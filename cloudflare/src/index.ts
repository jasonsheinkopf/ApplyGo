import { extractText, getDocumentProxy } from "unpdf";
import { type BrowserWorker } from "@cloudflare/puppeteer";
import { type Provider, callStructured, callText, normalizeProvider, providerKeyMissing } from "./llm";
import {
  type AtsProvider,
  companyNameKey,
  fetchBoardJobs,
  filterJobsByRoles,
  locationMatches,
  parseLocationFilter,
  proposeCompanies,
  resolveBoard,
  verifyWebsite,
} from "./companies";
import {
  FIT_BATCH_SIZE,
  type FitResult,
  SCREEN_BATCH_SIZE,
  assessJobFitBatch,
  buildMatchProfile,
  screenJobsBatch,
} from "./fit";
import {
  type LayoutSpec,
  type ResumeCheck,
  type ResumeDoc,
  type StructuredProfile,
  TEMPLATES,
  applyLayoutAdjustments,
  composeResumeDoc,
  defaultLayout,
  normalizeLayout,
  normalizeTemplate,
  renderResumeArtifacts,
  renderResumeHtml,
  reviewResumeDesign,
  runAllChecks,
} from "./resume";

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  BROWSER: BrowserWorker;
  SETUP_SECRET: string;
  SESSION_DAYS: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_MODEL?: string;
  ANTHROPIC_SCREEN_MODEL?: string;
  OPENAI_SCREEN_MODEL?: string;
}

type Session = {
  id: string;
  device_name: string;
  expires_at: string;
  revoked_at: string | null;
};

const encoder = new TextEncoder();

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
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

async function digestHex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return digestHex(encoder.encode(value));
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `applygo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie(): string {
  return "applygo_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

async function requireSession(request: Request, env: Env): Promise<Session | Response> {
  const token = cookieValue(request, "applygo_session");
  if (!token) return json({ error: "authentication_required" }, 401);
  const tokenHash = await sha256(token);
  const session = await env.DB.prepare(
    `SELECT id, device_name, expires_at, revoked_at
     FROM device_sessions
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(tokenHash)
    .first<Session>();
  if (!session) return json({ error: "invalid_or_expired_session" }, 401, { "set-cookie": clearSessionCookie() });
  await env.DB.prepare("UPDATE device_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(session.id)
    .run();
  return session;
}

async function createEnrollment(request: Request, env: Env): Promise<Response> {
  if (!env.SETUP_SECRET || request.headers.get("x-applygo-setup-secret") !== env.SETUP_SECRET) {
    return json({ error: "forbidden" }, 403);
  }
  const body = (await request.json().catch(() => ({}))) as { label?: string; minutes?: number };
  const code = randomToken(18);
  const codeHash = await sha256(code);
  const id = crypto.randomUUID();
  const minutes = Math.min(Math.max(body.minutes ?? 15, 1), 60);
  await env.DB.prepare(
    "INSERT INTO enrollment_codes (id, code_hash, label, expires_at) VALUES (?, ?, ?, datetime('now', ?))",
  )
    .bind(id, codeHash, body.label ?? "", `+${minutes} minutes`)
    .run();
  return json({ enrollment_code: code, expires_in_minutes: minutes }, 201);
}

async function exchangeEnrollment(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { code?: string; device_name?: string };
  if (!body.code || !body.device_name) return json({ error: "code_and_device_name_required" }, 400);
  const codeHash = await sha256(body.code);
  const enrollment = await env.DB.prepare(
    `SELECT id FROM enrollment_codes
     WHERE code_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(codeHash)
    .first<{ id: string }>();
  if (!enrollment) return json({ error: "invalid_or_expired_enrollment" }, 401);

  const token = randomToken();
  const tokenHash = await sha256(token);
  const sessionId = crypto.randomUUID();
  const days = Math.min(Math.max(Number(env.SESSION_DAYS || "90"), 1), 365);
  await env.DB.batch([
    env.DB.prepare("UPDATE enrollment_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?").bind(enrollment.id),
    env.DB.prepare(
      "INSERT INTO device_sessions (id, token_hash, device_name, expires_at) VALUES (?, ?, ?, datetime('now', ?))",
    ).bind(sessionId, tokenHash, body.device_name.slice(0, 120), `+${days} days`),
  ]);
  return json(
    { authenticated: true, device_id: sessionId, expires_in_days: days },
    201,
    { "set-cookie": sessionCookie(token, days * 86400) },
  );
}

async function listDevices(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const devices = await env.DB.prepare(
    `SELECT id, device_name, created_at, last_seen_at, expires_at,
            CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END AS revoked
     FROM device_sessions ORDER BY created_at DESC`,
  ).all();
  return json({ current_device_id: auth.id, devices: devices.results });
}

async function revokeDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare(
    "UPDATE device_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(deviceId)
    .run();
  const headers: HeadersInit = deviceId === auth.id ? { "set-cookie": clearSessionCookie() } : {};
  return json({ revoked: result.meta.changes > 0 }, 200, headers);
}

type Profile = {
  id: string;
  label: string;
  summary: string;
  preferences_json: string;
  structured_json: string;
  created_at: string;
  updated_at: string;
};

function readDesiredLocations(preferencesJson: string): string {
  try {
    return (JSON.parse(preferencesJson || "{}") as { desired_locations?: string }).desired_locations ?? "";
  } catch {
    return "";
  }
}

function readDesiredRoles(preferencesJson: string): string {
  try {
    return (JSON.parse(preferencesJson || "{}") as { desired_roles?: string }).desired_roles ?? "";
  } catch {
    return "";
  }
}

function readStructuredProfile(structuredJson: string): StructuredProfile | null {
  try {
    const parsed = JSON.parse(structuredJson || "{}");
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

// Deterministic safety net on top of prompting: even if the model doesn't perfectly follow
// "don't drop entries," any old education/experience entry whose key doesn't reappear in the
// new output is re-added, so regenerating can only add or correct, never silently lose data.
function mergeStructuredProfiles(existing: StructuredProfile | null, incoming: StructuredProfile): StructuredProfile {
  if (!existing) return incoming;
  function mergeByKey<T>(oldList: T[], newList: T[], keyFn: (item: T) => string): T[] {
    const newKeys = new Set((newList ?? []).map(keyFn));
    const preserved = (oldList ?? []).filter((item) => !newKeys.has(keyFn(item)));
    return [...(newList ?? []), ...preserved];
  }
  function mergeSkills(oldSkills: string[], newSkills: string[]): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const skill of [...(newSkills ?? []), ...(oldSkills ?? [])]) {
      const key = skill.trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        merged.push(skill.trim());
      }
    }
    return merged;
  }
  return {
    headline: incoming.headline || existing.headline,
    narrative_summary: incoming.narrative_summary || existing.narrative_summary,
    education: mergeByKey(existing.education, incoming.education, (e) => `${e.school}|${e.degree}`.toLowerCase()),
    experience: mergeByKey(existing.experience, incoming.experience, (e) => `${e.company}|${e.title}`.toLowerCase()),
    skills: mergeSkills(existing.skills, incoming.skills),
  };
}

async function getProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const profile = await env.DB.prepare(
    "SELECT id, label, summary, preferences_json, structured_json, created_at, updated_at FROM candidate_profiles WHERE id = ?",
  )
    .bind(profileId)
    .first<Profile>();
  return json({
    profile: {
      ...profile,
      desired_roles: readDesiredRoles(profile?.preferences_json ?? "{}"),
      desired_locations: readDesiredLocations(profile?.preferences_json ?? "{}"),
      structured: readStructuredProfile(profile?.structured_json ?? "{}"),
    },
  });
}

async function saveStructuredProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { structured?: unknown };
  if (!body.structured || typeof body.structured !== "object") {
    return json({ error: "structured_required" }, 400);
  }
  const structured = body.structured as StructuredProfile;
  const profileId = await getOrCreateProfileId(env);
  // Recomputed on every save so the compact matching profile can never lag the real one.
  await env.DB.prepare(
    `UPDATE candidate_profiles SET structured_json = ?, summary = ?, match_profile = ?,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(
      JSON.stringify(structured),
      (structured.narrative_summary ?? "").slice(0, 4000),
      buildMatchProfile(structured),
      profileId,
    )
    .run();
  return json({ structured, match_profile: buildMatchProfile(structured) });
}

async function saveDesiredRoles(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { desired_roles?: string; desired_locations?: string };
  const desiredRoles = (body.desired_roles ?? "").trim();
  const desiredLocations = (body.desired_locations ?? "").trim();
  const profileId = await getOrCreateProfileId(env);
  const existing = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(existing?.preferences_json || "{}");
  } catch {
    prefs = {};
  }
  prefs.desired_roles = desiredRoles;
  prefs.desired_locations = desiredLocations;
  await env.DB.prepare("UPDATE candidate_profiles SET preferences_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(prefs), profileId)
    .run();
  return json({ desired_roles: desiredRoles, desired_locations: desiredLocations });
}

async function listRoleSignals(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const rows = await env.DB.prepare(
    "SELECT id, claim, created_at FROM candidate_evidence WHERE profile_id = ? AND category = 'role_signal' ORDER BY created_at DESC",
  )
    .bind(profileId)
    .all();
  return json({ role_signals: rows.results });
}

async function createRoleSignal(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { text?: string };
  const claim = (body.text ?? "").trim();
  if (!claim) return json({ error: "text_required" }, 400);
  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO candidate_evidence (id, profile_id, category, claim, usable_in_applications) VALUES (?, ?, 'role_signal', ?, 1)",
  )
    .bind(id, profileId, claim)
    .run();
  return json({ id, claim }, 201);
}

async function deleteRoleSignal(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare("DELETE FROM candidate_evidence WHERE id = ? AND category = 'role_signal'")
    .bind(id)
    .run();
  return json({ deleted: result.meta.changes > 0 });
}

async function generateDesiredRoles(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const provider = normalizeProvider(body.provider);
  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 501);
  if (provider === "openai" && !env.OPENAI_API_KEY) return json({ error: "openai_not_configured" }, 501);

  const profileId = await getOrCreateProfileId(env);
  const signals = await env.DB.prepare(
    "SELECT claim FROM candidate_evidence WHERE profile_id = ? AND category = 'role_signal' ORDER BY created_at ASC",
  )
    .bind(profileId)
    .all<{ claim: string }>();
  if (signals.results.length === 0) return json({ error: "no_source_material" }, 400);

  const prompt = [
    "A job candidate has given you loose notes, job links, and preferences about the kind of roles they want next.",
    "Write a clear, structured description of the roles they are looking for: role families/titles, seniority, domain,",
    "must-have vs nice-to-have aspects, and anything they explicitly ruled out. Base this only on the notes below.",
    "",
    "Notes:",
    ...signals.results.map((s) => `- ${s.claim}`),
  ].join("\n\n");

  try {
    const draft = await callText(env, provider, prompt);
    return json({ provider, draft_description: draft });
  } catch (err) {
    return json({ error: "generation_failed", detail: (err as Error).message }, 502);
  }
}

async function upsertProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { label?: string };
  const label = (body.label ?? "").trim();
  if (!label) return json({ error: "label_required" }, 400);
  const profileId = await getOrCreateProfileId(env);
  await env.DB.prepare("UPDATE candidate_profiles SET label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(label, profileId)
    .run();
  return json({ id: profileId, label });
}

type JobPosting = {
  id: string;
  title: string;
  company: string;
  source_url: string;
  raw_description: string;
  created_at: string;
};

async function listJobs(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const jobs = await env.DB.prepare(
    `SELECT id, title, company, source_url, raw_description, location, posted_at, ats_provider,
            company_id, fit_status, fit_reason, fit_missing_json, created_at
     FROM job_postings
     ORDER BY COALESCE(posted_at, created_at) DESC
     LIMIT 300`,
  ).all();
  return json({ jobs: jobs.results, counts: await jobPipelineCounts(env) });
}

/** Recent user-confirmed disqualifier reasons, most recent first, deduped case-insensitively. */
async function loadDisqualifiers(env: Env, profileId: string, limit = 25): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT reason FROM job_feedback WHERE profile_id = ? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(profileId)
    .all<{ reason: string }>();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows.results ?? []) {
    const key = row.reason.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row.reason.trim());
    if (out.length >= limit) break;
  }
  return out;
}

type JobRow = { id: string; title: string; company: string; location: string; raw_description: string };

function toAssessable(rows: JobRow[]) {
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    description: r.raw_description ?? "",
  }));
}

/**
 * Runs the filtering pipeline: cheap screen first, strong assessment only on what survives.
 *
 * Both tiers run in one request, bounded by a shared call budget, and the response reports what
 * is left at each stage so the dashboard can simply ask again. Doing the cheap pass first is the
 * whole point -- most scraped postings are obvious misses, and paying strong-model rates to
 * discover that is the expensive way to run this.
 */
async function processJobs(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string; calls?: number };
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const profileId = await getOrCreateProfileId(env);
  const profileRow = await env.DB.prepare(
    "SELECT preferences_json, structured_json, match_profile FROM candidate_profiles WHERE id = ?",
  )
    .bind(profileId)
    .first<{ preferences_json: string; structured_json: string; match_profile: string }>();
  const structured = readStructuredProfile(profileRow?.structured_json ?? "{}");
  if (!structured) return json({ error: "no_profile_yet" }, 400);
  // Backfills for profiles saved before match_profile existed.
  const matchProfile = profileRow?.match_profile?.trim() || buildMatchProfile(structured);
  const desiredRoles = readDesiredRoles(profileRow?.preferences_json ?? "{}");
  const disqualifiers = await loadDisqualifiers(env, profileId);

  const budget = { remaining: Math.min(Math.max(Number(body.calls) || 6, 1), 12) };
  const errors: string[] = [];
  let screened = 0;
  let screenedOut = 0;
  let assessed = 0;

  // Tier 1: cheap bulk screen over everything untouched.
  while (budget.remaining > 0) {
    const rows = await env.DB.prepare(
      `SELECT id, title, company, location, raw_description FROM job_postings
       WHERE fit_status = 'unassessed' ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(SCREEN_BATCH_SIZE)
      .all<JobRow>();
    const batch = toAssessable(rows.results ?? []);
    if (!batch.length) break;
    budget.remaining -= 1;
    try {
      const results = await screenJobsBatch(env, provider, matchProfile, desiredRoles, disqualifiers, batch);
      for (const result of results) {
        await env.DB.prepare(
          "UPDATE job_postings SET fit_status = ?, fit_reason = ?, screened_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
          .bind(result.keep ? "screened_in" : "screened_out", result.keep ? "" : result.note, result.id)
          .run();
        if (!result.keep) screenedOut += 1;
      }
      screened += results.length;
    } catch (err) {
      errors.push(`screen: ${(err as Error).message}`);
      break;
    }
  }

  // Tier 2: strong model, only on survivors.
  while (budget.remaining > 0) {
    const rows = await env.DB.prepare(
      `SELECT id, title, company, location, raw_description FROM job_postings
       WHERE fit_status = 'screened_in' ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(FIT_BATCH_SIZE)
      .all<JobRow>();
    const batch = toAssessable(rows.results ?? []);
    if (!batch.length) break;
    budget.remaining -= 1;
    try {
      const results = await assessJobFitBatch(
        env,
        provider,
        JSON.stringify(structured),
        desiredRoles,
        disqualifiers,
        batch,
      );
      await storeFitResults(env, results);
      assessed += results.length;
    } catch (err) {
      errors.push(`assess: ${(err as Error).message}`);
      break;
    }
  }

  const counts = await jobPipelineCounts(env);
  return json({ screened, screened_out: screenedOut, assessed, errors, counts });
}

