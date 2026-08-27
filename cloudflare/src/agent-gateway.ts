import app from "./index";
import {
  type AgentProfileFacts,
  type OnboardingConfirmed,
  type OnboardingTopic,
  type PreferencePatch,
  buildOnboardingQuestions,
  emptyConfirmed,
  inferConfirmedFromExisting,
  injectAgentSettingsLink,
  mergeAgentPreferences,
  newlyDiscoveredJobs,
  safeTextDocumentName,
  shapeShortlist,
  summarizeLegacyBody,
  toCompanyCounts,
} from "./agent";
import { companyFunnel, companyToJobHandoff, funnelViolations, runSummaryLine } from "./pipeline";
import { OAuthProvider, type AuthRequest, type ClientInfo, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type AgentCall, handleMcpRequest } from "./mcp-server";

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  /** Bound by @cloudflare/workers-oauth-provider; see wrangler.jsonc's kv_namespaces entry. */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider at request time -- not a real Wrangler binding, so it is never present outside a request that OAuthProvider itself dispatched. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** What an approved OAuth grant carries into every authenticated /mcp call, via ctx.props. */
type McpGrantProps = {
  agentToken: string;
  credentialId: string;
  label: string;
};

type DashboardSession = {
  id: string;
  device_name: string;
  expires_at: string;
  scope: string;
};

type AgentCredential = {
  id: string;
  label: string;
  expires_at: string;
};

type Principal =
  | { kind: "dashboard"; id: string; label: string }
  | { kind: "agent"; id: string; label: string };

type OnboardingRow = {
  profile_id: string;
  generation: number;
  mode: string;
  resume_confirmed: number;
  career_direction_confirmed: number;
  locations_confirmed: number;
  dealbreakers_confirmed: number;
  priorities_confirmed: number;
  extra_evidence_confirmed: number;
  profile_dirty: number;
  career_dirty: number;
  started_at: string;
  updated_at: string;
};

const encoder = new TextEncoder();
let agentSchemaReady: Promise<void> | null = null;

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

