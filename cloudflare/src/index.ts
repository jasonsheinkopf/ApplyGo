import { extractText, getDocumentProxy } from "unpdf";
import WordExtractor from "word-extractor";
import { type BrowserWorker } from "@cloudflare/puppeteer";
import {
  type LlmTrace,
  type Provider,
  type TraceSink,
  WRITING_STYLE_RULES,
  callStructured,
  callText,
  friendlyMessage,
  normalizeProvider,
  providerKeyMissing,
} from "./llm";
import {
  DEV_PAGE,
  TRACE_RETENTION,
  costSummary,
  getTrace,
  listTraces,
  taskRollups,
} from "./devconsole";
import {
  type ReplaySpec,
  createEvalCase,
  createEvalRun,
  getEvalCase,
  judgeRun,
  listEvalCases,
  listEvalRuns,
  replayTask,
  updateEvalCase,
} from "./evals";
import { taskInfo } from "./tasks";
import {
  type EvidencePlan,
  type JobRequirements,
  PLAN_SCHEMA,
  REQUIREMENTS_SCHEMA,
  coverageSummary,
  extractJobRequirements,
  planEvidence,
  renderPlanDirective,
} from "./philosophy";
import {
  type AtsProvider,
  COMPANY_LIST_SCHEMA,
  companyNameKey,
  fetchBoardJobs,
  fetchMissingDescriptions,
  filterJobsByRoles,
  locationMatches,
  parseLocationFilter,
  proposeCompanies,
  resolveBoard,
  verifyWebsite,
} from "./companies";
import {
  CARE_ABOUT_TOPICS_SCHEMA,
  type CareAboutTopic,
  FIT_BATCH_SCHEMA,
  FIT_BATCH_SIZE,
  type FitResult,
  SCREEN_BATCH_SCHEMA,
  SCREEN_BATCH_SIZE,
  assessJobFitBatch,
  buildMatchProfile,
  deriveCareAboutTopics,
  screenJobsBatch,
  verdictForScore,
} from "./fit";
import {
  type LayoutSpec,
  RESUME_DOC_SCHEMA,
  type ResumeCheck,
  type ComposeOptions,
  type ResumeDoc,
  type StructuredProfile,
  TEMPLATES,
  applyLayoutAdjustments,
  composeResumeDoc,
  defaultLayout,
  escapeHtml,
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
  LOCAL_RENDER_URL?: string;
  /** Set to "off" to stop recording model calls. Anything else (including unset) records them. */
  LLM_TRACE?: string;
  /** Installed once per isolate by the router; see attachTraceSink. */
  LLM_TRACE_SINK?: TraceSink;
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

/**
 * A response that streams one JSON object per line as work progresses, for operations long
 * enough that "please wait" isn't good enough -- screening hundreds of postings, or scanning a
 * dozen company boards. `run` is handed an `emit` function it calls after each unit of work; the
 * body starts streaming to the client immediately rather than only after everything finishes.
 *
 * Each unit of work is written to the database before its progress event is emitted (both endpoints
 * that use this already do that), so if the connection drops or the request is cancelled partway
 * through, everything done so far is saved -- resuming just means clicking the button again.
 */
function ndjsonResponse(ctx: ExecutionContext, run: (emit: (event: unknown) => Promise<void>) => Promise<unknown>): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const emit = (event: unknown) => writer.write(encoder.encode(JSON.stringify(event) + "\n"));

  ctx.waitUntil(
    (async () => {
      try {
        const result = await run(emit);
        await emit({ type: "done", ...(result as object) });
      } catch (err) {
        await emit({ type: "error", message: (err as Error).message });
      } finally {
        await writer.close();
      }
    })(),
  );

  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
}

/**
 * Runs `fn` over `items` with at most `concurrency` in flight at once, calling `onSettle` as each
 * one finishes (in completion order, not list order) so progress can still stream live rather than
 * only once the whole batch is done. Company board scans and job-fit LLM calls are both purely
 * I/O-bound -- almost all of their time is spent waiting on a fetch or a model response, not on
 * CPU -- so running a handful at once instead of one after another cuts wall-clock time roughly by
 * the concurrency factor for free, which is what turns "several minutes across multiple rounds"
 * into "under a minute in one click" for a realistic company list or posting backlog.
 */
async function runPooled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  onSettle: (item: T, result: R) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      const result = await fn(item);
      await onSettle(item, result);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()));
}

/**
 * Writes each completed model call to D1.
 *
 * The write is awaited inside the call rather than deferred: an LLM call takes seconds, a D1 insert
 * takes milliseconds, so the overhead is noise, and awaiting means a trace is never lost to a
 * request finishing before its background write did. Failures are swallowed upstream in llm.ts --
 * observability must not be able to break the thing it observes.
 */
function createTraceSink(env: Env): TraceSink {
  return async (trace: LlmTrace) => {
    await env.DB.prepare(
      `INSERT INTO llm_traces
       (id, task, provider, model, tier, prompt, response, input_tokens, output_tokens,
        cost_usd, latency_ms, ok, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        trace.task,
        trace.provider,
        trace.model,
        trace.tier,
        trace.prompt,
        trace.response,
        trace.inputTokens,
        trace.outputTokens,
        trace.costUsd,
        trace.latencyMs,
        trace.ok ? 1 : 0,
        trace.error,
      )
      .run();

    // Pruning on every insert would mean a full ordering scan per model call, and calls arrive
    // eight at a time. Sampling keeps the table bounded at negligible cost -- the exact row count
    // hovering somewhere above the cap between prunes doesn't matter for a debugging tool.
    if (Math.random() < 0.02) {
      await env.DB.prepare(
        `DELETE FROM llm_traces WHERE id IN (
           SELECT id FROM llm_traces ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )`,
      )
        .bind(TRACE_RETENTION)
        .run();
    }
  };
}

/**
 * Installs the trace sink on the env object once. `env` is shared across requests within an
 * isolate, but the sink closes over nothing request-specific (only the D1 binding, which is
 * constant), so installing it once and reusing it is safe.
 */
function attachTraceSink(env: Env): void {
  if (env.LLM_TRACE === "off" || env.LLM_TRACE_SINK) return;
  env.LLM_TRACE_SINK = createTraceSink(env);
}

/**
 * Additive columns this build's code reads, applied at runtime if they aren't there yet.
 *
 * The deploy path made this necessary. Pushing to the repo triggers a Cloudflare Workers Build that
 * runs `wrangler deploy` and nothing else -- it does NOT run `wrangler d1 migrations apply`. Only
 * the local `npm run release:production` script chains the two. So a commit that adds a migration
 * and the code that depends on it ships the code to production while the column is still missing,
 * and every query naming it fails until somebody remembers to run migrations by hand. That is a
 * loaded footgun: the deploy goes green, and the breakage shows up later as a runtime error on a
 * feature nobody thought they had touched.
 *
 * Restricted to `ADD COLUMN` on purpose. Adding a nullable/defaulted column is backward compatible
 * in both directions -- older code ignores it, newer code finds it -- so running it early, or twice,
 * or against a database that already has it, is harmless. Anything destructive or reshaping (drops,
 * renames, backfills, table rewrites) deliberately does NOT belong here and stays a deliberate
 * `wrangler d1 migrations apply` step, because those need a human deciding when they happen.
 *
 * These statements mirror the `ALTER TABLE ... ADD COLUMN` lines in migrations/. The migration files
 * remain the canonical schema for provisioning a fresh database; this list is the safety net for
 * databases that already exist. Any new additive column should be added in both places.
 */
const ADDITIVE_COLUMNS = [
  // 0017_resume_philosophy.sql
  "ALTER TABLE resumes ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE resumes ADD COLUMN plan_json TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE job_postings ADD COLUMN requirements_json TEXT NOT NULL DEFAULT '{}'",
];

/**
 * The in-flight or completed guard run for this isolate.
 *
 * Deliberately a memoized promise rather than a boolean: with a boolean flag set before the awaits,
 * a second request arriving while the first is still running its ALTERs would see "already checked"
 * and proceed against a database that isn't ready yet -- which is precisely the failure this guard
 * exists to prevent, reintroduced by the guard itself. Every caller awaits the same promise instead.
 */
let schemaReady: Promise<void> | null = null;

async function applyAdditiveColumns(env: Env): Promise<void> {
  for (const statement of ADDITIVE_COLUMNS) {
    try {
      await env.DB.prepare(statement).run();
    } catch {
      // Already present, which is the expected outcome nearly every time.
    }
  }
}

/**
 * Applies any missing additive columns, once per isolate.
 *
 * D1 has no `ADD COLUMN IF NOT EXISTS`, so each statement is attempted and its "duplicate column"
 * error swallowed -- on an already-migrated database (the normal case) every statement fails
 * harmlessly and nothing changes. Failures are never propagated: a schema guard that could take the
 * whole Worker down would be a worse problem than the one it exists to prevent.
 */
function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) schemaReady = applyAdditiveColumns(env);
  return schemaReady;
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

/**
 * Accepts either the dashboard's cookie or an `Authorization: Bearer` token, both hashed against
 * the same device_sessions table. The bearer path exists for the browser extension, which runs on
 * an ATS origin and so cannot rely on a same-site cookie.
 *
 * Deliberately the same table and the same token: the extension enrolls through the normal
 * one-time-code flow, appears in the Devices tab like any other device, and is revoked the same
 * way. A separate API-key system would be more code and one more thing that can outlive a revoke.
 */
async function requireSession(request: Request, env: Env): Promise<Session | Response> {
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = cookieValue(request, "applygo_session") ?? bearer;
  if (!token) return json({ error: "authentication_required" }, 401);
  const tokenHash = await sha256(token);
  const session = await env.DB.prepare(
    `SELECT id, device_name, expires_at, revoked_at
     FROM device_sessions
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(tokenHash)
    .first<Session>();
  if (!session) {
    // Only clear the cookie when the request actually presented one; a bad bearer token from the
    // extension has no business expiring the dashboard's session in the same browser.
    return bearer && !cookieValue(request, "applygo_session")
      ? json({ error: "invalid_or_expired_session" }, 401)
      : json({ error: "invalid_or_expired_session" }, 401, { "set-cookie": clearSessionCookie() });
  }
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
  const body = (await request.json()) as { code?: string; device_name?: string; return_token?: boolean };
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
  // The extension can't use the cookie (it calls from an ATS origin), so it asks for the raw token
  // instead. Returning it here gives away nothing extra: the caller just proved it holds a valid
  // single-use enrollment code, and it receives the very same token via Set-Cookie regardless.
  const payload: Record<string, unknown> = { authenticated: true, device_id: sessionId, expires_in_days: days };
  if (body.return_token === true) payload.token = token;
  return json(payload, 201, { "set-cookie": sessionCookie(token, days * 86400) });
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

/** Free-text hard requirements the candidate wrote themselves, enforced by tier-2 scoring as
 * binding rules alongside the built-in guidance (see fitPrompt in src/fit.ts). Deliberately
 * generic rather than a fixed "years of experience" field -- what counts as a dealbreaker (a
 * years-of-experience ceiling, a tech stack, a certification, anything) is different for everyone
 * and shouldn't require editing the prompt in code to change. */
function readDealbreakers(preferencesJson: string): string {
  try {
    return (JSON.parse(preferencesJson || "{}") as { dealbreakers?: string }).dealbreakers ?? "";
  } catch {
    return "";
  }
}

/** Free-text topics the candidate wants surfaced as quick facts per posting (see fitPrompt in
 * src/fit.ts) -- purely informational, unlike dealbreakers this never affects the fit score. What
 * counts as worth seeing at a glance (salary, years required, remote/hybrid/onsite, anything) is
 * personal, so it's the candidate's own words rather than a fixed set of fields the app picked. */
function readCareAbout(preferencesJson: string): string {
  try {
    return (JSON.parse(preferencesJson || "{}") as { care_about?: string }).care_about ?? "";
  } catch {
    return "";
  }
}

/** The interpreted topic list derived from `care_about` -- see deriveCareAboutTopics in src/fit.ts. */
function readCareAboutTopics(preferencesJson: string): CareAboutTopic[] {
  try {
    const topics = (JSON.parse(preferencesJson || "{}") as { care_about_topics?: CareAboutTopic[] })
      .care_about_topics;
    return Array.isArray(topics) ? topics.filter((topic) => topic?.label) : [];
  } catch {
    return [];
  }
}

async function writeCareAboutTopics(env: Env, profileId: string, topics: CareAboutTopic[]): Promise<void> {
  const existing = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(existing?.preferences_json || "{}");
  } catch {
    prefs = {};
  }
  prefs.care_about_topics = topics;
  await env.DB.prepare("UPDATE candidate_profiles SET preferences_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(prefs), profileId)
    .run();
}

/**
 * The topic list the scoring pass should use, deriving and caching it if it isn't there yet.
 *
 * Topics are normally resolved once when the candidate saves their "what do you care about" text.
 * This covers the two cases where that hasn't happened: text saved before topics existed, and a
 * save whose derivation call failed. Deriving here costs one cheap call per pipeline run at most,
 * and the result is persisted, so it self-heals rather than re-deriving on every run. Failing to
 * derive is not worth failing a scan over -- an empty list just means no fact chips this round.
 */
async function ensureCareAboutTopics(
  env: Env,
  provider: Provider,
  profileId: string,
  preferencesJson: string,
): Promise<CareAboutTopic[]> {
  const existing = readCareAboutTopics(preferencesJson);
  if (existing.length) return existing;
  const careAbout = readCareAbout(preferencesJson);
  if (!careAbout.trim() || providerKeyMissing(env, provider)) return [];
  try {
    const topics = await deriveCareAboutTopics(env, provider, careAbout);
    if (topics.length) await writeCareAboutTopics(env, profileId, topics);
    return topics;
  } catch {
    return [];
  }
}

/** One distinct role family the analysis thinks the candidate is suited for. */
type RoleAnalysisEntry = { title: string; description: string };

/**
 * The structured output of `roles.analyze`: a non-role-specific summary (location, what to avoid,
 * what matters) plus the distinct role types it identified. Regenerated wholesale by Reanalyze --
 * there's no per-field merge, since re-deriving from the current notes/preferences is the point.
 */
type RoleAnalysis = { summary: string; roles: RoleAnalysisEntry[] };

function readRoleAnalysis(preferencesJson: string): RoleAnalysis | null {
  try {
    const analysis = (JSON.parse(preferencesJson || "{}") as { role_analysis?: RoleAnalysis }).role_analysis;
    return analysis && Array.isArray(analysis.roles) ? analysis : null;
  } catch {
    return null;
  }
}

/**
 * Renders the structured analysis back into the same kind of plain-text block the fit/screen/resume
 * prompts have always taken as `desiredRoles` -- one heading + description per distinct role family.
 * Keeps every downstream consumer of that string unchanged while the candidate-facing side of this
 * became structured.
 */
function flattenRoleAnalysis(analysis: RoleAnalysis): string {
  return analysis.roles.map((r) => `## ${r.title}\n${r.description}`).join("\n\n");
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
      dealbreakers: readDealbreakers(profile?.preferences_json ?? "{}"),
      care_about: readCareAbout(profile?.preferences_json ?? "{}"),
      care_about_topics: readCareAboutTopics(profile?.preferences_json ?? "{}"),
      role_analysis: readRoleAnalysis(profile?.preferences_json ?? "{}"),
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

/**
 * Saves the three raw preference inputs -- locations, dealbreakers, criteria -- that feed both
 * scoring and the roles analysis. `desired_roles` itself is not accepted here: it's system-derived
 * output from `analyzeDesiredRoles`, not something typed directly, so this endpoint never touches it.
 */
async function saveDesiredRoles(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    desired_locations?: string;
    dealbreakers?: string;
    care_about?: string;
    provider?: string;
  };
  const desiredLocations = (body.desired_locations ?? "").trim();
  const dealbreakers = (body.dealbreakers ?? "").trim();
  const careAbout = (body.care_about ?? "").trim();
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

  // Re-interpreting the free text into topics is a model call, so it only runs when that text
  // actually changed -- editing a location shouldn't re-derive (and possibly re-word) the fact
  // columns. Clearing the text clears the topics without a call.
  const previousCareAbout = readCareAbout(existing?.preferences_json ?? "{}");
  let topics = readCareAboutTopics(existing?.preferences_json ?? "{}");
  if (!careAbout) {
    topics = [];
  } else if (careAbout !== previousCareAbout || !topics.length) {
    const provider = normalizeProvider(body.provider);
    if (!providerKeyMissing(env, provider)) {
      // A failed derivation must not fail the save -- the text is still stored, and the pipeline
      // re-derives on its next run via ensureCareAboutTopics.
      try {
        topics = await deriveCareAboutTopics(env, provider, careAbout);
      } catch {
        topics = [];
      }
    }
  }

  prefs.desired_locations = desiredLocations;
  prefs.dealbreakers = dealbreakers;
  prefs.care_about = careAbout;
  prefs.care_about_topics = topics;
  await env.DB.prepare("UPDATE candidate_profiles SET preferences_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(prefs), profileId)
    .run();
  return json({
    desired_locations: desiredLocations,
    dealbreakers,
    care_about: careAbout,
    care_about_topics: topics,
  });
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

const ROLE_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "One short paragraph covering only what matters to this candidate independent of any specific role -- " +
        "location constraints, what to avoid, what to prioritize. Never names a job title here.",
    },
    roles: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "A short, concrete job title a posting would actually use (e.g. 'Applied AI Engineer'), not a sentence.",
          },
          description: {
            type: "string",
            description:
              "Role family/titles, seniority, domain, must-have vs nice-to-have aspects, and enough concrete " +
              "keywords that a simple keyword match could find it.",
          },
        },
        required: ["title", "description"],
      },
      description:
        "Each genuinely distinct role family the candidate should be shown -- not variations on one title. Do " +
        "not blend different fields into one hybrid role that doesn't exist in the job market; a posting only " +
        "has to match ONE entry to be worth surfacing.",
    },
  },
  required: ["summary", "roles"],
} as const;

/**
 * Replaces the old free-text draft-then-paste flow: reanalyzes in one shot from every current input
 * (role-signal notes, the structured profile, locations, dealbreakers, criteria) and saves directly --
 * there's no draft to review first, since a candidate who wants to react to it can just Reanalyze
 * again. `desired_roles`, the flat string every scoring/resume prompt actually reads, is regenerated
 * from the result rather than typed, so it can never drift from what Analysis is showing.
 */