/** Row counts per pipeline stage, used for both the Jobs status line and the Data tab. */
async function jobPipelineCounts(env: Env): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    "SELECT fit_status, COUNT(*) AS n FROM job_postings GROUP BY fit_status",
  ).all<{ fit_status: string; n: number }>();
  const counts: Record<string, number> = {
    unassessed: 0,
    screened_in: 0,
    screened_out: 0,
    strong: 0,
    possible: 0,
    reject: 0,
  };
  for (const row of rows.results ?? []) counts[row.fit_status] = row.n;
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

// ---------------------------------------------------------------------------
// Stored data: inspection and stage-scoped resets
// ---------------------------------------------------------------------------

/**
 * The pipeline, as an ordered list. Each stage produces data that the stages after it depend on,
 * so resetting one has to clear everything downstream -- otherwise you get postings pointing at
 * companies that no longer exist, or fit verdicts computed against descriptions that are gone.
 */
const PIPELINE_STAGES = [
  {
    id: "companies",
    name: "Target companies",
    detail: "The company list itself. Clearing it also removes every posting scanned from those companies.",
  },
  {
    id: "listings",
    name: "Job listings",
    detail: "Postings scraped from company boards, with their titles, links, locations and dates.",
  },
  {
    id: "descriptions",
    name: "Job descriptions",
    detail: "The description text on each posting. This is the largest thing stored; clearing it keeps the listings but forces a re-scan before screening can run again.",
  },
  {
    id: "screening",
    name: "Screening + assessment",
    detail: "Every fit verdict, reason and gap list. Clearing it returns all postings to unscreened so the pipeline can run from scratch.",
  },
] as const;

async function dataSummary(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const count = async (sql: string): Promise<number> =>
    (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;

  const [companies, jobs, documents, notes, roleSignals, resumes, feedback, descBytes, docBytes] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM companies"),
    count("SELECT COUNT(*) AS n FROM job_postings"),
    count("SELECT COUNT(*) AS n FROM source_documents"),
    count("SELECT COUNT(*) AS n FROM candidate_evidence WHERE category = 'note'"),
    count("SELECT COUNT(*) AS n FROM candidate_evidence WHERE category = 'role_signal'"),
    count("SELECT COUNT(*) AS n FROM resumes"),
    count("SELECT COUNT(*) AS n FROM job_feedback"),
    count("SELECT COALESCE(SUM(LENGTH(raw_description)), 0) AS n FROM job_postings"),
    count("SELECT COALESCE(SUM(LENGTH(extracted_text)), 0) AS n FROM source_documents"),
  ]);

  return json({
    stages: PIPELINE_STAGES,
    counts: {
      companies,
      jobs,
      documents,
      notes,
      role_signals: roleSignals,
      resumes,
      feedback,
    },
    pipeline: await jobPipelineCounts(env),
    bytes: { job_descriptions: descBytes, document_text: docBytes },
  });
}

/** Clears one pipeline stage and everything downstream of it. */
async function purgeStage(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { stage?: string };
  const index = PIPELINE_STAGES.findIndex((s) => s.id === body.stage);
  if (index < 0) return json({ error: "unknown_stage" }, 400);

  const cleared: string[] = [];
  // Walk from the requested stage forward so downstream data always goes with it.
  for (const stage of PIPELINE_STAGES.slice(index)) {
    if (stage.id === "companies") {
      // Postings cascade via the companies foreign key, but manually added jobs have no
      // company_id and are the user's own work, so they are deliberately left alone.
      await env.DB.prepare("DELETE FROM companies").run();
      cleared.push("companies");
    } else if (stage.id === "listings") {
      await env.DB.prepare("DELETE FROM job_postings WHERE company_id IS NOT NULL").run();
      cleared.push("listings");
    } else if (stage.id === "descriptions") {
      await env.DB.prepare("UPDATE job_postings SET raw_description = ''").run();
      cleared.push("descriptions");
    } else if (stage.id === "screening") {
      await env.DB.prepare(
        `UPDATE job_postings SET fit_status = 'unassessed', fit_reason = '', fit_missing_json = '[]',
         screened_at = NULL, assessed_at = NULL`,
      ).run();
      cleared.push("screening");
    }
  }
  return json({ cleared, pipeline: await jobPipelineCounts(env) });
}

/** Deletes one standalone collection that isn't part of the job pipeline. */
async function purgeCollection(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { collection?: string };
  const statements: Record<string, string> = {
    feedback: "DELETE FROM job_feedback",
    resumes: "DELETE FROM resumes",
    notes: "DELETE FROM candidate_evidence WHERE category = 'note'",
    role_signals: "DELETE FROM candidate_evidence WHERE category = 'role_signal'",
    manual_jobs: "DELETE FROM job_postings WHERE company_id IS NULL",
  };
  const sql = statements[body.collection ?? ""];
  if (!sql) return json({ error: "unknown_collection" }, 400);
  const result = await env.DB.prepare(sql).run();
  return json({ deleted: result.meta.changes ?? 0 });
}

async function storeFitResults(env: Env, results: FitResult[]): Promise<void> {
  for (const result of results) {
    await env.DB.prepare(
      `UPDATE job_postings SET fit_status = ?, fit_reason = ?, fit_missing_json = ?, assessed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(result.verdict, result.reason, JSON.stringify(result.missing), result.id)
      .run();
  }
}

async function setJobFit(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { action?: string; reason?: string };
  const job = await env.DB.prepare("SELECT title, company FROM job_postings WHERE id = ?")
    .bind(id)
    .first<{ title: string; company: string }>();
  if (!job) return json({ error: "not_found" }, 404);

  if (body.action === "restore") {
    await env.DB.prepare(
      "UPDATE job_postings SET fit_status = 'unassessed', fit_reason = '', assessed_at = NULL WHERE id = ?",
    )
      .bind(id)
      .run();
    return json({ id, fit_status: "unassessed" });
  }

  const reason = (body.reason ?? "").trim();
  await env.DB.prepare(
    "UPDATE job_postings SET fit_status = 'reject', fit_reason = ?, assessed_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(reason || "Not a fit.", id)
    .run();

  // Only an explicit, user-typed reason becomes a durable disqualifier -- a bare "not for me"
  // click with nothing typed teaches the system nothing, which is the right default.
  if (reason) {
    const profileId = await getOrCreateProfileId(env);
    await env.DB.prepare(
      "INSERT INTO job_feedback (id, profile_id, job_id, title, company, reason) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), profileId, id, job.title, job.company, reason)
      .run();
  }

  return json({ id, fit_status: "reject", reason });
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

async function listCompanies(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const rows = await env.DB.prepare(
    `SELECT id, name, website, careers_url, bio, location, why_fit, ats_provider, status, source,
            scan_note, last_scanned_at, open_jobs, created_at
     FROM companies WHERE profile_id = ? ORDER BY name COLLATE NOCASE ASC`,
  )
    .bind(profileId)
    .all();
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM companies WHERE profile_id = ? AND status != 'dismissed' AND last_scanned_at IS NULL",
  )
    .bind(profileId)
    .first<{ n: number }>();

  // Companies added before a location was set (or under a different one) get flagged rather than
  // deleted, so tightening the filter never silently discards work.
  const prefsRow = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const desiredLocations = readDesiredLocations(prefsRow?.preferences_json ?? "{}");
  const locationTerms = parseLocationFilter(desiredLocations);
  const companies = (rows.results as Record<string, unknown>[]).map((row) => ({
    ...row,
    off_target: !locationMatches(String(row.location ?? ""), locationTerms),
  }));

  return json({
    companies,
    unscanned: pending?.n ?? 0,
    desired_locations: desiredLocations,
    off_target: companies.filter((c) => c.off_target).length,
  });
}

async function addCompanyRow(
  env: Env,
  profileId: string,
  company: {
    name: string;
    website: string;
    careers_url: string;
    bio: string;
    location: string;
    why_fit: string;
    status: string;
    source: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO companies
       (id, profile_id, name, name_key, website, careers_url, bio, location, why_fit, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      profileId,
      company.name,
      companyNameKey(company.name),
      company.website,
      company.careers_url,
      company.bio,
      company.location,
      company.why_fit,
      company.status,
      company.source,
    )
    .run();
  return result.meta.changes > 0;
}

async function createCompany(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    website?: string;
    careers_url?: string;
    bio?: string;
    location?: string;
  };
  const name = (body.name ?? "").trim();
  if (!name) return json({ error: "name_required" }, 400);
  const profileId = await getOrCreateProfileId(env);
  const added = await addCompanyRow(env, profileId, {
    name,
    website: (body.website ?? "").trim(),
    careers_url: (body.careers_url ?? "").trim(),
    bio: (body.bio ?? "").trim(),
    location: (body.location ?? "").trim(),
    why_fit: "",
    status: "reachable",
    source: "manual",
  });
  return json({ added }, added ? 201 : 200);
}

/**
 * Proposes companies from the candidate's own profile, then checks each proposed site actually
 * resolves before trusting it. A model listing employers will occasionally invent or misremember
 * one, so nothing here is taken on faith.
 */
async function discoverCompanies(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    provider?: string;
    count?: number;
    focus?: string;
  };
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const profileId = await getOrCreateProfileId(env);
  const profileRow = await env.DB.prepare(
    "SELECT preferences_json, structured_json FROM candidate_profiles WHERE id = ?",
  )
    .bind(profileId)
    .first<{ preferences_json: string; structured_json: string }>();
  const structured = readStructuredProfile(profileRow?.structured_json ?? "{}");
  if (!structured) return json({ error: "no_profile_yet" }, 400);
  const desiredRoles = readDesiredRoles(profileRow?.preferences_json ?? "{}");

  const existing = await env.DB.prepare("SELECT name FROM companies WHERE profile_id = ?")
    .bind(profileId)
    .all<{ name: string }>();
  const existingNames = (existing.results ?? []).map((r) => r.name);

  const desiredLocations = readDesiredLocations(profileRow?.preferences_json ?? "{}");
  const locationTerms = parseLocationFilter(desiredLocations);

  const count = Math.min(Math.max(Number(body.count) || 10, 1), 20);
  let proposals;
  try {
    proposals = await proposeCompanies(
      env,
      provider,
      JSON.stringify(structured),
      desiredRoles,
      existingNames,
      count,
      (body.focus ?? "").trim(),
      desiredLocations,
    );
  } catch (err) {
    return json({ error: "discovery_failed", detail: (err as Error).message }, 502);
  }

  const known = new Set(existingNames.map(companyNameKey));
  const deduped = proposals.filter((p) => {
    const key = companyNameKey(p.name);
    if (!key || known.has(key)) return false;
    known.add(key);
    return true;
  });

  // The prompt states the location requirement, but a model treats it as guidance often enough
  // that it has to be enforced here too rather than trusted.
  const fresh = deduped.filter((p) => locationMatches(p.location, locationTerms));
  const offTarget = deduped.length - fresh.length;

  let added = 0;
  let unreachable = 0;
  for (const proposal of fresh) {
    const reachable = await verifyWebsite(proposal.website);
    if (!reachable) unreachable += 1;
    const inserted = await addCompanyRow(env, profileId, {
      ...proposal,
      status: reachable ? "reachable" : "unreachable",
      source: "ai",
    });
    if (inserted) added += 1;
  }

  return json({
    added,
    proposed: proposals.length,
    duplicates: proposals.length - deduped.length,
    off_target: offTarget,
    unreachable,
    locations: desiredLocations,
  });
}

/**
 * Reads job boards for companies that need it. Each company costs several outbound requests, so
 * this works in bounded batches against a shared subrequest budget and reports what is left --
 * the dashboard just calls it again rather than risking a single oversized request.
 */
async function scanCompanies(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { limit?: number; company_id?: string };
  const profileId = await getOrCreateProfileId(env);

  const profileRow = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const desiredRoles = readDesiredRoles(profileRow?.preferences_json ?? "{}");
  const locationTerms = parseLocationFilter(readDesiredLocations(profileRow?.preferences_json ?? "{}"));

  const limit = Math.min(Math.max(Number(body.limit) || 6, 1), 12);
  const targets = body.company_id
    ? await env.DB.prepare(
        "SELECT id, name, website, careers_url, ats_provider, ats_token FROM companies WHERE id = ? AND profile_id = ?",
      )
        .bind(body.company_id, profileId)
        .all<CompanyScanRow>()
    : await env.DB.prepare(
        `SELECT id, name, website, careers_url, ats_provider, ats_token
         FROM companies
         WHERE profile_id = ? AND status != 'dismissed'
         ORDER BY last_scanned_at IS NOT NULL, last_scanned_at ASC
         LIMIT ?`,
      )
        .bind(profileId, limit)
        .all<CompanyScanRow>();

  const budget = { remaining: 40 };
  const results: { company: string; jobs: number; new_jobs: number; note: string }[] = [];
  let newListings = 0;

  for (const company of targets.results ?? []) {
    const outcome = await scanOneCompany(env, company, desiredRoles, locationTerms, budget);
    results.push({ company: company.name, jobs: outcome.jobs, new_jobs: outcome.newJobs, note: outcome.note });
    newListings += outcome.newJobs;
    if (budget.remaining <= 2) break;
  }

  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM companies WHERE profile_id = ? AND status != 'dismissed' AND last_scanned_at IS NULL",
  )
    .bind(profileId)
    .first<{ n: number }>();

  return json({ scanned: results.length, results, new_listings: newListings, unscanned: remaining?.n ?? 0 });
}

type CompanyScanRow = {
  id: string;
  name: string;
  website: string;
  careers_url: string;
  ats_provider: string;
  ats_token: string;
};

async function scanOneCompany(
  env: Env,
  company: CompanyScanRow,
  desiredRoles: string,
  locationTerms: string[],
  budget: { remaining: number },
): Promise<{ jobs: number; newJobs: number; note: string }> {
  let provider = company.ats_provider as AtsProvider | "" | "none";
  let token = company.ats_token;

  if (!provider || provider === "none") {
    const resolved = await resolveBoard(company.website, company.careers_url, budget);
    if (!resolved) {
      await env.DB.prepare(
        `UPDATE companies SET ats_provider = 'none', scan_note = ?, last_scanned_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
        .bind("No supported job board found on their site.", company.id)
        .run();
      return { jobs: 0, newJobs: 0, note: "no supported board found" };
    }
    provider = resolved.provider;
    token = resolved.token;
  }

  let scanned;
  try {
    budget.remaining -= 1;
    scanned = await fetchBoardJobs(provider as AtsProvider, token);
  } catch (err) {
    await env.DB.prepare(
      `UPDATE companies SET scan_note = ?, last_scanned_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
      .bind(`Board read failed: ${(err as Error).message}`, company.id)
      .run();
    return { jobs: 0, newJobs: 0, note: "board read failed" };
  }

  // A company can qualify on location while most of its postings don't, so each posting is
  // checked on its own rather than inherited from the company.
  const inArea = scanned.filter((job) => locationMatches(job.location, locationTerms));
  const relevant = filterJobsByRoles(inArea, desiredRoles)
    .filter((job) => job.title && job.external_id)
    .map((job) => ({ ...job, id: crypto.randomUUID() }));

  // Scanning only collects listings. Judging them is a separate, explicitly triggered stage, so
  // a scan stays cheap and fast and can cover far more companies per request.
  let newJobs = 0;
  for (const job of relevant) {
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO job_postings
         (id, title, company, source_url, raw_description, location, posted_at, ats_provider, company_id,
          external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        job.id,
        job.title,
        company.name,
        job.url,
        // Only the opening of a description is ever needed for screening, and this is the single
        // biggest column in the database, so it is capped on the way in.
        (job.description ?? "").slice(0, 1500),
        job.location,
        job.posted_at || null,
        provider,
        company.id,
        job.external_id,
      )
      .run();
    // relevant.length also counts postings the board already showed on a previous scan;
    // meta.changes is the only reliable signal for "actually new this time".
    if (inserted.meta.changes > 0) newJobs += 1;
  }

  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_postings WHERE company_id = ?")
    .bind(company.id)
    .first<{ n: number }>();

  const note =
    relevant.length === scanned.length
      ? `${scanned.length} open role${scanned.length === 1 ? "" : "s"} on their board.`
      : `${relevant.length} of ${scanned.length} open roles match your target roles and locations.`;

  await env.DB.prepare(
    `UPDATE companies SET ats_provider = ?, ats_token = ?, open_jobs = ?, scan_note = ?,
     last_scanned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(provider, token, total?.n ?? 0, note, company.id)
    .run();

  return { jobs: relevant.length, newJobs, note };
}

async function updateCompany(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { status?: string };
  const status = body.status === "dismissed" ? "dismissed" : "reachable";
  const result = await env.DB.prepare(
    "UPDATE companies SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(status, id)
    .run();
  return json({ updated: result.meta.changes > 0, status });
}

async function deleteCompany(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare("DELETE FROM companies WHERE id = ?").bind(id).run();
  return json({ deleted: result.meta.changes > 0 });
}

async function createJob(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    company?: string;
    source_url?: string;
    raw_description?: string;
  };
  const title = (body.title ?? "").trim();
  const company = (body.company ?? "").trim();
  const raw_description = (body.raw_description ?? "").trim();
  const source_url = (body.source_url ?? "").trim();
  if (!title || !company || !raw_description) {
    return json({ error: "title_company_and_raw_description_required" }, 400);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO job_postings (id, title, company, source_url, raw_description) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, title, company, source_url, raw_description)
    .run();
  return json({ id, title, company, source_url, raw_description }, 201);
}

async function deleteJob(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare("DELETE FROM job_postings WHERE id = ?").bind(id).run();
  return json({ deleted: result.meta.changes > 0 });
}

async function getOrCreateProfileId(env: Env): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT id FROM candidate_profiles ORDER BY created_at ASC LIMIT 1",
  ).first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO candidate_profiles (id, label, summary) VALUES (?, '', '')").bind(id).run();
  return id;
}