async function ensureAgentSchema(env: Env): Promise<void> {
  if (!agentSchemaReady) {
    agentSchemaReady = (async () => {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS agent_credentials (
           id TEXT PRIMARY KEY,
           token_hash TEXT NOT NULL UNIQUE,
           label TEXT NOT NULL,
           permissions_json TEXT NOT NULL DEFAULT '["profile:read","profile:write"]',
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           expires_at TEXT NOT NULL,
           revoked_at TEXT
         )`,
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_agent_credentials_active ON agent_credentials(revoked_at, expires_at)",
      ).run();
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS agent_onboarding_state (
           profile_id TEXT PRIMARY KEY REFERENCES candidate_profiles(id) ON DELETE CASCADE,
           generation INTEGER NOT NULL DEFAULT 0,
           mode TEXT NOT NULL DEFAULT 'continue',
           resume_confirmed INTEGER NOT NULL DEFAULT 0,
           career_direction_confirmed INTEGER NOT NULL DEFAULT 0,
           locations_confirmed INTEGER NOT NULL DEFAULT 0,
           dealbreakers_confirmed INTEGER NOT NULL DEFAULT 0,
           priorities_confirmed INTEGER NOT NULL DEFAULT 0,
           extra_evidence_confirmed INTEGER NOT NULL DEFAULT 0,
           profile_dirty INTEGER NOT NULL DEFAULT 0,
           career_dirty INTEGER NOT NULL DEFAULT 0,
           started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`,
      ).run();
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS agent_activity (
           id TEXT PRIMARY KEY,
           credential_id TEXT,
           action TEXT NOT NULL,
           detail TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`,
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_agent_activity_created ON agent_activity(created_at DESC)",
      ).run();
    })();
  }
  await agentSchemaReady;
}

async function requireFullDashboardSession(request: Request, env: Env): Promise<DashboardSession | Response> {
  const token = cookieValue(request, "applygo_session") ?? bearerToken(request);
  if (!token || token.startsWith("ago_")) return json({ error: "authentication_required" }, 401);
  const tokenHash = await sha256(token);
  const session = await env.DB.prepare(
    `SELECT id, device_name, expires_at, scope
     FROM device_sessions
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(tokenHash)
    .first<DashboardSession>();
  if (!session) return json({ error: "invalid_or_expired_session" }, 401);
  if (session.scope !== "full") return json({ error: "full_session_required" }, 403);
  await env.DB.prepare("UPDATE device_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(session.id)
    .run();
  return session;
}

async function requireAgentCredential(request: Request, env: Env): Promise<AgentCredential | Response> {
  const token = bearerToken(request);
  if (!token.startsWith("ago_")) return json({ error: "agent_token_required" }, 401);
  const tokenHash = await sha256(token);
  const credential = await env.DB.prepare(
    `SELECT id, label, expires_at
     FROM agent_credentials
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(tokenHash)
    .first<AgentCredential>();
  if (!credential) return json({ error: "invalid_or_expired_agent_token" }, 401);
  await env.DB.prepare("UPDATE agent_credentials SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(credential.id)
    .run();
  return credential;
}

async function requireAgentOrFull(request: Request, env: Env): Promise<Principal | Response> {
  if (bearerToken(request).startsWith("ago_")) {
    const credential = await requireAgentCredential(request, env);
    if (credential instanceof Response) return credential;
    return { kind: "agent", id: credential.id, label: credential.label };
  }
  const session = await requireFullDashboardSession(request, env);
  if (session instanceof Response) return session;
  return { kind: "dashboard", id: session.id, label: session.device_name };
}

async function recordActivity(env: Env, principal: Principal, action: string, detail = ""): Promise<void> {
  await env.DB.prepare("INSERT INTO agent_activity (id, credential_id, action, detail) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), principal.id, action.slice(0, 120), detail.slice(0, 500))
    .run();
}

async function getOrCreateProfileId(env: Env): Promise<string> {
  const existing = await env.DB.prepare("SELECT id FROM candidate_profiles ORDER BY created_at ASC LIMIT 1")
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO candidate_profiles (id, label, summary) VALUES (?, '', '')").bind(id).run();
  return id;
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function rowConfirmed(row: OnboardingRow): OnboardingConfirmed {
  return {
    resume: Boolean(row.resume_confirmed),
    career_direction: Boolean(row.career_direction_confirmed),
    locations: Boolean(row.locations_confirmed),
    dealbreakers: Boolean(row.dealbreakers_confirmed),
    priorities: Boolean(row.priorities_confirmed),
    extra_evidence: Boolean(row.extra_evidence_confirmed),
  };
}

function topicColumn(topic: OnboardingTopic): string {
  const columns: Record<OnboardingTopic, string> = {
    resume: "resume_confirmed",
    career_direction: "career_direction_confirmed",
    locations: "locations_confirmed",
    dealbreakers: "dealbreakers_confirmed",
    priorities: "priorities_confirmed",
    extra_evidence: "extra_evidence_confirmed",
  };
  return columns[topic];
}

function isOnboardingTopic(value: unknown): value is OnboardingTopic {
  return ["resume", "career_direction", "locations", "dealbreakers", "priorities", "extra_evidence"].includes(String(value));
}

async function profileFacts(env: Env, profileId: string): Promise<AgentProfileFacts> {
  const [profile, docs, prefs, notes] = await Promise.all([
    env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
      .bind(profileId)
      .first<{ preferences_json: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM source_documents WHERE profile_id = ?")
      .bind(profileId)
      .first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_evidence WHERE profile_id = ? AND category = 'role_signal'")
      .bind(profileId)
      .first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_evidence WHERE profile_id = ? AND category = 'note'")
      .bind(profileId)
      .first<{ n: number }>(),
  ]);
  const preferences = parseObject(profile?.preferences_json);
  return {
    documentCount: Number(docs?.n ?? 0),
    careerPreferenceCount: Number(prefs?.n ?? 0),
    noteCount: Number(notes?.n ?? 0),
    desiredLocations: String(preferences.desired_locations ?? ""),
    dealbreakers: String(preferences.dealbreakers ?? ""),
    careAbout: String(preferences.care_about ?? ""),
  };
}

async function ensureOnboardingState(env: Env, profileId: string): Promise<OnboardingRow> {
  const existing = await env.DB.prepare("SELECT * FROM agent_onboarding_state WHERE profile_id = ?")
    .bind(profileId)
    .first<OnboardingRow>();
  if (existing) return existing;
  const inferred = inferConfirmedFromExisting(await profileFacts(env, profileId));
  await env.DB.prepare(
    `INSERT INTO agent_onboarding_state
       (profile_id, generation, mode, resume_confirmed, career_direction_confirmed,
        locations_confirmed, dealbreakers_confirmed, priorities_confirmed, extra_evidence_confirmed)
     VALUES (?, 0, 'continue', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      profileId,
      Number(inferred.resume),
      Number(inferred.career_direction),
      Number(inferred.locations),
      Number(inferred.dealbreakers),
      Number(inferred.priorities),
      Number(inferred.extra_evidence),
    )
    .run();
  return (await env.DB.prepare("SELECT * FROM agent_onboarding_state WHERE profile_id = ?")
    .bind(profileId)
    .first<OnboardingRow>()) as OnboardingRow;
}

async function markTopic(env: Env, profileId: string, topic: OnboardingTopic): Promise<void> {
  await ensureOnboardingState(env, profileId);
  const column = topicColumn(topic);
  await env.DB.prepare(
    `UPDATE agent_onboarding_state SET ${column} = 1, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ?`,
  )
    .bind(profileId)
    .run();
}

async function markDirty(env: Env, profileId: string, profileDirty: boolean, careerDirty: boolean): Promise<void> {
  await ensureOnboardingState(env, profileId);
  await env.DB.prepare(
    `UPDATE agent_onboarding_state
     SET profile_dirty = CASE WHEN ? = 1 THEN 1 ELSE profile_dirty END,
         career_dirty = CASE WHEN ? = 1 THEN 1 ELSE career_dirty END,
         updated_at = CURRENT_TIMESTAMP
     WHERE profile_id = ?`,
  )
    .bind(Number(profileDirty), Number(careerDirty), profileId)
    .run();
}

async function startOnboarding(request: Request, env: Env, principal: Principal): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { mode?: string };
  const mode = body.mode === "continue" ? "continue" : "fresh";
  const profileId = await getOrCreateProfileId(env);
  const previous = await ensureOnboardingState(env, profileId);
  const confirmed = mode === "continue" ? inferConfirmedFromExisting(await profileFacts(env, profileId)) : emptyConfirmed();
  await env.DB.prepare(
    `UPDATE agent_onboarding_state
     SET generation = ?, mode = ?, resume_confirmed = ?, career_direction_confirmed = ?,
         locations_confirmed = ?, dealbreakers_confirmed = ?, priorities_confirmed = ?,
         extra_evidence_confirmed = ?, profile_dirty = ?, career_dirty = ?,
         started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE profile_id = ?`,
  )
    .bind(
      previous.generation + 1,
      mode,
      Number(confirmed.resume),
      Number(confirmed.career_direction),
      Number(confirmed.locations),
      Number(confirmed.dealbreakers),
      Number(confirmed.priorities),
      Number(confirmed.extra_evidence),
      Number(mode === "fresh"),
      Number(mode === "fresh"),
      profileId,
    )
    .run();
  await recordActivity(env, principal, "onboarding.start", mode);
  return getAgentContext(request, env, principal);
}

async function getAgentContext(request: Request, env: Env, _principal: Principal): Promise<Response> {
  const profileId = await getOrCreateProfileId(env);
  const profile = await env.DB.prepare(
    "SELECT id, label, summary, preferences_json, structured_json, updated_at FROM candidate_profiles WHERE id = ?",
  )
    .bind(profileId)
    .first<{ id: string; label: string; summary: string; preferences_json: string; structured_json: string; updated_at: string }>();
  const [documents, careerPreferences, notes, state] = await Promise.all([
    env.DB.prepare(
      `SELECT id, original_name, media_type, LENGTH(extracted_text) AS extracted_characters, created_at
       FROM source_documents WHERE profile_id = ? ORDER BY created_at DESC LIMIT 25`,
    ).bind(profileId).all(),
    env.DB.prepare(
      `SELECT id, claim, created_at FROM candidate_evidence
       WHERE profile_id = ? AND category = 'role_signal' ORDER BY created_at ASC LIMIT 50`,
    ).bind(profileId).all(),
    env.DB.prepare(
      `SELECT id, claim, created_at FROM candidate_evidence
       WHERE profile_id = ? AND category = 'note' ORDER BY created_at ASC LIMIT 50`,
    ).bind(profileId).all(),
    ensureOnboardingState(env, profileId),
  ]);

  const preferences = parseObject(profile?.preferences_json);
  const structured = parseObject(profile?.structured_json);
  const confirmed = rowConfirmed(state);
  const questions = buildOnboardingQuestions(confirmed);
  const hasStructuredProfile = Object.keys(structured).length > 0;
  const hasRoleAnalysis = Boolean(preferences.role_analysis && typeof preferences.role_analysis === "object");
  let nextAction = "ready_for_job_search";
  if (questions.length) nextAction = "continue_onboarding";
  else if (state.profile_dirty || !hasStructuredProfile) nextAction = "generate_profile";
  else if (state.career_dirty || !hasRoleAnalysis) nextAction = "analyze_careers";

  const full = new URL(request.url).searchParams.get("full") === "1";
  return json({
    api_version: 1,
    profile: {
      id: profile?.id,
      label: profile?.label ?? "",
      summary: profile?.summary ?? "",
      updated_at: profile?.updated_at,
      preferences: {
        desired_locations: String(preferences.desired_locations ?? ""),
        dealbreakers: String(preferences.dealbreakers ?? ""),
        care_about: String(preferences.care_about ?? ""),
        desired_roles: String(preferences.desired_roles ?? ""),
        role_analysis_present: hasRoleAnalysis,
      },
      structured_profile_present: hasStructuredProfile,
      ...(full ? { structured_profile: structured, raw_preferences: preferences } : {}),
      documents: documents.results ?? [],
      career_preferences: careerPreferences.results ?? [],
      notes: notes.results ?? [],
    },
    onboarding: {
      generation: state.generation,
      mode: state.mode,
      started_at: state.started_at,
      confirmed,
      complete: questions.length === 0,
      next_question: questions[0] ?? null,
      remaining_questions: questions,
      profile_dirty: Boolean(state.profile_dirty),
      career_dirty: Boolean(state.career_dirty),
    },
    next_action: nextAction,
  });
}

async function saveCareerPreference(request: Request, env: Env, principal: Principal): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { text?: string };
  const claim = String(body.text ?? "").trim();
  if (!claim) return json({ error: "text_required" }, 400);
  if (claim.length > 20_000) return json({ error: "text_too_large", max_characters: 20_000 }, 413);
  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO candidate_evidence (id, profile_id, category, claim, usable_in_applications) VALUES (?, ?, 'role_signal', ?, 1)",
  )
    .bind(id, profileId, claim)
    .run();
  const profile = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const preferences = parseObject(profile?.preferences_json);
  delete preferences.role_analysis;
  delete preferences.desired_roles;
  await env.DB.prepare("UPDATE candidate_profiles SET preferences_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(preferences), profileId)
    .run();
  await markTopic(env, profileId, "career_direction");
  await markDirty(env, profileId, false, true);
  await recordActivity(env, principal, "career.preference.add", `${claim.length} characters`);
  return json({ id, saved: true }, 201);
}

async function savePreferences(request: Request, env: Env, principal: Principal): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as PreferencePatch;
  if (body.desired_locations === undefined && body.dealbreakers === undefined && body.care_about === undefined) {
    return json({ error: "preference_field_required" }, 400);
  }
  const profileId = await getOrCreateProfileId(env);
  const profile = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const { preferences, changed } = mergeAgentPreferences(parseObject(profile?.preferences_json), body);
  await env.DB.prepare("UPDATE candidate_profiles SET preferences_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(preferences), profileId)
    .run();
  if (body.desired_locations !== undefined) await markTopic(env, profileId, "locations");
  if (body.dealbreakers !== undefined) await markTopic(env, profileId, "dealbreakers");
  if (body.care_about !== undefined) await markTopic(env, profileId, "priorities");
  if (changed.length) await markDirty(env, profileId, false, true);
  await recordActivity(env, principal, "preferences.update", changed.join(",") || "confirmed unchanged values");
  return json({ saved: true, changed, preferences: {
    desired_locations: String(preferences.desired_locations ?? ""),
    dealbreakers: String(preferences.dealbreakers ?? ""),
    care_about: String(preferences.care_about ?? ""),
  } });
}

async function addNote(request: Request, env: Env, principal: Principal): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { text?: string };
  const claim = String(body.text ?? "").trim();
  if (!claim) return json({ error: "text_required" }, 400);
  if (claim.length > 40_000) return json({ error: "text_too_large", max_characters: 40_000 }, 413);
  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO candidate_evidence (id, profile_id, category, claim, usable_in_applications) VALUES (?, ?, 'note', ?, 1)",
  )
    .bind(id, profileId, claim)
    .run();
  await markTopic(env, profileId, "extra_evidence");
  await markDirty(env, profileId, true, true);
  await recordActivity(env, principal, "evidence.note.add", `${claim.length} characters`);
  return json({ id, saved: true }, 201);
}

async function addTextDocument(request: Request, env: Env, principal: Principal): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { name?: string; text?: string; kind?: string };
  const text = String(body.text ?? "").trim();
  if (!text) return json({ error: "text_required" }, 400);
  if (text.length > 2_000_000) return json({ error: "document_too_large", max_characters: 2_000_000 }, 413);
  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  const name = safeTextDocumentName(String(body.name ?? "resume-from-chat.txt"));
  const r2Key = `profiles/${profileId}/agent/${id}/${name}`;
  const textHash = await sha256(text);
  await env.FILES.put(r2Key, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  try {
    await env.DB.prepare(
      `INSERT INTO source_documents (id, profile_id, original_name, r2_key, media_type, sha256, extracted_text)
       VALUES (?, ?, ?, ?, 'text/plain', ?, ?)`,
    )
      .bind(id, profileId, name, r2Key, textHash, text)
      .run();
  } catch (error) {
    await env.FILES.delete(r2Key);
    throw error;
  }
  if ((body.kind ?? "resume") === "resume") await markTopic(env, profileId, "resume");
  await markDirty(env, profileId, true, true);
  await recordActivity(env, principal, "document.add", `${name}; ${text.length} characters`);
  return json({ id, name, kind: body.kind ?? "resume", saved: true }, 201);
}

async function confirmOnboardingTopic(request: Request, env: Env, principal: Principal): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { topic?: unknown };
  if (!isOnboardingTopic(body.topic)) return json({ error: "invalid_topic" }, 400);
  const profileId = await getOrCreateProfileId(env);
  await markTopic(env, profileId, body.topic);
  await recordActivity(env, principal, "onboarding.confirm", body.topic);
  return getAgentContext(request, env, principal);
}