async function analyzeDesiredRoles(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const profileId = await getOrCreateProfileId(env);
  const [profileRow, signals] = await Promise.all([
    env.DB.prepare("SELECT preferences_json, match_profile FROM candidate_profiles WHERE id = ?")
      .bind(profileId)
      .first<{ preferences_json: string; match_profile: string }>(),
    env.DB.prepare(
      "SELECT claim FROM candidate_evidence WHERE profile_id = ? AND category = 'role_signal' ORDER BY created_at ASC",
    )
      .bind(profileId)
      .all<{ claim: string }>(),
  ]);

  const matchProfile = (profileRow?.match_profile ?? "").trim();
  const notes = signals.results.map((s) => s.claim);
  if (!notes.length && !matchProfile) return json({ error: "no_source_material" }, 400);

  const preferencesJson = profileRow?.preferences_json ?? "{}";
  const desiredLocations = readDesiredLocations(preferencesJson);
  const dealbreakers = readDealbreakers(preferencesJson);
  const careAbout = readCareAbout(preferencesJson);

  const prompt = [
    "A job candidate wants two things from you: what matters to them in a search regardless of role, and which",
    "distinct kinds of roles their background and stated interests actually support.",
    "",
    "SUMMARY: one short paragraph covering only things that apply no matter what role they're looking at --",
    "location constraints, what to avoid, what to prioritize. Do not name specific job titles here.",
    "",
    "ROLES: each genuinely distinct role family they should be shown -- not variations on one title, but",
    "different fields or functions entirely (for example, a former teacher now open to machine learning",
    "engineering roles, advocacy roles, AND corporate training roles). Do not blend them into a single hybrid",
    "role that doesn't actually exist in the job market, like 'ML advocate and trainer'. Being open to several",
    "different paths is not the same as wanting one job that combines all of them, and a posting only has to be",
    "a strong match for ONE entry to be worth surfacing, not all of them at once. For each entry, give a short",
    "concrete title plus a description covering role family/titles, seniority, domain, must-have vs nice-to-have",
    "aspects, and enough concrete keywords (actual job titles a posting would use) that a simple keyword match",
    "could find it.",
    "",
    "Ground both in the candidate's actual background below, not just their notes -- a role their experience",
    "doesn't support isn't a good entry even if a note mentions interest in it.",
    "",
    WRITING_STYLE_RULES,
    "",
    matchProfile ? `CANDIDATE BACKGROUND:\n${matchProfile}` : "",
    notes.length ? `NOTES AND LINKS:\n${notes.map((c) => `- ${c}`).join("\n")}` : "",
    desiredLocations ? `LOCATIONS THEY'LL WORK IN:\n${desiredLocations}` : "",
    dealbreakers ? `DEALBREAKERS:\n${dealbreakers}` : "",
    careAbout ? `WHAT THEY SAID THEY CARE ABOUT:\n${careAbout}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  let analysis: RoleAnalysis;
  try {
    analysis = await callStructured<RoleAnalysis>(
      env,
      provider,
      "roles.analyze",
      prompt,
      ROLE_ANALYSIS_SCHEMA,
      "submit_role_analysis",
      3000,
    );
  } catch (err) {
    return json({ error: "generation_failed", detail: friendlyMessage(err) }, 502);
  }

  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(preferencesJson || "{}");
  } catch {
    prefs = {};
  }
  const desiredRoles = flattenRoleAnalysis(analysis);
  prefs.role_analysis = analysis;
  prefs.desired_roles = desiredRoles;
  await env.DB.prepare("UPDATE candidate_profiles SET preferences_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(prefs), profileId)
    .run();

  return json({ provider, role_analysis: analysis, desired_roles: desiredRoles });
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
  // No LIMIT here, and no raw_description: the dashboard's own pipeline summary (jobPipelineCounts,
  // below) counts every row in the table, and a capped/truncated list here would silently disagree
  // with it -- a posting the summary counts as a match could land outside the cap and never render.
  // raw_description is dropped because the Jobs tab never displays it (only fit_reason and
  // fit_missing_json do), and at up to 1500 chars per row it's the single biggest thing here.
  const jobs = await env.DB.prepare(
    `SELECT id, title, company, source_url, location, posted_at, ats_provider,
            company_id, fit_status, fit_score, fit_reason, fit_missing_json, fit_detail_json, interested_at, applied_at, created_at,
            assessed_at,
            EXISTS(SELECT 1 FROM resumes r WHERE r.job_id = job_postings.id) AS has_resume,
            EXISTS(SELECT 1 FROM cover_letters c WHERE c.job_id = job_postings.id) AS has_cover_letter
     FROM job_postings
     ORDER BY COALESCE(posted_at, created_at) DESC`,
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

// Same reasoning as the company-scan concurrency: an assess call is one LLM request per batch of
// FIT_BATCH_SIZE postings, and the batches don't depend on each other, so several run at once
// instead of one after another. Shared between processJobs's own tier-2 pass and the "reassess my
// top matches" action below, so both get the same throughput.
const ASSESS_CONCURRENCY = 8;

/**
 * Tier-2 assessment over an already-fetched set of rows: batches them, fires the batches
 * concurrently, and writes+reports each as it completes. Factored out of processJobs so
 * `reassessTopMatches` below can reuse the exact same scoring logic against a different row
 * selection instead of duplicating the batching/concurrency/storage code.
 */
async function assessRowsBatched(
  env: Env,
  provider: Provider,
  structured: StructuredProfile,
  desiredRoles: string,
  disqualifiers: string[],
  dealbreakers: string,
  careAboutTopics: CareAboutTopic[],
  rows: JobRow[],
  total: number,
  emit: (event: unknown) => Promise<void>,
): Promise<{ assessed: number; errors: string[] }> {
  const items = toAssessable(rows);
  const batches: (typeof items)[] = [];
  for (let i = 0; i < items.length; i += FIT_BATCH_SIZE) batches.push(items.slice(i, i + FIT_BATCH_SIZE));

  const errors: string[] = [];
  let assessed = 0;
  let recommended = 0;
  let discarded = 0;
  let failed = false;
  await runPooled(
    batches,
    ASSESS_CONCURRENCY,
    async (batch) => {
      if (failed) return null;
      try {
        return await assessJobFitBatch(
          env, provider, JSON.stringify(structured), desiredRoles, disqualifiers, dealbreakers, careAboutTopics, batch,
        );
      } catch (err) {
        errors.push(`assess: ${(err as Error).message}`);
        failed = true;
        return null;
      }
    },
    async (_batch, results) => {
      if (!results) return;
      await storeFitResults(env, results);
      assessed += results.length;
      // Same reasoning as the screen stage's emit above: recommended/discarded are real,
      // just-happened counts for this batch (via the same verdictForScore cutoff storeFitResults
      // itself used), not a guess derived from done/total.
      for (const result of results) {
        if (verdictForScore(result.score) === "reject") discarded += 1;
        else recommended += 1;
      }
      await emit({ type: "progress", stage: "assess", done: assessed, total, recommended, discarded });
    },
  );
  return { assessed, errors };
}

/**
 * Runs the filtering pipeline: cheap screen, then strong assessment on whatever has survived it
 * (from this round or an earlier one).
 *
 * Both tiers run in one request, bounded by a shared call budget split roughly evenly between
 * them, and the response reports what is left at each stage so the dashboard can simply ask
 * again. A posting still has to be screened before it's ever eligible for assessment -- that
 * dependency is real and unavoidable -- but the two tiers' *backlogs* are worked down together
 * each round rather than one strictly first: an all-screen-then-leftover-to-assess split let a
 * large enough raw backlog claim the entire budget round after round, leaving screened_in
 * postings sitting there fully paid for and unassessed for as long as new raw postings kept
 * outnumbering the shared budget.
 */
async function processJobs(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  // Raised alongside the switch to concurrent batches below: each call is a single LLM request
  // covering a whole batch of postings (60 for screen, 8 for assess), and firing several of those
  // at once instead of one after another is what lets a realistic backlog clear in one click.
  const budget = { remaining: Math.min(Math.max(Number(body.calls) || 6, 1), 24) };
  const LLM_CONCURRENCY = 8;

  return ndjsonResponse(ctx, async (emit) => {
    const errors: string[] = [];
    let screened = 0;
    let screenedOut = 0;
    let assessed = 0;

    // Reported against the full backlog, not just what this click's budget can reach, so
    // "screened 50 of 243" stays meaningful across however many clicks it takes to clear it.
    const screenTotal = (await env.DB.prepare("SELECT COUNT(*) AS n FROM job_postings WHERE fit_status = 'unassessed'").first<{ n: number }>())?.n ?? 0;

    // The shared budget is split up front rather than handed to tier 1 first-come-first-served:
    // a large enough raw backlog (screening 60 at a time) can otherwise consume the entire budget
    // every single round, leaving tier 2 permanently at zero calls even though postings are
    // already sitting there screened_in, already paid for, waiting on the one step that actually
    // produces a verdict. Reserving half for assessment up front means a screened_in backlog
    // always gets worked down alongside the raw one, not only after it's entirely gone -- and
    // whichever tier doesn't need its full half (because there simply isn't that much of it left)
    // gives the unused portion back to the other rather than leaving it idle.
    const assessShare = Math.floor(budget.remaining / 2);
    const screenShare = budget.remaining - assessShare;

    // Tier 1: cheap bulk screen over everything untouched. Every batch this round's screen share
    // can afford is fetched up front and split into disjoint chunks (so concurrent calls never see
    // overlapping rows), then fired at once -- batches don't depend on each other, so there's no
    // reason to wait for one to finish before starting the next.
    const screenRows = await env.DB.prepare(
      `SELECT id, title, company, location, raw_description FROM job_postings
       WHERE fit_status = 'unassessed' ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(screenShare * SCREEN_BATCH_SIZE)
      .all<JobRow>();
    const screenItems = toAssessable(screenRows.results ?? []);
    const screenBatches: (typeof screenItems)[] = [];
    for (let i = 0; i < screenItems.length; i += SCREEN_BATCH_SIZE) screenBatches.push(screenItems.slice(i, i + SCREEN_BATCH_SIZE));
    // Tier 2 below reads budget.remaining, so any of the screen share left unused (the raw
    // backlog ran out before using its whole half) rolls forward into assessment's share instead
    // of just being dropped on the floor for this round.
    budget.remaining = assessShare + (screenShare - screenBatches.length);

    let screenFailed = false;
    await runPooled(
      screenBatches,
      LLM_CONCURRENCY,
      async (batch) => {
        if (screenFailed) return null;
        try {
          return await screenJobsBatch(env, provider, matchProfile, desiredRoles, disqualifiers, batch);
        } catch (err) {
          errors.push(`screen: ${(err as Error).message}`);
          screenFailed = true;
          return null;
        }
      },
      async (_batch, results) => {
        if (!results) return;
        for (const result of results) {
          // Written immediately, one posting at a time, so a dropped connection loses at most
          // the still-in-flight batches -- everything already screened stays screened.
          await env.DB.prepare(
            "UPDATE job_postings SET fit_status = ?, fit_reason = ?, screened_at = CURRENT_TIMESTAMP WHERE id = ?",
          )
            .bind(result.keep ? "screened_in" : "screened_out", result.keep ? "" : result.note, result.id)
            .run();
          if (!result.keep) screenedOut += 1;
        }
        screened += results.length;
        // screened_in/screened_out here are cumulative within this call, not lifetime totals --
        // the Search tab's live pipeline diagram uses them as real per-batch deltas (this posting
        // really was just screened out, right now) rather than inferring a split from done/total,
        // which carries no accept/reject information at all.
        await emit({
          type: "progress",
          stage: "screen",
          done: screened,
          total: screenTotal,
          screened_in: screened - screenedOut,
          screened_out: screenedOut,
        });
      },
    );

    // Tier 2: strong model, only on survivors. Total is snapshotted now rather than at the top
    // of the function, since tier 1 above is what populates this queue in the first place.
    const assessTotal = (await env.DB.prepare("SELECT COUNT(*) AS n FROM job_postings WHERE fit_status = 'screened_in'").first<{ n: number }>())?.n ?? 0;

    const assessRows = await env.DB.prepare(
      `SELECT id, title, company, location, raw_description FROM job_postings
       WHERE fit_status = 'screened_in' ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(budget.remaining * FIT_BATCH_SIZE)
      .all<JobRow>();

    const dealbreakers = readDealbreakers(profileRow?.preferences_json ?? "{}");
    const careAboutTopics = await ensureCareAboutTopics(env, provider, profileId, profileRow?.preferences_json ?? "{}");
    const assessResult = await assessRowsBatched(
      env, provider, structured, desiredRoles, disqualifiers, dealbreakers, careAboutTopics,
      assessRows.results ?? [], assessTotal, emit,
    );
    assessed = assessResult.assessed;
    errors.push(...assessResult.errors);

    return { screened, screened_out: screenedOut, assessed, errors, counts: await jobPipelineCounts(env) };
  });
}

/**
 * Re-scores whatever's already sitting at or above a score threshold, against the candidate's
 * current dealbreakers/preferences -- for after editing them, when the postings that mattered most
 * were already judged under the old criteria. Only reaches jobs still in the fresh-match buckets
 * (`strong`/`possible`); a job the candidate already acted on (interested/applied/manually
 * rejected) is a decision already made and isn't silently re-touched by this. Reuses the exact
 * scoring logic `processJobs`'s own tier-2 pass uses, via `assessRowsBatched`, rather than a
 * separate implementation that could drift from it.
 */
async function reassessTopMatches(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string; min_score?: number };
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);
  const minScore = Math.min(Math.max(Number(body.min_score) || 70, 0), 100);

  const profileId = await getOrCreateProfileId(env);
  const profileRow = await env.DB.prepare(
    "SELECT preferences_json, structured_json FROM candidate_profiles WHERE id = ?",
  )
    .bind(profileId)
    .first<{ preferences_json: string; structured_json: string }>();
  const structured = readStructuredProfile(profileRow?.structured_json ?? "{}");
  if (!structured) return json({ error: "no_profile_yet" }, 400);
  const desiredRoles = readDesiredRoles(profileRow?.preferences_json ?? "{}");
  const dealbreakers = readDealbreakers(profileRow?.preferences_json ?? "{}");
  const careAboutTopics = await ensureCareAboutTopics(env, provider, profileId, profileRow?.preferences_json ?? "{}");
  const disqualifiers = await loadDisqualifiers(env, profileId);

  // Capped defensively -- this is a deliberate one-off action the candidate chose to trigger with
  // their own threshold, not a routine high-frequency operation, but a threshold of 0 shouldn't be
  // able to re-run the strong model against the entire history in one click.
  const targets = await env.DB.prepare(
    `SELECT id, title, company, location, raw_description FROM job_postings
     WHERE fit_status IN ('strong', 'possible') AND fit_score >= ?
     ORDER BY fit_score DESC LIMIT 300`,
  )
    .bind(minScore)
    .all<JobRow>();
  const rows = targets.results ?? [];

  return ndjsonResponse(ctx, async (emit) => {
    if (!rows.length) return { assessed: 0, errors: [], counts: await jobPipelineCounts(env) };

    // Flips them back to screened_in first (the same state a fresh screen would leave them in),
    // so assessRowsBatched's write path is identical either way and a dropped connection here
    // just means clicking the button again re-selects the same still-strong/possible rows.
    await env.DB.prepare(
      `UPDATE job_postings SET fit_status = 'screened_in' WHERE id IN (${rows.map(() => "?").join(",")})`,
    )
      .bind(...rows.map((r) => r.id))
      .run();

    const { assessed, errors } = await assessRowsBatched(
      env, provider, structured, desiredRoles, disqualifiers, dealbreakers, careAboutTopics, rows, rows.length, emit,
    );
    return { assessed, errors, counts: await jobPipelineCounts(env) };
  });
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
    interested: 0,
    applied: 0,
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

  const [companies, jobs, documents, notes, roleSignals, resumes, feedback, coverLetters, applicationAnswers, descBytes, docBytes] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM companies"),
    count("SELECT COUNT(*) AS n FROM job_postings"),
    count("SELECT COUNT(*) AS n FROM source_documents"),
    count("SELECT COUNT(*) AS n FROM candidate_evidence WHERE category = 'note'"),
    count("SELECT COUNT(*) AS n FROM candidate_evidence WHERE category = 'role_signal'"),
    count("SELECT COUNT(*) AS n FROM resumes"),
    count("SELECT COUNT(*) AS n FROM job_feedback"),
    count("SELECT COUNT(*) AS n FROM cover_letters"),
    count("SELECT COUNT(*) AS n FROM application_answers"),
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
      cover_letters: coverLetters,
      application_answers: applicationAnswers,
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
    cover_letters: "DELETE FROM cover_letters",
    application_answers: "DELETE FROM application_answers",
  };
  const sql = statements[body.collection ?? ""];
  if (!sql) return json({ error: "unknown_collection" }, 400);
  const result = await env.DB.prepare(sql).run();
  return json({ deleted: result.meta.changes ?? 0 });
}

async function storeFitResults(env: Env, results: FitResult[]): Promise<void> {
  for (const result of results) {
    const detail = { facts: result.facts };
    await env.DB.prepare(
      `UPDATE job_postings SET fit_status = ?, fit_score = ?, fit_reason = ?, fit_missing_json = ?,
       fit_detail_json = ?, assessed_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
      .bind(
        verdictForScore(result.score), result.score, result.reason,
        JSON.stringify(result.missing), JSON.stringify(detail), result.id,
      )
      .run();
  }
}

async function setJobFit(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    reason?: string;
    fit_status?: string;
    fit_score?: number | null;
    fit_reason?: string;
    fit_missing_json?: string;
    fit_detail_json?: string;
  };
  const job = await env.DB.prepare("SELECT title, company, fit_score FROM job_postings WHERE id = ?")
    .bind(id)
    .first<{ title: string; company: string; fit_score: number | null }>();
  if (!job) return json({ error: "not_found" }, 404);

  if (body.action === "restore") {
    await env.DB.prepare(
      "UPDATE job_postings SET fit_status = 'unassessed', fit_score = NULL, fit_reason = '', assessed_at = NULL WHERE id = ?",
    )
      .bind(id)
      .run();
    return json({ id, fit_status: "unassessed" });
  }

  if (body.action === "restore_snapshot") {
    // Undo for Jindr: a reject overwrites fit_score/fit_reason below, so there's nothing left in
    // the database to restore from once one happens -- the client has to hold onto its own copy of
    // the row from just before the swipe and hand it back verbatim. interested_at is explicitly
    // cleared since Jindr only ever swipes from the not-yet-interested state in the first place.
    const fitStatus = body.fit_status || "unassessed";
    await env.DB.prepare(
      `UPDATE job_postings SET fit_status = ?, fit_score = ?, fit_reason = ?, fit_missing_json = ?,
       fit_detail_json = ?, interested_at = NULL WHERE id = ?`,
    )
      .bind(
        fitStatus,
        body.fit_score ?? null,
        body.fit_reason ?? "",
        body.fit_missing_json ?? "[]",
        body.fit_detail_json ?? "{}",
        id,
      )
      .run();
    return json({ id, fit_status: fitStatus });
  }

  if (body.action === "interested") {
    // A manual override on top of whatever the AI verdict was, the same way a rejection is --
    // fit_score/fit_reason are left alone so the score/reason that made it interesting is still
    // there to see once it's sitting in the Interested tab.
    await env.DB.prepare(
      "UPDATE job_postings SET fit_status = 'interested', interested_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(id)
      .run();
    return json({ id, fit_status: "interested" });
  }

  if (body.action === "applied") {
    // Same manual-override shape as 'interested'. interested_at is deliberately left set: a job you
    // applied to was necessarily one you were interested in, and keeping the timestamp means
    // un-applying can put it back on the Interested tab in its original position.
    await env.DB.prepare(
      "UPDATE job_postings SET fit_status = 'applied', applied_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(id)
      .run();
    return json({ id, fit_status: "applied" });
  }

  if (body.action === "unapplied") {
    // Undoing an application returns the job to Interested rather than all the way to the Jobs tab.
    // Marking something applied by mistake shouldn't also discard the decision to pursue it.
    await env.DB.prepare(
      `UPDATE job_postings SET fit_status = 'interested', applied_at = NULL,
       interested_at = COALESCE(interested_at, CURRENT_TIMESTAMP) WHERE id = ?`,
    )
      .bind(id)
      .run();
    return json({ id, fit_status: "interested" });
  }

  if (body.action === "uninterested") {
    // Leaving "interested" shouldn't cost the posting its score the way a full "restore" would --
    // it goes back to whatever bucket its existing score already implies, or unassessed if it was
    // never scored, rather than always resetting to unassessed and losing that context.
    const fitStatus = job.fit_score !== null && job.fit_score !== undefined
      ? verdictForScore(job.fit_score)
      : "unassessed";
    await env.DB.prepare(
      "UPDATE job_postings SET fit_status = ?, interested_at = NULL WHERE id = ?",
    )
      .bind(fitStatus, id)
      .run();
    return json({ id, fit_status: fitStatus });
  }

  const reason = (body.reason ?? "").trim();
  // A user rejection didn't come from the scoring model, but 0 is where a confirmed non-fit
  // belongs on the same scale as a modeled score, so the score badge stays meaningful either way.
  await env.DB.prepare(
    "UPDATE job_postings SET fit_status = 'reject', fit_score = 0, fit_reason = ?, assessed_at = CURRENT_TIMESTAMP WHERE id = ?",
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

/**
 * Asks one short, conversational clarifying question about a gap between what this specific
 * job asks for and what the candidate's profile currently shows evidence of. Nothing is written
 * to the DB here -- the question is only saved (as a candidate_evidence row) once the candidate
 * actually answers it, via createJobReviewAnswer below.
 */
async function reviewJobQuestion(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const job = await env.DB.prepare("SELECT title, company, raw_description FROM job_postings WHERE id = ?")
    .bind(id)
    .first<{ title: string; company: string; raw_description: string }>();
  if (!job) return json({ error: "not_found" }, 404);

  const profile = await loadProfileForResume(env);
  if (profile instanceof Response) return profile;

  // Prior answers for this same job, so a second (or third) click asks about something new
  // rather than circling back to ground already covered.
  const prior = await env.DB.prepare(
    "SELECT claim FROM candidate_evidence WHERE job_id = ? AND category = 'job_review' ORDER BY created_at ASC",
  )
    .bind(id)
    .all<{ claim: string }>();

  const prompt = [
    "You are helping a candidate prepare to apply to a specific job. Find ONE concrete gap between",
    "what this job asks for and what their profile currently shows evidence of, then write a single",
    "short, conversational nudge that helps them fill that gap in their own words.",
    "",
    "A bare question makes people freeze on a blank page, even when they have a relevant story --",
    "they just don't immediately connect it to the ask. So don't only ask; do some of the connecting",
    "for them. Actually look through the candidate profile below for one or two SPECIFIC, REAL",
    "things -- a project, a role, an employer, a tool -- that plausibly relate to the gap, name them",
    "by name, and float them as tentative possibilities: \"maybe something like the X you did at Y?",
    "Or was it more Z?\" Give them something concrete to react to, correct, or build on, instead of",
    "an empty prompt. If nothing in the profile plausibly connects, it's fine to ask straight instead",
    "of forcing a stretch.",
    "",
    WRITING_STYLE_RULES,
    "",
    "Rules:",
    "- Only name things that actually appear in the candidate profile below. Never invent a project,",
    "  employer, or skill that isn't there -- a confident wrong guess is worse than no guess at all.",
    "- Ask about something the posting actually states or clearly implies, not a generic prompt.",
    "- Phrase it the way a sharp friend prepping you for an interview would, not a form -- e.g. \"This",
    "  role wants people-management experience -- did leading the migration team at Acme count, or",
    "  was that more of an individual push?\"",
    "- Two or three sentences: the question itself, plus the specific thing(s) you're floating. Still",
    "  no preamble or throat-clearing -- go straight into it.",
    "- If the profile already covers everything the posting asks for well, ask about whichever",
    "  detail would most strengthen an application anyway, rather than inventing a gap.",
    (prior.results ?? []).length
      ? "- Don't repeat ground already covered by these previous answers for this same job:\n" +
        prior.results.map((r) => `  - ${r.claim}`).join("\n")
      : "",
    "",
    `JOB: ${job.title} at ${job.company}`,
    `JOB DESCRIPTION:\n${job.raw_description.slice(0, 3000)}`,
    "",
    `CANDIDATE PROFILE:\n${JSON.stringify(profile.structured)}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const question = await callText(env, provider, "review.question", prompt);
    return json({ question: question.trim() });
  } catch (err) {
    return json({ error: "generation_failed", detail: friendlyMessage(err) }, 502);
  }
}

async function listJobReview(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const rows = await env.DB.prepare(
    "SELECT id, claim, created_at FROM candidate_evidence WHERE job_id = ? AND category = 'job_review' ORDER BY created_at ASC",
  )
    .bind(id)
    .all();
  return json({ entries: rows.results });
}

async function createJobReviewAnswer(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { question?: string; answer?: string };
  const answer = (body.answer ?? "").trim();
  if (!answer) return json({ error: "answer_required" }, 400);
  const question = (body.question ?? "").trim();

  const job = await env.DB.prepare("SELECT id FROM job_postings WHERE id = ?").bind(id).first();
  if (!job) return json({ error: "not_found" }, 404);

  const profileId = await getOrCreateProfileId(env);
  // Keeping the question alongside the answer makes the saved evidence self-explanatory later --
  // "Q: ... / A: ..." reads sensibly on its own, unlike a bare answer with no context.
  const claim = question ? `Q: ${question}\nA: ${answer}` : answer;
  const evidenceId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO candidate_evidence (id, profile_id, category, claim, usable_in_applications, job_id) VALUES (?, ?, 'job_review', ?, 1, ?)",
  )
    .bind(evidenceId, profileId, claim, id)
    .run();

  const rows = await env.DB.prepare(
    "SELECT id, claim, created_at FROM candidate_evidence WHERE job_id = ? AND category = 'job_review' ORDER BY created_at ASC",
  )
    .bind(id)
    .all();
  return json({ id: evidenceId, entries: rows.results }, 201);
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
    "SELECT COUNT(*) AS n FROM companies WHERE profile_id = ? AND status NOT IN ('dismissed', 'unreachable') AND last_scanned_at IS NULL",
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

/** True for a bare token that's clearly a URL/domain rather than a company name -- "acme.com" or
 * "https://acme.com", but not "3M Co." or "Dr. Squatch" (an internal period isn't at the end, or
 * isn't immediately followed by the last word). Used to attach an optional website to whichever
 * name came just before it, without requiring it on the same line. */
function looksLikeUrl(token: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(token) || /\.[a-z]{2,}(\/\S*)?$/i.test(token);
}

/**
 * Adds many companies from one pasted list -- for a candidate who already has their own list of
 * employers to target, typing them into the single-company form one at a time doesn't scale.
 * Deliberately permissive about how that list is formatted: one company per line, several on one
 * line separated by commas or semicolons, a numbered or bulleted list, or any mix, since there's no
 * reason to make someone reformat a list they already have. Splitting happens on newlines, commas,
 * and semicolons together, each token has a leading bullet/number stripped, and any token that
 * looks like a URL is attached as the website of whichever name preceded it rather than treated as
 * its own entry -- so "Acme, https://acme.com, Beta Corp" reads as two companies, not three.
 * Capped at 50 -- comfortably more than anyone pastes in one sitting, and small enough that this
 * stays a handful of fast, sequential inserts rather than needing its own progress stream.
 */
async function bulkAddCompanies(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { text?: string };

  const tokens = (body.text ?? "")
    .split(/[\n,;]+/)
    .map((token) =>
      token
        .trim()
        .replace(/^["“]|["”]$/g, "")
        .replace(/^[-*•]\s*/, "")
        .replace(/^\(?\d+[.)]\s*/, "")
        .trim(),
    )
    .filter(Boolean);

  const companies: { name: string; website: string }[] = [];
  for (const token of tokens) {
    if (looksLikeUrl(token) && companies.length && !companies[companies.length - 1].website) {
      companies[companies.length - 1].website = token;
    } else {
      companies.push({ name: token, website: "" });
    }
  }
  const capped = companies.slice(0, 50);
  if (!capped.length) return json({ error: "no_companies_found" }, 400);

  const profileId = await getOrCreateProfileId(env);
  let added = 0;
  for (const company of capped) {
    const wasAdded = await addCompanyRow(env, profileId, {
      name: company.name,
      website: company.website,
      careers_url: "",
      bio: "",
      location: "",
      why_fit: "",
      status: "reachable",
      source: "manual",
    });
    if (wasAdded) added += 1;
  }
  return json({ added, skipped: capped.length - added, total: capped.length }, 201);
}

/**
 * Proposes companies from the candidate's own profile, then checks each proposed site actually
 * resolves before trusting it. A model listing employers will occasionally invent or misremember
 * one, so nothing here is taken on faith.
 */
async function discoverCompanies(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
  const focus = (body.focus ?? "").trim();

  return ndjsonResponse(ctx, async (emit) => {
    await emit({
      type: "progress",
      stage: "propose",
      message: `Asking the model for ${count} compan${count === 1 ? "y" : "ies"}…`,
    });

    let proposals;
    try {
      proposals = await proposeCompanies(
        env,
        provider,
        JSON.stringify(structured),
        desiredRoles,
        existingNames,
        count,
        focus,
        desiredLocations,
      );
    } catch (err) {
      throw new Error(friendlyMessage(err));
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

    await emit({
      type: "progress",
      stage: "verify",
      done: 0,
      total: fresh.length,
      proposed: proposals.length,
      duplicates: proposals.length - deduped.length,
      off_target: offTarget,
    });

    let added = 0;
    let unreachable = 0;
    let checked = 0;
    // Verifying a website is one fetch with no LLM cost -- almost all wall-clock time is spent
    // waiting on the network, not CPU. Running several at once instead of one after another is
    // what turns "up to 20 sequential 8s timeouts" into a few seconds, and emitting after each one
    // settles is what gives the candidate something to actually watch happen instead of one static
    // "please wait" for the whole batch.
    await runPooled(
      fresh,
      6,
      async (proposal) => verifyWebsite(proposal.website),
      async (proposal, reachable) => {
        checked += 1;
        if (!reachable) unreachable += 1;
        const inserted = await addCompanyRow(env, profileId, {
          ...proposal,
          status: reachable ? "reachable" : "unreachable",
          source: "ai",
        });
        if (inserted) added += 1;
        await emit({
          type: "progress",
          stage: "verify",
          done: checked,
          total: fresh.length,
          company: proposal.name,
          reachable,
        });
      },
    );

    return {
      added,
      proposed: proposals.length,
      duplicates: proposals.length - deduped.length,
      off_target: offTarget,
      unreachable,
      locations: desiredLocations,
    };
  });
}

/**
 * Reads job boards for companies that need it. Each company costs several outbound requests, so
 * this works in bounded batches against a shared subrequest budget and reports what is left --
 * the dashboard just calls it again rather than risking a single oversized request.
 */
async function scanCompanies(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { limit?: number; company_id?: string; force?: boolean };
  const profileId = await getOrCreateProfileId(env);

  const profileRow = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const desiredRoles = readDesiredRoles(profileRow?.preferences_json ?? "{}");
  const locationTerms = parseLocationFilter(readDesiredLocations(profileRow?.preferences_json ?? "{}"));

  // This bounds how many candidate rows the query below considers, which is cheap -- the actual
  // cost governor is the fetch budget in the loop further down, which already stops early and
  // reports what's left regardless of how high this number goes. So "scan all N companies" can
  // just ask for all N; the budget decides how many of them a single request actually reaches.
  const limit = Math.min(Math.max(Number(body.limit) || 6, 1), 500);
  const targets = body.company_id
    ? await env.DB.prepare(
        "SELECT id, name, website, careers_url, ats_provider, ats_token FROM companies WHERE id = ? AND profile_id = ?",
      )
        .bind(body.company_id, profileId)
        .all<CompanyScanRow>()
    : await env.DB.prepare(
        // Unreachable companies are excluded from the bulk scan the same as dismissed ones --
        // their site didn't resolve at discovery time, so spending scan budget retrying them
        // automatically would just fail again. The single-company scan query above (by id, no
        // status filter) still reaches them, for a deliberate manual retry.
        //
        // A company already scanned today is excluded too by default -- its board was just read,
        // so re-reading it minutes or hours later within the same click cycle just re-pays for the
        // same listings. It becomes eligible again once the calendar day rolls over -- or
        // immediately, with `force`, for the one case that guard actively works against: after a
        // change to what gets captured from a posting (e.g. a widened description-length cap),
        // every already-scanned posting is stuck on its old, thinner text until it's re-read, and
        // the ordinary daily guard silently no-ops the very re-scan that's supposed to fix that
        // (reports "0 scanned" with no indication anything was skipped, rather than an error).
        `SELECT id, name, website, careers_url, ats_provider, ats_token
         FROM companies
         WHERE profile_id = ? AND status NOT IN ('dismissed', 'unreachable')
           AND (? OR last_scanned_at IS NULL OR date(last_scanned_at) < date('now'))
         ORDER BY last_scanned_at IS NOT NULL, last_scanned_at ASC
         LIMIT ?`,
      )
        .bind(profileId, body.force === true ? 1 : 0, limit)
        .all<CompanyScanRow>();

  const companies = targets.results ?? [];

  return ndjsonResponse(ctx, async (emit) => {
    // Raised alongside the switch to concurrent scanning below: this was originally sized for a
    // sequential loop where the real limit was how long one request could reasonably run, not how
    // many subrequests were actually safe. Reading a board is a plain fetch with no LLM cost, so a
    // higher shared cap just means a realistic company list (tens to a couple hundred) clears in
    // one click instead of needing several.
    const budget = { remaining: 150 };
    const results: { company: string; jobs: number; new_jobs: number; note: string }[] = [];
    let newListings = 0;
    let done = 0;

    // Companies don't depend on each other, and scanning one is almost entirely waiting on a fetch
    // to that company's own board plus a few DB writes -- essentially no CPU time. Running several
    // at once instead of one after another turns "minutes across multiple rounds" into one click.
    await runPooled(
      companies,
      8,
      async (company) => {
        if (budget.remaining <= 2) return null;
        // scanOneCompany already writes each company's listings to the database before returning,
        // so a company already reported here is durably saved even if others in flight never finish.
        return scanOneCompany(env, company, desiredRoles, locationTerms, budget);
      },
      async (company, outcome) => {
        if (!outcome) return;
        done += 1;
        results.push({ company: company.name, jobs: outcome.jobs, new_jobs: outcome.newJobs, note: outcome.note });
        newListings += outcome.newJobs;
        await emit({
          type: "progress",
          done,
          total: companies.length,
          company: company.name,
          new_jobs: outcome.newJobs,
        });
      },
    );

    // "Unscanned" here means "not yet scanned today", matching the query above -- a company
    // scanned yesterday isn't owed another scan until this same cycle rolls into a new day.
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM companies
       WHERE profile_id = ? AND status NOT IN ('dismissed', 'unreachable')
         AND (last_scanned_at IS NULL OR date(last_scanned_at) < date('now'))`,
    )
      .bind(profileId)
      .first<{ n: number }>();

    return { scanned: results.length, results, new_listings: newListings, unscanned: remaining?.n ?? 0 };
  });
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
    const resolved = await resolveBoard(company.website, company.careers_url, company.name, budget);
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

  // Providers whose listing endpoint carries no description need one fetch per posting to get it.
  // Run after filtering so that cost is only paid for postings that actually survived.
  await fetchMissingDescriptions(provider as AtsProvider, token, relevant, budget);

  // Scanning only collects listings. Judging them is a separate, explicitly triggered stage, so
  // a scan stays cheap and fast and can cover far more companies per request.
  let newJobs = 0;
  for (const job of relevant) {
    // Compensation, remote/onsite, hours, and travel -- exactly what the tier-2 "what do you care
    // about" facts need -- routinely sit in a "Compensation and benefits" section at the very end
    // of a real posting, well past where a tighter cap used to cut off. Matches the ceiling
    // companies.ts's own scrape already caps at (DESCRIPTION_CAP in fetchBoardJobs), so this is
    // never the bottleneck -- whatever description actually made it through scraping gets stored.
    const description = (job.description ?? "").slice(0, 8000);
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
        description,
        job.location,
        job.posted_at || null,
        provider,
        company.id,
        job.external_id,
      )
      .run();
    // relevant.length also counts postings the board already showed on a previous scan;
    // meta.changes is the only reliable signal for "actually new this time".
    if (inserted.meta.changes > 0) {
      newJobs += 1;
    } else {
      // A posting already on file (from before this cap was raised, or from any run that captured
      // less) gets backfilled with the fuller text on its next scan -- only grows, never shrinks,
      // and a no-op once a posting already has the fuller description, so repeat scans stay cheap.
      await env.DB.prepare(
        `UPDATE job_postings SET raw_description = ?
         WHERE company_id = ? AND external_id = ? AND LENGTH(raw_description) < LENGTH(?)`,
      )
        .bind(description, company.id, job.external_id, description)
        .run();
    }
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

const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function documentMediaType(file: File): string {
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  if (extension === ".doc") return "application/msword";
  if (extension === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === ".md") return "text/markdown";
  if (extension === ".txt") return "text/plain";
  if (extension === ".pdf") return "application/pdf";
  return file.type;
}

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
  const mediaType = documentMediaType(file);
  if (!DOCUMENT_TYPES.has(mediaType)) return json({ error: "unsupported_media_type" }, 415);

  const bytes = await file.arrayBuffer();
  const sha = await digestHex(bytes);

  // Uploaded to R2 before any text extraction runs, deliberately -- pdf.js (via unpdf) parses
  // through a worker and transfers the ArrayBuffer it's given rather than copying it, which
  // detaches the original buffer (byteLength becomes 0) once parsing succeeds. That used to run
  // before the R2 write and shared the exact same `bytes` buffer, so a PDF that extracted
  // cleanly would silently upload as a zero-byte object -- the write succeeded, the document
  // listed fine, and the file was simply gone the moment you tried to open it. Saving the
  // artifact first means a bug in any extraction library can degrade `extracted_text`, the
  // best-effort part, but can never again take the upload itself down with it.
  const key = `documents/${crypto.randomUUID()}`;
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: mediaType },
    customMetadata: { originalName: file.name, uploadedByDevice: auth.id },
  });

  let extractedText = "";
  if (mediaType === "text/plain" || mediaType === "text/markdown") {
    extractedText = new TextDecoder().decode(bytes);
  } else if (mediaType === "application/pdf") {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      extractedText = text;
    } catch {
      extractedText = "";
    }
  } else if (mediaType === "application/msword" || mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      const extractor = new WordExtractor();
      const document = await extractor.extract(Buffer.from(bytes));
      extractedText = document.getBody().trim();
    } catch {
      extractedText = "";
    }
  }

  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO source_documents (id, profile_id, original_name, r2_key, media_type, sha256, extracted_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, profileId, file.name, key, mediaType, sha, extractedText)
    .run();
  return json({ id, original_name: file.name, media_type: mediaType, has_text: extractedText.length > 0 }, 201);
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
  const rangeHeader = request.headers.get("range");
  const object = rangeHeader
    ? await env.FILES.get(doc.r2_key, { range: request.headers })
    : await env.FILES.get(doc.r2_key);
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