const DOCUMENT_TYPES = new Set(["application/pdf", "text/plain", "text/markdown"]);

async function listDocuments(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const docs = await env.DB.prepare(
    `SELECT id, original_name, media_type, created_at, LENGTH(extracted_text) > 0 AS has_text
     FROM source_documents WHERE profile_id = ? ORDER BY created_at DESC`,
  )
    .bind(profileId)
    .all();
  return json({ documents: docs.results });
}

async function uploadDocument(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (file.size > 15 * 1024 * 1024) return json({ error: "file_too_large" }, 413);
  if (!DOCUMENT_TYPES.has(file.type)) return json({ error: "unsupported_media_type" }, 415);

  const bytes = await file.arrayBuffer();
  const sha = await digestHex(bytes);
  let extractedText = "";
  if (file.type === "text/plain" || file.type === "text/markdown") {
    extractedText = new TextDecoder().decode(bytes);
  } else if (file.type === "application/pdf") {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      extractedText = text;
    } catch {
      extractedText = "";
    }
  }
  const key = `documents/${crypto.randomUUID()}`;
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName: file.name, uploadedByDevice: auth.id },
  });

  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO source_documents (id, profile_id, original_name, r2_key, media_type, sha256, extracted_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, profileId, file.name, key, file.type, sha, extractedText)
    .run();
  return json({ id, original_name: file.name, media_type: file.type, has_text: extractedText.length > 0 }, 201);
}

async function renameDocument(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { original_name?: string };
  const name = (body.original_name ?? "").trim();
  if (!name) return json({ error: "original_name_required" }, 400);
  await env.DB.prepare("UPDATE source_documents SET original_name = ? WHERE id = ?").bind(name, id).run();
  return json({ id, original_name: name });
}

async function getDocumentFile(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const doc = await env.DB.prepare("SELECT r2_key, media_type, original_name FROM source_documents WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string; media_type: string; original_name: string }>();
  if (!doc) return json({ error: "not_found" }, 404);
  // PDF viewers (Adobe's plugin especially) fetch large files in chunks via Range requests;
  // without honoring those and replying 206/Content-Range, some viewers fail to load entirely.
  const object = await env.FILES.get(doc.r2_key, { range: request.headers });
  if (!object) return json({ error: "not_found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", doc.media_type);
  headers.set("content-disposition", `inline; filename="${doc.original_name.replace(/["\r\n]/g, "")}"`);
  headers.set("cache-control", "private, no-store");
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (object.range && "offset" in object.range && "end" in object.range) {
    headers.set("content-range", `bytes ${object.range.offset}-${object.range.end}/${object.size}`);
  }
  const status = request.headers.get("range") !== null ? 206 : 200;
  return new Response(object.body, { headers, status });
}

async function deleteDocument(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const doc = await env.DB.prepare("SELECT r2_key FROM source_documents WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string }>();
  if (!doc) return json({ error: "not_found" }, 404);
  await env.FILES.delete(doc.r2_key);
  await env.DB.prepare("DELETE FROM source_documents WHERE id = ?").bind(id).run();
  return json({ deleted: true });
}

async function listNotes(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const notes = await env.DB.prepare(
    "SELECT id, claim, created_at FROM candidate_evidence WHERE profile_id = ? AND category = 'note' ORDER BY created_at DESC",
  )
    .bind(profileId)
    .all();
  return json({ notes: notes.results });
}

async function createNote(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { text?: string };
  const claim = (body.text ?? "").trim();
  if (!claim) return json({ error: "text_required" }, 400);
  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO candidate_evidence (id, profile_id, category, claim, usable_in_applications) VALUES (?, ?, 'note', ?, 1)",
  )
    .bind(id, profileId, claim)
    .run();
  return json({ id, claim }, 201);
}

async function deleteNote(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare("DELETE FROM candidate_evidence WHERE id = ? AND category = 'note'")
    .bind(id)
    .run();
  return json({ deleted: result.meta.changes > 0 });
}


const STRUCTURED_PROFILE_JSON_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "A one-line professional headline, e.g. 'Senior AI Engineer'." },
    narrative_summary: { type: "string", description: "A short prose summary, 3-6 sentences, useful for a cover letter." },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          school: { type: "string" },
          degree: { type: "string" },
          field: { type: "string" },
          start_year: { type: "string" },
          end_year: { type: "string" },
        },
        required: ["school"],
      },
    },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          highlights: { type: "array", items: { type: "string" } },
        },
        required: ["company", "title"],
      },
    },
    skills: { type: "array", items: { type: "string" } },
  },
  required: ["headline", "narrative_summary", "education", "experience", "skills"],
} as const;


async function generateProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const provider = normalizeProvider(body.provider);
  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 501);
  if (provider === "openai" && !env.OPENAI_API_KEY) return json({ error: "openai_not_configured" }, 501);

  const profileId = await getOrCreateProfileId(env);
  const profile = await env.DB.prepare("SELECT structured_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ structured_json: string }>();
  const notes = await env.DB.prepare(
    "SELECT claim FROM candidate_evidence WHERE profile_id = ? AND category = 'note' ORDER BY created_at ASC",
  )
    .bind(profileId)
    .all<{ claim: string }>();
  const docs = await env.DB.prepare(
    `SELECT original_name, extracted_text FROM source_documents
     WHERE profile_id = ? AND LENGTH(extracted_text) > 0 ORDER BY created_at ASC`,
  )
    .bind(profileId)
    .all<{ original_name: string; extracted_text: string }>();

  const sourceParts: string[] = [];
  for (const note of notes.results) sourceParts.push(`Note: ${note.claim}`);
  for (const doc of docs.results) sourceParts.push(`Document "${doc.original_name}":\n${doc.extracted_text.slice(0, 8000)}`);

  if (sourceParts.length === 0) return json({ error: "no_source_material" }, 400);

  const existingStructured = readStructuredProfile(profile?.structured_json ?? "{}");
  const prompt = [
    "You are updating a job candidate's structured professional profile: education history, work experience with",
    "highlights, skills, a headline, and a short narrative summary.",
    existingStructured
      ? "This candidate already has a profile (given below as 'Current profile'). Treat it as the baseline: " +
        "keep every education and experience entry from it that the new material below does not contradict, even " +
        "if the new material doesn't happen to repeat it. Only change a specific field, or add a new entry, when " +
        "the new material below adds information or directly conflicts with what's already there. Never silently " +
        "drop an entry just because it isn't mentioned again."
      : "Base this on the material below.",
    "Do not invent schools, employers, dates, or accomplishments that are not present in the current profile or",
    "the new material. Leave a field empty rather than guessing.",
    "",
    ...(existingStructured ? [`Current profile:\n${JSON.stringify(existingStructured)}`, ""] : []),
    "New material:",
    ...sourceParts,
  ].join("\n\n");

  try {
    const raw = await callStructured<StructuredProfile>(
      env,
      provider,
      prompt,
      STRUCTURED_PROFILE_JSON_SCHEMA,
      "submit_structured_profile",
      2000,
    );
    const draft = mergeStructuredProfiles(existingStructured, raw);
    return json({ provider, draft_structured: draft });
  } catch (err) {
    return json({ error: "generation_failed", detail: (err as Error).message }, 502);
  }
}

async function listResumes(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const rows = await env.DB.prepare(
    `SELECT id, name, instructions, template, revision, checks_json, critique, created_at
     FROM resumes WHERE profile_id = ? ORDER BY created_at DESC`,
  )
    .bind(profileId)
    .all();
  return json({ resumes: rows.results, templates: TEMPLATES });
}

/** Loads the evidence every resume is built from, or the error response explaining why it can't. */
async function loadProfileForResume(
  env: Env,
): Promise<{ profileId: string; structured: StructuredProfile; desiredRoles: string } | Response> {
  const profileId = await getOrCreateProfileId(env);
  const row = await env.DB.prepare(
    "SELECT preferences_json, structured_json FROM candidate_profiles WHERE id = ?",
  )
    .bind(profileId)
    .first<{ preferences_json: string; structured_json: string }>();
  const structured = readStructuredProfile(row?.structured_json ?? "{}");
  if (!structured) return json({ error: "no_profile_yet" }, 400);
  return { profileId, structured, desiredRoles: readDesiredRoles(row?.preferences_json ?? "{}") };
}

/**
 * compose -> render -> check, shared by first generation and by every revision so a revised
 * resume is validated exactly as strictly as a fresh one.
 */
async function buildResumeVersion(
  env: Env,
  resumeId: string,
  provider: Provider,
  structured: StructuredProfile,
  desiredRoles: string,
  instructions: string,
  layout: LayoutSpec,
  feedback: string,
): Promise<{ doc: ResumeDoc; pdfKey: string; screenshotBase64: string; checks: ResumeCheck[] }> {
  const doc = await composeResumeDoc(env, provider, structured, desiredRoles, instructions, layout, feedback);
  const html = renderResumeHtml(doc, layout);
  const { pdfKey, pdfBytes, screenshotBase64 } = await renderResumeArtifacts(env, resumeId, html);
  const checks = await runAllChecks(pdfBytes, doc, structured, layout);
  return { doc, pdfKey, screenshotBase64, checks };
}

async function createResume(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    instructions?: string;
    provider?: string;
    template?: string;
    max_pages?: number;
  };
  const instructions = (body.instructions ?? "").trim();
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const profile = await loadProfileForResume(env);
  if (profile instanceof Response) return profile;

  const layout = normalizeLayout({
    ...defaultLayout(normalizeTemplate(body.template)),
    max_pages: body.max_pages ?? 1,
  });

  const id = crypto.randomUUID();
  let built;
  try {
    built = await buildResumeVersion(
      env,
      id,
      provider,
      profile.structured,
      profile.desiredRoles,
      instructions,
      layout,
      "",
    );
  } catch (err) {
    return json({ error: "generation_failed", detail: (err as Error).message }, 502);
  }

  const name = instructions ? instructions.slice(0, 60) : `Resume ${new Date().toISOString().slice(0, 10)}`;
  await env.DB.prepare(
    `INSERT INTO resumes (id, profile_id, name, instructions, content_json, pdf_r2_key, template, layout_json, checks_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      profile.profileId,
      name,
      instructions,
      JSON.stringify(built.doc),
      built.pdfKey,
      layout.template,
      JSON.stringify(layout),
      JSON.stringify(built.checks),
    )
    .run();

  return json({ id, name, template: layout.template, revision: 1, checks: built.checks }, 201);
}

/**
 * The design-review loop: screenshot what we rendered, have a vision model critique it as a
 * designer would, then apply its (clamped) layout changes and, when it says the writing itself
 * is the problem, re-compose from verified evidence with its guidance. The user's own comment,
 * when given, outranks the model's opinion.
 */
async function reviewResume(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { comment?: string; provider?: string };
  const comment = (body.comment ?? "").trim();
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const profile = await loadProfileForResume(env);
  if (profile instanceof Response) return profile;

  const row = await env.DB.prepare(
    "SELECT instructions, content_json, layout_json, checks_json, revision FROM resumes WHERE id = ? AND profile_id = ?",
  )
    .bind(id, profile.profileId)
    .first<{
      instructions: string;
      content_json: string;
      layout_json: string;
      checks_json: string;
      revision: number;
    }>();
  if (!row) return json({ error: "not_found" }, 404);

  const layout = normalizeLayout(JSON.parse(row.layout_json || "{}"));
  const doc = JSON.parse(row.content_json || "{}") as ResumeDoc;
  const previousChecks = JSON.parse(row.checks_json || "[]") as ResumeCheck[];

  try {
    // Re-render the current version so the reviewer sees exactly what is stored.
    const current = await renderResumeArtifacts(env, id, renderResumeHtml(doc, layout));
    const review = await reviewResumeDesign(
      env,
      provider,
      current.screenshotBase64,
      layout,
      previousChecks,
      comment,
    );

    const nextLayout = applyLayoutAdjustments(layout, review.layout_adjustments);
    const feedback = [review.needs_content_revision ? review.content_guidance : "", comment]
      .filter(Boolean)
      .join("\n");

    let built;
    if (feedback) {
      built = await buildResumeVersion(
        env,
        id,
        provider,
        profile.structured,
        profile.desiredRoles,
        row.instructions ?? "",
        nextLayout,
        feedback,
      );
    } else {
      // Layout-only fix: keep the approved wording, just re-render it.
      const html = renderResumeHtml(doc, nextLayout);
      const rendered = await renderResumeArtifacts(env, id, html);
      built = {
        doc,
        pdfKey: rendered.pdfKey,
        screenshotBase64: rendered.screenshotBase64,
        checks: await runAllChecks(rendered.pdfBytes, doc, profile.structured, nextLayout),
      };
    }

    const revision = (row.revision ?? 1) + 1;
    await env.DB.prepare(
      `UPDATE resumes SET content_json = ?, pdf_r2_key = ?, layout_json = ?, checks_json = ?, critique = ?,
       revision = ?, template = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
      .bind(
        JSON.stringify(built.doc),
        built.pdfKey,
        JSON.stringify(nextLayout),
        JSON.stringify(built.checks),
        review.critique,
        revision,
        nextLayout.template,
        id,
      )
      .run();

    return json({
      id,
      revision,
      verdict: review.verdict,
      critique: review.critique,
      layout: nextLayout,
      content_revised: Boolean(feedback),
      checks: built.checks,
    });
  } catch (err) {
    return json({ error: "review_failed", detail: (err as Error).message }, 502);
  }
}