async function listAgentTokens(request: Request, env: Env): Promise<Response> {
  const session = await requireFullDashboardSession(request, env);
  if (session instanceof Response) return session;
  const rows = await env.DB.prepare(
    `SELECT id, label, permissions_json, created_at, last_seen_at, expires_at
     FROM agent_credentials WHERE revoked_at IS NULL ORDER BY created_at DESC`,
  ).all();
  return json({ tokens: rows.results ?? [] });
}

async function createAgentToken(request: Request, env: Env): Promise<Response> {
  const session = await requireFullDashboardSession(request, env);
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as { label?: string; days?: number };
  const token = `ago_${randomToken()}`;
  const tokenHash = await sha256(token);
  const days = Math.min(Math.max(Number(body.days) || 90, 1), 365);
  const label = String(body.label || "ChatGPT job agent").trim().slice(0, 120) || "ChatGPT job agent";
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_credentials (id, token_hash, label, expires_at)
     VALUES (?, ?, ?, datetime('now', ?))`,
  )
    .bind(id, tokenHash, label, `+${days} days`)
    .run();
  await recordActivity(env, { kind: "dashboard", id: session.id, label: session.device_name }, "credential.create", label);
  return json({ id, token, label, expires_in_days: days, permissions: ["profile:read", "profile:write"] }, 201);
}

async function revokeAgentToken(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireFullDashboardSession(request, env);
  if (session instanceof Response) return session;
  const result = await env.DB.prepare(
    "UPDATE agent_credentials SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(id)
    .run();
  await recordActivity(env, { kind: "dashboard", id: session.id, label: session.device_name }, "credential.revoke", id);
  return json({ revoked: result.meta.changes > 0 });
}

async function listActivity(request: Request, env: Env): Promise<Response> {
  const principal = await requireAgentOrFull(request, env);
  if (principal instanceof Response) return principal;
  const rows = await env.DB.prepare(
    "SELECT action, detail, created_at FROM agent_activity ORDER BY created_at DESC LIMIT 50",
  ).all();
  return json({ activity: rows.results ?? [] });
}

/**
 * Every legacy call this gateway makes on an agent's behalf goes through here: it stands up a
 * short-lived (10-minute) full session, replays the request against the existing Worker under
 * that session, records one activity entry, and tears the session down whether the call succeeded
 * or not. This is the mechanism PR #107 introduced for profile.generate/careers.analyze; the
 * routes below reuse it rather than each inventing their own internal-session dance.
 *
 * `method`/`path`/`bodyText` are explicit rather than derived from `request` because several
 * callers need to translate an agent-shaped request into a differently-shaped (or differently
 * routed) legacy call -- e.g. POST /agent/v1/materials/resume {job_id} becomes
 * POST /jobs/:id/resume with a trimmed body. `request` is kept only to resolve `path` against the
 * same origin the legacy Worker already expects.
 */
async function bridgeLegacy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
  method: string,
  path: string,
  action: string,
  bodyText = "{}",
): Promise<Response> {
  const internalToken = randomToken();
  const sessionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO device_sessions (id, token_hash, device_name, expires_at)
     VALUES (?, ?, 'ApplyGo Agent internal bridge', datetime('now', '+10 minutes'))`,
  )
    .bind(sessionId, await sha256(internalToken))
    .run();
  try {
    const url = new URL(path, request.url);
    const hasBody = method !== "GET" && method !== "DELETE";
    const legacyRequest = new Request(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(hasBody ? { body: bodyText || "{}" } : {}),
    });
    const response = await app.fetch(legacyRequest, env as unknown as Parameters<typeof app.fetch>[1], ctx);
    await recordActivity(env, principal, action, `HTTP ${response.status}`);
    return response;
  } finally {
    await env.DB.prepare("DELETE FROM device_sessions WHERE id = ?").bind(sessionId).run().catch(() => undefined);
  }
}