// ---------------------------------------------------------------------------
// Application answers: the ask-once-remember-forever bank
// ---------------------------------------------------------------------------

/**
 * Collapses a form question down to something that matches across employers. Every ATS words the
 * same question slightly differently ("Are you legally authorized to work in the United States?"
 * vs "Are you authorized to work in the US?"), and an exact-string key would store a near-duplicate
 * row per company and never hit on the next form.
 *
 * Deliberately crude and deterministic rather than model-driven: this runs on every field of every
 * form, and a stable, inspectable key matters more here than catching every possible rewording. The
 * matching endpoint layers a semantic pass on top for whatever this misses.
 */
export function questionKey(question: string): string {
  return String(question ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    // Filler that varies between phrasings of the same question but never changes its meaning.
    .replace(
      /\b(are|is|do|does|did|you|your|the|a|an|of|to|for|in|on|at|this|that|please|kindly|we|us|our|will|would|can|could|any|have|has|been|be|if|as|and|or|it|its|with|from|by|about|currently|legally|ever)\b/g,
      " ",
    )
    .replace(/\b(usa|u s a|united states|us|america)\b/g, "us")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

async function listApplicationAnswers(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const rows = await env.DB.prepare(
    `SELECT id, question_key, question_text, answer, answer_type, updated_at
     FROM application_answers WHERE profile_id = ? ORDER BY updated_at DESC`,
  )
    .bind(profileId)
    .all();
  return json({ answers: rows.results });
}

/**
 * Upsert by question_key, so answering the same question on a second form updates the one stored
 * row rather than accumulating duplicates that later disagree with each other.
 */
async function saveApplicationAnswer(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    question?: string;
    answer?: string;
    answer_type?: string;
  };
  const question = (body.question ?? "").trim();
  const answer = (body.answer ?? "").trim();
  if (!question || !answer) return json({ error: "question_and_answer_required" }, 400);

  const key = questionKey(question);
  if (!key) return json({ error: "question_not_recognizable" }, 400);

  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO application_answers (id, profile_id, question_key, question_text, answer, answer_type)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, question_key) DO UPDATE SET
       question_text = excluded.question_text,
       answer = excluded.answer,
       answer_type = excluded.answer_type,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(id, profileId, key, question, answer, (body.answer_type ?? "text").trim() || "text")
    .run();

  const saved = await env.DB.prepare(
    "SELECT id, question_key, question_text, answer, answer_type, updated_at FROM application_answers WHERE profile_id = ? AND question_key = ?",
  )
    .bind(profileId, key)
    .first();
  return json({ answer: saved }, 201);
}

async function deleteApplicationAnswer(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare("DELETE FROM application_answers WHERE id = ?").bind(id).run();
  return json({ deleted: (result.meta.changes ?? 0) > 0 });
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
    WRITING_STYLE_RULES,
    "",
    ...(existingStructured ? [`Current profile:\n${JSON.stringify(existingStructured)}`, ""] : []),
    "New material:",
    ...sourceParts,
  ].join("\n\n");

  try {
    const raw = await callStructured<StructuredProfile>(
      env,
      provider,
      "profile.structure",
      prompt,
      STRUCTURED_PROFILE_JSON_SCHEMA,
      "submit_structured_profile",
      2000,
    );
    const draft = mergeStructuredProfiles(existingStructured, raw);
    return json({ provider, draft_structured: draft });
  } catch (err) {
    return json({ error: "generation_failed", detail: friendlyMessage(err) }, 502);
  }
}

async function listResumes(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const rows = await env.DB.prepare(
    `SELECT id, name, instructions, template, revision, checks_json, critique, is_master, created_at
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
  /** Master mode, and/or the pre-decided evidence plan. See ComposeOptions in resume.ts. */
  options: ComposeOptions = {},
): Promise<{ doc: ResumeDoc; pdfKey: string; screenshotBase64: string; checks: ResumeCheck[] }> {
  const doc = await composeResumeDoc(env, provider, structured, desiredRoles, instructions, layout, feedback, options);
  const html = renderResumeHtml(doc, layout);
  const { pdfKey, pdfBytes, screenshotBase64 } = await renderResumeArtifacts(env, resumeId, html);
  const checks = await runAllChecks(pdfBytes, doc, structured, layout);
  return { doc, pdfKey, screenshotBase64, checks };
}

/**
 * The master archive: every role, every accomplishment, no selection pressure.
 *
 * This is the first step of the architecture the rest of the resume pipeline assumes -- capture
 * everything, then generate each tailored version by deleting from it. The point is that you cannot
 * select evidence you never wrote down, so an accomplishment missing here is one that can never
 * appear on any tailored resume no matter how well it would have fit. It is deliberately far too
 * long to send anywhere, which is why it is rendered at the 2-page cap for legibility while the
 * prompt itself is told the page budget does not apply: the PDF is a readable artifact of the
 * archive, not a document anyone submits.
 *
 * There is at most one per profile, replaced in place on regeneration, so "the archive" stays a
 * single thing rather than accumulating a pile of near-duplicates.
 */
async function buildMasterResume(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const profile = await loadProfileForResume(env);
  if (profile instanceof Response) return profile;

  const existing = await env.DB.prepare(
    "SELECT id, revision FROM resumes WHERE profile_id = ? AND is_master = 1 LIMIT 1",
  )
    .bind(profile.profileId)
    .first<{ id: string; revision: number }>();

  const resumeId = existing?.id ?? crypto.randomUUID();
  const layout = normalizeLayout({ ...defaultLayout("compact"), max_pages: 2 });

  let built;
  try {
    built = await buildResumeVersion(
      env, resumeId, provider, profile.structured, "", "", layout, "", { master: true },
    );
  } catch (err) {
    return json({ error: "generation_failed", detail: friendlyMessage(err) }, 502);
  }

  // Deliberately no design-review/page-fit pass. Those exist to make a document fit a page budget,
  // and this one has none -- running them here would start deleting exactly the evidence the
  // archive exists to preserve.
  const name = "Master archive (everything)";
  const bulletCount = (built.doc.experience ?? []).reduce((n, e) => n + (e.bullets ?? []).length, 0);

  try {
    if (existing) {
      await env.DB.prepare(
        `UPDATE resumes SET name = ?, content_json = ?, pdf_r2_key = ?, template = ?, layout_json = ?,
         checks_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
        .bind(name, JSON.stringify(built.doc), built.pdfKey, layout.template, JSON.stringify(layout), JSON.stringify(built.checks), resumeId)
        .run();
      return json({
        id: resumeId, name, revision: existing.revision + 1, checks: built.checks,
        roles: (built.doc.experience ?? []).length, bullets: bulletCount, is_master: true,
      });
    }

    await env.DB.prepare(
      `INSERT INTO resumes (id, profile_id, name, instructions, content_json, pdf_r2_key, template, layout_json, checks_json, is_master)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 1)`,
    )
      .bind(resumeId, profile.profileId, name, JSON.stringify(built.doc), built.pdfKey, layout.template, JSON.stringify(layout), JSON.stringify(built.checks))
      .run();
    return json({
      id: resumeId, name, revision: 1, checks: built.checks,
      roles: (built.doc.experience ?? []).length, bullets: bulletCount, is_master: true,
    }, 201);
  } catch (err) {
    return json({ error: "save_failed", detail: friendlyMessage(err) }, 502);
  }
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
    return json({ error: "generation_failed", detail: friendlyMessage(err) }, 502);
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
 * when given, outranks the model's opinion. Shared by the explicit "Revise this version" endpoint
 * and the automatic pass `buildJobResume` runs on every generate/regenerate before showing anything
 * to the candidate -- same review, the only difference is whether there's a human comment to weigh.
 */
async function reviseOnce(
  env: Env,
  provider: Provider,
  resumeId: string,
  doc: ResumeDoc,
  layout: LayoutSpec,
  checks: ResumeCheck[],
  structured: StructuredProfile,
  targetRoles: string,
  instructions: string,
  userComment: string,
): Promise<{
  doc: ResumeDoc;
  pdfKey: string;
  layout: LayoutSpec;
  checks: ResumeCheck[];
  critique: string;
  verdict: "good" | "needs_work";
  contentRevised: boolean;
}> {
  const current = await renderResumeArtifacts(env, resumeId, renderResumeHtml(doc, layout));
  const review = await reviewResumeDesign(env, provider, current.screenshotBase64, layout, checks, userComment);
  const nextLayout = applyLayoutAdjustments(layout, review.layout_adjustments);
  const feedback = [review.needs_content_revision ? review.content_guidance : "", userComment].filter(Boolean).join("\n");

  if (feedback) {
    const built = await buildResumeVersion(env, resumeId, provider, structured, targetRoles, instructions, nextLayout, feedback);
    return {
      doc: built.doc, pdfKey: built.pdfKey, layout: nextLayout, checks: built.checks,
      critique: review.critique, verdict: review.verdict, contentRevised: true,
    };
  }
  // Layout-only fix, or no fix at all: keep the approved wording, just re-render at the new layout.
  const html = renderResumeHtml(doc, nextLayout);
  const rendered = await renderResumeArtifacts(env, resumeId, html);
  const newChecks = await runAllChecks(rendered.pdfBytes, doc, structured, nextLayout);
  return {
    doc, pdfKey: rendered.pdfKey, layout: nextLayout, checks: newChecks,
    critique: review.critique, verdict: review.verdict, contentRevised: false,
  };
}

function pageOverflowCheck(checks: ResumeCheck[]): ResumeCheck | undefined {
  return checks.find((c) => c.id === "page_count" && c.severity !== "ok");
}

/**
 * reviseOnce's design review sometimes tightens spacing or type instead of actually cutting
 * content, so one pass can come back still over the page target -- the candidate would then have
 * to click Revise again by hand and type the same "fewer bullets" note themselves. This automates
 * exactly that: pass a userComment on every retry, since reviseOnce always rebuilds content when
 * userComment is non-empty regardless of what the vision model itself concluded. It keeps going,
 * telling it plainly to cut real content rather than shrink type further, until the deterministic
 * page-count check -- real PDF text extraction, not the model's opinion -- says it fits, or the
 * attempt budget runs out.
 */