async function renameResume(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim();
  if (!name) return json({ error: "name_required" }, 400);
  await env.DB.prepare("UPDATE resumes SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(name, id).run();
  return json({ id, name });
}

async function deleteResume(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const row = await env.DB.prepare("SELECT pdf_r2_key FROM resumes WHERE id = ?")
    .bind(id)
    .first<{ pdf_r2_key: string | null }>();
  if (!row) return json({ error: "not_found" }, 404);
  if (row.pdf_r2_key) await env.FILES.delete(row.pdf_r2_key);
  await env.DB.prepare("DELETE FROM resumes WHERE id = ?").bind(id).run();
  return json({ deleted: true });
}

async function getResumeFile(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const row = await env.DB.prepare("SELECT pdf_r2_key, name FROM resumes WHERE id = ?")
    .bind(id)
    .first<{ pdf_r2_key: string | null; name: string }>();
  if (!row?.pdf_r2_key) return json({ error: "not_found" }, 404);
  const object = await env.FILES.get(row.pdf_r2_key, { range: request.headers });
  if (!object) return json({ error: "not_found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", "application/pdf");
  headers.set("content-disposition", `inline; filename="${row.name.replace(/["\r\n]/g, "")}.pdf"`);
  headers.set("cache-control", "private, no-store");
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (object.range && "offset" in object.range && "end" in object.range) {
    headers.set("content-range", `bytes ${object.range.offset}-${object.range.end}/${object.size}`);
  }
  const status = request.headers.get("range") !== null ? 206 : 200;
  return new Response(object.body, { headers, status });
}

async function uploadArtifact(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (file.size > 15 * 1024 * 1024) return json({ error: "file_too_large" }, 413);
  const allowed = new Set(["application/pdf", "text/plain", "text/markdown"]);
  if (!allowed.has(file.type)) return json({ error: "unsupported_media_type" }, 415);
  const key = `uploads/${crypto.randomUUID()}`;
  await env.FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName: file.name, uploadedByDevice: auth.id },
  });
  return json({ key, name: file.name, media_type: file.type, size: file.size }, 201);
}

const ENROLL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ApplyGo Device Enrollment</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.35rem; }
  label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
  input { width: 100%; padding: 0.6rem; font-size: 1rem; box-sizing: border-box; }
  button { margin-top: 1.5rem; padding: 0.7rem 1.25rem; font-size: 1rem; width: 100%; cursor: pointer; }
  #status { margin-top: 1rem; font-weight: 600; min-height: 1.25rem; }
  #status.success { color: #16794e; }
  #status.error { color: #b3261e; }
</style>
</head>
<body>
  <main>
    <h1>Enroll this device</h1>
    <p>Enter the one-time enrollment code and a name for this device. The code is single-use and expires quickly.</p>
    <form id="enroll-form">
      <label for="code">Enrollment code</label>
      <input id="code" name="code" autocomplete="one-time-code" required>
      <label for="device_name">Device name</label>
      <input id="device_name" name="device_name" required placeholder="e.g. Jason's iPhone">
      <button type="submit">Enroll device</button>
    </form>
    <p id="status" role="status" aria-live="polite"></p>
  </main>
  <script>
    var form = document.getElementById('enroll-form');
    var statusEl = document.getElementById('status');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      statusEl.textContent = 'Enrolling…';
      statusEl.className = '';
      var code = document.getElementById('code').value.trim();
      var deviceName = document.getElementById('device_name').value.trim();
      fetch('/auth/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code: code, device_name: deviceName }),
      })
        .then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return {}; }).then(function (body) {
              throw new Error(body.error || 'enrollment_failed');
            });
          }
          return fetch('/me', { credentials: 'same-origin' });
        })
        .then(function (meRes) {
          if (!meRes.ok) throw new Error('session_verification_failed');
          statusEl.textContent = 'Device enrolled. Session verified — you can close this page.';
          statusEl.className = 'success';
          form.reset();
        })
        .catch(function (err) {
          statusEl.textContent = 'Enrollment failed: ' + err.message;
          statusEl.className = 'error';
        });
    });
  </script>