/** profile.generate/careers.analyze need one extra side effect on success: clearing the dirty flag the legacy action just satisfied. */
async function callLegacyAction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
  path: string,
  action: string,
): Promise<Response> {
  const bodyText = await request.text();
  const response = await bridgeLegacy(request, env, ctx, principal, "POST", path, action, bodyText);
  if (response.ok) {
    const profileId = await getOrCreateProfileId(env);
    if (action === "profile.generate") {
      await ensureOnboardingState(env, profileId);
      await env.DB.prepare(
        "UPDATE agent_onboarding_state SET profile_dirty = 0, career_dirty = 1, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ?",
      ).bind(profileId).run();
    }
    if (action === "careers.analyze") {
      await ensureOnboardingState(env, profileId);
      await env.DB.prepare(
        "UPDATE agent_onboarding_state SET career_dirty = 0, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ?",
      ).bind(profileId).run();
    }
  }
  return response;
}

/** Reads a legacy JSON response's body without disturbing its status for the caller that forwards it. */
async function readLegacyJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// Job search, evaluation, and application materials (v1.1) -- the slice PR #107 deliberately
// stopped short of. Every route below is a thin translation over an existing legacy route; none
// of them re-implements discovery, scoring, or generation. None of them submits an application,
// contacts an employer, or sends anything external -- ApplyGo has no such route today (the
// /applications/* endpoints back a browser-extension autofill flow, not automated submission),
// so that boundary is preserved simply by not adding one.
// ---------------------------------------------------------------------------------------------

async function companiesList(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const response = await bridgeLegacy(request, env, ctx, principal, "GET", "/companies", "companies.list");
  return json(await readLegacyJson(response), response.status);
}