async function reviseUntilFits(
  env: Env,
  provider: Provider,
  resumeId: string,
  doc: ResumeDoc,
  layout: LayoutSpec,
  checks: ResumeCheck[],
  structured: StructuredProfile,
  targetRoles: string,
  instructions: string,
  userComment: string,
  maxAttempts = 3,
): Promise<Awaited<ReturnType<typeof reviseOnce>>> {
  let result = await reviseOnce(env, provider, resumeId, doc, layout, checks, structured, targetRoles, instructions, userComment);
  for (let attempt = 1; attempt < maxAttempts && pageOverflowCheck(result.checks); attempt++) {
    const overflow = pageOverflowCheck(result.checks)!;
    const comment = [
      overflow.message,
      "This is a hard constraint, not a suggestion: cut actual content rather than shrinking font or spacing further.",
      "Remove the least impactful bullet from every role, drop bullets entirely from the oldest or least relevant role first, and tighten any bullet that still runs long. Do not restore anything trimmed in a previous pass.",
    ].join(" ");
    result = await reviseOnce(
      env, provider, resumeId, result.doc, result.layout, result.checks, structured, targetRoles, instructions, comment,
    );
  }
  if (pageOverflowCheck(result.checks)) {
    result.critique = [
      result.critique,
      `Still over the ${layout.max_pages}-page target after ${maxAttempts} automatic tightening passes. There may just be too much career history for the page count -- try dropping an older role, or switch to the 2-page layout.`,
    ].filter(Boolean).join(" ");
  }
  return result;
}

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
    "SELECT instructions, content_json, layout_json, checks_json, revision, job_id FROM resumes WHERE id = ? AND profile_id = ?",
  )
    .bind(id, profile.profileId)
    .first<{
      instructions: string;
      content_json: string;
      layout_json: string;
      checks_json: string;
      revision: number;
      job_id: string | null;
    }>();
  if (!row) return json({ error: "not_found" }, 404);

  const layout = normalizeLayout(JSON.parse(row.layout_json || "{}"));
  const doc = JSON.parse(row.content_json || "{}") as ResumeDoc;
  const previousChecks = JSON.parse(row.checks_json || "[]") as ResumeCheck[];

  // A job-tailored resume keeps targeting that specific posting through every revision -- without
  // this, a content rewrite triggered by feedback would recompose against the profile's general
  // desired roles instead, drifting the resume back away from the job it was tailored for. The
  // review evidence is re-fetched fresh here rather than reused from the stored row, so an answer
  // added since the last revision still reaches this one.
  let targetRoles = profile.desiredRoles;
  let evidenceInstructions = "";
  if (row.job_id) {
    const job = await env.DB.prepare("SELECT title, company, raw_description FROM job_postings WHERE id = ?")
      .bind(row.job_id)
      .first<{ title: string; company: string; raw_description: string }>();
    if (job) {
      targetRoles = `${job.title} at ${job.company}\n\n${job.raw_description.slice(0, 3000)}`;
      evidenceInstructions = jobReviewEvidenceInstructions(await loadJobReviewClaims(env, row.job_id));
    }
  }

  const composeInstructions = [row.instructions ?? "", evidenceInstructions].filter(Boolean).join("\n\n");

  try {
    const revised = await reviseUntilFits(
      env, provider, id, doc, layout, previousChecks, profile.structured, targetRoles, composeInstructions, comment,
    );

    const revision = (row.revision ?? 1) + 1;
    await env.DB.prepare(
      `UPDATE resumes SET content_json = ?, pdf_r2_key = ?, layout_json = ?, checks_json = ?, critique = ?,
       revision = ?, template = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
      .bind(
        JSON.stringify(revised.doc),
        revised.pdfKey,
        JSON.stringify(revised.layout),
        JSON.stringify(revised.checks),
        revised.critique,
        revision,
        revised.layout.template,
        id,
      )
      .run();

    return json({
      id,
      revision,
      verdict: revised.verdict,
      critique: revised.critique,
      layout: revised.layout,
      content_revised: revised.contentRevised,
      checks: revised.checks,
    });
  } catch (err) {
    return json({ error: "review_failed", detail: friendlyMessage(err) }, 502);
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

/** A name or company as a filesystem-safe token: no path separators or quotes, spaces to
 * underscores, so it drops cleanly into a Content-Disposition filename either quoted or bare. */
function safeFilenamePart(text: string): string {
  return text
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

async function getResumeFile(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const row = await env.DB.prepare(
    `SELECT r.pdf_r2_key, r.name, j.company AS job_company, p.label AS profile_label
     FROM resumes r
     LEFT JOIN job_postings j ON j.id = r.job_id
     LEFT JOIN candidate_profiles p ON p.id = r.profile_id
     WHERE r.id = ?`,
  )
    .bind(id)
    .first<{ pdf_r2_key: string | null; name: string; job_company: string | null; profile_label: string | null }>();
  if (!row?.pdf_r2_key) return json({ error: "not_found" }, 404);
  const object = await env.FILES.get(row.pdf_r2_key, { range: request.headers });
  if (!object) return json({ error: "not_found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", "application/pdf");
  // A job-tailored resume's own `name` is "<job title> @ <company>" -- fine on screen, but a poor
  // download filename (spaces, punctuation, and the title itself all just noise once you're staring
  // at a folder of PDFs trying to tell them apart). "<Candidate Name>_Resume_<Company>.pdf" is what
  // you'd actually want to see there; a general-purpose version without a job falls back to its own
  // name since there's no company to use instead.
  const namePart = safeFilenamePart(row.profile_label || "Resume");
  const targetPart = safeFilenamePart(row.job_company || row.name || "General");
  const filename = `${namePart}_Resume_${targetPart}.pdf`;
  headers.set("content-disposition", `inline; filename="${filename}"`);
  headers.set("cache-control", "private, no-store");
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (object.range && "offset" in object.range && "end" in object.range) {
    headers.set("content-range", `bytes ${object.range.offset}-${object.range.end}/${object.size}`);
  }
  const status = request.headers.get("range") !== null ? 206 : 200;
  return new Response(object.body, { headers, status });
}

const RESUME_BASE_SCHEMA = {
  type: "object",
  properties: {
    base_resume_id: {
      type: "string",
      description:
        "The id of whichever existing resume version is the closest starting point for this job, exactly as " +
        "given. Empty string if none of them are a reasonable starting point.",
    },
    tailoring_notes: {
      type: "string",
      description:
        "What should change -- reordering, re-emphasis, trimming -- to fit this specific posting, using only " +
        "what's already true. If the chosen version already fits well, say so instead of inventing a change.",
    },
  },
  required: ["base_resume_id", "tailoring_notes"],
} as const;

/**
 * Picks whichever existing general-purpose resume is the closest fit for a specific job, and asks
 * for tailoring notes rather than trying to feed prior content back into composeResumeDoc directly
 * -- composition always writes fresh from the profile (COMPOSE_RULES' anti-fabrication guarantee
 * depends on that), so "start from an existing version" means "match its style/instructions and
 * angle the same evidence toward this posting," not literally editing its saved content.
 */
async function decideResumeBase(
  env: Env,
  provider: Provider,
  job: { title: string; company: string; raw_description: string },
  candidates: { id: string; name: string; instructions: string }[],
): Promise<{ base_resume_id: string; tailoring_notes: string }> {
  const prompt = [
    "A candidate has several existing general-purpose resume versions and wants to apply to a specific job.",
    "Pick whichever existing version is the closest fit as a starting point, and say what -- if anything --",
    "should change to tailor it for this specific posting. Only reordering, re-emphasizing, or trimming what's",
    "already true is allowed; never suggest inventing anything not already in the candidate's profile.",
    "",
    // tailoring_notes is passed straight through as compose instructions, so it carries the same
    // rules; otherwise the guidance itself can reintroduce the phrasing the resume rules strip.
    WRITING_STYLE_RULES,
    "",
    `JOB: ${job.title} at ${job.company}`,
    `JOB DESCRIPTION:\n${job.raw_description.slice(0, 2000)}`,
    "",
    `EXISTING VERSIONS:\n${JSON.stringify(candidates.map((c) => ({ id: c.id, name: c.name, instructions: c.instructions })))}`,
  ].join("\n");

  const result = await callStructured<{ base_resume_id: string; tailoring_notes: string }>(
    env,
    provider,
    "resume.select_base",
    prompt,
    RESUME_BASE_SCHEMA,
    "submit_resume_base",
    1000,
  );
  return {
    base_resume_id: (result.base_resume_id ?? "").trim(),
    tailoring_notes: (result.tailoring_notes ?? "").trim(),
  };
}

async function loadJobReviewClaims(env: Env, jobId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT claim FROM candidate_evidence WHERE job_id = ? AND category = 'job_review' ORDER BY created_at ASC",
  )
    .bind(jobId)
    .all<{ claim: string }>();
  return (rows.results ?? []).map((r) => r.claim);
}

/**
 * Job-review answers are raw, informally-worded evidence -- a candidate answering a quick question
 * in the moment, not pre-written resume content. Composing must not just paste that text in as its
 * own bullet or section; it needs the same explicit "rewrite it, don't quote it" instruction as
 * anything else the writing rules cover, since a plain instruction to "use this" tends to get taken
 * literally. This is folded into the compose call's `instructions` (not the stored profile), and
 * recomputed fresh on every call rather than baked into a resume row, so a new answer added after a
 * resume already exists still reaches the very next revision.
 */
function jobReviewEvidenceInstructions(claims: string[]): string {
  if (!claims.length) return "";
  return [
    "The candidate answered follow-up questions specifically for this application; their answers are below in",
    "their own words. Treat each one as real evidence about something they actually did, available for you to",
    "draw on where it genuinely helps -- not a requirement to use all of it, and not text to copy in verbatim",
    "or as its own bullet or section. Where an answer does strengthen a specific point (it's more concrete, more",
    "quantified, or fills a real gap), rewrite it fully into the same professional resume phrasing the writing",
    "rules above already require (action + object + problem/constraint + method + result, quantified only where",
    "a number is actually given) and fold it into whichever existing experience entry it belongs to, or the",
    "summary if it doesn't fit any entry. If an answer is redundant with what the resume already says, only",
    "administrative in nature (logistics, availability, and the like rather than a skill or accomplishment), or",
    "otherwise wouldn't add anything a reader would value, leave it out rather than forcing it in somewhere.",
    "Never paste the raw answer text into the resume.",
    "",
    "CANDIDATE'S OWN WORDS FOR THIS APPLICATION:",
    ...claims.map((c) => `- ${c}`),
  ].join("\n");
}

/**
 * Generates (or, with `regenerate`, redoes) the one resume version tailored to a specific job.
 * Unlike general-purpose versions, only one exists per job -- regenerating updates that same row
 * in place (bumping its revision) rather than accumulating a history, since a job-tailored resume
 * is only ever meant to represent the current best version for that one application.
 */
/**
 * Requirements + evidence plan for one posting, reusing the cached requirements when they exist.
 *
 * A posting's stated requirements don't change between the first resume and the fourth revision, so
 * extracting them again per revision buys nothing; the plan itself is re-derived each time, since
 * that one does depend on the current profile (an answer added on the Ask tab since the last build
 * can legitimately turn an unproven requirement into a proven one).
 *
 * Returns null rather than throwing on failure. This is a refinement over composing straight from
 * the job description, which is what the app did before and still does fine -- a planner outage
 * should degrade the resume, not block the candidate from getting one at all.
 */
async function loadEvidencePlan(
  env: Env,
  provider: Provider,
  jobId: string,
  job: { title: string; company: string; raw_description: string; requirements_json?: string },
  structured: StructuredProfile,
): Promise<EvidencePlan | null> {
  try {
    let requirements: JobRequirements | null = null;
    try {
      const cached = JSON.parse(job.requirements_json || "{}") as JobRequirements;
      if (cached?.requirements?.length) requirements = cached;
    } catch {
      // Unparseable cache is the same as no cache.
    }

    if (!requirements) {
      requirements = await extractJobRequirements(env, provider, {
        title: job.title,
        company: job.company,
        description: job.raw_description ?? "",
      });
      await env.DB.prepare("UPDATE job_postings SET requirements_json = ? WHERE id = ?")
        .bind(JSON.stringify(requirements), jobId)
        .run();
    }
    if (!requirements.requirements.length) return null;

    return await planEvidence(env, provider, structured, requirements, `${job.title} at ${job.company}`);
  } catch {
    return null;
  }
}

/** Coverage report from a stored plan_json blob, or null when this version predates planning. */
function storedCoverage(planJson: string): ({ proven: number; partial: number; unproven: number; items: EvidencePlan["coverage"] }) | null {
  try {
    const plan = JSON.parse(planJson || "{}") as EvidencePlan;
    if (!plan?.coverage?.length) return null;
    return { ...coverageSummary(plan), items: plan.coverage };
  } catch {
    return null;
  }
}

async function buildJobResume(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string; regenerate?: boolean };
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const job = await env.DB.prepare(
    "SELECT title, company, raw_description, requirements_json FROM job_postings WHERE id = ?",
  )
    .bind(id)
    .first<{ title: string; company: string; raw_description: string; requirements_json: string }>();
  if (!job) return json({ error: "not_found" }, 404);

  const profile = await loadProfileForResume(env);
  if (profile instanceof Response) return profile;

  const existing = await env.DB.prepare(
    "SELECT id, name, template, revision, checks_json, plan_json FROM resumes WHERE job_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(id)
    .first<{ id: string; name: string; template: string; revision: number; checks_json: string; plan_json: string }>();

  if (existing && !body.regenerate) {
    return json({
      id: existing.id,
      name: existing.name,
      template: existing.template,
      revision: existing.revision,
      checks: JSON.parse(existing.checks_json || "[]"),
      // Read back rather than recomputed: reusing an already-built resume shouldn't spend two model
      // calls re-deriving a coverage report that was already saved with it.
      coverage: storedCoverage(existing.plan_json),
      reused: true,
    });
  }

  const candidates = await env.DB.prepare(
    "SELECT id, name, instructions, layout_json FROM resumes WHERE profile_id = ? AND job_id IS NULL ORDER BY created_at DESC LIMIT 10",
  )
    .bind(profile.profileId)
    .all<{ id: string; name: string; instructions: string; layout_json: string }>();

  const reviewClaims = await loadJobReviewClaims(env, id);

  let baseInstructions = "";
  let tailoringNotes = "";
  let baseLayout: LayoutSpec | null = null;
  if ((candidates.results ?? []).length) {
    try {
      const decision = await decideResumeBase(env, provider, job, candidates.results);
      const base = candidates.results.find((c) => c.id === decision.base_resume_id);
      if (base) {
        baseInstructions = base.instructions ?? "";
        tailoringNotes = decision.tailoring_notes;
        // Inherit the chosen version's template and page length too, not just its wording
        // preferences -- otherwise every tailored resume gets forced back to the 1-page classic
        // default regardless of what the candidate actually picked for their general versions.
        try {
          baseLayout = normalizeLayout(JSON.parse(base.layout_json || "{}"));
        } catch {
          baseLayout = null;
        }
      }
    } catch {
      // A failed base-selection call shouldn't block generation -- compose still works fine
      // from the profile and job description alone, just without a stylistic starting point.
    }
  }

  const targetRoles = `${job.title} at ${job.company}\n\n${job.raw_description.slice(0, 3000)}`;
  // Stored on the row so future revisions know this version's base/tailoring preferences; the
  // review evidence is deliberately NOT baked in here -- it's layered on fresh below so a new
  // answer added after this resume already exists still reaches the very next revision.
  const instructions = [baseInstructions, tailoringNotes].filter(Boolean).join("\n\n");
  const composeInstructions = [instructions, jobReviewEvidenceInstructions(reviewClaims)].filter(Boolean).join("\n\n");
  const layout = baseLayout ?? normalizeLayout(defaultLayout());
  const resumeId = existing?.id ?? crypto.randomUUID();

  // Triage before writing: read the posting into discrete requirements, then decide per past role
  // how much of the page it earns against them. Doing this as its own step is the whole point of
  // src/philosophy.ts -- folding "which three jobs matter here" into the same call that writes the
  // bullets is what produces beautifully-written bullets about the wrong roles.
  const plan = await loadEvidencePlan(env, provider, id, job, profile.structured);
  const planOptions: ComposeOptions = plan ? { planDirective: renderPlanDirective(plan) } : {};

  let built;
  try {
    built = await buildResumeVersion(
      env, resumeId, provider, profile.structured, targetRoles, composeInstructions, layout, "", planOptions,
    );
  } catch (err) {
    return json({ error: "generation_failed", detail: friendlyMessage(err) }, 502);
  }

  // One automatic design-review-and-revise pass before this ever reaches the candidate. This is
  // the same review "Revise this version" runs on demand, just run once up front with no human
  // comment yet, so what gets shown on a fresh generate or a regenerate is already the refined
  // version rather than a rough first draft the candidate then has to notice and fix themselves.
  let finalLayout = layout;
  let finalDoc = built.doc;
  let finalPdfKey = built.pdfKey;
  let finalChecks = built.checks;
  let critique = "";
  try {
    const revised = await reviseUntilFits(
      env, provider, resumeId, built.doc, layout, built.checks, profile.structured, targetRoles, composeInstructions, "",
    );
    finalLayout = revised.layout;
    finalDoc = revised.doc;
    finalPdfKey = revised.pdfKey;
    finalChecks = revised.checks;
    critique = revised.critique;
  } catch {
    // The first draft still stands if the automatic polish pass itself fails -- better to hand
    // back something than to fail generation over an optional refinement step.
  }

  const name = `${job.title} @ ${job.company}`.slice(0, 60);
  const planJson = JSON.stringify(plan ?? {});
  // The unproven count is the genuinely useful half of this: "here are three things this posting
  // asks for that your profile can't currently show" is an actionable prompt to go answer a
  // question on the Ask tab, which is exactly what turns an unproven requirement into a proven one.
  const coverage = plan ? { ...coverageSummary(plan), items: plan.coverage } : null;

  try {
    if (existing) {
      await env.DB.prepare(
        `UPDATE resumes SET name = ?, instructions = ?, content_json = ?, pdf_r2_key = ?, template = ?,
         layout_json = ?, checks_json = ?, critique = ?, plan_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
        .bind(name, instructions, JSON.stringify(finalDoc), finalPdfKey, finalLayout.template, JSON.stringify(finalLayout), JSON.stringify(finalChecks), critique, planJson, resumeId)
        .run();
      return json({ id: resumeId, name, template: finalLayout.template, revision: existing.revision + 1, checks: finalChecks, critique, coverage, reused: false });
    }

    await env.DB.prepare(
      `INSERT INTO resumes (id, profile_id, name, instructions, content_json, pdf_r2_key, template, layout_json, checks_json, critique, plan_json, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(resumeId, profile.profileId, name, instructions, JSON.stringify(finalDoc), finalPdfKey, finalLayout.template, JSON.stringify(finalLayout), JSON.stringify(finalChecks), critique, planJson, id)
      .run();
    return json({ id: resumeId, name, template: finalLayout.template, revision: 1, checks: finalChecks, critique, coverage, reused: false }, 201);
  } catch (err) {
    return json({ error: "save_failed", detail: friendlyMessage(err) }, 502);
  }
}

const COVER_LETTER_SCHEMA = {
  type: "object",
  properties: {
    letter_body: {
      type: "string",
      description:
        "The full cover letter, greeting through sign-off, as plain paragraphs separated by a blank line. No " +
        "markdown, no placeholder brackets like [Company Name] -- use the real company name given below.",
    },
  },
  required: ["letter_body"],
} as const;

/**
 * Composes the letter text only -- rendering to HTML is a separate, deterministic step (renderCoverLetterHtml
 * below), same content/layout split the resume pipeline uses. Contact details/résumé content, when available,
 * are given as material to draw on but nothing here is invented: same anti-fabrication framing as résumés.
 */
async function composeCoverLetter(
  env: Env,
  provider: Provider,
  profile: StructuredProfile,
  job: { title: string; company: string; raw_description: string },
  reviewAnswers: string[],
  resumeContactLine: string,
): Promise<string> {
  const prompt = [
    "Write a cover letter for this candidate applying to this specific job. Genuine and specific, not generic --",
    "reference concrete evidence from the profile that actually matches what the posting asks for. Never invent",
    "an employer, title, credential, or accomplishment not in the profile below.",
    "",
    WRITING_STYLE_RULES,
    "",
    "This letter goes to an employer, so the register is professional throughout: no casual phrasing, no",
    "gushing, no rhetorical questions, and no restating the job description back at them. Confident and",
    "direct, without overclaiming.",
    "",
    "Structure: a brief greeting, 3-4 short paragraphs (why this role/company, the strongest relevant evidence,",
    "one more concrete example, a short close), and a sign-off using the candidate's name. One page's worth of",
    "text.",
    "",
    `JOB: ${job.title} at ${job.company}`,
    `JOB DESCRIPTION:\n${job.raw_description.slice(0, 3000)}`,
    "",
    reviewAnswers.length
      ? [
          "The candidate answered follow-up questions specifically for this application, in their own words",
          "below. Treat these as real evidence available to draw on, not a requirement to use all of it and",
          "not text to quote directly -- where one genuinely strengthens the letter, weave the substance into",
          "its own voice and sentence structure rather than pasting an answer in verbatim. Skip any answer that",
          "is redundant with what the letter already says, purely administrative (logistics, availability, and",
          "the like), or otherwise wouldn't add anything a reader would value.",
          "",
          "CANDIDATE'S OWN WORDS FOR THIS APPLICATION:",
          ...reviewAnswers.map((a) => `- ${a}`),
          "",
        ].join("\n")
      : "",
    resumeContactLine ? `CONTACT LINE (for reference, do not repeat verbatim in the letter body): ${resumeContactLine}\n` : "",
    `CANDIDATE PROFILE:\n${JSON.stringify(profile)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await callStructured<{ letter_body: string }>(
    env,
    provider,
    "cover_letter.write",
    prompt,
    COVER_LETTER_SCHEMA,
    "submit_cover_letter",
    2000,
  );
  return (result.letter_body ?? "").trim();
}

/** Deterministic letterhead + body rendering -- the model only ever produces the letter text. */
function renderCoverLetterHtml(name: string, letterBody: string): string {
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const paragraphs = letterBody
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Cover letter</title><style>
body { font-family: Georgia, 'Times New Roman', serif; max-width: 680px; margin: 2rem auto; padding: 0 1.5rem; color: #1a1a1a; line-height: 1.6; }
.name { font-size: 1.3rem; font-weight: 600; margin-bottom: 0.25rem; }
.date { color: #555; margin-bottom: 1.5rem; }
p { margin: 0 0 1rem; }
</style></head>
<body>
<div class="name">${escapeHtml(name)}</div>
<div class="date">${date}</div>
${paragraphs}
</body></html>`;
}

async function getCoverLetter(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const row = await env.DB.prepare("SELECT id, content_html FROM cover_letters WHERE job_id = ?")
    .bind(id)
    .first<{ id: string; content_html: string }>();
  return json({ cover_letter: row ?? null });
}

/** One cover letter per job -- generating again replaces it, no revision history (see 0012_cover_letters.sql). */
async function buildCoverLetter(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string; regenerate?: boolean };
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const job = await env.DB.prepare("SELECT title, company, raw_description FROM job_postings WHERE id = ?")
    .bind(id)
    .first<{ title: string; company: string; raw_description: string }>();
  if (!job) return json({ error: "not_found" }, 404);

  const existing = await env.DB.prepare("SELECT id, content_html FROM cover_letters WHERE job_id = ?")
    .bind(id)
    .first<{ id: string; content_html: string }>();
  if (existing && !body.regenerate) {
    return json({ id: existing.id, content_html: existing.content_html, reused: true });
  }

  const profile = await loadProfileForResume(env);
  if (profile instanceof Response) return profile;

  const profileRow = await env.DB.prepare("SELECT label FROM candidate_profiles WHERE id = ?")
    .bind(profile.profileId)
    .first<{ label: string }>();

  const reviewAnswers = await env.DB.prepare(
    "SELECT claim FROM candidate_evidence WHERE job_id = ? AND category = 'job_review' ORDER BY created_at ASC",
  )
    .bind(id)
    .all<{ claim: string }>();

  // The job-tailored resume, if one exists, carries a real contact line -- reused here rather
  // than asking the model to invent one, same anti-fabrication principle as everything else.
  const tailoredResume = await env.DB.prepare("SELECT content_json FROM resumes WHERE job_id = ?")
    .bind(id)
    .first<{ content_json: string }>();
  let contactLine = "";
  if (tailoredResume?.content_json) {
    try {
      contactLine = (JSON.parse(tailoredResume.content_json) as ResumeDoc).contact_line ?? "";
    } catch {
      contactLine = "";
    }
  }

  let letterBody: string;
  try {
    letterBody = await composeCoverLetter(
      env,
      provider,
      profile.structured,
      job,
      (reviewAnswers.results ?? []).map((r) => r.claim),
      contactLine,
    );
  } catch (err) {
    return json({ error: "generation_failed", detail: friendlyMessage(err) }, 502);
  }

  const name = profileRow?.label || profile.structured.headline || "Candidate";
  const contentHtml = renderCoverLetterHtml(name, letterBody);

  try {
    if (existing) {
      await env.DB.prepare("UPDATE cover_letters SET content_html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(contentHtml, existing.id)
        .run();
      return json({ id: existing.id, content_html: contentHtml, reused: false });
    }

    const coverLetterId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO cover_letters (id, profile_id, job_id, content_html) VALUES (?, ?, ?, ?)",
    )
      .bind(coverLetterId, profile.profileId, id, contentHtml)
      .run();
    return json({ id: coverLetterId, content_html: contentHtml, reused: false }, 201);
  } catch (err) {
    // A save failure shouldn't surface as a raw, uncaught exception -- the letter itself composed
    // fine at this point, so a clear error here (rather than a generic Workers error page the
    // frontend can't parse as JSON) is what actually helps track down what went wrong.
    return json({ error: "save_failed", detail: friendlyMessage(err) }, 502);
  }
}

// ---------------------------------------------------------------------------
// Application autofill: turning a live form into answers
// ---------------------------------------------------------------------------

type FormField = { name: string; label: string; type?: string; required?: boolean; options?: string[] };

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The field's name, exactly as given." },
          value: { type: "string", description: "The answer to type into it." },
          answered: {
            type: "boolean",
            description:
              "false if the profile does not actually establish this. Decline rather than guessing; " +
              "a declined field is handed to the candidate to answer themselves.",
          },
        },
        required: ["name", "value", "answered"],
      },
    },
  },
  required: ["answers"],
} as const;

/**
 * Fields whose answer is a fact about the person that is legally or personally consequential, and
 * which a model must never infer. Work authorization, sponsorship, and the EEO questions have real
 * consequences if answered wrongly, and "probably yes" is not a defensible basis for any of them.
 * These skip the model entirely: either the answer bank has it, or the candidate is asked.
 */
const NEVER_INFER =
  /\b(sponsor\w*|visa|authoriz\w*|work permit|citizen\w*|veteran\w*|disab\w*|gender|sex|race|ethnic\w*|hispanic|latino|felon\w*|convict\w*|criminal|background check|salary|salaries|compensat\w*|expected pay|desired pay|notice period|start date|available to start|relocat\w*|security clearance|clearance)\b/i;

/**
 * The identity fields every form starts with. StructuredProfile has no name/email/phone of its own
 * (it models career history, not contact details), so these come from the profile label and from
 * the contact line of whichever resume was built for this job. Parsed rather than modelled: an
 * email address is either present in the candidate's own resume or it is not.
 */
type ContactFacts = { name: string; email: string; phone: string; linkedin: string; website: string };

function contactFactsFrom(label: string, contactLine: string): ContactFacts {
  const parts = String(contactLine ?? "").split("|").map((x) => x.trim());
  const find = (re: RegExp) => parts.find((x) => re.test(x)) ?? "";
  return {
    name: (label ?? "").trim(),
    email: (contactLine.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) ?? [""])[0],
    phone: (contactLine.match(/(\+?\d[\d\s().-]{7,}\d)/) ?? [""])[0].trim(),
    linkedin: find(/linkedin\.com/i),
    website: find(/^https?:\/\//i) && !/linkedin\.com/i.test(find(/^https?:\/\//i)) ? find(/^https?:\/\//i) : "",
  };
}

/** Straight lookups. No model call, because there is nothing to reason about. */
function deterministicAnswer(label: string, contact: ContactFacts): string | null {
  const l = label.toLowerCase();
  const [first, ...rest] = contact.name.split(/\s+/).filter(Boolean);
  if (/\b(first|given)\s*name\b/.test(l)) return first || null;
  if (/\b(last|family|sur)\s*name\b/.test(l)) return rest.join(" ") || null;
  if (/\b(full name|your name)\b/.test(l) || l.trim() === "name") return contact.name || null;
  if (/\be-?mail\b/.test(l)) return contact.email || null;
  if (/\b(phone|mobile|telephone)\b/.test(l)) return contact.phone || null;
  if (/\blinkedin\b/.test(l)) return contact.linkedin || null;
  if (/\b(website|portfolio|personal site)\b/.test(l)) return contact.website || null;
  return null;
}

/**
 * Turns the form the extension is looking at into a set of answers.
 *
 * Resolution order is cheapest and most trustworthy first: the saved answer bank, then a single
 * model call for whatever is left. Anything unresolved comes back as `missing` rather than guessed,
 * and the sensitive categories above never reach the model at all.
 */
async function matchApplication(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    job_id?: string;
    fields?: FormField[];
    provider?: string;
  };
  const fields = (body.fields ?? []).filter((f) => f && f.name);
  if (!fields.length) return json({ error: "fields_required" }, 400);

  const provider = normalizeProvider(body.provider);
  const profile = await loadProfileForResume(env);
  if (profile instanceof Response) return profile;

  const profileId = profile.profileId;
  const profileRow = await env.DB.prepare("SELECT label FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ label: string }>();
  const resumeRow = body.job_id
    ? await env.DB.prepare("SELECT id, content_json FROM resumes WHERE job_id = ?")
        .bind(body.job_id)
        .first<{ id: string; content_json: string }>()
    : null;
  let contactLine = "";
  if (resumeRow?.content_json) {
    try {
      contactLine = (JSON.parse(resumeRow.content_json) as ResumeDoc).contact_line ?? "";
    } catch {
      contactLine = "";
    }
  }
  const contact = contactFactsFrom(profileRow?.label ?? "", contactLine);

  const bankRows = await env.DB.prepare(
    "SELECT question_key, question_text, answer FROM application_answers WHERE profile_id = ?",
  )
    .bind(profileId)
    .all<{ question_key: string; question_text: string; answer: string }>();
  const bank = new Map((bankRows.results ?? []).map((r) => [r.question_key, r.answer]));

  const answers: { name: string; value: string; source: string }[] = [];
  const unresolved: FormField[] = [];

  for (const field of fields) {
    const label = (field.label || field.name).trim();
    const hit = bank.get(questionKey(label));
    if (hit) {
      answers.push({ name: field.name, value: hit, source: "bank" });
      continue;
    }
    const deterministic = deterministicAnswer(label, contact);
    if (deterministic) {
      answers.push({ name: field.name, value: deterministic, source: "profile" });
      continue;
    }
    unresolved.push(field);
  }

  // Sensitive fields are never sent to the model. If the bank did not already answer one, the
  // candidate answers it, full stop.
  const askable = unresolved.filter((f) => !NEVER_INFER.test(f.label || f.name));
  const sensitive = unresolved.filter((f) => NEVER_INFER.test(f.label || f.name));
  const missing: FormField[] = [...sensitive];

  if (askable.length && !providerKeyMissing(env, provider)) {
    const jobRow = body.job_id
      ? await env.DB.prepare("SELECT title, company, raw_description FROM job_postings WHERE id = ?")
          .bind(body.job_id)
          .first<{ title: string; company: string; raw_description: string }>()
      : null;
    const reviewClaims = body.job_id ? await loadJobReviewClaims(env, body.job_id) : [];

    const prompt = [
      "Fill in this job application form on the candidate's behalf, using only what their profile",
      "below actually establishes.",
      "",
      WRITING_STYLE_RULES,
      "",
      "Set answered=false for any field the profile does not genuinely support. A declined field is",
      "handed back to the candidate to answer themselves, which is the correct outcome. Never guess,",
      "never approximate, and never invent an employer, title, date, credential, or number. For a",
      "field offering fixed options, the value must be exactly one of them.",
      "",
      jobRow ? `JOB: ${jobRow.title} at ${jobRow.company}` : "",
      jobRow ? `JOB DESCRIPTION:\n${jobRow.raw_description.slice(0, 2000)}` : "",
      reviewClaims.length ? `CONTEXT THE CANDIDATE GAVE FOR THIS APPLICATION:\n${reviewClaims.map((c) => `- ${c}`).join("\n")}` : "",
      "",
      `CANDIDATE PROFILE:\n${JSON.stringify(profile.structured)}`,
      "",
      `FIELDS:\n${JSON.stringify(askable.map((f) => ({ name: f.name, label: f.label, type: f.type, options: f.options })))}`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const result = await callStructured<{ answers: { name: string; value: string; answered: boolean }[] }>(
        env,
        provider,
        "application.answers",
        prompt,
        MATCH_SCHEMA,
        "submit_application_answers",
        3000,
      );
      const byName = new Map((result.answers ?? []).map((a) => [a.name, a]));
      for (const field of askable) {
        const got = byName.get(field.name);
        if (got && got.answered && (got.value ?? "").trim()) {
          answers.push({ name: field.name, value: got.value.trim(), source: "generated" });
        } else {
          missing.push(field);
        }
      }
    } catch {
      // A failed model call must not silently drop fields; they all become the candidate's to fill.
      missing.push(...askable);
    }
  } else {
    missing.push(...askable);
  }

  const letter = body.job_id
    ? await env.DB.prepare("SELECT content_html FROM cover_letters WHERE job_id = ?")
        .bind(body.job_id)
        .first<{ content_html: string }>()
    : null;

  return json({
    answers,
    missing: missing.map((f) => ({ name: f.name, label: f.label, type: f.type ?? "text", options: f.options ?? [] })),
    resume_url: resumeRow ? `/resumes/${resumeRow.id}/file` : null,
    cover_letter_text: letter ? stripHtmlToText(letter.content_html) : null,
  });
}

/** The stored cover letter is HTML; a form textarea needs the plain text back out of it. */
function stripHtmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<\s*(br|\/p|\/div|\/h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  /* Eleven tabs never fit on a phone, and a hard-cropped label at the edge looks like the end of
     the list rather than the middle of it. The scrollbar is hidden, so without a fade there is no
     cue at all that the row continues.
     Each side fades only when there is actually something that way -- a symmetric always-on mask
     washes out the first tab when you are already at the start (and the last at the end), which
     makes the active pill look clipped rather than scrollable. The listener is passive and only
     toggles two classes, so it costs nothing per frame. */
  nav.can-scroll-left {
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 20px);
    mask-image: linear-gradient(to right, transparent 0, #000 20px);
  }
  nav.can-scroll-right {
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent 100%);
    mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent 100%);
  }
  nav.can-scroll-left.can-scroll-right {
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 20px, #000 calc(100% - 20px), transparent 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 20px, #000 calc(100% - 20px), transparent 100%);
  }
  nav button {
    flex: none; margin: 0; padding: 0.45rem 0.95rem; font-size: 0.875rem; font-weight: 600;
    background: none; border: none; border-radius: 999px; color: var(--text-muted); cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }
  nav button:hover { color: var(--text); }
  nav button.active { background: var(--accent); color: var(--accent-contrast); }
  .panel { display: none; }
  .panel.active { display: block; }
  /* Same look as nav/.panel, namespaced separately so the sub-tab buttons never get picked up by
     the top-level 'nav .tab' click handler that switches main panels. */
  .subnav {
    display: flex; gap: 0.2rem; overflow-x: auto; padding: 0.25rem; margin-bottom: 1.1rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 999px; width: fit-content;
    -webkit-overflow-scrolling: touch;
  }
  .subnav button {
    flex: none; margin: 0; padding: 0.45rem 0.95rem; font-size: 0.85rem; font-weight: 600;
    background: none; border: none; border-radius: 999px; color: var(--text-muted); cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .subnav button:hover { color: var(--text); }
  .subnav button.active { background: var(--accent); color: var(--accent-contrast); }
  .subpanel { display: none; }
  .subpanel.active { display: block; }
  .role-analysis-roles { display: flex; flex-direction: column; gap: 0.7rem; margin-top: 0.6rem; }
  .role-analysis-role {
    padding: 0.7rem 0.9rem; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .role-analysis-role strong { display: block; margin-bottom: 0.25rem; font-size: 0.92rem; }
  .role-analysis-role p { margin: 0; font-size: 0.85rem; color: var(--text-muted); line-height: 1.45; }
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
  /* A step above .danger, and deliberately rare. Most "Remove" buttons drop one row you could add
     back in seconds, so they stay quiet and only redden on hover. These two -- resetting a whole
     pipeline stage, deleting an entire collection -- can throw away hours of scanning, and a
     confirm() dialog that only appears after the click is too late to be the first warning. Same
     red-outline vocabulary Jindr's "Not for me" already established, so it reads as a known shape
     rather than a new one. */
  .row-actions button.destructive {
    border-color: var(--error); color: var(--error);
  }
  .row-actions button.destructive:hover:not(:disabled) {
    background: var(--error-soft); color: var(--error); border-color: var(--error);
  }
  /* Control clusters: small inputs sized to their content instead of stretching full width. */
  .controls { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: flex-end; margin-bottom: 0.4rem; }
  .controls > div { display: flex; flex-direction: column; }
  .controls label { margin-top: 0; }
  .controls select, .controls input { width: auto; min-width: 9rem; }
  .controls button { margin-top: 0; }
  /* Sub-tab row (Ask/Resume/Cover/Apply): stays one line by scrolling horizontally instead of
     wrapping to a second row, the same pattern the top-level nav bar already uses for the same
     reason -- a button that wraps alone onto its own line reads as broken, not as a real tab. */
  .subtabs {
    display: flex; flex-wrap: nowrap; gap: 0.5rem; overflow-x: auto; padding-bottom: 0.2rem;
    margin-bottom: 0.9rem; -webkit-overflow-scrolling: touch; scrollbar-width: none;
  }
  .subtabs::-webkit-scrollbar { display: none; }
  .subtabs button { flex: none; margin-top: 0; white-space: nowrap; }
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
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  /* Pipeline flow diagram (Search tab) -- shows where scanned postings currently sit: not yet
     screened, screened out, awaiting the detailed pass, ruled out on fit, or recommended. Node
     heights and ribbon thickness are real counts from jobPipelineCounts, eased smoothly toward
     whatever the current numbers are on every animation frame -- an initial load and a live
     per-batch update during Scan/Find my matches both just change the target, so the diagram
     visibly moves instead of only ever replacing a static number. Not-interested/Interested/
     Applied aren't shown here -- this page is about finding matches, not the review funnel after. */
  #jobs-pipeline { margin: 0.6rem 0 1rem; }
  #jobs-pipeline svg { display: block; width: 100%; height: auto; overflow: visible; }
  .pf-stage-title { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; fill: var(--text-muted); text-transform: uppercase; }
  .pf-node-rect { stroke-width: 1.4; }
  .pf-node-label { font-size: 12px; font-weight: 600; fill: var(--text); }
  .pf-node-count { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; font-weight: 700; }
  .pf-node-pct { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 10px; fill: var(--text-muted); }
  /* fill and fill-opacity are set per-edge in JS (by flow kind); nothing to fix here. */
  .pf-dot { filter: drop-shadow(0 0 2px rgba(0,0,0,0.25)); }
  @media (prefers-reduced-motion: reduce) { .pf-dot { display: none; } }
  .pf-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12.5px; color: var(--text-muted); margin-top: 0.4rem; }
  .pf-legend-item { display: flex; align-items: center; gap: 6px; }
  .pf-swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .pf-progress-track { margin-top: 0.6rem; height: 3px; border-radius: 3px; background: var(--border); overflow: hidden; }
  .pf-progress-fill { height: 100%; width: 0%; background: var(--accent); transition: width 0.4s ease; }
  .pf-stat-row {
    display: flex; flex-wrap: wrap; gap: 20px; margin-top: 0.5rem; font-size: 12px; color: var(--text-muted);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  .pf-stat-row b { color: var(--text); font-weight: 700; }
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
  /* One-at-a-time review card. touch-action:pan-y leaves vertical scroll to the browser and hands
     horizontal movement to the drag handler; select:none stops a fast swipe from also highlighting
     the card's text on desktop. */
  /* Jindr is the one screen built around a single decision, so it gets to look like one instead of
     like a Jobs row that happens to be alone on the page. Capping the section and centring it
     stops the card stranding itself in the top-left corner of a wide window; the extra padding and
     larger type inside are what make it read as "look at this one thing" rather than "here is a
     list of length one". */
  #jindr-section { max-width: 34rem; margin-inline: auto; }
  .jindr-card {
    border: 1px solid var(--border); border-radius: var(--radius); padding: 1.6rem 1.5rem;
    background: var(--surface-2); touch-action: pan-y; user-select: none; cursor: grab;
  }
  .jindr-card .row-title { font-size: 1.25rem; line-height: 1.3; }
  .jindr-card .row-title-line { gap: 0.55rem; margin-bottom: 0.15rem; }
  .jindr-card .job-reason { font-size: 0.95rem; margin-top: 0.7rem; }
  .jindr-card.dragging { cursor: grabbing; transition: none; }
  .jindr-facts, .row-facts { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.6rem 0; }
  .row-facts { margin: 0.3rem 0 0; }
  /* Label above value, not squeezed onto one line -- a long value (e.g. a full remote/onsite
     policy sentence) used to force a single-line badge past the edge of the card/screen instead
     of wrapping. min-width:0 lets the value actually wrap inside a flex-wrap parent. */
  .fact-chip {
    display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; max-width: 100%;
    font-size: 0.78rem; padding: 0.3rem 0.55rem; border-radius: 0.5rem;
    background: var(--surface-2); border: 1px solid var(--border);
  }
  .fact-chip .fact-label {
    font-size: 0.62rem; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
    color: var(--text-muted);
  }
  .fact-chip .fact-value { color: var(--text); word-break: break-word; }
  .jindr-actions { display: flex; gap: 0.75rem; margin-top: 1.1rem; }
  .jindr-actions button { flex: 1; font-size: 0.95rem; padding: 0.75rem; margin-top: 0; }
  .jindr-actions button.danger {
    background: var(--surface); border: 1px solid var(--error); color: var(--error);
  }
  .jindr-actions button.danger:hover:not(:disabled) { background: var(--error-soft); opacity: 1; }
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
  /* The badge carries the tier the scorer already decided, so the three tiers get three colors.
     Green = a strong match (70+). Amber = either a genuine stretch worth a look (possible, 40-69)
     or a posting not filtered yet -- both mean "read this before trusting it", which is why they
     share a color. Red = ruled out. Flattening possible into the green tier was the bug here: a
     55% and a 92% looked equally settled, when the scoring prompt explicitly calls 40-69 "a
     genuine stretch or a posting too vague to be sure". */
  .badge.jobs, .badge.strong { background: var(--success-soft); color: var(--success); }
  .badge.warn { background: var(--error-soft); color: var(--error); }
  .badge.possible, .badge.queued { background: var(--warning-soft); color: var(--warning); }
  .row-title-line { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
  .company-bio { font-size: 0.85rem; margin: 0.35rem 0 0; line-height: 1.5; }
  .company-why { font-size: 0.82rem; color: var(--text-muted); margin: 0.3rem 0 0; padding-left: 0.55rem; border-left: 2px solid var(--border-strong); }
  .location-list { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .location-chip {
    font-size: 0.8rem; padding: 0.2rem 0.5rem; border: 1px solid var(--border);
    border-radius: 999px; background: transparent; color: inherit; cursor: pointer;
  }
  .text-link {
    font: inherit; padding: 0; margin: 0; border: none; background: none; color: var(--accent);
    text-decoration: underline; cursor: pointer;
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

  /* Touch targets.
     The controls in this file were sized for a mouse pointer, which is a few pixels wide. A
     fingertip is not: Apple's HIG puts the minimum at 44x44pt, and on an iPhone this app was
     shipping row actions at 27px, the notes disclosure at 20px, and primary buttons at 36px. That
     is the difference between tapping "Remove" and tapping the row above it.
     Gated on pointer:coarse so it applies where a finger is the primary input and leaves the
     deliberately dense desktop layout alone -- this is not a phone-width breakpoint, because an
     iPad in landscape is wide and still touched, while a narrow desktop window is neither.
     min-height, not height, so anything already taller (a textarea, a button whose label wrapped)
     keeps the size it worked out for itself. */
  @media (pointer: coarse) {
    button,
    select,
    input:not([type="checkbox"]):not([type="radio"]),
    summary {
      min-height: 44px;
    }
    /* Row actions are the worst offenders (27px) and the most likely to be mis-tapped, since they
       sit inches from a link that navigates away. Widened as well as heightened -- a 44px-tall
       target 40px wide is still a sliver. */
    .row-actions button { min-height: 44px; padding-inline: 0.9rem; }
    /* The tab bar is the primary navigation on a phone; it was ~34px. */
    nav button, .subtabs button { min-height: 44px; }
    /* A summary is a flex row so min-height actually centres its text instead of top-aligning it. */
    summary { display: flex; align-items: center; }
    /* The box itself stays visually small; the label around it is the real target, so that is what
       gets the height. :has() is ignored on anything too old to support it, which degrades to
       today's behaviour rather than breaking. */
    input[type="checkbox"], input[type="radio"] { min-width: 20px; min-height: 20px; }
    label:has(> input[type="checkbox"]), label:has(> input[type="radio"]) {
      min-height: 44px; display: flex; align-items: center; gap: 0.5rem;
    }
  }
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
    <button class="tab active" data-tab="roles" type="button">Roles</button>
    <button class="tab" data-tab="resume" type="button">Resume</button>
    <button class="tab" data-tab="companies" type="button">Companies</button>
    <button class="tab" data-tab="search" type="button">Search</button>
    <button class="tab" data-tab="jobs" type="button">Jobs</button>
    <button class="tab" data-tab="jindr" type="button">Jindr</button>
    <button class="tab" data-tab="interested" type="button">Interested</button>
    <button class="tab" data-tab="applied" type="button">Applied</button>
    <button class="tab" data-tab="devices" type="button">Devices</button>
    <button class="tab" data-tab="data" type="button">Database</button>
  </nav>

  <div id="panel-roles" class="panel active">
    <div class="subnav">
      <button class="subtab active" data-subtab="notes" type="button">Notes</button>
      <button class="subtab" data-subtab="locations" type="button">Locations</button>
      <button class="subtab" data-subtab="dealbreakers" type="button">Dealbreakers</button>
      <button class="subtab" data-subtab="criteria" type="button">Criteria</button>
      <button class="subtab" data-subtab="analysis" type="button">Analysis</button>
    </div>

    <div id="subpanel-notes" class="subpanel active">
      <section id="role-signals-section">
        <h2>What are you looking for?</h2>
        <p class="hint">Paste job links, or write loosely about what you want next. The more you add, the better the analysis on the Analysis tab.</p>
        <details id="role-signals-details" class="disclosure">
          <summary id="role-signals-summary">Notes on file</summary>
          <div id="role-signals-list"><p class="empty">Loading…</p></div>
        </details>
        <form id="role-signal-form">
          <label for="role-signal-text">Add a note or link</label>
          <textarea id="role-signal-text" required placeholder="e.g. a link to a posting, or 'I want senior IC roles in applied AI, remote-friendly, not pure infra'"></textarea>
          <button type="submit">Add</button>
        </form>
        <p id="role-signal-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>

    <div id="subpanel-locations" class="subpanel">
      <section id="locations-section">
        <h2>Locations you'll work in</h2>
        <p class="hint">Enforced as a hard filter: company discovery won't add employers outside these, and board scans skip postings elsewhere. Leave blank for no location limit.</p>
        <label for="desired-locations">Locations</label>
        <input id="desired-locations" placeholder="e.g. California, or Bay Area, Seattle, Remote">
        <button id="locations-save-button" type="button">Save</button>
        <p id="locations-save-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>

    <div id="subpanel-dealbreakers" class="subpanel">
      <section id="dealbreakers-section">
        <h2>Dealbreakers</h2>
        <p class="hint">Enforced during scoring (the detailed pass on postings that survive the quick screen) as a binding rule, the same weight as a stated hard requirement -- write down whatever you don't want to see, in your own words.</p>
        <label for="dealbreakers">Dealbreakers (optional)</label>
        <textarea id="dealbreakers" placeholder="e.g. Reject anything requiring 5+ years of experience for a technical role. 3-4 years is fine."></textarea>
        <button id="dealbreakers-save-button" type="button">Save</button>
        <p id="dealbreakers-save-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>

    <div id="subpanel-criteria" class="subpanel">
      <section id="criteria-section">
        <h2>Criteria</h2>
        <p class="hint">What do you care about? Write it however you'd say it out loud -- saving reads what you meant and turns it into the fact columns below, so you don't have to phrase it as labels. These are the topics you want at a glance for every posting, not targets to filter on (Dealbreakers is where you rule things out), and they never affect the score.</p>
        <label for="care-about">What do you care about? (optional)</label>
        <textarea id="care-about" placeholder="e.g. Salary, years of experience required, remote or in office, typical hours"></textarea>
        <div id="care-about-topics" class="row-facts"></div>
        <button id="criteria-save-button" type="button">Save</button>
        <p id="criteria-save-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>

    <div id="subpanel-analysis" class="subpanel">
      <section id="role-analysis-section">
        <h2>Analysis</h2>
        <p class="hint">What the model thinks you're suited for, based on your notes, your profile, and the Locations/Dealbreakers/Criteria tabs. This is what filters which postings you even see. Editing the other tabs and switching away reanalyzes automatically; use Reanalyze to force a fresh pass right now.</p>
        <label for="role-analysis-provider">Analyze using</label>
        <select id="role-analysis-provider">
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
        </select>
        <button id="role-analysis-button" class="secondary" type="button">Reanalyze</button>
        <p id="role-analysis-status" class="status" role="status" aria-live="polite"></p>
        <div id="role-analysis-view"><p class="empty">Not analyzed yet -- click Reanalyze, or add a note on the Notes tab and switch tabs.</p></div>
        <h3 class="subhead">Already have matches?</h3>
        <p class="hint">Re-score your existing top matches against the current analysis, without re-running the whole pipeline from scratch.</p>
        <div class="controls">
          <div>
            <label for="reassess-min-score">Minimum score to re-check</label>
            <input id="reassess-min-score" type="number" min="0" max="100" value="70">
          </div>
          <button id="reassess-button" type="button">Re-check my top matches</button>
        </div>
        <p id="reassess-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>
  </div>

  <div id="panel-resume" class="panel">
    <div class="subnav" aria-label="Resume sections">
      <button class="active" data-resume-subtab="documents" type="button">Documents</button>
      <button data-resume-subtab="notes" type="button">Notes</button>
      <button data-resume-subtab="master" type="button">Master</button>
      <button data-resume-subtab="versions" type="button">Resumes</button>
    </div>

    <div id="resume-subpanel-documents" class="subpanel active">
      <section id="material-section">
        <h2>Documents</h2>
        <p class="hint">Upload resumes, cover letters, or other career material. PDF, Word (.doc and .docx), plain text, and Markdown are supported.</p>
        <div id="documents-list"><p class="empty">Loading…</p></div>
        <form id="document-form">
          <label for="document-file">Choose a document</label>
          <input id="document-file" type="file" accept=".pdf,.doc,.docx,.txt,.md,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" required>
          <button type="submit">Upload</button>
        </form>
        <p id="document-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>

    <div id="resume-subpanel-notes" class="subpanel">
      <section id="notes-section">
        <h2>Notes</h2>
        <p class="hint">Paste a complete resume, or add accomplishments, updates, context, and experience that may not appear in your formal documents.</p>
        <div id="notes-list"><p class="empty">Loading…</p></div>
        <form id="note-form">
          <label for="note-text">Paste resume text or add a note</label>
          <textarea id="note-text" required style="min-height:14rem" placeholder="Paste plain-text resume content, or write anything the master resume should know about…"></textarea>
          <button type="submit">Add</button>
        </form>
        <p id="note-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>

    <div id="resume-subpanel-master" class="subpanel">
      <div class="split">
        <div>
        <section id="resume-master-section">
          <h2>Master resume</h2>
          <p class="hint">Builds a structured profile from all Documents and Notes, then creates one deliberately oversized resume containing everything. This is the source for future tailored versions, not a document to submit.</p>
          <label for="resume-provider">Build using</label>
          <select id="resume-provider">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
          <button id="resume-master-button" type="button">Build or update master</button>
          <p id="resume-master-status" class="status" role="status" aria-live="polite"></p>
        </section>
        <section id="master-profile-section">
          <h2>Structured source</h2>
          <p class="hint">Generated automatically as part of the master build and used by matching and tailored resumes.</p>
          <div id="resume-profile-view"><p class="empty">Build the master resume to create this source.</p></div>
        </section>
        </div>
        <section id="master-preview-section" style="display:none">
          <h2>Master preview</h2>
          <iframe id="master-preview-frame" style="width:100%; min-height:75vh; border:1px solid var(--border); border-radius:0.5rem;"></iframe>
          <div id="master-checks"></div>
        </section>
      </div>
    </div>

    <div id="resume-subpanel-versions" class="subpanel">
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

            <h3 class="subhead">Already have a list? Add several at once</h3>
            <label for="company-bulk-text">Names separated by commas, semicolons, or line breaks -- paste it however you already have it. A website right after a name attaches to it.</label>
            <textarea id="company-bulk-text" rows="6" placeholder="Acme Robotics, Another Company, A Third One, https://third.example"></textarea>
            <button id="company-bulk-button" type="button">Add up to 50</button>
            <p id="company-bulk-status" class="status" role="status" aria-live="polite"></p>
          </details>
        </section>
      </div>
      <div>
        <section id="companies-list-section">
          <label for="companies-filter">Filter</label>
          <input id="companies-filter" placeholder="Search by name, location, or description">
          <label class="checkbox-label">
            <input id="companies-show-unscannable" type="checkbox"><span id="companies-unscannable-count">Show companies that can't be scanned</span>
          </label>
          <div id="companies-list"><p class="empty">Loading…</p></div>
        </section>
      </div>
    </div>
  </div>

  <div id="panel-search" class="panel">
    <section id="jobs-scan-section">
      <h2>1. Scan for new listings</h2>
      <p class="hint">Reads the job boards of companies on your list. Each company costs a few requests, so however many you ask for, a single request only gets through as many as safely fit at once — picking "All" re-fires automatically until every company is covered, so you don't have to click through it by hand. A company already scanned today is skipped until tomorrow.</p>
      <p id="jobs-scan-summary" class="summary-line">Loading…</p>
      <div class="controls">
        <div>
          <label for="jobs-scan-count">Companies to scan</label>
          <select id="jobs-scan-count">
            <option value="1">1</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="500" selected>All</option>
          </select>
        </div>
        <button id="jobs-scan-button" type="button">Scan company boards</button>
      </div>
      <label><input id="jobs-scan-force" type="checkbox"> Re-scan companies already read today too</label>
      <p class="hint">Off by default to avoid re-paying for boards you just read. Turn this on for a one-off re-read of everything right now — for example right after a fix widens what gets captured from a posting, so already-scanned postings pick up the fuller text instead of waiting until tomorrow's normal scan.</p>
      <p id="jobs-scan-status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section id="jobs-filter-section">
      <h2>2. Filter for your best matches</h2>
      <p class="hint">Screens new listings against your profile in two passes — a quick check, then a closer look at anything that survives it — so you only spend real attention on postings worth reading.</p>
      <p id="jobs-pipeline-summary" class="sr-only" aria-live="polite"></p>
      <div id="jobs-pipeline" aria-hidden="true">
        <svg id="pf-svg" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="pf-legend">
          <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--text-muted)"></span>Scanned / passed screening</span>
          <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--warning)"></span>Waiting</span>
          <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--error)"></span>Dropped</span>
          <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--success)"></span>Recommended</span>
        </div>
        <div class="pf-progress-track"><div class="pf-progress-fill" id="pfProgressFill"></div></div>
        <div class="pf-stat-row">
          <span>Scanned: <b id="pfStatScanned">0</b></span>
          <span>Recommended: <b id="pfStatRecommended">0</b></span>
          <span>Screen accept rate: <b id="pfStatScreenRate">—</b></span>
          <span>Fully processed: <b id="pfStatProcessed">0%</b></span>
        </div>
      </div>
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
  </div>

  <div id="panel-jobs" class="panel">
    <section id="jobs-section">
      <h2>Job postings</h2>
      <label for="jobs-filter">Filter</label>
      <input id="jobs-filter" placeholder="Search by title, company, or location">
      <div class="controls">
        <div>
          <label for="jobs-age">Posted</label>
          <select id="jobs-age">
            <option value="">Any time</option>
            <option value="1">Last 24 hours</option>
            <option value="3">Last 3 days</option>
          </select>
        </div>
        <div>
          <label for="jobs-min-score">Minimum score</label>
          <select id="jobs-min-score">
            <option value="">Any score</option>
            <option value="50">50%+</option>
            <option value="60">60%+</option>
            <option value="70">70%+</option>
            <option value="80">80%+</option>
            <option value="90">90%+</option>
            <option value="100">100%</option>
          </select>
        </div>
        <div>
          <label for="jobs-sort">Sort by</label>
          <select id="jobs-sort">
            <option value="score">Best match</option>
            <option value="processed">Recently processed</option>
            <option value="posted">Recently posted</option>
          </select>
        </div>
      </div>
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

  <div id="panel-jindr" class="panel">
    <section id="jindr-section">
      <h2>Jindr</h2>
      <p class="hint">One posting at a time, best match first. Judge it and move on -- the same Interested/Not-for-me decision the Jobs tab makes, just without the scrolling.</p>
      <p id="jindr-progress" class="summary-line"></p>
      <div id="jindr-empty" class="empty" style="display:none">All caught up -- nothing left to review. New matches will show up here after your next "Find my matches" pass.</div>
      <div id="jindr-card" class="jindr-card" style="display:none">
        <div class="row-title-line">
          <a id="jindr-title" class="row-title" target="_blank" rel="noopener"></a>
          <span id="jindr-score" class="badge strong"></span>
        </div>
        <div id="jindr-meta" class="row-meta"></div>
        <div id="jindr-facts" class="jindr-facts"></div>
        <p id="jindr-reason" class="job-reason"></p>
        <div id="jindr-missing"></div>
        <div class="jindr-actions">
          <button id="jindr-reject" class="danger" type="button">✕ Not for me</button>
          <button id="jindr-interested" type="button">♥ Interested</button>
        </div>
      </div>
      <button id="jindr-undo" class="secondary" type="button" style="display:none">Undo</button>
      <p id="jindr-status" class="status" role="status" aria-live="polite"></p>
    </section>
  </div>

  <div id="panel-interested" class="panel">
    <section id="interested-list-section">
      <h2>Interested jobs</h2>
      <p class="hint">Jobs you've marked "Interested" on the Jobs tab. Click one to open its workspace — the posting link, an assistant that asks what your profile is still missing for it, a resume tailored to this posting, and a matching cover letter.</p>
      <div id="interested-list"><p class="empty">Loading…</p></div>
    </section>

    <section id="interested-detail-section" style="display:none">
      <h2 id="interested-detail-title"></h2>
      <p id="interested-detail-meta" class="row-meta"></p>
      <p id="interested-detail-reason" class="job-reason"></p>
      <a id="interested-detail-link" class="row-title" target="_blank" rel="noopener">Open posting</a>

      <!-- Assistant/Resume/Cover letter/Apply are sub-tabs, not stacked sections -- only one shows
           at a time, the same way the top-level dashboard tabs work, so opening one doesn't leave
           the others piled up underneath with no way to get back to just looking at one thing. -->
      <div class="subtabs">
        <button id="interested-subtab-assistant" type="button">Ask</button>
        <button id="interested-subtab-resume" class="secondary" type="button">Resume</button>
        <button id="interested-subtab-cover" class="secondary" type="button">Cover</button>
        <button id="interested-subtab-apply" class="secondary" type="button">Apply</button>
      </div>

      <div id="interested-assistant-panel">
        <p id="interested-review-status" class="status" role="status" aria-live="polite"></p>
        <button id="interested-review-button" type="button">Ask a question</button>
        <div id="interested-review-section" style="display:none">
          <p id="interested-review-question" class="job-reason"></p>
          <textarea id="interested-review-answer" placeholder="Answer in your own words — this gets added to your profile evidence for this job."></textarea>
          <button id="interested-review-submit" type="button">Submit answer</button>
        </div>
        <div id="interested-review-history"></div>
      </div>

      <div id="interested-resume-panel" style="display:none">
        <p id="interested-resume-status" class="status" role="status" aria-live="polite"></p>
        <button id="interested-resume-button" type="button">Generate tailored resume</button>
        <div id="interested-resume-section" style="display:none">
          <p class="hint">On some phones the preview below can't scroll or show a page break — if that happens, use the link to open the actual PDF instead.</p>
          <a id="interested-resume-open-link" class="row-title" target="_blank" rel="noopener">Open full PDF in a new tab</a>
          <iframe id="interested-resume-frame" style="width:100%; min-height:70vh; border:1px solid var(--border); border-radius:0.5rem;"></iframe>
          <div id="interested-resume-coverage" style="display:none"></div>
          <div id="interested-resume-checks"></div>
          <p id="interested-resume-critique" class="critique" style="display:none"></p>
          <textarea id="interested-resume-comment" placeholder="Optional — steer the revision, e.g. tighten the second bullet, or point out what still doesn't fit"></textarea>
          <button id="interested-resume-revise" class="secondary" type="button">Revise this version</button>
        </div>
      </div>

      <div id="interested-cover-panel" style="display:none">
        <p id="interested-cover-status" class="status" role="status" aria-live="polite"></p>
        <button id="interested-cover-button" type="button">Draft cover letter</button>
        <div id="interested-cover-section" style="display:none">
          <iframe id="interested-cover-frame" style="width:100%; min-height:60vh; border:1px solid var(--border); border-radius:0.5rem;"></iframe>
          <button id="interested-cover-regenerate" class="secondary" type="button">Regenerate for this job</button>
        </div>
      </div>

      <div id="interested-apply-panel" style="display:none">
        <p class="hint">What's ready for this application. Autofill arrives with the browser extension; for now, open the posting, use the resume and cover letter above, then mark it applied to move it to the Applied tab.</p>
        <div id="interested-apply-readiness"></div>
        <p id="interested-apply-status" class="status" role="status" aria-live="polite"></p>
        <button id="interested-apply-mark" type="button">Mark as applied</button>
      </div>
    </section>
  </div>

  <div id="panel-applied" class="panel">
    <section id="applied-section">
      <h2>Applied</h2>
      <p class="hint">Jobs you've applied to, most recent first. Everything generated for each one stays available.</p>
      <p id="applied-summary" class="summary-line"></p>
      <div id="applied-list"><p class="empty">Loading…</p></div>
    </section>
  </div>

  <div id="panel-devices" class="panel">
    <section id="devices-section">
      <h2>Devices</h2>
      <div id="devices-list"><p class="empty">Loading…</p></div>
    </section>
  </div>

  <div id="panel-data" class="panel">
    <section id="runtime-mode-section">
      <h2>Where ApplyGo runs</h2>
      <p class="hint">Local is the default: your database, files, and browser work stay on this computer. Cloudflare is optional and adds access from your phone through infrastructure you own.</p>
      <div class="row-item">
        <div class="row">
          <div>
            <div class="row-title">Local computer</div>
            <div class="row-meta">Default · no Cloudflare account · available while this computer is running</div>
          </div>
          <span class="badge jobs">Current local session</span>
        </div>
      </div>
      <div class="row-item">
        <div class="row">
          <div>
            <div class="row-title">Personal Cloudflare</div>
            <div class="row-meta">Optional phone access · requires a user-owned account, D1 database, R2 bucket, and Worker deployment</div>
          </div>
          <span class="badge queued">Setup requires local launcher</span>
        </div>
      </div>
      <p class="hint">Cloudflare credentials cannot be entered into this web page: a deployed Worker must not receive or store the API token capable of deploying itself. The local launcher will collect that token on the computer, store it in a private OS-backed credential store, provision the deployment, and then expose the mode switch here.</p>
    </section>
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
        // Leaving the Roles tab with unsaved edits (or having never analyzed at all) is exactly
        // when a stale/missing analysis would otherwise silently sit there -- see maybeReanalyzeRoles.
        var leavingRolesDirty = tabButton.dataset.tab !== 'roles'
          && document.getElementById('panel-roles').classList.contains('active');
        document.querySelectorAll('nav .tab').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
        tabButton.classList.add('active');
        document.getElementById('panel-' + tabButton.dataset.tab).classList.add('active');
        if (leavingRolesDirty) maybeReanalyzeRoles();
        // On a phone only three or four top-level tabs fit at once, so the tab you just picked
        // could sit half off-screen -- or, if you reached it by scrolling, leave the bar parked
        // somewhere that clips a neighbouring label mid-word. Centring the active tab keeps it
        // fully visible and shows a neighbour on each side, which is also the affordance that
        // there is more to scroll to.
        tabButton.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      });
    });

    document.querySelectorAll('[data-resume-subtab]').forEach(function (subtabButton) {
      subtabButton.addEventListener('click', function () {
        document.querySelectorAll('[data-resume-subtab]').forEach(function (button) { button.classList.remove('active'); });
        document.querySelectorAll('#panel-resume > .subpanel').forEach(function (panel) { panel.classList.remove('active'); });
        subtabButton.classList.add('active');
        document.getElementById('resume-subpanel-' + subtabButton.dataset.resumeSubtab).classList.add('active');
      });
    });

    // Drives the nav's edge fades (see .can-scroll-* above). Runs on scroll and on resize, plus
    // once at startup so the initial state is right before anything is touched.
    (function () {
      var navEl = document.querySelector('nav');
      if (!navEl) return;
      function updateNavFades() {
        var maxScroll = navEl.scrollWidth - navEl.clientWidth;
        navEl.classList.toggle('can-scroll-left', navEl.scrollLeft > 1);
        navEl.classList.toggle('can-scroll-right', navEl.scrollLeft < maxScroll - 1);
      }
      navEl.addEventListener('scroll', updateNavFades, { passive: true });
      window.addEventListener('resize', updateNavFades);
      updateNavFades();
    })();

    function el(tag, props, children) {
      var node = document.createElement(tag);
      Object.keys(props || {}).forEach(function (key) { node[key] = props[key]; });
      (children || []).forEach(function (child) { node.appendChild(child); });
      return node;
    }
    function text(value) { return document.createTextNode(value); }

    // Shared by the Jindr card and the Jobs tab rows -- label above value so a long value (a full
    // sentence, not just a short word) wraps inside the chip instead of forcing a single-line
    // badge past the edge of the card or screen.
    function factChip(fact) {
      if (!fact || !fact.label) return null;
      return el('div', { className: 'fact-chip' }, [
        el('span', { className: 'fact-label', textContent: fact.label }),
        el('span', { className: 'fact-value', textContent: fact.value || 'Not specified' }),
      ]);
    }

    function goToEnroll() { window.location.href = '/enroll'; }

    async function api(path, options) {
      var res = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
      if (res.status === 401) { goToEnroll(); throw new Error('not_authenticated'); }
      return res;
    }

    // A friendly detail (see friendlyMessage() server-side) already reads as a full sentence, so
    // showing it alone beats prefixing it with the internal error code, e.g. "generation_failed:
    // Anthropic is out of credits..." When there's no detail, fall back to the bare code.
    function errorMessage(data, fallback) {
      if (data && data.detail) return data.detail;
      return (data && data.error) || fallback;
    }

    // A failed request should always end up with a readable message, even if the response body
    // isn't valid JSON (a raw platform error page, a network-level failure) -- res.json() throwing
    // there would otherwise surface as an opaque parse error instead of anything actionable.
    async function errorMessageFromResponse(res, fallback) {
      var body = '';
      try { body = await res.text(); } catch (e) { body = ''; }
      if (body) {
        try { return errorMessage(JSON.parse(body), fallback + ' (HTTP ' + res.status + ')'); }
        catch (e) {
          // Cloudflare platform failures are plain text (often "Your worker..."). Preserve that
          // useful explanation instead of hiding it behind an "Unexpected token" JSON error.
          return body.replace(/\s+/g, ' ').trim().slice(0, 500);
        }
      }
      return fallback + ' (HTTP ' + res.status + ')';
    }

    async function requireJsonResponse(res, fallback) {
      var body = '';
      try { body = await res.text(); } catch (e) { body = ''; }
      var data = null;
      if (body) {
        try { data = JSON.parse(body); }
        catch (e) {
          var platformMessage = body.replace(/\s+/g, ' ').trim().slice(0, 500);
          throw new Error(platformMessage || fallback + ' (HTTP ' + res.status + ')');
        }
      }
      if (!res.ok) throw new Error(errorMessage(data, fallback + ' (HTTP ' + res.status + ')'));
      if (!data) throw new Error(fallback + ': empty response');
      return data;
    }

    // Reads a newline-delimited-JSON response as it arrives, calling onEvent for each line as
    // soon as it's in -- used for long-running operations (scanning boards, filtering hundreds
    // of postings) so progress shows up while the work is happening, not just at the end.
    // Returns the final {type: "done", ...} event's payload, or throws on a {type: "error"} event.
    async function readNdjson(res, onEvent) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var result = null;
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i]) continue;
          var event = JSON.parse(lines[i]);
          if (event.type === 'error') throw new Error(event.message || 'stream_failed');
          if (event.type === 'done') { result = event; continue; }
          onEvent(event);
        }
      }
      if (!result) throw new Error('stream_ended_unexpectedly');
      return result;
    }

    document.getElementById('sign-out').addEventListener('click', async function () {
      await api('/auth/logout', { method: 'POST' });
      goToEnroll();
    });

    // Shows what the saved free text was actually understood to mean, using the same chip the
    // Jindr and Jobs cards use -- so the columns you'll see there are visible before any scan runs.
    function renderCareAboutTopics(topics) {
      var host = document.getElementById('care-about-topics');
      host.innerHTML = '';
      (topics || []).forEach(function (topic) {
        var chip = factChip({ label: topic.label, value: topic.looking_for || '' });
        if (chip) host.appendChild(chip);
      });
    }

    // --- Roles page: sub-tabs, the three raw preference inputs, and the derived analysis ---

    document.querySelectorAll('#panel-roles .subnav .subtab').forEach(function (subtabButton) {
      subtabButton.addEventListener('click', function () {
        document.querySelectorAll('#panel-roles .subnav .subtab').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('#panel-roles .subpanel').forEach(function (p) { p.classList.remove('active'); });
        subtabButton.classList.add('active');
        document.getElementById('subpanel-' + subtabButton.dataset.subtab).classList.add('active');
        if (subtabButton.dataset.subtab === 'analysis') maybeReanalyzeRoles();
      });
    });

    // Set whenever a note is added/removed or the Locations/Dealbreakers/Criteria text changes,
    // so maybeReanalyzeRoles knows a fresh pass is actually worth running.
    var rolesInputsDirty = false;
    function markRolesDirty() { rolesInputsDirty = true; }
    ['desired-locations', 'dealbreakers', 'care-about'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', markRolesDirty);
    });

    async function savePreferences() {
      var res = await api('/desired-roles', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          desired_locations: document.getElementById('desired-locations').value,
          dealbreakers: document.getElementById('dealbreakers').value,
          care_about: document.getElementById('care-about').value,
          provider: document.getElementById('role-analysis-provider').value,
        }),
      });
      var saved = await res.json();
      if (!res.ok) throw new Error(errorMessage(saved, 'save_failed'));
      renderCareAboutTopics(saved.care_about_topics);
      return saved;
    }

    [
      ['locations-save-button', 'locations-save-status'],
      ['dealbreakers-save-button', 'dealbreakers-save-status'],
      ['criteria-save-button', 'criteria-save-status'],
    ].forEach(function (pair) {
      document.getElementById(pair[0]).addEventListener('click', async function () {
        var statusEl = document.getElementById(pair[1]);
        statusEl.textContent = 'Saving…';
        statusEl.className = 'status';
        try {
          await savePreferences();
          rolesInputsDirty = false;
          statusEl.textContent = 'Saved.';
          statusEl.className = 'status success';
        } catch (err) {
          statusEl.textContent = 'Error: ' + err.message;
          statusEl.className = 'status error';
        }
      });
    });

    // Non-null only once an analysis with at least one role exists -- both the never-analyzed-yet
    // empty state and the auto-trigger conditions below key off this.
    var currentRoleAnalysis = null;

    function renderRoleAnalysis(analysis) {
      currentRoleAnalysis = analysis && analysis.roles && analysis.roles.length ? analysis : null;
      var host = document.getElementById('role-analysis-view');
      host.innerHTML = '';
      if (!currentRoleAnalysis) {
        host.appendChild(el('p', { className: 'empty', textContent: 'Not analyzed yet -- click Reanalyze, or add a note on the Notes tab and switch tabs.' }));
        return;
      }
      host.appendChild(el('p', { textContent: currentRoleAnalysis.summary }));
      var list = el('div', { className: 'role-analysis-roles' });
      currentRoleAnalysis.roles.forEach(function (role) {
        var card = el('div', { className: 'role-analysis-role' });
        card.appendChild(el('strong', { textContent: role.title }));
        card.appendChild(el('p', { textContent: role.description }));
        list.appendChild(card);
      });
      host.appendChild(list);
    }

    // 'silent' is set by every auto-trigger path (page load, leaving the Roles tab, opening the
    // Analysis tab for the first time) so a background pass never overwrites status text the
    // candidate is actively looking at, and never surfaces "no source material yet" as an error
    // before they've written a single note. The explicit Reanalyze button always runs loud.
    async function runRoleAnalysis(silent) {
      var statusEl = document.getElementById('role-analysis-status');
      var button = document.getElementById('role-analysis-button');
      if (!silent) {
        button.disabled = true;
        statusEl.textContent = 'Analyzing…';
        statusEl.className = 'status';
      }
      try {
        var res = await api('/desired-roles/analyze', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: document.getElementById('role-analysis-provider').value }),
        });
        var data = await res.json();
        if (!res.ok) {
          if (data.error === 'no_source_material') return;
          throw new Error(errorMessage(data, 'generation_failed'));
        }
        renderRoleAnalysis(data.role_analysis);
        if (!silent) {
          statusEl.textContent = 'Analyzed just now.';
          statusEl.className = 'status success';
        }
      } catch (err) {
        if (!silent) {
          statusEl.textContent = 'Error: ' + err.message;
          statusEl.className = 'status error';
        }
      } finally {
        if (!silent) button.disabled = false;
      }
    }

    document.getElementById('role-analysis-button').addEventListener('click', function () { runRoleAnalysis(false); });

    // The auto-reanalyze rule: nothing changed and an analysis already exists -> skip. Otherwise
    // save whatever's dirty (best-effort -- the explicit Save buttons remain the reliable path)
    // and run a silent analysis pass, covering both "made changes and clicked away" and "never
    // analyzed at all yet".
    async function maybeReanalyzeRoles() {
      if (!rolesInputsDirty && currentRoleAnalysis) return;
      var wasDirty = rolesInputsDirty;
      rolesInputsDirty = false;
      if (wasDirty) {
        try { await savePreferences(); } catch (err) { /* best-effort; Save buttons remain available */ }
      }
      await runRoleAnalysis(true);
    }

    async function loadProfile() {
      var res = await api('/profile');
      var data = await res.json();
      if (data.profile) {
        document.getElementById('desired-locations').value = data.profile.desired_locations || '';
        document.getElementById('dealbreakers').value = data.profile.dealbreakers || '';
        document.getElementById('care-about').value = data.profile.care_about || '';
        renderCareAboutTopics(data.profile.care_about_topics);
        renderRoleAnalysis(data.profile.role_analysis);
        renderStructuredProfileView('resume-profile-view', data.profile.structured);
        maybeReanalyzeRoles();
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

    function renderChecks(checks, containerId) {
      var host = document.getElementById(containerId || 'resume-checks');
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
      var master = data.resumes.find(function (resume) { return Boolean(resume.is_master); });
      var versions = data.resumes.filter(function (resume) { return !resume.is_master; });
      if (master) {
        document.getElementById('master-preview-section').style.display = 'block';
        document.getElementById('master-preview-frame').src =
          '/resumes/' + encodeURIComponent(master.id) + '/file?v=' + Date.now();
        var masterChecks = [];
        try { masterChecks = JSON.parse(master.checks_json || '[]'); } catch (e) { masterChecks = []; }
        renderChecks(masterChecks, 'master-checks');
      }
      if (!versions.length) {
        list.appendChild(el('p', { className: 'empty', textContent: 'No resume versions yet — generate one above.' }));
        return;
      }
      versions.forEach(function (resume) {
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

    document.getElementById('resume-master-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('resume-master-status');
      var provider = document.getElementById('resume-provider').value;
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Reading your documents and notes, then building the master resume…';
      statusEl.className = 'status';
      try {
        var profileRes = await api('/profile/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: provider }),
        });
        var profileData = await requireJsonResponse(profileRes, 'profile_generation_failed');

        var saveRes = await api('/profile/structured', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ structured: profileData.draft_structured }),
        });
        await requireJsonResponse(saveRes, 'profile_save_failed');
        renderStructuredProfileView('resume-profile-view', profileData.draft_structured);
        statusEl.textContent = 'Profile ready. Rendering the master resume…';

        var res = await api('/resumes/master', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: provider }),
        });
        var data = await requireJsonResponse(res, 'master_resume_generation_failed');
        statusEl.textContent =
          'Archive built: ' + data.roles + ' role' + (data.roles === 1 ? '' : 's') + ', ' +
          data.bullets + ' accomplishment' + (data.bullets === 1 ? '' : 's') + ' on file.';
        statusEl.className = 'status success';
        await loadResumes();
        document.getElementById('master-preview-section').style.display = 'block';
        document.getElementById('master-preview-frame').src =
          '/resumes/' + encodeURIComponent(data.id) + '/file?v=' + Date.now();
        renderChecks(data.checks, 'master-checks');
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      } finally {
        button.disabled = false;
      }
    });

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
      var count = (data.role_signals || []).length;
      document.getElementById('role-signals-summary').textContent =
        count === 1 ? '1 note on file' : count + ' notes on file';
      renderCollapsibleList('role-signals-list', data.role_signals, 'Nothing added yet.', function (s) { return s.claim; }, async function (s) {
        await api('/role-signals/' + encodeURIComponent(s.id), { method: 'DELETE' });
        markRolesDirty();
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
        markRolesDirty();
        loadRoleSignals();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('reassess-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('reassess-status');
      var button = this;
      var minScore = Number(document.getElementById('reassess-min-score').value) || 70;
      button.disabled = true;
      statusEl.textContent = 'Re-checking…';
      statusEl.className = 'status';
      try {
        var res = await api('/jobs/reassess', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ min_score: minScore }),
        });
        if (!res.ok) throw new Error(errorMessage(await res.json(), 'reassess_failed'));
        var data = await readNdjson(res, function (event) {
          statusEl.textContent = 'Re-checking… ' + event.done + ' of ' + event.total;
        });
        statusEl.textContent = data.assessed
          ? 'Re-checked ' + data.assessed + ' match' + (data.assessed === 1 ? '' : 'es') + ' against your updated preferences.'
          : 'Nothing at or above ' + minScore + '% to re-check.';
        statusEl.className = (data.errors || []).length ? 'status error' : 'status success';
        await loadJobs();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      } finally {
        button.disabled = false;
      }
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

    // A site that didn't resolve at discovery time, or one whose board we scanned and found
    // nothing supported on, isn't going to start yielding postings on its own -- surfacing it
    // in the main list every time is just noise. Kept in the database either way; this only
    // controls what renders by default.
    function isUnscannable(company) {
      return company.status === 'unreachable' || company.ats_provider === 'none';
    }

    function renderCompanyRows(list, companies) {
      companies.forEach(function (company) {
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
        } else if (company.ats_provider === 'none') {
          titleChildren.push(el('span', { className: 'badge warn', textContent: 'no job board found' }));
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

        var muted = company.status === 'dismissed' || isUnscannable(company);
        list.appendChild(el('div', { className: 'row-item' + (muted ? ' is-muted' : '') }, [
          el('div', { className: 'row' }, [
            el('div', {}, body),
            el('div', { className: 'row-actions' }, [scanOne, dismiss, del]),
          ]),
        ]));
      });
    }

    function renderCompanies() {
      var needle = document.getElementById('companies-filter').value.trim();
      var showUnscannable = document.getElementById('companies-show-unscannable').checked;
      var list = document.getElementById('companies-list');
      list.innerHTML = '';

      var matching = allCompanies.filter(function (c) {
        return matchesFilter([c.name, c.location, c.bio, c.why_fit].join(' '), needle);
      });
      var scannable = matching.filter(function (c) { return !isUnscannable(c); });
      var unscannable = matching.filter(isUnscannable);

      var toggle = document.getElementById('companies-show-unscannable');
      toggle.parentElement.style.display = unscannable.length ? 'flex' : 'none';
      document.getElementById('companies-unscannable-count').textContent =
        "Show " + unscannable.length + " compan" + (unscannable.length === 1 ? 'y' : 'ies') + " that can't be scanned";

      if (!scannable.length && !(showUnscannable && unscannable.length)) {
        list.appendChild(el('p', {
          className: 'empty',
          textContent: allCompanies.length
            ? (matching.length ? "Nothing to show — try the checkbox above to reveal companies that can't be scanned." : 'No companies match that filter.')
            : 'No companies yet — run a search on the left.',
        }));
        return;
      }

      renderCompanyRows(list, scannable);
      if (showUnscannable && unscannable.length) {
        list.appendChild(el('h3', { className: 'subhead', textContent: "Can't be scanned" }));
        renderCompanyRows(list, unscannable);
      }
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
      var unscannableCount = allCompanies.filter(isUnscannable).length;
      document.getElementById('companies-summary').innerHTML = '';
      var summaryChildren = [
        el('strong', { textContent: String(allCompanies.length) }),
        // "not scanned yet" = board-check hasn't run on it; "can't be scanned" = it ran (or the
        // site never resolved) and there's nothing to read. Kept as separate counts since only
        // the first one means "scanning again would help."
        el('span', { textContent: ' compan' + (allCompanies.length === 1 ? 'y' : 'ies') +
          ' · ' + withJobs + ' with open roles · ' + (data.unscanned || 0) + ' not scanned yet · ' }),
      ];
      if (unscannableCount) {
        // The count alone isn't actionable -- it just names a number with no way to act on it from
        // here, which is worse than not saying it at all. Make it do the thing you'd otherwise have
        // to scroll up and find a checkbox for.
        var unscannableLink = el('button', {
          className: 'text-link', type: 'button',
          textContent: unscannableCount + " can't be scanned",
        });
        unscannableLink.addEventListener('click', function () {
          var toggle = document.getElementById('companies-show-unscannable');
          toggle.checked = true;
          renderCompanies();
          toggle.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        summaryChildren.push(unscannableLink);
        summaryChildren.push(el('span', { textContent: ' · ' }));
      }
      summaryChildren.push(el('span', { textContent:
        (data.off_target ? data.off_target + ' outside your locations · ' : '') +
        (data.desired_locations ? 'limited to ' + data.desired_locations : 'no location limit set') }));
      document.getElementById('companies-summary').appendChild(el('span', {}, summaryChildren));
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
    document.getElementById('companies-show-unscannable').addEventListener('change', renderCompanies);

    document.getElementById('companies-discover-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('companies-discover-status');
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Starting…';
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
        if (!res.ok) throw new Error(errorMessage(await res.json(), 'discovery_failed'));
        var data = await readNdjson(res, function (event) {
          if (event.stage === 'propose') {
            statusEl.textContent = event.message;
            return;
          }
          // The first 'verify' event (done=0) carries the propose/dedupe/location breakdown before
          // any site check has even started -- showing it immediately is what answers "why so few"
          // without waiting for the slowest part (the website checks) to finish first.
          var prefix = 'Proposed ' + event.proposed + '.' +
            (event.duplicates ? ' ' + event.duplicates + ' already on your list.' : '') +
            (event.off_target ? ' ' + event.off_target + ' outside your locations.' : '');
          if (!event.total) {
            statusEl.textContent = prefix + (event.proposed ? ' Nothing new left to check.' : '');
            return;
          }
          statusEl.textContent = prefix + ' Checking ' + event.done + ' of ' + event.total +
            (event.company ? ' (' + event.company + (event.done ? (event.reachable ? ', reachable' : ", couldn't be reached") : '') + ')' : '') + '…';
        });
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
      } finally {
        button.disabled = false;
      }
    });

    document.getElementById('jobs-scan-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('jobs-scan-status');
      var button = this;
      var wantsAll = document.getElementById('jobs-scan-count').value === '500';
      button.disabled = true;
      statusEl.textContent = 'Reading job boards…';
      statusEl.className = 'status';
      try {
        var totalScanned = 0;
        var totalNew = 0;
        var round = 0;
        var data;
        // A single request only gets through as many companies as safely fit in one call. "All"
        // means the user shouldn't have to click again to get the rest, so it re-fires on their
        // behalf until nothing's left -- capped so a real server problem can't spin forever.
        do {
          round += 1;
          var res = await api('/companies/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              limit: Number(document.getElementById('jobs-scan-count').value),
              force: document.getElementById('jobs-scan-force').checked,
            }),
          });
          if (!res.ok) throw new Error(errorMessage(await res.json(), 'scan_failed'));
          data = await readNdjson(res, function (event) {
            statusEl.textContent =
              (round > 1 ? 'Round ' + round + ': ' : '') +
              'Scanning… ' + event.done + ' of ' + event.total + ' compan' + (event.total === 1 ? 'y' : 'ies') +
              ' (' + event.company + (event.new_jobs ? ', ' + event.new_jobs + ' new' : '') + ')';
            // New listings land as unassessed the moment they're inserted -- grow the Search tab's
            // pipeline diagram live as each company's board read completes, not only after this
            // whole (possibly multi-round) scan finishes.
            pfBumpScanned(event.new_jobs);
          });
          totalScanned += data.scanned;
          totalNew += data.new_listings;
        } while (wantsAll && data.unscanned > 0 && data.scanned > 0 && round < 25);
        if (totalScanned === 0 && !document.getElementById('jobs-scan-force').checked) {
          // The single most confusing outcome this button can produce: it looks identical to "ran
          // fine, nothing new" whether that's actually true or every candidate was just skipped for
          // already being scanned today -- say so explicitly instead of leaving that ambiguous.
          statusEl.textContent = 'Nothing scanned -- every company on your list was already scanned today. ' +
            'Check "Re-scan companies already read today too" above if you specifically need a fresh read right now.';
        } else {
          statusEl.textContent =
            'Scanned ' + totalScanned + ' compan' + (totalScanned === 1 ? 'y' : 'ies') + ' — found ' +
            totalNew + ' new listing' + (totalNew === 1 ? '' : 's') + '. ' +
            (data.unscanned ? data.unscanned + ' compan' + (data.unscanned === 1 ? 'y' : 'ies') +
              ' still to scan today, click again to continue.' : 'All companies scanned for today.');
        }
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

    document.getElementById('company-bulk-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('company-bulk-status');
      var textEl = document.getElementById('company-bulk-text');
      var text = textEl.value.trim();
      if (!text) {
        statusEl.textContent = 'Paste at least one company first.';
        statusEl.className = 'status error';
        return;
      }
      statusEl.textContent = 'Adding…';
      statusEl.className = 'status';
      try {
        var res = await api('/companies/bulk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'add_failed'));
        statusEl.textContent = 'Added ' + data.added + ' of ' + data.total + '.' +
          (data.skipped ? ' ' + data.skipped + ' already on your list.' : '');
        statusEl.className = 'status success';
        textEl.value = '';
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
      interested: { text: 'Interested', cls: 'strong' },
      applied: { text: 'Applied', cls: 'strong' },
    };
    // Four buckets, kept visually and structurally separate so a fresh scan's unfiltered
    // postings never get mixed in with results you've already reviewed:
    //   judged matches (green)      -- shown by default
    //   not filtered yet (yellow)   -- hidden by default, own toggle
    //   ruled out (red)             -- hidden by default, own toggle
    //   interested / applied        -- never shown here at all, each lives on its own tab instead
    var QUEUED_STATUSES = { unassessed: true, screened_in: true };
    var RULED_OUT_STATUSES = { reject: true, screened_out: true };
    var INTERESTED_STATUSES = { interested: true };
    var APPLIED_STATUSES = { applied: true };

    async function submitJobFit(jobId, action, reason) {
      await api('/jobs/' + encodeURIComponent(jobId) + '/fit', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action, reason: reason || '' }),
      });
      await loadJobs();
    }

    // Jindr: the same judged-matches bucket the Jobs tab shows, one at a time instead of scrolled,
    // always ordered best-match-first regardless of whatever sort the Jobs tab currently has
    // selected. The queue is a plain snapshot taken when the tab is opened -- not rebuilt on every
    // loadJobs() -- so a background scan or reassess finishing mid-review doesn't reshuffle the
    // stack out from under you.
    var jindrQueue = [];
    var jindrIndex = 0;
    var jindrLastSwipe = null;

    function jindrBuildQueue() {
      jindrQueue = allJobs.filter(function (j) {
        return !QUEUED_STATUSES[j.fit_status] && !RULED_OUT_STATUSES[j.fit_status]
          && !INTERESTED_STATUSES[j.fit_status] && !APPLIED_STATUSES[j.fit_status];
      }).sort(jobSortComparator('score'));
      jindrIndex = 0;
      jindrLastSwipe = null;
      renderJindrCard();
    }

    function renderJindrCard() {
      document.getElementById('jindr-undo').style.display = jindrLastSwipe ? 'inline-block' : 'none';
      document.getElementById('jindr-status').textContent = '';

      if (jindrIndex >= jindrQueue.length) {
        document.getElementById('jindr-progress').textContent = jindrQueue.length
          ? 'Reviewed all ' + jindrQueue.length + '.' : '';
        document.getElementById('jindr-card').style.display = 'none';
        document.getElementById('jindr-empty').style.display = 'block';
        return;
      }

      document.getElementById('jindr-empty').style.display = 'none';
      document.getElementById('jindr-card').style.display = 'block';
      var card = document.getElementById('jindr-card');
      card.style.transform = '';
      card.classList.remove('dragging');

      var job = jindrQueue[jindrIndex];
      document.getElementById('jindr-progress').textContent = (jindrIndex + 1) + ' of ' + jindrQueue.length + ' to review';

      var titleEl = document.getElementById('jindr-title');
      titleEl.textContent = job.title;
      if (job.source_url) { titleEl.href = job.source_url; } else { titleEl.removeAttribute('href'); }

      var hasScore = job.fit_score !== null && job.fit_score !== undefined;
      var scoreEl = document.getElementById('jindr-score');
      scoreEl.textContent = hasScore ? job.fit_score + '% match' : 'Not yet scored';
      // The class was hardcoded to "strong" in the markup, so a 55% here looked exactly as settled
      // as a 92% -- the same flattening the Jobs rows had. Derive it from the posting's own status
      // via the shared label table instead.
      var scoreInfo = FIT_LABELS[job.fit_status] || FIT_LABELS.unassessed;
      scoreEl.className = ('badge ' + scoreInfo.cls).trim();

      document.getElementById('jindr-meta').textContent = [job.company, job.location].filter(Boolean).join(' · ');

      var detail = {};
      try { detail = JSON.parse(job.fit_detail_json || '{}'); } catch (e) { detail = {}; }
      var factsHost = document.getElementById('jindr-facts');
      factsHost.innerHTML = '';
      (detail.facts || []).map(factChip).filter(Boolean).forEach(function (chip) { factsHost.appendChild(chip); });

      document.getElementById('jindr-reason').textContent = job.fit_reason || '';

      var missing = [];
      try { missing = JSON.parse(job.fit_missing_json || '[]'); } catch (e) { missing = []; }
      var missingHost = document.getElementById('jindr-missing');
      missingHost.innerHTML = '';
      if (missing.length) {
        missingHost.appendChild(el('p', { className: 'job-missing', textContent: 'Gaps: ' + missing.join('; ') }));
      }
    }

    function jindrSwipe(action) {
      if (jindrIndex >= jindrQueue.length) return;
      var job = jindrQueue[jindrIndex];
      jindrLastSwipe = { job: JSON.parse(JSON.stringify(job)), action: action };
      jindrIndex += 1;
      renderJindrCard();
      // Fired after the UI has already moved on -- reviewing one posting shouldn't stall on a
      // round trip the same way a swipe app never waits for the server before showing the next card.
      submitJobFit(job.id, action).catch(function (err) {
        document.getElementById('jindr-status').textContent = 'Error saving that decision: ' + err.message;
        document.getElementById('jindr-status').className = 'status error';
      });
    }

    document.getElementById('jindr-interested').addEventListener('click', function () { jindrSwipe('interested'); });
    document.getElementById('jindr-reject').addEventListener('click', function () { jindrSwipe('reject'); });

    document.getElementById('jindr-undo').addEventListener('click', async function () {
      if (!jindrLastSwipe) return;
      var snapshot = jindrLastSwipe.job;
      var button = this;
      button.disabled = true;
      try {
        await api('/jobs/' + encodeURIComponent(snapshot.id) + '/fit', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'restore_snapshot',
            fit_status: snapshot.fit_status,
            fit_score: snapshot.fit_score,
            fit_reason: snapshot.fit_reason,
            fit_missing_json: snapshot.fit_missing_json,
            fit_detail_json: snapshot.fit_detail_json,
          }),
        });
        jindrIndex -= 1;
        jindrLastSwipe = null;
        renderJindrCard();
        await loadJobs();
      } catch (err) {
        document.getElementById('jindr-status').textContent = 'Error: ' + err.message;
        document.getElementById('jindr-status').className = 'status error';
      } finally {
        button.disabled = false;
      }
    });

    // Drag-to-swipe: a bonus on top of the buttons above, not a replacement -- pointer events so
    // it works with both touch and mouse, translateX follows the pointer, releasing past a distance
    // threshold commits to the same action the corresponding button would.
    (function () {
      var card = document.getElementById('jindr-card');
      var dragging = false;
      var startX = 0;
      var dx = 0;
      var THRESHOLD = 100;

      card.addEventListener('pointerdown', function (event) {
        if (jindrIndex >= jindrQueue.length) return;
        // The buttons are children of the card -- without this, pressing one starts a drag first
        // (capturing the pointer to the card) and the button never sees its own click at all.
        if (event.target.closest('.jindr-actions')) return;
        dragging = true;
        startX = event.clientX;
        dx = 0;
        card.classList.add('dragging');
        card.setPointerCapture(event.pointerId);
      });
      card.addEventListener('pointermove', function (event) {
        if (!dragging) return;
        dx = event.clientX - startX;
        card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 20) + 'deg)';
      });
      function endDrag() {
        if (!dragging) return;
        dragging = false;
        card.classList.remove('dragging');
        if (dx > THRESHOLD) {
          jindrSwipe('interested');
        } else if (dx < -THRESHOLD) {
          jindrSwipe('reject');
        } else {
          card.style.transform = '';
        }
        dx = 0;
      }
      card.addEventListener('pointerup', endDrag);
      card.addEventListener('pointercancel', endDrag);
    })();

    document.querySelector('[data-tab="jindr"]').addEventListener('click', jindrBuildQueue);

    function renderJobRows(list, jobs) {
      jobs.forEach(function (job) {
        var fitInfo = FIT_LABELS[job.fit_status] || FIT_LABELS.unassessed;
        // A numeric score means the strong tier (or a manual "Not for me", scored 0) actually
        // rated this posting -- show the real number. Postings still queued or dropped by the
        // cheap screen never reach that tier, so they keep the descriptive label instead.
        var hasScore = job.fit_score !== null && job.fit_score !== undefined;
        var badgeText = hasScore ? job.fit_score + '% match' : fitInfo.text;
        var missing = [];
        try { missing = JSON.parse(job.fit_missing_json || '[]'); } catch (e) { missing = []; }
        var fitDetail = {};
        try { fitDetail = JSON.parse(job.fit_detail_json || '{}'); } catch (e) { fitDetail = {}; }

        var titleNode = job.source_url
          ? el('a', {
              className: 'row-title', href: job.source_url, target: '_blank', rel: 'noopener',
              textContent: job.title,
            })
          : el('span', { className: 'row-title', textContent: job.title });
        var titleLine = [titleNode, el('span', { className: ('badge ' + fitInfo.cls).trim(), textContent: badgeText })];

        var meta = [
          job.company,
          job.location,
          job.posted_at ? 'posted ' + new Date(job.posted_at).toLocaleDateString() : '',
          job.ats_provider || 'added by hand',
        ].filter(Boolean).join(' · ');

        var body = [el('div', { className: 'row-title-line' }, titleLine), el('div', { className: 'row-meta', textContent: meta })];
        // Whatever the candidate said they care about (Roles tab, Criteria) -- one chip per fact, on
        // its own line so a long value wraps instead of forcing the title line to overflow.
        var facts = (fitDetail.facts || []).map(factChip).filter(Boolean);
        if (facts.length) body.push(el('div', { className: 'row-facts' }, facts));
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
        // Every row that reaches this list is, by construction, not yet interested -- once marked,
        // a job is excluded from all three Jobs-tab buckets and only shows up on the Interested tab.
        var interested = el('button', { type: 'button', textContent: 'Interested' });
        interested.addEventListener('click', function () { submitJobFit(job.id, 'interested'); });
        actions.push(interested);
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

    // A posting with no known post date is never excluded by an age filter -- there's no
    // evidence it's stale, so the honest default is to show it rather than guess.
    function withinAge(job, maxDays) {
      if (!maxDays || !job.posted_at) return true;
      var ageMs = Date.now() - new Date(job.posted_at).getTime();
      return ageMs <= maxDays * 86400000;
    }

    // Same principle as withinAge: a posting with no score yet (still queued, or dropped by the
    // cheap screen before ever reaching the scoring tier) is never excluded by a score threshold
    // -- there's nothing to compare, and this filter isn't what's gating those groups anyway.
    function withinScore(job, minScore) {
      if (!minScore || job.fit_score === null || job.fit_score === undefined) return true;
      return job.fit_score >= minScore;
    }

    // A posting missing whatever field this sort is on (never processed, no known post date)
    // sorts to the end rather than jumping to the top under a naive falsy-first-value comparison
    // -- same "don't penalize missing data, but don't let it masquerade as new either" principle
    // withinAge/withinScore already use for filtering.
    function jobSortComparator(mode) {
      return function (a, b) {
        if (mode === 'processed') {
          var pa = a.assessed_at ? new Date(a.assessed_at).getTime() : -1;
          var pb = b.assessed_at ? new Date(b.assessed_at).getTime() : -1;
          return pb - pa;
        }
        if (mode === 'posted') {
          var da = a.posted_at ? new Date(a.posted_at).getTime() : -1;
          var db = b.posted_at ? new Date(b.posted_at).getTime() : -1;
          return db - da;
        }
        // Sorted by the actual score now that there is one, rather than just the two-bucket order --
        // an 88% and a 71% were both "strong" under the old labels but aren't equally worth reading first.
        return (b.fit_score ?? 0) - (a.fit_score ?? 0);
      };
    }

    function renderJobs() {
      var needle = document.getElementById('jobs-filter').value.trim();
      var maxAgeDays = Number(document.getElementById('jobs-age').value) || 0;
      var minScore = Number(document.getElementById('jobs-min-score').value) || 0;
      var showQueued = document.getElementById('jobs-show-unfiltered').checked;
      var showRejected = document.getElementById('jobs-show-rejected').checked;
      var list = document.getElementById('jobs-list');
      list.innerHTML = '';

      var matching = allJobs.filter(function (job) {
        return matchesFilter([job.title, job.company, job.location].join(' '), needle)
          && withinAge(job, maxAgeDays)
          && withinScore(job, minScore);
      });
      // Kept as three separate groups rather than one filtered-and-sorted list, so a fresh
      // scan's unreviewed postings can never end up sitting among ones you've already judged --
      // each group only ever appears in its own block, gated by its own toggle.
      var matches = matching.filter(function (j) {
        return !QUEUED_STATUSES[j.fit_status] && !RULED_OUT_STATUSES[j.fit_status]
          && !INTERESTED_STATUSES[j.fit_status] && !APPLIED_STATUSES[j.fit_status];
      });
      var queued = matching.filter(function (j) { return QUEUED_STATUSES[j.fit_status]; });
      var ruledOut = matching.filter(function (j) { return RULED_OUT_STATUSES[j.fit_status]; });
      matches.sort(jobSortComparator(document.getElementById('jobs-sort').value));

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
    document.getElementById('jobs-age').addEventListener('change', renderJobs);
    document.getElementById('jobs-min-score').addEventListener('change', renderJobs);
    document.getElementById('jobs-sort').addEventListener('change', renderJobs);
    document.getElementById('jobs-show-unfiltered').addEventListener('change', renderJobs);
    document.getElementById('jobs-show-rejected').addEventListener('change', renderJobs);

    document.getElementById('jobs-assess-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('jobs-assess-status');
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Screening listings, then assessing the ones worth a closer look…';
      statusEl.className = 'status';
      pfBeginRun();
      try {
        var totalScreened = 0, totalScreenedOut = 0, totalAssessed = 0, allErrors = [];
        var round = 0;
        var data;
        // Same reasoning as "Scan company boards": one request only gets through as much of the
        // backlog as the server's own per-call budget safely allows, so it re-fires on your
        // behalf until nothing's left rather than making you click through a big backlog by
        // hand -- capped so a real server problem, or a backlog that genuinely stops shrinking,
        // can't spin forever.
        do {
          round += 1;
          var res = await api('/jobs/process', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: document.getElementById('jobs-provider').value }),
          });
          if (!res.ok) throw new Error(errorMessage(await res.json(), 'process_failed'));
          data = await readNdjson(res, function (event) {
            statusEl.textContent = (round > 1 ? 'Round ' + round + ': ' : '') + (event.stage === 'screen'
              ? 'Step 1 of 2 — quick screen: '
              : 'Step 2 of 2 — detailed scoring: ') + event.done + ' of ' + event.total;
            // Real per-batch accept/reject counts, not a guess from done/total -- see
            // pfApplyRunEvent. This is what makes the pipeline diagram move live, batch by batch,
            // while this run is still in flight rather than only jumping once at the very end.
            pfApplyRunEvent(event);
          });
          // The server's own authoritative counts, reconciling away any drift the live per-batch
          // deltas above might have accumulated.
          setPfCounts(data.counts || {});
          totalScreened += data.screened || 0;
          totalScreenedOut += data.screened_out || 0;
          totalAssessed += data.assessed || 0;
          if ((data.errors || []).length) allErrors.push.apply(allErrors, data.errors);
        } while (
          !allErrors.length && round < 25 &&
          ((data.counts || {}).unassessed > 0 || (data.counts || {}).screened_in > 0) &&
          (data.screened || data.assessed)
        );

        var counts = data.counts || {};
        var left = (counts.unassessed || 0) + (counts.screened_in || 0);
        var parts = [];
        if (totalScreened) parts.push('Screened ' + totalScreened + ', dropped ' + totalScreenedOut + ' as clear misses.');
        if (totalAssessed) parts.push('Assessed ' + totalAssessed + ' in detail.');
        if (!parts.length) parts.push('Nothing left to process.');
        // Only reachable if the loop stopped without actually clearing the backlog: a real error,
        // the round cap, or a round that made no progress at all -- genuinely worth a click to retry.
        parts.push(left ? left + ' still queued — click again to continue.' : 'All caught up.');
        if (allErrors.length) parts.push('Some batches failed: ' + allErrors.join('; '));
        statusEl.textContent = parts.join(' ');
        statusEl.className = allErrors.length ? 'status error' : 'status success';
        await loadJobs();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      } finally {
        button.disabled = false;
      }
    });

    // ---- Pipeline flow diagram (Search tab) --------------------------------------------------
    // A live sankey of where scanned postings currently sit, built once as persistent SVG nodes
    // and then only ever mutated -- not rebuilt from scratch on every update -- so a change can be
    // eased smoothly instead of jumping. Two real branch points: the cheap screen (screened out /
    // screened in), then the detailed pass on whatever passed it (ruled out / recommended).
    // Not-interested/Interested/Applied aren't shown -- this page is about finding matches, not
    // the human review funnel after it; Interested/Applied postings are folded into "Recommended"
    // here since that's still what they were found as.
    //
    // setPfCounts() is the single entry point, same idea as a real-events-call-decideNext design:
    // it's called with the authoritative shape jobPipelineCounts() returns (every full /jobs load
    // reconciles from it), and nudged with real per-batch deltas while a scan or a Find-my-matches
    // run is actively in flight, via pfBumpScanned() and pfApplyRunEvent() below. No probability or
    // random weighting is needed anywhere here, unlike a simulation that has to guess outcomes in
    // advance -- the real split is already known by the time a batch finishes, so it's just assigned.
    var PF_NODES = [
      { id: 'scanned', label: 'Scanned postings', stage: 0, kind: 'neutral' },
      { id: 'screen_pending', label: 'Not screened yet', stage: 1, kind: 'pending' },
      { id: 'screen_rejected', label: 'Screened out', stage: 1, kind: 'reject' },
      { id: 'screen_accepted', label: 'Passed screening', stage: 1, kind: 'neutral' },
      { id: 'fit_pending', label: 'Awaiting review', stage: 2, kind: 'pending' },
      { id: 'fit_rejected', label: 'Ruled out', stage: 2, kind: 'reject' },
      { id: 'fit_recommended', label: 'Recommended', stage: 2, kind: 'success' },
    ];
    var PF_BRANCHES = {
      scanned: ['screen_pending', 'screen_rejected', 'screen_accepted'],
      screen_accepted: ['fit_pending', 'fit_rejected', 'fit_recommended'],
    };
    var PF_STAGE_TITLES = ['Scanned', 'Screening', 'Fit review'];
    var PF_KIND_COLOR = { neutral: 'var(--text-muted)', pending: 'var(--warning)', reject: 'var(--error)', success: 'var(--success)' };

    var PF_VB_W = 900, PF_VB_H = 340;
    var PF_MARGIN_TOP = 26, PF_MARGIN_BOTTOM = 8;
    var PF_USABLE_H = PF_VB_H - PF_MARGIN_TOP - PF_MARGIN_BOTTOM;
    var PF_NODE_W = 10;
    var PF_MIN_H = 6;
    var PF_ROW_GAP = 26; // generous on purpose: each node's 2-line label needs real clearance from its neighbors, not just its own (possibly tiny) bar height
    var PF_SOURCE_HEIGHT = 200; // the fixed 100% reference height "Scanned postings" renders at
    var PF_COL_MARGIN = 14;
    var PF_COL_STEP = 300;
    var PF_SMOOTH_RATE = 6;

    var pfNodeMap = {};
    PF_NODES.forEach(function (n) {
      pfNodeMap[n.id] = n;
      n.x = PF_COL_MARGIN + n.stage * PF_COL_STEP;
      n.width = PF_NODE_W;
      n.dispHeight = PF_MIN_H;
      n.y = PF_MARGIN_TOP; n.cy = PF_MARGIN_TOP;
    });
    var pfStageGroups = [[], [], []];
    PF_NODES.forEach(function (n) { pfStageGroups[n.stage].push(n.id); });

    var pfEdges = {};
    var pfChildEdges = {}; var pfParentEdges = {};
    PF_NODES.forEach(function (n) { pfChildEdges[n.id] = []; pfParentEdges[n.id] = []; });
    Object.keys(PF_BRANCHES).forEach(function (source) {
      PF_BRANCHES[source].forEach(function (target) {
        var edge = { source: source, target: target, committed: 0, sy0: 0, sy1: 0, ty0: 0, ty1: 0 };
        pfEdges[source + '->' + target] = edge;
        pfChildEdges[source].push(edge);
        pfParentEdges[target].push(edge);
      });
    });

    var pfSourceTotal = 0;
    var pfLastCountsPayload = null;
    var pfAnimating = false;
    var pfLastFrame = 0;

    function pfDerivedTotal(nodeId) {
      if (nodeId === 'scanned') return pfSourceTotal;
      var edges = pfParentEdges[nodeId], sum = 0;
      for (var i = 0; i < edges.length; i++) sum += edges[i].committed;
      return sum;
    }
    function pfTargetHeight(n) {
      if (n.id === 'scanned') return PF_SOURCE_HEIGHT;
      return Math.max(PF_MIN_H, (pfDerivedTotal(n.id) / Math.max(1, pfSourceTotal)) * PF_SOURCE_HEIGHT);
    }

    // The one entry point that actually moves the diagram, and the one place bursts get decided:
    // whatever edge's committed count just went UP compared to last time gets a burst proportional
    // to that increase, so motion only ever appears at the instant new real numbers land, not as
    // constant ambient looping. The very first call (page load) is deliberately silent -- that's
    // the starting state, not an update, and bursting the entire existing backlog on load would be
    // both meaningless and overwhelming.
    function setPfCounts(counts) {
      var isFirstLoad = pfLastCountsPayload === null;
      var prevCommitted = {};
      Object.keys(pfEdges).forEach(function (key) { prevCommitted[key] = pfEdges[key].committed; });

      pfLastCountsPayload = counts;
      var unassessed = counts.unassessed || 0;
      var screenedOut = counts.screened_out || 0;
      var screenedIn = counts.screened_in || 0;
      var reject = counts.reject || 0;
      var recommended = (counts.strong || 0) + (counts.possible || 0) + (counts.interested || 0) + (counts.applied || 0);
      var screenAccepted = screenedIn + reject + recommended;

      pfSourceTotal = unassessed + screenedOut + screenAccepted;
      pfEdges['scanned->screen_pending'].committed = unassessed;
      pfEdges['scanned->screen_rejected'].committed = screenedOut;
      pfEdges['scanned->screen_accepted'].committed = screenAccepted;
      pfEdges['screen_accepted->fit_pending'].committed = screenedIn;
      pfEdges['screen_accepted->fit_rejected'].committed = reject;
      pfEdges['screen_accepted->fit_recommended'].committed = recommended;

      if (!isFirstLoad) {
        Object.keys(pfEdges).forEach(function (key) {
          var delta = pfEdges[key].committed - prevCommitted[key];
          if (delta > 0) pfBurst(key, delta);
        });
      }

      document.getElementById('jobs-pipeline-summary').textContent =
        recommended + ' match' + (recommended === 1 ? '' : 'es') +
        ', ' + (unassessed + screenedIn) + ' waiting to be filtered' +
        ', ' + screenedOut + ' dropped in screening' +
        ', ' + reject + ' ruled out.';
      document.getElementById('pfStatScanned').textContent = String(pfSourceTotal);
      document.getElementById('pfStatRecommended').textContent = String(recommended);
      var totalScreened = screenedOut + screenAccepted;
      document.getElementById('pfStatScreenRate').textContent = totalScreened ? Math.round(100 * screenAccepted / totalScreened) + '%' : '—';
      var processed = pfSourceTotal ? Math.round(100 * (pfSourceTotal - unassessed - screenedIn) / pfSourceTotal) : 0;
      document.getElementById('pfStatProcessed').textContent = processed + '%';
      document.getElementById('pfProgressFill').style.width = processed + '%';

      pfWake();
    }

    // Freezes the counts as of the moment a Find-my-matches run starts, so live per-batch deltas
    // during that run (see pfApplyRunEvent) have a stable base to add onto rather than drifting
    // against whatever setPfCounts happened to see last.
    var pfRunSnapshot = null;
    var pfRunAssessBase = null;
    function pfBeginRun() {
      pfRunSnapshot = pfLastCountsPayload
        ? Object.assign({}, pfLastCountsPayload)
        : { unassessed: 0, screened_out: 0, screened_in: 0, reject: 0, strong: 0, possible: 0, interested: 0, applied: 0 };
      pfRunAssessBase = null;
    }
    function pfApplyRunEvent(event) {
      if (!pfRunSnapshot) return;
      var next = Object.assign({}, pfLastCountsPayload || pfRunSnapshot);
      if (event.stage === 'screen') {
        next.unassessed = Math.max(0, pfRunSnapshot.unassessed - event.done);
        next.screened_out = pfRunSnapshot.screened_out + (event.screened_out || 0);
        next.screened_in = pfRunSnapshot.screened_in + (event.screened_in || 0);
      } else if (event.stage === 'assess') {
        // Frozen the instant assess events start, from whatever screened_in ended up at when the
        // screen stage (above) finished -- not the pre-run snapshot, which would still include
        // postings this same run only just moved out of "not screened yet".
        if (pfRunAssessBase === null) pfRunAssessBase = next.screened_in;
        next.screened_in = Math.max(0, pfRunAssessBase - event.done);
        next.reject = pfRunSnapshot.reject + (event.discarded || 0);
        next.possible = pfRunSnapshot.possible + (event.recommended || 0);
      }
      setPfCounts(next);
    }
    // Scanning company boards finds new postings before any screening happens -- they land
    // straight in "not screened yet", growing the Scanned total live as each company's board read
    // completes, same idea as the assess-run deltas above but simpler (only one bucket changes).
    function pfBumpScanned(newJobs) {
      if (!newJobs) return;
      var base = pfLastCountsPayload || { unassessed: 0, screened_out: 0, screened_in: 0, reject: 0, strong: 0, possible: 0, interested: 0, applied: 0 };
      var next = Object.assign({}, base);
      next.unassessed = (base.unassessed || 0) + newJobs;
      setPfCounts(next);
    }

    function pfLayoutColumns() {
      pfStageGroups.forEach(function (ids) {
        var totalH = 0;
        ids.forEach(function (id) { totalH += pfNodeMap[id].dispHeight; });
        totalH += PF_ROW_GAP * (ids.length - 1);
        var y = PF_MARGIN_TOP + (PF_USABLE_H - totalH) / 2;
        ids.forEach(function (id) {
          var n = pfNodeMap[id];
          n.y = y; n.cy = y + n.dispHeight / 2;
          y += n.dispHeight + PF_ROW_GAP;
        });
      });
    }
    function pfRecomputeEdgeSlices() {
      PF_NODES.forEach(function (n) {
        var outs = pfChildEdges[n.id].slice().sort(function (a, b) { return pfNodeMap[a.target].cy - pfNodeMap[b.target].cy; });
        var outDenom = 0; outs.forEach(function (e) { outDenom += e.committed; }); outDenom = Math.max(1, outDenom);
        var cum = 0;
        outs.forEach(function (e) {
          var h = (e.committed / outDenom) * n.dispHeight;
          e.sy0 = n.y + cum; e.sy1 = e.sy0 + h; cum += h;
        });
        var ins = pfParentEdges[n.id].slice().sort(function (a, b) { return pfNodeMap[a.source].cy - pfNodeMap[b.source].cy; });
        var inDenom = 0; ins.forEach(function (e) { inDenom += e.committed; }); inDenom = Math.max(1, inDenom);
        cum = 0;
        ins.forEach(function (e) {
          var h = (e.committed / inDenom) * n.dispHeight;
          e.ty0 = n.y + cum; e.ty1 = e.ty0 + h; cum += h;
        });
      });
    }

    var PF_SVG_NS = 'http://www.w3.org/2000/svg';
    function pfEl(tag, attrs) {
      var e = document.createElementNS(PF_SVG_NS, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }

    var pfSvg = document.getElementById('pf-svg');
    pfSvg.setAttribute('viewBox', '0 0 ' + PF_VB_W + ' ' + PF_VB_H);
    PF_STAGE_TITLES.forEach(function (title, i) {
      var t = pfEl('text', { x: PF_COL_MARGIN + i * PF_COL_STEP + PF_NODE_W / 2, y: PF_MARGIN_TOP - 12, 'text-anchor': 'middle', class: 'pf-stage-title' });
      t.textContent = title;
      pfSvg.appendChild(t);
    });

    var pfFlowLayer = pfEl('g', {});
    pfSvg.appendChild(pfFlowLayer);
    var pfPathByKey = {};
    Object.keys(pfEdges).forEach(function (key) {
      var path = pfEl('path', { class: 'pf-link', d: '' });
      pfFlowLayer.appendChild(path);
      pfPathByKey[key] = path;
    });

    var PF_BURST_MAX = 18; // visual cap -- a real delta can be up to a full batch (60 for screen),
                            // and 60 individual dots at once reads as noise, not motion.
    var PF_BURST_DUR_MIN = 0.8, PF_BURST_DUR_RANGE = 0.5;
    var PF_BURST_STAGGER = 0.06; // seconds between each dot's start, so a burst arrives as a
                                  // trickle rather than a single-frame pop of simultaneous dots.

    // Fires once per real increase (see setPfCounts), never on a timer or a loop: a handful of
    // dots -- proportional to, capped at a readable count of, exactly how much this specific edge
    // just grew by -- ride their OWN random path across the current ribbon band (computed fresh
    // from the edge's live sy0/sy1/ty0/ty1, so a burst mid-transition still starts and ends on the
    // ribbon as it actually is right now) and are discarded once they land. No shared guide path
    // or indefinite animation needed -- SMIL's animateMotion takes a path directly.
    function pfBurst(key, delta) {
      var e = pfEdges[key];
      if (!e) return;
      var s = pfNodeMap[e.source], t = pfNodeMap[e.target];
      var x0 = s.x + s.width, x1 = t.x, midX = (x0 + x1) / 2;
      var n = Math.max(1, Math.min(PF_BURST_MAX, Math.round(delta)));
      var color = PF_KIND_COLOR[t.kind] || 'var(--text-muted)';
      for (var i = 0; i < n; i++) {
        // One random vertical fraction per dot, reused at both ends, so each dot cuts its own
        // straight-ish diagonal through the band instead of every dot sharing one centerline.
        var frac = Math.random();
        var y0 = e.sy0 + frac * (e.sy1 - e.sy0);
        var y1 = e.ty0 + frac * (e.ty1 - e.ty0);
        var d = 'M' + x0 + ',' + y0 + ' C' + midX + ',' + y0 + ' ' + midX + ',' + y1 + ' ' + x1 + ',' + y1;
        var dur = PF_BURST_DUR_MIN + Math.random() * PF_BURST_DUR_RANGE;
        var begin = i * PF_BURST_STAGGER + Math.random() * (PF_BURST_STAGGER / 2);
        var dot = pfEl('circle', { r: 2.6, class: 'pf-dot', fill: color });
        var anim = pfEl('animateMotion', { path: d, dur: dur + 's', begin: begin + 's', fill: 'freeze' });
        dot.appendChild(anim);
        pfFlowLayer.appendChild(dot);
        (function (el, life) { setTimeout(function () { el.remove(); }, life * 1000); })(dot, begin + dur + 0.15);
      }
    }

    var pfNodeLayer = pfEl('g', {});
    pfSvg.appendChild(pfNodeLayer);
    var pfNodeVisuals = {};
    PF_NODES.forEach(function (n) {
      var rect = pfEl('rect', { class: 'pf-node-rect', x: n.x, y: n.y, width: n.width, height: n.dispHeight, rx: 2, fill: 'var(--surface-2)', stroke: PF_KIND_COLOR[n.kind] });
      var tx = n.x + n.width + 8;
      // A label can end up sitting inside a wide ribbon (e.g. "Scanned postings", dead center of
      // the diagram, with three stacked col1 ribbons passing directly behind it) -- a halo behind
      // the text keeps it legible regardless of what color is behind it, rather than hoping every
      // ribbon stays out of the way.
      var halo = pfEl('rect', { class: 'pf-label-halo', x: tx - 4, y: n.cy - 14, width: 90, height: 30, rx: 3, fill: 'var(--surface)', 'fill-opacity': 0.85 });
      var label = pfEl('text', { x: tx, y: n.cy - 2, class: 'pf-node-label' });
      label.textContent = n.label;
      var meta = pfEl('text', { x: tx, y: n.cy + 12, class: 'pf-node-count', fill: PF_KIND_COLOR[n.kind] });
      meta.textContent = '0';
      pfNodeLayer.appendChild(halo); pfNodeLayer.appendChild(rect); pfNodeLayer.appendChild(label); pfNodeLayer.appendChild(meta);
      pfNodeVisuals[n.id] = { rect: rect, halo: halo, label: label, meta: meta };
    });

    function pfRender() {
      PF_NODES.forEach(function (n) {
        var v = pfNodeVisuals[n.id];
        v.rect.setAttribute('y', n.y);
        v.rect.setAttribute('height', n.dispHeight);
        v.halo.setAttribute('y', n.cy - 14);
        v.label.setAttribute('y', n.cy - 2);
        v.meta.setAttribute('y', n.cy + 12);
        var total = Math.round(pfDerivedTotal(n.id));
        var pct = n.id === 'scanned' ? 'total' : (pfSourceTotal ? (100 * total / pfSourceTotal).toFixed(1) + '%' : '0%');
        v.meta.textContent = total + ' · ' + pct;
      });
      Object.keys(pfEdges).forEach(function (key) {
        var e = pfEdges[key];
        var s = pfNodeMap[e.source], t = pfNodeMap[e.target];
        var x0 = s.x + s.width, x1 = t.x, midX = (x0 + x1) / 2;
        var d = 'M' + x0 + ',' + e.sy0 + ' C' + midX + ',' + e.sy0 + ' ' + midX + ',' + e.ty0 + ' ' + x1 + ',' + e.ty0 +
          ' L' + x1 + ',' + e.ty1 + ' C' + midX + ',' + e.ty1 + ' ' + midX + ',' + e.sy1 + ' ' + x0 + ',' + e.sy1 + ' Z';
        pfPathByKey[key].setAttribute('d', d);
        pfPathByKey[key].setAttribute('fill', PF_KIND_COLOR[t.kind] || 'var(--text-muted)');
        pfPathByKey[key].setAttribute('fill-opacity', 0.4);
      });
    }

    function pfFrame(now) {
      var dt = Math.min(0.1, (now - pfLastFrame) / 1000);
      pfLastFrame = now;
      var settled = true;
      PF_NODES.forEach(function (n) {
        var target = pfTargetHeight(n);
        if (Math.abs(target - n.dispHeight) > 0.3) settled = false;
        var alpha = 1 - Math.exp(-dt * PF_SMOOTH_RATE);
        n.dispHeight += (target - n.dispHeight) * alpha;
      });
      pfLayoutColumns();
      pfRecomputeEdgeSlices();
      pfRender();
      if (settled) { pfAnimating = false; return; }
      requestAnimationFrame(pfFrame);
    }
    function pfWake() {
      if (pfAnimating) return;
      pfAnimating = true;
      pfLastFrame = performance.now();
      requestAnimationFrame(pfFrame);
    }

    function renderJobPipeline(counts) {
      setPfCounts(counts);
    }

    // rAF keeps running while a background tab is (mostly) inactive, but some browsers throttle
    // it heavily -- waking it explicitly when the Search tab becomes visible again catches up any
    // easing that stalled while it was hidden.
    document.querySelector('[data-tab="search"]').addEventListener('click', pfWake);

    async function loadJobs() {
      var res = await api('/jobs');
      var data = await res.json();
      allJobs = data.jobs || [];
      renderJobPipeline(data.counts || {});
      renderJobs();
      renderInterestedList();
      renderAppliedList();
    }

    var activeInterestedJobId = null;
    var activeInterestedResumeId = null;
    var resumeAutoLoadedForJob = false;
    var coverAutoLoadedForJob = false;
    var pendingReviewQuestion = null;

    function renderReviewHistory(entries) {
      var host = document.getElementById('interested-review-history');
      host.innerHTML = '';
      if (!entries.length) return;
      host.appendChild(el('h3', { className: 'subhead', textContent: 'Answered so far' }));
      entries.forEach(function (entry) {
        host.appendChild(el('p', { className: 'job-reason', textContent: entry.claim }));
      });
    }

    async function loadJobReviewHistory(jobId) {
      var res = await api('/jobs/' + encodeURIComponent(jobId) + '/review');
      var data = await res.json();
      renderReviewHistory(data.entries || []);
    }

    var INTERESTED_SUBTABS = ['assistant', 'resume', 'cover', 'apply'];

    function showInterestedSubtab(name) {
      INTERESTED_SUBTABS.forEach(function (tab) {
        var active = tab === name;
        document.getElementById('interested-' + tab + '-panel').style.display = active ? 'block' : 'none';
        var button = document.getElementById('interested-subtab-' + tab);
        button.classList.toggle('secondary', !active);
      });
    }

    INTERESTED_SUBTABS.forEach(function (tab) {
      document.getElementById('interested-subtab-' + tab).addEventListener('click', function () {
        showInterestedSubtab(tab);
        if (tab === 'resume') maybeAutoLoadResume();
        if (tab === 'cover') maybeAutoLoadCoverLetter();
        // The bank is only ever fetched once at page load, so an answer saved since then (from the
        // Profile tab in another session, or the browser extension) would otherwise show as 0 here
        // until a full page reload. Refetching on every visit to this tab keeps it live instead.
        if (tab === 'apply') loadAnswers();
      });
    });

    /**
     * A resume or cover letter already generated for this job should show up the moment you look at
     * its tab, not stay hidden until you press Generate/Draft again -- that button is for making a
     * new one or a revision, not for revealing one that already exists. These reuse the same
     * fast, no-LLM path the backend already takes when a document exists (reused: true), so
     * opening the tab never triggers a fresh generation for a job that doesn't have one yet.
     */
    function maybeAutoLoadResume() {
      if (resumeAutoLoadedForJob || !activeInterestedJobId) return;
      var job = allJobs.filter(function (j) { return j.id === activeInterestedJobId; })[0];
      if (!job || !job.has_resume) return;
      resumeAutoLoadedForJob = true;
      buildInterestedResume();
    }

    function maybeAutoLoadCoverLetter() {
      if (coverAutoLoadedForJob || !activeInterestedJobId) return;
      var job = allJobs.filter(function (j) { return j.id === activeInterestedJobId; })[0];
      if (!job || !job.has_cover_letter) return;
      coverAutoLoadedForJob = true;
      buildInterestedCoverLetter(false);
    }

    function showInterestedDetail(job) {
      activeInterestedJobId = job.id;
      showInterestedSubtab('assistant');
      var section = document.getElementById('interested-detail-section');
      section.style.display = 'block';
      document.getElementById('interested-detail-title').textContent = job.title;
      document.getElementById('interested-detail-meta').textContent =
        [job.company, job.location].filter(Boolean).join(' · ');
      var reasonEl = document.getElementById('interested-detail-reason');
      reasonEl.textContent = job.fit_reason || '';
      reasonEl.style.display = job.fit_reason ? 'block' : 'none';
      var link = document.getElementById('interested-detail-link');
      if (job.source_url) {
        link.href = job.source_url;
        link.style.display = 'inline-block';
      } else {
        link.style.display = 'none';
      }
      // Review, resume, and cover-letter state are all per-job -- switching to a different job
      // shouldn't carry over a pending question, answer, or preview that belonged to the last one.
      pendingReviewQuestion = null;
      document.getElementById('interested-review-section').style.display = 'none';
      document.getElementById('interested-review-answer').value = '';
      document.getElementById('interested-review-status').textContent = '';
      loadJobReviewHistory(job.id);

      activeInterestedResumeId = null;
      resumeAutoLoadedForJob = false;
      document.getElementById('interested-resume-section').style.display = 'none';
      document.getElementById('interested-resume-status').textContent = '';
      document.getElementById('interested-resume-comment').value = '';
      document.getElementById('interested-resume-critique').style.display = 'none';
      document.getElementById('interested-resume-open-link').removeAttribute('href');

      coverAutoLoadedForJob = false;
      document.getElementById('interested-cover-section').style.display = 'none';
      document.getElementById('interested-cover-status').textContent = '';

      document.getElementById('interested-apply-status').textContent = '';
      renderApplyReadiness();

      // The Resume/Cover-letter subtabs may already be showing from the previously selected job
      // (switching jobs doesn't reset which subtab is active) -- if this one is freshly opened
      // straight to that subtab, load its existing document immediately rather than waiting for a
      // second click on the subtab button, which never comes.
      var currentSubtab = INTERESTED_SUBTABS.filter(function (tab) {
        return document.getElementById('interested-' + tab + '-panel').style.display !== 'none';
      })[0];
      if (currentSubtab === 'resume') maybeAutoLoadResume();
      if (currentSubtab === 'cover') maybeAutoLoadCoverLetter();
    }

    function renderAppliedList() {
      var list = document.getElementById('applied-list');
      list.innerHTML = '';
      var appliedJobs = allJobs.filter(function (j) { return j.fit_status === 'applied'; });
      appliedJobs.sort(function (a, b) { return new Date(b.applied_at || 0) - new Date(a.applied_at || 0); });

      document.getElementById('applied-summary').textContent = appliedJobs.length
        ? appliedJobs.length + ' application' + (appliedJobs.length === 1 ? '' : 's') + ' sent'
        : '';

      if (!appliedJobs.length) {
        list.appendChild(el('p', {
          className: 'empty',
          textContent: 'Nothing applied to yet. Mark a job applied from the Apply tab of an interested job.',
        }));
        return;
      }

      appliedJobs.forEach(function (job) {
        var titleNode = job.source_url
          ? el('a', { className: 'row-title', href: job.source_url, target: '_blank', rel: 'noopener', textContent: job.title })
          : el('span', { className: 'row-title', textContent: job.title });
        var meta = [
          job.company,
          job.location,
          job.applied_at ? 'applied ' + new Date(job.applied_at).toLocaleDateString() : '',
        ].filter(Boolean).join(' · ');

        var body = [
          el('div', { className: 'row-title-line' }, [titleNode]),
          el('div', { className: 'row-meta', textContent: meta }),
        ];

        // "Not applied" read as a status claim contradicting the "N applications sent" line right
        // above it. Every other action in the app is an imperative; this one should be too.
        var undo = el('button', { type: 'button', textContent: 'Mark not applied' });
        undo.addEventListener('click', function () { submitJobFit(job.id, 'unapplied'); });

        list.appendChild(el('div', { className: 'row-item' }, [
          el('div', { className: 'row' }, [
            el('div', {}, body),
            el('div', { className: 'row-actions' }, [undo]),
          ]),
        ]));
      });
    }

    function renderInterestedList() {
      var list = document.getElementById('interested-list');
      list.innerHTML = '';
      var interestedJobs = allJobs.filter(function (j) { return j.fit_status === 'interested'; });
      // Most recently marked first -- this is the "what did I just decide to go after" list, not
      // a freshness-of-posting one, so it sorts on interested_at rather than posted_at/fit_score.
      interestedJobs.sort(function (a, b) { return new Date(b.interested_at || 0) - new Date(a.interested_at || 0); });

      if (!interestedJobs.length) {
        list.appendChild(el('p', {
          className: 'empty',
          textContent: 'No interested jobs yet — mark one from the Jobs tab.',
        }));
        document.getElementById('interested-detail-section').style.display = 'none';
        activeInterestedJobId = null;
        return;
      }

      interestedJobs.forEach(function (job) {
        var hasScore = job.fit_score !== null && job.fit_score !== undefined;
        var badgeText = hasScore ? job.fit_score + '% match' : FIT_LABELS.interested.text;
        // Same direct link the Jobs tab row has -- marking a job interested shouldn't cost the
        // one-click "just take me to the posting" path it had before, only add the workspace below.
        var titleNode = job.source_url
          ? el('a', {
              className: 'row-title', href: job.source_url, target: '_blank', rel: 'noopener',
              textContent: job.title,
            })
          : el('span', { className: 'row-title', textContent: job.title });
        var titleLine = [
          titleNode,
          el('span', { className: 'badge strong', textContent: badgeText }),
        ];
        var meta = [
          job.company,
          job.location,
          job.posted_at ? 'posted ' + new Date(job.posted_at).toLocaleDateString() : '',
        ].filter(Boolean).join(' · ');
        var body = [el('div', { className: 'row-title-line' }, titleLine), el('div', { className: 'row-meta', textContent: meta })];

        var view = el('button', { type: 'button', textContent: 'View' });
        view.addEventListener('click', function () { showInterestedDetail(job); });
        var remove = el('button', { className: 'danger', type: 'button', textContent: 'Remove interest' });
        remove.addEventListener('click', function () { submitJobFit(job.id, 'uninterested'); });

        list.appendChild(el('div', { className: 'row-item' }, [
          el('div', { className: 'row' }, [
            el('div', {}, body),
            el('div', { className: 'row-actions' }, [view, remove]),
          ]),
        ]));
      });

      // Keep showing whichever job was already open across a refresh; default to the newest otherwise.
      var stillActive = interestedJobs.filter(function (j) { return j.id === activeInterestedJobId; })[0];
      showInterestedDetail(stillActive || interestedJobs[0]);
    }

    document.getElementById('interested-review-button').addEventListener('click', async function () {
      if (!activeInterestedJobId) return;
      var statusEl = document.getElementById('interested-review-status');
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Thinking of a question…';
      statusEl.className = 'status';
      try {
        var res = await api('/jobs/' + encodeURIComponent(activeInterestedJobId) + '/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(await errorMessageFromResponse(res, 'review_failed'));
        var data = await res.json();
        pendingReviewQuestion = data.question;
        document.getElementById('interested-review-question').textContent = data.question;
        document.getElementById('interested-review-section').style.display = 'block';
        document.getElementById('interested-review-answer').value = '';
        statusEl.textContent = '';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      } finally {
        button.disabled = false;
      }
    });

    document.getElementById('interested-review-submit').addEventListener('click', async function () {
      if (!activeInterestedJobId) return;
      var answer = document.getElementById('interested-review-answer').value.trim();
      if (!answer) return;
      var statusEl = document.getElementById('interested-review-status');
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Saving…';
      statusEl.className = 'status';
      try {
        var res = await api('/jobs/' + encodeURIComponent(activeInterestedJobId) + '/review-answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: pendingReviewQuestion, answer: answer }),
        });
        if (!res.ok) throw new Error(await errorMessageFromResponse(res, 'save_failed'));
        var data = await res.json();
        renderReviewHistory(data.entries || []);
        document.getElementById('interested-review-section').style.display = 'none';
        document.getElementById('interested-review-answer').value = '';
        pendingReviewQuestion = null;
        statusEl.textContent = 'Saved — added to your profile evidence for this job.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      } finally {
        button.disabled = false;
      }
    });

    function renderInterestedResumeChecks(checks) {
      var host = document.getElementById('interested-resume-checks');
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

    function showInterestedResumeCritique(critique) {
      var critiqueEl = document.getElementById('interested-resume-critique');
      critiqueEl.textContent = critique || '';
      critiqueEl.style.display = critique ? 'block' : 'none';
    }

    // What this posting asked for, and which of it your profile can actually back up. The unproven
    // list is the useful half: each entry is something to go answer on the Ask tab, which is what
    // turns it into evidence the next revision can use. Deliberately not framed as a score -- an
    // unproven requirement is a gap to close, not a grade.
    function renderResumeCoverage(coverage) {
      var host = document.getElementById('interested-resume-coverage');
      host.innerHTML = '';
      if (!coverage || !coverage.items || !coverage.items.length) {
        host.style.display = 'none';
        return;
      }
      host.style.display = 'block';
      host.appendChild(el('h4', { textContent: 'What this posting asks for' }));
      host.appendChild(el('p', {
        className: 'hint',
        textContent: coverage.proven + ' backed by your profile, ' + coverage.partial +
          ' partly, ' + coverage.unproven + ' not yet.',
      }));
      var list = el('ul', { className: 'checks' });
      coverage.items.forEach(function (item) {
        var mark = item.status === 'proven' ? '✓' : item.status === 'partial' ? '~' : '·';
        var severity = item.status === 'proven' ? 'ok' : item.status === 'partial' ? 'warning' : 'error';
        var text = item.requirement + (item.evidence ? ' — ' + item.evidence : '');
        list.appendChild(el('li', { className: severity }, [
          el('span', { className: 'mark', textContent: mark }),
          el('span', { textContent: text }),
        ]));
      });
      host.appendChild(list);
    }

    // Embedded PDF viewers inside an iframe are unreliable on some phones -- notably iOS Safari,
    // which often renders only a static first page with no scrolling and no visible page break.
    // The direct link opens the exact same file as a real navigation, which uses the browser's
    // actual PDF viewer (full scroll, pinch zoom, page breaks) instead of the embedded one.
    function setInterestedResumePreview(resumeId) {
      var url = '/resumes/' + encodeURIComponent(resumeId) + '/file?v=' + Date.now();
      document.getElementById('interested-resume-frame').src = url;
      document.getElementById('interested-resume-open-link').href = url;
    }

    async function buildInterestedResume() {
      if (!activeInterestedJobId) return;
      var statusEl = document.getElementById('interested-resume-status');
      statusEl.textContent = 'Picking the best version, tailoring it, and reviewing the result…';
      statusEl.className = 'status';
      try {
        var res = await api('/jobs/' + encodeURIComponent(activeInterestedJobId) + '/resume', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(await errorMessageFromResponse(res, 'resume_failed'));
        var data = await res.json();
        activeInterestedResumeId = data.id;
        document.getElementById('interested-resume-section').style.display = 'block';
        setInterestedResumePreview(data.id);
        renderInterestedResumeChecks(data.checks || []);
        renderResumeCoverage(data.coverage);
        showInterestedResumeCritique(data.critique);
        statusEl.textContent = data.reused
          ? 'Showing the version already tailored for this job.'
          : 'Tailored version ' + data.revision + ' ready.';
        statusEl.className = 'status success';
        var job = allJobs.filter(function (j) { return j.id === activeInterestedJobId; })[0];
        if (job) job.has_resume = true;
        renderApplyReadiness();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    }

    async function reviseInterestedResume() {
      if (!activeInterestedResumeId) return;
      var statusEl = document.getElementById('interested-resume-status');
      var comment = document.getElementById('interested-resume-comment').value.trim();
      statusEl.textContent = 'Reviewing the rendered page and revising…';
      statusEl.className = 'status';
      try {
        var res = await api('/resumes/' + encodeURIComponent(activeInterestedResumeId) + '/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ comment: comment }),
        });
        if (!res.ok) throw new Error(await errorMessageFromResponse(res, 'review_failed'));
        var data = await res.json();
        setInterestedResumePreview(activeInterestedResumeId);
        renderInterestedResumeChecks(data.checks || []);
        showInterestedResumeCritique(data.critique);
        statusEl.textContent = 'Revised — now revision ' + data.revision + '.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    }

    document.getElementById('interested-resume-button').addEventListener('click', function () {
      buildInterestedResume();
    });
    document.getElementById('interested-resume-revise').addEventListener('click', function () {
      reviseInterestedResume();
    });

    async function buildInterestedCoverLetter(regenerate) {
      if (!activeInterestedJobId) return;
      var statusEl = document.getElementById('interested-cover-status');
      statusEl.textContent = regenerate ? 'Regenerating…' : 'Drafting…';
      statusEl.className = 'status';
      try {
        var res = await api('/jobs/' + encodeURIComponent(activeInterestedJobId) + '/cover-letter', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ regenerate: !!regenerate }),
        });
        if (!res.ok) throw new Error(await errorMessageFromResponse(res, 'cover_letter_failed'));
        var data = await res.json();
        document.getElementById('interested-cover-section').style.display = 'block';
        document.getElementById('interested-cover-frame').srcdoc = data.content_html || '';
        statusEl.textContent = data.reused ? 'Showing the letter already drafted for this job.' : 'Draft ready.';
        statusEl.className = 'status success';
        var job = allJobs.filter(function (j) { return j.id === activeInterestedJobId; })[0];
        if (job) job.has_cover_letter = true;
        renderApplyReadiness();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    }

    // The Apply tab is a readiness summary rather than an action: it says what has been prepared for
    // this job so far, and lets you record that you sent it. Autofill lands with the extension.
    var applicationAnswers = [];

    function renderApplyReadiness() {
      var host = document.getElementById('interested-apply-readiness');
      host.innerHTML = '';
      var job = allJobs.filter(function (j) { return j.id === activeInterestedJobId; })[0];
      if (!job) return;

      var items = [
        { label: 'Posting link', ready: Boolean(job.source_url) },
        { label: 'Tailored resume', ready: Boolean(job.has_resume) },
        { label: 'Cover letter', ready: Boolean(job.has_cover_letter) },
        { label: 'Answers on file', ready: applicationAnswers.length > 0,
          detail: applicationAnswers.length + ' saved' },
      ];
      var list = el('ul', { className: 'checks' });
      items.forEach(function (item) {
        list.appendChild(el('li', { className: item.ready ? 'ok' : 'warning' }, [
          el('span', { className: 'mark', textContent: item.ready ? '✓' : '!' }),
          el('span', { textContent: item.label + (item.detail ? ' (' + item.detail + ')' : '') }),
        ]));
      });
      host.appendChild(list);

      var alreadyApplied = job.fit_status === 'applied';
      var button = document.getElementById('interested-apply-mark');
      button.textContent = alreadyApplied ? 'Already applied' : 'Mark as applied';
      button.disabled = alreadyApplied;
    }

    document.getElementById('interested-apply-mark').addEventListener('click', async function () {
      if (!activeInterestedJobId) return;
      var statusEl = document.getElementById('interested-apply-status');
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Recording…';
      statusEl.className = 'status';
      try {
        await submitJobFit(activeInterestedJobId, 'applied');
        statusEl.textContent = 'Recorded. Moved to the Applied tab.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
        button.disabled = false;
      }
    });

    function renderAnswers() {
      var list = document.getElementById('answers-list');
      if (!list) {
        renderApplyReadiness();
        return;
      }
      list.innerHTML = '';
      if (!applicationAnswers.length) {
        list.appendChild(el('p', {
          className: 'empty',
          textContent: 'No saved answers yet. Add the questions every form asks so you only answer them once.',
        }));
        return;
      }
      applicationAnswers.forEach(function (entry) {
        var body = [
          el('div', { className: 'row-title', textContent: entry.question_text }),
          el('div', { className: 'row-meta', textContent: entry.answer }),
        ];
        var remove = el('button', { className: 'danger', type: 'button', textContent: 'Remove' });
        remove.addEventListener('click', async function () {
          await api('/application-answers/' + encodeURIComponent(entry.id), { method: 'DELETE' });
          loadAnswers();
        });
        list.appendChild(el('div', { className: 'row-item' }, [
          el('div', { className: 'row' }, [
            el('div', {}, body),
            el('div', { className: 'row-actions' }, [remove]),
          ]),
        ]));
      });
    }

    async function loadAnswers() {
      var res = await api('/application-answers');
      var data = await res.json();
      applicationAnswers = data.answers || [];
      renderAnswers();
      renderApplyReadiness();
    }

    var answerForm = document.getElementById('answer-form');
    if (answerForm) answerForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('answer-status');
      statusEl.textContent = 'Saving…';
      statusEl.className = 'status';
      try {
        var res = await api('/application-answers', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            question: document.getElementById('answer-question').value,
            answer: document.getElementById('answer-value').value,
          }),
        });
        if (!res.ok) throw new Error(await errorMessageFromResponse(res, 'save_failed'));
        document.getElementById('answer-form').reset();
        statusEl.textContent = 'Saved.';
        statusEl.className = 'status success';
        await loadAnswers();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('interested-cover-button').addEventListener('click', function () {
      buildInterestedCoverLetter(false);
    });
    document.getElementById('interested-cover-regenerate').addEventListener('click', function () {
      buildInterestedCoverLetter(true);
    });

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
      countsHost.appendChild(dataRow('Cover letters', String(counts.cover_letters || 0)));
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
        var reset = el('button', { className: 'destructive', type: 'button', textContent: 'Reset' });
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
        { id: 'cover_letters', name: 'Cover letters', note: 'Generated cover letters for interested jobs.' },
        { id: 'notes', name: 'Notes', note: 'Freeform and pasted resume text on Resume > Notes.' },
        { id: 'role_signals', name: 'Desired-role signals', note: 'Links and notes on the Roles tab (Notes sub-tab).' },
      ].forEach(function (collection) {
        var del = el('button', { className: 'destructive', type: 'button', textContent: 'Delete' });
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
    loadAnswers();
    loadData();
  </script>
</body>
</html>`;

function dashboardPage(): Response {
  // The whole dashboard (markup, CSS, JS) is one inline page with no separately-versioned asset
  // URLs, so a cached copy of this response is a cached copy of the entire app -- including bug
  // fixes that already shipped. Explicit no-store (same as every other private response here)
  // instead of leaving it to whatever default heuristic a browser or intermediate cache would
  // otherwise apply to an HTML response with no cache-control header at all.
  return new Response(DASHBOARD_PAGE, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
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

/**
 * The extension calls the Worker from an ATS origin (boards.greenhouse.io and friends), so those
 * requests need CORS. Two deliberate limits keep this from widening the app's attack surface:
 *
 * - Credentials are never allowed. Cookie auth therefore stays strictly same-origin, and a random
 *   web page cannot ride the dashboard's logged-in session. Cross-origin callers must present a
 *   bearer token, which only the enrolled extension has.
 * - Only the handful of paths the extension actually uses are exposed.
 */
const EXTENSION_CORS_PATHS = [
  /^\/auth\/enroll$/,
  /^\/applications\/match$/,
  /^\/application-answers$/,
  /^\/jobs$/,
  /^\/jobs\/[^/]+\/fit$/,
  /^\/resumes\/[^/]+\/file$/,
];

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

/**
 * Which JSON Schema (and tool name / token budget) a task's structured call uses, so a saved eval
 * case's prompt can be resent without duplicating that wiring per case. Kept here rather than in
 * evals.ts because every schema it needs is already in scope in this file or imported above --
 * evals.ts staying schema-agnostic avoids a circular import back into index.ts for the four schemas
 * that are defined here (STRUCTURED_PROFILE_JSON_SCHEMA, RESUME_BASE_SCHEMA, COVER_LETTER_SCHEMA,
 * MATCH_SCHEMA).
 *
 * `resume.design_review` (needs a screenshot, never stored) and `evals.judge` (not a savable case)
 * fall through to null, matching `replayable: false` in tasks.ts.
 */
function replaySpecFor(task: string): ReplaySpec | null {
  switch (task) {
    case "fit.screen":
      return { kind: "structured", schema: SCREEN_BATCH_SCHEMA, toolName: "submit_screen", maxTokens: 4000 };
    case "fit.assess":
      return { kind: "structured", schema: FIT_BATCH_SCHEMA, toolName: "submit_fit_assessment", maxTokens: 7000 };
    case "fit.care_about_topics":
      return { kind: "structured", schema: CARE_ABOUT_TOPICS_SCHEMA, toolName: "submit_topics", maxTokens: 1200 };
    case "companies.discover":
      return { kind: "structured", schema: COMPANY_LIST_SCHEMA, toolName: "submit_companies", maxTokens: 4000 };
    case "profile.structure":
      return { kind: "structured", schema: STRUCTURED_PROFILE_JSON_SCHEMA, toolName: "submit_structured_profile", maxTokens: 2000 };
    case "roles.analyze":
      return { kind: "structured", schema: ROLE_ANALYSIS_SCHEMA, toolName: "submit_role_analysis", maxTokens: 3000 };
    case "review.question":
      return { kind: "text" };
    case "resume.build":
      return { kind: "structured", schema: RESUME_DOC_SCHEMA, toolName: "submit_resume", maxTokens: 4000 };
    case "resume.requirements":
      return { kind: "structured", schema: REQUIREMENTS_SCHEMA, toolName: "submit_requirements", maxTokens: 3000 };
    case "resume.plan_evidence":
      return { kind: "structured", schema: PLAN_SCHEMA, toolName: "submit_plan", maxTokens: 4000 };
    case "resume.select_base":
      return { kind: "structured", schema: RESUME_BASE_SCHEMA, toolName: "submit_resume_base", maxTokens: 1000 };
    case "cover_letter.write":
      return { kind: "structured", schema: COVER_LETTER_SCHEMA, toolName: "submit_cover_letter", maxTokens: 2000 };
    case "application.answers":
      return { kind: "structured", schema: MATCH_SCHEMA, toolName: "submit_application_answers", maxTokens: 3000 };
    default:
      return null;
  }
}

/**
 * The dev console and its data endpoints.
 *
 * Gated on the same device session as everything else: the traces contain the full text of every
 * prompt, which includes the candidate's profile and the postings being assessed. That is at least
 * as sensitive as the dashboard itself, so it gets the same protection rather than being left open
 * on the grounds that it is "just a debug page".
 */
async function devConsole(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;

  const path = url.pathname;
  const method = request.method;
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 90);

  if (method === "GET" && path === "/dev") {
    return new Response(DEV_PAGE, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
    });
  }
  if (method === "GET" && path === "/dev/tasks") {
    return json({ days, tasks: await taskRollups(env.DB, days) });
  }
  if (method === "GET" && path === "/dev/costs") {
    return json(await costSummary(env.DB, days));
  }

  const traceMatch = path.match(/^\/dev\/traces\/(.+)$/);
  if (method === "GET" && traceMatch) {
    const trace = await getTrace(env.DB, decodeURIComponent(traceMatch[1]));
    return trace ? json({ trace }) : json({ error: "not_found" }, 404);
  }
  if (method === "GET" && path === "/dev/traces") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    return json({
      traces: await listTraces(env.DB, {
        task: url.searchParams.get("task") || undefined,
        onlyErrors: url.searchParams.get("errors") === "1",
        limit,
      }),
    });
  }

  // --- Eval harness -----------------------------------------------------------------------

  if (method === "GET" && path === "/dev/evals/cases") {
    return json({ cases: await listEvalCases(env.DB, url.searchParams.get("task") || undefined) });
  }

  if (method === "POST" && path === "/dev/evals/cases") {
    const body = (await request.json().catch(() => ({}))) as {
      task?: string;
      name?: string;
      prompt?: string;
      notes?: string;
      source_trace_id?: string;
    };
    if (!body.task || !replaySpecFor(body.task)) return json({ error: "not_replayable" }, 400);
    if (!body.name?.trim() || !body.prompt?.trim()) return json({ error: "name_and_prompt_required" }, 400);
    const id = await createEvalCase(env.DB, {
      task: body.task,
      name: body.name.trim(),
      prompt: body.prompt,
      notes: body.notes ?? "",
      sourceTraceId: body.source_trace_id ?? null,
    });
    return json({ id });
  }

  const caseRunsMatch = path.match(/^\/dev\/evals\/cases\/([^/]+)\/runs$/);
  if (method === "POST" && caseRunsMatch) {
    const evalCase = await getEvalCase(env.DB, decodeURIComponent(caseRunsMatch[1]));
    if (!evalCase) return json({ error: "not_found" }, 404);
    const spec = replaySpecFor(evalCase.task);
    if (!spec) return json({ error: "not_replayable" }, 400);

    const body = (await request.json().catch(() => ({}))) as { provider?: string; model?: string; prompt?: string };
    const provider = normalizeProvider(body.provider);
    const keyError = providerKeyMissing(env, provider);
    if (keyError) return json({ error: keyError }, 501);
    const model = (body.model ?? "").trim();
    if (!model) return json({ error: "model_required" }, 400);
    const prompt = body.prompt?.trim() ? body.prompt : evalCase.prompt;

    const outcome = await replayTask(env, evalCase.task, spec, provider, model, prompt);

    let judgeScore: number | null = null;
    let judgeReasoning: string | null = null;
    if (outcome.ok) {
      // Judging failure (rate limit, provider hiccup) shouldn't hide a successful replay -- the
      // run is still worth keeping, just unscored.
      try {
        const taskMeta = taskInfo(evalCase.task);
        const judged = await judgeRun(env, taskMeta?.what ?? evalCase.task, prompt, outcome.response, evalCase.notes);
        judgeScore = judged.score;
        judgeReasoning = judged.reasoning;
      } catch {
        judgeReasoning = "Judging failed; the run itself succeeded.";
      }
    }

    const id = await createEvalRun(env.DB, {
      caseId: evalCase.id,
      provider,
      model,
      prompt,
      outcome,
      judgeScore,
      judgeReasoning,
    });
    return json({ id, outcome, judge_score: judgeScore, judge_reasoning: judgeReasoning });
  }

  const caseMatch = path.match(/^\/dev\/evals\/cases\/([^/]+)$/);
  if (method === "GET" && caseMatch) {
    const evalCase = await getEvalCase(env.DB, decodeURIComponent(caseMatch[1]));
    if (!evalCase) return json({ error: "not_found" }, 404);
    return json({ case: evalCase, runs: await listEvalRuns(env.DB, evalCase.id) });
  }
  if (method === "PATCH" && caseMatch) {
    const evalCase = await getEvalCase(env.DB, decodeURIComponent(caseMatch[1]));
    if (!evalCase) return json({ error: "not_found" }, 404);
    const body = (await request.json().catch(() => ({}))) as { prompt?: string; name?: string; notes?: string };
    await updateEvalCase(env.DB, evalCase.id, body);
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}

function extensionCorsOrigin(request: Request, pathname: string): string | null {
  const origin = request.headers.get("origin");
  if (!origin || !origin.startsWith("chrome-extension://")) return null;
  return EXTENSION_CORS_PATHS.some((re) => re.test(pathname)) ? origin : null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    attachTraceSink(env);
    // Costs three failed ALTERs on the first request an isolate serves, and nothing after that.
    await ensureSchema(env);

    const corsOrigin = extensionCorsOrigin(request, url.pathname);
    if (corsOrigin && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }
    if (corsOrigin) {
      const response = await handle(request, env, ctx, url);
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders(corsOrigin))) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    }
    return handle(request, env, ctx, url);
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  {
    if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok", mode: "cloudflare" });
    // Not `startsWith("/dev")` -- that also matches "/devices" and "/devices/:id/revoke",
    // which shadowed the real device-management routes below and 404'd the Devices tab.
    if (url.pathname === "/dev" || url.pathname.startsWith("/dev/")) return devConsole(request, env, url);
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
    if (request.method === "POST" && url.pathname === "/companies/bulk") return bulkAddCompanies(request, env);
    if (request.method === "POST" && url.pathname === "/companies/discover") return discoverCompanies(request, env, ctx);
    if (request.method === "POST" && url.pathname === "/companies/scan") return scanCompanies(request, env, ctx);
    const companyMatch = url.pathname.match(/^\/companies\/([^/]+)$/);
    if (request.method === "PATCH" && companyMatch) return updateCompany(request, env, companyMatch[1]);
    if (request.method === "DELETE" && companyMatch) return deleteCompany(request, env, companyMatch[1]);
    if (request.method === "GET" && url.pathname === "/jobs") return listJobs(request, env);
    if (request.method === "POST" && url.pathname === "/jobs") return createJob(request, env);
    if (request.method === "POST" && url.pathname === "/jobs/process") return processJobs(request, env, ctx);
    if (request.method === "POST" && url.pathname === "/jobs/reassess") return reassessTopMatches(request, env, ctx);
    if (request.method === "GET" && url.pathname === "/data") return dataSummary(request, env);
    if (request.method === "POST" && url.pathname === "/data/purge-stage") return purgeStage(request, env);
    if (request.method === "POST" && url.pathname === "/data/purge-collection") return purgeCollection(request, env);
    const jobFitMatch = url.pathname.match(/^\/jobs\/([^/]+)\/fit$/);
    if (request.method === "PATCH" && jobFitMatch) return setJobFit(request, env, jobFitMatch[1]);
    const jobReviewMatch = url.pathname.match(/^\/jobs\/([^/]+)\/review$/);
    if (request.method === "GET" && jobReviewMatch) return listJobReview(request, env, jobReviewMatch[1]);
    if (request.method === "POST" && jobReviewMatch) return reviewJobQuestion(request, env, jobReviewMatch[1]);
    const jobReviewAnswerMatch = url.pathname.match(/^\/jobs\/([^/]+)\/review-answer$/);
    if (request.method === "POST" && jobReviewAnswerMatch) return createJobReviewAnswer(request, env, jobReviewAnswerMatch[1]);
    const jobResumeMatch = url.pathname.match(/^\/jobs\/([^/]+)\/resume$/);
    if (request.method === "POST" && jobResumeMatch) return buildJobResume(request, env, jobResumeMatch[1]);
    const jobCoverLetterMatch = url.pathname.match(/^\/jobs\/([^/]+)\/cover-letter$/);
    if (request.method === "GET" && jobCoverLetterMatch) return getCoverLetter(request, env, jobCoverLetterMatch[1]);
    if (request.method === "POST" && jobCoverLetterMatch) return buildCoverLetter(request, env, jobCoverLetterMatch[1]);
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
    if (request.method === "GET" && url.pathname === "/application-answers") return listApplicationAnswers(request, env);
    if (request.method === "PUT" && url.pathname === "/application-answers") return saveApplicationAnswer(request, env);
    const answerMatch = url.pathname.match(/^\/application-answers\/([^/]+)$/);
    if (request.method === "DELETE" && answerMatch) return deleteApplicationAnswer(request, env, answerMatch[1]);
    if (request.method === "POST" && url.pathname === "/profile/generate") return generateProfile(request, env);
    if (request.method === "GET" && url.pathname === "/role-signals") return listRoleSignals(request, env);
    if (request.method === "POST" && url.pathname === "/role-signals") return createRoleSignal(request, env);
    const roleSignalMatch = url.pathname.match(/^\/role-signals\/([^/]+)$/);
    if (request.method === "DELETE" && roleSignalMatch) return deleteRoleSignal(request, env, roleSignalMatch[1]);
    if (request.method === "PUT" && url.pathname === "/desired-roles") return saveDesiredRoles(request, env);
    if (request.method === "POST" && url.pathname === "/desired-roles/analyze") return analyzeDesiredRoles(request, env);
    if (request.method === "GET" && url.pathname === "/resumes") return listResumes(request, env);
    if (request.method === "POST" && url.pathname === "/resumes") return createResume(request, env);
    // Ahead of the /resumes/:id routes below, which would otherwise capture "master" as an id.
    if (request.method === "POST" && url.pathname === "/resumes/master") return buildMasterResume(request, env);
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
    if (request.method === "POST" && url.pathname === "/applications/match") return matchApplication(request, env);
    if (request.method === "POST" && url.pathname === "/artifacts") return uploadArtifact(request, env);
    const artifactMatch = url.pathname.match(/^\/artifacts\/(.+)$/);
    if (request.method === "GET" && artifactMatch) return downloadArtifact(request, env, decodeURIComponent(artifactMatch[1]));
    if (request.method === "GET" && url.pathname === "/me") {
      const auth = await requireSession(request, env);
      return auth instanceof Response ? auth : json({ authenticated: true, device: auth });
    }
    return json({ error: "not_found" }, 404);
  }
}