</body>
</html>`;

function enrollPage(): Response {
  return new Response(ENROLL_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const DASHBOARD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ApplyGo</title>
<style>
  :root {
    color-scheme: light dark;
    --accent: #4f46e5;
    --accent-soft: rgba(79, 70, 229, 0.1);
    --accent-contrast: #ffffff;
    --bg: #f4f4f7;
    --surface: #ffffff;
    --surface-2: #fafafb;
    --border: #e4e4ea;
    --border-strong: #d3d3dc;
    --text: #17171c;
    --text-muted: #6b6b78;
    --success: #15734a;
    --success-soft: rgba(21, 115, 74, 0.1);
    --warning: #92610a;
    --warning-soft: rgba(146, 97, 10, 0.1);
    --error: #b3261e;
    --error-soft: rgba(179, 38, 30, 0.1);
    --radius: 0.8rem;
    --radius-sm: 0.5rem;
    --shadow: 0 1px 2px rgba(16, 16, 24, 0.04), 0 1px 3px rgba(16, 16, 24, 0.03);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d0d10;
      --surface: #17171b;
      --surface-2: #1e1e24;
      --border: #2a2a32;
      --border-strong: #3a3a44;
      --text: #f0f0f3;
      --text-muted: #9a9aa6;
      --accent: #8b93f8;
      --accent-soft: rgba(139, 147, 248, 0.14);
      --accent-contrast: #0d0d10;
      --success: #4ade9b;
      --success-soft: rgba(74, 222, 155, 0.13);
      --warning: #e0b155;
      --warning-soft: rgba(224, 177, 85, 0.13);
      --error: #f2837c;
      --error-soft: rgba(242, 131, 124, 0.13);
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding-bottom: 3rem;
    line-height: 1.5;
  }
  .shell { max-width: 72rem; margin: 0 auto; padding: 0 1.1rem; }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1.1rem 0 0.9rem; gap: 0.75rem;
  }
  .brand { display: flex; align-items: center; gap: 0.5rem; font-weight: 700; font-size: 1.15rem; letter-spacing: -0.01em; }
  .brand svg { flex: none; }
  .brand .go { color: var(--accent); }
  nav {
    display: flex; gap: 0.2rem; overflow-x: auto; padding: 0.25rem; margin-bottom: 1.1rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 999px;
    -webkit-overflow-scrolling: touch; scrollbar-width: none;
  }
  nav::-webkit-scrollbar { display: none; }
  nav button {
    flex: none; margin: 0; padding: 0.45rem 0.95rem; font-size: 0.875rem; font-weight: 600;
    background: none; border: none; border-radius: 999px; color: var(--text-muted); cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }
  nav button:hover { color: var(--text); }
  nav button.active { background: var(--accent); color: var(--accent-contrast); }
  .panel { display: none; }
  .panel.active { display: block; }
  section {
    margin: 0 0 1.1rem; padding: 1.15rem 1.25rem; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
  }
  h2 { font-size: 1.0rem; font-weight: 650; margin: 0 0 0.7rem; letter-spacing: -0.01em; }
  h3 { font-size: 0.92rem; font-weight: 650; margin: 1.4rem 0 0.5rem; }
  p.hint { color: var(--text-muted); font-size: 0.85rem; line-height: 1.45; margin: -0.35rem 0 0.85rem; }
  label { display: block; margin: 0.7rem 0 0.3rem; font-weight: 600; font-size: 0.82rem; color: var(--text-muted); }
  input, textarea, select {
    width: 100%; padding: 0.55rem 0.7rem; font-size: 0.95rem; box-sizing: border-box; font-family: inherit;
    background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm);
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  input:focus, textarea:focus, select:focus {
    outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
  }
  textarea { min-height: 5.5rem; resize: vertical; line-height: 1.5; }
  button {
    margin-top: 0.85rem; padding: 0.55rem 1rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
    background: var(--accent); color: var(--accent-contrast); border: 1px solid transparent;
    border-radius: var(--radius-sm); transition: opacity 0.12s ease, background 0.12s ease;
  }
  button:hover:not(:disabled) { opacity: 0.9; }
  button:disabled { opacity: 0.55; cursor: default; }
  button.secondary { background: var(--surface); border-color: var(--border-strong); color: var(--text); }
  button.secondary:hover:not(:disabled) { background: var(--surface-2); opacity: 1; }
  /* Compact actions that sit inside a list row rather than ending a form. */
  .row-actions { display: flex; flex: none; gap: 0.35rem; align-items: center; }
  .row-actions button {
    margin-top: 0; padding: 0.3rem 0.6rem; font-size: 0.8rem; font-weight: 600; white-space: nowrap;
    background: var(--surface); border: 1px solid var(--border); color: var(--text-muted);
  }
  .row-actions button:hover:not(:disabled) { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); }
  .row-actions button.danger:hover:not(:disabled) { color: var(--error); border-color: var(--error); }
  /* Control clusters: small inputs sized to their content instead of stretching full width. */
  .controls { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: flex-end; margin-bottom: 0.4rem; }
  .controls > div { display: flex; flex-direction: column; }
  .controls label { margin-top: 0; }
  .controls select, .controls input { width: auto; min-width: 9rem; }
  .controls button { margin-top: 0; }
  details.disclosure {
    margin-top: 1.1rem; border-top: 1px solid var(--border); padding-top: 0.9rem;
  }
  details.disclosure > summary {
    cursor: pointer; font-size: 0.85rem; font-weight: 600; color: var(--text-muted);
    list-style: none; display: flex; align-items: center; gap: 0.4rem;
  }
  details.disclosure > summary::-webkit-details-marker { display: none; }
  details.disclosure > summary::before { content: "+"; font-size: 1rem; line-height: 1; }
  details.disclosure[open] > summary::before { content: "\\2013"; }
  details.disclosure > summary:hover { color: var(--text); }
  #sign-out { margin-top: 0; padding: 0.35rem 0.8rem; font-size: 0.82rem; }
  .status { margin-top: 0.6rem; font-weight: 600; font-size: 0.9rem; min-height: 1.1rem; }
  .status.success { color: var(--success); }
  .status.error { color: var(--error); }
  .row-item { padding: 0.7rem 0; border-top: 1px solid var(--border); }
  .row-item:first-child { border-top: none; padding-top: 0.15rem; }
  .row-item:last-child { padding-bottom: 0.15rem; }
  .row-title { font-weight: 600; font-size: 0.95rem; }
  a.row-title { color: inherit; text-decoration: none; }
  a.row-title:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 0.15em; }
  .row-meta { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.1rem; }
  /* min-width:0 lets the text column shrink; without it a long unbreakable URL
     forces the whole grid wider than the viewport on phones. */
  .row { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
  .row > div:first-child { min-width: 0; flex: 1; overflow-wrap: anywhere; }
  /* On a phone there isn't room for text and a button cluster side by side -- squeezing the
     text into ~150px makes rows several times taller than stacking the actions underneath. */
  @media (max-width: 599px) {
    .row { flex-direction: column; align-items: stretch; gap: 0.5rem; }
    .row-actions { justify-content: flex-start; flex-wrap: wrap; }
  }
  .empty { color: var(--text-muted); font-size: 0.88rem; margin: 0.35rem 0; }
  .template-choices { display: grid; gap: 0.5rem; margin-bottom: 0.9rem; }
  @media (min-width: 560px) { .template-choices { grid-template-columns: repeat(3, 1fr); } }
  .template-card {
    text-align: left; padding: 0.65rem 0.7rem; border: 1px solid var(--border);
    border-radius: 0.55rem; background: transparent; color: inherit; cursor: pointer;
  }
  .template-card[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .template-card strong { display: block; font-size: 0.95rem; margin-bottom: 0.15rem; }
  .template-card span { font-size: 0.8rem; color: var(--text-muted); line-height: 1.35; }
  .checks { list-style: none; padding: 0; margin: 0.75rem 0 0; display: grid; gap: 0.35rem; }
  .checks li { font-size: 0.85rem; display: flex; gap: 0.5rem; align-items: baseline; }
  .checks .mark { font-weight: 700; }
  .checks .error .mark { color: var(--error); }
  .checks .warning .mark { color: #b8860b; }
  .checks .ok .mark { color: var(--success); }
  .critique {
    font-size: 0.9rem; border-left: 3px solid var(--accent); padding: 0.5rem 0.75rem;
    background: var(--surface-2, rgba(127,127,127,0.08)); border-radius: 0 0.4rem 0.4rem 0;
  }
  .summary-line {
    font-size: 0.85rem; color: var(--text-muted); margin: 0 0 1rem; padding: 0.6rem 0.75rem;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    line-height: 1.5;
  }
  .summary-line strong { font-size: 1.25rem; color: var(--text); margin-right: 0.15rem; }
  .badge {
    display: inline-block; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.03em;
    text-transform: uppercase; padding: 0.15rem 0.45rem; border-radius: 999px;
    border: 1px solid transparent; background: var(--surface-2); color: var(--text-muted); white-space: nowrap;
  }
  /* Green = already judged and worth your attention (strong/possible). Yellow = not filtered
     yet -- don't waste time on it until it's been screened. Red = ruled out. */
  .badge.jobs, .badge.strong, .badge.possible { background: var(--success-soft); color: var(--success); }
  .badge.warn { background: var(--error-soft); color: var(--error); }
  .badge.queued { background: var(--warning-soft); color: var(--warning); }
  .row-title-line { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
  .company-bio { font-size: 0.85rem; margin: 0.35rem 0 0; line-height: 1.5; }
  .company-why { font-size: 0.82rem; color: var(--text-muted); margin: 0.3rem 0 0; padding-left: 0.55rem; border-left: 2px solid var(--border-strong); }
  .location-list { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .location-chip {
    font-size: 0.8rem; padding: 0.2rem 0.5rem; border: 1px solid var(--border);
    border-radius: 999px; background: transparent; color: inherit; cursor: pointer;
  }
  .checkbox-label {
    display: flex; align-items: center; gap: 0.45rem; font-size: 0.85rem; color: var(--text-muted);
    margin: 0.6rem 0 0.2rem; cursor: pointer; font-weight: 500;
  }
  .checkbox-label:hover { color: var(--text); }
  .checkbox-label input { width: auto; margin: 0; accent-color: var(--accent); }
  .job-reason { font-size: 0.85rem; margin: 0.35rem 0 0; line-height: 1.5; }
  .job-missing {
    font-size: 0.8rem; color: var(--text-muted); margin: 0.3rem 0 0;
    padding-left: 0.55rem; border-left: 2px solid var(--border-strong);
  }
  .row-item.is-muted .row-title, .row-item.is-muted .job-reason { opacity: 0.62; }
  .split { display: grid; grid-template-columns: 1fr; gap: 1.1rem; align-items: start; }
  /* Grid items default to min-width:auto, which refuses to shrink below their widest
     unbreakable content. Long pasted URLs then push the whole page wider than the phone
     viewport, so every grid child is explicitly allowed to shrink. */
  .split > * { min-width: 0; }
  @media (min-width: 860px) {
    .split { grid-template-columns: minmax(0, 22rem) minmax(0, 1fr); }
    .split-sticky { position: sticky; top: 1rem; }
  }
  .collapsible-text { cursor: pointer; overflow-wrap: anywhere; }
  .collapsible-text:hover { color: var(--accent); }
  h3.subhead { font-size: 0.85rem; margin: 1.1rem 0 0.4rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .skills-list { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.3rem; }
  .skill-pill { background: var(--bg); border: 1px solid var(--border); border-radius: 999px; padding: 0.2rem 0.65rem; font-size: 0.85rem; }
  hr.divider { border: none; border-top: 1px solid var(--border); margin: 1.25rem 0; }
</style>
</head>
<body>
  <div class="shell">
  <header>
    <div class="brand">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <rect width="28" height="28" rx="8" fill="var(--accent)"/>
        <path d="M8 15L13 20L21 9" stroke="var(--accent-contrast)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Apply<span class="go">Go</span></span>
    </div>
    <button id="sign-out" class="secondary" type="button">Sign out</button>
  </header>

  <nav>
    <button class="tab active" data-tab="roles" type="button">Desired Roles</button>
    <button class="tab" data-tab="profile" type="button">Profile</button>
    <button class="tab" data-tab="resume" type="button">Resume</button>
    <button class="tab" data-tab="companies" type="button">Companies</button>
    <button class="tab" data-tab="jobs" type="button">Jobs</button>
    <button class="tab" data-tab="devices" type="button">Devices</button>
    <button class="tab" data-tab="data" type="button">Data</button>
  </nav>

  <div id="panel-roles" class="panel active">
    <div class="split">
      <div>
        <section id="role-signals-section">
          <h2>What are you looking for?</h2>
          <p class="hint">Paste job links, or write loosely about what you want next. The more you add, the better the generated description.</p>
          <div id="role-signals-list"><p class="empty">Loading…</p></div>
          <form id="role-signal-form">
            <label for="role-signal-text">Add a note or link</label>
            <textarea id="role-signal-text" required placeholder="e.g. a link to a posting, or 'I want senior IC roles in applied AI, remote-friendly, not pure infra'"></textarea>
            <button type="submit">Add</button>
          </form>
          <p id="role-signal-status" class="status" role="status" aria-live="polite"></p>
        </section>
      </div>
      <div class="split-sticky">
        <section id="desired-roles-section">
          <h2>Generated description</h2>
          <label for="desired-roles-provider">Generate using</label>
          <select id="desired-roles-provider">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
          <button id="desired-roles-generate-button" class="secondary" type="button">Generate description</button>
          <p id="desired-roles-generate-status" class="status" role="status" aria-live="polite"></p>
          <div id="desired-roles-draft-block" style="display:none">
            <label for="desired-roles-draft">Draft (review, then use or discard)</label>
            <textarea id="desired-roles-draft" readonly style="min-height:8rem"></textarea>
            <button id="desired-roles-use-draft" type="button">Use this draft</button>
          </div>
          <label for="desired-roles-description">Saved description</label>
          <textarea id="desired-roles-description" style="min-height:8rem" placeholder="What roles are you targeting?"></textarea>
          <label for="desired-locations">Locations you'll work in</label>
          <input id="desired-locations" placeholder="e.g. California, or Bay Area, Seattle, Remote">
          <p class="hint">Enforced as a hard filter: company discovery won't add employers outside these, and board scans skip postings elsewhere. Leave blank for no location limit.</p>
          <button id="desired-roles-save-button" type="button">Save</button>
          <p id="desired-roles-save-status" class="status" role="status" aria-live="polite"></p>
        </section>
      </div>
    </div>
  </div>

  <div id="panel-profile" class="panel">
    <div class="split">
      <div>
        <section id="material-section">
          <h2>Your material</h2>
          <p class="hint">Upload files or add notes — this feeds the structured profile on the right.</p>
          <label for="profile-label">Name</label>
          <input id="profile-label" required placeholder="e.g. Jason Sheinkopf">
          <button id="save-name-button" class="secondary" type="button">Save name</button>
          <p id="profile-status" class="status" role="status" aria-live="polite"></p>

          <hr class="divider">

          <h3 class="subhead">Documents</h3>
          <div id="documents-list"><p class="empty">Loading…</p></div>
          <form id="document-form">
            <label for="document-file">Upload resume or notes file (PDF, plain text, or Markdown)</label>
            <input id="document-file" type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" required>
            <button type="submit">Upload</button>
          </form>
          <p id="document-status" class="status" role="status" aria-live="polite"></p>

          <hr class="divider">

          <h3 class="subhead">Notes about yourself</h3>
          <div id="notes-list"><p class="empty">Loading…</p></div>
          <form id="note-form">
            <label for="note-text">Add unstructured text (accomplishments, goals, background — anything)</label>
            <textarea id="note-text" required placeholder="Write freely; this feeds the profile generator"></textarea>
            <button type="submit">Add note</button>
          </form>
          <p id="note-status" class="status" role="status" aria-live="polite"></p>
        </section>
      </div>
      <div class="split-sticky">
        <section id="structured-profile-section">
          <h2>Your structured profile</h2>
          <label for="generate-provider">Generate from documents &amp; notes using</label>
          <select id="generate-provider">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
          <button id="generate-button" type="button">Generate structured profile</button>
          <p id="generate-status" class="status" role="status" aria-live="polite"></p>
          <div id="structured-draft-block" style="display:none">
            <h3 class="subhead">Draft — review, then save or discard</h3>
            <div id="structured-draft-view"></div>
            <button id="use-structured-draft" type="button">Save this</button>
            <button id="discard-structured-draft" class="secondary" type="button">Discard</button>
          </div>
          <div id="structured-profile-view"><p class="empty">No structured profile yet — add material on the left and generate.</p></div>
        </section>
      </div>
    </div>
  </div>

  <div id="panel-resume" class="panel">
    <div class="split">
      <div class="split-sticky">
        <section id="resume-reference-section">
          <h2>Your profile</h2>
          <p class="hint">Read-only — edit this on the Profile tab. Every resume version is built from it.</p>
          <div id="resume-profile-view"><p class="empty">No structured profile yet — build one on the Profile tab first.</p></div>
        </section>
      </div>
      <div>
        <section id="resume-generate-section">
          <h2>Resume versions</h2>
          <label for="resume-template">Template</label>
          <div id="resume-template-choices" class="template-choices"></div>
          <label for="resume-instructions">Instructions for this version (optional)</label>
          <textarea id="resume-instructions" placeholder="e.g. keep it to one page, emphasize leadership, target a backend-heavy role"></textarea>
          <label for="resume-pages">Length</label>
          <select id="resume-pages">
            <option value="1">One page</option>
            <option value="2">Up to two pages</option>
          </select>
          <label for="resume-provider">Generate using</label>
          <select id="resume-provider">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
          <button id="resume-generate-button" type="button">Generate new version</button>
          <p id="resume-generate-status" class="status" role="status" aria-live="polite"></p>
        </section>

        <section id="resume-list-section">
          <div id="resumes-list"><p class="empty">Loading…</p></div>
        </section>

        <section id="resume-preview-section" style="display:none">
          <h2>Preview</h2>
          <iframe id="resume-preview-frame" style="width:100%; min-height:70vh; border:1px solid var(--border); border-radius:0.5rem;"></iframe>

          <div id="resume-checks"></div>

          <h3>Design review</h3>
          <p class="hint">A vision model looks at the rendered page the way a designer would, then adjusts the layout — and rewrites the wording from your verified profile if that's the real problem. Add a comment to steer it, or leave it blank and just hit revise.</p>
          <p id="resume-critique" class="critique" style="display:none"></p>
          <textarea id="resume-review-comment" placeholder="Optional — e.g. too much white space at the bottom, make the skills section smaller"></textarea>
          <button id="resume-review-button" type="button">Revise this version</button>
          <p id="resume-review-status" class="status" role="status" aria-live="polite"></p>
        </section>
      </div>
    </div>
  </div>

  <div id="panel-companies" class="panel">
    <div class="split">
      <div class="split-sticky">
        <section id="companies-controls-section">
          <h2>Target companies</h2>
          <p class="hint">Built from your profile and desired roles. Jobs are read from each company's own board — no aggregators.</p>
          <p id="companies-summary" class="summary-line">Loading…</p>

          <label for="company-focus">Focus this search (optional)</label>
          <input id="company-focus" placeholder="e.g. automotive, robotics, Bay Area startups">
          <div class="controls">
            <div>
              <label for="company-count">How many</label>
              <select id="company-count">
                <option value="10">10</option>
                <option value="15">15</option>
                <option value="20">20</option>
              </select>
            </div>
            <div>
              <label for="company-provider">Search using</label>
              <select id="company-provider">
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>
          </div>
          <button id="companies-discover-button" type="button">Find more companies</button>
          <p id="companies-discover-status" class="status" role="status" aria-live="polite"></p>
          <p class="hint">Once companies are on your list, scan their boards for openings from the Jobs tab.</p>

          <h3>Where they are</h3>
          <div id="companies-locations"><p class="empty">No companies yet.</p></div>

          <details class="disclosure">
            <summary>Add a company yourself</summary>
            <form id="company-form">
              <label for="company-name">Name</label>
              <input id="company-name" required placeholder="e.g. Acme Robotics">
              <label for="company-website">Website</label>
              <input id="company-website" type="url" placeholder="https://acme.com">
              <button type="submit">Add company</button>
            </form>
            <p id="company-add-status" class="status" role="status" aria-live="polite"></p>
          </details>
        </section>
      </div>
      <div>
        <section id="companies-list-section">
          <label for="companies-filter">Filter</label>
          <input id="companies-filter" placeholder="Search by name, location, or description">
          <div id="companies-list"><p class="empty">Loading…</p></div>
        </section>
      </div>
    </div>
  </div>

  <div id="panel-jobs" class="panel">
    <section id="jobs-scan-section">
      <h2>1. Scan for new listings</h2>
      <p class="hint">Reads the job boards of every company on your list. Runs in batches, so click again if there are more companies left to scan.</p>
      <p id="jobs-scan-summary" class="summary-line">Loading…</p>
      <button id="jobs-scan-button" type="button">Scan company boards</button>
      <p id="jobs-scan-status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section id="jobs-filter-section">
      <h2>2. Filter for your best matches</h2>
      <p class="hint">Screens new listings against your profile in two passes — a quick check, then a closer look at anything that survives it — so you only spend real attention on postings worth reading.</p>
      <p id="jobs-pipeline" class="summary-line">Loading…</p>
      <div class="controls">
        <div>
          <label for="jobs-provider">Filter using</label>
          <select id="jobs-provider">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <button id="jobs-assess-button" type="button">Find my matches</button>
      </div>
      <p id="jobs-assess-status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section id="jobs-section">
      <h2>Job postings</h2>
      <label for="jobs-filter">Filter</label>
      <input id="jobs-filter" placeholder="Search by title, company, or location">
      <label class="checkbox-label">
        <input id="jobs-show-unfiltered" type="checkbox"><span id="jobs-unfiltered-count">Show postings not filtered yet</span>
      </label>
      <label class="checkbox-label">
        <input id="jobs-show-rejected" type="checkbox"><span id="jobs-rejected-count">Show postings marked not a fit</span>
      </label>
      <div id="jobs-list"><p class="empty">Loading…</p></div>
      <details class="disclosure">
        <summary>Add a posting by hand</summary>
        <form id="job-form">
          <label for="job-title">Title</label>
          <input id="job-title" required placeholder="e.g. Senior Engineer">
          <label for="job-company">Company</label>
          <input id="job-company" required placeholder="e.g. Acme Corp">
          <label for="job-url">Posting URL (optional)</label>
          <input id="job-url" type="url" placeholder="https://...">
          <label for="job-description">Description</label>
          <textarea id="job-description" required placeholder="Paste the job description"></textarea>
          <button type="submit">Add job</button>
        </form>
        <p id="job-status" class="status" role="status" aria-live="polite"></p>
      </details>
    </section>
  </div>

  <div id="panel-devices" class="panel">
    <section id="devices-section">
      <h2>Devices</h2>
      <div id="devices-list"><p class="empty">Loading…</p></div>
    </section>
  </div>

  <div id="panel-data" class="panel">
    <section id="data-stored-section">
      <h2>What's stored</h2>
      <p class="hint">Everything ApplyGo keeps about you and your search, and how much space the bulky parts take.</p>
      <div id="data-counts"><p class="empty">Loading…</p></div>
    </section>

    <section id="data-pipeline-section">
      <h2>Pipeline</h2>
      <p class="hint">Each stage feeds the next. Resetting one also clears everything downstream of it, because those results were derived from what you're removing.</p>
      <div id="data-stages"><p class="empty">Loading…</p></div>
    </section>

    <section id="data-collections-section">
      <h2>Other collections</h2>
      <p class="hint">Standalone data that isn't part of the job pipeline.</p>
      <div id="data-collections"></div>
      <p id="data-status" class="status" role="status" aria-live="polite"></p>
    </section>
  </div>
  </div>

  <script>
    document.querySelectorAll('nav .tab').forEach(function (tabButton) {
      tabButton.addEventListener('click', function () {
        document.querySelectorAll('nav .tab').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
        tabButton.classList.add('active');
        document.getElementById('panel-' + tabButton.dataset.tab).classList.add('active');
      });
    });

    function el(tag, props, children) {
      var node = document.createElement(tag);
      Object.keys(props || {}).forEach(function (key) { node[key] = props[key]; });
      (children || []).forEach(function (child) { node.appendChild(child); });
      return node;
    }
    function text(value) { return document.createTextNode(value); }

    function goToEnroll() { window.location.href = '/enroll'; }

    async function api(path, options) {
      var res = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
      if (res.status === 401) { goToEnroll(); throw new Error('not_authenticated'); }
      return res;
    }

    function errorMessage(data, fallback) {
      var msg = (data && data.error) || fallback;
      if (data && data.detail) msg += ': ' + data.detail;
      return msg;
    }

    document.getElementById('sign-out').addEventListener('click', async function () {
      await api('/auth/logout', { method: 'POST' });
      goToEnroll();
    });

    async function loadProfile() {
      var res = await api('/profile');
      var data = await res.json();
      if (data.profile) {
        document.getElementById('profile-label').value = data.profile.label || '';
        document.getElementById('desired-roles-description').value = data.profile.desired_roles || '';
        document.getElementById('desired-locations').value = data.profile.desired_locations || '';
        renderStructuredProfileView('structured-profile-view', data.profile.structured);
        renderStructuredProfileView('resume-profile-view', data.profile.structured);
      }
    }

    var activeResumeId = null;
    var selectedTemplate = 'classic';

    function renderTemplateChoices(templates) {
      var host = document.getElementById('resume-template-choices');
      host.innerHTML = '';
      templates.forEach(function (tpl) {
        var card = el('button', { className: 'template-card', type: 'button' }, [
          el('strong', { textContent: tpl.name }),
          el('span', { textContent: tpl.blurb }),
        ]);
        card.setAttribute('aria-pressed', String(tpl.id === selectedTemplate));
        card.addEventListener('click', function () {
          selectedTemplate = tpl.id;
          Array.prototype.forEach.call(host.children, function (child) {
            child.setAttribute('aria-pressed', String(child === card));
          });
        });
        host.appendChild(card);
      });
    }

    function renderChecks(checks) {
      var host = document.getElementById('resume-checks');
      host.innerHTML = '';
      if (!checks || !checks.length) return;
      var list = el('ul', { className: 'checks' });
      checks.forEach(function (check) {
        var mark = check.severity === 'ok' ? '✓' : check.severity === 'warning' ? '!' : '✕';
        list.appendChild(el('li', { className: check.severity }, [
          el('span', { className: 'mark', textContent: mark }),
          el('span', { textContent: check.message }),
        ]));
      });
      host.appendChild(list);
    }

    // Cache-bust so a revised PDF at the same URL actually reloads in the iframe.
    function showResumePreview(id, checks, critique) {
      activeResumeId = id;
      var section = document.getElementById('resume-preview-section');
      section.style.display = 'block';
      document.getElementById('resume-preview-frame').src =
        '/resumes/' + encodeURIComponent(id) + '/file?v=' + Date.now();
      renderChecks(checks);
      var critiqueEl = document.getElementById('resume-critique');
      critiqueEl.textContent = critique || '';
      critiqueEl.style.display = critique ? 'block' : 'none';
      section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function loadResumes() {
      var res = await api('/resumes');
      var data = await res.json();
      if (data.templates) renderTemplateChoices(data.templates);
      var list = document.getElementById('resumes-list');
      list.innerHTML = '';
      if (!data.resumes.length) {
        list.appendChild(el('p', { className: 'empty', textContent: 'No resume versions yet — generate one above.' }));
        return;
      }
      data.resumes.forEach(function (resume) {
        var preview = el('a', {
          className: 'row-title',
          href: '/resumes/' + encodeURIComponent(resume.id) + '/file',
          target: '_blank',
          rel: 'noopener',
          textContent: resume.name,
        });
        var previewInline = el('button', { type: 'button', textContent: 'Preview' });
        previewInline.addEventListener('click', function () {
          var checks = [];
          try { checks = JSON.parse(resume.checks_json || '[]'); } catch (e) { checks = []; }
          showResumePreview(resume.id, checks, resume.critique);
        });
        var rename = el('button', { type: 'button', textContent: 'Rename' });
        rename.addEventListener('click', async function () {
          var name = window.prompt('New name for this resume version:', resume.name);
          if (!name) return;
          await api('/resumes/' + encodeURIComponent(resume.id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name }),
          });
          loadResumes();
        });
        var del = el('button', { className: 'danger', type: 'button', textContent: 'Remove' });
        del.addEventListener('click', async function () {
          await api('/resumes/' + encodeURIComponent(resume.id), { method: 'DELETE' });
          loadResumes();
        });
        var meta = [
          resume.template || 'classic',
          'rev ' + (resume.revision || 1),
          new Date(resume.created_at).toLocaleString(),
        ].join(' · ');
        var row = el('div', { className: 'row' }, [
          el('div', {}, [preview, el('div', { className: 'row-meta', textContent: meta })]),
          el('div', { className: 'row-actions' }, [previewInline, rename, del]),
        ]);
        list.appendChild(el('div', { className: 'row-item' }, [row]));
      });
    }

    document.getElementById('resume-generate-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('resume-generate-status');
      statusEl.textContent = 'Generating and rendering a PDF… this can take a little while.';
      statusEl.className = 'status';
      try {
        var res = await api('/resumes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            instructions: document.getElementById('resume-instructions').value,
            provider: document.getElementById('resume-provider').value,
            template: selectedTemplate,
            max_pages: Number(document.getElementById('resume-pages').value),
          }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'generation_failed'));
        statusEl.textContent = 'Created "' + data.name + '".';
        statusEl.className = 'status success';
        document.getElementById('resume-instructions').value = '';
        await loadResumes();
        showResumePreview(data.id, data.checks, '');
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('resume-review-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('resume-review-status');
      if (!activeResumeId) {
        statusEl.textContent = 'Preview a resume version first.';
        statusEl.className = 'status error';
        return;
      }
      statusEl.textContent = 'Reviewing the rendered page and revising… this takes a bit longer than generating.';
      statusEl.className = 'status';
      try {
        var res = await api('/resumes/' + encodeURIComponent(activeResumeId) + '/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            comment: document.getElementById('resume-review-comment').value,
            provider: document.getElementById('resume-provider').value,
          }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'review_failed'));
        document.getElementById('resume-review-comment').value = '';
        await loadResumes();
        showResumePreview(data.id, data.checks, data.critique);
        statusEl.textContent =
          'Revision ' + data.revision + ' ready — ' +
          (data.content_revised ? 'wording and layout updated.' : 'layout updated.');
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    // Renders a list where each item shows one line, click to expand/collapse the full text.
    function renderCollapsibleList(listId, items, emptyText, getText, onDelete) {
      var list = document.getElementById(listId);
      list.innerHTML = '';
      if (!items || !items.length) {
        list.appendChild(el('p', { className: 'empty', textContent: emptyText }));
        return;
      }
      items.forEach(function (item) {
        // One row missing its text must not take the whole list down with it.
        var full = String(getText(item) == null ? '' : getText(item));
        var oneLine = full.length > 72 ? full.slice(0, 72) + '…' : full;
        var expanded = false;
        var textEl = el('div', { className: 'collapsible-text', textContent: oneLine });
        textEl.addEventListener('click', function () {
          expanded = !expanded;
          textEl.textContent = expanded ? full : oneLine;
        });
        var del = el('button', { className: 'danger', type: 'button', textContent: 'Remove' });
        del.addEventListener('click', async function (event) {
          event.stopPropagation();
          await onDelete(item);
        });
        var row = el('div', { className: 'row' }, [el('div', {}, [textEl]), el('div', { className: 'row-actions' }, [del])]);
        list.appendChild(el('div', { className: 'row-item' }, [row]));
      });
    }

    function renderStructuredProfileView(containerId, structured) {
      var container = document.getElementById(containerId);
      container.innerHTML = '';
      var hasContent = structured && (
        structured.headline || structured.narrative_summary ||
        (structured.education && structured.education.length) ||
        (structured.experience && structured.experience.length) ||
        (structured.skills && structured.skills.length)
      );
      if (!hasContent) {
        container.appendChild(el('p', { className: 'empty', textContent: 'No structured profile yet — add material on the left and generate.' }));
        return;
      }
      if (structured.headline) container.appendChild(el('div', { className: 'row-title', textContent: structured.headline }));
      if (structured.narrative_summary) container.appendChild(el('p', { textContent: structured.narrative_summary }));
      if (structured.education && structured.education.length) {
        container.appendChild(el('h3', { className: 'subhead', textContent: 'Education' }));
        structured.education.forEach(function (item) {
          var line = [item.degree, item.field].filter(Boolean).join(' in ');
          var years = [item.start_year, item.end_year].filter(Boolean).join('–');
          container.appendChild(el('div', { className: 'row-item', textContent: [line, item.school, years].filter(Boolean).join(' · ') }));
        });
      }
      if (structured.experience && structured.experience.length) {
        container.appendChild(el('h3', { className: 'subhead', textContent: 'Experience' }));
        structured.experience.forEach(function (item) {
          var years = [item.start, item.end].filter(Boolean).join('–');
          var block = el('div', { className: 'row-item' }, [
            el('div', { className: 'row-title', textContent: [item.title, item.company].filter(Boolean).join(' — ') + (years ? ' (' + years + ')' : '') }),
          ]);
          (item.highlights || []).forEach(function (h) {
            block.appendChild(el('div', { className: 'row-meta', textContent: '• ' + h }));
          });
          container.appendChild(block);
        });
      }
      if (structured.skills && structured.skills.length) {
        container.appendChild(el('h3', { className: 'subhead', textContent: 'Skills' }));
        var pills = el('div', { className: 'skills-list' });
        structured.skills.forEach(function (skill) {
          pills.appendChild(el('span', { className: 'skill-pill', textContent: skill }));
        });
        container.appendChild(pills);
      }
    }

    async function loadRoleSignals() {
      var res = await api('/role-signals');
      var data = await res.json();
      renderCollapsibleList('role-signals-list', data.role_signals, 'Nothing added yet.', function (s) { return s.claim; }, async function (s) {
        await api('/role-signals/' + encodeURIComponent(s.id), { method: 'DELETE' });
        loadRoleSignals();
      });
    }

    document.getElementById('role-signal-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('role-signal-status');
      statusEl.textContent = 'Adding…';
      statusEl.className = 'status';
      try {
        var res = await api('/role-signals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: document.getElementById('role-signal-text').value }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'add_failed'));
        statusEl.textContent = 'Added.';
        statusEl.className = 'status success';
        document.getElementById('role-signal-form').reset();
        loadRoleSignals();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('desired-roles-generate-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('desired-roles-generate-status');
      var draftBlock = document.getElementById('desired-roles-draft-block');
      statusEl.textContent = 'Generating…';
      statusEl.className = 'status';
      draftBlock.style.display = 'none';
      try {
        var res = await api('/desired-roles/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: document.getElementById('desired-roles-provider').value }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'generation_failed'));
        document.getElementById('desired-roles-draft').value = data.draft_description;
        draftBlock.style.display = 'block';
        statusEl.textContent = 'Draft ready below. Review before using it.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('desired-roles-use-draft').addEventListener('click', function () {
      document.getElementById('desired-roles-description').value = document.getElementById('desired-roles-draft').value;
      document.getElementById('desired-roles-draft-block').style.display = 'none';
      document.getElementById('desired-roles-generate-status').textContent = 'Draft copied below — click Save to keep it.';
    });

    document.getElementById('desired-roles-save-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('desired-roles-save-status');
      statusEl.textContent = 'Saving…';
      statusEl.className = 'status';
      try {
        var res = await api('/desired-roles', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            desired_roles: document.getElementById('desired-roles-description').value,
            desired_locations: document.getElementById('desired-locations').value,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'save_failed');
        statusEl.textContent = 'Saved.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('save-name-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('profile-status');
      statusEl.textContent = 'Saving…';
      statusEl.className = 'status';
      try {
        var res = await api('/profile', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: document.getElementById('profile-label').value }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'save_failed');
        statusEl.textContent = 'Saved.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    var latestStructuredDraft = null;

    document.getElementById('generate-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('generate-status');
      var draftBlock = document.getElementById('structured-draft-block');
      statusEl.textContent = 'Generating… this can take a little while.';
      statusEl.className = 'status';
      draftBlock.style.display = 'none';
      try {
        var res = await api('/profile/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: document.getElementById('generate-provider').value }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'generation_failed'));
        latestStructuredDraft = data.draft_structured;
        renderStructuredProfileView('structured-draft-view', latestStructuredDraft);
        draftBlock.style.display = 'block';
        statusEl.textContent = 'Draft ready below. Review before saving it.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('use-structured-draft').addEventListener('click', async function () {
      var statusEl = document.getElementById('generate-status');
      if (!latestStructuredDraft) return;
      try {
        var res = await api('/profile/structured', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ structured: latestStructuredDraft }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'save_failed');
        document.getElementById('structured-draft-block').style.display = 'none';
        renderStructuredProfileView('structured-profile-view', latestStructuredDraft);
        statusEl.textContent = 'Saved.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('discard-structured-draft').addEventListener('click', function () {
      latestStructuredDraft = null;
      document.getElementById('structured-draft-block').style.display = 'none';
      document.getElementById('generate-status').textContent = 'Discarded.';
    });

    function renderDocuments(docs) {
      var list = document.getElementById('documents-list');
      list.innerHTML = '';
      if (!docs.length) {
        list.appendChild(el('p', { className: 'empty', textContent: 'No documents yet.' }));
        return;
      }
      docs.forEach(function (doc) {
        var rename = el('button', { type: 'button', textContent: 'Rename' });
        rename.addEventListener('click', async function () {
          var name = window.prompt('New name for this document:', doc.original_name);
          if (!name) return;
          await api('/documents/' + encodeURIComponent(doc.id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ original_name: name }),
          });
          loadDocuments();
        });
        var del = el('button', { className: 'danger', type: 'button', textContent: 'Remove' });
        del.addEventListener('click', async function () {
          await api('/documents/' + encodeURIComponent(doc.id), { method: 'DELETE' });
          loadDocuments();
        });
        var meta = doc.media_type + (doc.has_text ? '' : ' — text not extracted, paste content as a note instead');
        var preview = el('a', {
          className: 'row-title',
          href: '/documents/' + encodeURIComponent(doc.id) + '/file',
          target: '_blank',
          rel: 'noopener',
          textContent: doc.original_name,
        });
        preview.style.display = 'block';
        var row = el('div', { className: 'row' }, [
          el('div', {}, [
            preview,
            el('div', { className: 'row-meta', textContent: meta }),
          ]),
          el('div', { className: 'row-actions' }, [rename, del]),
        ]);
        list.appendChild(el('div', { className: 'row-item' }, [row]));
      });
    }

    async function loadDocuments() {
      var res = await api('/documents');
      var data = await res.json();
      renderDocuments(data.documents);
    }

    document.getElementById('document-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('document-status');
      var fileInput = document.getElementById('document-file');
      if (!fileInput.files.length) return;
      statusEl.textContent = 'Uploading…';
      statusEl.className = 'status';
      try {
        var formData = new FormData();
        formData.append('file', fileInput.files[0]);
        var res = await api('/documents', { method: 'POST', body: formData });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'upload_failed'));
        statusEl.textContent = 'Uploaded.';
        statusEl.className = 'status success';
        document.getElementById('document-form').reset();
        loadDocuments();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    async function loadNotes() {
      var res = await api('/notes');
      var data = await res.json();
      renderCollapsibleList('notes-list', data.notes, 'No notes yet.', function (n) { return n.claim; }, async function (n) {
        await api('/notes/' + encodeURIComponent(n.id), { method: 'DELETE' });
        loadNotes();
      });
    }

    document.getElementById('note-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('note-status');
      statusEl.textContent = 'Adding…';
      statusEl.className = 'status';
      try {
        var res = await api('/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: document.getElementById('note-text').value }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'add_failed'));
        statusEl.textContent = 'Added.';
        statusEl.className = 'status success';
        document.getElementById('note-form').reset();
        loadNotes();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    var allCompanies = [];
    var allJobs = [];

    function matchesFilter(haystack, needle) {
      if (!needle) return true;
      return haystack.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
    }

    function renderCompanies() {
      var needle = document.getElementById('companies-filter').value.trim();
      var list = document.getElementById('companies-list');
      list.innerHTML = '';
      var shown = allCompanies.filter(function (c) {
        return matchesFilter([c.name, c.location, c.bio, c.why_fit].join(' '), needle);
      });
      if (!shown.length) {
        list.appendChild(el('p', {
          className: 'empty',
          textContent: allCompanies.length ? 'No companies match that filter.' : 'No companies yet — run a search on the left.',
        }));
        return;
      }
      shown.forEach(function (company) {
        var titleChildren = [];
        if (company.website) {
          titleChildren.push(el('a', {
            className: 'row-title', href: company.website, target: '_blank', rel: 'noopener',
            textContent: company.name,
          }));
        } else {
          titleChildren.push(el('span', { className: 'row-title', textContent: company.name }));
        }
        if (company.open_jobs > 0) {
          titleChildren.push(el('span', { className: 'badge jobs', textContent: company.open_jobs + ' open' }));
        }
        if (company.status === 'unreachable') {
          titleChildren.push(el('span', { className: 'badge warn', textContent: 'site unreachable' }));
        }
        if (company.status === 'dismissed') {
          titleChildren.push(el('span', { className: 'badge', textContent: 'dismissed' }));
        }
        if (company.off_target) {
          titleChildren.push(el('span', { className: 'badge warn', textContent: 'outside your locations' }));
        }

        var meta = [company.location, company.last_scanned_at ? 'scanned ' + new Date(company.last_scanned_at).toLocaleDateString() : 'not scanned yet']
          .filter(Boolean).join(' · ');

        var body = [
          el('div', { className: 'row-title-line' }, titleChildren),
          el('div', { className: 'row-meta', textContent: meta }),
        ];
        if (company.bio) body.push(el('p', { className: 'company-bio', textContent: company.bio }));
        if (company.why_fit) body.push(el('p', { className: 'company-why', textContent: company.why_fit }));
        if (company.scan_note) body.push(el('div', { className: 'row-meta', textContent: company.scan_note }));

        var scanOne = el('button', { type: 'button', textContent: 'Scan' });
        scanOne.addEventListener('click', async function () {
          scanOne.disabled = true;
          scanOne.textContent = 'Scanning…';
          await api('/companies/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ company_id: company.id }),
          });
          await loadCompanies();
          await loadJobs();
        });
        var dismiss = el('button', {
          type: 'button',
          textContent: company.status === 'dismissed' ? 'Restore' : 'Dismiss',
        });
        dismiss.addEventListener('click', async function () {
          await api('/companies/' + encodeURIComponent(company.id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: company.status === 'dismissed' ? 'reachable' : 'dismissed' }),
          });
          loadCompanies();
        });
        var del = el('button', { className: 'danger', type: 'button', textContent: 'Remove' });
        del.addEventListener('click', async function () {
          await api('/companies/' + encodeURIComponent(company.id), { method: 'DELETE' });
          loadCompanies();
        });

        list.appendChild(el('div', { className: 'row-item' + (company.status === 'dismissed' ? ' is-muted' : '') }, [
          el('div', { className: 'row' }, [
            el('div', {}, body),
            el('div', { className: 'row-actions' }, [scanOne, dismiss, del]),
          ]),
        ]));
      });
    }

    function renderCompanyLocations() {
      var host = document.getElementById('companies-locations');
      host.innerHTML = '';
      var counts = {};
      allCompanies.forEach(function (c) {
        var key = (c.location || 'Unknown').trim() || 'Unknown';
        counts[key] = (counts[key] || 0) + 1;
      });
      var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
      if (!keys.length) {
        host.appendChild(el('p', { className: 'empty', textContent: 'No companies yet.' }));
        return;
      }
      var wrap = el('div', { className: 'location-list' });
      keys.forEach(function (key) {
        var chip = el('button', {
          className: 'location-chip', type: 'button', textContent: key + ' (' + counts[key] + ')',
        });
        chip.addEventListener('click', function () {
          document.getElementById('companies-filter').value = key === 'Unknown' ? '' : key;
          renderCompanies();
        });
        wrap.appendChild(chip);
      });
      host.appendChild(wrap);
    }

    async function loadCompanies() {
      var res = await api('/companies');
      var data = await res.json();
      allCompanies = data.companies || [];
      var withJobs = allCompanies.filter(function (c) { return c.open_jobs > 0; }).length;
      document.getElementById('companies-summary').innerHTML = '';
      document.getElementById('companies-summary').appendChild(
        el('span', {}, [
          el('strong', { textContent: String(allCompanies.length) }),
          el('span', { textContent: ' compan' + (allCompanies.length === 1 ? 'y' : 'ies') +
            ' · ' + withJobs + ' with open roles · ' + (data.unscanned || 0) + ' not scanned yet' +
            (data.off_target ? ' · ' + data.off_target + ' outside your locations' : '') +
            (data.desired_locations ? ' · limited to ' + data.desired_locations : ' · no location limit set') }),
        ]),
      );
      renderCompanyLocations();
      renderCompanies();
      renderScanSummary();
    }

    function renderScanSummary() {
      var host = document.getElementById('jobs-scan-summary');
      if (!host) return;
      var scannedAt = allCompanies
        .map(function (c) { return c.last_scanned_at; })
        .filter(Boolean)
        .sort()
        .pop();
      var eligible = allCompanies.filter(function (c) { return c.status !== 'dismissed'; }).length;
      var unscanned = allCompanies.filter(function (c) { return c.status !== 'dismissed' && !c.last_scanned_at; }).length;
      host.innerHTML = '';
      host.appendChild(el('span', {}, [
        el('span', {
          textContent: (scannedAt ? 'Last scanned ' + new Date(scannedAt).toLocaleString() : 'Never scanned yet') +
            ' · ' + eligible + ' compan' + (eligible === 1 ? 'y' : 'ies') + ' on your list' +
            (unscanned ? ' · ' + unscanned + ' not scanned yet' : ''),
        }),
      ]));
    }

    document.getElementById('companies-filter').addEventListener('input', renderCompanies);

    document.getElementById('companies-discover-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('companies-discover-status');
      statusEl.textContent = 'Searching and checking each site resolves… this takes a moment.';
      statusEl.className = 'status';
      try {
        var res = await api('/companies/discover', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: document.getElementById('company-provider').value,
            count: Number(document.getElementById('company-count').value),
            focus: document.getElementById('company-focus').value,
          }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'discovery_failed'));
        var parts = ['Added ' + data.added + ' new.'];
        if (data.duplicates) parts.push(data.duplicates + ' already on your list.');
        if (data.off_target) {
          parts.push(data.off_target + ' rejected as outside ' + (data.locations || 'your locations') + '.');
        }
        if (data.unreachable) parts.push(data.unreachable + " couldn't be reached — flagged for you to check.");
        statusEl.textContent = parts.join(' ');
        statusEl.className = 'status success';
        loadCompanies();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('jobs-scan-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('jobs-scan-status');
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Reading job boards…';
      statusEl.className = 'status';
      try {
        var res = await api('/companies/scan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ limit: 6 }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'scan_failed'));
        statusEl.textContent =
          'Scanned ' + data.scanned + ' compan' + (data.scanned === 1 ? 'y' : 'ies') + ' — found ' +
          data.new_listings + ' new listing' + (data.new_listings === 1 ? '' : 's') + '. ' +
          (data.unscanned ? data.unscanned + ' compan' + (data.unscanned === 1 ? 'y' : 'ies') +
            ' still unscanned, click again to continue.' : 'All companies scanned.');
        statusEl.className = 'status success';
        await loadCompanies();
        await loadJobs();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      } finally {
        button.disabled = false;
      }
    });

    document.getElementById('company-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('company-add-status');
      statusEl.textContent = 'Adding…';
      statusEl.className = 'status';
      try {
        var res = await api('/companies', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: document.getElementById('company-name').value,
            website: document.getElementById('company-website').value,
          }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'add_failed'));
        statusEl.textContent = data.added ? 'Added.' : 'Already on your list.';
        statusEl.className = 'status success';
        document.getElementById('company-form').reset();
        loadCompanies();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    var FIT_LABELS = {
      strong: { text: 'Strong match', cls: 'strong' },
      possible: { text: 'Possible match', cls: 'possible' },
      reject: { text: 'Not a fit', cls: 'warn' },
      screened_out: { text: 'Screened out', cls: 'warn' },
      screened_in: { text: 'Awaiting review', cls: 'queued' },
      unassessed: { text: 'Not filtered yet', cls: 'queued' },
    };
    // Three buckets, kept visually and structurally separate so a fresh scan's unfiltered
    // postings never get mixed in with results you've already reviewed:
    //   judged matches (green)      -- shown by default
    //   not filtered yet (yellow)   -- hidden by default, own toggle
    //   ruled out (red)             -- hidden by default, own toggle
    var QUEUED_STATUSES = { unassessed: true, screened_in: true };
    var RULED_OUT_STATUSES = { reject: true, screened_out: true };

    async function submitJobFit(jobId, action, reason) {
      await api('/jobs/' + encodeURIComponent(jobId) + '/fit', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action, reason: reason || '' }),
      });
      await loadJobs();
    }

    function renderJobRows(list, jobs) {
      jobs.forEach(function (job) {
        var fitInfo = FIT_LABELS[job.fit_status] || FIT_LABELS.unassessed;
        var missing = [];
        try { missing = JSON.parse(job.fit_missing_json || '[]'); } catch (e) { missing = []; }

        var titleNode = job.source_url
          ? el('a', {
              className: 'row-title', href: job.source_url, target: '_blank', rel: 'noopener',
              textContent: job.title,
            })
          : el('span', { className: 'row-title', textContent: job.title });
        var titleLine = [titleNode, el('span', { className: ('badge ' + fitInfo.cls).trim(), textContent: fitInfo.text })];

        var meta = [
          job.company,
          job.location,
          job.posted_at ? 'posted ' + new Date(job.posted_at).toLocaleDateString() : '',
          job.ats_provider || 'added by hand',
        ].filter(Boolean).join(' · ');

        var body = [el('div', { className: 'row-title-line' }, titleLine), el('div', { className: 'row-meta', textContent: meta })];
        if (job.fit_reason) body.push(el('p', { className: 'job-reason', textContent: job.fit_reason }));
        if (missing.length) body.push(el('p', { className: 'job-missing', textContent: 'Gaps: ' + missing.join('; ') }));

        var actions = [];
        if (job.fit_status === 'reject') {
          var restore = el('button', { type: 'button', textContent: 'Restore' });
          restore.addEventListener('click', function () { submitJobFit(job.id, 'restore'); });
          actions.push(restore);
        } else {
          var reject = el('button', { type: 'button', textContent: 'Not for me' });
          reject.addEventListener('click', function () {
            var reason = window.prompt(
              'Optional — why isn\\'t this a fit? (helps avoid similar postings later)',
              job.fit_reason && job.fit_status !== 'unassessed' ? job.fit_reason : '',
            );
            if (reason === null) return;
            submitJobFit(job.id, 'reject', reason);
          });
          actions.push(reject);
        }
        var del = el('button', { className: 'danger', type: 'button', textContent: 'Remove' });
        del.addEventListener('click', async function () {
          await api('/jobs/' + encodeURIComponent(job.id), { method: 'DELETE' });
          loadJobs();
        });
        actions.push(del);

        var muted = RULED_OUT_STATUSES[job.fit_status] || QUEUED_STATUSES[job.fit_status];
        list.appendChild(el('div', { className: 'row-item' + (muted ? ' is-muted' : '') }, [
          el('div', { className: 'row' }, [
            el('div', {}, body),
            el('div', { className: 'row-actions' }, actions),
          ]),
        ]));
      });
    }

    function renderJobs() {
      var needle = document.getElementById('jobs-filter').value.trim();
      var showQueued = document.getElementById('jobs-show-unfiltered').checked;
      var showRejected = document.getElementById('jobs-show-rejected').checked;
      var list = document.getElementById('jobs-list');
      list.innerHTML = '';

      var matching = allJobs.filter(function (job) {
        return matchesFilter([job.title, job.company, job.location].join(' '), needle);
      });
      // Kept as three separate groups rather than one filtered-and-sorted list, so a fresh
      // scan's unreviewed postings can never end up sitting among ones you've already judged --
      // each group only ever appears in its own block, gated by its own toggle.
      var matches = matching.filter(function (j) { return !QUEUED_STATUSES[j.fit_status] && !RULED_OUT_STATUSES[j.fit_status]; });
      var queued = matching.filter(function (j) { return QUEUED_STATUSES[j.fit_status]; });
      var ruledOut = matching.filter(function (j) { return RULED_OUT_STATUSES[j.fit_status]; });
      var order = { strong: 0, possible: 1 };
      matches.sort(function (a, b) { return (order[a.fit_status] ?? 2) - (order[b.fit_status] ?? 2); });

      var queuedToggle = document.getElementById('jobs-show-unfiltered');
      queuedToggle.parentElement.style.display = queued.length ? 'flex' : 'none';
      document.getElementById('jobs-unfiltered-count').textContent =
        'Show ' + queued.length + ' posting' + (queued.length === 1 ? '' : 's') + ' not filtered yet';

      var rejectedToggle = document.getElementById('jobs-show-rejected');
      rejectedToggle.parentElement.style.display = ruledOut.length ? 'flex' : 'none';
      document.getElementById('jobs-rejected-count').textContent =
        'Show ' + ruledOut.length + ' posting' + (ruledOut.length === 1 ? '' : 's') + ' marked not a fit';

      if (!matches.length && !(showQueued && queued.length) && !(showRejected && ruledOut.length)) {
        list.appendChild(el('p', {
          className: 'empty',
          textContent: allJobs.length
            ? (matching.length ? 'Nothing to show — try the checkboxes above to reveal filtered-out postings.' : 'No postings match that filter.')
            : 'No job postings yet — add target companies and scan their boards.',
        }));
        return;
      }

      renderJobRows(list, matches);

      if (showQueued && queued.length) {
        list.appendChild(el('h3', { className: 'subhead', textContent: 'Not filtered yet' }));
        renderJobRows(list, queued);
      }
      if (showRejected && ruledOut.length) {
        list.appendChild(el('h3', { className: 'subhead', textContent: 'Marked not a fit' }));
        renderJobRows(list, ruledOut);
      }
    }

    document.getElementById('jobs-filter').addEventListener('input', renderJobs);
    document.getElementById('jobs-show-unfiltered').addEventListener('change', renderJobs);
    document.getElementById('jobs-show-rejected').addEventListener('change', renderJobs);

    document.getElementById('jobs-assess-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('jobs-assess-status');
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Screening listings, then assessing the ones worth a closer look…';
      statusEl.className = 'status';
      try {
        var res = await api('/jobs/process', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: document.getElementById('jobs-provider').value }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'process_failed'));
        var counts = data.counts || {};
        var left = (counts.unassessed || 0) + (counts.screened_in || 0);
        var parts = [];
        if (data.screened) parts.push('Screened ' + data.screened + ', dropped ' + data.screened_out + ' as clear misses.');
        if (data.assessed) parts.push('Assessed ' + data.assessed + ' in detail.');
        if (!parts.length) parts.push('Nothing left to process.');
        parts.push(left ? left + ' still queued — click again to continue.' : 'All caught up.');
        if ((data.errors || []).length) parts.push('Some batches failed: ' + data.errors.join('; '));
        statusEl.textContent = parts.join(' ');
        statusEl.className = (data.errors || []).length ? 'status error' : 'status success';
        await loadJobs();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      } finally {
        button.disabled = false;
      }
    });

    function renderJobPipeline(counts) {
      var host = document.getElementById('jobs-pipeline');
      host.innerHTML = '';
      var matches = (counts.strong || 0) + (counts.possible || 0);
      var queued = (counts.unassessed || 0) + (counts.screened_in || 0);
      host.appendChild(el('span', {}, [
        el('strong', { textContent: String(matches) }),
        el('span', { textContent: ' match' + (matches === 1 ? '' : 'es') +
          ' · ' + queued + ' waiting to be filtered' +
          ' · ' + (counts.screened_out || 0) + ' dropped in screening' +
          ' · ' + (counts.reject || 0) + ' ruled out' }),
      ]));
    }

    async function loadJobs() {
      var res = await api('/jobs');
      var data = await res.json();
      allJobs = data.jobs || [];
      renderJobPipeline(data.counts || {});
      renderJobs();
    }

    document.getElementById('job-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('job-status');
      statusEl.textContent = 'Adding…';
      statusEl.className = 'status';
      try {
        var res = await api('/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: document.getElementById('job-title').value,
            company: document.getElementById('job-company').value,
            source_url: document.getElementById('job-url').value,
            raw_description: document.getElementById('job-description').value,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'add_failed');
        statusEl.textContent = 'Added.';
        statusEl.className = 'status success';
        document.getElementById('job-form').reset();
        loadJobs();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    function renderDevices(currentId, devices) {
      var list = document.getElementById('devices-list');
      list.innerHTML = '';
      devices.forEach(function (device) {
        var isCurrent = device.id === currentId;
        var titleLine = [el('span', { className: 'row-title', textContent: device.device_name })];
        if (isCurrent) titleLine.push(el('span', { className: 'badge possible', textContent: 'this device' }));
        if (device.revoked) titleLine.push(el('span', { className: 'badge warn', textContent: 'revoked' }));
        var children = [
          el('div', {}, [
            el('div', { className: 'row-title-line' }, titleLine),
            el('div', { className: 'row-meta', textContent: 'Last seen ' + new Date(device.last_seen_at).toLocaleString() }),
          ]),
        ];
        if (!device.revoked) {
          var revoke = el('button', { className: 'danger', type: 'button', textContent: 'Revoke' });
          revoke.addEventListener('click', async function () {
            await api('/devices/' + encodeURIComponent(device.id) + '/revoke', { method: 'POST' });
            if (isCurrent) { goToEnroll(); return; }
            loadDevices();
          });
          children.push(el('div', { className: 'row-actions' }, [revoke]));
        }
        list.appendChild(el('div', { className: 'row-item' }, [el('div', { className: 'row' }, children)]));
      });
    }

    function formatBytes(n) {
      if (!n) return '0 KB';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function dataRow(label, value, note) {
      var body = [el('div', { className: 'row-title', textContent: label })];
      if (note) body.push(el('div', { className: 'row-meta', textContent: note }));
      return el('div', { className: 'row-item' }, [
        el('div', { className: 'row' }, [
          el('div', {}, body),
          el('div', { className: 'row-actions' }, [el('span', { className: 'badge', textContent: value })]),
        ]),
      ]);
    }

    async function loadData() {
      var res = await api('/data');
      var data = await res.json();
      var counts = data.counts || {};
      var pipeline = data.pipeline || {};
      var bytes = data.bytes || {};

      var countsHost = document.getElementById('data-counts');
      countsHost.innerHTML = '';
      countsHost.appendChild(dataRow('Target companies', String(counts.companies || 0)));
      countsHost.appendChild(dataRow(
        'Job listings', String(counts.jobs || 0),
        (pipeline.strong || 0) + ' strong · ' + (pipeline.possible || 0) + ' possible · ' +
        ((pipeline.unassessed || 0) + (pipeline.screened_in || 0)) + ' queued · ' +
        (pipeline.screened_out || 0) + ' screened out · ' + (pipeline.reject || 0) + ' ruled out',
      ));
      countsHost.appendChild(dataRow('Job description text', formatBytes(bytes.job_descriptions), 'Largest thing stored'));
      countsHost.appendChild(dataRow('Uploaded documents', String(counts.documents || 0), 'Extracted text: ' + formatBytes(bytes.document_text)));
      countsHost.appendChild(dataRow('Notes', String(counts.notes || 0)));
      countsHost.appendChild(dataRow('Desired-role signals', String(counts.role_signals || 0)));
      countsHost.appendChild(dataRow('Resume versions', String(counts.resumes || 0)));
      countsHost.appendChild(dataRow('Rejection reasons you taught it', String(counts.feedback || 0)));

      var stagesHost = document.getElementById('data-stages');
      stagesHost.innerHTML = '';
      (data.stages || []).forEach(function (stage, index) {
        var downstream = (data.stages || []).slice(index + 1).map(function (s) { return s.name.toLowerCase(); });
        var body = [
          el('div', { className: 'row-title', textContent: (index + 1) + '. ' + stage.name }),
          el('div', { className: 'row-meta', textContent: stage.detail }),
        ];
        if (downstream.length) {
          body.push(el('div', { className: 'row-meta', textContent: 'Also clears: ' + downstream.join(', ') }));
        }
        var reset = el('button', { className: 'danger', type: 'button', textContent: 'Reset' });
        reset.addEventListener('click', async function () {
          var warning = downstream.length
            ? 'Reset "' + stage.name + '" and also clear ' + downstream.join(', ') + '?'
            : 'Reset "' + stage.name + '"?';
          if (!window.confirm(warning)) return;
          var statusEl = document.getElementById('data-status');
          statusEl.textContent = 'Clearing…';
          statusEl.className = 'status';
          var r = await api('/data/purge-stage', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stage: stage.id }),
          });
          var d = await r.json();
          statusEl.textContent = r.ok ? 'Cleared: ' + (d.cleared || []).join(', ') + '.' : errorMessage(d, 'purge_failed');
          statusEl.className = r.ok ? 'status success' : 'status error';
          await loadData();
          await loadCompanies();
          await loadJobs();
        });
        stagesHost.appendChild(el('div', { className: 'row-item' }, [
          el('div', { className: 'row' }, [el('div', {}, body), el('div', { className: 'row-actions' }, [reset])]),
        ]));
      });

      var collectionsHost = document.getElementById('data-collections');
      collectionsHost.innerHTML = '';
      [
        { id: 'manual_jobs', name: 'Hand-added job postings', note: 'Postings you typed in yourself, which company scans never touch.' },
        { id: 'feedback', name: 'Rejection reasons', note: 'What you taught the filter by rejecting postings with a reason.' },
        { id: 'resumes', name: 'Resume versions', note: 'Generated resumes and their PDFs.' },
        { id: 'notes', name: 'Notes', note: 'Freeform notes on the Profile tab.' },
        { id: 'role_signals', name: 'Desired-role signals', note: 'Links and notes on the Desired Roles tab.' },
      ].forEach(function (collection) {
        var del = el('button', { className: 'danger', type: 'button', textContent: 'Delete' });
        del.addEventListener('click', async function () {
          if (!window.confirm('Delete all ' + collection.name.toLowerCase() + '?')) return;
          var statusEl = document.getElementById('data-status');
          var r = await api('/data/purge-collection', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ collection: collection.id }),
          });
          var d = await r.json();
          statusEl.textContent = r.ok ? 'Deleted ' + d.deleted + ' row' + (d.deleted === 1 ? '' : 's') + '.' : errorMessage(d, 'purge_failed');
          statusEl.className = r.ok ? 'status success' : 'status error';
          await loadData();
        });
        collectionsHost.appendChild(el('div', { className: 'row-item' }, [
          el('div', { className: 'row' }, [
            el('div', {}, [
              el('div', { className: 'row-title', textContent: collection.name }),
              el('div', { className: 'row-meta', textContent: collection.note }),
            ]),
            el('div', { className: 'row-actions' }, [del]),
          ]),
        ]));
      });
    }

    async function loadDevices() {
      var res = await api('/devices');
      var data = await res.json();
      renderDevices(data.current_device_id, data.devices);
    }

    loadProfile();
    loadRoleSignals();
    loadDocuments();
    loadNotes();
    loadResumes();
    loadCompanies();
    loadJobs();
    loadDevices();
    loadData();
  </script>
</body>
</html>`;