async function jobsList(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const response = await bridgeLegacy(request, env, ctx, principal, "GET", "/jobs", "jobs.list");
  return json(await readLegacyJson(response), response.status);
}

async function companiesDiscover(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const bodyText = await request.text();
  const response = await bridgeLegacy(request, env, ctx, principal, "POST", "/companies/discover", "companies.discover", bodyText);
  return json(summarizeLegacyBody(await response.text()), response.status);
}

async function companiesScan(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const bodyText = await request.text();
  const response = await bridgeLegacy(request, env, ctx, principal, "POST", "/companies/scan", "companies.scan", bodyText);
  return json(summarizeLegacyBody(await response.text()), response.status);
}

async function companiesSearchTermsRead(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const response = await bridgeLegacy(request, env, ctx, principal, "GET", "/companies/search-terms", "companies.search_terms.read");
  return json(await readLegacyJson(response), response.status);
}

async function companiesSearchTermsWrite(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const bodyText = await request.text();
  const response = await bridgeLegacy(request, env, ctx, principal, "PUT", "/companies/search-terms", "companies.search_terms.write", bodyText);
  return json(await readLegacyJson(response), response.status);
}

/**
 * Runs ApplyGo's one scoring pipeline (screen, then assess -- see fit.ts) over whatever is
 * currently unassessed. There is no narrower "score just this job" primitive in the app today;
 * the pipeline is already scoped to unassessed rows and safe to call repeatedly, so this is the
 * real underlying action behind both /agent/v1/jobs/process (bulk trigger) and
 * /agent/v1/jobs/evaluate (trigger, then hand back a rationale-rich shortlist) below.
 */
async function runFitPipeline(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
  bodyText: string,
): Promise<{ response: Response; summary: Record<string, unknown> }> {
  const response = await bridgeLegacy(request, env, ctx, principal, "POST", "/jobs/process", "jobs.evaluate", bodyText || "{}");
  const text = await response.text();
  return { response, summary: summarizeLegacyBody(text) };
}

async function jobsProcess(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const bodyText = await request.text();
  const { response, summary } = await runFitPipeline(request, env, ctx, principal, bodyText);
  return json(summary, response.status);
}

async function jobsEvaluate(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { provider?: string; calls?: number; min_score?: number; limit?: number };
  const { response, summary } = await runFitPipeline(
    request,
    env,
    ctx,
    principal,
    JSON.stringify({ provider: body.provider, calls: body.calls }),
  );
  if (!response.ok) return json(summary, response.status);
  const jobsResponse = await bridgeLegacy(request, env, ctx, principal, "GET", "/jobs", "jobs.evaluate.read");
  const jobsData = await readLegacyJson(jobsResponse);
  const minScore = Math.min(Math.max(Number(body.min_score) || 40, 0), 100);
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 100);
  const jobs = Array.isArray(jobsData.jobs) ? jobsData.jobs as Record<string, unknown>[] : [];
  return json({ pipeline_run: summary, ranked: shapeShortlist(jobs, minScore, limit) });
}

/**
 * "Search" in ApplyGo terms is scan known companies for new postings, then score whatever came
 * in -- there is no separate job-discovery primitive independent of the company pipeline (new
 * companies are found by /companies/discover; new postings come from scanning them). This wraps
 * both steps and reports only what is new since the call started, using each job's own created_at
 * as the watermark.
 */
async function jobsSearch(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const bodyText = await request.text();
  const since = new Date().toISOString();
  const scanResponse = await bridgeLegacy(request, env, ctx, principal, "POST", "/companies/scan", "jobs.search.scan", bodyText || "{}");
  const scanSummary = summarizeLegacyBody(await scanResponse.text());
  if (!scanResponse.ok) return json({ scan: scanSummary }, scanResponse.status);

  const { response: evalResponse, summary: evalSummary } = await runFitPipeline(request, env, ctx, principal, "{}");
  if (!evalResponse.ok) return json({ scan: scanSummary, evaluate: evalSummary }, evalResponse.status);

  const jobsResponse = await bridgeLegacy(request, env, ctx, principal, "GET", "/jobs", "jobs.search.read");
  const jobsData = await readLegacyJson(jobsResponse);
  const allJobs = Array.isArray(jobsData.jobs) ? jobsData.jobs as Record<string, unknown>[] : [];
  const newly = newlyDiscoveredJobs(allJobs, since);
  return json({
    scan: scanSummary,
    evaluate: evalSummary,
    newly_found_count: newly.length,
    newly_found: shapeShortlist(newly, 0, 50),
  });
}

async function jobsShortlist(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const url = new URL(request.url);
  const minScore = Math.min(Math.max(Number(url.searchParams.get("min_score")) || 60, 0), 100);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
  const jobsResponse = await bridgeLegacy(request, env, ctx, principal, "GET", "/jobs", "jobs.shortlist");
  const jobsData = await readLegacyJson(jobsResponse);
  const jobs = Array.isArray(jobsData.jobs) ? jobsData.jobs as Record<string, unknown>[] : [];
  return json({ shortlist: shapeShortlist(jobs, minScore, limit) });
}

async function profileQuestionsList(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const response = await bridgeLegacy(request, env, ctx, principal, "GET", "/profile/improve/questions", "profile.questions.read");
  return json(await readLegacyJson(response), response.status);
}

async function profileQuestionsAudit(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const bodyText = await request.text();
  const response = await bridgeLegacy(request, env, ctx, principal, "POST", "/profile/improve/audit", "profile.questions.audit", bodyText);
  return json(summarizeLegacyBody(await response.text()), response.status);
}

async function profileQuestionsAnswer(request: Request, env: Env, ctx: ExecutionContext, principal: Principal, id: string): Promise<Response> {
  const bodyText = await request.text();
  const response = await bridgeLegacy(
    request,
    env,
    ctx,
    principal,
    "PUT",
    `/profile/improve/questions/${encodeURIComponent(id)}`,
    "profile.questions.answer",
    bodyText,
  );
  return json(await readLegacyJson(response), response.status);
}

async function profileQuestionsApply(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const bodyText = await request.text();
  const response = await bridgeLegacy(request, env, ctx, principal, "POST", "/profile/improve/apply", "profile.questions.apply", bodyText);
  return json(await readLegacyJson(response), response.status);
}