function dashboardPage(): Response {
  return new Response(DASHBOARD_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function downloadArtifact(request: Request, env: Env, key: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const object = await env.FILES.get(key, { range: request.headers });
  if (!object) return json({ error: "not_found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");
  headers.set("accept-ranges", "bytes");
  if (object.range && "offset" in object.range && "end" in object.range) {
    headers.set("content-range", `bytes ${object.range.offset}-${object.range.end}/${object.size}`);
  }
  const status = request.headers.get("range") !== null ? 206 : 200;
  return new Response(object.body, { headers, status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok", mode: "cloudflare" });
    if (request.method === "GET" && url.pathname === "/enroll") return enrollPage();
    if (request.method === "GET" && url.pathname === "/") {
      const auth = await requireSession(request, env);
      if (auth instanceof Response) return Response.redirect(new URL("/enroll", request.url).toString(), 302);
      return dashboardPage();
    }
    if (request.method === "GET" && url.pathname === "/profile") return getProfile(request, env);
    if (request.method === "PUT" && url.pathname === "/profile") return upsertProfile(request, env);
    if (request.method === "PUT" && url.pathname === "/profile/structured") return saveStructuredProfile(request, env);
    if (request.method === "GET" && url.pathname === "/companies") return listCompanies(request, env);
    if (request.method === "POST" && url.pathname === "/companies") return createCompany(request, env);
    if (request.method === "POST" && url.pathname === "/companies/discover") return discoverCompanies(request, env);
    if (request.method === "POST" && url.pathname === "/companies/scan") return scanCompanies(request, env);
    const companyMatch = url.pathname.match(/^\/companies\/([^/]+)$/);
    if (request.method === "PATCH" && companyMatch) return updateCompany(request, env, companyMatch[1]);
    if (request.method === "DELETE" && companyMatch) return deleteCompany(request, env, companyMatch[1]);
    if (request.method === "GET" && url.pathname === "/jobs") return listJobs(request, env);
    if (request.method === "POST" && url.pathname === "/jobs") return createJob(request, env);
    if (request.method === "POST" && url.pathname === "/jobs/process") return processJobs(request, env);
    if (request.method === "GET" && url.pathname === "/data") return dataSummary(request, env);
    if (request.method === "POST" && url.pathname === "/data/purge-stage") return purgeStage(request, env);
    if (request.method === "POST" && url.pathname === "/data/purge-collection") return purgeCollection(request, env);
    const jobFitMatch = url.pathname.match(/^\/jobs\/([^/]+)\/fit$/);
    if (request.method === "PATCH" && jobFitMatch) return setJobFit(request, env, jobFitMatch[1]);
    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (request.method === "DELETE" && jobMatch) return deleteJob(request, env, jobMatch[1]);
    if (request.method === "GET" && url.pathname === "/documents") return listDocuments(request, env);
    if (request.method === "POST" && url.pathname === "/documents") return uploadDocument(request, env);
    const documentFileMatch = url.pathname.match(/^\/documents\/([^/]+)\/file$/);
    if (request.method === "GET" && documentFileMatch) return getDocumentFile(request, env, documentFileMatch[1]);
    const documentMatch = url.pathname.match(/^\/documents\/([^/]+)$/);
    if (request.method === "PATCH" && documentMatch) return renameDocument(request, env, documentMatch[1]);
    if (request.method === "DELETE" && documentMatch) return deleteDocument(request, env, documentMatch[1]);
    if (request.method === "GET" && url.pathname === "/notes") return listNotes(request, env);
    if (request.method === "POST" && url.pathname === "/notes") return createNote(request, env);
    const noteMatch = url.pathname.match(/^\/notes\/([^/]+)$/);
    if (request.method === "DELETE" && noteMatch) return deleteNote(request, env, noteMatch[1]);
    if (request.method === "POST" && url.pathname === "/profile/generate") return generateProfile(request, env);
    if (request.method === "GET" && url.pathname === "/role-signals") return listRoleSignals(request, env);
    if (request.method === "POST" && url.pathname === "/role-signals") return createRoleSignal(request, env);
    const roleSignalMatch = url.pathname.match(/^\/role-signals\/([^/]+)$/);
    if (request.method === "DELETE" && roleSignalMatch) return deleteRoleSignal(request, env, roleSignalMatch[1]);
    if (request.method === "PUT" && url.pathname === "/desired-roles") return saveDesiredRoles(request, env);
    if (request.method === "POST" && url.pathname === "/desired-roles/generate") return generateDesiredRoles(request, env);
    if (request.method === "GET" && url.pathname === "/resumes") return listResumes(request, env);
    if (request.method === "POST" && url.pathname === "/resumes") return createResume(request, env);
    const resumeFileMatch = url.pathname.match(/^\/resumes\/([^/]+)\/file$/);
    if (request.method === "GET" && resumeFileMatch) return getResumeFile(request, env, resumeFileMatch[1]);
    const resumeReviewMatch = url.pathname.match(/^\/resumes\/([^/]+)\/review$/);
    if (request.method === "POST" && resumeReviewMatch) return reviewResume(request, env, resumeReviewMatch[1]);
    const resumeMatch = url.pathname.match(/^\/resumes\/([^/]+)$/);
    if (request.method === "PATCH" && resumeMatch) return renameResume(request, env, resumeMatch[1]);
    if (request.method === "DELETE" && resumeMatch) return deleteResume(request, env, resumeMatch[1]);
    if (request.method === "POST" && url.pathname === "/admin/enrollments") return createEnrollment(request, env);
    if (request.method === "POST" && url.pathname === "/auth/enroll") return exchangeEnrollment(request, env);
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      return json({ authenticated: false }, 200, { "set-cookie": clearSessionCookie() });
    }
    if (request.method === "GET" && url.pathname === "/devices") return listDevices(request, env);
    const deviceMatch = url.pathname.match(/^\/devices\/([^/]+)\/revoke$/);
    if (request.method === "POST" && deviceMatch) return revokeDevice(request, env, deviceMatch[1]);
    if (request.method === "POST" && url.pathname === "/artifacts") return uploadArtifact(request, env);
    const artifactMatch = url.pathname.match(/^\/artifacts\/(.+)$/);
    if (request.method === "GET" && artifactMatch) return downloadArtifact(request, env, decodeURIComponent(artifactMatch[1]));
    if (request.method === "GET" && url.pathname === "/me") {
      const auth = await requireSession(request, env);
      return auth instanceof Response ? auth : json({ authenticated: true, device: auth });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