/** Shared by both material routes: pull {job_id, ...rest} apart and forward `rest` to the per-job legacy route. */
async function materialsRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
  legacyPathSuffix: "resume" | "cover-letter",
  action: string,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { job_id?: string; provider?: string; regenerate?: boolean };
  const jobId = String(body.job_id ?? "").trim();
  if (!jobId) return json({ error: "job_id_required" }, 400);
  const legacyBody = JSON.stringify({ provider: body.provider, regenerate: body.regenerate });
  const response = await bridgeLegacy(
    request,
    env,
    ctx,
    principal,
    "POST",
    `/jobs/${encodeURIComponent(jobId)}/${legacyPathSuffix}`,
    action,
    legacyBody,
  );
  return json(await readLegacyJson(response), response.status);
}

async function materialsResume(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  return materialsRequest(request, env, ctx, principal, "resume", "materials.resume");
}

async function materialsCoverLetter(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  return materialsRequest(request, env, ctx, principal, "cover-letter", "materials.cover_letter");
}

/**
 * Read-only QC view for the agent's "why aren't we finding enough good jobs" role: the same
 * company/job funnel the dashboard renders (via pipeline.ts, so the arithmetic is guaranteed to
 * reconcile -- see funnelViolations), plus three signals that funnel doesn't cover: recent model
 * failures, discovery streams that still have unfetched pages, and duplicate postings by
 * title+company, which a funnel count alone can't reveal.
 */
async function pipelineStatus(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const [companiesResponse, jobsResponse] = await Promise.all([
    bridgeLegacy(request, env, ctx, principal, "GET", "/companies", "pipeline.status"),
    bridgeLegacy(request, env, ctx, principal, "GET", "/jobs", "pipeline.status"),
  ]);
  const companiesData = await readLegacyJson(companiesResponse);
  const jobsData = await readLegacyJson(jobsResponse);
  const counts = toCompanyCounts((companiesData.company_pipeline as Record<string, number>) ?? {});
  const stages = companyFunnel(counts);
  const violations = funnelViolations(stages);
  const jobCounts = (jobsData.counts as Record<string, number>) ?? {};
  const handoff = companyToJobHandoff(counts, Number(jobCounts.unassessed ?? 0));
  const summaryLine = runSummaryLine(counts, Number(jobCounts.unassessed ?? 0), false);

  const [failedTraces, openStreams, duplicates] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM llm_traces WHERE ok = 0 AND created_at > datetime('now', '-24 hours')",
    ).first<{ n: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM company_discovery_streams WHERE exhausted = 0",
    ).first<{ n: number }>()
      .catch(() => ({ n: 0 })),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT title, company FROM job_postings GROUP BY title, company HAVING COUNT(*) > 1
       )`,
    ).first<{ n: number }>(),
  ]);

  return json({
    summary: summaryLine,
    stages,
    handoff,
    funnel_violations: violations,
    diagnostics: {
      model_call_failures_24h: failedTraces?.n ?? 0,
      discovery_streams_with_pages_remaining: openStreams?.n ?? 0,
      duplicate_title_company_groups: duplicates?.n ?? 0,
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Shown instead of the consent page when the browser has no signed-in ApplyGo dashboard session. */
function authorizeSignInPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in required</title>
<style>:root{font-family:system-ui,sans-serif;color:#171717;background:#f5f5f7}body{margin:0;padding:24px 16px;max-width:480px}a{color:#222}</style>
</head><body><h1>Sign in to ApplyGo first</h1>
<p>This browser isn't signed in to ApplyGo. <a href="/">Sign in</a>, then use the connector's "Connect" button again to reopen this authorization request.</p>
</body></html>`;
}

/**
 * The consent screen a human sees before Claude.ai (or any other MCP client) is granted an
 * `ago_*` agent credential. The same preserved OAuth query string is resubmitted on the form's
 * `action` so the POST handler below can re-parse the identical AuthRequest -- this is a
 * stateless round trip, not a stored draft.
 */
function authorizeConsentPage(client: ClientInfo, oauthRequest: AuthRequest): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize agent access</title>
<style>:root{font-family:system-ui,sans-serif;color:#171717;background:#f5f5f7}*{box-sizing:border-box}body{margin:0;padding:24px 16px;max-width:480px}
section{background:white;border:1px solid #ddd;border-radius:14px;padding:18px;margin:14px 0}
button{appearance:none;border:1px solid #222;background:#222;color:white;padding:10px 14px;border-radius:9px;font:inherit;font-weight:600;cursor:pointer;margin-right:10px}
button.secondary{background:white;color:#222}
ul{padding-left:20px;color:#444}</style>
</head><body>
<h1>Authorize agent access</h1>
<section>
<p><strong>${escapeHtml(client.clientName || client.clientId)}</strong> wants to access your ApplyGo data as a trusted job agent.</p>
<p>This grants the same access level as an <a href="/agent">agent key</a> created from Settings: it can search for jobs, evaluate fit, update your search preferences, answer profile questions, and generate resumes/cover letters. It cannot submit an application, send email, or delete career data -- ApplyGo has no route that does either.</p>
<p>Scopes requested: ${oauthRequest.scope.length ? oauthRequest.scope.map((s) => `<code>${escapeHtml(s)}</code>`).join(", ") : "(none declared)"}</p>
<form method="POST">
<button type="submit" name="decision" value="approve">Allow access</button>
<button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</form>
</section>
<p><a href="/agent">Manage existing agent keys</a></p>
</body></html>`;
}

/**
 * The `/authorize` step of the OAuth dance -- not handled by OAuthProvider itself (see its own
 * docs: "This URL is used in OAuth metadata and is not handled by the provider itself"). GET shows
 * a consent screen gated on the existing full dashboard session; POST records the human's decision
 * and, on approval, mints a fresh `ago_*` credential exactly like the "Create agent key" button on
 * `/agent` does, then completes the grant with that token as `props` so every future `/mcp` call
 * under this grant authenticates as that credential.
 */
async function handleAuthorizeRequest(request: Request, env: Env): Promise<Response> {
  await ensureAgentSchema(env);
  const session = await requireFullDashboardSession(request, env);
  if (session instanceof Response) {
    return new Response(authorizeSignInPage(), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    return json({ error: "invalid_authorize_request", detail: (error as Error).message }, 400);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return json({ error: "unknown_oauth_client" }, 400);

  if (request.method === "GET") {
    return new Response(authorizeConsentPage(client, oauthRequest), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const form = await request.formData().catch(() => null);
  const approved = form?.get("decision") === "approve";
  if (!approved) {
    if (!oauthRequest.redirectUri) return json({ error: "access_denied" }, 400);
    const redirect = new URL(oauthRequest.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    if (oauthRequest.state) redirect.searchParams.set("state", oauthRequest.state);
    return Response.redirect(redirect.toString(), 302);
  }

  const token = `ago_${randomToken()}`;
  const tokenHash = await sha256(token);
  const credentialId = crypto.randomUUID();
  const label = `Claude connector (${client.clientName || client.clientId})`.slice(0, 120);
  await env.DB.prepare(
    `INSERT INTO agent_credentials (id, token_hash, label, expires_at) VALUES (?, ?, ?, datetime('now', '+365 days'))`,
  ).bind(credentialId, tokenHash, label).run();
  await recordActivity(env, { kind: "dashboard", id: session.id, label: session.device_name }, "credential.create", label);

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    // One candidate per ApplyGo deployment -- the dashboard session id is a stable enough per-install
    // subject identifier; there is no separate user table this could reference instead.
    userId: session.id,
    metadata: { clientName: client.clientName ?? client.clientId, credentialId },
    scope: oauthRequest.scope,
    props: { agentToken: token, credentialId, label } satisfies McpGrantProps,
  });
  return Response.redirect(redirectTo, 302);
}

function agentPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ApplyGo Agent Access</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#f5f5f7}*{box-sizing:border-box}body{margin:0}.shell{max-width:900px;margin:0 auto;padding:24px 16px 64px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}a{color:inherit}section{background:white;border:1px solid #ddd;border-radius:14px;padding:18px;margin:14px 0}h1{font-size:1.6rem;margin:0}h2{font-size:1.1rem;margin:0 0 8px}.hint{color:#666;line-height:1.45}.status{padding:12px;border-radius:10px;background:#f2f2f2;white-space:pre-wrap}button{appearance:none;border:1px solid #222;background:#222;color:white;padding:10px 14px;border-radius:9px;font:inherit;font-weight:600;cursor:pointer}button.secondary{background:white;color:#222}button.danger{background:white;color:#9c1c1c;border-color:#c77}.row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid #eee}.row:first-child{border-top:0}.token{width:100%;min-height:84px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#eee;font-size:.78rem;margin:2px}.ok{background:#e7f7ea}.todo{background:#fff1d8}@media(max-width:600px){.top,.row{align-items:flex-start;flex-direction:column}.row button{width:100%}}
</style>
</head>
<body><main class="shell">
<div class="top"><div><h1>Agent access</h1><div class="hint">A trusted job agent can read and update the same ApplyGo profile you use on your phone.</div></div><a href="/">Back to ApplyGo</a></div>
<section><h2>Connection</h2><p class="hint">Agent keys are separate from device sessions, stored only as hashes, expire automatically, and can be revoked here. Creating a key does not expose your Cloudflare credentials or database password.</p><button id="create-token">Create agent key</button><div id="new-token-wrap" style="display:none;margin-top:12px"><strong>Copy this now — it is shown once.</strong><textarea id="new-token" class="token" readonly></textarea><button id="copy-token" class="secondary">Copy</button></div><div id="tokens" class="status" style="margin-top:12px">Loading…</div></section>
<section><h2>Interview state</h2><p class="hint">“Start fresh” re-runs the interview from the beginning without deleting existing documents, notes, jobs, or applications.</p><button id="start-fresh" class="secondary">Start fresh interview</button><div id="onboarding" class="status" style="margin-top:12px">Loading…</div></section>
<section><h2>What the agent can change</h2><div class="hint">This first slice is deliberately narrow: source-document text, factual notes, Career preference notes, location/dealbreaker/priority preferences, Profile generation, and Career analysis. It cannot submit applications, send email, delete career data, or invoke arbitrary ApplyGo routes.</div></section>
</main>
<script>
async function api(path, options){const res=await fetch(path,options);let data={};try{data=await res.json()}catch{}if(!res.ok)throw new Error(data.error||('HTTP '+res.status));return data}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]})}
async function load(){try{const [tokens,ctx]=await Promise.all([api('/agent/v1/tokens'),api('/agent/v1/context')]);const t=document.getElementById('tokens');if(!tokens.tokens.length)t.innerHTML='No active agent keys.';else t.innerHTML=tokens.tokens.map(function(x){return '<div class="row"><div><strong>'+esc(x.label)+'</strong><div class="hint">Expires '+esc(x.expires_at)+'</div></div><button class="danger" data-revoke="'+esc(x.id)+'">Revoke</button></div>'}).join('');document.querySelectorAll('[data-revoke]').forEach(function(b){b.onclick=async function(){await api('/agent/v1/tokens/'+encodeURIComponent(b.dataset.revoke),{method:'DELETE'});load()}});const o=ctx.onboarding;const pills=Object.keys(o.confirmed).map(function(k){return '<span class="pill '+(o.confirmed[k]?'ok':'todo')+'">'+esc(k.replaceAll('_',' '))+': '+(o.confirmed[k]?'done':'needed')+'</span>'}).join('');document.getElementById('onboarding').innerHTML=pills+'<div style="margin-top:10px"><strong>Next action:</strong> '+esc(ctx.next_action)+'</div>'+(o.next_question?'<div style="margin-top:10px"><strong>Next question:</strong> '+esc(o.next_question.prompt)+'</div>':'')}catch(e){document.getElementById('tokens').textContent='Sign in to ApplyGo first. '+e.message;document.getElementById('onboarding').textContent='Unavailable until signed in.'}}
document.getElementById('create-token').onclick=async function(){try{const data=await api('/agent/v1/tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'ChatGPT job agent',days:90})});document.getElementById('new-token').value=data.token;document.getElementById('new-token-wrap').style.display='block';load()}catch(e){alert(e.message)}};
document.getElementById('copy-token').onclick=async function(){await navigator.clipboard.writeText(document.getElementById('new-token').value)};
document.getElementById('start-fresh').onclick=async function(){try{await api('/agent/v1/onboarding/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'fresh'})});load()}catch(e){alert(e.message)}};
load();
</script></body></html>`;
}

/**
 * The whole `/agent/*` surface, including `/agent/v1/*`. Exported so the MCP layer
 * (mcp-server.ts) can call it in-process -- constructing a synthetic Request carrying an
 * `ago_*` bearer token and reading the Response back -- instead of making a real network
 * subrequest back to this same Worker.
 */
export async function handleAgentRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await ensureAgentSchema(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/agent") {
    const session = await requireFullDashboardSession(request, env);
    if (session instanceof Response) return new Response(null, { status: 302, headers: { location: "/" } });
    return new Response(agentPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  if (request.method === "GET" && url.pathname === "/agent/v1/tokens") return listAgentTokens(request, env);
  if (request.method === "POST" && url.pathname === "/agent/v1/tokens") return createAgentToken(request, env);
  const tokenMatch = url.pathname.match(/^\/agent\/v1\/tokens\/([^/]+)$/);
  if (request.method === "DELETE" && tokenMatch) return revokeAgentToken(request, env, tokenMatch[1]);

  if (request.method === "GET" && url.pathname === "/agent/v1/activity") return listActivity(request, env);

  const principal = await requireAgentOrFull(request, env);
  if (principal instanceof Response) return principal;

  if (request.method === "GET" && url.pathname === "/agent/v1/context") return getAgentContext(request, env, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/onboarding/start") return startOnboarding(request, env, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/onboarding/confirm") return confirmOnboardingTopic(request, env, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/career-preferences") return saveCareerPreference(request, env, principal);
  if (request.method === "PUT" && url.pathname === "/agent/v1/preferences") return savePreferences(request, env, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/notes") return addNote(request, env, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/documents/text") return addTextDocument(request, env, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/profile/generate") {
    return callLegacyAction(request, env, ctx, principal, "/profile/generate", "profile.generate");
  }
  if (request.method === "POST" && url.pathname === "/agent/v1/careers/analyze") {
    return callLegacyAction(request, env, ctx, principal, "/desired-roles/analyze", "careers.analyze");
  }

  // ----- v1.1: job search, evaluation, profile feedback, and application materials -----
  if (request.method === "GET" && url.pathname === "/agent/v1/companies") return companiesList(request, env, ctx, principal);
  if (request.method === "GET" && url.pathname === "/agent/v1/jobs") return jobsList(request, env, ctx, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/companies/discover") return companiesDiscover(request, env, ctx, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/companies/scan") return companiesScan(request, env, ctx, principal);
  if (request.method === "GET" && url.pathname === "/agent/v1/companies/search-terms") return companiesSearchTermsRead(request, env, ctx, principal);
  if (request.method === "PUT" && url.pathname === "/agent/v1/companies/search-terms") return companiesSearchTermsWrite(request, env, ctx, principal);

  if (request.method === "POST" && url.pathname === "/agent/v1/jobs/search") return jobsSearch(request, env, ctx, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/jobs/process") return jobsProcess(request, env, ctx, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/jobs/evaluate") return jobsEvaluate(request, env, ctx, principal);
  if (request.method === "GET" && url.pathname === "/agent/v1/jobs/shortlist") return jobsShortlist(request, env, ctx, principal);

  if (request.method === "GET" && url.pathname === "/agent/v1/profile/questions") return profileQuestionsList(request, env, ctx, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/profile/questions/audit") return profileQuestionsAudit(request, env, ctx, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/profile/questions/apply") return profileQuestionsApply(request, env, ctx, principal);
  const profileQuestionMatch = url.pathname.match(/^\/agent\/v1\/profile\/questions\/([^/]+)$/);
  if (request.method === "PUT" && profileQuestionMatch) return profileQuestionsAnswer(request, env, ctx, principal, profileQuestionMatch[1]);

  if (request.method === "POST" && url.pathname === "/agent/v1/materials/resume") return materialsResume(request, env, ctx, principal);
  if (request.method === "POST" && url.pathname === "/agent/v1/materials/cover-letter") return materialsCoverLetter(request, env, ctx, principal);

  if (request.method === "GET" && url.pathname === "/agent/v1/pipeline/status") return pipelineStatus(request, env, ctx, principal);

  return json({ error: "not_found" }, 404);
}

/**
 * Everything that isn't the OAuth-protected `/mcp` endpoint: the existing `/agent/*` surface,
 * the new `/authorize` consent step, and every legacy ApplyGo route unchanged. This is what
 * OAuthProvider calls `defaultHandler` -- every request that isn't `/mcp` with a valid access
 * token passes through here exactly as it did before this file added OAuth.
 */
const applyGoHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorizeRequest(request, env);
    if (url.pathname === "/agent" || url.pathname.startsWith("/agent/")) {
      return handleAgentRequest(request, env, ctx);
    }

    const response = await app.fetch(request, env as unknown as Parameters<typeof app.fetch>[1], ctx);
    if (request.method === "GET" && url.pathname === "/" && response.ok && (response.headers.get("content-type") || "").includes("text/html")) {
      const html = injectAgentSettingsLink(await response.text());
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(html, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
};

/**
 * The `/mcp` endpoint itself. OAuthProvider only calls this once a bearer token from a completed
 * grant has been verified, with that grant's `props` (see McpGrantProps) attached to `ctx.props`.
 * The tool implementations in mcp-server.ts never see D1, R2, or the ago_* token directly -- they
 * only see `callAgent`, which is exactly the same in-process call to handleAgentRequest that a real
 * `ago_*`-authenticated HTTP request to `/agent/v1/*` would make.
 */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as unknown as { props?: McpGrantProps }).props;
    if (!props?.agentToken) return json({ error: "missing_grant_props" }, 500);

    const callAgent: AgentCall = async (method, path, body) => {
      const agentRequest = new Request(new URL(path, request.url), {
        method,
        headers: {
          authorization: `Bearer ${props.agentToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      });
      const response = await handleAgentRequest(agentRequest, env, ctx);
      const responseBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: response.status, body: responseBody };
    };

    return handleMcpRequest(request, callAgent);
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler: applyGoHandler,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  scopesSupported: ["applygo:agent"],
});
