import { extractText, getDocumentProxy } from "unpdf";
import WordExtractor from "word-extractor";
import { type BrowserWorker } from "@cloudflare/puppeteer";
import {
  type LlmTrace,
  type Provider,
  type TraceSink,
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
import { getManagedPrompt, langfuseConfigured, langfuseTraceUrl } from "./langfuse";
import { resumeFilenameFor } from "./resume-filename.ts";
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
  CAREER_PROFILE_SCHEMA,
  CAREER_PROFILE_SCHEMA_VERSION,
  IMPROVE_AUDIT_SCHEMA,
  type CareerProfile,
  type ImproveQuestion,
  careerProfileHasContent,
  listProfileEntities,
  normalizeCareerProfile,
  normalizeImproveQuestions,
  readCareerProfile,
  renderCareerProfile,
} from "./profile";
import {
  PROFILE_CREATE_PROMPT,
  PROFILE_IMPROVE_APPLY_PROMPT,
  PROFILE_IMPROVE_AUDIT_PROMPT,
  ROLES_ANALYZE_PROMPT,
} from "./prompts";
import { MARKET_RESEARCH_TTL_DAYS, marketCacheKey, researchRoleMarket } from "./market";
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
  type CompanySearchTerm,
  type VerifyReason,
  atsDisplayName,
  companyNameKey,
  detectAtsFromUrl,
  companySearchTermsFromTitles,
  fetchBoardJobs,
  fetchMissingDescriptions,
  fetchWithTimeout,
  filterJobsByRoles,
  htmlToText,
  isReadableAtsProvider,
  locationMatches,
  mergeCompanySearchTerms,
  parseLocationFilter,
  resolveBoard,
  verifyWebsite,
} from "./companies";
import { type AdzunaPosting, adzunaConfigured, aggregateCompanies, searchAdzunaPage } from "./adzuna";
import { resolveWebsiteViaSearch } from "./websearch";
import { companyIdentity, isNonCompanyName } from "./identity";
import { PRESCREEN_PREDICATE, companyFunnel, companyToJobHandoff, funnelViolations } from "./pipeline";
import {
  type IdentityStatus,
  type JobSourceStatus,
  isScannable,
  reconcileCompanyState,
} from "./companystate";
import { CONFIDENCE_FLOOR, type DiscoveryEvidence, resolveWebsiteDeterministic, verifyCandidate } from "./resolver";

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
import {
  type GmailConnection,
  type GmailMatch,
  type GoogleOAuthClient,
  GmailInvalidClientError,
  GmailReconnectRequiredError,
  GmailRedirectMismatchError,
  exchangeGmailCode,
  fetchGmailAddress,
  isSearchableCompanyName,
  readGmailConnection,
  readGoogleOAuthClient,
  refreshGmailAccessToken,
  revokeGmailToken,
  searchGmailForCompany,
} from "./gmail";

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
  /** See src/langfuse.ts. Unset means every call still runs, just not sent to Langfuse. */
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_HOST?: string;
  /** Set to "off" to stop recording model calls. Anything else (including unset) records them. */
  LLM_TRACE?: string;
  /** Installed once per isolate by the router; see attachTraceSink. */
  LLM_TRACE_SINK?: TraceSink;
  /** See src/gmail.ts. Unset means the Settings > Email "Connect Gmail" flow can't start. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** See src/adzuna.ts. Unset means "Find companies" can't run its primary discovery source. */
  ADZUNA_APP_ID?: string;
  ADZUNA_APP_KEY?: string;
  ADZUNA_COUNTRY?: string;
}

type Session = {
  id: string;
  device_name: string;
  expires_at: string;
  revoked_at: string | null;
  /** 'full' for a normal device; 'read_only' for an MCP/reporting credential. */
  scope: string;
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
        cost_usd, latency_ms, ok, error, langfuse_trace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        trace.langfuseTraceId,
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
  // 0018_langfuse.sql
  "ALTER TABLE llm_traces ADD COLUMN langfuse_trace_id TEXT",
  // 0025_career_refactor.sql
  "ALTER TABLE resumes ADD COLUMN role_family TEXT NOT NULL DEFAULT ''",
  // 0026_companies_pipeline.sql
  "ALTER TABLE companies ADD COLUMN fit_score INTEGER",
  "ALTER TABLE companies ADD COLUMN fit_reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE companies ADD COLUMN fit_screened_at TEXT",
  "ALTER TABLE companies ADD COLUMN signal TEXT NOT NULL DEFAULT ''",
  // 0027_companies_verify_pipeline.sql
  "ALTER TABLE companies ADD COLUMN verify_reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE companies ADD COLUMN last_verified_at TEXT",
  // 0028_company_discovery_streams.sql
  "ALTER TABLE companies ADD COLUMN website_source TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE companies ADD COLUMN website_confidence INTEGER",
];

/**
 * Tables this build's code reads, created at runtime if they aren't there yet.
 *
 * Same deploy-path reasoning as ADDITIVE_COLUMNS above, for the case that list cannot cover. A
 * `CREATE TABLE IF NOT EXISTS` is idempotent and backward compatible in both directions in exactly
 * the way an `ADD COLUMN` is -- older code ignores the table, newer code finds it, and running it
 * twice or against a database that already has it does nothing -- so it belongs to the same safety
 * net rather than to the deliberate `wrangler d1 migrations apply` step.
 *
 * The charter stays narrow on purpose: IF NOT EXISTS creates only. Anything that reshapes or
 * rewrites existing rows still needs a human deciding when it happens.
 *
 * These mirror the CREATE TABLE statements in migrations/; the migration files remain the canonical
 * schema for a fresh database.
 */
const ADDITIVE_TABLES = [
  // 0024_role_examples.sql
  `CREATE TABLE IF NOT EXISTS role_examples (
     id TEXT PRIMARY KEY,
     profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
     type TEXT NOT NULL CHECK (type IN ('good', 'bad')),
     source_url TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     parsed_job_json TEXT NOT NULL DEFAULT '{}',
     fetch_status TEXT NOT NULL DEFAULT 'pending',
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  "CREATE INDEX IF NOT EXISTS idx_role_examples_profile ON role_examples(profile_id, type, created_at DESC)",
  // 0025_career_refactor.sql
  `CREATE TABLE IF NOT EXISTS role_market_research (
     id TEXT PRIMARY KEY,
     profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
     cache_key TEXT NOT NULL,
     role_title TEXT NOT NULL,
     locations TEXT NOT NULL DEFAULT '',
     research_json TEXT NOT NULL DEFAULT '{}',
     researched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_role_market_key ON role_market_research(profile_id, cache_key)",
  // 0028_company_discovery_streams.sql
  `CREATE TABLE IF NOT EXISTS company_discovery_streams (
     id TEXT PRIMARY KEY,
     profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
     term TEXT NOT NULL,
     location TEXT NOT NULL DEFAULT '',
     next_page INTEGER NOT NULL DEFAULT 1,
     exhausted INTEGER NOT NULL DEFAULT 0,
     total_available INTEGER,
     postings_seen INTEGER NOT NULL DEFAULT 0,
     last_searched_at TEXT,
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_streams_key ON company_discovery_streams(profile_id, term, location)",
  "CREATE INDEX IF NOT EXISTS idx_discovery_streams_pending ON company_discovery_streams(profile_id, exhausted, last_searched_at)",
  // 0029_profile_improve.sql
  `CREATE TABLE IF NOT EXISTS profile_improvement_questions (
     id TEXT PRIMARY KEY,
     profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
     profile_version TEXT NOT NULL DEFAULT '',
     entity_type TEXT NOT NULL DEFAULT '',
     entity_id TEXT NOT NULL DEFAULT '',
     entity_label TEXT NOT NULL DEFAULT '',
     target_field TEXT NOT NULL DEFAULT '',
     category TEXT NOT NULL DEFAULT 'other',
     priority INTEGER NOT NULL DEFAULT 0,
     question TEXT NOT NULL,
     why_it_matters TEXT NOT NULL DEFAULT '',
     answer_type TEXT NOT NULL DEFAULT 'long_text',
     answer TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'applied', 'dismissed', 'obsolete')),
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     answered_at TEXT,
     applied_at TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS idx_improve_questions_profile ON profile_improvement_questions(profile_id, status)",
  `CREATE TABLE IF NOT EXISTS profile_improvement_audits (
     id TEXT PRIMARY KEY,
     profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
     profile_version TEXT NOT NULL DEFAULT '',
     questions_generated INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  "CREATE INDEX IF NOT EXISTS idx_improve_audits_profile ON profile_improvement_audits(profile_id, created_at DESC)",
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
  for (const statement of [...ADDITIVE_TABLES, ...ADDITIVE_COLUMNS]) {
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

// SameSite=Lax, not Strict: Google's redirect back to /gmail/callback is a top-level cross-site
// GET, and a Strict cookie is withheld on exactly that kind of navigation, which would silently
// break CSRF verification. A short Max-Age is enough -- this only has to survive one round trip
// to Google's consent screen and back.
function gmailStateCookie(token: string): string {
  return `applygo_gmail_state=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

function clearGmailStateCookie(): string {
  return "applygo_gmail_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
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
    `SELECT id, device_name, expires_at, revoked_at, scope
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
  // The whole read-only guarantee, in one place. A read_only credential may look at anything it is
  // allowed to fetch, and may change nothing -- enforced here rather than route by route, so a
  // route added tomorrow is covered without anyone remembering to mark it. Every mutation in this
  // app is a POST/PUT/PATCH/DELETE, so restricting the method is restricting the capability.
  if (session.scope === "read_only" && request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "read_only_credential", detail: "This token can read ApplyGo data but cannot change anything." }, 403);
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

/**
 * POST /devices/read-only -- mints a credential that can read ApplyGo but change nothing.
 *
 * Requires an existing full session, so this is "the signed-in user issuing themselves a reporting
 * key", not a new way in. The raw token is returned exactly once and only its hash is stored; there
 * is no endpoint that can read it back, so a lost token is revoked and replaced, never recovered.
 */
async function createReadOnlyToken(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { label?: string; days?: number };
  const token = randomToken();
  const tokenHash = await sha256(token);
  const days = Math.min(Math.max(Number(body.days) || 365, 1), 365);
  const label = (body.label || "MCP read-only").slice(0, 120);
  await env.DB.prepare(
    `INSERT INTO device_sessions (id, token_hash, device_name, expires_at, scope)
     VALUES (?, ?, ?, datetime('now', ?), 'read_only')`,
  )
    .bind(crypto.randomUUID(), tokenHash, label, `+${days} days`)
    .run();
  // Deliberately not set as a cookie: this is a machine credential for an MCP client, and putting
  // it in the browser's cookie jar would downgrade the current session to read-only.
  return json({ token, scope: "read_only", label, expires_in_days: days }, 201);
}

async function listDevices(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const devices = await env.DB.prepare(
    `SELECT id, device_name, created_at, last_seen_at, expires_at,
            0 AS revoked
     FROM device_sessions
     WHERE revoked_at IS NULL
     ORDER BY created_at DESC`,
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

/** The score (0-100) at or above which a rated posting counts as Recommended. */
function readMatchThreshold(preferencesJson: string): number {
  try {
    const value = (JSON.parse(preferencesJson || "{}") as { match_threshold?: number }).match_threshold;
    if (!Number.isFinite(value)) return 70;
    return Math.min(Math.max(Math.round(value as number), 0), 100);
  } catch {
    return 70;
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

/**
 * One distinct role family the analysis thinks the candidate should search for.
 *
 * `title` and `alternate_titles` are deliberately real job-market categories rather than
 * descriptions of the person: they exist to be matched against actual postings, and a title nobody
 * posts matches nothing. `search_title_terms` is narrower still -- the literal words a deterministic
 * title filter compares against, kept separate from `search_keywords` (body terms) because the two
 * are consumed by different stages with different precision requirements.
 */
type RoleAnalysisEntry = {
  title: string;
  alternate_titles: string[];
  fit_summary: string;
  why_this_fits: { claim: string; evidence: string[] }[];
  seniority: string;
  domains: string[];
  must_have_characteristics: string[];
  nice_to_have_characteristics: string[];
  search_title_terms: string[];
  search_keywords: string[];
  possible_gaps_or_cautions: string[];
};

/**
 * The structured output of `roles.analyze`: a role-independent search summary plus the distinct
 * role families it identified. Regenerated wholesale by Reanalyze -- there's no per-field merge,
 * since re-deriving from the current profile and preferences is the point.
 *
 * Market data lives in a sibling table rather than in here (see `role_market_research`), because it
 * comes from a different process with a different failure mode: candidate reasoning must stay
 * stable and reproducible when a labor-statistics provider is down.
 */
type RoleAnalysis = { summary: string; roles: RoleAnalysisEntry[] };

/** Fills in any field an older stored analysis predates, so v1 records render without guarding. */
function normalizeRoleAnalysisEntry(raw: Record<string, unknown>): RoleAnalysisEntry {
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
  return {
    title: String(raw.title ?? "").trim(),
    alternate_titles: list(raw.alternate_titles),
    // Older analyses stored a single `description`; surfacing it as the fit summary keeps a
    // pre-refactor record readable instead of blank.
    fit_summary: String(raw.fit_summary ?? raw.description ?? "").trim(),
    why_this_fits: (Array.isArray(raw.why_this_fits) ? raw.why_this_fits : [])
      .map((w) => {
        const item = (w ?? {}) as Record<string, unknown>;
        return { claim: String(item.claim ?? "").trim(), evidence: list(item.evidence) };
      })
      .filter((w) => w.claim),
    seniority: String(raw.seniority ?? "").trim(),
    domains: list(raw.domains),
    must_have_characteristics: list(raw.must_have_characteristics),
    nice_to_have_characteristics: list(raw.nice_to_have_characteristics),
    search_title_terms: list(raw.search_title_terms),
    search_keywords: list(raw.search_keywords),
    possible_gaps_or_cautions: list(raw.possible_gaps_or_cautions),
  };
}

function normalizeRoleAnalysis(raw: unknown): RoleAnalysis {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const roles = Array.isArray(input.roles) ? input.roles : [];
  return {
    summary: String(input.summary ?? "").trim(),
    roles: roles
      .map((r) => normalizeRoleAnalysisEntry((r ?? {}) as Record<string, unknown>))
      .filter((r) => r.title),
  };
}

function readRoleAnalysis(preferencesJson: string): RoleAnalysis | null {
  try {
    const analysis = (JSON.parse(preferencesJson || "{}") as { role_analysis?: unknown }).role_analysis;
    if (!analysis || typeof analysis !== "object") return null;
    const normalized = normalizeRoleAnalysis(analysis);
    return normalized.roles.length ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Renders the structured analysis into the flat `desired_roles` string every downstream stage
 * already consumes -- company discovery, board filtering, prescreening, deep fit, resume targeting.
 *
 * Deliberately search-oriented rather than descriptive. The old version flattened each role's prose
 * description, which meant the cheap title filter downstream was deriving match terms from
 * sentences and picking up whatever generic words happened to appear in them. Emitting the explicit
 * title/alternate-title/search-term vocabulary instead gives that filter something precise to work
 * with, and keeps prose that would only add noise (fit rationale, cautions, and especially market
 * and salary text) out of a string whose entire job is finding relevant postings.
 */
function flattenRoleAnalysis(analysis: RoleAnalysis): string {
  return analysis.roles
    .map((r) => {
      const lines = [`## ${r.title}`];
      if (r.alternate_titles.length) lines.push(`Also posted as: ${r.alternate_titles.join(", ")}`);
      if (r.seniority) lines.push(`Seniority: ${r.seniority}`);
      if (r.domains.length) lines.push(`Domains: ${r.domains.join(", ")}`);
      if (r.search_title_terms.length) lines.push(`Title terms: ${r.search_title_terms.join(", ")}`);
      if (r.search_keywords.length) lines.push(`Keywords: ${r.search_keywords.join(", ")}`);
      if (r.must_have_characteristics.length) lines.push(`Must have: ${r.must_have_characteristics.join("; ")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * The explicit title vocabulary for the cheap deterministic board filter, in matchable form.
 * Kept structured (rather than re-parsed out of the flattened string above) so the filter never has
 * to guess which words in a block of prose were meant to be title terms.
 */
function roleTitleTerms(analysis: RoleAnalysis | null): string[] {
  if (!analysis) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const role of analysis.roles) {
    for (const term of [role.title, ...role.alternate_titles, ...role.search_title_terms]) {
      const cleaned = term.trim().toLowerCase();
      if (cleaned.length < 3 || seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

function readStructuredProfile(structuredJson: string): StructuredProfile | null {
  return readCareerProfile(structuredJson);
}

/**
 * Guards a regeneration against losing real evidence, without freezing old mistakes in place.
 *
 * The previous implementation force-merged every old education/experience entry back into each new
 * generation. That was the right safety net for the old schema, where the model was told to treat
 * the existing profile as a baseline to extend. It is the wrong one now: the model is deliberately
 * rebuilding the whole record from the source documents, so union-ing the old objects back in
 * re-introduces exactly what regeneration is supposed to fix -- duplicate entries for one job
 * described across three resumes, and stale categorization that no amount of better source material
 * could ever dislodge.
 *
 * So this validates rather than merges. A regeneration that came back with materially less career
 * history than the record it replaces is treated as a failed generation (a truncated response, a
 * model that lost its place mid-output) and the existing profile is kept. A regeneration that holds
 * its ground is accepted whole, duplicates collapsed and categories corrected. The source documents
 * remain on file either way, so the recovery path for a rejected generation is simply to run it
 * again rather than to reconstruct anything by hand.
 */
function acceptRegeneratedProfile(
  existing: StructuredProfile | null,
  incoming: StructuredProfile,
): { profile: StructuredProfile; rejected: boolean } {
  if (!existing) return { profile: incoming, rejected: false };

  // Deliberately counts organizations and institutions rather than entries: collapsing three
  // duplicate descriptions of one employer into one entry is a *correct* regeneration that must not
  // trip this, while genuinely dropping an employer must.
  const namesOf = (profile: StructuredProfile) =>
    new Set(
      [
        ...profile.work_experience.map((e) => e.organization),
        ...profile.education.map((e) => e.institution),
      ]
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    );

  const before = namesOf(existing);
  const after = namesOf(incoming);
  const lost = [...before].filter((name) => !after.has(name));

  // One dropped organization out of many is plausibly a correct merge of two spellings of the same
  // employer; losing a large share of them is not something a good regeneration does.
  const lostTooMuch = before.size > 0 && lost.length > Math.max(1, Math.floor(before.size * 0.34));
  if (lostTooMuch) return { profile: existing, rejected: true };

  return { profile: incoming, rejected: false };
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
  // Normalized rather than trusted as-is: this endpoint accepts a body from the browser, and the
  // stored record is what every downstream stage indexes into without guarding. Normalizing here
  // also stamps the current schema version, so stored data always says which generation it is.
  const structured = normalizeCareerProfile(body.structured);
  const profileId = await getOrCreateProfileId(env);
  // Recomputed on every save so the compact matching profile can never lag the real one.
  await env.DB.prepare(
    `UPDATE candidate_profiles SET structured_json = ?, summary = ?, match_profile = ?,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(
      JSON.stringify(structured),
      structured.career_summary.narrative_summary.slice(0, 4000),
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

async function setMatchThreshold(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { match_threshold?: number };
  if (!Number.isFinite(body.match_threshold)) return json({ error: "invalid_threshold" }, 400);
  const threshold = Math.min(Math.max(Math.round(body.match_threshold as number), 0), 100);

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
  prefs.match_threshold = threshold;
  await env.DB.prepare("UPDATE candidate_profiles SET preferences_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(prefs), profileId)
    .run();
  return json({ match_threshold: threshold });
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

// ---------------------------------------------------------------------------
// Role examples -- Good/Bad job postings the candidate points at as concrete evidence of what they
// do and don't want, alongside the Description notes above. See docs on the `role_examples` table
// (migrations/0024_role_examples.sql) for why this is its own table rather than another
// candidate_evidence category or a job_postings row.
// ---------------------------------------------------------------------------

type RoleExampleType = "good" | "bad";

/** Best-effort structured read of a posting fetched from a URL. Every field is optional -- a
 * partial or empty result just means a thinner example, never a reason to fail the save. */
type ParsedJobExample = {
  title?: string;
  company?: string;
  location?: string;
  employment_type?: string;
  description?: string;
  responsibilities?: string[];
  qualifications?: string[];
  skills?: string[];
};

const JOB_EXAMPLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The job title as the posting states it." },
    company: { type: "string", description: "The hiring company's name." },
    location: { type: "string", description: "Where the role is based, as the posting states it (city, region, or 'Remote')." },
    employment_type: { type: "string", description: "e.g. Full-time, Contract, Remote, Hybrid, Onsite -- whatever the posting specifies." },
    description: { type: "string", description: "A short prose summary of what the role actually is." },
    responsibilities: { type: "array", items: { type: "string" }, description: "The core duties, one per entry." },
    qualifications: { type: "array", items: { type: "string" }, description: "Required and preferred qualifications, one per entry." },
    skills: { type: "array", items: { type: "string" }, description: "Named technologies, tools, or skills the posting calls out." },
  },
  required: ["title", "company"],
} as const;

/** Caps how much of a fetched page's text is sent to the model or kept in the description. */
const JOB_EXAMPLE_TEXT_CAP = 12000;

/**
 * Fetches a job posting URL and asks the model to read it into structured fields, for a Good/Bad
 * example the candidate is pointing at. Every failure mode -- unreachable URL, a non-HTML error
 * page, a scraping block, a missing provider key, a malformed model response -- resolves to `null`
 * rather than throwing, because none of them should stop the example (URL + reason) from saving;
 * see createRoleExample below.
 */
async function fetchRoleExampleJob(
  env: Env,
  provider: Provider,
  sourceUrl: string,
): Promise<ParsedJobExample | null> {
  if (providerKeyMissing(env, provider)) return null;
  try {
    const res = await fetchWithTimeout(sourceUrl, 10000, { redirect: "follow" });
    if (!res || !res.ok) return null;
    const html = await res.text();
    const text = htmlToText(html).slice(0, JOB_EXAMPLE_TEXT_CAP);
    if (!text) return null;

    const prompt = await getManagedPrompt(env, "roles/extract_example", {
      source_url: sourceUrl,
      posting_text: text,
    });
    const parsed = await callStructured<ParsedJobExample>(
      env,
      provider,
      "roles.extract_example",
      prompt,
      JOB_EXAMPLE_SCHEMA,
      "submit_job_example",
      2000,
    );
    return parsed && parsed.title ? parsed : null;
  } catch {
    return null;
  }
}

type RoleExampleRow = {
  id: string;
  type: RoleExampleType;
  source_url: string;
  reason: string;
  parsed_job_json: string;
  fetch_status: string;
  created_at: string;
  updated_at: string;
};

function shapeRoleExample(row: RoleExampleRow) {
  let parsed: ParsedJobExample = {};
  try {
    parsed = JSON.parse(row.parsed_job_json || "{}");
  } catch {
    parsed = {};
  }
  return {
    id: row.id,
    type: row.type,
    source_url: row.source_url,
    reason: row.reason,
    fetch_status: row.fetch_status,
    job: Object.keys(parsed).length ? parsed : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listRoleExamples(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const rows = await env.DB.prepare(
    `SELECT id, type, source_url, reason, parsed_job_json, fetch_status, created_at, updated_at
     FROM role_examples WHERE profile_id = ? ORDER BY created_at DESC`,
  )
    .bind(profileId)
    .all<RoleExampleRow>();
  const shaped = rows.results.map(shapeRoleExample);
  return json({
    good: shaped.filter((r) => r.type === "good"),
    bad: shaped.filter((r) => r.type === "bad"),
  });
}

async function createRoleExample(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    type?: string;
    source_url?: string;
    reason?: string;
    provider?: string;
  };
  const type: RoleExampleType | null = body.type === "good" || body.type === "bad" ? body.type : null;
  const sourceUrl = (body.source_url ?? "").trim();
  const reason = (body.reason ?? "").trim();
  if (!type) return json({ error: "type_required" }, 400);
  if (!sourceUrl) return json({ error: "source_url_required" }, 400);

  const provider = normalizeProvider(body.provider);
  const parsed = await fetchRoleExampleJob(env, provider, sourceUrl);

  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO role_examples (id, profile_id, type, source_url, reason, parsed_job_json, fetch_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, profileId, type, sourceUrl, reason, JSON.stringify(parsed ?? {}), parsed ? "ok" : "failed")
    .run();

  return json(
    shapeRoleExample({
      id,
      type,
      source_url: sourceUrl,
      reason,
      parsed_job_json: JSON.stringify(parsed ?? {}),
      fetch_status: parsed ? "ok" : "failed",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    201,
  );
}

async function updateRoleExample(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { reason?: string };
  if (typeof body.reason !== "string") return json({ error: "reason_required" }, 400);
  const result = await env.DB.prepare(
    "UPDATE role_examples SET reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(body.reason.trim(), id)
    .run();
  return json({ updated: result.meta.changes > 0 });
}

async function deleteRoleExample(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare("DELETE FROM role_examples WHERE id = ?").bind(id).run();
  return json({ deleted: result.meta.changes > 0 });
}

/**
 * Renders one type's examples (good or bad) into the plain-text block analyzeDesiredRoles feeds
 * the model, in the same "one heading + body" shape as everything else in that prompt. The job's
 * parsed fields matter more than the reason -- the reason is supplementary context, the job itself
 * is evidence -- so the posting is described first and the candidate's own words follow.
 */
function formatRoleExamplesForPrompt(examples: RoleExampleRow[]): string {
  return examples
    .map((row) => {
      let parsed: ParsedJobExample = {};
      try {
        parsed = JSON.parse(row.parsed_job_json || "{}");
      } catch {
        parsed = {};
      }
      const headline = parsed.title
        ? `${parsed.title}${parsed.company ? ` at ${parsed.company}` : ""}`
        : row.source_url;
      const lines = [`- ${headline}`];
      if (parsed.location) lines.push(`  Location: ${parsed.location}`);
      if (parsed.employment_type) lines.push(`  Employment type: ${parsed.employment_type}`);
      if (parsed.description) lines.push(`  Summary: ${parsed.description}`);
      if (parsed.responsibilities?.length) lines.push(`  Responsibilities: ${parsed.responsibilities.join("; ")}`);
      if (parsed.qualifications?.length) lines.push(`  Qualifications: ${parsed.qualifications.join("; ")}`);
      if (parsed.skills?.length) lines.push(`  Skills: ${parsed.skills.join(", ")}`);
      if (row.reason) lines.push(`  Why the candidate flagged this: ${row.reason}`);
      lines.push(`  Source: ${row.source_url}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

const strArrayProp = (description: string) => ({ type: "array", items: { type: "string" }, description });

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
            description:
              "A real, recognizable job title employers actually post (e.g. 'Applied AI Engineer'), not a " +
              "sentence and not an invented hybrid of several different careers.",
          },
          alternate_titles: strArrayProp(
            "Other real titles employers commonly use for substantially the same job.",
          ),
          fit_summary: {
            type: "string",
            description: "One or two sentences on why this path makes sense for this specific person.",
          },
          why_this_fits: {
            type: "array",
            description:
              "Each claim paired with the concrete evidence from the candidate's background that supports it. " +
              "Never assert fit without citing what they actually did.",
            items: {
              type: "object",
              properties: {
                claim: { type: "string" },
                evidence: strArrayProp("Specific things from their record that back this claim up."),
              },
              required: ["claim"],
            },
          },
          seniority: { type: "string", description: "The level they could plausibly enter at, e.g. 'Mid to senior'." },
          domains: strArrayProp("Industries or subject areas where this role fits their background."),
          must_have_characteristics: strArrayProp("What a posting must have for this to be a genuine match."),
          nice_to_have_characteristics: strArrayProp("What would make a posting an especially good match."),
          search_title_terms: strArrayProp(
            "Literal title words to match against posting titles. Short, common, recall-oriented -- these feed a " +
              "cheap deterministic filter, not a model.",
          ),
          search_keywords: strArrayProp("Body keywords that indicate this kind of role."),
          possible_gaps_or_cautions: strArrayProp(
            "Honest weaknesses for this path and what would strengthen it. Do not flatter.",
          ),
        },
        required: ["title", "fit_summary"],
      },
      description:
        "Each genuinely distinct role family the candidate should be shown -- not variations on one title. Do " +
        "not blend different fields into one hybrid role that doesn't exist in the job market; a posting only " +
        "has to match ONE entry to be worth surfacing. Typically 3-8 entries.",
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
  const [profileRow, signals, exampleRows] = await Promise.all([
    env.DB.prepare("SELECT preferences_json, match_profile, structured_json FROM candidate_profiles WHERE id = ?")
      .bind(profileId)
      .first<{ preferences_json: string; match_profile: string; structured_json: string }>(),
    env.DB.prepare(
      "SELECT claim FROM candidate_evidence WHERE profile_id = ? AND category = 'role_signal' ORDER BY created_at ASC",
    )
      .bind(profileId)
      .all<{ claim: string }>(),
    env.DB.prepare(
      `SELECT id, type, source_url, reason, parsed_job_json, fetch_status, created_at, updated_at
       FROM role_examples WHERE profile_id = ? ORDER BY created_at ASC`,
    )
      .bind(profileId)
      .all<RoleExampleRow>(),
  ]);

  // Career analysis gets the FULL record, not the compact match profile.
  //
  // The compact rendering exists to make hundreds of cheap prescreen calls affordable, and it earns
  // that by dropping exactly what this call needs most: project work, accomplishments, mentoring,
  // stakeholder contact, leadership. Analyzing careers from it produced recommendations that could
  // only restate titles the candidate had already typed, because the evidence that would suggest an
  // unfamiliar-but-plausible path had been summarized away before the model saw it. This call runs
  // once per meaningful preference change, so the extra tokens are cheap and the lost evidence is
  // not. Falls back to the compact string only when there is no structured profile at all.
  const structuredProfile = readStructuredProfile(profileRow?.structured_json ?? "{}");
  const fullBackground = structuredProfile ? renderCareerProfile(structuredProfile) : "";
  const matchProfile = fullBackground || (profileRow?.match_profile ?? "").trim();
  const notes = signals.results.map((s) => s.claim);
  const goodExamples = exampleRows.results.filter((r) => r.type === "good");
  const badExamples = exampleRows.results.filter((r) => r.type === "bad");
  if (!notes.length && !matchProfile && !goodExamples.length && !badExamples.length) {
    return json({ error: "no_source_material" }, 400);
  }

  const preferencesJson = profileRow?.preferences_json ?? "{}";
  const desiredLocations = readDesiredLocations(preferencesJson);
  const dealbreakers = readDealbreakers(preferencesJson);
  const careAbout = readCareAbout(preferencesJson);

  const prompt = await getManagedPrompt(
    env,
    "roles/analyze",
    {
      candidate_background: matchProfile,
      // Product terminology is now "Preferences", but the variable name is unchanged: renaming it
      // would break any Langfuse template still referencing {{notes_and_links}}, and the variable is
      // not candidate-visible. The heading inside the value carries the new wording.
      notes_and_links: notes.length
        ? `STATED PREFERENCES (desired direction, in the candidate's own words):\n${notes.map((c) => `- ${c}`).join("\n")}`
        : "",
      locations: desiredLocations ? `LOCATIONS THEY'LL WORK IN:\n${desiredLocations}` : "",
      dealbreakers: dealbreakers ? `DEALBREAKERS (hard constraints):\n${dealbreakers}` : "",
      criteria: careAbout ? `PRIORITIES (what they want surfaced and compared):\n${careAbout}` : "",
      good_examples: goodExamples.length
        ? `GOOD EXAMPLES (postings representing work they want):\n${formatRoleExamplesForPrompt(goodExamples)}`
        : "",
      bad_examples: badExamples.length
        ? `BAD EXAMPLES (postings representing work they do not want):\n${formatRoleExamplesForPrompt(badExamples)}`
        : "",
    },
    ROLES_ANALYZE_PROMPT,
  );

  let analysis: RoleAnalysis;
  try {
    const raw = await callStructured<unknown>(
      env,
      provider,
      "roles.analyze",
      prompt,
      ROLE_ANALYSIS_SCHEMA,
      "submit_role_analysis",
      // Several role families, each carrying evidence-backed claims and search vocabulary, needs
      // materially more room than the old title+description pair.
      8000,
    );
    analysis = normalizeRoleAnalysis(raw);
    if (!analysis.roles.length) throw new Error("no_roles_returned");
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

/**
 * Returns cached market research for the current role families, researching any that are missing or
 * stale. Deliberately a separate endpoint from the analysis itself: the Roles page renders its
 * cards from the analysis immediately and fills market context in afterwards, so a slow or failing
 * data provider never delays the part of the page that is about the candidate.
 */
async function getRoleMarketResearch(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const provider = normalizeProvider(url.searchParams.get("provider") ?? undefined);

  const profileId = await getOrCreateProfileId(env);
  const profileRow = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const analysis = readRoleAnalysis(profileRow?.preferences_json ?? "{}");
  if (!analysis) return json({ research: {} });

  const locations = readDesiredLocations(profileRow?.preferences_json ?? "{}");
  const cached = await env.DB.prepare(
    "SELECT cache_key, research_json, researched_at FROM role_market_research WHERE profile_id = ?",
  )
    .bind(profileId)
    .all<{ cache_key: string; research_json: string; researched_at: string }>();

  const byKey = new Map(cached.results.map((row) => [row.cache_key, row]));
  const ttlMs = MARKET_RESEARCH_TTL_DAYS * 24 * 60 * 60 * 1000;
  const out: Record<string, unknown> = {};

  for (const role of analysis.roles) {
    const key = marketCacheKey(role.title, locations);
    const row = byKey.get(key);
    const fresh = row && Date.now() - Date.parse(row.researched_at + "Z") < ttlMs;
    if (row && fresh && !refresh) {
      try {
        out[role.title] = JSON.parse(row.research_json);
        continue;
      } catch {
        // Fall through and re-research rather than serving a corrupted cache row.
      }
    }

    const research = await researchRoleMarket(env, provider, role, locations);
    out[role.title] = research;
    // Cached even when unavailable, so a provider that is blocking us isn't re-hammered on every
    // page load. The TTL still expires it, so recovery is automatic.
    await env.DB.prepare(
      `INSERT INTO role_market_research (id, profile_id, cache_key, role_title, locations, research_json, researched_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(profile_id, cache_key) DO UPDATE SET
         research_json = excluded.research_json, researched_at = CURRENT_TIMESTAMP`,
    )
      .bind(crypto.randomUUID(), profileId, key, role.title, locations, JSON.stringify(research))
      .run();
  }

  return json({ research: out });
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
            assessed_at, manual_status, removed_at, removed_from_status, removal_reason,
            EXISTS(SELECT 1 FROM resumes r WHERE r.job_id = job_postings.id) AS has_resume,
            EXISTS(SELECT 1 FROM cover_letters c WHERE c.job_id = job_postings.id) AS has_cover_letter
     FROM job_postings
     ORDER BY COALESCE(posted_at, created_at) DESC`,
  ).all();
  const profileId = await getOrCreateProfileId(env);
  const profileRow = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const matchThreshold = readMatchThreshold(profileRow?.preferences_json ?? "{}");
  return json({ jobs: jobs.results, counts: await jobPipelineCounts(env, matchThreshold), match_threshold: matchThreshold });
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
// instead of one after another.
const ASSESS_CONCURRENCY = 8;

/**
 * Tier-2 assessment over an already-fetched set of rows: batches them, fires the batches
 * concurrently, and writes+reports each as it completes.
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
  fitThreshold: number,
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
      await emit({ type: "pipeline", stage: "assess", phase: "dispatched", ids: batch.map((item) => item.id) });
      try {
        // Deep assessment gets the FULL record. This is the stage that decides whether the
        // candidate is genuinely plausible for a posting, so summarizing away their project work
        // and per-role skills is exactly the wrong economy -- the cheap prescreen above is where
        // token cost is worth optimizing, and it already uses the compact match profile.
        return await assessJobFitBatch(
          env, provider, renderCareerProfile(structured), desiredRoles, disqualifiers, dealbreakers, careAboutTopics, batch,
        );
      } catch (err) {
        errors.push(`assess: ${(err as Error).message}`);
        failed = true;
        await emit({ type: "pipeline", stage: "assess", phase: "failed", ids: batch.map((item) => item.id) });
        return null;
      }
    },
    async (_batch, results) => {
      if (!results) return;
      await storeFitResults(env, results);
      assessed += results.length;
      // These live buckets use the candidate's current Fit Threshold, exactly like the Jobs page.
      // fit_status remains the model pipeline's legacy fixed verdict; fit_score is the source of
      // truth for user-facing Recommended / Not Recommended categorization.
      for (const result of results) {
        if (result.score < fitThreshold) discarded += 1;
        else recommended += 1;
      }
      await emit({
        type: "pipeline",
        stage: "assess",
        phase: "resolved",
        outcomes: results.map((result) => ({
          id: result.id,
          // Presentation metadata for the Search Sankey only. The stored verdict, score, and Jobs
          // categorization remain unchanged; this simply lets the diagram distinguish the deep
          // model's existing hard-reject verdict from its threshold-based score split.
          outcome: verdictForScore(result.score) === "reject"
            ? "failed"
            : result.score < fitThreshold ? "rejected" : "recommended",
        })),
      });
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
        await emit({ type: "pipeline", stage: "screen", phase: "dispatched", ids: batch.map((item) => item.id) });
        try {
          return await screenJobsBatch(env, provider, matchProfile, desiredRoles, disqualifiers, batch);
        } catch (err) {
          errors.push(`screen: ${(err as Error).message}`);
          screenFailed = true;
          await emit({ type: "pipeline", stage: "screen", phase: "failed", ids: batch.map((item) => item.id) });
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
        await emit({
          type: "pipeline",
          stage: "screen",
          phase: "resolved",
          outcomes: results.map((result) => ({ id: result.id, outcome: result.keep ? "passed" : "rejected" })),
        });
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
      assessRows.results ?? [], assessTotal, readMatchThreshold(profileRow?.preferences_json ?? "{}"), emit,
    );
    assessed = assessResult.assessed;
    errors.push(...assessResult.errors);

    return {
      screened, screened_out: screenedOut, assessed, errors,
      counts: await jobPipelineCounts(env, readMatchThreshold(profileRow?.preferences_json ?? "{}")),
    };
  });
}

/** Row counts per pipeline stage, used for both the Jobs status line and the Data tab. */
async function jobPipelineCounts(env: Env, threshold?: number): Promise<Record<string, number>> {
  if (threshold === undefined) {
    const profile = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles LIMIT 1")
      .first<{ preferences_json: string }>();
    threshold = readMatchThreshold(profile?.preferences_json ?? "{}");
  }
  const rows = await env.DB.prepare(
    `SELECT fit_status, fit_score, CASE WHEN assessed_at IS NULL THEN 0 ELSE 1 END AS completed,
            manual_status, COUNT(*) AS n
     FROM job_postings
     GROUP BY fit_status, fit_score, completed, manual_status`,
  ).all<{ fit_status: string; fit_score: number | null; completed: number; manual_status: string; n: number }>();
  const counts: Record<string, number> = {
    unassessed: 0,
    screened_in: 0,
    screened_out: 0,
    strong: 0,
    possible: 0,
    reject: 0,
    interested: 0,
    applied: 0,
    manual_interested: 0,
    manual_removed: 0,
    good_fit: 0,
    bad_fit: 0,
    unrated: 0,
    ruled_out: 0,
  };
  let total = 0;
  for (const row of rows.results ?? []) {
    total += row.n;
    if (row.manual_status === "interested") counts.manual_interested += row.n;
    else if (row.manual_status === "removed") counts.manual_removed += row.n;
    else counts[row.fit_status] = (counts[row.fit_status] ?? 0) + row.n;

    const hasCompletedScore = row.completed === 1 && Number.isFinite(row.fit_score) &&
      (row.fit_score as number) >= 0 && (row.fit_score as number) <= 100;
    if (!hasCompletedScore && row.fit_status === "screened_out") counts.ruled_out += row.n;
    else if (!hasCompletedScore) counts.unrated += row.n;
    else if ((row.fit_score as number) >= threshold) counts.good_fit += row.n;
    else counts.bad_fit += row.n;
  }
  counts.total = total;

  // THE shared Pre-screen figure -- the identical predicate Companies uses, imported from
  // pipeline.ts rather than restated here. Companies' last node and Jobs' first node are the same
  // rows by construction, which is what makes moving between the two pages continue one diagram
  // instead of showing two numbers that nearly agree.
  const prescreen = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM job_postings WHERE ${PRESCREEN_PREDICATE}`,
  ).first<{ n: number }>();
  counts.prescreen_jobs = prescreen?.n ?? 0;

  return counts;
}

/**
 * Row/unit counts per Companies-pipeline stage -- Discovery / Verify / (existing) Pre-screen handoff
 * -- used by the Companies status line, its pipeline visual, and the Data tab. There is deliberately
 * no fit/score bucket here: a company's worth is never judged at this level (see companies.ts's
 * header comment).
 *
 * The three stages are three different *units*, on purpose -- see the Companies Sankey's own header
 * comment for why that's never blurred together:
 * - `discovery_postings`: real Adzuna job POSTINGS looked at so far (summed across every search
 *   stream), the raw discovery material itself -- not a company count. `discovery_companies` is the
 *   unique-company count extracted from those postings, shown as a secondary figure alongside it.
 * - `verified`/`unverified` (+ its per-reason breakdown, for the Unverified tab's filter chips) are
 *   COMPANY counts, straight off `companies.status`/`verify_reason`.
 * - `prescreen_jobs` counts JOBS, not companies -- the number of `job_postings` rows sourced from a
 *   company that haven't completed Jobs' own screening yet (`fit_status = 'unassessed'`), the exact
 *   same column/value Jobs' own pipeline counts treat as its own Pre-screen stage. This is
 *   deliberate: Companies' Pre-screen number and Jobs' Pre-screen number must always agree, because
 *   they're reading the same rows, not two independently computed totals that could drift apart.
 */
async function companiesPipelineCounts(env: Env, profileId: string): Promise<Record<string, number>> {
  // Grouped on the two real axes. The legacy status/verify_reason pair is no longer read here --
  // it is a projection now, not the source of truth, and counting from a projection is how the
  // page ended up disagreeing with itself.
  const rows = await env.DB.prepare(
    `SELECT identity_status, job_source_status, COUNT(*) AS n FROM companies
     WHERE profile_id = ? GROUP BY identity_status, job_source_status`,
  )
    .bind(profileId)
    .all<{ identity_status: string; job_source_status: string; n: number }>();

  const counts: Record<string, number> = {
    identity_pending: 0, identity_verified: 0, identity_ambiguous: 0,
    identity_unresolved: 0, identity_not_a_company: 0, identity_dismissed: 0,
    source_pending: 0, source_supported: 0, source_unsupported_ats: 0,
    source_careers_only: 0, source_no_board: 0, source_board_unreachable: 0,
  };
  let total = 0;
  for (const row of rows.results ?? []) {
    total += row.n;
    const identityKey = `identity_${row.identity_status}`;
    if (identityKey in counts) counts[identityKey] += row.n;
    // Job-source counts are scoped to verified companies, matching the funnel: a pending job source
    // on an unresolved company means "never reached", not "checked and found nothing".
    if (row.identity_status === "verified") {
      const sourceKey = `source_${row.job_source_status}`;
      if (sourceKey in counts) counts[sourceKey] += row.n;
    }
  }
  counts.total = total;

  const streams = await env.DB.prepare(
    "SELECT COALESCE(SUM(postings_seen), 0) AS n FROM company_discovery_streams WHERE profile_id = ?",
  )
    .bind(profileId)
    .first<{ n: number }>();
  counts.discovery_postings = streams?.n ?? 0;

  // THE shared Pre-screen number. Same predicate Jobs uses, imported rather than restated, so the
  // two pages cannot drift.
  const prescreen = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM job_postings WHERE ${PRESCREEN_PREDICATE}`,
  ).first<{ n: number }>();
  counts.prescreen_jobs = prescreen?.n ?? 0;

  // Legacy aliases, still read by parts of the UI not yet migrated. Derived from the new axes so
  // they cannot disagree with them.
  counts.verified = counts.identity_verified;
  counts.discovered = counts.identity_pending;
  counts.dismissed = counts.identity_dismissed;
  counts.unverified = counts.identity_unresolved + counts.identity_ambiguous;
  counts.discovery_companies = total - counts.identity_dismissed;

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
  const profileId = await getOrCreateProfileId(env);

  const count = async (sql: string): Promise<number> =>
    (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;

  const [companies, jobs, documents, notes, roleSignals, roleExamples, resumes, feedback, coverLetters, applicationAnswers, descBytes, docBytes] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM companies"),
    count("SELECT COUNT(*) AS n FROM job_postings"),
    count("SELECT COUNT(*) AS n FROM source_documents"),
    count("SELECT COUNT(*) AS n FROM candidate_evidence WHERE category = 'note'"),
    count("SELECT COUNT(*) AS n FROM candidate_evidence WHERE category = 'role_signal'"),
    count("SELECT COUNT(*) AS n FROM role_examples"),
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
      role_examples: roleExamples,
      resumes,
      feedback,
      cover_letters: coverLetters,
      application_answers: applicationAnswers,
    },
    pipeline: await jobPipelineCounts(env),
    company_pipeline: await companiesPipelineCounts(env, profileId),
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
    role_examples: "DELETE FROM role_examples",
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
  const body = (await request.json().catch(() => ({}))) as { action?: string; reason?: string };
  const job = await env.DB.prepare("SELECT title, company, manual_status, removed_from_status FROM job_postings WHERE id = ?")
    .bind(id)
    .first<{ title: string; company: string; manual_status: string; removed_from_status: string | null }>();
  if (!job) return json({ error: "not_found" }, 404);

  if (body.action === "interested") {
    // A manual override on top of whatever the AI verdict was -- fit_score/fit_status/fit_reason
    // are never touched, so the rating that made it interesting is still there to see.
    await env.DB.prepare(
      "UPDATE job_postings SET manual_status = 'interested', interested_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(id)
      .run();
    return json({ id, manual_status: "interested" });
  }

  if (body.action === "removed") {
    // Records where the job was (normal or interested) right before removal, so Re-add knows
    // whether to send it back to Interested or let its rating recompute its bucket. fit_score/
    // fit_status/fit_reason are never touched -- removal must never cost a job its rating.
    await env.DB.prepare(
      `UPDATE job_postings SET manual_status = 'removed', removed_at = CURRENT_TIMESTAMP,
       removed_from_status = ?, removal_reason = '' WHERE id = ?`,
    )
      .bind(job.manual_status, id)
      .run();
    return json({ id, manual_status: "removed" });
  }

  if (body.action === "readd") {
    // Restoring from Removed never re-derives a fit_status/fit_score -- there's nothing to
    // recompute, they were never touched in the first place. Recommended/Not Recommended falls out live from
    // the untouched fit_score once manual_status goes back to 'normal'.
    const target = job.removed_from_status === "interested" ? "interested" : "normal";
    await env.DB.prepare(
      `UPDATE job_postings SET manual_status = ?, removed_at = NULL, removed_from_status = NULL,
       removal_reason = '' WHERE id = ?`,
    )
      .bind(target, id)
      .run();
    return json({ id, manual_status: target });
  }

  if (body.action === "set_removal_reason") {
    const reason = (body.reason ?? "").trim();
    const profileId = await getOrCreateProfileId(env);
    // Keep the posting and its durable profile-learning signal in sync. Re-saving an edited
    // reason replaces the prior lesson for this job instead of quietly accumulating duplicates;
    // clearing it also removes the lesson from the profile.
    const statements = [
      env.DB.prepare("UPDATE job_postings SET removal_reason = ? WHERE id = ?").bind(reason, id),
      env.DB.prepare("DELETE FROM job_feedback WHERE profile_id = ? AND job_id = ?").bind(profileId, id),
    ];
    if (reason) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO job_feedback (id, profile_id, job_id, title, company, reason) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), profileId, id, job.title, job.company, reason),
      );
    }
    await env.DB.batch(statements);
    return json({ id, removal_reason: reason });
  }

  if (body.action === "applied") {
    // manual_status is already 'interested' by construction -- applying only ever happens from
    // the Interested workspace.
    await env.DB.prepare("UPDATE job_postings SET applied_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return json({ id, applied: true });
  }

  if (body.action === "unapplied") {
    await env.DB.prepare("UPDATE job_postings SET applied_at = NULL WHERE id = ?").bind(id).run();
    return json({ id, applied: false });
  }

  return json({ error: "unknown_action" }, 400);
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

  const prompt = await getManagedPrompt(env, "jobs/review_question", {
    prior_answers_rule: (prior.results ?? []).length
      ? "- Don't repeat ground already covered by these previous answers for this same job:\n" +
        prior.results.map((r) => `  - ${r.claim}`).join("\n")
      : "",
    job_title: job.title,
    company: job.company,
    job_description: job.raw_description.slice(0, 3000),
    candidate_profile: JSON.stringify(profile.structured),
  });

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
    `SELECT id, name, source_name, website, careers_url, board_url, bio, ats_provider, source,
            identity_status, job_source_status, status, verify_reason,
            scan_note, last_scanned_at, last_verified_at, job_source_checked_at, open_jobs,
            created_at, signal, location, website_source, website_confidence, website_evidence
     FROM companies WHERE profile_id = ? ORDER BY name COLLATE NOCASE ASC`,
  )
    .bind(profileId)
    .all();
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM companies WHERE profile_id = ?
       AND identity_status = 'verified' AND job_source_status = 'pending'`,
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
    company_pipeline: await companiesPipelineCounts(env, profileId),
  });
}

/**
 * The single insert path for a company, and the only place a new row's state is decided.
 *
 * Everything written here goes through companyIdentity (so the raw aggregator string is preserved
 * as source_name while the display name is cleaned) and reconcileCompanyState (so an impossible
 * identity/job-source combination is corrected here rather than surfacing in the UI later).
 */
async function addCompanyRow(
  env: Env,
  profileId: string,
  company: {
    name: string;
    website: string;
    careers_url: string;
    bio: string;
    location: string;
    source: string;
    identity?: IdentityStatus;
    jobSource?: JobSourceStatus;
    websiteConfidence?: number | null;
    websiteEvidence?: string;
    websiteSource?: string;
    boardUrl?: string;
    scan_note?: string;
    signal?: string;
  },
): Promise<boolean> {
  const identity = companyIdentity(company.name);
  const { state } = reconcileCompanyState({
    identity: company.identity ?? "pending",
    jobSource: company.jobSource ?? "pending",
    website: company.website,
    websiteConfidence: company.websiteConfidence ?? null,
    websiteEvidence: company.websiteEvidence ?? "",
    boardUrl: company.boardUrl ?? "",
    atsProvider: "",
    atsToken: "",
  });

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO companies
       (id, profile_id, name, name_key, source_name, website, careers_url, bio, location,
        status, verify_reason, identity_status, job_source_status, website_source,
        website_confidence, website_evidence, board_url, source, scan_note, signal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      profileId,
      identity.displayName,
      identity.matchKey,
      identity.sourceName,
      state.website,
      company.careers_url,
      company.bio,
      company.location,
      // Legacy status/verify_reason are still written for one release so a rollback stays possible.
      legacyStatusFor(state),
      legacyVerifyReasonFor(state),
      state.identity,
      state.jobSource,
      company.websiteSource ?? "",
      state.websiteConfidence,
      state.websiteEvidence,
      state.boardUrl,
      company.source,
      company.scan_note ?? "",
      company.signal ?? "",
    )
    .run();
  return result.meta.changes > 0;
}

/** Legacy `status` projection, kept in sync so an older reader still sees something coherent. */
function legacyStatusFor(state: { identity: IdentityStatus; jobSource: JobSourceStatus }): string {
  if (state.identity === "dismissed") return "dismissed";
  if (state.identity !== "verified") return state.identity === "pending" ? "discovered" : "unverified";
  return state.jobSource === "supported" ? "verified" : state.jobSource === "pending" ? "discovered" : "unverified";
}

/** Legacy `verify_reason` projection. */
function legacyVerifyReasonFor(state: { identity: IdentityStatus; jobSource: JobSourceStatus }): string {
  if (state.identity === "unresolved") return "no_website";
  if (state.identity === "ambiguous") return "ambiguous";
  if (state.identity !== "verified") return "";
  switch (state.jobSource) {
    case "unsupported_ats": return "unsupported_ats";
    case "board_unreachable": return "board_unreachable";
    case "no_board":
    case "careers_only": return "no_job_board";
    default: return "";
  }
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
    // A website the candidate typed themselves is identity evidence -- they know who they meant, so
    // it needs no resolver confirmation. Without one, identity stays pending for the resolver.
    identity: (body.website ?? "").trim() ? "verified" : "pending",
    websiteSource: (body.website ?? "").trim() ? "manual" : "",
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
      identity: company.website ? "verified" : "pending",
      websiteSource: company.website ? "manual" : "",
      source: "manual",
    });
    if (wasAdded) added += 1;
  }
  return json({ added, skipped: capped.length - added, total: capped.length }, 201);
}

// ---------------------------------------------------------------------------
// Company search terms -- the visible, editable discovery input
// ---------------------------------------------------------------------------

function readCompanySearchTerms(preferencesJson: string): CompanySearchTerm[] {
  try {
    const raw = (JSON.parse(preferencesJson || "{}") as { company_search_terms?: unknown }).company_search_terms;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((t) => ({
        term: String((t as { term?: unknown })?.term ?? "").trim(),
        source: (t as { source?: unknown })?.source === "manual" ? ("manual" as const) : ("generated" as const),
      }))
      .filter((t) => t.term);
  } catch {
    return [];
  }
}

async function writeCompanySearchTerms(env: Env, profileId: string, terms: CompanySearchTerm[]): Promise<void> {
  const existing = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(existing?.preferences_json || "{}");
  } catch {
    prefs = {};
  }
  prefs.company_search_terms = terms;
  await env.DB.prepare("UPDATE candidate_profiles SET preferences_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(prefs), profileId)
    .run();
}

/**
 * Deterministic, no LLM call -- reuses the exact same title/alternate-title/search-title-term
 * extraction Adzuna discovery's own query-building and the board role-filter already use
 * (roleTitleTerms), rather than running a second, possibly-inconsistent analysis just to name the
 * same roles again. This is also *why* the visible search terms genuinely are what gets searched:
 * they're not a friendly gloss over a separate hidden query, they're the literal terms. The actual
 * capping/title-casing/tagging is companySearchTermsFromTitles (companies.ts) -- pure, so it's the
 * part covered by tests, independent of readRoleAnalysis's DB-shaped input here.
 */
function generateCompanySearchTerms(preferencesJson: string): CompanySearchTerm[] {
  return companySearchTermsFromTitles(roleTitleTerms(readRoleAnalysis(preferencesJson)));
}

/** GET /companies/search-terms -- lazily generates and persists a first suggested set if the
 *  candidate has never had one, so this always has something to show without a separate "generate"
 *  click being required before the terms are visible at all. */
async function getCompanySearchTerms(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const row = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const prefsJson = row?.preferences_json ?? "{}";
  let terms = readCompanySearchTerms(prefsJson);
  if (!terms.length) {
    terms = generateCompanySearchTerms(prefsJson);
    if (terms.length) await writeCompanySearchTerms(env, profileId, terms);
  }
  return json({ terms });
}

/** PUT /companies/search-terms {terms} -- the frontend owns the full list client-side (chips added/
 *  edited/removed there) and syncs the whole thing back here, rather than this being a set of
 *  granular add/remove/edit endpoints -- simpler on both ends for a list this small. */
async function setCompanySearchTerms(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { terms?: unknown };
  if (!Array.isArray(body.terms)) return json({ error: "invalid_terms" }, 400);
  const terms: CompanySearchTerm[] = body.terms
    .map((t) => ({
      term: String((t as { term?: unknown })?.term ?? "").trim().slice(0, 80),
      source: (t as { source?: unknown })?.source === "manual" ? ("manual" as const) : ("generated" as const),
    }))
    .filter((t) => t.term)
    .slice(0, 50);
  const profileId = await getOrCreateProfileId(env);
  await writeCompanySearchTerms(env, profileId, terms);
  return json({ terms });
}

/** POST /companies/search-terms/regenerate -- replaces only the source:'generated' terms with a
 *  fresh extraction from the candidate's current Role Analysis; every source:'manual' term the
 *  candidate typed in survives untouched. This is the explicit "Reset to suggested" action, never
 *  run silently -- the candidate's own edits are otherwise never overwritten by a page load. */
async function regenerateCompanySearchTerms(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const row = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const prefsJson = row?.preferences_json ?? "{}";
  const manual = readCompanySearchTerms(prefsJson).filter((t) => t.source === "manual");
  const generated = generateCompanySearchTerms(prefsJson);
  // Manual terms first -- the candidate's own deliberate additions read as the "primary" list, with
  // suggestions filling in after, rather than a wall of generated chips burying the two they typed.
  const terms = mergeCompanySearchTerms(manual, generated);
  await writeCompanySearchTerms(env, profileId, terms);
  return json({ terms });
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

type DiscoveryStream = {
  id: string;
  term: string;
  location: string;
  next_page: number;
  total_available: number | null;
};

/**
 * Primary -- and only -- company discovery: deterministic, grounded in real current hiring activity
 * via the Adzuna Job Search API (src/adzuna.ts), not LLM recall. No LLM call happens anywhere in
 * this function -- company identity comes straight off Adzuna's structured `company` field, and a
 * real domain is only ever trusted once resolveCompanyDomain's guess-and-verify has confirmed it
 * responds.
 *
 * Resumable: every (search term, location) combination is its own persisted stream
 * (company_discovery_streams) tracking which Adzuna page it's already read. A click processes a
 * bounded batch of not-yet-exhausted streams and advances each one's cursor -- it never restarts a
 * stream from page 1 just because a previous click didn't finish the whole configured search
 * universe, and a stream Adzuna has confirmed has nothing left simply stops being selected.
 */
async function discoverCompanies(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  if (!adzunaConfigured(env)) return json({ error: "adzuna_not_configured" }, 501);

  const body = (await request.json().catch(() => ({}))) as { focus?: string };
  const focus = (body.focus ?? "").trim();

  const profileId = await getOrCreateProfileId(env);
  const profileRow = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const prefsJson = profileRow?.preferences_json ?? "{}";
  const desiredLocations = readDesiredLocations(prefsJson);
  const locationTerms = parseLocationFilter(desiredLocations);

  let searchTerms = readCompanySearchTerms(prefsJson);
  if (!searchTerms.length) {
    searchTerms = generateCompanySearchTerms(prefsJson);
    if (searchTerms.length) await writeCompanySearchTerms(env, profileId, searchTerms);
  }
  if (!searchTerms.length) return json({ error: "no_search_terms" }, 400);
  // Focus is appended to every term as typed by the candidate -- a separate broader-intent input
  // from the concrete search terms above it, not itself one of the persisted terms.
  const whatTerms = searchTerms.map((t) => (focus ? `${t.term} ${focus}` : t.term));
  const whereTerms = locationTerms.length ? locationTerms : [""];

  // Every (term, location) combination gets its own stream row, created once and reused by every
  // future click -- no cap on how many combinations exist, since the per-click budget below (not
  // this list) is what bounds a single request's cost.
  for (const what of whatTerms) {
    for (const where of whereTerms) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO company_discovery_streams (id, profile_id, term, location) VALUES (?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), profileId, what, where)
        .run();
    }
  }

  const activeKeys = new Set(whatTerms.flatMap((what) => whereTerms.map((where) => `${what} ${where}`)));
  const allStreams = await env.DB.prepare(
    `SELECT id, term, location, next_page, total_available FROM company_discovery_streams
     WHERE profile_id = ? AND exhausted = 0
     ORDER BY last_searched_at IS NOT NULL, last_searched_at ASC`,
  )
    .bind(profileId)
    .all<DiscoveryStream>();
  // Only streams matching the *current* configured terms/locations are eligible -- a term the
  // candidate has since removed just stops being picked, with no separate cleanup step needed.
  const eligible = (allStreams.results ?? []).filter((s) => activeKeys.has(`${s.term} ${s.location}`));
  // Bounded per click, same reasoning as the old fixed pair cap -- Adzuna's free tier is
  // rate-limited, and one click should stay a handful of requests. Unlike the old cap, this only
  // bounds *this round's* work: a stream not reached this click is exactly as eligible next click,
  // in front of the line (least-recently-searched first), never silently dropped.
  const batch = eligible.slice(0, 8);

  const existing = await env.DB.prepare("SELECT name FROM companies WHERE profile_id = ?")
    .bind(profileId)
    .all<{ name: string }>();
  const known = new Set((existing.results ?? []).map((r) => companyIdentity(r.name).matchKey));

  return ndjsonResponse(ctx, async (emit) => {
    await emit({
      type: "progress",
      stage: "search",
      message: `Searching ${batch.length} of ${eligible.length} remaining job-market quer${eligible.length === 1 ? "y" : "ies"}…`,
    });

    const queryErrors: string[] = [];
    const allPostings: AdzunaPosting[] = [];
    let searched = 0;
    let rateLimited = false;
    // Deliberately low concurrency compared to this file's usual 6-8 for plain fetches -- Adzuna's
    // free tier has a real per-day/per-second rate limit, unlike verifyWebsite or a board read.
    await runPooled(
      batch,
      2,
      async (stream) => {
        if (rateLimited) return null;
        try {
          return await searchAdzunaPage(env, stream.term, stream.location, stream.next_page, 50);
        } catch (err) {
          const message = (err as Error).message;
          if (message === "adzuna_rate_limited") {
            // Not this stream's fault and not "nothing left" -- leave its cursor untouched so the
            // very next click retries the same page rather than skipping it.
            rateLimited = true;
            return null;
          }
          queryErrors.push(`${stream.term} / ${stream.location || "anywhere"}: ${message}`);
          // A genuine per-query failure still advances last_searched_at (so a broken stream
          // doesn't permanently monopolize the front of the least-recently-searched queue) but
          // never marks it exhausted -- "failed once" isn't "confirmed nothing left".
          await env.DB.prepare("UPDATE company_discovery_streams SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(stream.id)
            .run();
          return null;
        }
      },
      async (stream, result) => {
        searched += 1;
        if (result) {
          allPostings.push(...result.postings);
          const nextPage = stream.next_page + 1;
          const exhausted = result.postings.length === 0 || (stream.next_page - 1) * 50 + result.postings.length >= result.count;
          await env.DB.prepare(
            `UPDATE company_discovery_streams SET next_page = ?, exhausted = ?, total_available = ?,
             postings_seen = postings_seen + ?, last_searched_at = CURRENT_TIMESTAMP WHERE id = ?`,
          )
            .bind(nextPage, exhausted ? 1 : 0, result.count, result.postings.length, stream.id)
            .run();
        }
        await emit({ type: "progress", stage: "search", done: searched, total: batch.length, what: stream.term, where: stream.location });
      },
    );

    const aggregated = aggregateCompanies(allPostings);

    // Employer fields that held an ATS page title rather than a company ("Careers Listing", "Job
    // Board"). Dropped before dedupe so they never become company rows to resolve, display, or
    // explain -- there is no website to find for a string that names no employer.
    const namedCompanies = aggregated.filter((c) => !isNonCompanyName(c.name));
    const notCompanies = aggregated.length - namedCompanies.length;

    const discovered = namedCompanies.filter((c) => {
      // companyIdentity's match key, not the old companyNameKey: it merges "Sargent & Lundy LLC."
      // with "Sargent Lundy" while keeping genuinely distinct employers apart.
      const key = companyIdentity(c.name).matchKey;
      if (!key || known.has(key)) return false;
      known.add(key);
      return true;
    });
    const duplicates = namedCompanies.length - discovered.length;

    // Adzuna's `where` filter is soft-matched on its end, so the same location check is enforced
    // locally too, rather than trusted blindly -- a filter stated to an external system is still
    // worth re-checking.
    const fresh = discovered.filter((c) => locationMatches(c.location, locationTerms));
    const offTarget = discovered.length - fresh.length;

    await emit({
      type: "progress",
      stage: "resolve",
      done: 0,
      total: fresh.length,
      discovered: discovered.length,
      duplicates,
      off_target: offTarget,
    });

    let added = 0;
    let domainResolved = 0;
    let domainUnresolved = 0;
    let checked = 0;
    await runPooled(
      fresh,
      6,
      // The full waterfall, not the old bare slug guess: cleaned-name domain candidates, each one
      // confirmed against what the page says about itself before it is accepted. Discovery evidence
      // (the posting URL the aggregator gave us) is tried first and outranks any guess.
      async (company): Promise<Awaited<ReturnType<typeof resolveWebsiteDeterministic>>> => {
        const evidence: DiscoveryEvidence = {
          name: company.name,
          location: company.location,
          signal: company.signal,
          urls: company.urls ?? [],
        };
        return resolveWebsiteDeterministic(evidence);
      },
      async (company, outcome) => {
        checked += 1;
        if (outcome.status === "resolved") domainResolved += 1;
        else domainUnresolved += 1;

        const resolved = outcome.status === "resolved";
        const ambiguous = outcome.status === "ambiguous";
        const inserted = await addCompanyRow(env, profileId, {
          name: company.name,
          website: outcome.status === "unresolved" ? "" : outcome.website,
          careers_url: "",
          bio: "",
          location: company.location,
          identity: resolved ? "verified" : ambiguous ? "ambiguous" : "unresolved",
          websiteSource: resolved || ambiguous ? outcome.source : "",
          websiteConfidence: resolved || ambiguous ? outcome.confidence : null,
          websiteEvidence: outcome.evidence,
          source: "adzuna",
          scan_note: resolved
            ? "Website confirmed; checking its careers page and job board next."
            : ambiguous
              ? "A possible website was found but could not be confirmed to be this company. Left unverified rather than guessed -- confirm or correct it by hand."
              : "Discovered from real job postings. No website confirmed yet; retried automatically on the next run, and you can add one by hand.",
          signal: company.signal,
        });
        if (inserted) added += 1;
        await emit({
          type: "progress",
          stage: "resolve",
          done: checked,
          total: fresh.length,
          company: company.name,
          resolved: outcome.status === "resolved",
          outcome: outcome.status,
        });
      },
    );

    return {
      added,
      discovered: discovered.length,
      duplicates,
      off_target: offTarget,
      domain_resolved: domainResolved,
      domain_unresolved: domainUnresolved,
      locations: desiredLocations,
      not_companies: notCompanies,
      query_errors: queryErrors,
      rate_limited: rateLimited,
      streams_processed: searched,
      streams_remaining: Math.max(0, eligible.length - searched),
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
  const body = (await request.json().catch(() => ({}))) as { limit?: number; company_id?: string };
  const profileId = await getOrCreateProfileId(env);

  const profileRow = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  const desiredRoles = readDesiredRoles(profileRow?.preferences_json ?? "{}");
  const titleTerms = roleTitleTerms(readRoleAnalysis(profileRow?.preferences_json ?? "{}"));
  const locationTerms = parseLocationFilter(readDesiredLocations(profileRow?.preferences_json ?? "{}"));

  // This bounds how many candidate rows the query below considers, which is cheap -- the actual
  // cost governor is the fetch budget in the loop further down, which already stops early and
  // reports what's left regardless of how high this number goes. So "scan all N companies" can
  // just ask for all N; the budget decides how many of them a single request actually reaches.
  const limit = Math.min(Math.max(Number(body.limit) || 6, 1), 500);
  const targets = body.company_id
    ? await env.DB.prepare(
        "SELECT id, name, website, careers_url, ats_provider, ats_token, last_scanned_at, location, signal, board_url FROM companies WHERE id = ? AND profile_id = ?",
      )
        .bind(body.company_id, profileId)
        .all<CompanyScanRow>()
    : await env.DB.prepare(
        // Only 'dismissed' (user-removed) is excluded, with one narrower exception below.
        // 'unverified' companies are deliberately included, not skipped: verification is retried on
        // every run (a company with no website last time might have one now; a board this app
        // couldn't read might have changed ATS), and a company with a website but no board
        // resolution yet needs this same pass to attempt one. 'discovered' and 'verified' both need
        // it too -- a fresh company for its first check, an already-verified one for its routine
        // board re-read.
        //
        // The exception: 'unsupported_ats' is the one unverified reason that's a real capability
        // limitation of this app, not something a re-check can fix on its own -- retrying it every
        // single click just burns budget confirming the same "yes, still ADP" outcome. Skipped
        // unless it's been at least 14 days since the last check, in case the company migrated ATS
        // platforms since.
        //
        // No "already scanned today" exclusion otherwise: every other eligible company is always a
        // candidate, so a Find companies click re-reads everything regardless of when it was last
        // checked. Ordering by least-recently-scanned first still matters when the fetch budget
        // can't reach everyone in one request -- each round's just-checked companies get a fresh
        // last_scanned_at and sort to the back, so a multi-round run still ends up covering every
        // company exactly once.
        `SELECT id, name, website, careers_url, ats_provider, ats_token, last_scanned_at, location, signal, board_url
         FROM companies
         WHERE profile_id = ? AND identity_status NOT IN ('dismissed', 'not_a_company')
           AND NOT (job_source_status = 'unsupported_ats' AND job_source_checked_at > datetime('now', '-14 days'))
           AND NOT (job_source_status IN ('no_board', 'careers_only') AND job_source_checked_at > datetime('now', '-3 days'))
         ORDER BY last_scanned_at IS NOT NULL, last_scanned_at ASC
         LIMIT ?`,
      )
        .bind(profileId, limit)
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
        return scanOneCompany(env, company, desiredRoles, locationTerms, budget, titleTerms);
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
          verified: outcome.status === "verified",
        });
      },
    );

    // Total eligible companies, not time-gated (beyond the same unsupported_ats cooldown the
    // target query above applies) -- the client uses this against however many it's scanned so
    // far across this click's rounds to know when a Find Jobs run has covered everyone.
    const eligible = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM companies WHERE profile_id = ? AND identity_status NOT IN ('dismissed', 'not_a_company')
       AND NOT (job_source_status = 'unsupported_ats' AND job_source_checked_at > datetime('now', '-14 days'))
       AND NOT (job_source_status IN ('no_board', 'careers_only') AND job_source_checked_at > datetime('now', '-3 days'))`,
    )
      .bind(profileId)
      .first<{ n: number }>();

    return { scanned: results.length, results, new_listings: newListings, eligible_total: eligible?.n ?? 0 };
  });
}

type CompanyScanRow = {
  id: string;
  name: string;
  website: string;
  careers_url: string;
  ats_provider: string;
  ats_token: string;
  last_scanned_at: string | null;
  location: string;
  signal: string;
  board_url: string;
};

/** Minimum confidence resolveWebsiteViaSearch must report before its answer is even attempted --
 *  below this, it's treated the same as "ambiguous", not silently trusted. */
const WEBSITE_SEARCH_CONFIDENCE_FLOOR = 60;

/**
 * The single update path for a company's pipeline state, and the only place scan outcomes are
 * persisted. Everything runs through reconcileCompanyState first, so a caller that computes an
 * impossible combination gets it corrected here instead of writing a contradictory row.
 *
 * Legacy status/verify_reason are projected alongside the new axes for one release, so an older
 * reader (or a rollback) still sees a coherent value.
 */
async function writeCompanyState(
  env: Env,
  companyId: string,
  desired: {
    identity: IdentityStatus;
    jobSource: JobSourceStatus;
    website?: string;
    websiteConfidence?: number | null;
    websiteEvidence?: string;
    websiteSource?: string;
    boardUrl?: string;
    atsProvider?: string;
    atsToken?: string;
    careersUrl?: string;
    scanNote?: string;
    touchScanned?: boolean;
  },
): Promise<{ identity: IdentityStatus; jobSource: JobSourceStatus; repaired: string[] }> {
  const { state, repaired } = reconcileCompanyState({
    identity: desired.identity,
    jobSource: desired.jobSource,
    website: desired.website ?? "",
    websiteConfidence: desired.websiteConfidence ?? null,
    websiteEvidence: desired.websiteEvidence ?? "",
    boardUrl: desired.boardUrl ?? "",
    atsProvider: desired.atsProvider ?? "",
    atsToken: desired.atsToken ?? "",
  });

  await env.DB.prepare(
    `UPDATE companies SET
       identity_status = ?, job_source_status = ?, status = ?, verify_reason = ?,
       website = COALESCE(NULLIF(?, ''), website),
       website_confidence = COALESCE(?, website_confidence),
       website_evidence = COALESCE(NULLIF(?, ''), website_evidence),
       website_source = COALESCE(NULLIF(?, ''), website_source),
       board_url = COALESCE(NULLIF(?, ''), board_url),
       ats_provider = COALESCE(NULLIF(?, ''), ats_provider),
       ats_token = COALESCE(NULLIF(?, ''), ats_token),
       careers_url = COALESCE(NULLIF(?, ''), careers_url),
       scan_note = COALESCE(NULLIF(?, ''), scan_note),
       last_verified_at = CURRENT_TIMESTAMP,
       job_source_checked_at = CURRENT_TIMESTAMP,
       last_scanned_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_scanned_at END,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(
      state.identity,
      state.jobSource,
      legacyStatusFor(state),
      legacyVerifyReasonFor(state),
      state.website,
      state.websiteConfidence,
      state.websiteEvidence,
      desired.websiteSource ?? "",
      state.boardUrl,
      state.atsProvider,
      state.atsToken,
      desired.careersUrl ?? "",
      desired.scanNote ?? "",
      desired.touchScanned === false ? 0 : 1,
      companyId,
    )
    .run();

  return { identity: state.identity, jobSource: state.jobSource, repaired };
}

/** The public board URL for a resolved provider/token pair. One definition, so a board link and a
 *  board read can never disagree about where the board is. */
function boardUrlFor(provider: AtsProvider, token: string): string {
  switch (provider) {
    case "greenhouse": return `https://job-boards.greenhouse.io/${token}`;
    case "lever": return `https://jobs.lever.co/${token}`;
    case "ashby": return `https://jobs.ashbyhq.com/${token}`;
    case "smartrecruiters": return `https://careers.smartrecruiters.com/${token}`;
    case "workday": {
      const [tenant, pod, site] = token.split("|");
      return tenant && pod && site ? `https://${tenant}.${pod}.myworkdayjobs.com/${site}` : "";
    }
    default: return token.includes(".") ? `https://${token}` : "";
  }
}

async function scanOneCompany(
  env: Env,
  company: CompanyScanRow,
  desiredRoles: string,
  locationTerms: string[],
  budget: { remaining: number },
  titleTerms: string[] = [],
): Promise<{ jobs: number; newJobs: number; note: string; status: "verified" | "unverified" }> {
  // No website at all -- nothing for resolveBoard to even try. Can happen for a manually-added
  // company with just a name, a discovered row that reached this query before its domain
  // resolution ever ran, or a company the deterministic slug-guess in discoverCompanies couldn't
  // place. Only ever tried once per company (gated on last_scanned_at being unset) -- the search
  // fallback costs real money, so it isn't worth re-attempting on every single Find companies click
  // the way the free deterministic paths are; a manual "Save website" fix remains available
  // regardless of how this attempt goes.
  if (!company.website) {
    // Free deterministic waterfall first (cleaned-name candidates, each confirmed against what the
    // page says about itself). It runs on every scan, because it costs nothing beyond a couple of
    // HTTP requests and a company unresolvable last week may be resolvable today.
    const deterministic = await resolveWebsiteDeterministic({
      name: company.name,
      location: company.location,
      signal: company.signal,
    });
    if (deterministic.status === "resolved") {
      await writeCompanyState(env, company.id, {
        identity: "verified",
        jobSource: "pending",
        website: deterministic.website,
        websiteConfidence: deterministic.confidence,
        websiteEvidence: deterministic.evidence,
        websiteSource: deterministic.source,
        scanNote: "Website confirmed; checking its job board next.",
        touchScanned: false,
      });
      company = { ...company, website: deterministic.website };
    } else if (!company.last_scanned_at) {
      // Paid, search-grounded fallback. Only on a company's first scan: it costs real money, so it
      // is not worth re-spending on every click the way the free paths above are. Manual entry
      // stays available regardless of how this goes.
      const found = await resolveWebsiteViaSearch(env, { name: company.name, location: company.location, signal: company.signal });
      if (found && found.official_website && found.confidence >= WEBSITE_SEARCH_CONFIDENCE_FLOOR) {
        // Never trusted on the model's word: the proposed URL is re-verified against real page
        // evidence, exactly like a guessed one.
        const confirmed = await verifyCandidate(company.name, found.official_website);
        if (confirmed && confirmed.score >= CONFIDENCE_FLOOR) {
          await writeCompanyState(env, company.id, {
            identity: "verified",
            jobSource: "pending",
            website: confirmed.url,
            websiteConfidence: confirmed.score,
            websiteEvidence: `search: ${found.reason} | confirmed: ${confirmed.evidence}`,
            websiteSource: "search",
            careersUrl: found.careers_url || "",
            scanNote: "Website found by search and confirmed; checking its job board next.",
            touchScanned: false,
          });
          company = { ...company, website: confirmed.url, careers_url: found.careers_url || company.careers_url };
        } else {
          await writeCompanyState(env, company.id, {
            identity: "ambiguous",
            jobSource: "pending",
            website: found.official_website,
            websiteConfidence: confirmed?.score ?? found.confidence,
            websiteEvidence: `search proposed ${found.official_website} but the page did not confirm it: ${confirmed?.evidence ?? "unreachable"}`,
            websiteSource: "search",
            scanNote: "A website was proposed but could not be confirmed as this company. Confirm or correct it by hand.",
          });
          return { jobs: 0, newJobs: 0, note: "ambiguous company identity", status: "unverified" };
        }
      } else if (found && found.official_website) {
        await writeCompanyState(env, company.id, {
          identity: "ambiguous",
          jobSource: "pending",
          website: found.official_website,
          websiteConfidence: found.confidence,
          websiteEvidence: found.reason,
          websiteSource: "search",
          scanNote: `Multiple companies could match this name. ${found.reason}`.trim(),
        });
        return { jobs: 0, newJobs: 0, note: "ambiguous company identity", status: "unverified" };
      }
    } else if (deterministic.status === "ambiguous") {
      await writeCompanyState(env, company.id, {
        identity: "ambiguous",
        jobSource: "pending",
        website: deterministic.website,
        websiteConfidence: deterministic.confidence,
        websiteEvidence: deterministic.evidence,
        websiteSource: deterministic.source,
        scanNote: "A possible website was found but not confirmed as this company. Confirm or correct it by hand.",
      });
      return { jobs: 0, newJobs: 0, note: "ambiguous company identity", status: "unverified" };
    }
  }
  if (!company.website) {
    await writeCompanyState(env, company.id, {
      identity: "unresolved",
      jobSource: "pending",
      scanNote: "No website could be confirmed for this company yet. Retried automatically, or add one by hand.",
    });
    return { jobs: 0, newJobs: 0, note: "no website confirmed", status: "unverified" };
  }

  let provider = company.ats_provider as AtsProvider | "" | "none";
  let token = company.ats_token;

  if (!provider || provider === "none") {
    // Any URL already on the row may itself name an ATS. This is free and used to be skipped
    // entirely: the patterns only ever ran against careers-page HTML, never against a URL already
    // resolved and stored, which is how a readable Greenhouse board sat on a row labelled "no job
    // board" with its jobs never imported.
    const fromStoredUrl = detectAtsFromUrl(company.careers_url) ?? detectAtsFromUrl(company.board_url ?? "");
    const resolved = fromStoredUrl ?? (await resolveBoard(company.website, company.careers_url, company.name, budget));
    if (!resolved) {
      // A careers page we found but could not classify is NOT "no job board" -- the link is the
      // useful thing to show. Only a company with no hiring surface at all gets no_board.
      const careersUrl = company.careers_url || "";
      await writeCompanyState(env, company.id, {
        identity: "verified",
        jobSource: careersUrl ? "careers_only" : "no_board",
        website: company.website,
        boardUrl: careersUrl,
        scanNote: careersUrl
          ? "Careers page found, but it does not run on a job-board system this app can read. Use the link to browse it directly."
          : "Checked the careers page, common careers paths, and likely Greenhouse, Lever, Ashby, and SmartRecruiters addresses. No job board was found.",
      });
      return { jobs: 0, newJobs: 0, note: careersUrl ? "careers page only" : "no job board found", status: "unverified" };
    }
    provider = resolved.provider;
    token = resolved.token;
  }

  // Some ATS platforms are recognized by their URL but publish no public API to read listings
  // from -- ADP and iCIMS chief among them (see companies.ts's AtsProvider comment for the full
  // list and why). Recognizing the platform is still real progress over "nothing found": the
  // candidate gets a working link straight to the board instead of a dead end, even though this
  // app can't auto-score postings on it. This check runs on every call, not just a fresh
  // resolution, since a company already labeled this way from a prior scan skips resolveBoard
  // above entirely and would otherwise fall through into fetchBoardJobs with a provider it has no
  // case for.
  if (!isReadableAtsProvider(provider as AtsProvider)) {
    const boardUrl = token.includes(".") ? `https://${token}` : company.careers_url || company.website;
    const label = atsDisplayName(provider as AtsProvider);
    // Verified company, unsupported board. The limitation is ApplyGo's, not the employer's, and the
    // state model now says so instead of filing this under "unverified".
    await writeCompanyState(env, company.id, {
      identity: "verified",
      jobSource: "unsupported_ats",
      website: company.website,
      atsProvider: provider,
      atsToken: token,
      boardUrl,
      careersUrl: boardUrl,
      scanNote: `Hires through ${label}, which this app cannot read automatically yet. View current openings directly.`,
    });
    return { jobs: 0, newJobs: 0, note: `uses ${label}, view directly`, status: "unverified" };
  }

  // A company already read successfully at least once is never demoted back to unverified by a
  // later transient failure -- see classifyVerification's own header comment for why. Only a
  // never-yet-successful company's first failed attempt counts as a real verification outcome.
  const hadPriorSuccess = Boolean(company.last_scanned_at);

  let scanned;
  try {
    budget.remaining -= 1;
    scanned = await fetchBoardJobs(provider as AtsProvider, token);
  } catch (err) {
    // A company that has read successfully before is never demoted by one transient failure.
    await writeCompanyState(env, company.id, {
      identity: "verified",
      jobSource: hadPriorSuccess ? "supported" : "board_unreachable",
      website: company.website,
      atsProvider: provider,
      atsToken: token,
      boardUrl: boardUrlFor(provider as AtsProvider, token),
      scanNote: `Board read failed: ${(err as Error).message}`,
    });
    return { jobs: 0, newJobs: 0, note: "board read failed", status: hadPriorSuccess ? "verified" : "unverified" };
  }

  // A company can qualify on location while most of its postings don't, so each posting is
  // checked on its own rather than inherited from the company.
  const inArea = scanned.filter((job) => locationMatches(job.location, locationTerms));
  const relevant = filterJobsByRoles(inArea, desiredRoles, titleTerms)
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

  await writeCompanyState(env, company.id, {
    identity: "verified",
    jobSource: "supported",
    website: company.website,
    atsProvider: provider,
    atsToken: token,
    boardUrl: boardUrlFor(provider as AtsProvider, token),
    scanNote: note,
  });
  await env.DB.prepare("UPDATE companies SET open_jobs = ? WHERE id = ?").bind(total?.n ?? 0, company.id).run();

  return { jobs: relevant.length, newJobs, note, status: "verified" };
}

async function updateCompany(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    status?: string;
    website?: string;
    careers_url?: string;
  };

  // A website the candidate typed is the manual-fix path. It is still verified before being
  // trusted -- but held to a lower bar than a machine guess: they know which company they meant,
  // so reachability is enough and page-evidence scoring is not required.
  const website = (body.website ?? "").trim();
  if (website) {
    const normalized = website.match(/^https?:\/\//i) ? website : `https://${website}`;
    const reachable = await verifyWebsite(normalized);
    const { identity } = await writeCompanyState(env, id, {
      identity: reachable ? "verified" : "unresolved",
      // Force a fresh board resolution against the corrected domain: whatever was resolved before
      // belonged to the old (wrong) website.
      jobSource: "pending",
      website: reachable ? normalized : "",
      websiteConfidence: reachable ? 100 : null,
      websiteEvidence: reachable ? "entered by hand" : "entered by hand but unreachable",
      websiteSource: "manual",
      careersUrl: (body.careers_url ?? "").trim(),
      scanNote: reachable
        ? "Website set by hand; checking its careers page and job board next."
        : "That website could not be reached -- double-check the address.",
      touchScanned: false,
    });
    if (reachable) {
      await env.DB.prepare("UPDATE companies SET ats_provider = '', ats_token = '', board_url = '' WHERE id = ?").bind(id).run();
    }
    return json({ updated: true, status: identity, reachable });
  }

  if (body.status === "dismissed") {
    const result = await env.DB.prepare(
      "UPDATE companies SET identity_status = 'dismissed', status = 'dismissed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(id)
      .run();
    return json({ updated: result.meta.changes > 0, status: "dismissed" });
  }

  // Re-add: restore the state the row's own stored evidence implies rather than resetting to
  // "discovered" -- a company with a confirmed website and a working board should read as Verified
  // again immediately, not sit mislabeled until its next scan. reconcileCompanyState does the
  // deriving, so this agrees with every other write path by construction.
  const row = await env.DB.prepare("SELECT website, ats_provider, ats_token, board_url, website_confidence FROM companies WHERE id = ?")
    .bind(id)
    .first<{ website: string; ats_provider: string; ats_token: string; board_url: string; website_confidence: number | null }>();
  const readable = row?.ats_provider ? isReadableAtsProvider(row.ats_provider as AtsProvider) : false;
  const { identity } = await writeCompanyState(env, id, {
    identity: row?.website ? "verified" : "pending",
    jobSource: !row?.website
      ? "pending"
      : readable
        ? "supported"
        : row.ats_provider
          ? "unsupported_ats"
          : row.board_url
            ? "careers_only"
            : "pending",
    website: row?.website ?? "",
    websiteConfidence: row?.website_confidence ?? null,
    atsProvider: row?.ats_provider ?? "",
    atsToken: row?.ats_token ?? "",
    boardUrl: row?.board_url ?? "",
    touchScanned: false,
  });
  return json({ updated: true, status: identity });
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

// ---------------------------------------------------------------------------
// Gmail (read-only) -- see src/gmail.ts for the OAuth/token/search logic itself.
//
// Self-hosted ApplyGo has no shared Google OAuth app to fall back on, so the Client ID/Secret are
// normally entered by the user through Settings > Email's guided setup and stored in
// candidate_profiles.google_oauth_json -- resolveGoogleOAuthClient() below is the one place that
// decides where they come from, DB first, GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET env vars as a
// fallback for developers/advanced deployments (see README).
// ---------------------------------------------------------------------------

const GMAIL_OAUTH_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Derived from the incoming request's own origin, so the same code works on localhost and
 * production without a hardcoded domain -- Settings > Email displays this exact value (with a
 * copy button) for the user to paste into their Google OAuth client's Authorized redirect URIs. */
function gmailRedirectUri(request: Request): string {
  return new URL("/gmail/callback", request.url).toString();
}

async function readGmailProfileConnection(env: Env, profileId: string): Promise<GmailConnection | null> {
  const row = await env.DB.prepare("SELECT gmail_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ gmail_json: string }>();
  return readGmailConnection(row?.gmail_json ?? "{}");
}

async function writeGmailProfileConnection(env: Env, profileId: string, connection: GmailConnection): Promise<void> {
  await env.DB.prepare("UPDATE candidate_profiles SET gmail_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(connection), profileId)
    .run();
}

async function readGoogleOAuthProfileClient(env: Env, profileId: string): Promise<GoogleOAuthClient | null> {
  const row = await env.DB.prepare("SELECT google_oauth_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ google_oauth_json: string }>();
  return readGoogleOAuthClient(row?.google_oauth_json ?? "{}");
}

/** DB-stored credentials (entered via Settings > Email) win over the env-var fallback, so a user
 * who fills in the form always gets what they entered even if GOOGLE_CLIENT_ID/SECRET happen to
 * also be set. */
async function resolveGoogleOAuthClient(
  env: Env,
  profileId: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const stored = await readGoogleOAuthProfileClient(env, profileId);
  if (stored) return { clientId: stored.client_id, clientSecret: stored.client_secret };
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  return null;
}

/** The Client ID is not sensitive (it's a public value visible in the browser's own address bar
 * during the consent redirect) and is safe to echo back so Settings > Email can show what's saved;
 * the Client Secret is never read back over the wire once saved. */
async function saveGoogleOAuthCredentials(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { client_id?: string; client_secret?: string };
  const clientId = (body.client_id ?? "").trim();
  const clientSecret = (body.client_secret ?? "").trim();
  if (!clientId || !clientSecret) return json({ error: "client_id_and_secret_required" }, 400);

  const profileId = await getOrCreateProfileId(env);
  const client: GoogleOAuthClient = { client_id: clientId, client_secret: clientSecret, saved_at: new Date().toISOString() };
  await env.DB.prepare("UPDATE candidate_profiles SET google_oauth_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(client), profileId)
    .run();
  return json({ state: "ready", client_id: clientId });
}

async function startGmailConnect(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const client = await resolveGoogleOAuthClient(env, profileId);
  // Reachable only if someone hits this URL directly with nothing configured -- the Connect button
  // itself is hidden until Settings > Email reports state "ready" or beyond. A redirect (not a raw
  // JSON error) keeps this consistent with every other outcome of this top-level navigation.
  if (!client) {
    return new Response(null, { status: 302, headers: { location: "/?gmail_error=not_configured" } });
  }

  const state = randomToken(24);
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: gmailRedirectUri(request),
    response_type: "code",
    scope: GMAIL_OAUTH_SCOPE,
    // offline + consent guarantee a refresh_token comes back even on a reconnect -- without
    // prompt=consent, Google only issues one the very first time an account approves this app.
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      "set-cookie": gmailStateCookie(state),
    },
  });
}

/**
 * Deliberately unauthenticated, the same way exchangeEnrollment is -- Google's redirect back here
 * cannot carry the dashboard's session cookie (it's a fresh top-level navigation from
 * accounts.google.com), so the short-lived state cookie set by startGmailConnect is what proves
 * this callback belongs to a connect flow this same browser actually started.
 *
 * Every outcome (success or failure) redirects back to `/` with a query param rather than
 * rendering a standalone page, so Settings > Email -- not a bare error screen -- is always what
 * the user actually sees, with friendly copy translated client-side from the short error code.
 */
async function handleGmailCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");
  const cookieState = cookieValue(request, "applygo_gmail_state");
  const clearCookie = clearGmailStateCookie();
  const redirectWithError = (errorCode: string, detail?: string): Response => {
    const params = new URLSearchParams({ gmail_error: errorCode });
    if (detail) params.set("gmail_error_detail", detail.slice(0, 200));
    return new Response(null, { status: 302, headers: { location: `/?${params.toString()}`, "set-cookie": clearCookie } });
  };

  // Google redirects back with ?error=... (not ?code=...) when the user declines on the consent
  // screen, or for a handful of other consent-time problems -- access_denied is common enough
  // (someone just changes their mind) to deserve its own friendly copy; anything else falls back
  // to a generic "Google reported an error" with the raw code in technical details.
  if (googleError) {
    return redirectWithError(googleError === "access_denied" ? "access_denied" : "google_error", googleError);
  }
  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectWithError("invalid_request");
  }

  const profileId = await getOrCreateProfileId(env);
  const client = await resolveGoogleOAuthClient(env, profileId);
  if (!client) return redirectWithError("not_configured");

  try {
    const tokens = await exchangeGmailCode(client.clientId, client.clientSecret, code, gmailRedirectUri(request));
    const emailAddress = await fetchGmailAddress(tokens.accessToken);
    await writeGmailProfileConnection(env, profileId, {
      email_address: emailAddress,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_expires_at: tokens.expiresAt,
      connected_at: new Date().toISOString(),
      needs_reconnect: false,
    });
    return new Response(null, {
      status: 302,
      headers: { location: "/?gmail=connected", "set-cookie": clearCookie },
    });
  } catch (err) {
    if (err instanceof GmailInvalidClientError) return redirectWithError("invalid_client");
    if (err instanceof GmailRedirectMismatchError) return redirectWithError("redirect_mismatch");
    return redirectWithError("exchange_failed", (err as Error).message);
  }
}

/**
 * Passive read only -- never attempts a live token refresh, so this can never surface a Gmail
 * problem as the bare 401 the frontend's api() helper treats as "log the whole app out." Reports
 * one of four states Settings > Email renders directly: not_configured (no Client ID/Secret yet),
 * ready (configured, not connected), connected, or needs_reconnect (set by checkGmailReplies the
 * next time a refresh hits invalid_grant -- this endpoint only ever reads that flag, never
 * triggers the refresh that would discover it).
 */
async function getGmailStatus(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const storedClient = await readGoogleOAuthProfileClient(env, profileId);
  const envFallback = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const configured = Boolean(storedClient) || envFallback;
  const connection = await readGmailProfileConnection(env, profileId);

  let state: "not_configured" | "ready" | "connected" | "needs_reconnect";
  if (!configured) state = "not_configured";
  else if (!connection) state = "ready";
  else if (connection.needs_reconnect) state = "needs_reconnect";
  else state = "connected";

  return json({
    state,
    redirect_uri: gmailRedirectUri(request),
    client_id: storedClient?.client_id ?? (envFallback ? env.GOOGLE_CLIENT_ID : "") ?? "",
    using_env_fallback: !storedClient && envFallback,
    email_address: connection?.email_address ?? "",
    connected_at: connection?.connected_at ?? "",
  });
}

async function disconnectGmail(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const connection = await readGmailProfileConnection(env, profileId);
  await env.DB.prepare("UPDATE candidate_profiles SET gmail_json = '{}', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(profileId)
    .run();
  if (connection?.access_token) await revokeGmailToken(connection.access_token);
  return json({ connected: false });
}

type GmailCheckOutcome =
  | { skipped: true }
  | { skipped: false; matches: GmailMatch[]; error?: string };

/**
 * One pass over every applied job, run-to-completion in a single request rather than
 * /companies/scan's multi-round budget pattern -- realistic personal-use volume (tens of applied
 * jobs, not hundreds) comfortably fits Workers' subrequest limits in one call, and results are
 * deliberately not persisted to D1 (they only ever live in the client's in-memory state for this
 * session), so there's no server-side "already checked" state a resumable design would need.
 */
async function checkGmailReplies(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const client = await resolveGoogleOAuthClient(env, profileId);
  if (!client) return json({ error: "google_client_not_configured" }, 500);
  const connection = await readGmailProfileConnection(env, profileId);
  if (!connection) return json({ error: "gmail_not_connected" }, 400);

  let accessToken: string;
  try {
    const refreshed = await refreshGmailAccessToken(client.clientId, client.clientSecret, connection);
    accessToken = refreshed.accessToken;
    if (refreshed.accessToken !== connection.access_token) {
      await writeGmailProfileConnection(env, profileId, {
        ...connection,
        access_token: refreshed.accessToken,
        token_expires_at: refreshed.expiresAt,
        needs_reconnect: false,
      });
    }
  } catch (err) {
    if (err instanceof GmailReconnectRequiredError) {
      // Persisted, not just returned -- so the next Settings > Email load (a passive status read)
      // already shows "needs reconnecting" without this route having to run again.
      await writeGmailProfileConnection(env, profileId, { ...connection, needs_reconnect: true });
      return json({ error: "gmail_reconnect_required" }, 400);
    }
    return json({ error: "gmail_refresh_failed", message: (err as Error).message }, 502);
  }

  const jobs = await env.DB.prepare(
    "SELECT id, company, applied_at FROM job_postings WHERE applied_at IS NOT NULL ORDER BY applied_at DESC",
  ).all<{ id: string; company: string; applied_at: string }>();
  const targets = jobs.results ?? [];

  return ndjsonResponse(ctx, async (emit) => {
    const matchesByJob: Record<string, GmailMatch[]> = {};
    const skipped: string[] = [];
    let done = 0;

    await runPooled<{ id: string; company: string; applied_at: string }, GmailCheckOutcome>(
      targets,
      4,
      async (job) => {
        const name = companyNameKey(job.company);
        if (!isSearchableCompanyName(name)) return { skipped: true };
        try {
          const matches = await searchGmailForCompany(accessToken, name, new Date(job.applied_at));
          return { skipped: false, matches };
        } catch (err) {
          return { skipped: false, matches: [], error: (err as Error).message };
        }
      },
      async (job, outcome) => {
        done += 1;
        if (outcome.skipped) {
          skipped.push(job.id);
        } else {
          matchesByJob[job.id] = outcome.matches;
        }
        await emit({
          type: "progress",
          done,
          total: targets.length,
          job_id: job.id,
          company: job.company,
          found: outcome.skipped ? 0 : outcome.matches.length,
        });
      },
    );

    return { matches: matchesByJob, skipped, checked: targets.length };
  });
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


/**
 * How much of one document's extracted text reaches the model.
 *
 * Was 8,000 characters, which is roughly three pages -- comfortably less than an ordinary two-page
 * resume once formatting artifacts and extraction noise are counted, and far less than the long-form
 * CVs, academic records and multi-role histories people actually upload. Everything past the cut was
 * silently discarded, so the profile could never contain evidence from the back half of a document
 * the candidate had successfully uploaded, and no part of the UI said so.
 *
 * 40,000 characters is about 8-10 pages of professional prose: enough that an ordinary resume or CV
 * is never truncated at all, while still bounding a pathological input. The cap applies ONLY when
 * building model input -- `source_documents.extracted_text` keeps the complete extraction, so
 * raising this later re-reads the full text with no re-upload.
 */
const PROFILE_SOURCE_DOC_CHARS = 40000;

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
  // Every document with text, every time -- regeneration reconsiders the whole record from all
  // available evidence rather than layering the newest upload onto a previous interpretation.
  const docs = await env.DB.prepare(
    `SELECT original_name, extracted_text FROM source_documents
     WHERE profile_id = ? AND LENGTH(extracted_text) > 0 ORDER BY created_at ASC`,
  )
    .bind(profileId)
    .all<{ original_name: string; extracted_text: string }>();
  // Answers the candidate has already given through Improve and that have been integrated into the
  // profile once are first-person evidence too -- surfaced here as supplementary source material so
  // a regeneration that reconsiders the whole record from scratch (see the prompt's "do NOT simply
  // copy the current profile forward" instruction) doesn't need the integration in current_profile
  // alone to survive; the candidate never has to copy anything into Notes by hand.
  const appliedAnswers = await env.DB.prepare(
    `SELECT entity_label, question, answer FROM profile_improvement_questions
     WHERE profile_id = ? AND status = 'applied' ORDER BY applied_at ASC`,
  )
    .bind(profileId)
    .all<{ entity_label: string; question: string; answer: string }>();

  const sourceParts: string[] = [];
  for (const note of notes.results) sourceParts.push(`Note: ${note.claim}`);
  for (const qa of appliedAnswers.results) {
    sourceParts.push(
      `Improve interview answer${qa.entity_label ? ` (${qa.entity_label})` : ""} — Q: ${qa.question}\nA: ${qa.answer}`,
    );
  }
  for (const doc of docs.results) {
    const text = doc.extracted_text.slice(0, PROFILE_SOURCE_DOC_CHARS);
    const truncated = doc.extracted_text.length > PROFILE_SOURCE_DOC_CHARS;
    sourceParts.push(
      `Document "${doc.original_name}":\n${text}` +
        (truncated ? `\n[Document truncated at ${PROFILE_SOURCE_DOC_CHARS} characters.]` : ""),
    );
  }

  if (sourceParts.length === 0) return json({ error: "no_source_material" }, 400);

  const existingStructured = readStructuredProfile(profile?.structured_json ?? "{}");
  const previousEntityIds = existingStructured
    ? listProfileEntities(existingStructured)
        .filter((e) => e.entity_id)
        .map((e) => `${e.entity_id} — ${e.entity_label}`)
        .join("\n")
    : "";
  const prompt = await getManagedPrompt(
    env,
    "profile/create",
    {
      current_profile: existingStructured
        ? `Current profile (previous interpretation, not authoritative):\n${JSON.stringify(existingStructured)}`
        : "",
      source_material: sourceParts.join("\n\n"),
      previous_entity_ids: previousEntityIds,
    },
    PROFILE_CREATE_PROMPT,
  );

  try {
    const raw = await callStructured<unknown>(
      env,
      provider,
      "profile.create",
      prompt,
      CAREER_PROFILE_SCHEMA,
      "submit_structured_profile",
      // The canonical record is deliberately exhaustive, so it needs far more room to come back
      // whole than the old five-field shape did. A truncated profile is the one failure mode that
      // silently loses evidence every downstream stage depends on.
      16000,
    );
    const normalized = normalizeCareerProfile(raw);
    const { profile: draft, rejected } = acceptRegeneratedProfile(existingStructured, normalized);
    return json({ provider, draft_structured: draft, rejected_incomplete: rejected });
  } catch (err) {
    return json({ error: "generation_failed", detail: friendlyMessage(err) }, 502);
  }
}

// ---------------------------------------------------------------------------
// Improve workflow: audit, save/dismiss answers, apply
// ---------------------------------------------------------------------------

type ImproveQuestionRow = {
  id: string;
  profile_version: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  target_field: string;
  category: string;
  priority: number;
  question: string;
  why_it_matters: string;
  answer_type: string;
  answer: string;
  status: string;
  created_at: string;
  answered_at: string | null;
  applied_at: string | null;
};

/**
 * A short, content-derived version tag for the structured profile, stored on every question row so
 * a later pass can tell whether the profile has changed underneath a still-open question. Hash
 * rather than `updated_at`: a save that reorders or re-normalizes without changing meaning would
 * otherwise look like drift it isn't.
 */
async function profileVersionTag(structuredJson: string): Promise<string> {
  const bytes = new TextEncoder().encode(structuredJson);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

function questionDedupeKey(entityType: string, entityId: string, targetField: string): string {
  return `${entityType}|${entityId}|${targetField.trim().toLowerCase()}`;
}

async function loadOpenImproveQuestions(env: Env, profileId: string): Promise<ImproveQuestionRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM profile_improvement_questions
     WHERE profile_id = ? AND status IN ('pending', 'answered') ORDER BY priority DESC, created_at ASC`,
  )
    .bind(profileId)
    .all<ImproveQuestionRow>();
  return rows.results;
}

async function listImproveQuestions(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const questions = await loadOpenImproveQuestions(env, profileId);
  const answered = questions.filter((q) => q.status === "answered").length;
  return json({ questions, answered_count: answered, pending_count: questions.length - answered });
}

/**
 * State B/C's "Find Improvements": audits the current structured profile against everything
 * already asked (so resolved ground is not re-covered), inserts the genuinely new questions, and
 * returns the full open set. A deterministic dedupe key backstops the prompt's own
 * "don't re-ask resolved questions" instruction -- if the model regenerates a near-duplicate of an
 * already-open question for the same entity and field, it is dropped here rather than shown twice.
 */
/** Result shape shared by the route wrapper and applyImproveAnswers' inline re-audit. */
type ImproveAuditResult =
  | { ok: true; questions: ImproveQuestionRow[]; inserted: number; answered_count: number; pending_count: number }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * The audit itself, factored out from the route handler so `applyImproveAnswers` can re-run it
 * in-process after a successful apply without constructing a second authenticated request -- this
 * runs strictly after its caller has already checked the session and the profile exists.
 */
async function runImproveAudit(env: Env, profileId: string, provider: Provider): Promise<ImproveAuditResult> {
  const row = await env.DB.prepare("SELECT structured_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ structured_json: string }>();
  const structured = readCareerProfile(row?.structured_json ?? "{}");
  if (!structured) return { ok: false, status: 400, error: "no_profile_yet" };

  const priorRows = await env.DB.prepare(
    `SELECT entity_type, entity_id, entity_label, target_field, category, question, answer, status
     FROM profile_improvement_questions WHERE profile_id = ? ORDER BY created_at ASC`,
  )
    .bind(profileId)
    .all<{
      entity_type: string; entity_id: string; entity_label: string; target_field: string;
      category: string; question: string; answer: string; status: string;
    }>();

  const priorState = priorRows.results.length
    ? priorRows.results
        .map((q) =>
          `[${q.status}] ${q.entity_label || q.entity_type} / ${q.target_field || q.category}: "${q.question}"` +
          (q.answer ? ` -> answered: "${q.answer}"` : ""),
        )
        .join("\n")
    : "(no prior questions -- this is the first audit of this profile)";

  const prompt = await getManagedPrompt(
    env,
    "profile/improve-audit",
    { career_profile: renderCareerProfile(structured), prior_question_state: priorState },
    PROFILE_IMPROVE_AUDIT_PROMPT,
  );

  let generated: ImproveQuestion[];
  try {
    const raw = await callStructured<unknown>(
      env,
      provider,
      "profile.improve_audit",
      prompt,
      IMPROVE_AUDIT_SCHEMA,
      "submit_improve_questions",
      8000,
    );
    generated = normalizeImproveQuestions((raw as { questions?: unknown })?.questions, structured);
  } catch (err) {
    // Existing profile and question state are untouched on failure -- there is nothing to roll back.
    return { ok: false, status: 502, error: "audit_failed", detail: friendlyMessage(err) };
  }

  const versionTag = await profileVersionTag(row?.structured_json ?? "{}");
  const existingOpen = await loadOpenImproveQuestions(env, profileId);
  const existingKeys = new Set(existingOpen.map((q) => questionDedupeKey(q.entity_type, q.entity_id, q.target_field)));

  let inserted = 0;
  for (const q of generated) {
    const key = questionDedupeKey(q.entity_type, q.entity_id, q.target_field);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    await env.DB.prepare(
      `INSERT INTO profile_improvement_questions
       (id, profile_id, profile_version, entity_type, entity_id, entity_label, target_field, category, priority, question, why_it_matters, answer_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
      .bind(q.id, profileId, versionTag, q.entity_type, q.entity_id, q.entity_label, q.target_field, q.category, q.priority, q.question, q.why_it_matters, q.answer_type)
      .run();
    inserted += 1;
  }

  await env.DB.prepare(
    "INSERT INTO profile_improvement_audits (id, profile_id, profile_version, questions_generated) VALUES (?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), profileId, versionTag, inserted)
    .run();

  const questions = await loadOpenImproveQuestions(env, profileId);
  const answered = questions.filter((q) => q.status === "answered").length;
  return { ok: true, questions, inserted, answered_count: answered, pending_count: questions.length - answered };
}

/** State B/C's "Find Improvements" route: authenticates, validates the provider, then delegates to
 * runImproveAudit above. */
async function findProfileImprovements(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const provider = normalizeProvider(body.provider);
  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 501);
  if (provider === "openai" && !env.OPENAI_API_KEY) return json({ error: "openai_not_configured" }, 501);

  const profileId = await getOrCreateProfileId(env);
  const result = await runImproveAudit(env, profileId, provider);
  if (!result.ok) return json({ error: result.error, detail: result.detail }, result.status);
  return json({ questions: result.questions, inserted: result.inserted, answered_count: result.answered_count, pending_count: result.pending_count });
}

async function saveImproveAnswer(request: Request, env: Env, questionId: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { answer?: string };
  const answer = (body.answer ?? "").trim();
  if (!answer) return json({ error: "answer_required" }, 400);

  const profileId = await getOrCreateProfileId(env);
  const existing = await env.DB.prepare(
    "SELECT status FROM profile_improvement_questions WHERE id = ? AND profile_id = ?",
  )
    .bind(questionId, profileId)
    .first<{ status: string }>();
  if (!existing) return json({ error: "question_not_found" }, 404);
  if (existing.status === "applied") return json({ error: "question_already_applied" }, 409);

  await env.DB.prepare(
    "UPDATE profile_improvement_questions SET answer = ?, status = 'answered', answered_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(answer, questionId)
    .run();
  const updated = await env.DB.prepare("SELECT * FROM profile_improvement_questions WHERE id = ?")
    .bind(questionId)
    .first<ImproveQuestionRow>();
  return json({ question: updated });
}

/** Explicit dismiss -- "I don't remember" / "not applicable" / "don't want to add this" -- distinct
 * from simply leaving a question unanswered. Dismissed questions are excluded from the open set a
 * later audit is shown as still-pending, so they do not immediately resurface. */
async function dismissImproveQuestion(request: Request, env: Env, questionId: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const existing = await env.DB.prepare(
    "SELECT status FROM profile_improvement_questions WHERE id = ? AND profile_id = ?",
  )
    .bind(questionId, profileId)
    .first<{ status: string }>();
  if (!existing) return json({ error: "question_not_found" }, 404);
  if (existing.status === "applied") return json({ error: "question_already_applied" }, 409);

  await env.DB.prepare("UPDATE profile_improvement_questions SET status = 'dismissed' WHERE id = ?")
    .bind(questionId)
    .run();
  return json({ ok: true });
}

/**
 * State D's "Apply Answers & Continue": integrates every saved-but-unapplied answer into the
 * canonical profile via an LLM pass, then immediately re-audits so the next round of questions is
 * ready without a second click. Atomic in the sense the spec asks for: a question is marked
 * `applied` only after both the LLM integration call AND the structured_json write have succeeded,
 * and a failure at either step leaves every saved answer exactly as it was, retryable.
 */
async function applyImproveAnswers(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const provider = normalizeProvider(body.provider);
  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 501);
  if (provider === "openai" && !env.OPENAI_API_KEY) return json({ error: "openai_not_configured" }, 501);

  const profileId = await getOrCreateProfileId(env);
  const row = await env.DB.prepare("SELECT structured_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ structured_json: string }>();
  const structured = readCareerProfile(row?.structured_json ?? "{}");
  if (!structured) return json({ error: "no_profile_yet" }, 400);

  const answered = await env.DB.prepare(
    "SELECT * FROM profile_improvement_questions WHERE profile_id = ? AND status = 'answered' ORDER BY created_at ASC",
  )
    .bind(profileId)
    .all<ImproveQuestionRow>();
  if (!answered.results.length) return json({ error: "no_answers_to_apply" }, 400);

  const answeredText = answered.results
    .map((q) =>
      `- entity_type: ${q.entity_type}\n  entity_id: ${q.entity_id}\n  entity_label: ${q.entity_label}\n  ` +
      `target_field: ${q.target_field}\n  question: ${q.question}\n  why_it_matters: ${q.why_it_matters}\n  answer: ${q.answer}`,
    )
    .join("\n\n");

  const prompt = await getManagedPrompt(
    env,
    "profile/improve-apply",
    { career_profile: JSON.stringify(structured), answered_questions: answeredText },
    PROFILE_IMPROVE_APPLY_PROMPT,
  );

  let updated: CareerProfile;
  try {
    const raw = await callStructured<unknown>(
      env,
      provider,
      "profile.improve_apply",
      prompt,
      CAREER_PROFILE_SCHEMA,
      "submit_updated_profile",
      16000,
    );
    const normalized = normalizeCareerProfile(raw);
    // Same regression guard a Create regeneration gets: an apply pass that comes back with
    // materially fewer organizations/institutions than it started from is a failed integration
    // (truncated response, model lost its place), not a legitimate edit, and must not be written.
    const { profile: accepted, rejected } = acceptRegeneratedProfile(structured, normalized);
    if (rejected) return json({ error: "apply_rejected_incomplete" }, 502);
    updated = accepted;
  } catch (err) {
    // No question is marked applied and structured_json is untouched -- every saved answer is
    // exactly as retryable as it was before this call.
    return json({ error: "apply_failed", detail: friendlyMessage(err) }, 502);
  }

  // The write and the status flip happen together, after the LLM call has already succeeded, so a
  // failure anywhere above this point never leaves a question marked applied against unsaved data.
  await env.DB.prepare(
    `UPDATE candidate_profiles SET structured_json = ?, summary = ?, match_profile = ?,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(JSON.stringify(updated), updated.career_summary.narrative_summary.slice(0, 4000), buildMatchProfile(updated), profileId)
    .run();

  const appliedIds = answered.results.map((q) => q.id);
  for (const id of appliedIds) {
    await env.DB.prepare(
      "UPDATE profile_improvement_questions SET status = 'applied', applied_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(id)
      .run();
  }

  // Re-audit immediately against the newly-applied profile, so the loop (Create -> Analyze -> Ask ->
  // Answer -> Save -> Apply -> Reanalyze -> Ask Again) advances in one action from the user's side.
  // A failure here does not undo the apply that already succeeded above -- the candidate can always
  // press "Check Again" -- so it degrades to an empty next-question set rather than an error.
  const reaudit = await runImproveAudit(env, profileId, provider);

  return json({
    structured: updated,
    applied_count: appliedIds.length,
    questions: reaudit.ok ? reaudit.questions : [],
    answered_count: reaudit.ok ? reaudit.answered_count : 0,
    pending_count: reaudit.ok ? reaudit.pending_count : 0,
    reaudit_error: reaudit.ok ? null : reaudit.error,
  });
}

async function listResumes(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const rows = await env.DB.prepare(
    `SELECT r.id, r.name, r.instructions, r.template, r.revision, r.checks_json, r.critique,
            r.is_master, r.role_family, r.job_id, r.created_at,
            j.title AS job_title, j.company AS job_company
     FROM resumes r
     LEFT JOIN job_postings j ON j.id = r.job_id
     WHERE r.profile_id = ? ORDER BY r.created_at DESC`,
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
    role_family?: string;
  };
  const instructions = (body.instructions ?? "").trim();
  const roleFamily = (body.role_family ?? "").trim();
  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const profile = await loadProfileForResume(env);
  if (profile instanceof Response) return profile;

  /**
   * A career resume targets ONE role family, not the whole analysis.
   *
   * Passing every discovered family as the target is what produces a resume hedging across
   * unrelated careers -- the exact fictional-hybrid problem the analysis works to avoid. So when a
   * family is chosen, the target narrows to that entry alone; the evidence source is unchanged
   * either way, since selection is presentation and the Profile remains the only factual authority.
   */
  const analysis = readRoleAnalysis(
    (await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
      .bind(profile.profileId)
      .first<{ preferences_json: string }>())?.preferences_json ?? "{}",
  );
  const chosen = roleFamily ? analysis?.roles.find((r) => r.title === roleFamily) : undefined;
  const target = chosen ? flattenRoleAnalysis({ summary: analysis?.summary ?? "", roles: [chosen] }) : profile.desiredRoles;

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
      target,
      instructions,
      layout,
      "",
    );
  } catch (err) {
    return json({ error: "generation_failed", detail: friendlyMessage(err) }, 502);
  }

  const name = roleFamily || (instructions ? instructions.slice(0, 60) : `Resume ${new Date().toISOString().slice(0, 10)}`);
  await env.DB.prepare(
    `INSERT INTO resumes (id, profile_id, name, instructions, content_json, pdf_r2_key, template, layout_json, checks_json, role_family)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      roleFamily,
    )
    .run();

  return json({ id, name, role_family: roleFamily, template: layout.template, revision: 1, checks: built.checks }, 201);
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
  const prompt = await getManagedPrompt(env, "resume/select_base", {
    job_title: job.title,
    company: job.company,
    job_description: job.raw_description.slice(0, 2000),
    resume_versions: JSON.stringify(candidates.map((c) => ({ id: c.id, name: c.name, instructions: c.instructions }))),
  });

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
  const prompt = await getManagedPrompt(env, "cover_letter/compose", {
    job_title: job.title,
    company: job.company,
    job_description: job.raw_description.slice(0, 3000),
    review_answers: reviewAnswers.length
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
        ].join("\n") : "",
    contact_line: resumeContactLine ? `CONTACT LINE (for reference, do not repeat verbatim in the letter body): ${resumeContactLine}\n` : "",
    candidate_profile: JSON.stringify(profile),
  });

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

  const name = profileRow?.label || profile.structured.identity.name ||
    profile.structured.career_summary.headline || "Candidate";
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

type FormField = {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  options?: string[];
  maxLength?: number;
};

/** One focused answer, grounded or explicitly not, for the on-demand /applications/generate-answer call. */
const GENERATE_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The drafted answer text, ready to review and edit." },
    grounded: {
      type: "boolean",
      description:
        "true if the answer is well-supported by the candidate's actual profile/evidence/job context. " +
        "false if this is a best-effort draft with limited support -- say so rather than hiding it, since " +
        "the candidate reviews and edits every draft before it's used either way.",
    },
  },
  required: ["answer", "grounded"],
} as const;

/**
 * Which of the employer's own real options matches the candidate's already-known answer, for the
 * on-demand /applications/resolve-option call -- see extension/agent.js, which only ever reaches
 * for this after its own fast, rule-based synonym matching (content.js) has already tried and
 * failed. Never a place to invent a choice: the model picks from the exact list it's given or says
 * so isn't confident, and the server re-checks the returned text is actually one of those options
 * before trusting it either way.
 */
const RESOLVE_OPTION_SCHEMA = {
  type: "object",
  properties: {
    option: {
      type: ["string", "null"],
      description:
        "The exact text of the one option, copied verbatim from the provided list, that the candidate's " +
        "answer clearly means. null if none of the options unambiguously match -- do not guess or pick " +
        "the closest-sounding one when it's genuinely unclear.",
    },
    confident: {
      type: "boolean",
      description: "true only if the match is obvious and unambiguous, not merely plausible.",
    },
  },
  required: ["option", "confident"],
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
 * Where an answer the candidate just typed should live, which is a different question from whether
 * a model may invent it (that's NEVER_INFER above -- salary is never inferable, but once the
 * candidate states it, it is worth remembering).
 *
 *   stable_fact  a fact about the person that doesn't change per employer (phone, work auth)
 *   preference   a standing choice that holds until they change their mind (willing to relocate)
 *   contextual   reusable but liable to go stale (salary expectation, notice period, start date)
 *   job_specific true of exactly one application ("why do you want to work at Acme?")
 *   one_time     an artifact of this form and meaningless elsewhere (agree-to-terms, referral source)
 *
 * Rule-based rather than a model call, deliberately: this runs on every answered field, the
 * categories are stable and few, and a wrong classification quietly mis-files personal data --
 * which is exactly the kind of decision that should be inspectable in a regex rather than
 * re-litigated by a model each time. Anything unmatched returns `uncertain`, which the sidebar
 * turns into an explicit "remember this?" question rather than defaulting either way.
 */
type AnswerCategory = "stable_fact" | "preference" | "contextual" | "job_specific" | "one_time" | "uncertain";
type AnswerStorage = "bank" | "job" | "none" | "ask";

const JOB_SPECIFIC_PATTERN =
  /\b(why (do|are|would) you|why (this|our|us)|interest(ed)? in (this|our|the) (role|company|position|team)|what (interests|excites|draws|attracts) you|how (does|do) your (experience|background|skill)\w* (relate|apply|fit|align)|cover letter|what do you know about (us|our))\b/i;
const ONE_TIME_PATTERN =
  /\b(i (agree|certify|acknowledge|consent|confirm)|agree to|terms|privacy (policy|notice)|acknowledg\w*|certif\w*|consent|how did you hear|referr\w*|referred by|hear about (us|this))\b/i;
const CONTEXTUAL_PATTERN =
  /\b(salary|salaries|compensat\w*|expected pay|desired pay|pay range|hourly rate|notice period|start date|available to start|availability|earliest.*(start|available))\b/i;
const PREFERENCE_PATTERN =
  /\b(willing to relocat\w*|open to relocat\w*|relocat\w*|travel|remote|hybrid|on-?site|in-?office|work arrangement|work preference|shift|weekend|overtime)\b/i;
const STABLE_FACT_PATTERN =
  /\b(sponsor\w*|visa|authoriz\w*|work permit|citizen\w*|veteran\w*|disab\w*|gender|sex|race|ethnic\w*|hispanic|latino|felon\w*|convict\w*|criminal|background check|security clearance|clearance|phone|mobile|telephone|e-?mail|linkedin|github|portfolio|website|address|city|state|country|zip|postal|pronoun|first name|last name|full name)\b/i;

function classifyAnswer(question: string): { category: AnswerCategory; storage: AnswerStorage; explain: string } {
  const q = String(question ?? "");
  if (JOB_SPECIFIC_PATTERN.test(q)) {
    return { category: "job_specific", storage: "job", explain: "That one's specific to this application, so I'll keep it with this job rather than reuse it elsewhere." };
  }
  if (ONE_TIME_PATTERN.test(q)) {
    return { category: "one_time", storage: "none", explain: "That's particular to this form, so there's nothing worth saving." };
  }
  if (CONTEXTUAL_PATTERN.test(q)) {
    return { category: "contextual", storage: "bank", explain: "I'll remember that, though it's the kind of thing worth revisiting later." };
  }
  if (PREFERENCE_PATTERN.test(q)) {
    return { category: "preference", storage: "bank", explain: "I'll remember that preference for future applications." };
  }
  if (STABLE_FACT_PATTERN.test(q)) {
    return { category: "stable_fact", storage: "bank", explain: "I'll remember that for future applications." };
  }
  return { category: "uncertain", storage: "ask", explain: "Want me to remember this for future applications?" };
}

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
  };
  const fields = (body.fields ?? []).filter((f) => f && f.name);
  if (!fields.length) return json({ error: "fields_required" }, 400);

  // No model call happens in this endpoint any more -- narrative fields are left for the candidate
  // to fill or explicitly draft via POST /applications/generate-answer, which takes its own
  // provider. This one only ever does lookups (bank, job-scoped answers, deterministic contact
  // facts), so there's no provider to choose here.
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

  // Answers given for *this* job outrank the shared bank: "why this company" has one right answer
  // per company, and the shared bank should never be holding one in the first place.
  const jobBankRows = body.job_id
    ? await env.DB.prepare(
        "SELECT question_key, answer FROM job_application_answers WHERE profile_id = ? AND job_id = ?",
      )
        .bind(profileId, body.job_id)
        .all<{ question_key: string; answer: string }>()
    : null;
  const jobBank = new Map((jobBankRows?.results ?? []).map((r) => [r.question_key, r.answer]));

  const answers: { name: string; value: string; source: string; confidence: string }[] = [];
  const unresolved: FormField[] = [];

  // Resolution order, cheapest and most authoritative first. Everything above the model tier is a
  // plain lookup -- no call is ever spent deciding something already known (see the agent's
  // deterministic-by-default contract in extension/agent.js).
  for (const field of fields) {
    const label = (field.label || field.name).trim();
    const key = questionKey(label);
    const jobHit = jobBank.get(key);
    if (jobHit) {
      answers.push({ name: field.name, value: jobHit, source: "job_answer", confidence: "high" });
      continue;
    }
    const hit = bank.get(key);
    if (hit) {
      answers.push({ name: field.name, value: hit, source: "bank", confidence: "high" });
      continue;
    }
    const deterministic = deterministicAnswer(label, contact);
    if (deterministic) {
      answers.push({ name: field.name, value: deterministic, source: "profile", confidence: "high" });
      continue;
    }
    unresolved.push(field);
  }

  // Free-text/textarea are the only types worth offering a draft for -- generating a fabricated
  // date or a plausible-looking number is exactly the invention this app refuses to do elsewhere,
  // so a date/number/select/radio field only ever gets a real value: the employer's own options,
  // or the candidate's own typing. See extension/sidebar.js for how each reason renders.
  const GENERATABLE_TYPES = new Set(["text", "textarea"]);
  const toMissing = (f: FormField, reason: string) => {
    const sensitive = reason === "sensitive";
    const classification = sensitive ? null : classifyAnswer(f.label || f.name);
    return {
      name: f.name,
      label: f.label,
      type: f.type ?? "text",
      options: f.options ?? [],
      required: Boolean(f.required),
      max_length: f.maxLength ?? null,
      reason,
      category: classification?.category ?? null,
      // Never for a sensitive field, and never for a fixed-choice/date/number field -- generation
      // only makes sense where there's nothing to invent but prose, and prose the candidate reads
      // and edits before anything reaches the employer's page.
      can_generate: !sensitive && GENERATABLE_TYPES.has(f.type ?? "text"),
    };
  };

  // Nothing here calls a model. Sensitive fields never reach the model at all (NEVER_INFER,
  // enforced again server-side in /applications/generate-answer as a second gate); every other
  // unresolved field -- narrative or not -- is left for the candidate to fill, choose, or
  // explicitly draft with Generate. Auto-filling a narrative answer without being asked is exactly
  // the behavior this endpoint used to have and no longer does: see the "Generate -> review/edit ->
  // Fill or Save" flow in extension/agent.js, which replaces the old silent best-effort autofill.
  const missing = unresolved.map((f) => toMissing(f, NEVER_INFER.test(f.label || f.name) ? "sensitive" : "open"));

  const letter = body.job_id
    ? await env.DB.prepare("SELECT content_html FROM cover_letters WHERE job_id = ?")
        .bind(body.job_id)
        .first<{ content_html: string }>()
    : null;

  const jobMeta = body.job_id
    ? await env.DB.prepare("SELECT title, company FROM job_postings WHERE id = ?")
        .bind(body.job_id)
        .first<{ title: string; company: string }>()
    : null;

  return json({
    answers,
    missing,
    resume_url: resumeRow ? `/resumes/${resumeRow.id}/file` : null,
    // The name the extension uploads the resume as -- see resumeFilenameFor. Computed here rather
    // than in the extension because the candidate's name and the job's company already live
    // together in this one response; the extension never needs to know how the name is formatted.
    resume_filename: resumeRow ? resumeFilenameFor(contact.name, jobMeta?.company ?? "") : null,
    cover_letter_text: letter ? stripHtmlToText(letter.content_html) : null,
    job: jobMeta ? { id: body.job_id, title: jobMeta.title, company: jobMeta.company } : null,
    // So the sidebar can say "I don't have a tailored resume for this job yet" and point back at
    // the main app rather than silently attaching nothing (see extension/sidebar.js).
    assets: { resume: Boolean(resumeRow), cover_letter: Boolean(letter) },
  });
}

/**
 * One focused draft for one open-ended field, on demand -- see the "Generate -> review/edit ->
 * Fill or Save" flow in extension/agent.js/sidebar.js. Deliberately not a batch pass: a narrative
 * answer is only ever drafted when the candidate asks for this specific field, and the draft lands
 * in the sidebar's input for them to read and edit, never straight into the employer's form.
 *
 * The prompt itself lives in Langfuse (`applications/generate_answer`), not here -- see "Prompt
 * Management" in the README for how to create/update it. Every runtime value the model gets is
 * passed as a template variable rather than folded into a hardcoded string, so the instructions can
 * be revised without a deploy.
 */
async function generateApplicationAnswer(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    job_id?: string;
    provider?: string;
    field?: { name?: string; label?: string; type?: string; max_length?: number | null };
  };
  const label = (body.field?.label ?? "").trim();
  if (!label) return json({ error: "field_label_required" }, 400);
  // Re-checked here rather than trusted from the client -- the sidebar's own gating (hiding
  // Generate for a sensitive question) is the UI half of this rule; this is the actual safeguard.
  if (NEVER_INFER.test(label)) return json({ error: "field_not_generatable" }, 400);

  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  const profile = await loadProfileForResume(env);
  if (profile instanceof Response) return profile;

  const jobRow = body.job_id
    ? await env.DB.prepare("SELECT title, company, raw_description FROM job_postings WHERE id = ?")
        .bind(body.job_id)
        .first<{ title: string; company: string; raw_description: string }>()
    : null;
  const reviewClaims = body.job_id ? await loadJobReviewClaims(env, body.job_id) : [];

  // Existing saved answers -- global and job-scoped -- can carry real context a generic profile
  // read wouldn't (an already-stated salary range, an already-answered "why this kind of role").
  const bankRows = await env.DB.prepare(
    "SELECT question_text, answer FROM application_answers WHERE profile_id = ?",
  )
    .bind(profile.profileId)
    .all<{ question_text: string; answer: string }>();
  const jobBankRows = body.job_id
    ? await env.DB.prepare(
        "SELECT question_text, answer FROM job_application_answers WHERE profile_id = ? AND job_id = ?",
      )
        .bind(profile.profileId, body.job_id)
        .all<{ question_text: string; answer: string }>()
    : null;
  const savedAnswers = [...(bankRows.results ?? []), ...(jobBankRows?.results ?? [])];

  // Fetching the managed prompt is folded into the same try/catch as the model call itself: a
  // missing/unpromoted Langfuse prompt is exactly as much "generation didn't work this time" as a
  // provider outage, and neither should ever escape as a raw exception with a stack trace attached.
  try {
    const prompt = await getManagedPrompt(env, "applications/generate_answer", {
      question: label,
      field_type: body.field?.type || "text",
      max_length: body.field?.max_length ? String(body.field.max_length) : "",
      job: jobRow ? `${jobRow.title} at ${jobRow.company}` : "",
      company: jobRow?.company ?? "",
      job_description: jobRow ? jobRow.raw_description.slice(0, 2000) : "",
      candidate_profile: JSON.stringify(profile.structured),
      review_context: reviewClaims.length ? reviewClaims.map((c) => `- ${c}`).join("\n") : "",
      saved_answers: savedAnswers.length
        ? savedAnswers.map((a) => `- ${a.question_text}: ${a.answer}`).join("\n")
        : "",
    });
    const result = await callStructured<{ answer: string; grounded: boolean }>(
      env,
      provider,
      "application.generate_answer",
      prompt,
      GENERATE_ANSWER_SCHEMA,
      "submit_drafted_answer",
      1200,
    );
    return json({ answer: (result.answer ?? "").trim(), grounded: Boolean(result.grounded) });
  } catch (err) {
    return json({ error: "generation_failed", message: (err as Error).message }, 502);
  }
}

/**
 * Which of a fixed-choice field's real options the candidate's already-known answer means -- the
 * last, model-assisted step before the extension gives up and asks the candidate directly (see
 * extension/agent.js). Reached only after content.js's own fast, rule-based synonym matching has
 * already tried and failed: a decorated option ("United States+1" rather than "United States") or
 * an unanticipated phrasing shouldn't force a human into the loop when the match is genuinely
 * obvious. Never invents a choice -- the model picks from the exact list it's given, and this
 * re-checks its answer is actually one of those options before trusting it, the same "grounded or
 * explicitly not" discipline generateApplicationAnswer already applies to narrative drafts.
 */
async function resolveApplicationOption(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    provider?: string;
    label?: string;
    value?: string;
    options?: string[];
  };
  const label = (body.label ?? "").trim();
  const value = (body.value ?? "").trim();
  const options = (body.options ?? []).filter((o) => typeof o === "string" && o.trim());
  if (!label || !value || !options.length) return json({ error: "label_value_options_required" }, 400);
  // Re-checked here rather than trusted from the client -- the same actual safeguard
  // generateApplicationAnswer applies, not just relying on the extension's own gating.
  if (NEVER_INFER.test(label)) return json({ error: "field_not_resolvable" }, 400);

  const provider = normalizeProvider(body.provider);
  const keyError = providerKeyMissing(env, provider);
  if (keyError) return json({ error: keyError }, 501);

  try {
    const prompt = await getManagedPrompt(env, "applications/resolve_option", {
      question: label,
      candidate_answer: value,
      options: options.map((o) => `- ${o}`).join("\n"),
    });
    // Cheap/fast tier: this is picking from a small closed set, not open-ended reasoning, the same
    // category of task the bulk job-screen pass already uses this tier for.
    const result = await callStructured<{ option: string | null; confident: boolean }>(
      env,
      provider,
      "application.resolve_option",
      prompt,
      RESOLVE_OPTION_SCHEMA,
      "submit_resolved_option",
      500,
      "screen",
    );
    // The model's own echo of the option text is never trusted over the real list -- if it doesn't
    // exactly match one of the options given, that's the same as "no confident match" rather than a
    // risk of introducing a value that was never actually on the employer's form.
    const matched = result.option && options.includes(result.option) ? result.option : null;
    return json({ option: matched, confident: Boolean(result.confident) && Boolean(matched) });
  } catch (err) {
    return json({ error: "resolution_failed", message: (err as Error).message }, 502);
  }
}

/**
 * The candidate's explicit answer to a field the agent couldn't resolve, kept for reuse -- the
 * backend half of Save (see extension/agent.js for the Fill/Save split: Fill never calls this,
 * since using an answer once and remembering it are now two distinct actions rather than one call
 * with a `remember` flag).
 *
 * Three jobs, in order: notice when this contradicts something already stored, decide where (or
 * whether) the answer belongs, and write it. The contradiction check comes first and is not
 * silently resolved -- an explicit `confirm_overwrite` is required before a durable stored answer
 * changes, so the current application always uses what the candidate just said while the saved
 * record only moves when they mean it to. Save is itself the candidate's explicit "remember this"
 * signal, so an otherwise-ambiguous classification resolves to the bank here rather than asking a
 * second time -- the sidebar only offers Save once the candidate has already chosen to keep it.
 */
async function saveApplicationAgentAnswer(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    question?: string;
    answer?: string;
    answer_type?: string;
    job_id?: string;
    confirm_overwrite?: boolean;
  };
  const question = (body.question ?? "").trim();
  const answer = (body.answer ?? "").trim();
  if (!question || !answer) return json({ error: "question_and_answer_required" }, 400);
  const key = questionKey(question);
  if (!key) return json({ error: "question_not_recognizable" }, 400);

  const profileId = await getOrCreateProfileId(env);
  const classification = classifyAnswer(question);
  const answerType = (body.answer_type ?? "text").trim() || "text";
  const storage: AnswerStorage = classification.storage === "ask" ? "bank" : classification.storage;

  if (storage === "none") {
    return json({ stored: false, storage, category: classification.category, message: classification.explain });
  }

  const existing =
    storage === "bank"
      ? await env.DB.prepare("SELECT answer FROM application_answers WHERE profile_id = ? AND question_key = ?")
          .bind(profileId, key)
          .first<{ answer: string }>()
      : null;

  if (
    storage === "bank" &&
    existing &&
    existing.answer.trim().toLowerCase() !== answer.toLowerCase() &&
    body.confirm_overwrite !== true
  ) {
    return json({
      stored: false,
      conflict: { existing_answer: existing.answer, new_answer: answer },
      category: classification.category,
      message: "That's different from the answer I had saved. Should I update the saved one?",
    });
  }

  if (storage === "job" && !body.job_id) {
    return json({
      stored: false,
      storage,
      category: classification.category,
      message: "I can't tell which application this belongs to, so there's nothing to save it against.",
    });
  }

  if (storage === "bank") {
    await env.DB.prepare(
      `INSERT INTO application_answers (id, profile_id, question_key, question_text, answer, answer_type, category)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, question_key) DO UPDATE SET
         question_text = excluded.question_text,
         answer = excluded.answer,
         answer_type = excluded.answer_type,
         category = excluded.category,
         updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(crypto.randomUUID(), profileId, key, question, answer, answerType, classification.category)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO job_application_answers (id, profile_id, job_id, question_key, question_text, answer, answer_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, job_id, question_key) DO UPDATE SET
         question_text = excluded.question_text,
         answer = excluded.answer,
         answer_type = excluded.answer_type,
         updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(crypto.randomUUID(), profileId, body.job_id, key, question, answer, answerType)
      .run();
  }

  let message: string;
  if (storage === "job") {
    const job = await env.DB.prepare("SELECT company FROM job_postings WHERE id = ?")
      .bind(body.job_id)
      .first<{ company: string }>();
    message = job?.company
      ? `Filled and saved for future ${job.company} applications.`
      : "Filled and saved for future applications to this job.";
  } else if (classification.category === "contextual") {
    message = "Filled and saved. You can update this later if it changes.";
  } else {
    message = "Filled and saved for future applications.";
  }

  return json({ stored: true, storage, category: classification.category, message });
}

/**
 * The agent's decision log (see migration 0022). Batched because a single autofill pass produces
 * one event per field and a request each would be absurd.
 *
 * Values are dropped for anything NEVER_INFER matches: knowing that a work-authorization question
 * was asked and answered by the candidate is the useful signal for debugging and later evaluation;
 * storing the answer itself a second time, outside the answer bank, is not.
 */
async function recordAgentEvents(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    job_id?: string;
    application_url?: string;
    events?: { type?: string; field?: string; detail?: Record<string, unknown> }[];
  };
  const events = (body.events ?? []).slice(0, 200);
  if (!events.length) return json({ recorded: 0 });

  const profileId = await getOrCreateProfileId(env);
  const url = (body.application_url ?? "").slice(0, 500);
  const statements = events.map((event) => {
    const field = String(event.field ?? "").slice(0, 200);
    const detail = { ...(event.detail ?? {}) };
    if (NEVER_INFER.test(field) || NEVER_INFER.test(String(detail.label ?? ""))) delete detail.value;
    return env.DB.prepare(
      `INSERT INTO application_agent_events (id, profile_id, job_id, application_url, event_type, field_name, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      profileId,
      body.job_id ?? null,
      url,
      String(event.type ?? "unknown").slice(0, 60),
      field,
      JSON.stringify(detail).slice(0, 4000),
    );
  });
  await env.DB.batch(statements);
  return json({ recorded: statements.length });
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
          statusEl.textContent = 'Device enrolled. Opening your dashboard…';
          statusEl.className = 'success';
          form.reset();
          window.location.replace('/');
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

/**
 * The two brand images (media/images/applygo-logo.png, mon-chan-avatar.png), inlined as base64 --
 * this app has no static-asset pipeline (everything else in the dashboard is inline SVG), and
 * adding one (an R2 route, a Workers Assets binding) for two small images would be a bigger change
 * than "use the right logo" calls for. Pre-resized well below source resolution (the logo to 64px,
 * Mon-chan to 40px) since these are display-small; embedding the originals would be 1-2MB apiece.
 * Each string appears exactly once, here, and every use site in DASHBOARD_PAGE references it rather
 * than repeating the payload inline.
 */
const APPLYGO_LOGO_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAA9CAIAAACSt/iWAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAUGVYSWZNTQAqAAAACAACARIAAwAAAAEAAQAAh2kABAAAAAEAAAAmAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAABAoAMABAAAAAEAAAA9AAAAAFXOSNAAAAI0aVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIgogICAgICAgICAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyI+CiAgICAgICAgIDxleGlmOlBpeGVsWURpbWVuc2lvbj4xMTAwPC9leGlmOlBpeGVsWURpbWVuc2lvbj4KICAgICAgICAgPGV4aWY6UGl4ZWxYRGltZW5zaW9uPjExNTY8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpDb2xvclNwYWNlPjE8L2V4aWY6Q29sb3JTcGFjZT4KICAgICAgICAgPHRpZmY6T3JpZW50YXRpb24+MTwvdGlmZjpPcmllbnRhdGlvbj4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CoIpQe8AACOUSURBVGgFjXp3fFxXvedtc6f3ImlUZtS7uy3LLXYcYxwDKSQENiQhCYGlPAgl8OHBg8977PLhtV0SHjWP3RcC2UB4BBL32HGXZRXLVh9pJM1ImhlN773c/Z4rOYT9a8/HHt25c885v/L91XPp2OoURVE0jQ9KEATy5y9DvPveV3zD7zRFC5Twvl/I7f9n3ntT/r8v8rmMQmsMrK0G1tbsza3Y5ObNwYP3HCA0baz+vi0JFWQQckrRJVAvEkAoWb/6q33F2xt3Nq6xvnhjfen3P/BXM9fZWv9ZnEA+xIv3c0xTDM2EgoESRRuNplIxXyoWaIZLJFOeleXe3l65QiGUShVMEaduULi+lCBwuPtXHIoPsQxbqWCKSME6GeuUbVzjz8Y0luOKZfIgL+epcqlcLIpy+Ss+/vKFTP/LcizLUhK+UizRLKM3moaGR/RGc7lSYTmJRMJb1WqpTDY2PmHQaWuqq9Vq9fu0sb4MWYouxVwbgr8LI+DJ6/UZDXqFSiWUCXXivn/ZeIMgSI6TOObmT732Is9RqqrOzX33bu7tYqhKuVR6H6HrctsQvUi/QNM0I5W5XJ4bV86G3BMSlfnjT3+xmM84nYt9e/bm00k8IFMqKZbNJNOzjtlF50Iumz529KherxcqFQKZu+SAgSVC0Pp3rEvTyXT6yrUbFouJY9ma6iq9TstLeIahRZXcnYcpWIblf/5PLzxWO6JTSz2R4tAyE9P0HXrwuZaWxkoui0cZTGMY0EEexp6VCrjD1EKFeevNN8K3f3tPQ8JeJXespK+Vj3/hhe8sOhyrXt/uPf1A0aJrOeAPgFyjQVdtNikUCrlcDvIIkO5SgUtiA4QB/CAOqNW5uATEdXR1rnm8qx5PNpMRhEqpVNrU3WU0GACt9edBXDCSOv3jp5461iZY9tKuk1QxGIjkzsxy+h3PffgjDwoVIRCO+v2BaDRcLOQYhlWq1FVVVWqN+rWXf7SJeveeHi1l3inoe+jlN195x7f76V+0tzd5lpediy6JhDPoDXXWGpVKSWjDru9Bep1Q3CUygQ1sjLvmS9ORcKS9o72YTuk1yirzJnAr0MzMjCMeT5hMJiJFkVuINp5I6CRpyrxFaH6IwpO3XrRolp7s506P/uj7t4artBQXcxgkcb2spOKgwEq8yE6npDcWKs8fKHXZ9ZXao1TnExSnoDOeXbW/Gxu6DgZqa2qqzGaWZWiWrZTKIhrv0iiS/J6siRpoGgzgYkP8AFA6mYIZqbXadDwKqecLeUGgFWp1Op2y1NdCoeuLrU8olYpSLCA3UMvzQqnI7Pp65cZ/pzNrR7foa1w3mqpkmg4pxWjIDvC78L4S5u2B4LN9TJdNVTHsoLueFObnKLVOMG22Wd5613mnUnocGFuHK1WBIZFBRP0e5tc3fs8CgNJ16rE4HoNRzjgcTU1NRUJ3BSARf4XNMZl0RqvVbjBA7BoaE3iJpFiGIkt0vlC49M7STEBofYgECZre0qxXK2QgplIklJQhlRJVyVV2t2n7WnQViZnZ9Gx23lm6don2rggqq0KlkeS8qVQGO5LFN+gmDJCdxD93ubjrT8mPhAFxgEYJPzszy/G82WIq5LLkhoQDKRKeTyaSUl4ilUnJQmRp8oltlCpVosBT2QitUI7MO6+/8d381O/gwvEYQSy2xpNEMFiGWVezWc3hF5rlwq47v3v5JdfyKp1OUayckqoUNOjHvuRhKCGRTJJtyICM1i9wBWSxd8MQuUkYYFg2XywNDg7Fkume3t5sOkV2JLPIH7lStbi41FBnhVGShxmmUCgAo+BAp1FnJWYh6kqz/Hh86YEdgrwSvSsf0E6eIRIkA9gjF2I8ooW0XzX7k62ty2cWJ5OROPFUDMOzcNoVwLhQKl24OfGHyxNzi8usRAS5KAg8ls3lnM6FTDaL+AMmwRBxc8FQ6MSp0zV1dbv37SlkM0A2vBgEXCpXEFJg0/FYtLa2tlIuMxy3tOL5zZnBizcnsvm8TCnjjJ0hz4KQnb9/NwPMCBQ8pih1CGDjH8gmythgBKogA+qVbGnU7tqSd+YimEFRxWgsDklRUun4zGIwXWkwa6zVZmy6MVcQIOiFxaVsoTjlmLs1djueSLISCfvdb35ZSga/suqRSXi9xSJBJJRKaYYtZNM+78ro8GD/nr0ynhepoMBwLJmJZ0rpRKKhwRqOFwOTp9oVCzq+XBGAE2KtROnkH4b4DdQTZu5+3fgJVibUW2QmfYHm5HTw1i1HwLHk2b7nqFGvaanWdrfbZRIOUBSXIeJAmF90ubu7u0wms0qjnZufd7ncG7kQzDedSt0en5DJFT2beqlSfnxkAKrw+SP77rnXYrGI7oyQQODJ0MlkimYlKq36d799rW71F3u7DRVYM/md4I5sueEeKpQA8KzfEW//5UOkjAAOjEvA/YmRoF4u0H3/cM+9B2PhSCKRMpv0PM+LMwRIdX7eCQswWyzLy8sAeVNzcy6bJXEAQAVzcrls757dS67lG9euZhJhxK86W9ORY/vUKgVyHEKWaBN4PBFPQmMwcVCGTINh8AOQA1pFUkXCKAoRd50lsgO5Jvc3fhN/ErmCywHqhDJ0d/82Y7mQff3Wmf79BwbvzK3GCnrJ/MMf3C/aHl3I50Ph8PYd28vFQmuTPZnKzM/PM/R6ICMyA+aFcrHUaGtoqKtNplIyZFJymQDaQT02Jr6RgjM8e20sUmQU5cwH9m/XSOX5yHJLlWzdvkUmwUaRYiA2ULwBOjH/xn1IgX0fV+RSDIu4SZ7m4fOkCnlqNhgIHezb5FrxKeRSQhZFwWRnp6bg3+HHi8Ui5sllfHtr8+qql5gUvrMsty4uQAVftWo1z3O4BgSJJxJRQegRYFRFq0a6Z3uXSiFPxFNCeNKsk4m7YF6ZUlop6wEYCpYln5iI2+BfqqGMXTBdkVRREzRdYeWCcTMgRG7SRBcAXr06teCckynkHa22BqsFW7Ic65idRWZpNJtyWeQ1SAyImywVCo2NdgY/Q8gzszNwjoRQLATYChVcwePC8BPJRC6XJ6kvRXEs98Dh/vt291gtRiwSCIYNbITikJPjcQJEJBTUzm9Rtg+SazJAPgKwitr6Narve5TGJiZzeBi2JDjCsinlw5EMZCQ+i49ypVYjBL2L+BmaB0tIJiYnJjmptLGxMRkJE8+5IU54fw4pLeP1rs07nRJeury6AnLBMcwUM9PZrNe7Ojcz7nM7Ll447fX58Ct4g7WVyahAa9FoRMsXRKEKkAmcLBMYwD9KqiOUgyVQj/RTbqbUdUzwFpP3AlwMliFDiGWExbgslBIVRpgg+YBZw8d9c5US4SqVyfzprRMylbq5rT0cDiE+rM/E9uBDplSdOXmKfeTBD3b39lgsVfFolGNYmVo9cef2qtuZigWpUk6jlEZjSXN1XVV1DQdJE2LXB9wst7CwxHvP15vlWC4Uz/3mjvbt0aTOf9bKLELPhHqiGYYqJOnAUN518cxYYsSjSCZi9WYp0KJkc6G5K71VJU4MSeRhYE2GGsPN1/ebjXoIxWIxo9oMrPk0OngkqYTjSIlCkWrBteSGo2f69/bznAR3bY3NiVRy4vZYOZdssdXV11pRCUzOLlbXt3T1bJLLAHQSTUXD3OACGXIZhBK8Fcfidq/2g6/fzD39st8bSgNgomYIt3iilF575seTn3p57d3wptnq589PlwBVo4L6QHtBjgiMR+DvRSMAG5kiSZ4xEYtUWyytrW31tXWrblc8FldodEqNTqZQZHP5Zberf/duRihuVE9AudFS5Vlx1VmrAQa4rdE70+3dW6y1tXCyxEw3NL/OBZFuOhWXMmVKohDKwpZtu/7w+//z6EPHtx985OSQn0JCVClQ5QIgRLP0iCOi7X3sYw8/+Ktf/ls4njXtfLqYTQulfKVQEPAM/t0dwCjCqk6jJQ4KvhmjVFIqFL09vclEfGx0lOF5FLHDgze3b9sKFXEwVXGukMlmxm8NdbfZUFYvudzBWHrbjt01NTXlUhG0ijInqLjLB5wGvXjn4qNd3ULfC1Q5Yyml1ErpSy+9BNvb8piBUtbQ+ho4LSrto/JrmUx+ampaLgNyqHPnzr3wiS9XRusF81ZKUU12jzkp3xAJeaJviUsaTUZDGW6XoJD8F5VPdXd3I/pevngRTmbb1s0alQrGwF29eq2lqUHOc+Pjt3mmcmd8OZ4p2pvaDt23XyGTgXrRvwjJZAJcwNblMjmqDOgcPHFqq0+7w6SurThm6CL1/MePf/rb41o5dfRjn6X6HoCzZqRSKh2jQuNbSq+5fn5qJUKA0bdrK0XL6d4XBH09vpJhpynLVWr8F3Afs96UztolUUjLmTRxOBgEjeCBlIVtLS0GnU6lUkFLyAsRH+iEd9rn80Rg44WCQqnS6Yy1dXVyhRwBYx0yIHXN71Uplal0etUXQI/A3lAPE2al0kvvXsqmo8c+cLhy9hSVTDBms7O2Wa6SFsvsL175z1ujozu39X7ra59TKNV0ITQ+Of/zV0/WWGueP9ynXFtFiUA1NVGd3bgAjQLDUWMvMuHB772xsKI5+PK/vEhXSgVUollUIsjfUEyUdDq93mBELANh2D+VTHo9K3Q55iL+kUCa5KZAHmLV3cCEEMgi8ZDKeEwu5vMqnSHgXUF1DZrwcCKR/tkvX/7mVz9H+32oSyitjursoSSSP77+p2e++B3ksJDcxI1TPb1tlWKFQesCfgzbnztVCYVpiYRqaaW6e+H7RfdDM7MvT189+xOfXa1v/PxH/0uDrS4WiSwuLdTbmqBzlFMB/xpoq7XWQvYQ+tqqq8psQDb6PMgFWwTgSBUAxHXJE47ofD6Xz2fBN2o0UO3z+Via1ukNxBIqgkKrSSVSc3OO9v4+d7boyZdmZxfUUr6js9XpXAhH43/3zb/50PHDNPJwlinkcgykjn/mKspgpBqbqHobwQ8GwzHl8MTbP/pvQ9lPfen7I0NX9m3u0+k0MpWKYTjEWbPJVMznVCo1SELwGR4e1MhYW70V2Q773W99mdQEDBMKh2DUyIBEeYjLMkwiEcvls+ANXh+6WVxaaobe0U9hSZ0B59tga7hydTASjbgvXr955UIx8M+eoKJr866jh/boNfIvPf85BmUdyw8Nj0/PLjTYmzmGoxUyWqsT5ApinoR4CV1OnXrlh2+5Nb33P6ig+bNn/tzb2mNvaXXOzrhdLue8AygwWqrlUuT/EpVSxQolpRx5Kk9kLKQ9yURicXERNUAhn0MLCJ0PrUaDUoYYjiDkMXJZACsYjuh1ejQmUADDTSFfqrFWg3cw9+qvX0tGQu2drVx24s60J5I3xkJLDdwMa9iqb+ihMit8+u1aq5aSWlMVu672eE9Xp1qtJI5SwocCoT+9/h8JmSqsTHXX95y9/KZR2WgVDO2t9c75uQP79iAFWl31vPvu5e07dnb3dJl0mkwqGQqsGQz6oVvj9K1rJxABNDpDuVQAvNKZdDAYDIdC4E8H4AN6Wp2El6DDAZOSyeXLyyszjnmlXLbvwD7gx+/3Q4yWGuvgwA3n/PSTTz6pMunTfl8sFlcpOL93dda5VEytKNkwVVjhhRVfIKtp+psrt+YfffjB1tbG69evvXr6tU8++fUCmxqbuHZo14fPDp5ePPHblvo9f/v9H2p0OtLOwGDZYi53/p13hm8OffSRR+12+8TtUVhqe9dm2jlxXfSVFYPBwLGk0uMkPBK5VCqJGi8Wjwf8/ka7rb2tDQYEpM06HCuetQP791y6+K7Pcd3MJ9hsIFlkF5M6bejGaLr648985T50laUSqiDmc/D9LE8Vy+VsPpfLpZLxVDq55Fr5xau/khkUjz3yzGzoztzi7Z7mHb1te0Zuj1Run312S/yKS7Hn6Z9Ua+nK4kk0DShzL6OxU7rGXCZz4sTpI0fvDwf9dfU2FCW0xzmKbiZCDMswSP1I0Y0Sg+hET0uliVDw0rvne3s3NTY2k6KMpvL5Qjqbu3L5kkmn2L9vF8PLqHyUmntjYfj0WqT05mRgRtW909axqb139/YdJqN+bn7hzvRcncVQW2OeX1qZWHAUKpVIMbZ1R59KpVn0zHbaNw3PDFAleXhmfDvt/Nh2jVwhW/QkHWz/seZgJb5KsgzSn5RS3Z9m7PfeGhzI5Kl9h+4pZzOE1B9875soZODXkXgguCJhRlUJd1nIF+Yn7/jdDpVSEYkl0RyWSmVQp1QuX5h3VEq5Q0ePIv9HEiGwSsG800ivNahi9UouwnRYd2wdmr3505d/9sYf/8yrzUPuYa2u7o0/nUhSlRvjN/v2H16JOVeWPV6/P5wI5BO5hGO2Jz3/icbggW4dTB6BVq+WTozfqVEVZdCk6A9JupF00aZNvMr0P1762f7+3SjTCbg+99wTRrMF1BfEsMHDDSnVDsfsyMCldGSNormmti60SqdnZhqbmsAlPO3gwLUj9x1Czg30ww2ACfgZXAveQYtZw66NjTszRnPXjp17Wzo78sXsssudZCMzc+OHjh/W0fr45I0+Vaar4NTGFp1jE63J8c9soXbaaY1CWkGiCS3TaEDQSplk0p1sqlGiIkR/BEGXykUFmpfa+iPhoFpss8L7s7u6rKGgX6HWwrtzvGzV6x24/E7C74b2NUazQmMIB7x+74pKY2hsbIQG0Kz1+Lwms1GC9iXNoAGDzlcBiXpqlfUPwubsVi3HGEZDZVObRiqRXT530W5rSa1kOSVz5/rAUw88+olPfrKz71jrtoObzekP23NogsDjqWUSEmFJhkIG1tGp+SVPHM1NnuNGp4PVevQoaEpjZ+v6CpmUQqFab9Rym3p7EtGga2rIQfGQqQ6MM3Qsw0W9iXzajWRTpZDJ1QakeqjL5HDCalUsnrh65dojH30IXRq04Otstt+/+suPNLj5EkwXXoO5MLtwz+N/F4wtelY9vJViFBV/cvX4Bz68u7W1Z/vWSjZHHIu0hur+Ip35wWZusVxBX0DMBQgDVCqHb2W1UtJu0w9N+ft5JpkrJZJZmUlBFWKoo4dGxnbv3gtuoS/2ha/81+aWVtTI+UxSZzDaG2rh4811bX17+q01dTKVXqHWB6LpeDw+fGs8my1IOOKpJiancAcFzYrHN3T1gmT216pyFMEOu7p98WlZf4rPOF0TrfaOvl2HKtGSLB6sMlYd+dCxSiZLaMRAyOfkVDElBMZoUuwTDAI/CMqXpmJapUQjZ1VyyYwnZVSwegUrlbAKhZRuvJ82ts/NOixmi7W+HjBmj+zbEghF7S3tvFyRTibyqYRCLnMurfb39+k0GoVKWV/fsGXrls29mzo7OiFvqEKjlNfV1TvmnQzLg+eGxrZUrhL2LMjK6UwqfepOrObgs1VVZqVCI5HIL5x6e1e9rau1qbt3W7lYVioVQB5UDZwwEpmQXKXWhsRuhUg9Q8XSZYc3s6sNjWT0AOjlQG7Jm2gwyeAmlXoj3f5YIIzGeWzbzp2OmZn5hQX2s48fR01ULmQiERJoNUZLqZDzeVbkSoNap716bWDk1u1yITc1O+deXtXrNdXVVRZLdU2Ndfv27Xa7nZUqllyrRx9+gqrpn4nrLi5Jp7KWIOuji+zKzLxvYuKxA/fd95EHcMpx5864yWTE8Hl9OONAu2NmZlYfvcJkfMRLEuNFWsGeHA1ua1QaVBzJL0V+QtFsq4VXGzT85ucq2pYX/+ePrLU29ExhAyAABoQGCithoS+kwUImEUOaiqm//883v/3tbxy+Z286g5Y3pUP8SScj0aTDuUTOHSoVnJ2olfJt27eyVGXZ7e7q7qqy1h78ELvqdb99/szaxZOfevxpW2uXzFQT9Qe62ppmZx0wCcTKhYVFU13dr//9p6XJ16t2ovZSSdAWE7vFp0dCSinbVKMor+fyFcGilSzzjEpvyliP+WPytYWBPfsPbdm2HVujQVREnjZ+6TV8QeIQi8XCCXQi/Eur/qvD0zOzc79++aW9+/oS4RDSOARoMYFDVBHQyobDCAZDHq+vt7vLYDY+/9XvjIzd+cDBPe2dnaVi8SPHj73yL1954uMPm3rvRVAsJ2Pwd5xcdfqtt5LZPHJ8rJaNrpW8I7WMt94kVShk4VT5znLGZJQ/uAsNXUAMzgDBiZ5czV5ZkvXv3adqvtdgsUJoHMcWEKRwgkGOQlh6YuhcpZiD8U1Mzv/9v76MWqDWWj01M5fJpEHcyTdfZelKNp0mnQwU70huS0U0tkkHBQyxiDKCTK//1S9//aWvfxvZFb6it40WWjoZ72o0Hz58MFui7z+8F5hRyKSJRLymroGScItTk+NTc7YqXdDndjvuZFdHGsyyba1afFbQsCFowgeGcNrBaXZ/de/+/eVcJh4JcmhLsBJIHpsDO6VCnp4ZPoOw1dlq++l/vHn+6qi1yuhbQ94ZhatJpdLPf+HTn3nukzIW1QgpnVE3YGGIHxIStyE9CYVaE4unDhx5CG0cdFsVSiUaAoA7+qfpdAZEgBytRm2vr3780ftRcrS1t8VTGTjn5sY60IPmTWXg79NBl0KJTB7PiivDGbN0uZR/c0rOtzzQ3tFlbWiSyWSoClBZSngZQIESBYdg7LOfuB+6wEIXro5Mzcxr1cqVVS8yaCAGcde94jl5+vyFK4NTjkUUKIA+wheMBr8ieBPbI56bVZmMyXhyeHRMyvM4ZsHJDf4h00ILv9Zq9a0FDHrd+KRjYHjincs3B27eWvYE4IEPH4IvZ6h8PDd/mqGK6PVv0E7ET62laFehXmHbV9XQEfEvz06OA7o6gwkr50mDkYI2cCLNJWLRSCQG+Rp0mlQ6410LQvbIjLBysVD8ymc+1tFiH5uYRYPot7duJdM5XspbrdWtzY0drY22uppqs16jUvAyyVMff/APf3wrkUrJSUcWdl5BD4r4HH9ILlcWSiQXYOAsOH58en7VFzQYdAM3bm7ZtJldHqSzYalSSbS6rlfyh5rzCzl7f9++B1VSJpVoiIf9q+6lGx63Smeqqa0HXHPZXACl7MLIiVyJ4glA0//rtT+eOnMJLymgCQezhpq62pvu3bsDALPX10A52VxhxeufmnM55pe8/mAqg5hJ1VjMPZ2tNdWW//3an+ecTgICgd7U271j26aBwSHwjCYCVBqNRlGjQ3NoZmayebhjk9nU3lj7wye6+eVTDQ0mIBMzQToGKtu5uCpRdYxRVOUKJVgOIg8jlMMB39rKYq5YRkYMNxsL++mEbzoUCnpX3WgBabXqDz32+UAoAgZKpTLSdwzIEsDQ6zQNtdXd7U2bupo7Wmy11WY0NsDDossz5VhYcHvnF1dwrA33oFDiPKHUt713YmYBR1pqpZJ0YYE4hllcXIrHYkaTUaPR6rRaeH30M5/98FZFbOzBHqa6SgfgQ2oQAc1UzjjYgu1hm82GshzvGUA/9Y1tRpMZR1+uuelkKl3IZRAT6fNv/NuKy2mttTZ39HrXQl/+23+Cq4GcCDrxbAlNbNgkjBPVPYymjJ+QYFdbjE22utpqo8Wgqbea7fV1Wo3qma/9AGzglQA4TbwWAM6P3nePVq06f3kA1IvCFeAYsCn6GpARPDK+fv/rT27rbkyOvR4NuGs1xRod3Ax3zZGdE3rsXbvRNkW+CG7hBuPRkESqUGrxYgOnRgpgqakwUm5zT2dHV5fbvbyyMAszJW5ADPXEaaJ1hdUkyCdw3k/UC36gk2w2615dm1tYhlR4XqLVKM0GLUKVVCqvqrJ4PB6lQgn9gm2fz8sydQh78Llo2QBaGo1GxAimEsTAcLUGi7GuJZp9vPmwnSsEXQuDl64OqqybTCqtUmtgIIwSBEcKA+RscIboTQgSucvtdnv85EzEN3NRb6qCLgK+1WAo+Nlv/HOxJMADidvczbsIMsmGLLpkCB44qaXBTBk6yWayKKORqEJRyFcQoeDI8QwKIDgDKA8GAJ+N50UXScyTkE5STyqWSJpV7PEDPbv23LN5134UUi73CpIUxMxCLr20tBj2exD05QArh1kVHKlYzEaWlQSjcfSlcQew4CKp0rRzWKNS6nXkhRyRnCIsGL6Vx0wpWhck+yKOjeyLWRikawmC4JHgm1EbIJUHMxA52mipQkrOo2WCw2/0ZHEhUrwuAHEW7uCMIRyOoAnyzHNPWkyGpo7NeoMhk0wYdZpkPBwMRVHi2uxN3T2bgeVkMgnLwXmFY3rcXG0lqGAodM5xDgZg0+6ZAbOlJo42WiScSkTHppYyyPtlMktN9blzFy9fuwEqIC0yRC7Eq42PdVmSoE8oA86R0ZDzHpxhQgTgXsQJeXhdBlgCbIPRSiGzvaf5gWMHG5ua61u6dVoNSMSv0CzHS/FMJpNNZnBmnUils3hzqbGzwzkxPjZwAa1yk6UaB+yJeBQkQwP0/PhViBQQ0Go1EsyWSkC9wmTKhMNPPfsFx4KL52Vi73GdfEIBIEBYEhXyPn5IkowBNkB9kXTtN2RPGFg/LqCoFNJ1ifDUR4/s29sn01hsTW0QaCoeg1ZFz8FWcDaF0hykwD7wPhcKeo5bW/O/e+IP9nqLQqGEERLXbKyNhoNsJUdnAg5sgOeAYiRpSIEgrTqb/dLZE3K2BG288ruTg+NLgAPwDTGLFIMZInVCL/kucvM+ciH7dQYI2koFtVKWQkqEUisZ62m2fui+3bbmjsb2noYGWx6IK+TJOSuaXEgeiFTQiSzBzMBDoVhWawhURq9fqK+ri6XSeIsOFtvZu81gMMI7OWYdHFwKCb0kr8OLBbS+uorX6sZuXFfwVM/WvR73glzOS+hiLBICe3DnUA9OlNHqImkMMce7XBAUkRvrA3+Ruinl8s9/+ol9e3Z85RvfW1h0feqRI0cO7i5z6q19+3DKEg/40HwG++h3oJmA6FEib3SVsDbWwhsheqMer/kMX7ug16rgefRmndXWajRXeT1ep3N4U0/X1q2b6Yh7jKAX9BMU0wqVdmlpaXluvKt3M8IQqpzFuekGqzmayNyeXtCbrdcHR9ZQFGVyaLXD2WMgRq3TDurLQECxCFLQEujfvfPpJz/R2dUG/TrnnedOvfXR44eq6hpu3xpdcvt6t/U12JtoeJIMAj+JX6AfzUa8yAI6JBJpvlAMRcJX3z3f3mqvbmjRqDV4NwAGjR41mp8GvRYn3sTBJLyT8CEYyFUQHXDwdGfoWl/frkA0kYyGjHodpzJ4lpeqjFo0Jqz1DclYHPpFx/7da0M//sm/o76BX4MvgloAFaNB21CLYm3LkXsP2OrrCvksokYRkchgRlybd0x7lp0wb5xiRQK+ZLakq6pvbm1HAxOHAdAG2IAs8WLP3IILDd2Ozg60TyBZ6AHvi6WSifoGG3aBtYFbAAdAoOOeSaI1OGG1FtQvz01YrVZkEywt2JpaaIlsxbUwPDyydfuOrdt2ArIozDAZIR3mcO38Saw7M+8eGJmad3lA1m9e+WVtQx1VKpTyebwUg+IGiIJngF7Qs5ErlT6v1+mYAnwbG6yVUnFiYiJXFBoamy3VtdU1aJfLUGxAjUMDl/FmxEc+9gRas8NDwyql3G5rQBRDVoG2FxS+3ucEw3RybQamjcPv8dtjPte02WzGuxdytQ6H9OG11Vw6IZWr4OnaOrqyyTiiACYjskLeeAtqcnICZzzoHdQYtXAUFy4PaIw1Tz77GTCQwUtHJP9Bmw2oyjEc6dkgHVBrNFAYqr+VleU1nxevUTbbapOxEOpMQB/Fdpnhc4nQ3OwMy+McRbXn0AcNRn02kUBOA3DiBQjkeYAMQCP6bthKzu/1eIavX2LLGaVCXmalcrU+6FtNRAImS02tvbWlvRvJHA53cfgHpUFV0AACMqwYmQkqxD+/+YdqvG6g1PA4Fcom00Vm94HDOBECJEgERNTDUaKAvirgTdwiSeI5XmU2hzyei+dO4hwAbVqjXo/kDK0ddNmWXC5/OK7Xqo1a5bI3eN/9DyEtTydicBJwTvBaop8gCT94YP2r88VkqL7aOOdcVJtqmru3Oecct0ZHMK2te2tVVXUsFAIEs7kMsFuq0MGgn+OkkWg4nysAHDMTo1Q+mcxRO/v34SAHSC4Vc6OjY40trZATyssyxaYTEXhVtIFgDHiBAEdevFI1Pjrykxf/8d57j6B1SYwKL57RbDSddSws2zs3QYF79h1EVuJbWXjn7Lmu3m2QF6yIJJU4/GORpBQQfHHm+H8BBX7u1zAdUR8AAAAASUVORK5CYII=";
const MON_CHAN_ICON_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAACcAAAAoCAIAAADyl3S3AAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAUGVYSWZNTQAqAAAACAACARIAAwAAAAEAAQAAh2kABAAAAAEAAAAmAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAAAnoAMABAAAAAEAAAAoAAAAAK65e2cAAAIyaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIgogICAgICAgICAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyI+CiAgICAgICAgIDxleGlmOlBpeGVsWURpbWVuc2lvbj43NzU8L2V4aWY6UGl4ZWxZRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFhEaW1lbnNpb24+NzY4PC9leGlmOlBpeGVsWERpbWVuc2lvbj4KICAgICAgICAgPGV4aWY6Q29sb3JTcGFjZT4xPC9leGlmOkNvbG9yU3BhY2U+CiAgICAgICAgIDx0aWZmOk9yaWVudGF0aW9uPjE8L3RpZmY6T3JpZW50YXRpb24+CiAgICAgIDwvcmRmOkRlc2NyaXB0aW9uPgogICA8L3JkZjpSREY+CjwveDp4bXBtZXRhPgqEtWRQAAANlUlEQVRYCX1XaWxc13W+97519o3D4QyHm7gNTUoWF+2SQ4kxI0t2hKZN0qY/UjRoHbQFgqYoEKB/CiTIj/ZPfzUxEDiNE1eNjAauElmuElsWtZJaqI0iKXERlxnOxtm3N2+5PXdmKNUtkEvivfvuPfes3znnDtbyEYwRooiNF5PGd22x9oB92Pz8qC9QBOfrx3dejBbXlthjh6zBHbYQz040zuzI/jzv+teOSHj/P2oKK/97HU5QgggSRF0zOHbSMAwdMTK2BX98bVZ7EEJ4gZ0nCKmaoWsvt17OXoh8uVSbvVwHKVgSk8nMw5mp8MJNRSmPjv/RwJ4RURB2BL+QinEqtX3zs9+moiuu5vbQ8JGenh4COur6/2H/+z8JJjrhZq5OPZv6ea+4+GYz0Qz66acJp+sf2rt6X4SyZishuXzu3uX/dCy9d6hVisb0+2fP3QtOHD35jWAwYFSV3y/pxS7GuKwZl/7rPW75V6c7FE/rsO4Z5NLz7duPY6uPvP52s1mqm8ukUoPmktHy+o3xoTbOO+TWCv3b80/DFz772eO+ibf3HzxIq2o9+MAXcxwihCGoHkuIlmHQmkuqOr3wHz/2py/u7THkjnGj/+vE3kU3LrdvbjyOPq0ox81muQ4LHs6rqppNhO0kIwbHjcG/wJpCNj8ZED70pjavffJPhfS3xk+eJhjroFw2n0jE0slEsZDRVZUTBJPF7vZ4vc0tZqt19tbvgrlLrwZ0MTCK+/4YiW5aKWBHt8PjV5eiarmIXG5mJIK4YoCOVsjEnGYBufoQFiiHSecpg5jcC784IRRuPPzJ+VzW4fJsLlynqUU7SrlkxQZUHNENVKrSRUW8jTxpw+kTkm/06LytBXV/GREbnbmOnG60q1ty+Ij6TK0UwangI8gp8DDWdV0pZ90mCclNNJNC8/dRZw/XdlSrJC3LHx5ur04/e0cQ8MkWzhWUecGMqBmStB5O9qKGphcK5TQhnChgHDyGHT2VmbtkdVnoQtjo5s0uzqiqSpkaBq5lUi2u1ECaxvMc4iRULhtbYT0ao/sOyx0TWvKJxViY3O0E5prBnKNq7AmgYJGtR4lpwFlMHLyZNdmlp1d+uXZtbtDu8bUEMKwQkWBKDb2RsczDbECOcuCuGsAMo6ptrq8uLD7cc7QjoCRAPSYPRDXMY2/4YrJ3BoCMAgUsEaLHH7Vqs4/U/JNwl6271w7nKEACPAsYbByAigCUUB5MSlVFRgVzQrFcXU48R+pMU/K/qZLBjJqVsfqozeCx891YhgU22BfHm2XT8WFnGocjpYIG+K4WDMzzosj2a8qCVMpzgsnmKlRUVN7WeSFeKSX1+IGQQ5QA6HXu4M/aBGxqHGyYWpNfpwGB9UWsU+SySF86KHsCeWrkqrmERkyiZAXzakSUB98JPG91+dYqGOXWdMeIGOSOmonbLtcCUZNmQFKqmKUpx+L5AkvMtJpiEALmBGAKM8gyBD61Qk2o3sfL1UTkGTEP8WYr8xAAAmGQinie2NwtFa6pGHksW4IdrnXKmUBknYjpz5uwsxtXs0ZhC1FWI2Fxx0AIKMWWFq5zEtmCxtwvaGETQgz8DWgB1RLZul0tFfLFoq69LOw1NBHMmayaqXXt+eUBI61qUAJJnSnoBcYRVy8Z/S4qxeniL2n8Xt08eO4Mgr17cdtxCrZKNlSAZaZqPSQGwc8TqtTsEUVoLY1Rkwrk4BXCFfJaqVIROQJeaFgDRyGvlDQtJ7GpCVv9NA4Z9/mWAOlSjhnxWZTboOlloGcggH84SrEAHU/gnE0BXmiUQ1jHei4MKuo6nX945+YH3/+TUWKWBEgiJm7HjQxylhYk2o1iDFWzta36foMMSjEhlAPVIekNrNUzs55KiBZKlaup0NgffNfX0gqUIJVVRKYUQrLI7WqWrSboxEwbln817wJs82WNVNYtMrAlRv1A/UxdM0ARzyVy1QsziXvrlck9rvEhh0XkGBuGLmy3isLGaj4R8TS18OCpRlfHuKJUkuElD5/F2FFjxcwE1dMl/d+vpn7yadxh5v78hPcP97vMMgaX17HIuFIK+ZApqmenlTvZ0WuLj6bjUhkZb+zGZnBujQ76VJOcT26t+rsByTI7Ule3qlYK2xtNNlxzAOMGcVY0dG+T+82qXzG1fvXbP5gthi7OJuucoL4hXWX/zBg6v1m8u6YGd/X7mhzlKoryA2XDxADBahKEHTWZaTEdrlYr9aABmpiLdUVRCkmrna/FgiEBLKJE0Kztkq0Quzt79v1/S8UjTWOoVFFMkojNfs7qhSJnlNOoFFN1fWMj/P6lHwIrf2tHf2+n3bINYEGcQLUS1TSLhKuFlK6Blmw0MEx1FaslUSBMMYAo9DvCQ38Z6HR63TiXy01PT7st2GrqFPyjpOv1LcW1tBGHUtDb7m+1FXdxH/VeP39tPg+xHBoMde4KSsE92OxDRKLFCFq/LK/f0pMJtVwC9+5IhSn0IKqDu5HJy7W9hr2vIsECagaKqTOV7d99eiUaCR8/+Mrxr3xNGj194bO57//wB4/mFvr7Q6PDQ1//6luvT3zn75qPB0cvb8ZSf/mVN7sFM95UkK2A2jzYO4w9gzaL17H56+jzebfXL0kiw7CuG8V8SlBTkqcHDX0LewYQXBCzKby6IVYqpwKO0Lv/HFG0gVCv3+cFX4Q3N8KRrXK5fP/+rKFVTp/8AiXywN4D/zh6CBXz6PYNY3WjbhOCytDajnhRb5/cog+DcMeBYNcyB1fVanRjVdMV1P0W8QxQQ0VKCa08RWvLiON4gkOtHaEjRwHxVDOgA515czKdybz73jmTLP31t7/5xdcOIbhL6lAcoIdTarWjYgHyEnt91OWB2EPX58xeW+/xjr49kiiCQqz6y6LY0jW4vnasau2TDejaFAkSDrZRgFyphCwWwx+s5PKZTMZssTqdDp/P872//5vJiSPAemRslNFjsrSyWExndu/ZzQ0No94BMIjutCwi8E8eP45GokN7IDOgEgCa4AhHbC6P7GjZjKd7nV5W3qHSNAeQ148AdRwPFtNyaXHhqW4YB48cFiTp+cqz2d9eKmQy+dR2Z39/NpV+tvi0q7uLgxskxEw2gVSmTb0VYby0vLrvwIGWZh9bBw+zjkGp3WYLtHddv3Yz2NZukmX4hcBUgkMCcwjYZDZZRvaPXbr48ff+9jsOpdqjVtsNHQprdP7Jh9nMttP9p2+/vXd4pF7wavIYd1aOBf7WteuGbgTa2gVJZJ4HqaxSUypJ8tDwiKZWr05NTUxOcoQwwUwsk82Godvtji9MnNh4usDfnv5Sf0g2W6B6Deq6trJaGRkdGxtjnOrEtRrAkl4S70zPLC0tHxufcNmdrG7UBtbz4QYlwdlMduryJ4Zeff3UG1aLhaqNpGZKswHxFhfmHkcvfvRKqei12wDPUF3mCDGNnxjav5+qWs0ERko4du+5NnU1Hkscm5hscrsZeneUImzCHAHVlLhc7sm3zkBn+Ok77yw8mceCiOEnUUNkjU7XOru65N7edbWqaRpHjfV8tuhye9vad3zLbmFEFJLbqQ/OffDjn/8rErBJNrGStyMSGPGcLGtVNR2PZ/NZt6fJandAS5wNz91/9/Erwb5Tr7/V1z/AQVprcO1idVWW5Z7DR+8r6rm7d+BXg7m3Z/j4CZ+vGXah84CN6e3tu7fvXLr2cc+e0a99869K0USxXDSbAV8vxeLzZ3+0nU4JHOZ4Pry+MTA4ZLJaLt261Dvy6oMH0z2u/kTk+aHRw2OjYx5vMwHxrGRCKTOKhZKm61a7VWApCPcqNRbd+uzKlVsPro/sG2/v7bv64GOhLO9yBiYmT7odroYzACmQNVc/+llTsz+0exDaQyqWmL03M3VlSnDaBg/tU6mSSMdaHK2ldOHhvZsS4UPdoe7OXa2BgM/nk81mEJ9Op1aWluOxSCaXf7S2EOwJyQ6T3WqrKOVkMk4UzkrF06fPNDd5X0iFkPFHj38RGpaRXKbFqNvq3X/4yGYkcmHqo9a9fZpWKVeKKSHOmyXfYEdnc18mnZqau6vfvRFeX3GI9vb23lKlZPN4oIKthVfdgcDw7v0Xr/4qV9x22D3JdKzLH7JbfXAHhVjuDAZMXk+t0tVf65EZrOax7CLu4V02MuFOx2984h87Zbdyrd7genQ52Ny1HH1iNzuCXZ2LTx4qnOHsawsODCw/mV+OLDqam9LFTG4t937iR35vYKTzcFdHSFXxuZ/+S/94QBZf3phAJEQIV8+fobkIoAo6PqgRy5TvrZTGX7FlitqVZe1x2e3q2afwlIg01DUUcAd/c/5srpB+9cAhh9OzubySTaYtFvvTpYeeJt/ukbGinva6gpHEVjGRcWc2fIX7Yt+X95/6M6fDUQNEw2AewQWMFyF1INWqGo1kNKeZWM2iSRK+4TEy+dx85PxaVgyLoWexyoPilIKVPYcO2e3O1dWFUqEousSt8NLuFn+rzzc/c72ChaQp6hX07sqd0VbNJIpT22tquYAc8PusjmFmKg83rXoJUKtGZLu0nii/FnJAu4ZNjRK71XQ4JB2RXGjs7Y285dz5sxwxV9QyyRIJmxwBDydy1VTs6LFjo/sOV0vlQknhJZMVZchcQU+vaJqKtZyqVOCyUJdSy378P+3NoNTZsT4sAAAAAElFTkSuQmCC";

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
  .brand {
    display: flex; align-items: center; gap: 0.5rem; font-weight: 700; font-size: 1.15rem;
    letter-spacing: -0.01em; color: var(--text); text-decoration: none;
  }
  .brand:hover { color: var(--text); }
  .brand svg { flex: none; }
  .brand .go { color: var(--accent); }
  .brand-logo { flex: none; border-radius: 7px; object-fit: cover; display: block; }
  /* The one small, consistent signal that a control triggers the language model rather than a plain
     database action -- see the buttons that carry it: resume/cover-letter generation, role and job
     analysis, company discovery. Never on navigation, deletes, or ordinary settings. */
  .ai-icon {
    display: inline-block; width: 15px; height: 15px; vertical-align: -3px; margin-right: 6px;
    border-radius: 999px; flex: none; background-size: cover; background-position: center;
    background-image: url('data:image/png;base64,${MON_CHAN_ICON_B64}');
  }
  .header-actions { display: flex; align-items: center; }
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
  .subpanel { display: none; }
  .subpanel.active { display: block; }
  .role-analysis-roles { display: flex; flex-direction: column; gap: 0.7rem; margin-top: 0.6rem; }
  .role-analysis-role {
    padding: 0.7rem 0.9rem; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .role-analysis-role p { margin: 0 0 0.4rem; font-size: 0.85rem; color: var(--text-muted); line-height: 1.45; }
  /* The collapsed card is a two-line scan target: title, then the one-line fit summary. With 5-10
     role families on the page, anything taller stops being comparable at a glance. */
  .role-analysis-role > summary { cursor: pointer; display: flex; flex-direction: column; gap: 0.15rem; align-items: flex-start; }
  .role-analysis-role > summary::-webkit-details-marker { display: none; }
  .role-card-title { font-weight: 650; font-size: 0.95rem; }
  .role-card-fit { font-size: 0.85rem; color: var(--text-muted); line-height: 1.4; }
  .role-card-body { margin-top: 0.7rem; padding-top: 0.7rem; border-top: 1px solid var(--border); }
  .role-market { margin-top: 0.8rem; padding-top: 0.7rem; border-top: 1px dashed var(--border); }
  .role-market .badge { margin-bottom: 0.35rem; }

  /* Profile → Summary. The record is far larger than a resume, so nesting and collapsibility are
     doing the work of keeping it reviewable rather than overwhelming. */
  .profile-name { font-size: 1.15rem; font-weight: 700; }
  .profile-group { margin-top: 0.9rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
  .profile-group > summary {
    cursor: pointer; padding: 0.6rem 0.8rem; display: flex; align-items: center; gap: 0.5rem;
    justify-content: space-between; min-height: 44px;
  }
  .profile-group > summary::-webkit-details-marker { display: none; }
  .profile-group-title { font-weight: 650; }
  .profile-card { padding: 0.7rem 0.8rem; border-top: 1px solid var(--border); }
  .profile-subcard { margin: 0.5rem 0 0 0.9rem; padding-left: 0.7rem; border-left: 2px solid var(--border); }
  .profile-subcard-title { font-weight: 600; font-size: 0.88rem; }
  .profile-field-label {
    margin-top: 0.55rem; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--text-muted);
  }
  .profile-bullets { margin: 0.2rem 0 0; padding-left: 1.1rem; font-size: 0.85rem; color: var(--text-muted); line-height: 1.5; }
  .raw-json { overflow-x: auto; font-size: 0.75rem; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
  section {
    margin: 0 0 1.1rem; padding: 1.15rem 1.25rem; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
Let me check the placeholder embraces like a variable name, gets its value when the prompt is compile careful. This is one of the prompts I'm using and the response first read it and let's talk about it. All right, so basically this gets used to analyze what kind of roles are suitable for you. So the idea would be you know if you are let's say you're a teacher and you put all your experience maybe it can like tell you that you're suitable for there's other rules suitable for you for me right I was a teacher and I did a lot of different snake things in tech I can't I'm not sure exactly what you know what what roles are suitable for me out like I don't know what those rules are so the idea is this is supposed to build a profile of like the kind of things my skills my strengths and stuff like that and then the next step is it's gonna take that and it's gonna analyze like what kind of roles I'm suitable for and explain what those roles are okay so right now this is just generating the profile and then you want to take out somewhere else and have it run against potential jobs so even before that I'm going to have another language model call that's basically going to look at this and say like okay like I'm trying to basically work through if you actually went in imagine you went into a service that helps you find a job and you paid them a lot of money and they're super professional I imagine the first thing you would do is they'd want to know like tell me everything about you tell me everything you've done before all your past history and like everything like this and it builds a profile of your skills and everything and then the next step after that is okay now I know everything about you now let me look at the job market and see what kind of roles actually exist that match that which is that makes sense yeah so what kind of helps you on here so basically I want to restructure this prompt like you could see the prompt and I agree the writing style completely be gone that's not necessary that's a mistake but I like of course we don't want to invent stuff but like basically what we want to do is like create a complete you know profile of them and I don't know like I guess maybe if we I don't know the example of the perfect structured output but maybe that's a good idea for us to have I suppose but like what would you suggest like if would it make sense for this to be structured for the next language models to look at let me take us like and think through a concrete structure i think your instinct is right here so separating out the steps into something like evidence to profile to career analysis to role generation each step is clean and focused and you build on each step in order and then the final job evaluation step compare jobs against that structured profile plus the preferences and then your first prompt is just about building that deep profile not focused on optimized for job matching yet the profiles richer than a resume right shouldn't this profile should be structured and so like wouldn't it make sense because like of course your resume is not going to include a lot of stuff but like later on like for example what I'm gonna want to do is have an agent that like talks to you like when you make a resume there's certain like later on there's certain things you need like you know did a project with seven percent growth like you you you want to like say certain stuff people don't know to add that so like here you're just kind of putting everything to everything like you're saying it's like you go to your taxes here's everything I have you know you ingest it you make a structured profile that I guess you know it's pretty obvious we should have like school a category for school like I guess it would be all the different categories of things that go into a resume like written in a way where it's easy later for someone who's good at like putting together the resume to grab pieces from it and so we probably want to be structured so what would be like the standard structure you would have like you know education and then for each education you have like what the school is when you went there you know what like what you what you majored in like all like yeah all this kind of stuff and then it would be like education previous roles skills you know maybe maybe like technical skills not technical skills like so can you can you right now I'm gonna turn off voice mode I want you to basically suggest a structured profile that would like encapsulate everything even with I guess in other category that everything should go absolutely okay this is good but not specifically just for me like I don't know if maybe like mentoring but like mentoring if you're mentoring it would be within a specific job so the idea here is like within each job you know these things like anything you do that is mentoring should be within a job you know like everything should be related to that job because like later what we're gonna do is probably pick the jobs that matter like the jobs to include that matter and same thing it's like I guess awards and honors are like if you get an award and an honor and it's you know inside school it goes with that school but it makes sense that where's honors are here outside school community outreach is good actually this is pretty good okay great so now I want you now we need to make the prompt and I think for the prompt we probably want to give it the correct schema so I'm going to give you the prompt we have now because that'll show the variables and I suppose you need to give the exact schema with like an example with fake information and make sure you have something for each so it knows the format so like make something up for each section and like it should know how to do it if there's multiple for example if there's two schools that should be clear if there's projects and research make a full prompt that gives that example in it actually before you do that can you tell me if I'm giving an example schema and I am working in lag fuse what's the smart way to have the example schema because I suppose it's gonna like scored for how well it matches like how good should I just manually build it in here or does it go somewhere else I ordered some CBD oh thank you so that's what I currently have for the prompt so you want you to fix the prompt based on this but I think if the current profile doesn't match the schema make sure the new one does, but maybe we don't even need to say that actually you have a connector can you connect to GitHub and you check this project apply go and check this for me so I'm worried I'm looking here and I see it gives you the current profile and source material for new material question is when this prompt is going through when it gives you the new material is that all of the material or only the stuff that's been added recently because I'm worried if you if this generate if this did a bad job before then we're only looking at like the structured profile although we do need the structured profile so my question is currently does the source material everything or just the new stuff and what should we do about that so just answer me that how do I erase so like when I put answers into apply go hello yeah like the pull down tab it shows a check mark first name checkmark last name and I think my problem is I wrote down it's like recalling the wrong thing like when's the earliest you want to start working with us and so it's gotten its memory how to answer these questions and some of these are pulled down tabs and for the pull down tabs it didn't it's I think it's still not recognizing them am I doing something wrong like I got to reload the extension okay hold on a second it's still not recognizing that pull down tab for country if I click it it shows different countries but we need to figure out a better way of extracting like you know doing these pull downs you can see it I like that it shows it didn't accept it but I need a way to do this I need a way can you find a way to make it automatic also you said there were other changes that were not committed can you check them and if you think they're a good idea tell me what they are and then commit them if you think they're a good idea okay do let's change it like you said and let's also get rid of that character limit or at least make it a character limit I think no one's gonna upload pages that are you know more than five pages so any document that's more than five pages worth of characters you can get rid of it you can truncate it or maybe ten pages no no one's gonna do it but do that and so I think all you need to do is give me the prompt yeah the prompt and the config which I think you're saying is the structured output so if you can give me first the prompt autonik config is for like an example structure so where are we supposed to add the example structure it's supposed to be in the prompt okay knowing all that give me the perfect prompt that's totally complete right now this one is supposed to find rolls like the result supposed to tell you like what kind of jobs what kind of job roles like imagine you don't really know what jobs are called like what job roles are actually probably a decent fit the ones that are worth like worth looking for like basically yeah the result the result of this will support company discovery so which kind of companies should even look for but then also which kind of jobs are suitable like it'll do like a filter you know and only pull back jobs that like are like this that are similar to this also you have access to the repo so take a look and I want you to find the meaning of these variables I'm assuming candidate background is their profile but I'm not sure notes locations deal breakers these are all like the criteria for what they want to do so I think the idea here is yeah I want you to look through the repo and make sure this all still makes sense right now I have two language model calls I think profile structure and rolesanalyze I think that's right is that it's creating your profile. Let's talk about can you check the workflow of all this so you understand where the information comes from and then let's talk about it all right let's kind of think this through together and I think what we're going to do is come up with a plan and I'm going to give this to like Claude Opus and have it make these changes and also like connect to update the prompts like automatically and lang fuse let's think about this so the idea I had was like you go in order forced rolls then resume then companies so it's like okay roles but I guess the question really is with the current way we're doing this if you go in order then you're looking through roles and try to come up with roles before it looks at your resume right right yeah so really you'd want the resume first the full picture and then roll second then companies is that what you're getting at I wonder if we should change roles like call roles to profile maybe and but we do kind of want like people come if they want a job it's like there's the concept of like your profile and then there's like what is it you want and then we work on resumes so like the idea is currently the resume tab now the idea was you know you upload everything all the your resume stuff and then it makes your master resume and that kind of like has everything and then from there you have like custom resumes for each job where their master resume you would never send that out but it's just like basically has kind of everything for each job even if it's not formatted the correct way I mean it's formatted the correct way but you know all that information does it make sense even to have a master resume like that i think there's a cleaner separation than what you have right now where roles becomes your profile first like who is this candidate and that's fed by resume and notes and then after that you go into career direction which is like what kinds of roles and companies should we target and then after that you can get to resume tailoring which is just about presentation and not about changing the underlying data and on your master resume point I'd probably rename that to a master career profile not a resume just to remove the idea of page limits and marketing constraints and then just keep it as a canonical data record then you can generate tailored resumes from that without losing any of the source information in the process of tailoring all right so for the tabs what are you saying right now it's rolls resume what do you think for the first tab should be I call the first tab profile and make it the canonical career record like your structured facts about the person then the second could be brolls and targets or maybe career direction something that makes it clear that it's about discovery and not just titles and then resumes come after that as a presentation layer that ordering lines up with the actual table profile careers resume oh yeah that's even cleaner profile is talk about what goes in profile profile is yeah profile would include your work history details accomplishments responsibilities skills education media short narrative arc but it's all factual no preferences or job targets just the evidence so profile should be where you upload your documents like your resume exactly upload everything there your resume CV notes anything and that builds the structure profile underneath okay so let's talk about then the careers tab so in profile right now like in resume I have a documents tab so let's imagine that's going to move into profile okay so within profile docs makes sense as one subtab then another could be structured profile where you see and can lightly edit what the system extract it keep it minimal but transparent how about it's yeah docs should be the one where you okay so there's one tab docs and there you just it works just like the resume documents tab now where you're basically choosing a file and uploading it and that's it yeah that works simple upload extra logs like the from the resume we have the notes tab this is where they can also just paste in information paste more stuff they can add you know a bunch of notes they can also invoice go voice to text and just talk so like this is where they're just adding like text instead of a document yeah nice so within profile choose subtops dogs for files notes for free form text or voice under the hood both feed into the same structured profile builder you have those two and then let's talk about what happens you so you add those two and you would want to like then see your structured profile like it's basically should take those because now it has everything about yeah but if like your profile so so for example your profile doesn't include you want to work remotely that's more to do with like job right so profile is purely background that's like super structure that has your job your all the colleges you went to and everything that's it that's where the education job skills accomplishments live no preferences yet okay so then how how are we going to get it like I guess we want to like generate it and have to be able to see it in some nice pretty printed JSON format and yeah totally after Docs and notes are processed show the structured profile in a breedable JSON due blood people notes and then a third tab is what we call it because we shouldn't call it profile because we're already on the profile tab should be something analysis analysis or maybe extracted profile something that signals this is what we understood what are some more options sure parsed profile profile preview structured view review and confirm for like put it all together consolidate profile or unified profile how about summary just summary short and clear summary when you go to the summary tab now there's like a little button you press that's basically like regenerate or generate if you've never generated a regenerate profile and then it does this prompt this prompt that takes that information and then consolidates it and like make makes that structure json file and it's not formatted like a resume but it's in that structure like exactly the structure we saw and it shouldn't show like you know curly braces like it should look pretty printed should look really nice with with like you know the indentations are good like really easy for human to read right a clean human friendly view with I'm sorry but you've reached your daily GPT Live One limit for today you can continue with GPT Live One can hear me loud and clear what's on your mind so do you remember what we were just talking about quick summary what did we just talk about right we were talking about reorganizing the apt tabs so that it's profile careers resume and within profile subtops for docs uploads do careers and so for careers here this is like what it is that you want which comes from like the roles and so if you look at current what we have for roles it was like what are you looking for pace job links and so I think what we want is a couple we want we want one of them which is like you kind of you would be able to write you know unstructured text about what kind of jobs you're looking for as you might know so what do we call that not targets but like maybe desired roles or role role preferences something like that it signals what you want without forcing a specific drop type that's good preferences and then here the idea is like here you're supposed to loosely write about you know it's okay you can just basically say what jobs you want so you can say you can say the exact name of the role the official name or you could say like oh I want to roll where I do this and this and I get to do this and this so it needs to be able to be loose but also like give you the exact answer if you give the exact answer or they can be like loose either one and that's that's this first one right okay maybe call that roll signals or roll notes do what I said I said career preferences call it preferences in the next one preferences let's have it be examples and then this is the one where there's like good like you can you it's optional but you can put in job links you found that are good and like basically you can add one add to like good or bad or desired or undesired and then you can like put a job link and you can have like a text optional where you explain why and then for example you could say oh i don't like this job because it requires you know such and such experience so you can add those so this is like examples of good jobs and bad jobs checking i like that so in careers you'd have preferences for free form wants like exact titles or things to avoid then examples good and bad job postings with URLs and notes and location which is already what we have in roles but this isn't careers same thing deal breakers and then also criterion works the way it works now and then we need you know to and then the idea here is like okay that its own subtap call the button analyze careers it takes profile plus all careers inputs and outputs a rolls subtab then roll shows a summary role families keywords and why they fit with a re analyze button and maybe rename criteria to priori yeah you're right rename criteria to priorities this is good and then for analysis yeah i guess we'll put it yeah let's call it rolls because i think we're not using that now so instead of what it currently says analysis it says rolls and then that kind of operates like it does now where you analyze or reanalyze and it takes everything and it tells you like the kind of careers that you're looking for and I think what actually would be a good idea is like to say like for each one like for example I got I got a result of applied A engineer and it explains what it is and that's good but maybe like you said maybe like it shows that it gives the name of the job the kind of the job title and then maybe we should do the thing where you like click it and expand so imagine you've got ten of them you click it and expands and there it should show like why it shows it for you it should show like you know like analysis of like if this is a career that is you know increasing you know with government reports or whatever in that location and also like the expected salary for you know for your experience level checking yeah I like that extended cards per roll default shows role title and a short match summary span to see so now we said we have profile what was it profile career and what was the next one resume resume we've already uploaded everything so the current resume tab we don't need the documents anymore and I guess we don't need the notes anymore because we already added that somewhere else checking right so resume becomes just generate application documents so a master resume tailored resumes per job and cover letters that keeps profile as the canonical data it probably doesn't maybe it didn't make sense to be said to have like one giant master resume that's like five pages long I think right so maybe it just makes sense I don't know maybe we don't need sub tabs like basically all the resumes but then I think it would make sense is like we're I think we're gonna have a lot of different resumes but I think it would make sense is like for each of those job roles to generate a resume for that job role keep a general resume as the default then generate tailored versions per roll posting profile is the source of true let's say it puts you to like five different types of jobs five different like roles I would like to have a way where it makes your you make a resume for like to start with you make a resume for each roll type right so after analyzed careers generate a base resume per role type like applied AI engineer resume and then tailor from that you could also link each expandable role card in the roles page to generate resume button yeah how about that in the careers in the role yeah in the careers page under roles like where we were expanding each one no you know what maybe let's not do that let's do it in the resume page we got to have this in the resumes page we've got why don't we have like a rolls we think I'm trying to find a way to organize it checking I shift to organizing the resumes themselves so you see cards for each resume with roll tags attached symbolists no extra subtabs for example applied AI engineer resume last updated today open or regenerate then you can have career resumes as base versions and job specific resumes clearly linked back to those I think something like that makes sense I think you can use your best judgment on that because I'm going to have to make you have you make a prompt for that but I think that's what we want to do and what I want you to do now okay so I want you to do now is I'm going to ask you to make a prompt for opus so this can be like a big task and this is basically going to make all those changes and make sure like the it looks at the prompts and make you know and the prompts lying fuse and like actually updates everything this is going to be like kind of a big restructure to do all this check in I think this war in a big refactor pumped for opus make it an architecture migration restructure Ui tabs to profile I think I might go shopping so that's my credits replenish in ten minutes and I can send a big job in or I need bread cheese we have mayonise I'm sure covers are good here wipes tonight we don't use to do it tomorrow right tomorrow is Sunday we really don't have any food huh so maybe I'll cook once twice pork chip I get chicken again pork chicken we went rice right progress I see it read them now but it should be pretty obvious like it should know like basically it should have the line I want the language model to think about it and answer it should be pretty obvious which of these is America and if it's not only if it's not obvious ask me sort of like a virtual world I think and you and other people walk around and sort of maybe solve puzzles I've never played but we'll check it out and let you know do you want to go in a couple minutes you don't what y'all go about a new arrival by myself again this cookies for me actually a problem here is like it showed me all these to pick from and I picked it but it still didn't accept it so somehow like even though it's reading them it's not able to write them all right let's do it what's that package only a meat can be here so where do we go beans and broke always first I have a lot of that give me one of the lives do you have plugin everything away it's on drink back probably  }
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
     red-outline vocabulary the Jobs cards' own "Not for me" already established, so it reads as a
     known shape rather than a new one. */
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
  .subtabs button.active { background: var(--accent); color: var(--accent-contrast); }
  /* A true three-way selector for the Companies list. The connected outer track makes it read as
     one control, while the filled active segment and inset ring remain unmistakable in either
     color scheme instead of relying on a subtle color shift between three unrelated buttons. */
  .segmented-control {
    display: inline-flex; gap: 0; overflow: hidden; padding: 3px; margin-bottom: 1rem;
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-2);
  }
  .segmented-control button {
    margin: 0; border: 0; border-radius: calc(var(--radius-sm) - 3px); background: transparent;
    color: var(--text-muted); font-weight: 650;
  }
  .segmented-control button:hover:not(:disabled) { background: var(--surface); color: var(--text); opacity: 1; }
  .segmented-control button.active {
    background: var(--accent); color: var(--accent-contrast);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.24), inset 0 0 0 1px rgba(255, 255, 255, 0.18);
  }
  .segmented-control button:focus-visible { position: relative; z-index: 1; outline: 2px solid var(--accent); outline-offset: -1px; }
  /* Mobile replacement for a .segmented-control: a row of pagination dots plus the current
     subsection's name, with horizontal swipe doing the actual navigating (see the
     initMobileSubnav script below). Hidden by default -- the media query below is what turns
     it on and hides the segmented control it stands in for, only on screens too narrow to fit
     every sub-tab label on one line. */
  .mobile-subnav { display: none; }
  @media (max-width: 640px) {
    /* Visually hidden rather than display:none -- the buttons still do the real navigating
       (the dots/swipe are cosmetic, see initMobileSubnav below), so a screen reader or keyboard
       user needs them to stay reachable even though sighted mobile users no longer see them. */
    .segmented-control.has-mobile-subnav {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
    .mobile-subnav {
      display: flex; flex-direction: column; align-items: center; gap: 0.3rem; margin-bottom: 1rem;
    }
    .mobile-subnav-dots { display: flex; align-items: center; gap: 0.4rem; }
    .mobile-subnav-dot {
      width: 6px; height: 6px; border-radius: 50%; background: var(--border-strong); padding: 0;
      transition: background 0.12s ease, transform 0.12s ease;
    }
    .mobile-subnav-dot.active { background: var(--accent); transform: scale(1.25); }
    .mobile-subnav-label { font-size: 0.95rem; font-weight: 650; color: var(--text); }
  }
  /* Settings tab's gear icon replaces its text label but keeps the same button box, so it needs
     to center the icon the way a short text label centers itself. */
  nav button.tab-icon { display: inline-flex; align-items: center; justify-content: center; }
  nav button.tab-icon svg { display: block; }
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
  .interested-card {
    margin: 0 0 0.65rem; padding: 0.8rem 0.9rem; border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--surface); cursor: pointer;
    transition: border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease;
  }
  .interested-card:first-child { padding-top: 0.8rem; border-top: 1px solid var(--border); }
  .interested-card:last-child { padding-bottom: 0.8rem; }
  .interested-card:hover { border-color: var(--border-strong); background: var(--surface-2); }
  .interested-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .interested-card.is-expanded { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .interested-inline-tools { margin-top: 0.85rem; cursor: default; }
  .interested-inline-tools > #interested-detail-section {
    margin: 0; padding: 1rem; background: var(--surface-2); box-shadow: none;
  }
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
  /* Pipeline flow diagram (Search tab). Queues are upstream reservoirs, processing stages are
     narrow gates, and only resolved decisions accumulate downstream. */
  #jobs-pipeline { margin: 0.6rem 0 1rem; }
  #jobs-pipeline svg { display: block; width: 100%; height: auto; overflow: visible; }
  .pf-stage-title { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; fill: var(--text-muted); text-transform: uppercase; }
  .pf-node-rect { stroke-width: 1.4; }
  .pf-node-label { font-size: 12px; font-weight: 600; fill: var(--text); }
  .pf-node-count { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; font-weight: 700; }
  .pf-node-pct { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 10px; fill: var(--text-muted); }
  /* fill and fill-opacity are set per-edge in JS (by flow kind); nothing to fix here. */
  .pf-dot { filter: drop-shadow(0 0 2px rgba(0,0,0,0.25)); }
  .pf-reservoir { pointer-events: none; }
  .pf-reservoir-queue { stroke: var(--warning); stroke-width: 1; stroke-dasharray: 3 2; }
  .pf-node-gate { stroke-width: 2.4; }
  .pf-splash { pointer-events: none; }
  @media (prefers-reduced-motion: reduce) { .pf-dot, .pf-splash { display: none; } }
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
  /* Companies pipeline (Search tab). #companies-pipeline holds the real Sankey (#cpf-svg, same
     engine and dimensions as #jobs-pipeline -- see createPipelineFlow) for Discovery -> Verify,
     both stages counting companies. #companies-pipeline-row visually joins a third "Pre-screen"
     card to its right so the diagram reads as one continuous pipeline, but that card is
     deliberately not a third ribbon-conserved Sankey stage: it counts jobs, not companies, and a
     flow-conserving ribbon across that boundary would visually claim a company-to-job unit that
     doesn't exist. */
  #companies-pipeline-row { display: flex; align-items: center; gap: 0.5rem; }
  /* Fixed at 58% (not 100%) of the row on purpose: the viewBox below (vbW 770) is tightly cropped
     to this diagram's real 2-stage content using Jobs' own per-stage constants (COL_MARGIN,
     COL_STEP, node/font CSS -- all shared, unchanged), rather than Jobs' full 3-stage vbW (1320).
     Stretching that narrower viewBox to 100% of a full-width row would scale every node/font/stroke
     up by ~1320/770, i.e. visibly larger than Jobs' -- exactly the "too large" complaint. Capping
     the container to the matching 770/1320 fraction keeps 1 viewBox unit equal to the same real
     pixel size in both diagrams, so node size/typography/density genuinely match, not just the
     stage-graph logic. */
  #companies-pipeline { flex: 0 0 58%; max-width: 58%; margin: 0.6rem 0 0.5rem; }
  #companies-pipeline svg { display: block; width: 100%; height: auto; overflow: visible; }
  .cpf-arrow { flex: 0 0 auto; font-size: 15px; color: var(--text-muted); }
  .cpf-stage-handoff {
    flex: 0 0 auto; padding: 0.7rem 0.85rem; border: 1px dashed var(--border);
    border-radius: 10px; background: var(--surface-2);
  }
  .cpf-stage-handoff h3 { margin: 0 0 0.35rem; font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; color: var(--text-muted); text-transform: uppercase; }
  .cpf-stat-primary { font-size: 20px; font-weight: 700; color: var(--text); font-family: ui-monospace, 'SF Mono', Menlo, monospace; white-space: nowrap; }
  .cpf-stat-sub { margin-top: 0.15rem; font-size: 11.5px; color: var(--text-muted); font-family: ui-monospace, 'SF Mono', Menlo, monospace; white-space: nowrap; }
  .chip-list { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.3rem 0 0.5rem; }
  .chip-list:empty::after { content: 'No search terms yet.'; font-size: 12.5px; color: var(--text-muted); }
  .chip {
    display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.3rem 0.4rem 0.3rem 0.7rem;
    border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2);
    font-size: 13px; color: var(--text);
  }
  .chip.chip-manual { border-color: var(--accent); }
  .chip button {
    all: unset; cursor: pointer; width: 16px; height: 16px; border-radius: 50%; flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1;
    color: var(--text-muted);
  }
  .chip button:hover { background: var(--surface); color: var(--text); }
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
  .gmail-steps { margin: 0.75rem 0; padding-left: 1.25rem; display: grid; gap: 0.5rem; font-size: 0.9rem; line-height: 1.5; }
  code {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 0.85em;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 0.3rem; padding: 0.05rem 0.3rem;
  }
  .critique {
    font-size: 0.9rem; border-left: 3px solid var(--accent); padding: 0.5rem 0.75rem;
    background: var(--surface-2, rgba(127,127,127,0.08)); border-radius: 0 0.4rem 0.4rem 0;
  }
  .row-facts { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.3rem 0 0; }
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
  /* Compact green action -- Recommended/Not Recommended's "Interested" and Removed's "Re-add" -- same quiet,
     colors-on-hover convention as .danger, just green instead of red. */
  .row-actions button.success:hover:not(:disabled) { color: var(--success); border-color: var(--success); }
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
    <a class="brand" href="/" aria-label="ApplyGo home">
      <img class="brand-logo" width="28" height="28" alt="" src="data:image/png;base64,${APPLYGO_LOGO_B64}">
      <span>Apply<span class="go">Go</span></span>
    </a>
    <div class="header-actions" aria-label="Utilities">
      <button id="sign-out" class="secondary" type="button">Sign out</button>
    </div>
  </header>

  <nav id="workflow-nav">
    <button class="tab active" data-tab="profile" type="button">Profile</button>
    <button class="tab" data-tab="careers" type="button">Careers</button>
    <button class="tab" data-tab="resume" type="button">Resume</button>
    <button class="tab" data-tab="companies" type="button">Companies</button>
    <button class="tab" data-tab="jobs" type="button">Jobs</button>
    <button class="tab tab-icon" data-tab="settings" type="button" aria-label="Settings" title="Settings">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
      <span class="sr-only">Settings</span>
    </button>
  </nav>

  <div id="panel-careers" class="panel">
    <div class="segmented-control" role="group" aria-label="Careers sections">
      <button class="subtab active" data-subtab="notes" type="button">Preferences</button>
      <button class="subtab" data-subtab="examples" type="button">Examples</button>
      <button class="subtab" data-subtab="locations" type="button">Location</button>
      <button class="subtab" data-subtab="dealbreakers" type="button">Deal Breakers</button>
      <button class="subtab" data-subtab="criteria" type="button">Priorities</button>
      <button class="subtab" data-subtab="analysis" type="button">Roles</button>
    </div>

    <div id="subpanel-notes" class="subpanel active">
      <section id="role-signals-section">
        <h2>What kind of work do you want?</h2>
        <p class="hint">Describe the direction you want your career to go, in your own words. Knowing the exact title is fine ("Applied AI Engineer"), and so is only knowing how you want the work to feel ("technical, building prototypes, explaining things to customers, not infrastructure all day"). This is preference data, not proof of qualification -- what you <em>can</em> do comes from your Profile. The more you add, the better the Roles tab gets.</p>
        <details id="role-signals-details" class="disclosure">
          <summary id="role-signals-summary">Notes on file</summary>
          <div id="role-signals-list"><p class="empty">Loading…</p></div>
        </details>
        <form id="role-signal-form">
          <label for="role-signal-text">Add a preference</label>
          <textarea id="role-signal-text" required placeholder="e.g. 'Applied AI Engineer or Solutions Engineer working with AI products, hands-on prototyping rather than pure research, customer-facing technical work'"></textarea>
          <button type="submit">Add</button>
        </form>
        <p id="role-signal-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>

    <div id="subpanel-examples" class="subpanel">
      <section id="role-examples-good-section">
        <h2>Good examples</h2>
        <p class="hint">Jobs that represent the kind of opportunity you want -- open, closed, old, already applied to, or purely illustrative, it doesn't matter. Paste a link and we'll try to read the posting; if it can't be fetched, your reason alone still counts.</p>
        <details id="role-examples-good-details" class="disclosure">
          <summary id="role-examples-good-summary">Good examples on file</summary>
          <div id="role-examples-good-list"><p class="empty">Loading…</p></div>
        </details>
        <form id="role-example-good-form">
          <label for="role-example-good-url">Job URL</label>
          <input id="role-example-good-url" type="url" required placeholder="https://...">
          <label for="role-example-good-reason">Why is this a good fit? (optional)</label>
          <textarea id="role-example-good-reason" placeholder="e.g. This is almost exactly what I want because it combines applied AI development with customer-facing technical work."></textarea>
          <button type="submit">Add</button>
        </form>
        <p id="role-example-good-status" class="status" role="status" aria-live="polite"></p>
      </section>

      <section id="role-examples-bad-section">
        <h2>Bad examples</h2>
        <p class="hint">Jobs that represent the kind of opportunity you don't want. Same idea -- the posting is evidence, and the reason is supplementary context.</p>
        <details id="role-examples-bad-details" class="disclosure">
          <summary id="role-examples-bad-summary">Bad examples on file</summary>
          <div id="role-examples-bad-list"><p class="empty">Loading…</p></div>
        </details>
        <form id="role-example-bad-form">
          <label for="role-example-bad-url">Job URL</label>
          <input id="role-example-bad-url" type="url" required placeholder="https://...">
          <label for="role-example-bad-reason">Why is this a poor fit? (optional)</label>
          <textarea id="role-example-bad-reason" placeholder="e.g. Too much pure infrastructure work and not enough product or customer interaction."></textarea>
          <button type="submit">Add</button>
        </form>
        <p id="role-example-bad-status" class="status" role="status" aria-live="polite"></p>
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
        <h2>Priorities</h2>
        <p class="hint">What do you care about? Write it however you'd say it out loud -- saving reads what you meant and turns it into the fact columns below, so you don't have to phrase it as labels. These are the topics you want surfaced and compared at a glance for every posting, not filters (Deal Breakers is where you rule things out), and they never affect the score.</p>
        <label for="care-about">What do you care about? (optional)</label>
        <textarea id="care-about" placeholder="e.g. Salary, years of experience required, remote or in office, typical hours"></textarea>
        <div id="care-about-topics" class="row-facts"></div>
        <button id="criteria-save-button" type="button">Save</button>
        <p id="criteria-save-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>

    <div id="subpanel-analysis" class="subpanel">
      <section id="role-analysis-section">
        <h2>Roles</h2>
        <p class="hint">The distinct role families worth searching for, reasoned from your full Profile together with your Preferences, Examples, Location, Deal Breakers and Priorities. A posting only has to match one of these strongly to be worth surfacing. This is what filters which postings you see. Editing the other tabs and switching away re-runs this automatically.</p>
        <label for="role-analysis-provider">Analyze using</label>
        <select id="role-analysis-provider">
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
        </select>
        <button id="role-analysis-button" class="secondary" type="button"><span class="ai-icon" aria-hidden="true"></span>Analyze Careers</button>
        <p id="role-analysis-status" class="status" role="status" aria-live="polite"></p>
        <div id="role-analysis-view"><p class="empty">Not analyzed yet -- click Reanalyze, or add something on the Description or Examples tab and switch tabs.</p></div>
      </section>
    </div>
  </div>

  <div id="panel-profile" class="panel active">
    <div class="segmented-control" role="group" aria-label="Profile sections">
      <button class="subtab active" data-profile-subtab="docs" type="button">Docs</button>
      <button class="subtab" data-profile-subtab="notes" type="button">Notes</button>
      <button class="subtab" data-profile-subtab="summary" type="button">Create</button>
      <button class="subtab" data-profile-subtab="improve" type="button">Improve</button>
    </div>

    <div id="profile-subpanel-docs" class="subpanel active">
      <section id="material-section">
        <h2>Documents</h2>
        <p class="hint">Upload resumes, CVs, and other professional documents. Everything you upload here is read in full when your Profile is generated -- not just the newest file. PDF, Word (.doc and .docx), plain text, and Markdown are supported.</p>
        <div id="documents-list"><p class="empty">Loading…</p></div>
        <form id="document-form">
          <label for="document-file">Choose a document</label>
          <input id="document-file" type="file" accept=".pdf,.doc,.docx,.txt,.md,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" required>
          <button type="submit">Upload</button>
        </form>
        <p id="document-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>

    <div id="profile-subpanel-notes" class="subpanel">
      <section id="notes-section">
        <h2>Notes</h2>
        <p class="hint">Factual career evidence in your own words -- type it, paste it, or dictate it with your device's voice-to-text. Good things to add: what you actually did in a role, accomplishments and numbers, projects and the technologies behind them, education, awards, independent work. Anything a resume left out belongs here. This is about what you <em>have done</em>; what you <em>want next</em> goes under Careers.</p>
        <div id="notes-list"><p class="empty">Loading…</p></div>
        <form id="note-form">
          <label for="note-text">Add factual career evidence</label>
          <textarea id="note-text" required style="min-height:14rem" placeholder="e.g. At Acme I ran the migration off the legacy pipeline — 4 engineers, 9 months, cut nightly batch time from 6h to 40min. Also onboarded every new hire on the data team."></textarea>
          <button type="submit">Add</button>
        </form>
        <p id="note-status" class="status" role="status" aria-live="polite"></p>
      </section>
    </div>

    <div id="profile-subpanel-summary" class="subpanel">
      <section id="career-profile-section">
        <h2>Create</h2>
        <p class="hint">Your career evidence record, built from every document and note above. This is the factual source of truth the whole app reads from -- career analysis, job matching, and every resume. It is deliberately far more complete than any single resume would be; a resume selects from this, it never replaces it. Optimized for completeness and structure, never for length or polish.</p>
        <label for="profile-provider">Generate using</label>
        <select id="profile-provider">
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
        </select>
        <button id="profile-generate-button" type="button"><span class="ai-icon" aria-hidden="true"></span>Generate Profile</button>
        <p id="profile-generate-status" class="status" role="status" aria-live="polite"></p>
        <div id="career-profile-view"><p class="empty">Loading…</p></div>
        <details id="career-profile-raw-details" class="disclosure" style="display:none">
          <summary>Raw structured data</summary>
          <pre id="career-profile-raw" class="raw-json"></pre>
        </details>
      </section>
    </div>

    <div id="profile-subpanel-improve" class="subpanel">
      <section id="improve-section">
        <h2>Improve</h2>
        <p class="hint">A guided interview that asks about specific, high-value gaps in your Career Evidence Record -- never generic "tell me more" prompts, and never resume-writing advice. Answer any question, several, or all, in any order, then apply them to fold the answers into your profile.</p>
        <div id="improve-no-profile" class="empty" style="display:none">
          Create your profile before improving it.
          <button id="improve-go-to-create" class="secondary" type="button" style="margin-left:0.5rem">Go to Create</button>
        </div>
        <div id="improve-controls">
          <div id="improve-progress" class="summary-line" style="display:none"></div>
          <label for="improve-provider">Analyze using</label>
          <select id="improve-provider">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
          <button id="improve-action-button" type="button"><span class="ai-icon" aria-hidden="true"></span>Find Improvements</button>
          <p id="improve-status" class="status" role="status" aria-live="polite"></p>
        </div>
        <div id="improve-questions"></div>
      </section>
    </div>
  </div>

  <div id="panel-resume" class="panel">
    <section id="resume-generate-section">
      <h2>Resumes</h2>
      <p class="hint">A resume selects and rewrites evidence from your Profile for one target. It never adds anything your Profile doesn't already support. Build one baseline per career path, then tailor per job from the Jobs tab.</p>
      <div id="resume-no-profile" class="empty" style="display:none">Generate your Profile first — resumes are built from it.</div>

      <div id="resume-build-controls">
        <label for="resume-role-family">Career path</label>
        <select id="resume-role-family"></select>
        <label for="resume-template">Template</label>
        <div id="resume-template-choices" class="template-choices"></div>
        <label for="resume-instructions">Instructions for this version (optional)</label>
        <textarea id="resume-instructions" placeholder="e.g. keep it to one page, emphasize leadership, target a backend-heavy role"></textarea>
        <label for="resume-pages">Length</label>
        <select id="resume-pages">
          <option value="1">One page</option>
          <option value="2">Up to two pages</option>
        </select>
        <label for="resume-provider">Build using</label>
        <select id="resume-provider">
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
        </select>
        <button id="resume-generate-button" type="button"><span class="ai-icon" aria-hidden="true"></span>Generate resume</button>
        <p id="resume-generate-status" class="status" role="status" aria-live="polite"></p>
      </div>
    </section>

    <section id="resume-career-list-section">
      <h2>Career resumes</h2>
      <p class="hint">One baseline per career path from your Roles tab. Same evidence, different emphasis.</p>
      <div id="resumes-career-list"><p class="empty">Loading…</p></div>
    </section>

    <section id="resume-job-list-section">
      <h2>Job-specific resumes</h2>
      <p class="hint">Tailored to one posting. Created from a job on the Jobs tab.</p>
      <div id="resumes-job-list"><p class="empty">Loading…</p></div>
    </section>

    <section id="resume-preview-section" style="display:none">
      <h2>Preview</h2>
      <iframe id="resume-preview-frame" style="width:100%; min-height:70vh; border:1px solid var(--border); border-radius:0.5rem;"></iframe>

      <div id="resume-checks"></div>

      <h3>Design review</h3>
      <p class="hint">A vision model looks at the rendered page the way a designer would, then adjusts the layout — and rewrites the wording from your verified profile if that's the real problem. Add a comment to steer it, or leave it blank and just hit revise.</p>
      <p id="resume-critique" class="critique" style="display:none"></p>
      <textarea id="resume-review-comment" placeholder="Optional — e.g. too much white space at the bottom, make the skills section smaller"></textarea>
      <button id="resume-review-button" type="button"><span class="ai-icon" aria-hidden="true"></span>Revise this version</button>
      <p id="resume-review-status" class="status" role="status" aria-live="polite"></p>
    </section>
  </div>

  <div id="panel-companies" class="panel">
    <div class="segmented-control" id="companies-view-tabs" role="group" aria-label="Company sections">
      <button class="active" data-companies-view="find" type="button" aria-pressed="true">Search</button>
      <button data-companies-view="verified" type="button" aria-pressed="false">Verified <span id="companies-verified-count"></span></button>
      <button data-companies-view="unverified" type="button" aria-pressed="false">Unverified <span id="companies-unverified-count"></span></button>
      <button data-companies-view="removed" type="button" aria-pressed="false">Removed <span id="companies-removed-count"></span></button>
    </div>

    <section id="companies-find-panel">
      <h2>Find companies</h2>
      <p class="hint">Find companies hiring for your target roles. No AI judges whether a company "sounds relevant" — only whether it's a real, monitorable employer; fit is judged per-job in Jobs.</p>

      <h3 id="companies-search-terms-heading">Search terms</h3>
      <p class="hint">What ApplyGo actually searches for. Generated from your Role Analysis — edit freely.</p>
      <div id="companies-search-terms-list" class="chip-list" role="group" aria-labelledby="companies-search-terms-heading"></div>
      <div class="controls">
        <label for="companies-search-term-input" class="sr-only">Add a search term</label>
        <input id="companies-search-term-input" placeholder="Add a term…" maxlength="80">
        <button id="companies-search-term-add" type="button">+ Add term</button>
        <button id="companies-search-terms-reset" type="button" class="secondary">Reset to suggested</button>
      </div>
      <p id="companies-search-terms-status" class="status" role="status" aria-live="polite"></p>

      <label for="company-focus">Search focus (optional)</label>
      <input id="company-focus" placeholder="e.g. automotive, robotics, Bay Area startups">

      <p id="companies-pipeline-summary" class="sr-only" aria-live="polite"></p>
      <div id="companies-pipeline-row">
        <div id="companies-pipeline" aria-hidden="true">
          <svg id="cpf-svg" preserveAspectRatio="xMidYMid meet"></svg>
        </div>
        <div class="cpf-arrow" aria-hidden="true">→</div>
        <!-- Visually joined to the diagram (same row, same connector styling as the ribbons feeding
             it) but deliberately not one more Sankey stage: the diagram to its left counts
             companies throughout; this counts jobs. One verified company can produce many postings,
             or none, so drawing this as a conserved-flow ribbon would visually claim a
             company-to-job relationship that doesn't exist. See src/companies.ts's header comment
             for why company-level and job-level judgments are kept this separate everywhere. -->
        <div class="cpf-stage-handoff">
          <h3>Pre-screen</h3>
          <div class="cpf-stat-primary"><span id="cpfStatPrescreen">0</span> jobs</div>
          <div class="cpf-stat-sub">in Jobs → Pre-screen</div>
        </div>
      </div>
      <div class="pf-legend">
        <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--accent)"></span>Discovered</span>
        <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--error)"></span>Unverified</span>
        <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--success)"></span>Verified</span>
      </div>

      <button id="companies-discover-button" type="button">Find companies</button>
      <p id="companies-discover-status" class="status" role="status" aria-live="polite"></p>

      <details class="disclosure">
        <summary>Add companies manually</summary>
        <form id="company-form">
          <label for="company-name">Name</label>
          <input id="company-name" required placeholder="e.g. Acme Robotics">
          <label for="company-website">Website</label>
          <input id="company-website" type="url" placeholder="https://acme.com">
          <button type="submit">Add company</button>
        </form>
        <p id="company-add-status" class="status" role="status" aria-live="polite"></p>

        <label for="company-bulk-text">Add a list</label>
        <textarea id="company-bulk-text" rows="6" placeholder="Acme Robotics, Another Company, https://another.example"></textarea>
        <button id="company-bulk-button" type="button">Add up to 50</button>
        <p id="company-bulk-status" class="status" role="status" aria-live="polite"></p>
      </details>
    </section>

    <section id="companies-list-section" style="display:none">
          <label for="companies-filter">Filter</label>
          <input id="companies-filter" placeholder="Search by name, location, or description">
          <div class="segmented-control" id="companies-unverified-filters" role="group" aria-label="Unverified reason" style="display:none">
            <button class="active" data-unverified-reason="" type="button" aria-pressed="true">All <span id="companies-reason-all-count"></span></button>
            <button data-unverified-reason="no_website" type="button" aria-pressed="false">No website <span id="companies-reason-no_website-count"></span></button>
            <button data-unverified-reason="no_job_board" type="button" aria-pressed="false">No job board <span id="companies-reason-no_job_board-count"></span></button>
            <button data-unverified-reason="unsupported_ats" type="button" aria-pressed="false">Unsupported board <span id="companies-reason-unsupported_ats-count"></span></button>
            <button data-unverified-reason="board_unreachable" type="button" aria-pressed="false">Board unreachable <span id="companies-reason-board_unreachable-count"></span></button>
            <button data-unverified-reason="ambiguous" type="button" aria-pressed="false">Ambiguous <span id="companies-reason-ambiguous-count"></span></button>
          </div>
          <div id="companies-list"><p class="empty">Loading…</p></div>
    </section>
  </div>

  <div id="panel-jobs" class="panel">
    <div class="segmented-control" id="jobs-view-tabs" role="group" aria-label="Job sections">
      <button class="active" data-jobs-view="search" type="button" aria-pressed="true">Search</button>
      <button data-jobs-view="good_match" type="button" aria-pressed="false">Good Fit <span id="jobs-good_match-count"></span></button>
      <button data-jobs-view="bad_match" type="button" aria-pressed="false">Bad Fit <span id="jobs-bad_match-count"></span></button>
      <button data-jobs-view="removed" type="button" aria-pressed="false">Removed <span id="jobs-removed-count"></span></button>
      <button data-jobs-view="fit_fail" type="button" aria-pressed="false">Fit Fail <span id="jobs-fit_fail-count"></span></button>
      <button data-jobs-view="interested" type="button" aria-pressed="false">Interested <span id="jobs-interested-count"></span></button>
      <button data-jobs-view="applied" type="button" aria-pressed="false">Applied <span id="jobs-applied-count"></span></button>
    </div>

    <section id="jobs-find-section">
      <h2>Find jobs</h2>
      <p class="hint">Reads every company's job board, then screens and scores whatever's new against your profile — start to finish in one click. Boards are cheap to read, so every company is re-read on every click regardless of when it was last scanned.</p>
      <p id="jobs-pipeline-summary" class="sr-only" aria-live="polite"></p>
      <div id="jobs-pipeline" aria-hidden="true">
        <svg id="pf-svg" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="pf-legend">
          <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--accent)"></span>Processing</span>
          <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--warning)"></span>Pass / waiting</span>
          <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--error)"></span>Fail / Bad Fit</span>
          <span class="pf-legend-item"><span class="pf-swatch" style="background:var(--success)"></span>Good Fit</span>
        </div>
        <div class="pf-progress-track"><div class="pf-progress-fill" id="pfProgressFill"></div></div>
        <div class="pf-stat-row">
          <span>Scanned: <b id="pfStatScanned">0</b></span>
          <span>Good Fit: <b id="pfStatRecommended">0</b></span>
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
        <button id="jobs-find-button" type="button">Find Jobs</button>
      </div>
      <p id="jobs-find-status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section id="jobs-section" style="display:none">
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
        <div>
          <label for="jobs-match-threshold">Fit Threshold ≥</label>
          <input id="jobs-match-threshold" type="number" min="0" max="100" step="1" value="70">
        </div>
      </div>
      <p id="jobs-match-threshold-status" class="status" role="status" aria-live="polite"></p>

      <div id="jobs-list"><p class="empty">Loading…</p></div>

      <!-- Interested subtab: cards expand the shared job tools inline; nothing renders in a
           separate selected-job area below the list. -->
      <div id="jobs-interested-section" style="display:none">
        <section id="interested-list-section">
          <p class="hint">Jobs you've marked "Interested". Click anywhere on a card except its posting link or buttons to expand Ask, Resume, Cover Letter, and Apply tools inline.</p>
          <div id="interested-list"><p class="empty">Loading…</p></div>
        </section>

        <!-- The existing job tools are a single reusable panel. JavaScript moves it into the
             expanded card, then parks it here invisibly when the accordion is closed. -->
        <div id="interested-detail-home" style="display:none">
        <section id="interested-detail-section" style="display:none">

          <!-- Assistant/Resume/Cover letter/Apply are sub-tabs, not stacked sections -- only one shows
               at a time, the same way the top-level dashboard tabs work, so opening one doesn't leave
               the others piled up underneath with no way to get back to just looking at one thing. -->
          <div class="subtabs">
            <button id="interested-subtab-assistant" type="button">Ask</button>
            <button id="interested-subtab-resume" class="secondary" type="button">Resume</button>
            <button id="interested-subtab-cover" class="secondary" type="button">Cover Letter</button>
            <button id="interested-subtab-apply" class="secondary" type="button">Apply</button>
          </div>

          <div id="interested-assistant-panel">
            <p id="interested-review-status" class="status" role="status" aria-live="polite"></p>
            <button id="interested-review-button" type="button"><span class="ai-icon" aria-hidden="true"></span>Ask a question</button>
            <div id="interested-review-section" style="display:none">
              <p id="interested-review-question" class="job-reason"></p>
              <textarea id="interested-review-answer" placeholder="Answer in your own words — this gets added to your profile evidence for this job."></textarea>
              <button id="interested-review-submit" type="button">Submit answer</button>
            </div>
            <div id="interested-review-history"></div>
          </div>

          <div id="interested-resume-panel" style="display:none">
            <p id="interested-resume-status" class="status" role="status" aria-live="polite"></p>
            <button id="interested-resume-button" type="button"><span class="ai-icon" aria-hidden="true"></span>Generate tailored resume</button>
            <div id="interested-resume-section" style="display:none">
              <p class="hint">On some phones the preview below can't scroll or show a page break — if that happens, use the link to open the actual PDF instead.</p>
              <a id="interested-resume-open-link" class="row-title" target="_blank" rel="noopener">Open full PDF in a new tab</a>
              <iframe id="interested-resume-frame" style="width:100%; min-height:70vh; border:1px solid var(--border); border-radius:0.5rem;"></iframe>
              <div id="interested-resume-coverage" style="display:none"></div>
              <div id="interested-resume-checks"></div>
              <p id="interested-resume-critique" class="critique" style="display:none"></p>
              <textarea id="interested-resume-comment" placeholder="Optional — steer the revision, e.g. tighten the second bullet, or point out what still doesn't fit"></textarea>
              <button id="interested-resume-revise" class="secondary" type="button"><span class="ai-icon" aria-hidden="true"></span>Revise this version</button>
            </div>
          </div>

          <div id="interested-cover-panel" style="display:none">
            <p id="interested-cover-status" class="status" role="status" aria-live="polite"></p>
            <button id="interested-cover-button" type="button"><span class="ai-icon" aria-hidden="true"></span>Draft cover letter</button>
            <div id="interested-cover-section" style="display:none">
              <iframe id="interested-cover-frame" style="width:100%; min-height:60vh; border:1px solid var(--border); border-radius:0.5rem;"></iframe>
              <button id="interested-cover-regenerate" class="secondary" type="button"><span class="ai-icon" aria-hidden="true"></span>Regenerate for this job</button>
            </div>
          </div>

          <div id="interested-apply-panel" style="display:none">
            <p class="hint">What's ready for this application. Press <strong>Apply</strong> on the card above to open the employer's page — with the ApplyGo extension installed, the in-page assistant picks it up from there and fills what it can. Mark it applied here once you've submitted.</p>
            <div id="interested-apply-readiness"></div>
            <p id="interested-apply-status" class="status" role="status" aria-live="polite"></p>
            <button id="interested-apply-mark" type="button">Mark as applied</button>
          </div>
        </section>
        </div>
      </div>

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

    <section id="applied-section" style="display:none">
      <h2>Applied</h2>
      <p class="hint">Jobs you've applied to, most recent first. Everything generated for each one stays available.</p>
      <p id="applied-summary" class="summary-line"></p>
      <div class="controls">
        <button id="gmail-check-replies-button" type="button" style="display:none">Check for replies</button>
      </div>
      <p id="gmail-not-connected-hint" class="hint" style="display:none">Connect Gmail in Settings &rarr; Email to check for replies here.</p>
      <p id="gmail-check-status" class="status" role="status" aria-live="polite"></p>
      <div id="applied-list"><p class="empty">Loading…</p></div>
    </section>
  </div>

  <div id="panel-settings" class="panel">
    <div class="segmented-control" role="group" aria-label="Settings sections">
      <button class="active" data-settings-subtab="devices" type="button" aria-pressed="true">Devices</button>
      <button data-settings-subtab="email" type="button" aria-pressed="false">Email</button>
      <button data-settings-subtab="data" type="button" aria-pressed="false">Data</button>
    </div>

    <div id="settings-subpanel-devices" class="subpanel active">
      <section id="devices-section">
        <h2>Devices</h2>
        <div id="devices-list"><p class="empty">Loading…</p></div>
      </section>
    </div>

    <div id="settings-subpanel-email" class="subpanel">
      <section id="gmail-section">
        <h2>Email</h2>
        <p class="hint">Connect Gmail to let ApplyGo check your inbox for replies related to jobs you've applied to.</p>
        <p class="hint"><strong>ApplyGo only requests read-only Gmail access. It cannot send, edit, or delete your email.</strong></p>

        <div id="gmail-status-card"><p class="empty">Loading…</p></div>
        <p id="gmail-flow-message" class="status" role="status" aria-live="polite"></p>
        <details id="gmail-error-details" style="display:none">
          <summary>Technical details</summary>
          <p id="gmail-error-technical" class="job-reason"></p>
        </details>

        <details id="gmail-setup-details">
          <summary id="gmail-setup-summary">Set up Gmail</summary>
          <p class="hint">Google requires you to create your own OAuth credentials so ApplyGo can ask permission to read your Gmail. This usually only needs to be done once for this ApplyGo installation.</p>

          <div class="row-item">
            <div class="row">
              <div>
                <div class="row-title">Authorized redirect URI</div>
                <div class="row-meta" id="gmail-redirect-uri">Loading…</div>
              </div>
              <button id="gmail-copy-redirect" class="secondary" type="button">Copy</button>
            </div>
          </div>
          <p class="hint">Copy this exact URL into Google's "Authorized redirect URIs" field -- see step 9 below.</p>

          <details>
            <summary>How do I get these?</summary>
            <ol class="gmail-steps">
              <li>Open <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a>.</li>
              <li>Create a new Google Cloud project, or select an existing one dedicated to ApplyGo.</li>
              <li>Using the search bar at the top, find and enable the <strong>Gmail API</strong>.</li>
              <li>Open <strong>APIs &amp; Services &rarr; OAuth consent screen</strong>.</li>
              <li>Choose <strong>External</strong> as the audience, and fill in the required app name and your email address.</li>
              <li>Under <strong>Audience &rarr; Test users</strong>, add your own Google account -- required while the app is in Testing status.</li>
              <li>Under <strong>Data access</strong>, add the scope ApplyGo needs: <code>https://www.googleapis.com/auth/gmail.readonly</code>.</li>
              <li>Go to <strong>APIs &amp; Services &rarr; Credentials &rarr; Create Credentials &rarr; OAuth client ID</strong>, and choose <strong>Web application</strong> as the type.</li>
              <li>Under <strong>Authorized redirect URIs</strong>, click Add URI and paste the exact address shown above.</li>
              <li>Click Create. Google will show a <strong>Client ID</strong> and <strong>Client Secret</strong> -- copy both.</li>
              <li>Paste them into the fields below and click <strong>Save credentials</strong>.</li>
              <li>Come back here and click <strong>Connect Gmail</strong>.</li>
            </ol>
          </details>

          <form id="gmail-credentials-form">
            <label for="gmail-client-id">Google Client ID</label>
            <input id="gmail-client-id" type="text" placeholder="1234567890-abc123.apps.googleusercontent.com" autocomplete="off">
            <label for="gmail-client-secret">Google Client Secret</label>
            <div class="controls">
              <div style="flex:1">
                <input id="gmail-client-secret" type="password" placeholder="GOCSPX-…" autocomplete="off" style="width:100%">
              </div>
              <button id="gmail-toggle-secret" class="secondary" type="button">Show</button>
            </div>
            <button type="submit">Save credentials</button>
          </form>
          <p id="gmail-credentials-status" class="status" role="status" aria-live="polite"></p>
        </details>

        <div id="gmail-connect-section" style="display:none">
          <div class="row-item">
            <div class="row-title">What ApplyGo can do</div>
            <p class="row-meta">✓ Search your Gmail inbox<br>✓ Read message metadata/content necessary to identify potential application replies</p>
          </div>
          <div class="row-item">
            <div class="row-title">What ApplyGo cannot do</div>
            <p class="row-meta">✕ Send email<br>✕ Reply to email<br>✕ Edit messages<br>✕ Delete messages</p>
          </div>
          <p class="hint"><strong>Using Google's Testing mode?</strong> Google may require you to reconnect Gmail periodically -- typically after seven days. If that happens, ApplyGo will show "Reconnect Gmail." Your ApplyGo data is unaffected.</p>
          <button id="gmail-connect-button" type="button">Connect Gmail</button>
        </div>
      </section>
    </div>

    <div id="settings-subpanel-data" class="subpanel">
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
  </div>

  <script>
    document.querySelectorAll('nav .tab').forEach(function (tabButton) {
      tabButton.addEventListener('click', function () {
        // Leaving Careers with unsaved edits (or having never analyzed at all) is exactly when a
        // stale/missing analysis would otherwise silently sit there -- see maybeReanalyzeRoles.
        var leavingRolesDirty = tabButton.dataset.tab !== 'careers'
          && document.getElementById('panel-careers').classList.contains('active');
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

    document.querySelectorAll('[data-profile-subtab]').forEach(function (subtabButton) {
      subtabButton.addEventListener('click', function () {
        document.querySelectorAll('[data-profile-subtab]').forEach(function (button) { button.classList.remove('active'); });
        document.querySelectorAll('#panel-profile > .subpanel').forEach(function (panel) { panel.classList.remove('active'); });
        subtabButton.classList.add('active');
        document.getElementById('profile-subpanel-' + subtabButton.dataset.profileSubtab).classList.add('active');
      });
    });

    document.querySelectorAll('[data-settings-subtab]').forEach(function (subtabButton) {
      subtabButton.addEventListener('click', function () {
        document.querySelectorAll('[data-settings-subtab]').forEach(function (button) {
          button.classList.remove('active');
          button.setAttribute('aria-pressed', 'false');
        });
        document.querySelectorAll('#panel-settings > .subpanel').forEach(function (panel) {
          panel.classList.remove('active');
        });
        subtabButton.classList.add('active');
        subtabButton.setAttribute('aria-pressed', 'true');
        document.getElementById('settings-subpanel-' + subtabButton.dataset.settingsSubtab).classList.add('active');
      });
    });

    // Mobile replacement for a .segmented-control row of secondary tabs: pagination dots plus
    // the current subsection's name, with the actual navigating done by a horizontal swipe
    // anywhere in the page content. Desktop keeps the segmented control as-is (see the
    // .has-mobile-subnav media query above) -- this only changes how the same buttons are
    // reached on a screen too narrow to show every label at once.
    //
    // Deliberately built on top of the existing per-section click handlers rather than
    // duplicating their logic: each subtab button already knows how to activate itself (toggle
    // a subpanel, refetch a list, whatever), so swiping just clicks the next/previous button and
    // lets that handler do its normal job. That also means the dots/label stay correct even when
    // something other than a swipe changes the active button (a plain click, or code elsewhere
    // calling .click()).
    var mobileSwipeTargets = {};

    // Pulls a button's own label text, ignoring nested elements like a live count badge
    // ("Added <span id=...>3</span>") so the mobile label reads "Added", not "Added 3".
    function subtabLabelText(button) {
      var label = '';
      button.childNodes.forEach(function (node) {
        if (node.nodeType === Node.TEXT_NODE) label += node.textContent;
      });
      label = label.trim();
      return label || button.textContent.trim();
    }

    function initMobileSubnav(container) {
      if (!container) return null;
      var buttons = Array.prototype.slice.call(container.children).filter(function (node) {
        return node.tagName === 'BUTTON';
      });
      if (buttons.length < 2) return null;

      container.classList.add('has-mobile-subnav');
      var nav = el('div', { className: 'mobile-subnav' });
      var dots = el('div', { className: 'mobile-subnav-dots' });
      dots.setAttribute('role', 'tablist');
      dots.setAttribute('aria-hidden', 'true');
      var label = el('div', { className: 'mobile-subnav-label' });
      label.setAttribute('aria-live', 'polite');
      buttons.forEach(function () { dots.appendChild(el('span', { className: 'mobile-subnav-dot' })); });
      nav.appendChild(dots);
      nav.appendChild(label);
      container.parentNode.insertBefore(nav, container);

      function activeIndex() {
        var idx = buttons.findIndex(function (b) { return b.classList.contains('active'); });
        return idx === -1 ? 0 : idx;
      }
      function sync() {
        var idx = activeIndex();
        Array.prototype.forEach.call(dots.children, function (dot, i) { dot.classList.toggle('active', i === idx); });
        label.textContent = subtabLabelText(buttons[idx]);
      }
      // Deferred rather than run inline: this listener is wired up before the section's own
      // click handler that actually moves the .active class (e.g. the Companies/Jobs view
      // handlers are registered much further down the script), so reading the active button
      // synchronously here would always be one click stale. A zero-delay timeout runs after
      // every click listener attached in the same tick has finished, including ones added later
      // in the file, so the dots/label end up correct regardless of listener order.
      buttons.forEach(function (button) { button.addEventListener('click', function () { setTimeout(sync, 0); }); });
      sync();

      return {
        next: function () { var idx = activeIndex(); if (idx < buttons.length - 1) buttons[idx + 1].click(); },
        prev: function () { var idx = activeIndex(); if (idx > 0) buttons[idx - 1].click(); },
      };
    }

    [
      ['panel-profile', document.querySelector('#panel-profile .segmented-control')],
      ['panel-careers', document.querySelector('#panel-careers .segmented-control')],
      ['panel-companies', document.getElementById('companies-view-tabs')],
      ['panel-jobs', document.getElementById('jobs-view-tabs')],
      ['panel-settings', document.querySelector('#panel-settings .segmented-control')],
    ].forEach(function (entry) {
      var controller = initMobileSubnav(entry[1]);
      if (controller) mobileSwipeTargets[entry[0]] = controller;
    });

    // A touch is treated as a page-swipe candidate only when it starts outside any element that
    // is already horizontally scrollable on its own (the primary nav, a .subtabs row, etc) --
    // checked dynamically by scroll width rather than a hardcoded selector list, so it keeps
    // working if more such rows are added later. Direction is locked in on the first move past a
    // small deadzone by comparing |dx| to |dy|, so an intentional vertical scroll never gets
    // reinterpreted as a swipe partway through.
    (function () {
      function isInsideHorizontalScroller(node) {
        while (node && node !== document.body) {
          if (node.scrollWidth > node.clientWidth + 1) {
            var overflowX = getComputedStyle(node).overflowX;
            if (overflowX === 'auto' || overflowX === 'scroll') return true;
          }
          node = node.parentElement;
        }
        return false;
      }

      var startX = 0, startY = 0, tracking = false, horizontal = null, controller = null;
      var SWIPE_THRESHOLD = 50;
      var DIRECTION_DEADZONE = 10;
      var HORIZONTAL_RATIO = 1.5;

      document.addEventListener('touchstart', function (e) {
        tracking = false;
        if (e.touches.length !== 1) return;
        if (e.target.closest && (e.target.closest('input, textarea, select') || isInsideHorizontalScroller(e.target))) return;
        var panel = document.querySelector('.panel.active');
        controller = panel && mobileSwipeTargets[panel.id];
        if (!controller) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        horizontal = null;
        tracking = true;
      }, { passive: true });

      document.addEventListener('touchmove', function (e) {
        if (!tracking || horizontal !== null) return;
        var dx = e.touches[0].clientX - startX;
        var dy = e.touches[0].clientY - startY;
        if (Math.abs(dx) > DIRECTION_DEADZONE || Math.abs(dy) > DIRECTION_DEADZONE) {
          horizontal = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_RATIO;
        }
      }, { passive: true });

      document.addEventListener('touchend', function (e) {
        if (!tracking) return;
        tracking = false;
        if (!horizontal || !controller) return;
        var dx = e.changedTouches[0].clientX - startX;
        if (Math.abs(dx) < SWIPE_THRESHOLD) return;
        if (dx < 0) controller.next(); else controller.prev();
      }, { passive: true });
    })();

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

    // Shared by every Jobs tab row -- label above value so a long value (a full
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

    // A non-JSON error body is either a genuine network-level failure or one specific, recognizable
    // Cloudflare platform failure: the isolate handling the request got evicted and restarted before
    // it could respond (a redeploy racing the request, an OOM, etc). That one is common enough to be
    // worth naming plainly instead of dumping Cloudflare's own raw error page at the candidate, whose
    // wording ("Only GET or HEAD requests are retried automatically") is instructing a human to just
    // press the button again -- so say that instead. Anything else falls through to the raw text
    // unchanged, so a genuinely new failure mode is never silently hidden behind a made-up message.
    function platformFailureMessage(body) {
      if (/worker restarted mid-request/i.test(body)) {
        return 'The server was restarted while handling your request. Please try again.';
      }
      return body.replace(/\s+/g, ' ').trim().slice(0, 500);
    }

    // A failed request should always end up with a readable message, even if the response body
    // isn't valid JSON (a raw platform error page, a network-level failure) -- res.json() throwing
    // there would otherwise surface as an opaque parse error instead of anything actionable.
    async function errorMessageFromResponse(res, fallback) {
      var body = '';
      try { body = await res.text(); } catch (e) { body = ''; }
      if (body) {
        try { return errorMessage(JSON.parse(body), fallback + ' (HTTP ' + res.status + ')'); }
        catch (e) { return platformFailureMessage(body); }
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
          throw new Error(platformFailureMessage(body) || fallback + ' (HTTP ' + res.status + ')');
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
    // Jobs cards use -- so the columns you'll see there are visible before any scan runs.
    function renderCareAboutTopics(topics) {
      var host = document.getElementById('care-about-topics');
      host.innerHTML = '';
      (topics || []).forEach(function (topic) {
        var chip = factChip({ label: topic.label, value: topic.looking_for || '' });
        if (chip) host.appendChild(chip);
      });
    }

    // --- Roles page: sub-tabs, the three raw preference inputs, and the derived analysis ---

    document.querySelectorAll('#panel-careers [data-subtab]').forEach(function (subtabButton) {
      subtabButton.addEventListener('click', function () {
        document.querySelectorAll('#panel-careers [data-subtab]').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('#panel-careers .subpanel').forEach(function (p) { p.classList.remove('active'); });
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

    /** Market research keyed by role title, filled in asynchronously after the cards render. */
    var roleMarketData = {};

    function renderMarketSection(role, host) {
      var market = roleMarketData[role.title];
      var section = el('div', { className: 'role-market' });
      section.appendChild(el('div', { className: 'profile-field-label', textContent: 'Market context' }));

      if (!market) {
        section.appendChild(el('div', { className: 'row-meta', textContent: 'Looking up market data…' }));
        host.appendChild(section);
        return;
      }
      // The honest empty state. Never replaced by a model's recollection of salary figures --
      // see src/market.ts for why that distinction is load-bearing.
      if (market.unavailable) {
        section.appendChild(el('div', { className: 'row-meta', textContent: 'Market data not yet available for this role.' }));
        host.appendChild(section);
        return;
      }

      var direction = market.demand_direction || 'unclear';
      section.appendChild(el('span', { className: 'badge ' + (direction === 'growing' ? 'strong' : 'queued'), textContent: 'Demand: ' + direction }));
      if (market.outlook_summary) section.appendChild(el('p', { className: 'row-meta', textContent: market.outlook_summary }));
      if (market.typical_salary_range) {
        section.appendChild(el('div', { className: 'row-meta', textContent: 'Typical range: ' + market.typical_salary_range }));
      }
      if (market.salary_for_experience_level) {
        section.appendChild(el('div', { className: 'row-meta', textContent: 'At your level: ' + market.salary_for_experience_level }));
      }
      if (market.geographic_notes) {
        section.appendChild(el('div', { className: 'row-meta', textContent: 'Your locations: ' + market.geographic_notes }));
      }
      (market.caveats || []).forEach(function (caveat) {
        section.appendChild(el('div', { className: 'row-meta', textContent: '⚠ ' + caveat }));
      });
      if (market.sources && market.sources.length) {
        var sources = el('div', { className: 'row-meta' });
        sources.appendChild(text('Sources: '));
        market.sources.forEach(function (source, index) {
          if (index) sources.appendChild(text(' · '));
          sources.appendChild(el('a', { href: source.url, target: '_blank', rel: 'noopener', textContent: source.name }));
        });
        section.appendChild(sources);
      }
      host.appendChild(section);
    }

    /**
     * Role families as compact expandable cards.
     *
     * Collapsed shows only title plus a one-line fit summary, because a candidate may end up with
     * 5-10 of these and the list has to stay scannable enough to compare them at a glance. Every
     * detail the analysis produced -- including the evidence behind each fit claim, which is what
     * makes a surprising recommendation believable rather than arbitrary -- lives one tap away.
     */
    function renderRoleAnalysis(analysis) {
      currentRoleAnalysis = analysis && analysis.roles && analysis.roles.length ? analysis : null;
      var host = document.getElementById('role-analysis-view');
      host.innerHTML = '';
      if (!currentRoleAnalysis) {
        host.appendChild(el('p', {
          className: 'empty',
          textContent: 'No careers analyzed yet — press Analyze Careers, or add something under Preferences or Examples and switch tabs.',
        }));
        return;
      }
      if (currentRoleAnalysis.summary) host.appendChild(el('p', { textContent: currentRoleAnalysis.summary }));

      var list = el('div', { className: 'role-analysis-roles' });
      currentRoleAnalysis.roles.forEach(function (role) {
        var card = el('details', { className: 'role-analysis-role' });
        var summary = el('summary', {}, [
          el('span', { className: 'role-card-title', textContent: role.title }),
          el('span', { className: 'role-card-fit', textContent: role.fit_summary || '' }),
        ]);
        card.appendChild(summary);

        var body = el('div', { className: 'role-card-body' });
        if (role.alternate_titles && role.alternate_titles.length) {
          body.appendChild(el('div', { className: 'profile-field-label', textContent: 'Also posted as' }));
          body.appendChild(el('div', { className: 'row-meta', textContent: role.alternate_titles.join(' · ') }));
        }
        var meta = [role.seniority, (role.domains || []).join(', ')].filter(Boolean).join(' · ');
        if (meta) body.appendChild(el('div', { className: 'row-meta', textContent: meta }));

        if (role.why_this_fits && role.why_this_fits.length) {
          body.appendChild(el('div', { className: 'profile-field-label', textContent: 'Why this fits you' }));
          role.why_this_fits.forEach(function (item) {
            var block = el('div', { className: 'profile-subcard' });
            block.appendChild(el('div', { className: 'profile-subcard-title', textContent: item.claim }));
            (item.evidence || []).forEach(function (evidence) {
              block.appendChild(el('div', { className: 'row-meta', textContent: '• ' + evidence }));
            });
            body.appendChild(block);
          });
        }

        profileBullets('Must have', role.must_have_characteristics, body);
        profileBullets('Nice to have', role.nice_to_have_characteristics, body);
        profileBullets('Gaps and cautions', role.possible_gaps_or_cautions, body);

        var searchTerms = (role.search_title_terms || []).concat(role.search_keywords || []);
        if (searchTerms.length) {
          body.appendChild(el('div', { className: 'profile-field-label', textContent: 'Search terms' }));
          var pills = el('div', { className: 'skills-list' });
          searchTerms.forEach(function (term) {
            pills.appendChild(el('span', { className: 'skill-pill', textContent: term }));
          });
          body.appendChild(pills);
        }

        renderMarketSection(role, body);
        card.appendChild(body);
        list.appendChild(card);
      });
      host.appendChild(list);
    }

    /**
     * Fetches market context after the cards are already on screen.
     *
     * Deliberately not awaited by the analysis flow: research hits external providers that can be
     * slow or unreachable, and the candidate-facing half of this page must never wait on them.
     */
    async function loadRoleMarketData() {
      if (!currentRoleAnalysis) return;
      try {
        var res = await api('/role-market?provider=' + encodeURIComponent(document.getElementById('role-analysis-provider').value));
        var data = await res.json();
        if (!res.ok) return;
        roleMarketData = data.research || {};
        renderRoleAnalysis(currentRoleAnalysis);
      } catch (err) {
        // Leaving the "looking up" line in place is a better failure than an error banner on a
        // section that is supplementary to the actual recommendation.
      }
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
        renderResumeRoleChoices(data.role_analysis);
        loadRoleMarketData();
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
        renderResumeRoleChoices(data.profile.role_analysis);
        renderStructuredProfileView('career-profile-view', data.profile.structured);
        if (data.profile.role_analysis) loadRoleMarketData();
        setProfileButtonMode(Boolean(data.profile.structured));
        // Resumes are built from the profile, so the build controls are meaningless without one.
        var hasProfile = Boolean(data.profile.structured);
        document.getElementById('resume-no-profile').style.display = hasProfile ? 'none' : '';
        document.getElementById('resume-build-controls').style.display = hasProfile ? '' : 'none';
        setImproveProfileAvailability(hasProfile);
        if (hasProfile) loadImproveQuestions();
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

    /**
     * Renders the resume list as two card groups: career baselines (one per role family) and
     * job-specific tailored versions. Split rather than one flat list because the two answer
     * different questions -- "which career am I presenting for?" versus "which application is this
     * for?" -- and a single list mixed them into something you had to read the name to decode.
     */
    async function loadResumes() {
      var res = await api('/resumes');
      var data = await res.json();
      if (data.templates) renderTemplateChoices(data.templates);

      // Master resumes are retired as a concept but old rows are deliberately not deleted, so they
      // are filtered out of the UI rather than migrated or destroyed.
      var all = (data.resumes || []).filter(function (resume) { return !resume.is_master; });
      var career = all.filter(function (resume) { return !resume.job_id; });
      var jobSpecific = all.filter(function (resume) { return Boolean(resume.job_id); });

      renderResumeCards('resumes-career-list', career, 'No career resumes yet — pick a career path above and generate one.');
      renderResumeCards('resumes-job-list', jobSpecific, 'No job-specific resumes yet — open a job on the Jobs tab to tailor one.');
    }

    function renderResumeCards(listId, resumes, emptyText) {
      var list = document.getElementById(listId);
      if (!list) return;
      list.innerHTML = '';
      if (!resumes.length) {
        list.appendChild(el('p', { className: 'empty', textContent: emptyText }));
        return;
      }
      resumes.forEach(function (resume) {
        var title = el('a', {
          className: 'row-title',
          href: '/resumes/' + encodeURIComponent(resume.id) + '/file',
          target: '_blank',
          rel: 'noopener',
          textContent: resume.role_family || resume.name,
        });
        var subtitleText = resume.role_family
          ? 'Base resume for this career path'
          : (resume.job_title
              ? 'Tailored for ' + resume.job_title + (resume.job_company ? ' at ' + resume.job_company : '')
              : resume.name);
        var meta = [
          resume.template || 'classic',
          'rev ' + (resume.revision || 1),
          'updated ' + new Date(resume.created_at).toLocaleDateString(),
        ].join(' · ');

        var open = el('button', { type: 'button', textContent: 'Open' });
        open.addEventListener('click', function () {
          var checks = [];
          try { checks = JSON.parse(resume.checks_json || '[]'); } catch (e) { checks = []; }
          showResumePreview(resume.id, checks, resume.critique);
        });
        var regenerate = el('button', { className: 'secondary', type: 'button', textContent: 'Regenerate' });
        regenerate.addEventListener('click', function () {
          var select = document.getElementById('resume-role-family');
          if (select && resume.role_family) select.value = resume.role_family;
          document.getElementById('resume-generate-button').click();
        });
        var rename = el('button', { type: 'button', textContent: 'Rename' });
        rename.addEventListener('click', async function () {
          var name = window.prompt('New name for this resume:', resume.name);
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

        var actions = [open];
        if (resume.role_family) actions.push(regenerate);
        actions.push(rename, del);

        list.appendChild(el('div', { className: 'row-item' }, [
          el('div', { className: 'row' }, [
            el('div', {}, [
              title,
              el('div', { className: 'row-meta', textContent: subtitleText }),
              el('div', { className: 'row-meta', textContent: meta }),
            ]),
            el('div', { className: 'row-actions' }, actions),
          ]),
        ]));
      });
    }

    /** Populates the career-path picker from the current role analysis. */
    function renderResumeRoleChoices(analysis) {
      var select = document.getElementById('resume-role-family');
      if (!select) return;
      var previous = select.value;
      select.innerHTML = '';
      var roles = (analysis && analysis.roles) || [];
      if (!roles.length) {
        select.appendChild(el('option', { value: '', textContent: 'General — no career paths analyzed yet' }));
        return;
      }
      select.appendChild(el('option', { value: '', textContent: 'General (all career paths)' }));
      roles.forEach(function (role) {
        select.appendChild(el('option', { value: role.title, textContent: role.title }));
      });
      if (previous) select.value = previous;
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
            role_family: (document.getElementById('resume-role-family') || {}).value || '',
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

    // --- Profile → Summary: the canonical career record, rendered for a human ---

    /** A labelled list of short strings, rendered as an indented bullet run. */
    function profileBullets(label, items, host) {
      if (!items || !items.length) return;
      host.appendChild(el('div', { className: 'profile-field-label', textContent: label }));
      var ul = el('ul', { className: 'profile-bullets' });
      items.forEach(function (item) { ul.appendChild(el('li', { textContent: item })); });
      host.appendChild(ul);
    }

    /** A collapsible group. Long sections start closed so the page stays scannable. */
    function profileGroup(title, count, openByDefault) {
      var details = el('details', { className: 'profile-group' });
      details.open = Boolean(openByDefault);
      var summary = el('summary', {}, [
        el('span', { className: 'profile-group-title', textContent: title }),
      ]);
      if (count) summary.appendChild(el('span', { className: 'badge', textContent: String(count) }));
      details.appendChild(summary);
      return details;
    }

    function renderProfileProject(project, host) {
      var card = el('div', { className: 'profile-subcard' });
      card.appendChild(el('div', { className: 'profile-subcard-title', textContent: project.name }));
      if (project.description) card.appendChild(el('p', { className: 'row-meta', textContent: project.description }));
      if (project.problem_or_purpose) {
        card.appendChild(el('p', { className: 'row-meta', textContent: 'Purpose: ' + project.problem_or_purpose }));
      }
      profileBullets('Work performed', project.work_performed, card);
      profileBullets('Technologies', project.technologies_and_methods, card);
      profileBullets('Outcomes', project.outcomes, card);
      profileBullets('Metrics', project.metrics, card);
      profileBullets('Awards', project.awards_and_honors, card);
      profileBullets('Skills demonstrated', project.skills_demonstrated, card);
      host.appendChild(card);
    }

    /** Aggregate sections (skills, tools, signals) all render the same way: claim + its evidence. */
    function renderEvidencedSection(title, items, nameKey, host) {
      if (!items || !items.length) return;
      var group = profileGroup(title, items.length, false);
      items.forEach(function (item) {
        var row = el('div', { className: 'profile-subcard' });
        row.appendChild(el('div', { className: 'profile-subcard-title', textContent: item[nameKey] || item.name || '' }));
        if (item.evidence && item.evidence.length) {
          row.appendChild(el('div', { className: 'row-meta', textContent: item.evidence.join(' · ') }));
        }
        group.appendChild(row);
      });
      host.appendChild(group);
    }

    function renderSimpleListSection(title, items, host) {
      if (!items || !items.length) return;
      var group = profileGroup(title, items.length, false);
      items.forEach(function (item) {
        group.appendChild(el('div', { className: 'profile-subcard' }, [
          el('div', { className: 'row-meta', textContent: item }),
        ]));
      });
      host.appendChild(group);
    }

    /**
     * Renders the CareerProfile as a hierarchical, readable document rather than a JSON dump.
     *
     * The record is deliberately much larger than a resume, so the shape of this view is doing real
     * work: sections are collapsible, the two the candidate most wants to verify (experience and
     * education) start open, and evidence stays visually nested under the role or project it came
     * from -- which is the same provenance rule the data model itself is built on. Raw JSON is still
     * reachable behind a details element for debugging, but it is never the default experience.
     */
    function renderStructuredProfileView(containerId, structured) {
      var container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = '';

      var hasContent = structured && (
        (structured.career_summary && (structured.career_summary.headline || structured.career_summary.narrative_summary)) ||
        (structured.work_experience && structured.work_experience.length) ||
        (structured.education && structured.education.length)
      );
      if (!hasContent) {
        container.appendChild(el('p', {
          className: 'empty',
          textContent: 'No profile yet — add documents and notes, then press Generate Profile.',
        }));
        return;
      }

      var summary = structured.career_summary || {};
      var identity = structured.identity || {};

      if (identity.name) container.appendChild(el('div', { className: 'profile-name', textContent: identity.name }));
      if (summary.headline) container.appendChild(el('div', { className: 'row-title', textContent: summary.headline }));
      var idBits = [identity.location, identity.email, identity.phone].filter(Boolean);
      if (identity.citizenship_or_work_authorization && identity.citizenship_or_work_authorization.length) {
        idBits = idBits.concat(identity.citizenship_or_work_authorization);
      }
      if (idBits.length) container.appendChild(el('div', { className: 'row-meta', textContent: idBits.join(' · ') }));
      if (identity.links && identity.links.length) {
        var links = el('div', { className: 'row-meta' });
        identity.links.forEach(function (link, index) {
          if (index) links.appendChild(text(' · '));
          links.appendChild(el('a', { href: link.url, target: '_blank', rel: 'noopener', textContent: link.label || link.url }));
        });
        container.appendChild(links);
      }
      if (summary.narrative_summary) container.appendChild(el('p', { textContent: summary.narrative_summary }));

      // Experience -- the densest section, and the one worth opening by default.
      if (structured.work_experience && structured.work_experience.length) {
        var expGroup = profileGroup('Work experience', structured.work_experience.length, true);
        structured.work_experience.forEach(function (role) {
          var card = el('div', { className: 'profile-card' });
          var span = [role.start_date, role.current ? 'Present' : role.end_date].filter(Boolean).join(' – ');
          card.appendChild(el('div', {
            className: 'row-title',
            textContent: [role.title, role.organization].filter(Boolean).join(' — ') + (span ? ' (' + span + ')' : ''),
          }));
          var roleMeta = [role.location, role.employment_type].filter(Boolean).join(' · ');
          if (roleMeta) card.appendChild(el('div', { className: 'row-meta', textContent: roleMeta }));
          if (role.description) card.appendChild(el('p', { className: 'row-meta', textContent: role.description }));

          profileBullets('Responsibilities', role.responsibilities, card);
          (role.achievements || []).length && card.appendChild(el('div', { className: 'profile-field-label', textContent: 'Achievements' }));
          (role.achievements || []).forEach(function (achievement) {
            var line = achievement.description +
              (achievement.metrics && achievement.metrics.length ? ' (' + achievement.metrics.join('; ') + ')' : '');
            card.appendChild(el('div', { className: 'row-meta', textContent: '• ' + line }));
          });
          profileBullets('Leadership and management', role.leadership_and_management, card);
          profileBullets('Mentoring and teaching', role.mentoring_and_teaching, card);
          profileBullets('Stakeholder and client work', role.stakeholder_and_client_work, card);
          profileBullets('Communication and documentation', role.communication_and_documentation, card);
          profileBullets('Technologies and methods', role.technologies_and_methods, card);
          profileBullets('Skills demonstrated', role.skills_demonstrated, card);
          (role.projects || []).forEach(function (project) { renderProfileProject(project, card); });

          expGroup.appendChild(card);
        });
        container.appendChild(expGroup);
      }

      if (structured.education && structured.education.length) {
        var eduGroup = profileGroup('Education', structured.education.length, true);
        structured.education.forEach(function (item) {
          var card = el('div', { className: 'profile-card' });
          var line = [item.degree, item.field_of_study].filter(Boolean).join(' in ');
          var years = [item.start_date, item.end_date].filter(Boolean).join(' – ');
          card.appendChild(el('div', {
            className: 'row-title',
            textContent: [line || 'Study', item.institution].filter(Boolean).join(' · ') + (years ? ' (' + years + ')' : ''),
          }));
          if (item.specialization) {
            card.appendChild(el('div', { className: 'row-meta', textContent: 'Specialization: ' + item.specialization }));
          }
          profileBullets('Coursework', item.coursework, card);
          profileBullets('Activities', item.activities, card);
          profileBullets('Awards and honors', item.awards_and_honors, card);
          (item.projects || []).forEach(function (project) { renderProfileProject(project, card); });
          (item.research || []).forEach(function (research) {
            var sub = el('div', { className: 'profile-subcard' });
            sub.appendChild(el('div', { className: 'profile-subcard-title', textContent: research.topic }));
            if (research.description) sub.appendChild(el('p', { className: 'row-meta', textContent: research.description }));
            profileBullets('Contributions', research.contributions, sub);
            profileBullets('Outcomes', research.outcomes, sub);
            card.appendChild(sub);
          });
          eduGroup.appendChild(card);
        });
        container.appendChild(eduGroup);
      }

      if (structured.independent_projects && structured.independent_projects.length) {
        var projGroup = profileGroup('Independent projects', structured.independent_projects.length, false);
        structured.independent_projects.forEach(function (project) {
          var card = el('div', { className: 'profile-card' });
          card.appendChild(el('div', {
            className: 'row-title',
            textContent: project.name + (project.dates ? ' (' + project.dates + ')' : ''),
          }));
          if (project.project_type) card.appendChild(el('div', { className: 'row-meta', textContent: project.project_type }));
          if (project.description) card.appendChild(el('p', { className: 'row-meta', textContent: project.description }));
          if (project.problem_or_purpose) {
            card.appendChild(el('p', { className: 'row-meta', textContent: 'Purpose: ' + project.problem_or_purpose }));
          }
          profileBullets('Work performed', project.work_performed, card);
          profileBullets('Technologies', project.technologies_and_methods, card);
          profileBullets('Outcomes', project.outcomes, card);
          profileBullets('Metrics', project.metrics, card);
          profileBullets('Skills demonstrated', project.skills_demonstrated, card);
          projGroup.appendChild(card);
        });
        container.appendChild(projGroup);
      }

      if (structured.research_and_publications && structured.research_and_publications.length) {
        var pubGroup = profileGroup('Research and publications', structured.research_and_publications.length, false);
        structured.research_and_publications.forEach(function (item) {
          var card = el('div', { className: 'profile-card' });
          card.appendChild(el('div', { className: 'row-title', textContent: item.title }));
          var pubMeta = [item.type, item.venue, item.date, item.authorship_role].filter(Boolean).join(' · ');
          if (pubMeta) card.appendChild(el('div', { className: 'row-meta', textContent: pubMeta }));
          profileBullets('Contributions', item.contributions, card);
          profileBullets('Recognition', item.recognition, card);
          pubGroup.appendChild(card);
        });
        container.appendChild(pubGroup);
      }

      renderEvidencedSection('Technical skills', structured.technical_skills, 'skill', container);
      renderEvidencedSection('Tools and technologies', structured.tools_and_technologies, 'name', container);
      renderEvidencedSection('Professional skills', structured.professional_skills, 'skill', container);
      renderEvidencedSection('Domain knowledge', structured.domain_knowledge, 'domain', container);
      renderEvidencedSection('Career signals', structured.career_signals, 'signal', container);

      renderSimpleListSection('Certifications and training', structured.certifications_and_training, container);
      renderSimpleListSection('Awards and honors', structured.independent_awards_and_honors, container);
      renderSimpleListSection('Community and volunteer', structured.community_outreach_and_volunteer, container);
      renderSimpleListSection('Professional memberships', structured.professional_memberships, container);
      renderSimpleListSection('Languages', structured.languages, container);

      if (structured.other && structured.other.length) {
        var otherGroup = profileGroup('Other', structured.other.length, false);
        structured.other.forEach(function (item) {
          otherGroup.appendChild(el('div', { className: 'profile-subcard' }, [
            el('div', { className: 'profile-subcard-title', textContent: item.category }),
            el('div', { className: 'row-meta', textContent: item.description }),
          ]));
        });
        container.appendChild(otherGroup);
      }

      // Gaps last: they are the app asking the candidate for more, not part of the record itself.
      if (structured.evidence_gaps && structured.evidence_gaps.length) {
        var gapGroup = profileGroup('What would strengthen this profile', structured.evidence_gaps.length, false);
        gapGroup.appendChild(el('p', {
          className: 'hint',
          textContent: 'Nothing here is a problem with your profile — these are things the app could not determine from your documents. Answering any of them in Notes and regenerating will improve it.',
        }));
        structured.evidence_gaps.forEach(function (gap) {
          var card = el('div', { className: 'profile-subcard' });
          card.appendChild(el('div', { className: 'profile-subcard-title', textContent: gap.topic }));
          if (gap.missing_information) card.appendChild(el('div', { className: 'row-meta', textContent: gap.missing_information }));
          if (gap.why_it_matters) card.appendChild(el('div', { className: 'row-meta', textContent: 'Why it matters: ' + gap.why_it_matters }));
          if (gap.suggested_question) card.appendChild(el('div', { className: 'row-meta', textContent: '→ ' + gap.suggested_question }));
          gapGroup.appendChild(card);
        });
        container.appendChild(gapGroup);
      }

      var rawDetails = document.getElementById('career-profile-raw-details');
      if (rawDetails) {
        rawDetails.style.display = '';
        document.getElementById('career-profile-raw').textContent = JSON.stringify(structured, null, 2);
      }
    }

    /** Tracks whether a profile exists, so the button reads Generate vs Regenerate. */
    var hasCareerProfile = false;

    function setProfileButtonMode(exists) {
      hasCareerProfile = Boolean(exists);
      var button = document.getElementById('profile-generate-button');
      if (button) button.textContent = hasCareerProfile ? 'Regenerate Profile' : 'Generate Profile';
    }

    document.getElementById('profile-generate-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('profile-generate-status');
      var button = this;
      var provider = document.getElementById('profile-provider').value;
      button.disabled = true;
      statusEl.textContent = 'Reading every document and note on file…';
      statusEl.className = 'status';
      try {
        var genRes = await api('/profile/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: provider }),
        });
        var genData = await requireJsonResponse(genRes, 'profile_generation_failed');

        var saveRes = await api('/profile/structured', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ structured: genData.draft_structured }),
        });
        var saved = await requireJsonResponse(saveRes, 'profile_save_failed');

        renderStructuredProfileView('career-profile-view', saved.structured);
        setProfileButtonMode(true);
        // A regeneration that came back with materially less history than the stored record is
        // rejected server-side; saying so beats silently showing the unchanged profile.
        statusEl.textContent = genData.rejected_incomplete
          ? 'That regeneration came back incomplete, so your existing profile was kept. Try again.'
          : 'Profile updated.';
        statusEl.className = genData.rejected_incomplete ? 'status error' : 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      } finally {
        button.disabled = false;
      }
    });

    // --- Profile → Improve: guided evidence interview ---
    //
    // One state-driven primary action button, per the spec: "Find Improvements" (no audit run yet,
    // or the open questions have all been resolved), "Apply Answers & Continue" (at least one saved
    // answer waiting to be integrated), "Improving Profile…" (a call is in flight), or
    // "Check Again" (the last audit found nothing valuable). Never a chat UI, never separate
    // technical buttons for "run audit" vs "integrate JSON".

    var improveQuestions = [];
    var improveHasAudited = false;
    var improveBusy = false;

    function improveCategoryLabel(category) {
      return (category || 'other').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    function updateImproveButton() {
      var button = document.getElementById('improve-action-button');
      if (!button) return;
      var answeredCount = improveQuestions.filter(function (q) { return q.status === 'answered'; }).length;
      var pendingCount = improveQuestions.filter(function (q) { return q.status === 'pending'; }).length;
      if (improveBusy) {
        button.textContent = 'Improving Profile…';
      } else if (answeredCount > 0) {
        button.textContent = 'Apply Answers & Continue';
      } else if (improveHasAudited && pendingCount === 0) {
        button.textContent = 'Check Again';
      } else {
        button.textContent = 'Find Improvements';
      }
      button.disabled = improveBusy;

      var progress = document.getElementById('improve-progress');
      if (pendingCount === 0 && answeredCount === 0) {
        progress.style.display = 'none';
      } else {
        progress.style.display = '';
        progress.textContent = answeredCount + ' answered · ' + pendingCount + ' remaining';
      }
    }

    function renderImproveQuestionCard(question) {
      var card = el('div', { className: 'profile-card' });
      var titleRow = el('div', { className: 'row-title-line', style: 'display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap' });
      titleRow.appendChild(el('span', { className: 'badge', textContent: improveCategoryLabel(question.category) }));
      if (question.status === 'answered') titleRow.appendChild(el('span', { className: 'badge', textContent: 'Answered', style: 'background:var(--success,#2e7d32);color:#fff' }));
      card.appendChild(titleRow);
      card.appendChild(el('p', { className: 'row-title', textContent: question.question, style: 'margin-top:0.4rem' }));
      if (question.why_it_matters) {
        card.appendChild(el('p', { className: 'row-meta', textContent: 'Why it matters: ' + question.why_it_matters }));
      }
      var textarea = el('textarea', {
        placeholder: 'Your answer…',
        value: question.answer || '',
        style: 'min-height:4.5rem',
      });
      card.appendChild(textarea);
      var actions = el('div', { className: 'row-actions', style: 'margin-top:0.5rem' });
      var statusMsg = el('span', { className: 'status' });
      var saveBtn = el('button', { type: 'button', textContent: question.status === 'answered' ? 'Update Answer' : 'Save' });
      saveBtn.addEventListener('click', async function () {
        var value = textarea.value.trim();
        if (!value) { statusMsg.textContent = 'Enter an answer first.'; statusMsg.className = 'status error'; return; }
        saveBtn.disabled = true;
        try {
          var res = await api('/profile/improve/questions/' + encodeURIComponent(question.id), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ answer: value }),
          });
          var data = await requireJsonResponse(res, 'save_failed');
          question.status = data.question.status;
          question.answer = data.question.answer;
          statusMsg.textContent = 'Saved.';
          statusMsg.className = 'status success';
          updateImproveButton();
          renderImproveQuestions(improveQuestions);
        } catch (err) {
          statusMsg.textContent = 'Error: ' + err.message;
          statusMsg.className = 'status error';
          saveBtn.disabled = false;
        }
      });
      var dismissBtn = el('button', { type: 'button', className: 'secondary', textContent: 'Skip / Dismiss' });
      dismissBtn.addEventListener('click', async function () {
        dismissBtn.disabled = true;
        try {
          await api('/profile/improve/questions/' + encodeURIComponent(question.id) + '/dismiss', { method: 'POST' });
          improveQuestions = improveQuestions.filter(function (q) { return q.id !== question.id; });
          updateImproveButton();
          renderImproveQuestions(improveQuestions);
        } catch (err) {
          statusMsg.textContent = 'Error: ' + err.message;
          statusMsg.className = 'status error';
          dismissBtn.disabled = false;
        }
      });
      actions.appendChild(saveBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);
      card.appendChild(statusMsg);
      return card;
    }

    /** Grouped by entity, highest-priority question in each group first, groups ordered by their
     * own best question -- so the candidate sees the most valuable open thread first but can still
     * jump straight to any other role or project's questions. */
    function renderImproveQuestions(questions) {
      var container = document.getElementById('improve-questions');
      container.innerHTML = '';
      if (!questions.length) {
        if (improveHasAudited) {
          container.appendChild(el('p', {
            className: 'empty',
            textContent: 'No high-value questions found right now. Your Career Evidence Record already contains strong detail across the areas this review checks.',
          }));
        }
        return;
      }
      var groups = {};
      var order = [];
      questions.forEach(function (q) {
        var key = q.entity_label || 'General';
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(q);
      });
      order.sort(function (a, b) {
        var maxA = Math.max.apply(null, groups[a].map(function (q) { return q.priority; }));
        var maxB = Math.max.apply(null, groups[b].map(function (q) { return q.priority; }));
        return maxB - maxA;
      });
      order.forEach(function (key) {
        var items = groups[key].slice().sort(function (a, b) { return b.priority - a.priority; });
        var group = profileGroup(key, items.length, true);
        items.forEach(function (q) { group.appendChild(renderImproveQuestionCard(q)); });
        container.appendChild(group);
      });
    }

    /** Called from loadProfile so Improve reflects "no profile yet" (state A) without an extra
     * round trip, and so a profile that already has open questions shows them immediately. */
    function setImproveProfileAvailability(hasProfile) {
      document.getElementById('improve-no-profile').style.display = hasProfile ? 'none' : '';
      document.getElementById('improve-controls').style.display = hasProfile ? '' : 'none';
      document.getElementById('improve-questions').style.display = hasProfile ? '' : 'none';
    }

    async function loadImproveQuestions() {
      try {
        var res = await api('/profile/improve/questions');
        var data = await res.json();
        improveQuestions = data.questions || [];
        if (improveQuestions.length) improveHasAudited = true;
        renderImproveQuestions(improveQuestions);
        updateImproveButton();
      } catch (err) {
        // Best-effort on initial load; the action button still lets the candidate try explicitly.
      }
    }

    document.getElementById('improve-go-to-create').addEventListener('click', function () {
      document.querySelector('[data-profile-subtab="summary"]').click();
    });

    document.getElementById('improve-action-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('improve-status');
      var provider = document.getElementById('improve-provider').value;
      var answeredCount = improveQuestions.filter(function (q) { return q.status === 'answered'; }).length;
      improveBusy = true;
      updateImproveButton();
      statusEl.textContent = answeredCount > 0
        ? 'Integrating your answers into the profile…'
        : 'Reviewing your Career Evidence Record for high-value gaps…';
      statusEl.className = 'status';
      try {
        if (answeredCount > 0) {
          var applyRes = await api('/profile/improve/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: provider }),
          });
          var applyData = await requireJsonResponse(applyRes, 'apply_failed');
          renderStructuredProfileView('career-profile-view', applyData.structured);
          setProfileButtonMode(true);
          improveQuestions = applyData.questions || [];
          improveHasAudited = true;
          statusEl.textContent = applyData.applied_count + ' answer' + (applyData.applied_count === 1 ? '' : 's') +
            ' applied to your profile.' + (applyData.reaudit_error ? ' (Could not check for new questions -- try Check Again.)' : '');
          statusEl.className = 'status success';
        } else {
          var auditRes = await api('/profile/improve/audit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: provider }),
          });
          var auditData = await requireJsonResponse(auditRes, 'audit_failed');
          improveQuestions = auditData.questions || [];
          improveHasAudited = true;
          statusEl.textContent = auditData.inserted > 0
            ? 'Found ' + auditData.inserted + ' new question' + (auditData.inserted === 1 ? '' : 's') + '.'
            : 'No new questions this time.';
          statusEl.className = 'status success';
        }
        renderImproveQuestions(improveQuestions);
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      } finally {
        improveBusy = false;
        updateImproveButton();
      }
    });

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

    // One line of identifying info when collapsed: the parsed job's title/company/location if the
    // fetch succeeded, otherwise the bare URL the candidate pasted -- either way enough to tell
    // examples apart without expanding each one.
    function roleExampleSummaryLine(item) {
      var job = item.job;
      if (job && job.title) {
        return job.title + (job.company ? ' at ' + job.company : '') + (job.location ? ' · ' + job.location : '');
      }
      return item.source_url;
    }

    function roleExampleFullText(item) {
      var job = item.job;
      var parts = [];
      if (job && job.title) parts.push(job.title + (job.company ? ' at ' + job.company : ''));
      if (job && job.location) parts.push(job.location);
      if (job && job.employment_type) parts.push(job.employment_type);
      if (job && job.description) parts.push(job.description);
      if (job && job.responsibilities && job.responsibilities.length) parts.push('Responsibilities: ' + job.responsibilities.join('; '));
      if (job && job.qualifications && job.qualifications.length) parts.push('Qualifications: ' + job.qualifications.join('; '));
      if (job && job.skills && job.skills.length) parts.push('Skills: ' + job.skills.join(', '));
      if (!job && item.fetch_status === 'failed') parts.push("Couldn't fetch this posting -- saved with the link and reason only.");
      if (item.reason) parts.push('Reason: ' + item.reason);
      parts.push(item.source_url);
      return parts.join(' — ');
    }

    // Same collapsible-row shape as renderCollapsibleList, but the collapsed line is built from the
    // parsed job rather than a raw claim string, and the expanded text pulls in every parsed field.
    function renderRoleExampleList(listId, items, emptyText, onDelete) {
      var list = document.getElementById(listId);
      list.innerHTML = '';
      if (!items || !items.length) {
        list.appendChild(el('p', { className: 'empty', textContent: emptyText }));
        return;
      }
      items.forEach(function (item) {
        var summary = roleExampleSummaryLine(item);
        var expanded = false;
        var textEl = el('div', { className: 'collapsible-text', textContent: summary });
        textEl.addEventListener('click', function () {
          expanded = !expanded;
          textEl.textContent = expanded ? roleExampleFullText(item) : summary;
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

    // Good and bad examples are the same shape end to end (list/summary/form ids differ only by
    // the 'good'/'bad' prefix), so one setup function drives both sections.
    function setupRoleExampleSection(type) {
      var listId = 'role-examples-' + type + '-list';
      var summaryId = 'role-examples-' + type + '-summary';
      var formId = 'role-example-' + type + '-form';
      var urlId = 'role-example-' + type + '-url';
      var reasonId = 'role-example-' + type + '-reason';
      var statusId = 'role-example-' + type + '-status';
      var noun = type === 'good' ? 'good example' : 'bad example';

      async function load() {
        var res = await api('/role-examples');
        var data = await res.json();
        var items = data[type] || [];
        document.getElementById(summaryId).textContent =
          items.length === 1 ? '1 ' + noun + ' on file' : items.length + ' ' + noun + 's on file';
        renderRoleExampleList(listId, items, 'Nothing added yet.', async function (item) {
          await api('/role-examples/' + encodeURIComponent(item.id), { method: 'DELETE' });
          markRolesDirty();
          load();
        });
      }

      document.getElementById(formId).addEventListener('submit', async function (event) {
        event.preventDefault();
        var statusEl = document.getElementById(statusId);
        statusEl.textContent = 'Adding…';
        statusEl.className = 'status';
        try {
          var res = await api('/role-examples', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: type,
              source_url: document.getElementById(urlId).value,
              reason: document.getElementById(reasonId).value,
              provider: document.getElementById('role-analysis-provider').value,
            }),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(errorMessage(data, 'add_failed'));
          statusEl.textContent = data.job
            ? 'Added — read the posting successfully.'
            : "Added — couldn't read the posting, saved the link and reason.";
          statusEl.className = 'status success';
          document.getElementById(formId).reset();
          markRolesDirty();
          load();
        } catch (err) {
          statusEl.textContent = 'Error: ' + err.message;
          statusEl.className = 'status error';
        }
      });

      return load;
    }

    var loadGoodRoleExamples = setupRoleExampleSection('good');
    var loadBadRoleExamples = setupRoleExampleSection('bad');
    function loadRoleExamples() { loadGoodRoleExamples(); loadBadRoleExamples(); }

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
    // Populated by a "Check for replies" run (see the gmail-check-replies-button handler) -- held
    // only in memory for this page load, never persisted, keyed by job id.
    var gmailReplyMatches = {};
    var gmailReplySkipped = {};
    var liveJobsRefreshTimer = null;
    var liveJobsRefreshInFlight = false;
    var liveJobsRefreshAgain = false;

    // Search and Jobs share the database as their source of truth. Coalesce bursts of pipeline
    // events into small authoritative /jobs refreshes so rows and counts advance batch-by-batch
    // without resetting the Search diagram's transient in-flight animation state.
    function queueLiveJobsRefresh() {
      clearTimeout(liveJobsRefreshTimer);
      liveJobsRefreshTimer = setTimeout(async function refreshLiveJobs() {
        if (liveJobsRefreshInFlight) {
          liveJobsRefreshAgain = true;
          return;
        }
        liveJobsRefreshInFlight = true;
        try {
          await loadJobs(false);
          // Reconcile the Search Sankey from the newly persisted rows too. This keeps its two
          // visually distinct Fail populations authoritative between streaming batches without
          // resetting the rest of the running Search UI.
          syncPipelineFitCountsFromJobs();
        } catch (err) {
          // The main Search request remains authoritative and will do a final full refresh. A
          // transient side-refresh failure should not abort paid screening work already in flight.
        } finally {
          liveJobsRefreshInFlight = false;
          if (liveJobsRefreshAgain) {
            liveJobsRefreshAgain = false;
            queueLiveJobsRefresh();
          }
        }
      }, 80);
    }

    function matchesFilter(haystack, needle) {
      if (!needle) return true;
      return haystack.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
    }

    // The reason a failed company shows in the Unverified tab, in plain language -- see
    // classifyVerification in src/companies.ts and the search-fallback confidence floor in
    // src/websearch.ts for where these five codes come from.
    var VERIFY_REASON_LABELS = {
      no_website: 'No website could be confirmed for this company.',
      no_job_board: 'A website was confirmed, but no job board could be found on it.',
      unsupported_ats: 'This company’s job board uses a system this app can’t automatically read yet.',
      board_unreachable: 'A supported job board was found, but reading it failed. This is often temporary.',
      ambiguous: 'A possible website was found, but not with enough confidence to trust automatically — this is a common-name collision, not a missing website.',
    };

    var companiesView = 'find';
    var companiesUnverifiedReason = '';
    var companiesPipeline = {};

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
        if (company.status === 'verified') {
          titleChildren.push(el('span', { className: 'badge strong', textContent: 'verified' }));
        } else if (company.status === 'unverified') {
          titleChildren.push(el('span', { className: 'badge warn', textContent: company.verify_reason ? company.verify_reason.replace(/_/g, ' ') : 'unverified' }));
        }
        if (company.status === 'dismissed') {
          titleChildren.push(el('span', { className: 'badge', textContent: 'removed' }));
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
        if (company.signal) body.push(el('p', { className: 'company-bio', textContent: company.signal }));
        if (company.bio) body.push(el('p', { className: 'company-bio', textContent: company.bio }));
        // Prominent, plain-language failure reason -- debugging why a company didn't make it in
        // matters for an open-source app the candidate might need to fix themselves.
        if (company.status === 'unverified') {
          body.push(el('p', {
            className: 'company-why',
            textContent: 'Why verification failed: ' + (VERIFY_REASON_LABELS[company.verify_reason] || 'Unknown reason.'),
          }));
        }
        if (company.scan_note) body.push(el('div', { className: 'row-meta', textContent: company.scan_note }));
        // Resolved once this company was checked -- the actual careers/board link the site
        // publishes, not just its homepage. Most useful for a detected-but-unsupported ATS (ADP,
        // iCIMS, ...), where this is the only way to actually see the postings, but shown whenever
        // it's known since "click through and look yourself" is always a fair fallback.
        if (company.careers_url) {
          body.push(el('div', { className: 'row-meta' }, [
            el('a', { href: company.careers_url, target: '_blank', rel: 'noopener', textContent: 'View job board ↗' }),
          ]));
        }

        // The manual-fix path for any unverified company: typing a real website here re-verifies it
        // the same way discovery would have, and clears any stale board resolution so the next scan
        // starts fresh against the corrected domain.
        if (company.status === 'unverified') {
          var websiteInput = el('input', { type: 'url', placeholder: 'https://example.com' });
          var websiteButton = el('button', { type: 'button', textContent: 'Save website' });
          var websiteStatus = el('span', { className: 'row-meta' });
          websiteButton.addEventListener('click', async function () {
            var value = websiteInput.value.trim();
            if (!value) return;
            websiteStatus.textContent = 'Checking…';
            var res = await api('/companies/' + encodeURIComponent(company.id), {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ website: value }),
            });
            var data = await res.json();
            websiteStatus.textContent = data.reachable ? 'Verified — refreshing…' : "Couldn't be reached; double-check the address.";
            if (data.reachable) await loadCompanies();
          });
          body.push(el('div', { className: 'row' }, [websiteInput, websiteButton, websiteStatus]));
        }

        var changeStatus = el('button', {
          type: 'button',
          textContent: company.status === 'dismissed' ? 'Re-add' : 'Remove',
          className: company.status === 'dismissed' ? '' : 'danger',
        });
        changeStatus.addEventListener('click', async function () {
          await api('/companies/' + encodeURIComponent(company.id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: company.status === 'dismissed' ? 'reachable' : 'dismissed' }),
          });
          loadCompanies();
        });

        var muted = company.status === 'dismissed' || company.status === 'unverified';
        list.appendChild(el('div', { className: 'row-item' + (muted ? ' is-muted' : '') }, [
          el('div', { className: 'row' }, [
            el('div', {}, body),
            el('div', { className: 'row-actions' }, [changeStatus]),
          ]),
        ]));
      });
    }

    function renderCompanies() {
      var finding = companiesView === 'find';
      document.getElementById('companies-find-panel').style.display = finding ? 'block' : 'none';
      document.getElementById('companies-list-section').style.display = finding ? 'none' : 'block';
      document.getElementById('companies-unverified-filters').style.display = companiesView === 'unverified' ? 'flex' : 'none';
      if (finding) return;

      var needle = document.getElementById('companies-filter').value.trim();
      var list = document.getElementById('companies-list');
      list.innerHTML = '';

      var matching = allCompanies.filter(function (c) {
        return matchesFilter([c.name, c.location, c.bio, c.signal].join(' '), needle);
      });
      var visible = matching.filter(function (c) {
        if (companiesView === 'removed') return c.status === 'dismissed';
        if (companiesView === 'verified') return c.status === 'verified';
        if (companiesView === 'unverified') {
          if (c.status !== 'unverified') return false;
          return !companiesUnverifiedReason || c.verify_reason === companiesUnverifiedReason;
        }
        return false;
      });

      if (!visible.length) {
        list.appendChild(el('p', {
          className: 'empty',
          textContent: !allCompanies.length ? 'No companies yet — use the Search tab to add some.'
            : (matching.length ? 'No companies in this category.' : 'No companies match that filter.'),
        }));
        return;
      }
      renderCompanyRows(list, visible);
    }

    // ---- Companies -> Search: search terms (chips) -----------------------------------------------
    // The frontend owns the working list client-side and PUTs the whole thing back on every change
    // (see setCompanySearchTerms's own comment for why) -- so add/remove/reset all just mutate
    // companySearchTerms then call saveCompanySearchTerms, never a separate per-chip endpoint.
    var companySearchTerms = [];

    function renderCompanySearchTerms() {
      var list = document.getElementById('companies-search-terms-list');
      list.innerHTML = '';
      companySearchTerms.forEach(function (entry, index) {
        var removeBtn = el('button', { type: 'button', title: 'Remove "' + entry.term + '"', 'aria-label': 'Remove ' + entry.term, textContent: String.fromCharCode(215) });
        removeBtn.addEventListener('click', function () {
          companySearchTerms.splice(index, 1);
          saveCompanySearchTerms();
        });
        list.appendChild(el('span', { className: 'chip' + (entry.source === 'manual' ? ' chip-manual' : '') }, [
          el('span', { textContent: entry.term }),
          removeBtn,
        ]));
      });
    }

    async function saveCompanySearchTerms() {
      renderCompanySearchTerms();
      var statusEl = document.getElementById('companies-search-terms-status');
      try {
        var res = await api('/companies/search-terms', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ terms: companySearchTerms }),
        });
        if (!res.ok) throw new Error(errorMessage(await res.json(), 'save_failed'));
        statusEl.textContent = '';
        statusEl.className = 'status';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    }

    async function loadCompanySearchTerms() {
      var res = await api('/companies/search-terms');
      var data = await res.json();
      companySearchTerms = data.terms || [];
      renderCompanySearchTerms();
    }

    function addCompanySearchTermFromInput() {
      var input = document.getElementById('companies-search-term-input');
      var value = input.value.trim();
      if (!value) return;
      var already = companySearchTerms.some(function (t) { return t.term.toLowerCase() === value.toLowerCase(); });
      if (!already) companySearchTerms.push({ term: value, source: 'manual' });
      input.value = '';
      saveCompanySearchTerms();
    }
    document.getElementById('companies-search-term-add').addEventListener('click', addCompanySearchTermFromInput);
    document.getElementById('companies-search-term-input').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addCompanySearchTermFromInput(); }
    });

    document.getElementById('companies-search-terms-reset').addEventListener('click', async function () {
      var statusEl = document.getElementById('companies-search-terms-status');
      statusEl.textContent = 'Regenerating from your Role Analysis…';
      statusEl.className = 'status';
      try {
        var res = await api('/companies/search-terms/regenerate', { method: 'POST' });
        var data = await res.json();
        if (!res.ok) throw new Error(errorMessage(data, 'regenerate_failed'));
        companySearchTerms = data.terms || [];
        renderCompanySearchTerms();
        statusEl.textContent = 'Suggested terms refreshed. Your own additions were kept.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    // ---- Companies -> Search: Discovery -> Verify -----------------------------------------------
    // Same generic engine Jobs uses (createPipelineFlow, defined further down -- function
    // declarations are hoisted, so calling it here before its own textual definition is fine).
    // Only two stages, and deliberately no accumulator edge overrides: unlike Jobs' review_queue,
    // neither 'verified' nor 'unverified' feeds a further stage in this diagram, so the default
    // rule (an edge's committed volume is simply its target node's own count) is exactly right for
    // both edges here. The Companies -> Jobs handoff (a jobs COUNT, not a companies one) sits in
    // the same row, visually joined, but is deliberately not folded into this ribbon graph -- see
    // the HTML/CSS comment on #companies-pipeline-row.
    var CPF_NODES = [
      { id: 'discovery_gate', label: 'Discovered', stage: 0, kind: 'gate' },
      { id: 'unverified', label: 'Unverified', stage: 1, kind: 'reject' },
      { id: 'verified', label: 'Verified', stage: 1, kind: 'success' },
    ];
    var CPF_BRANCHES = { discovery_gate: ['unverified', 'verified'] };
    var CPF_STAGE_TITLES = ['Discovery', 'Verify'];
    // vbH/sourceHeight/colStep are Jobs' own #jobs-pipeline constants, unchanged. vbW=770 is those
    // same constants' natural width for 2 stages instead of 3 (COL_MARGIN 66 + 1*colStep 550 +
    // node width 10 + the same ~144-unit label margin Jobs reserves) -- see the CSS comment on
    // #companies-pipeline for how this stays visually the same size as Jobs despite the smaller
    // viewBox.
    var companiesFlow = createPipelineFlow({ svgId: 'cpf-svg', nodes: CPF_NODES, branches: CPF_BRANCHES, stageTitles: CPF_STAGE_TITLES, vbW: 770, vbH: 340, sourceHeight: 200, colStep: 550 });

    var cpfDiscovered = 0, cpfVerified = 0, cpfUnverified = 0;

    function cpfRefresh() {
      var nodeCounts = { discovery_gate: Math.max(0, cpfDiscovered), unverified: cpfUnverified, verified: cpfVerified };
      companiesFlow.setCounts(nodeCounts, { total: nodeCounts.discovery_gate + nodeCounts.unverified + nodeCounts.verified });
    }

    // Full reconciliation from the authoritative backend counts -- every /companies load resets
    // Discovery/Verify from here, the same role setPfCounts plays for Jobs. Never bursts on its
    // own; live per-company bursts come only from the discover/scan progress handlers below, which
    // is where a real, individually-resolved company outcome actually becomes known.
    // Every number here is explicitly unit-labeled and never combined with a number of a different
    // unit as if they were comparable -- Discovery counts job postings (with unique companies as a
    // secondary figure), Verify counts companies, Pre-screen counts jobs. E.g. never "found 269,
    // verified 214, imported 57"; always "269 companies discovered, 214 verified, 57 jobs imported".
    function renderCompanyPipelineStats() {
      var p = companiesPipeline;
      cpfDiscovered = p.discovered || 0;
      cpfVerified = p.verified || 0;
      cpfUnverified = p.unverified || 0;
      cpfRefresh();
      document.getElementById('cpfStatPrescreen').textContent = p.prescreen_jobs || 0;
      document.getElementById('companies-pipeline-summary').textContent =
        (p.discovery_postings || 0) + ' job postings searched across ' + (p.discovery_companies || 0) + ' compan' + ((p.discovery_companies || 0) === 1 ? 'y' : 'ies') +
        ' · ' + cpfVerified + ' verified · ' + cpfUnverified + ' unverified · ' + (p.prescreen_jobs || 0) + ' jobs imported into Jobs → Pre-screen.';
    }

    async function loadCompanies() {
      var res = await api('/companies');
      var data = await res.json();
      allCompanies = data.companies || [];
      companiesPipeline = data.company_pipeline || {};
      document.getElementById('companies-verified-count').textContent = '(' + (companiesPipeline.verified || 0) + ')';
      document.getElementById('companies-unverified-count').textContent = '(' + (companiesPipeline.unverified || 0) + ')';
      document.getElementById('companies-removed-count').textContent = '(' + (companiesPipeline.dismissed || 0) + ')';
      ['no_website', 'no_job_board', 'unsupported_ats', 'board_unreachable', 'ambiguous'].forEach(function (reason) {
        document.getElementById('companies-reason-' + reason + '-count').textContent = '(' + (companiesPipeline['unverified_' + reason] || 0) + ')';
      });
      document.getElementById('companies-reason-all-count').textContent = '(' + (companiesPipeline.unverified || 0) + ')';
      renderCompanyPipelineStats();
      renderCompanies();
    }

    document.getElementById('companies-filter').addEventListener('input', renderCompanies);
    document.querySelectorAll('[data-companies-view]').forEach(function (button) {
      button.addEventListener('click', function () {
        companiesView = button.dataset.companiesView;
        document.querySelectorAll('[data-companies-view]').forEach(function (item) {
          item.classList.remove('active');
          item.setAttribute('aria-pressed', 'false');
        });
        button.classList.add('active');
        button.setAttribute('aria-pressed', 'true');
        renderCompanies();
      });
    });
    document.querySelectorAll('[data-unverified-reason]').forEach(function (button) {
      button.addEventListener('click', function () {
        companiesUnverifiedReason = button.dataset.unverifiedReason;
        document.querySelectorAll('[data-unverified-reason]').forEach(function (item) {
          item.classList.remove('active');
          item.setAttribute('aria-pressed', 'false');
        });
        button.classList.add('active');
        button.setAttribute('aria-pressed', 'true');
        renderCompanies();
      });
    });

    async function scanNewCompanies(statusEl) {
      var res = await api('/companies/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 500 }),
      });
      if (!res.ok) throw new Error(errorMessage(await res.json(), 'scan_failed'));
      return readNdjson(res, function (event) {
        statusEl.textContent = 'Checking job boards… ' + event.done + ' of ' + event.total +
          ' (' + event.company + (event.new_jobs ? ', ' + event.new_jobs + ' openings added' : '') + ')';
        // scanCompanies is where a company's Verify outcome actually becomes known -- domain
        // resolution alone (the discover-button handler below) only gets it as far as the
        // Discovery gate. One real per-company burst per event, same idea as Jobs' pipeline events.
        if (typeof event.verified === 'boolean') {
          cpfDiscovered = Math.max(0, cpfDiscovered - 1);
          if (event.verified) cpfVerified += 1; else cpfUnverified += 1;
          cpfRefresh();
          companiesFlow.burst(event.verified ? 'discovery_gate->verified' : 'discovery_gate->unverified', 1);
        }
      });
    }

    // Find companies: search real job postings for real hiring activity, then verify each new
    // company has a real, readable job board -- one action, the whole Discovery → Verify pipeline,
    // then hands straight into the existing board scan (which is where jobs actually get imported
    // into Jobs' own Pre-screen). No LLM call anywhere in this flow. Each stage's endpoint only
    // does a bounded unit of work per call, so this re-fires each stage until its backlog clears or
    // a round cap protects against a stuck state, exactly like Find Jobs already does.
    // "Find companies" means continue, not start over: /companies/discover advances each
    // (search term, location) stream from wherever its own cursor left off (never page 1 of an
    // already-searched stream), and stops itself on a provider rate limit or once this click's
    // bounded batch of streams is processed -- streams_remaining/rate_limited below say what, if
    // anything, is left for another click. The round loop here just re-fires that bounded call a
    // few times so a realistic backlog usually clears in one click instead of requiring several.
    document.getElementById('companies-discover-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('companies-discover-status');
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Searching real job postings…';
      statusEl.className = 'status';
      try {
        var round = 0, totalAdded = 0, totalDuplicates = 0, totalOffTarget = 0;
        var totalResolved = 0, totalUnresolved = 0, discoverData;
        do {
          round += 1;
          var res = await api('/companies/discover', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ focus: document.getElementById('company-focus').value }),
          });
          if (!res.ok) throw new Error(errorMessage(await res.json(), 'discovery_failed'));
          discoverData = await readNdjson(res, function (event) {
            if (event.stage === 'search') {
              statusEl.textContent = (round > 1 ? 'Round ' + round + ': ' : '') + 'Searching job postings… ' + (event.done || 0) + ' of ' + event.total + ' quer' + (event.total === 1 ? 'y' : 'ies');
              return;
            }
            statusEl.textContent = (round > 1 ? 'Round ' + round + ': ' : '') + 'Verifying companies… ' + event.done + ' of ' + event.total +
              (event.company ? ' (' + event.company + (event.done ? (event.resolved ? ', website found' : ', website not found') : '') + ')' : '') + '…';
            // A resolve-stage event is one company's real, just-determined outcome: either it has
            // a confirmed website and enters Discovery awaiting a board check, or (no website) it's
            // already fully classified Unverified -- no board check could ever help it.
            if (event.stage === 'resolve' && event.company) {
              if (event.resolved) {
                cpfDiscovered += 1;
                cpfRefresh();
                companiesFlow.burstIntoGate('discovery_gate', 1);
              } else {
                cpfUnverified += 1;
                cpfRefresh();
                companiesFlow.burst('discovery_gate->unverified', 1);
              }
            }
          });
          totalAdded += discoverData.added || 0;
          totalDuplicates += discoverData.duplicates || 0;
          totalOffTarget += discoverData.off_target || 0;
          totalResolved += discoverData.domain_resolved || 0;
          totalUnresolved += discoverData.domain_unresolved || 0;
        } while (round < 10 && !discoverData.rate_limited && discoverData.streams_remaining > 0);

        // Always re-check job boards, not only when this click found something new -- scanCompanies
        // covers every eligible company each call (including prior Unverified rows worth retrying,
        // e.g. a "no website" company a search-grounded lookup might now resolve), which is what
        // makes Unverified companies actually get retried on a later Find companies click instead
        // of only ever being checked once.
        var scanData = await scanNewCompanies(statusEl);

        var parts = [totalAdded ? (totalAdded + ' new compan' + (totalAdded === 1 ? 'y' : 'ies') + ' discovered.') : 'No new companies discovered this run.'];
        if (totalResolved || totalUnresolved) parts.push(totalResolved + ' website' + (totalResolved === 1 ? '' : 's') + ' confirmed, ' + totalUnresolved + " couldn't be found automatically.");
        if (scanData) {
          parts.push((scanData.new_listings ? scanData.new_listings + ' new job' + (scanData.new_listings === 1 ? '' : 's') + ' imported' : 'No new jobs found') +
            ' from ' + scanData.scanned + ' compan' + (scanData.scanned === 1 ? 'y' : 'ies') + ' checked.');
          parts.push('Those jobs are now in Jobs → Pre-screen.');
        }
        if (totalDuplicates) parts.push(totalDuplicates + ' already on your list.');
        if (totalOffTarget) parts.push(totalOffTarget + ' rejected as outside ' + (discoverData.locations || 'your locations') + '.');
        if (discoverData.rate_limited) {
          parts.push('Search paused at the job board’s rate limit — click Find companies again to continue.');
        } else if (discoverData.streams_remaining > 0) {
          parts.push(discoverData.streams_remaining + ' search quer' + (discoverData.streams_remaining === 1 ? 'y' : 'ies') + ' left to check — click Find companies again to continue.');
        }
        if (discoverData.query_errors && discoverData.query_errors.length) {
          parts.push(discoverData.query_errors.length + ' quer' + (discoverData.query_errors.length === 1 ? 'y' : 'ies') + ' failed and will retry next run.');
        }
        statusEl.textContent = parts.join(' ');
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
        var scanData = data.added ? await scanNewCompanies(statusEl) : null;
        statusEl.textContent = data.added
          ? 'Added and checked its job board' + (scanData ? '; imported ' + scanData.new_listings + ' opening' + (scanData.new_listings === 1 ? '' : 's') + '.' : '.')
          : 'Already on your list.';
        statusEl.className = 'status success';
        document.getElementById('company-form').reset();
        await loadCompanies();
        await loadJobs();
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
        var scanData = data.added ? await scanNewCompanies(statusEl) : null;
        statusEl.textContent = 'Added ' + data.added + ' of ' + data.total + '.' +
          (scanData ? ' Checked ' + scanData.scanned + ' job board' + (scanData.scanned === 1 ? '' : 's') +
            ' and imported ' + scanData.new_listings + ' opening' + (scanData.new_listings === 1 ? '' : 's') + '.' : '') +
          (data.skipped ? ' ' + data.skipped + ' already on your list.' : '');
        statusEl.className = 'status success';
        textEl.value = '';
        await loadCompanies();
        await loadJobs();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    var FIT_LABELS = {
      strong: { text: 'Strong match', cls: 'strong' },
      possible: { text: 'Possible match', cls: 'possible' },
      reject: { text: 'Not a fit', cls: 'warn' },
      screened_out: { text: 'AI Ruled Out', cls: 'warn' },
      screened_in: { text: 'Awaiting review', cls: 'queued' },
      unassessed: { text: 'Not filtered yet', cls: 'queued' },
      interested: { text: 'Interested', cls: 'strong' },
      applied: { text: 'Applied', cls: 'strong' },
    };
    var matchThreshold = 70;
    var jobsView = 'search';

    function hasCompletedFitScore(job) {
      var score = Number(job.fit_score);
      return Boolean(job.assessed_at) && job.fit_score !== null && job.fit_score !== undefined &&
        Number.isFinite(score) && score >= 0 && score <= 100;
    }

    // The underlying AI category remains independent from later manual actions. Search analytics
    // use this even after a job moves to Interested or Removed, and Re-add can reveal it again
    // without rerunning AI. Changing the threshold only re-partitions saved scores.
    function pipelineJobCategory(job) {
      if (hasCompletedFitScore(job) && job.fit_status === 'reject') return 'fit_fail';
      if (!hasCompletedFitScore(job) && job.fit_status === 'screened_out') return 'screen_fail';
      if (!hasCompletedFitScore(job)) return 'unrated';
      return Number(job.fit_score) >= matchThreshold ? 'good_match' : 'bad_match';
    }

    // On the Jobs page, an explicit human choice wins tab membership. The saved score and AI
    // pipeline state remain untouched underneath this view-level category.
    function jobCategory(job) {
      if (job.applied_at) return 'applied';
      if (job.manual_status === 'interested') return 'interested';
      if (job.manual_status === 'removed') return 'removed';
      return pipelineJobCategory(job);
    }

    async function submitJobFit(jobId, action, reason, reload) {
      var res = await api('/jobs/' + encodeURIComponent(jobId) + '/fit', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action, reason: reason || '' }),
      });
      if (!res.ok) throw new Error(await errorMessageFromResponse(res, 'Could not update this job.'));
      var data = await res.json();
      if (reload !== false) await loadJobs();
      return data;
    }

    // Shared title/badge/meta/facts/reason/missing block for Recommended, Not Recommended, Unrated,
    // AI Ruled Out, and manually removed cards.
    // A quick-screen rejection gets an explicit AI Ruled Out badge; other postings without a
    // completed score remain Unrated.
    function buildJobCardBody(job) {
      var fitInfo = FIT_LABELS[job.fit_status] || FIT_LABELS.unassessed;
      var hasScore = hasCompletedFitScore(job);
      var isRuledOut = !hasScore && job.fit_status === 'screened_out';
      var badgeText = hasScore ? job.fit_score + '% match' : (isRuledOut ? 'AI Ruled Out' : 'Unrated');
      var badgeCls = hasScore ? fitInfo.cls : (isRuledOut ? 'warn' : 'queued');
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
      var titleLine = [titleNode, el('span', { className: ('badge ' + badgeCls).trim(), textContent: badgeText })];

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
      return body;
    }

    // Recommended/Not Recommended: compact, immediate, no-confirmation actions to the right of the card --
    // Interested (green) then Remove (red). Neither touches fit_score/fit_status; see setJobFit.
    function renderMatchCards(list, jobs) {
      jobs.forEach(function (job) {
        var body = buildJobCardBody(job);
        var interested = el('button', { className: 'success', type: 'button', textContent: 'Interested' });
        interested.addEventListener('click', function () { submitJobFit(job.id, 'interested'); });
        var remove = el('button', { className: 'danger', type: 'button', textContent: 'Remove' });
        remove.addEventListener('click', function () { submitJobFit(job.id, 'removed'); });

        list.appendChild(el('div', { className: 'row-item' }, [
          el('div', { className: 'row' }, [
            el('div', {}, body),
            el('div', { className: 'row-actions' }, [interested, remove]),
          ]),
        ]));
      });
    }

    // Removed: Re-add restores the job to wherever its untouched rating (or its prior Interested
    // status) says it belongs. A submitted reason becomes a visibly locked, durable profile signal
    // until the candidate deliberately chooses Edit reason.
    function renderRemovedCards(list, jobs) {
      jobs.forEach(function (job) {
        var body = buildJobCardBody(job);

        var readd = el('button', { className: 'success', type: 'button', textContent: 'Re-add' });
        readd.addEventListener('click', function () { submitJobFit(job.id, 'readd'); });

        var reasonInput = el('input', {
          type: 'text', placeholder: 'Reason', value: job.removal_reason || '',
          style: 'width:auto; flex:1; min-width:10rem; margin-top:0',
        });
        var submitReason = el('button', { className: 'secondary', type: 'button', textContent: 'Save reason' });
        var reasonStatus = el('div', { className: 'status', role: 'status', 'aria-live': 'polite' });
        var reasonActions = el('div', { className: 'row-actions', style: 'margin-top:0.5rem' }, [reasonInput, submitReason]);

        function showSaved(reason) {
          reasonInput.value = reason;
          reasonInput.disabled = true;
          submitReason.disabled = false;
          submitReason.textContent = 'Edit reason';
          reasonStatus.className = 'status success';
          reasonStatus.textContent = reason
            ? 'Saved to your profile: “' + reason + '”'
            : 'Reason cleared from your profile.';
        }
        if (job.removal_reason) showSaved(job.removal_reason);

        submitReason.addEventListener('click', async function () {
          if (reasonInput.disabled) {
            reasonInput.disabled = false;
            submitReason.textContent = 'Save reason';
            reasonStatus.textContent = '';
            reasonInput.focus();
            return;
          }
          submitReason.disabled = true;
          submitReason.textContent = 'Saving…';
          reasonStatus.className = 'status';
          reasonStatus.textContent = 'Saving to your profile…';
          try {
            var result = await submitJobFit(job.id, 'set_removal_reason', reasonInput.value, false);
            job.removal_reason = result.removal_reason || '';
            showSaved(job.removal_reason);
          } catch (err) {
            submitReason.disabled = false;
            submitReason.textContent = 'Save reason';
            reasonStatus.className = 'status error';
            reasonStatus.textContent = err instanceof Error ? err.message : 'Could not save this reason.';
          }
        });

        list.appendChild(el('div', { className: 'row-item' }, [
          el('div', { className: 'row' }, [
            el('div', {}, body),
            el('div', { className: 'row-actions' }, [readd]),
          ]),
          reasonActions,
          reasonStatus,
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
      if (!minScore || !hasCompletedFitScore(job)) return true;
      return Number(job.fit_score) >= minScore;
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

    var JOB_COUNT_VIEWS = ['good_match', 'bad_match', 'removed', 'fit_fail', 'interested', 'applied'];

    function renderJobs() {
      var needle = document.getElementById('jobs-filter').value.trim();
      var maxAgeDays = Number(document.getElementById('jobs-age').value) || 0;
      var minScore = Number(document.getElementById('jobs-min-score').value) || 0;
      var list = document.getElementById('jobs-list');

      // Shared across all six result subtabs, same as Companies' text filter -- changing the
      // filter controls applies within whichever result subtab is currently active.
      // filter implementations.
      var filtered = allJobs.filter(function (job) {
        return matchesFilter([job.title, job.company, job.location].join(' '), needle)
          && withinAge(job, maxAgeDays)
          && withinScore(job, minScore);
      });

      // Counts reflect the full, unfiltered set -- same convention Companies' segmented-control
      // counts use -- so the badges don't shift just because the search box has something in it.
      var counts = {
        good_match: 0, bad_match: 0, removed: 0, fit_fail: 0, interested: 0, applied: 0,
        // These remain real pipeline states, but the simplified Jobs tabs intentionally omit them.
        unrated: 0, screen_fail: 0,
      };
      allJobs.forEach(function (job) {
        var category = jobCategory(job);
        counts[category] += 1;
      });
      JOB_COUNT_VIEWS.forEach(function (view) {
        document.getElementById('jobs-' + view + '-count').textContent = '(' + counts[view] + ')';
      });

      var showingSearch = jobsView === 'search';
      var showingInterested = jobsView === 'interested';
      var showingApplied = jobsView === 'applied';
      document.getElementById('jobs-find-section').style.display = showingSearch ? 'block' : 'none';
      document.getElementById('jobs-section').style.display = showingSearch || showingApplied ? 'none' : 'block';
      document.getElementById('applied-section').style.display = showingApplied ? 'block' : 'none';
      document.getElementById('jobs-interested-section').style.display = showingInterested ? 'block' : 'none';
      document.getElementById('interested-list-section').style.display = 'block';
      list.style.display = showingSearch || showingInterested || showingApplied ? 'none' : 'block';

      if (showingSearch) {
        pfWake();
        return;
      }

      if (showingInterested) {
        renderInterestedList(filtered);
        return;
      }

      if (showingApplied) {
        renderAppliedList();
        return;
      }

      list.innerHTML = '';
      var bucket = filtered.filter(function (job) { return jobCategory(job) === jobsView; });
      if (jobsView === 'removed') {
        bucket.sort(function (a, b) { return new Date(b.removed_at || 0) - new Date(a.removed_at || 0); });
      } else {
        bucket.sort(jobSortComparator(document.getElementById('jobs-sort').value));
      }

      if (!bucket.length) {
        list.appendChild(el('p', {
          className: 'empty',
          textContent: allJobs.length ? 'No postings match that filter.' : 'No job postings yet — add target companies and scan their boards.',
        }));
        return;
      }

      if (jobsView === 'removed') renderRemovedCards(list, bucket);
      else bucket.forEach(function (job) {
        if (job.manual_status === 'removed') renderRemovedCards(list, [job]);
        else renderMatchCards(list, [job]);
      });
    }

    document.getElementById('jobs-filter').addEventListener('input', renderJobs);
    document.getElementById('jobs-age').addEventListener('change', renderJobs);
    document.getElementById('jobs-min-score').addEventListener('change', renderJobs);
    document.getElementById('jobs-sort').addEventListener('change', renderJobs);

    document.querySelectorAll('[data-jobs-view]').forEach(function (button) {
      button.addEventListener('click', function () {
        jobsView = button.dataset.jobsView;
        document.querySelectorAll('[data-jobs-view]').forEach(function (item) {
          item.classList.remove('active');
          item.setAttribute('aria-pressed', 'false');
        });
        button.classList.add('active');
        button.setAttribute('aria-pressed', 'true');
        renderJobs();
      });
    });

    // Buckets update immediately on every keystroke/spinner click; the PATCH that persists the
    // value is debounced a moment behind so typing a two-digit number doesn't fire one request per
    // digit.
    var jobsMatchThresholdSaveTimer = null;
    document.getElementById('jobs-match-threshold').addEventListener('input', function () {
      var value = Number(this.value);
      if (!Number.isFinite(value)) return;
      value = Math.min(Math.max(Math.round(value), 0), 100);
      matchThreshold = value;
      renderJobs();
      syncPipelineFitCountsFromJobs();

      clearTimeout(jobsMatchThresholdSaveTimer);
      jobsMatchThresholdSaveTimer = setTimeout(function () {
        api('/jobs/match-threshold', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ match_threshold: value }),
        }).catch(function (err) {
          var statusEl = document.getElementById('jobs-match-threshold-status');
          statusEl.textContent = 'Error saving threshold: ' + err.message;
          statusEl.className = 'status error';
        });
      }, 400);
    });

    // Find Jobs: one action, the whole pipeline -- scan every company's board (regardless of when
    // it was last read), then screen and score whatever's new (plus anything still queued from a
    // previous run), sharing one status line and feeding the same live pipeline diagram throughout.
    document.getElementById('jobs-find-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('jobs-find-status');
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Reading job boards…';
      statusEl.className = 'status';
      pfBeginRun();
      try {
        // Stage 1: scan boards. One request only gets through as many companies as safely fit in
        // one call, so it re-fires on your behalf until every company's been reached this run --
        // capped so a real server problem can't spin forever.
        var totalCompaniesScanned = 0, totalNewListings = 0;
        var scanRound = 0;
        var scanData;
        do {
          scanRound += 1;
          var scanRes = await api('/companies/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ limit: 500 }),
          });
          if (!scanRes.ok) throw new Error(errorMessage(await scanRes.json(), 'scan_failed'));
          scanData = await readNdjson(scanRes, function (event) {
            statusEl.textContent =
              (scanRound > 1 ? 'Round ' + scanRound + ': ' : '') +
              'Reading job boards… ' + event.done + ' of ' + event.total + ' compan' + (event.total === 1 ? 'y' : 'ies') +
              ' (' + event.company + (event.new_jobs ? ', ' + event.new_jobs + ' new' : '') + ')';
            // New listings land as unassessed the moment they're inserted -- grow the pipeline
            // diagram live as each company's board read completes, not only once scanning is done.
            pfBumpScanned(event.new_jobs);
            if (event.new_jobs) queueLiveJobsRefresh();
          });
          totalCompaniesScanned += scanData.scanned;
          totalNewListings += scanData.new_listings;
        } while (scanData.scanned > 0 && totalCompaniesScanned < scanData.eligible_total && scanRound < 25);

        // Stage 2: screen + score. Same re-firing pattern, now against whatever the scan just
        // added plus anything still queued from before.
        statusEl.textContent = 'Screening listings, then assessing the ones worth a closer look…';
        var totalScreened = 0, totalScreenedOut = 0, totalAssessed = 0, totalRecommended = 0, allErrors = [];
        var round = 0;
        var data;
        do {
          round += 1;
          // Assessment progress reports a cumulative recommendation count for this request.
          // Keep the latest value, then add it once when the round finishes so retries and
          // multiple batches do not double-count the same newly recommended postings.
          var roundRecommended = 0;
          var res = await api('/jobs/process', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: document.getElementById('jobs-provider').value }),
          });
          if (!res.ok) throw new Error(await errorMessageFromResponse(res, 'process_failed'));
          data = await readNdjson(res, function (event) {
            if (event.type === 'pipeline') {
              pfApplyPipelineEvent(event);
              if (event.stage === 'assess' && event.phase === 'resolved') queueLiveJobsRefresh();
              return;
            }
            if (event.stage === 'assess') roundRecommended = event.recommended || 0;
            statusEl.textContent = (round > 1 ? 'Round ' + round + ': ' : '') + (event.stage === 'screen'
              ? 'Screening: '
              : 'Scoring: ') + event.done + ' of ' + event.total +
              (event.stage === 'assess' ? ' · ' + roundRecommended + ' newly recommended' : '');
          });
          totalScreened += data.screened || 0;
          totalScreenedOut += data.screened_out || 0;
          totalAssessed += data.assessed || 0;
          totalRecommended += roundRecommended;
          if ((data.errors || []).length) allErrors.push.apply(allErrors, data.errors);
        } while (
          !allErrors.length && round < 25 &&
          ((data.counts || {}).unassessed > 0 || (data.counts || {}).screened_in > 0) &&
          (data.screened || data.assessed)
        );

        var counts = data.counts || {};
        var left = (counts.unassessed || 0) + (counts.screened_in || 0);
        var parts = [];
        parts.push('Scanned ' + totalCompaniesScanned + ' compan' + (totalCompaniesScanned === 1 ? 'y' : 'ies') +
          ', found ' + totalNewListings + ' new listing' + (totalNewListings === 1 ? '' : 's') + '.');
        if (totalScreened) parts.push('Screened ' + totalScreened + ', dropped ' + totalScreenedOut + ' as clear misses.');
        if (totalAssessed) parts.push('Assessed ' + totalAssessed + ' in detail; ' + totalRecommended + ' newly recommended.');
        // Only reachable if the loop stopped without actually clearing the backlog: a real error,
        // the round cap, or a round that made no progress at all -- genuinely worth a click to retry.
        parts.push(left ? left + ' still queued — click Find Jobs again to continue.' : 'All caught up.');
        if (allErrors.length) parts.push('Some batches failed: ' + allErrors.join('; '));
        statusEl.textContent = parts.join(' ');
        statusEl.className = allErrors.length ? 'status error' : 'status success';
        await pfWaitForIdle();
        await loadCompanies();
        await loadJobs();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      } finally {
        button.disabled = false;
      }
    });

    // ---- Pipeline flow diagram engine (shared by Jobs -> Search and Companies -> Search) -------
    // A live liquid pipeline. Waiting work is always upstream of the gate that will process it;
    // only completed decisions flow downstream. Extracted into a factory so both tabs' diagrams
    // share one animation/layout/rendering engine rather than maintaining two copies of the same
    // ~500 lines of Sankey-ribbon math and particle physics -- each tab keeps its own small glue
    // layer (translating its own backend's counts/events into the generic shape below), but the
    // engine itself (layoutColumns, edge slicing, node/reservoir/particle rendering, the smooth
    // height-interpolation loop) knows nothing about postings or companies.
    //
    // cfg: { svgId, nodes: [{id,label,stage,kind}], branches: {sourceId:[targetId,...]},
    //        stageTitles: [string,...], kindColor?, vbW?, vbH?, sourceHeight?, colStep? }
    // Returns: { setCounts(nodeCounts, opts), burst(key, delta, reverse?, addCount?, releaseGate?),
    //            burstIntoGate(nodeId, count), waitForIdle(), wake() }
    function createPipelineFlow(cfg) {
      var NODES = cfg.nodes;
      var BRANCHES = cfg.branches;
      var STAGE_TITLES = cfg.stageTitles;
      var KIND_COLOR = cfg.kindColor || { queue: 'var(--warning)', gate: 'var(--accent)', reject: 'var(--error)', success: 'var(--success)' };

      var VB_W = cfg.vbW || 1320, VB_H = cfg.vbH || 340;
      var MARGIN_TOP = 26, MARGIN_BOTTOM = 8;
      var USABLE_H = VB_H - MARGIN_TOP - MARGIN_BOTTOM;
      var NODE_W = 10;
      var MIN_H = 12;
      var ROW_GAP = 26; // generous on purpose: each node's 2-line label needs real clearance from its neighbors, not just its own (possibly tiny) bar height
      var SOURCE_HEIGHT = cfg.sourceHeight || 200;
      var COL_MARGIN = 66;
      var COL_STEP = cfg.colStep || 550;
      var SMOOTH_RATE = 6;

      var nodeMap = {};
      NODES.forEach(function (n) {
        nodeMap[n.id] = n;
        n.x = COL_MARGIN + n.stage * COL_STEP;
        n.width = NODE_W;
        n.dispHeight = MIN_H;
        n.y = MARGIN_TOP; n.cy = MARGIN_TOP;
      });
      var stageGroups = STAGE_TITLES.map(function () { return []; });
      NODES.forEach(function (n) {
        if (!stageGroups[n.stage]) stageGroups[n.stage] = [];
        stageGroups[n.stage].push(n.id);
      });

      var edges = {};
      var childEdges = {}; var parentEdges = {};
      NODES.forEach(function (n) { childEdges[n.id] = []; parentEdges[n.id] = []; });
      Object.keys(BRANCHES).forEach(function (source) {
        BRANCHES[source].forEach(function (target) {
          var edge = { source: source, target: target, committed: 0, sy0: 0, sy1: 0, ty0: 0, ty1: 0 };
          edges[source + '->' + target] = edge;
          childEdges[source].push(edge);
          parentEdges[target].push(edge);
        });
      });

      var sourceTotal = 0;
      var nodeCounts = {};
      var isFirstCall = true;
      var animating = false;
      var lastFrame = 0;
      var reservoirCounts = {};
      var reservoirDisplay = {};

      function derivedTotal(nodeId) {
        return nodeCounts[nodeId] || 0;
      }
      function targetHeight(n) {
        return Math.max(MIN_H, (derivedTotal(n.id) / Math.max(1, sourceTotal)) * SOURCE_HEIGHT);
      }

      function layoutColumns() {
        stageGroups.forEach(function (ids) {
          var totalH = 0;
          ids.forEach(function (id) { totalH += nodeMap[id].dispHeight; });
          totalH += ROW_GAP * (ids.length - 1);
          var y = MARGIN_TOP + (USABLE_H - totalH) / 2;
          ids.forEach(function (id) {
            var n = nodeMap[id];
            n.y = y; n.cy = y + n.dispHeight / 2;
            y += n.dispHeight + ROW_GAP;
          });
        });
      }
      function edgeWeight(edge) {
        // Every declared transition is a permanent channel. A value of one is only the visual
        // floor; labels and statistics continue to show the truthful zero count.
        return Math.max(1, edge.committed);
      }
      function recomputeEdgeSlices() {
        NODES.forEach(function (n) {
          var outs = childEdges[n.id].slice().sort(function (a, b) { return nodeMap[a.target].cy - nodeMap[b.target].cy; });
          var outDenom = 0; outs.forEach(function (e) { outDenom += edgeWeight(e); }); outDenom = Math.max(1, outDenom);
          var cum = 0;
          outs.forEach(function (e) {
            var h = (edgeWeight(e) / outDenom) * n.dispHeight;
            e.sy0 = n.y + cum; e.sy1 = e.sy0 + h; cum += h;
          });
          var ins = parentEdges[n.id].slice().sort(function (a, b) { return nodeMap[a.source].cy - nodeMap[b.source].cy; });
          var inDenom = 0; ins.forEach(function (e) { inDenom += edgeWeight(e); }); inDenom = Math.max(1, inDenom);
          cum = 0;
          ins.forEach(function (e) {
            var h = (edgeWeight(e) / inDenom) * n.dispHeight;
            e.ty0 = n.y + cum; e.ty1 = e.ty0 + h; cum += h;
          });
        });
      }

      var SVG_NS = 'http://www.w3.org/2000/svg';
      function svgEl(tag, attrs) {
        var e = document.createElementNS(SVG_NS, tag);
        for (var k in attrs) e.setAttribute(k, attrs[k]);
        return e;
      }

      var svg = document.getElementById(cfg.svgId);
      svg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
      STAGE_TITLES.forEach(function (title, i) {
        var t = svgEl('text', { x: COL_MARGIN + i * COL_STEP + NODE_W / 2, y: MARGIN_TOP - 12, 'text-anchor': 'middle', class: 'pf-stage-title' });
        t.textContent = title;
        svg.appendChild(t);
      });

      var flowLayer = svgEl('g', {});
      svg.appendChild(flowLayer);
      var pathByKey = {};
      Object.keys(edges).forEach(function (key) {
        var path = svgEl('path', { class: 'pf-link', d: '' });
        flowLayer.appendChild(path);
        pathByKey[key] = path;
      });

      // Pools sit above ribbons but below labels/nodes. Their right edge is fixed to the receiving
      // wall; added volume expands leftward, making each impact visibly accumulate instead of
      // simply vanishing at the destination.
      var reservoirLayer = svgEl('g', {});
      svg.appendChild(reservoirLayer);
      var reservoirByNode = {};
      NODES.forEach(function (node) {
        var pool = svgEl('rect', {
          class: 'pf-reservoir' + (node.kind === 'queue' || node.kind === 'gate' ? ' pf-reservoir-queue' : ''), x: node.x, y: node.y, width: 0, height: node.dispHeight,
          rx: 2, fill: KIND_COLOR[node.kind], 'fill-opacity': 0.72,
        });
        reservoirLayer.appendChild(pool);
        reservoirByNode[node.id] = pool;
      });

      var BURST_MAX = cfg.burstMax || 60;
      var BURST_STAGGER = 30; // milliseconds between releases, so droplets visibly peel away
      var GRAVITY_X = 620; // SVG units / second²: zero-speed release, then acceleration right
      var POOL_MAX_W = 46;
      var particles = [];
      var splashes = [];
      var particleAnimating = false;
      var idleWaiters = [];

      function deposit(nodeId, amount, addCount) {
        if (addCount) nodeCounts[nodeId] = (nodeCounts[nodeId] || 0) + amount;
        reservoirCounts[nodeId] = Math.min(derivedTotal(nodeId), (reservoirCounts[nodeId] || 0) + amount);
        wake();
      }

      function waitForIdle() {
        if (!particleAnimating) return Promise.resolve();
        return new Promise(function (resolve) { idleWaiters.push(resolve); });
      }

      function burstIntoGate(nodeId, count) {
        var gate = nodeMap[nodeId];
        var n = Math.max(1, Math.min(BURST_MAX, Math.round(count)));
        var now = performance.now();
        var x1 = gate.x, x0 = gate.x - POOL_MAX_W - 8;
        for (var i = 0; i < n; i++) {
          var y = gate.y + Math.random() * gate.dispHeight;
          var dot = svgEl('circle', { r: 2.8, class: 'pf-dot', fill: KIND_COLOR.gate, cx: x0, cy: y });
          flowLayer.appendChild(dot);
          particles.push({
            el: dot, target: nodeId, color: KIND_COLOR.gate, volume: count / n,
            addCount: false, releaseGate: null, noDeposit: true,
            x0: x0, x1: x1, dx: x1 - x0, y0: y, y1: y,
            distance: Math.max(1, x1 - x0), drift: (Math.random() - 0.5) * 5,
            start: now + i * BURST_STAGGER,
          });
        }
        if (!particleAnimating) { particleAnimating = true; requestAnimationFrame(particleFrame); }
      }

      function splashAt(x, y, color, now) {
        for (var j = 0; j < 3; j++) {
          var circle = svgEl('circle', { r: 1.5, class: 'pf-splash', fill: color });
          flowLayer.appendChild(circle);
          splashes.push({
            el: circle, x: x, y: y, vx: -18 - Math.random() * 34,
            vy: (j - 1) * 28 + (Math.random() - 0.5) * 10, born: now, life: 310,
          });
        }
      }

      function particleFrame(now) {
        for (var i = particles.length - 1; i >= 0; i--) {
          var p = particles[i];
          if (now < p.start) continue;
          var elapsed = (now - p.start) / 1000;
          var progress = Math.min(1, (0.5 * GRAVITY_X * elapsed * elapsed) / p.distance);
          var easedY = progress * progress * (3 - 2 * progress);
          p.el.setAttribute('cx', p.x0 + p.dx * progress);
          p.el.setAttribute('cy', p.y0 + (p.y1 - p.y0) * easedY + Math.sin(progress * Math.PI) * p.drift);
          if (progress >= 1) {
            p.el.remove();
            particles.splice(i, 1);
            if (p.releaseGate) nodeCounts[p.releaseGate] = Math.max(0, (nodeCounts[p.releaseGate] || 0) - p.volume);
            if (!p.noDeposit) deposit(p.target, p.volume, p.addCount);
            splashAt(p.x1, p.y1, p.color, now);
          }
        }
        for (var s = splashes.length - 1; s >= 0; s--) {
          var sp = splashes[s];
          var age = now - sp.born;
          if (age >= sp.life) {
            sp.el.remove(); splashes.splice(s, 1); continue;
          }
          var seconds = age / 1000;
          sp.el.setAttribute('cx', sp.x + sp.vx * seconds);
          sp.el.setAttribute('cy', sp.y + sp.vy * seconds);
          sp.el.setAttribute('fill-opacity', String(1 - age / sp.life));
        }
        if (particles.length || splashes.length) requestAnimationFrame(particleFrame);
        else {
          particleAnimating = false;
          while (idleWaiters.length) idleWaiters.shift()();
        }
      }

      // Fires once per real increase, driven explicitly by the caller (never on a timer or a
      // loop): a handful of dots -- proportional to, capped at a readable count of, exactly how
      // much this specific edge just grew by -- ride their OWN random path across the current
      // ribbon band (computed fresh from the edge's live sy0/sy1/ty0/ty1, so a burst mid-transition
      // still starts and ends on the ribbon as it actually is right now). Each begins at rest and
      // accelerates horizontally, then deposits its share of the real delta into the destination
      // pool and makes a tiny splash.
      function burst(key, delta, reverse, addCount, releaseGate) {
        var e = edges[key];
        if (!e) return;
        var source = nodeMap[e.source], target = nodeMap[e.target];
        if (reverse) { var swap = source; source = target; target = swap; }
        var x0 = reverse ? source.x : source.x + source.width;
        var x1 = reverse ? target.x + target.width : target.x;
        var n = Math.max(1, Math.min(BURST_MAX, Math.round(delta)));
        var color = KIND_COLOR[target.kind] || 'var(--text-muted)';
        var now = performance.now();
        for (var i = 0; i < n; i++) {
          // One random vertical fraction per dot, reused at both ends, so each dot cuts its own
          // straight-ish diagonal through the band instead of every dot sharing one centerline.
          var frac = Math.random();
          var y0 = (reverse ? e.ty0 : e.sy0) + frac * ((reverse ? e.ty1 : e.sy1) - (reverse ? e.ty0 : e.sy0));
          var y1 = (reverse ? e.sy0 : e.ty0) + frac * ((reverse ? e.sy1 : e.ty1) - (reverse ? e.sy0 : e.ty0));
          var dot = svgEl('circle', { r: 2.8, class: 'pf-dot', fill: color, cx: x0, cy: y0 });
          flowLayer.appendChild(dot);
          particles.push({
            el: dot, target: target.id, color: color, volume: delta / n,
            addCount: Boolean(addCount), releaseGate: releaseGate || null,
            x0: x0, x1: x1, dx: x1 - x0, y0: y0, y1: y1, distance: Math.max(1, Math.abs(x1 - x0)),
            drift: (Math.random() - 0.5) * 9,
            start: now + i * BURST_STAGGER + Math.random() * BURST_STAGGER * 0.35,
          });
        }
        if (!particleAnimating) { particleAnimating = true; requestAnimationFrame(particleFrame); }
      }

      var nodeLayer = svgEl('g', {});
      svg.appendChild(nodeLayer);
      var nodeVisuals = {};
      NODES.forEach(function (n) {
        var rect = svgEl('rect', { class: 'pf-node-rect' + (n.kind === 'gate' ? ' pf-node-gate' : ''), x: n.x, y: n.y, width: n.width, height: n.dispHeight, rx: 2, fill: n.kind === 'gate' ? 'var(--accent-soft)' : 'var(--surface-2)', stroke: KIND_COLOR[n.kind] });
        var tx = n.x + n.width + 8;
        // A label can end up sitting inside a wide ribbon, dead center of the diagram, with
        // stacked ribbons passing directly behind it -- a halo behind the text keeps it legible
        // regardless of what color is behind it, rather than hoping every ribbon stays out of the way.
        var halo = svgEl('rect', { class: 'pf-label-halo', x: tx - 4, y: n.cy - 14, width: 90, height: 30, rx: 3, fill: 'var(--surface)', 'fill-opacity': 0.85 });
        var label = svgEl('text', { x: tx, y: n.cy - 2, class: 'pf-node-label' });
        label.textContent = n.label;
        var meta = svgEl('text', { x: tx, y: n.cy + 12, class: 'pf-node-count', fill: KIND_COLOR[n.kind] });
        meta.textContent = '0';
        nodeLayer.appendChild(halo); nodeLayer.appendChild(rect); nodeLayer.appendChild(label); nodeLayer.appendChild(meta);
        nodeVisuals[n.id] = { rect: rect, halo: halo, label: label, meta: meta };
      });

      function render() {
        NODES.forEach(function (n) {
          var v = nodeVisuals[n.id];
          v.rect.setAttribute('y', n.y);
          v.rect.setAttribute('height', n.dispHeight);
          v.halo.setAttribute('y', n.cy - 14);
          v.label.setAttribute('y', n.cy - 2);
          v.meta.setAttribute('y', n.cy + 12);
          var total = Math.round(derivedTotal(n.id));
          var pct = sourceTotal ? (100 * total / sourceTotal).toFixed(1) + '%' : '0%';
          v.meta.textContent = total + ' · ' + pct;
          var pool = reservoirByNode[n.id];
          if (pool) {
            var poolCount = Math.min(total, reservoirDisplay[n.id] || 0);
            var poolWidth = POOL_MAX_W * (poolCount / Math.max(1, sourceTotal));
            pool.setAttribute('x', n.x - poolWidth);
            pool.setAttribute('y', n.y);
            pool.setAttribute('width', poolWidth);
            pool.setAttribute('height', n.dispHeight);
          }
        });
        Object.keys(edges).forEach(function (key) {
          var e = edges[key];
          var s = nodeMap[e.source], t = nodeMap[e.target];
          var x0 = s.x + s.width, x1 = t.x, midX = (x0 + x1) / 2;
          var d = 'M' + x0 + ',' + e.sy0 + ' C' + midX + ',' + e.sy0 + ' ' + midX + ',' + e.ty0 + ' ' + x1 + ',' + e.ty0 +
            ' L' + x1 + ',' + e.ty1 + ' C' + midX + ',' + e.ty1 + ' ' + midX + ',' + e.sy1 + ' ' + x0 + ',' + e.sy1 + ' Z';
          pathByKey[key].setAttribute('d', d);
          var edgeColor = KIND_COLOR[t.kind] || 'var(--text-muted)';
          var empty = e.committed <= 0;
          pathByKey[key].setAttribute('fill', edgeColor);
          pathByKey[key].setAttribute('fill-opacity', empty ? 0.16 : 0.4);
          pathByKey[key].setAttribute('stroke', edgeColor);
          pathByKey[key].setAttribute('stroke-opacity', empty ? 0.5 : 0);
          pathByKey[key].setAttribute('stroke-width', empty ? 1.25 : 0);
        });
      }

      function frame(now) {
        var dt = Math.min(0.1, (now - lastFrame) / 1000);
        lastFrame = now;
        var settled = true;
        NODES.forEach(function (n) {
          var target = targetHeight(n);
          if (Math.abs(target - n.dispHeight) > 0.3) settled = false;
          var alpha = 1 - Math.exp(-dt * SMOOTH_RATE);
          n.dispHeight += (target - n.dispHeight) * alpha;
        });
        Object.keys(reservoirByNode).forEach(function (nodeId) {
          var target = reservoirCounts[nodeId] || 0;
          var shown = reservoirDisplay[nodeId] || 0;
          if (Math.abs(target - shown) > 0.03) settled = false;
          reservoirDisplay[nodeId] = shown + (target - shown) * (1 - Math.exp(-dt * 9));
        });
        layoutColumns();
        recomputeEdgeSlices();
        render();
        if (settled) { animating = false; return; }
        requestAnimationFrame(frame);
      }
      function wake() {
        if (animating) return;
        animating = true;
        lastFrame = performance.now();
        requestAnimationFrame(frame);
      }

      // The one full-reconciliation entry point: caller hands over the current absolute count for
      // every node ('counts'), optionally a 'total' (the denominator percentages/bar heights are
      // computed against -- not always just the sum of stage-0 nodes, e.g. Jobs' total includes
      // postings that have already moved past the gate) and 'edgeOverrides' for any edge whose
      // real committed volume isn't simply "the target node's own count" (an accumulator node like
      // Jobs' review_queue, which also feeds further stages, needs the sum of everything that
      // passed through it, not just what's currently sitting there). Never bursts on its own --
      // reconciliation resizes bars/pools smoothly; a caller wanting a droplet burst calls burst()/
      // burstIntoGate() explicitly with the real delta it just learned about, same as before this
      // was a shared engine.
      function setCounts(counts, opts) {
        opts = opts || {};
        nodeCounts = counts;
        sourceTotal = opts.total !== undefined ? opts.total : stageGroups[0].reduce(function (sum, id) { return sum + (counts[id] || 0); }, 0);

        NODES.forEach(function (node) {
          var actual = derivedTotal(node.id);
          if (isFirstCall || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            reservoirCounts[node.id] = actual;
            reservoirDisplay[node.id] = actual;
          } else if ((reservoirCounts[node.id] || 0) > actual) {
            reservoirCounts[node.id] = actual;
          }
        });

        Object.keys(edges).forEach(function (key) {
          var e = edges[key];
          e.committed = (opts.edgeOverrides && opts.edgeOverrides[key] !== undefined) ? opts.edgeOverrides[key] : (counts[e.target] || 0);
        });

        isFirstCall = false;
        wake();
      }

      return { setCounts: setCounts, burst: burst, burstIntoGate: burstIntoGate, waitForIdle: waitForIdle, wake: wake };
    }

    // ---- Jobs -> Search: Pre-Screen -> Screen -> Fit -------------------------------------------
    // Human actions aren't shown -- this diagram ends with the AI pipeline's Fit outcomes. Manual
    // state never changes which path a posting took through the screening and fit stages.
    var PF_NODES = [
      { id: 'screen_gate', label: 'Pre-Screen', stage: 0, kind: 'gate' },
      { id: 'screen_rejected', label: 'Fail', stage: 1, kind: 'reject' },
      { id: 'review_queue', label: 'Pass', stage: 1, kind: 'queue' },
      // Fit Fail is the deep assessment's existing hard-reject verdict. Good and Bad are the
      // remaining completed scores split by the user's current Fit Threshold.
      { id: 'fit_failed', label: 'Fail', stage: 2, kind: 'reject' },
      { id: 'fit_recommended', label: 'Good', stage: 2, kind: 'success' },
      { id: 'fit_rejected', label: 'Bad', stage: 2, kind: 'reject' },
    ];
    var PF_BRANCHES = {
      screen_gate: ['screen_rejected', 'review_queue'],
      review_queue: ['fit_failed', 'fit_recommended', 'fit_rejected'],
    };
    var PF_STAGE_TITLES = ['Pre-Screen', 'Screen', 'Fit'];
    var jobsFlow = createPipelineFlow({ svgId: 'pf-svg', nodes: PF_NODES, branches: PF_BRANCHES, stageTitles: PF_STAGE_TITLES, vbW: 1320, vbH: 340, sourceHeight: 200, colStep: 550 });

    var pfSourceTotal = 0;
    var pfNodeCounts = {};
    var pfScreenWaiting = 0;
    var pfScreenProcessing = 0;
    var pfFitProcessing = 0;
    var pfLastCountsPayload = null;

    // Recomputes the generic engine's node-count snapshot from Jobs' own bookkeeping above and
    // pushes it through setCounts(). review_queue needs an edge override: it's an accumulator
    // (also feeds Fit), so the volume that "passed screening" is everything still downstream of
    // it, not just its own currently-waiting count.
    function pfRefresh() {
      var nodeCounts = {
        screen_gate: pfScreenWaiting + pfScreenProcessing,
        screen_rejected: pfNodeCounts.screen_rejected || 0,
        review_queue: pfNodeCounts.review_queue || 0,
        fit_failed: pfNodeCounts.fit_failed || 0,
        fit_rejected: pfNodeCounts.fit_rejected || 0,
        fit_recommended: pfNodeCounts.fit_recommended || 0,
      };
      var accepted = nodeCounts.review_queue + nodeCounts.fit_failed + nodeCounts.fit_rejected + nodeCounts.fit_recommended;
      jobsFlow.setCounts(nodeCounts, { total: pfSourceTotal, edgeOverrides: { 'screen_gate->review_queue': accepted } });
    }
    function pfWake() { jobsFlow.wake(); }
    function pfWaitForIdle() { return jobsFlow.waitForIdle(); }

    // Sankey-only interpretation of the existing rows. This deliberately does not call
    // jobCategory(): manual Interested/Removed choices and the Jobs tabs must not rewrite the AI
    // path. Likewise, Fit Fail uses the already-stored deep-model reject verdict, while the two
    // other completed-fit buckets use the adjustable threshold over their existing saved scores.
    function pfBucketsFromJobs(counts) {
      var buckets = {
        unassessed: 0,
        screenFailed: 0,
        screenPassed: 0,
        fitFailed: 0,
        recommended: 0,
        notRecommended: 0,
      };
      if (!allJobs.length && (counts.total || 0) > 0) {
        buckets.unassessed = counts.unassessed || 0;
        buckets.screenFailed = counts.screened_out || counts.ruled_out || 0;
        buckets.screenPassed = counts.screened_in || 0;
        buckets.fitFailed = counts.reject || 0;
        buckets.recommended = counts.good_fit || 0;
        buckets.notRecommended = Math.max(0, (counts.bad_fit || 0) - buckets.fitFailed);
        return buckets;
      }
      allJobs.forEach(function (job) {
        if (hasCompletedFitScore(job)) {
          if (job.fit_status === 'reject') buckets.fitFailed += 1;
          else if (Number(job.fit_score) >= matchThreshold) buckets.recommended += 1;
          else buckets.notRecommended += 1;
        } else if (job.fit_status === 'screened_out') {
          buckets.screenFailed += 1;
        } else if (job.fit_status === 'screened_in') {
          buckets.screenPassed += 1;
        } else {
          buckets.unassessed += 1;
        }
      });
      return buckets;
    }

    // Full reconciliation from the authoritative /jobs payload -- every full Jobs load resets from
    // here. Deliberately silent (no burst): this resizes bars/pools to match reality, it doesn't
    // claim new real work just happened. Live motion comes only from pfApplyPipelineEvent/
    // pfBumpScanned below, each firing an explicit burst for the specific real delta it just
    // learned about from an actual backend event -- never inferred from a before/after diff here.
    function setPfCounts(counts) {
      pfLastCountsPayload = counts;
      var buckets = pfBucketsFromJobs(counts);
      var screenAccepted = buckets.screenPassed + buckets.fitFailed + buckets.recommended + buckets.notRecommended;
      pfSourceTotal = counts.total || allJobs.length ||
        (buckets.unassessed + buckets.screenFailed + screenAccepted);
      pfScreenWaiting = buckets.unassessed;
      pfScreenProcessing = 0;
      pfFitProcessing = 0;
      pfNodeCounts.screen_rejected = buckets.screenFailed;
      pfNodeCounts.review_queue = buckets.screenPassed;
      pfNodeCounts.fit_failed = buckets.fitFailed;
      pfNodeCounts.fit_rejected = buckets.notRecommended;
      pfNodeCounts.fit_recommended = buckets.recommended;
      pfRefresh();

      document.getElementById('jobs-pipeline-summary').textContent =
        buckets.screenFailed + ' failed pre-screen' +
        ', ' + buckets.screenPassed + ' passed and awaiting fit' +
        ', ' + buckets.fitFailed + ' failed fit' +
        ', ' + buckets.recommended + ' good fit' +
        ', ' + buckets.notRecommended + ' bad fit.';
      document.getElementById('pfStatScanned').textContent = String(pfSourceTotal);
      document.getElementById('pfStatRecommended').textContent = String(buckets.recommended);
      var totalScreened = buckets.screenFailed + screenAccepted;
      document.getElementById('pfStatScreenRate').textContent = totalScreened ? Math.round(100 * screenAccepted / totalScreened) + '%' : '—';
      var processed = pfSourceTotal ? Math.round(100 * (buckets.screenFailed + buckets.fitFailed + buckets.recommended + buckets.notRecommended) / pfSourceTotal) : 0;
      document.getElementById('pfStatProcessed').textContent = processed + '%';
      document.getElementById('pfProgressFill').style.width = processed + '%';
    }

    function pfBeginRun() { /* Pipeline events carry the real transient state. */ }

    function pfApplyPipelineEvent(event) {
      var count = (event.ids || event.outcomes || []).length;
      if (!count) return;
      if (event.phase === 'dispatched') {
        if (event.stage === 'screen') {
          pfScreenWaiting = Math.max(0, pfScreenWaiting - count);
          pfScreenProcessing += count;
          pfRefresh();
          jobsFlow.burstIntoGate('screen_gate', count);
          return;
        }
        // There is intentionally no separate AI Review node. A dispatched deep-assessment batch
        // remains represented by Screen > Pass until its real Fit outcome resolves.
        pfFitProcessing += count;
        pfRefresh();
        return;
      }
      if (event.phase === 'failed') {
        if (event.stage === 'screen') {
          pfScreenProcessing = Math.max(0, pfScreenProcessing - count);
          pfScreenWaiting += count;
          pfRefresh();
          return;
        }
        pfFitProcessing = Math.max(0, pfFitProcessing - count);
        pfRefresh();
        return;
      }
      if (event.phase === 'resolved') {
        if (event.stage === 'screen') {
          pfScreenProcessing = Math.max(0, pfScreenProcessing - count);
        } else {
          pfFitProcessing = Math.max(0, pfFitProcessing - count);
          pfNodeCounts.review_queue = Math.max(0, (pfNodeCounts.review_queue || 0) - count);
        }
        var grouped = {};
        event.outcomes.forEach(function (item) { grouped[item.outcome] = (grouped[item.outcome] || 0) + 1; });
        if (event.stage === 'screen') {
          pfNodeCounts.screen_rejected += grouped.rejected || 0;
          pfNodeCounts.review_queue += grouped.passed || 0;
          pfRefresh();
          if (grouped.rejected) jobsFlow.burst('screen_gate->screen_rejected', grouped.rejected, false, false);
          if (grouped.passed) jobsFlow.burst('screen_gate->review_queue', grouped.passed, false, false);
        } else {
          pfNodeCounts.fit_failed += grouped.failed || 0;
          pfNodeCounts.fit_rejected += grouped.rejected || 0;
          pfNodeCounts.fit_recommended += grouped.recommended || 0;
          pfRefresh();
          if (grouped.failed) jobsFlow.burst('review_queue->fit_failed', grouped.failed, false, false);
          if (grouped.rejected) jobsFlow.burst('review_queue->fit_rejected', grouped.rejected, false, false);
          if (grouped.recommended) jobsFlow.burst('review_queue->fit_recommended', grouped.recommended, false, false);
        }
      }
    }
    // Scanning company boards finds new postings before any screening happens -- they land
    // straight in "not screened yet", growing the Scanned total live as each company's board read
    // completes, same idea as the assess-run deltas above but simpler (only one bucket changes).
    function pfBumpScanned(newJobs) {
      if (!newJobs) return;
      pfSourceTotal += newJobs;
      pfScreenWaiting += newJobs;
      pfRefresh();
    }

    function renderJobPipeline(counts) {
      setPfCounts(counts);
    }

    // A Fit Threshold change is a pure view change over saved scores. Recompute the Search page's
    // fit totals from the same in-memory rows immediately too, so it cannot keep showing the old
    // boundary while Jobs has already moved those postings between Recommended and Not Recommended.
    function syncPipelineFitCountsFromJobs() {
      var counts = Object.assign({}, pfLastCountsPayload || {});
      counts.good_fit = 0;
      counts.bad_fit = 0;
      counts.unrated = 0;
      counts.ruled_out = 0;
      counts.reject = 0;
      counts.screened_out = 0;
      allJobs.forEach(function (job) {
        var category = pipelineJobCategory(job);
        if (category === 'good_match') counts.good_fit += 1;
        else if (category === 'bad_match') counts.bad_fit += 1;
        else if (category === 'fit_fail') counts.reject += 1;
        else if (category === 'screen_fail') {
          counts.ruled_out += 1;
          counts.screened_out += 1;
        }
        else counts.unrated += 1;
      });
      counts.total = allJobs.length;
      setPfCounts(counts);
    }

    // rAF keeps running while a background tab is (mostly) inactive, but some browsers throttle
    // it heavily -- waking it explicitly when Jobs > Search becomes visible again catches up any
    // easing that stalled while it was hidden.
    document.querySelector('[data-tab="jobs"]').addEventListener('click', function () {
      if (jobsView === 'search') pfWake();
    });
    document.querySelector('[data-tab="companies"]').addEventListener('click', function () {
      if (companiesView === 'find') companiesFlow.wake();
    });

    async function loadJobs(syncPipeline) {
      var res = await api('/jobs');
      var data = await res.json();
      allJobs = data.jobs || [];
      if (syncPipeline !== false) {
        matchThreshold = Number.isFinite(data.match_threshold) ? data.match_threshold : 70;
        document.getElementById('jobs-match-threshold').value = matchThreshold;
        renderJobPipeline(data.counts || {});
      }
      // renderJobs() also drives the Interested subtab (via renderInterestedList) when it is active.
      renderJobs();
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

    function parkInterestedDetail() {
      var section = document.getElementById('interested-detail-section');
      section.style.display = 'none';
      document.getElementById('interested-detail-home').appendChild(section);
    }

    function showInterestedDetail(job, inlineHost) {
      activeInterestedJobId = job.id;
      showInterestedSubtab('assistant');
      var section = document.getElementById('interested-detail-section');
      inlineHost.appendChild(section);
      section.style.display = 'block';
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
      var appliedJobs = allJobs.filter(function (j) { return Boolean(j.applied_at); });
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
        var titleLine = [titleNode];
        var matches = gmailReplyMatches[job.id] || [];
        if (matches.length) {
          titleLine.push(el('span', {
            className: 'badge strong',
            textContent: matches.length + ' possible repl' + (matches.length === 1 ? 'y' : 'ies'),
          }));
        }
        var meta = [
          job.company,
          job.location,
          job.applied_at ? 'applied ' + new Date(job.applied_at).toLocaleDateString() : '',
        ].filter(Boolean).join(' · ');

        var body = [
          el('div', { className: 'row-title-line' }, titleLine),
          el('div', { className: 'row-meta', textContent: meta }),
        ];
        if (gmailReplySkipped[job.id]) {
          body.push(el('p', { className: 'row-meta', textContent: 'Not checked -- company name too short/generic to search reliably.' }));
        }
        matches.forEach(function (match) {
          body.push(el('div', { className: 'row-item' }, [
            el('a', {
              className: 'row-title', href: 'https://mail.google.com/mail/u/0/#all/' + match.id,
              target: '_blank', rel: 'noopener', textContent: match.subject || '(no subject)',
            }),
            el('div', { className: 'row-meta', textContent: [match.from, match.date].filter(Boolean).join(' · ') }),
            el('p', { className: 'job-reason', textContent: match.snippet }),
          ]));
        });

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

    // candidateJobs is renderJobs()'s already-search/age/score-filtered array, so the Interested
    // subtab's list respects the same shared filter controls as the other five subtabs.
    function renderInterestedList(candidateJobs) {
      var list = document.getElementById('interested-list');
      var expandedJobId = activeInterestedJobId;
      // The reusable tools may currently live inside a card that is about to be replaced.
      // Detach them before clearing the list so their event handlers and generated state survive.
      parkInterestedDetail();
      list.innerHTML = '';
      // Applied jobs stay manual_status='interested' (applying only ever happens from this
      // workspace) but live on the Applied subtab, not here -- same exclusion this list has
      // always had, back when applying overwrote fit_status away from 'interested'.
      var interestedJobs = candidateJobs.filter(function (j) { return j.manual_status === 'interested' && !j.applied_at; });
      interestedJobs.sort(jobSortComparator(document.getElementById('jobs-sort').value));

      if (!interestedJobs.length) {
        list.appendChild(el('p', {
          className: 'empty',
          textContent: 'No interested jobs yet — mark one Interested from Good Fit, Bad Fit, or Fit Fail.',
        }));
        activeInterestedJobId = null;
        return;
      }

      var expandedEntry = null;
      interestedJobs.forEach(function (job) {
        var hasScore = hasCompletedFitScore(job);
        var badgeText = hasScore ? job.fit_score + '% match' : FIT_LABELS.interested.text;
        // Deliberately not a link any more. The whole card, title included, is one accordion
        // control; "go to the employer's page" is the Apply button's job, so that navigation
        // happens exactly once, from the one place that also hands off to the extension's agent.
        var titleNode = el('span', { className: 'row-title', textContent: job.title });
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

        // The handoff point: opens the employer's own application page, where the extension's
        // in-page agent takes over (see extension/agent.js). Disabled rather than hidden when a
        // posting has no URL, so the button's absence never reads as "this job can't be applied to".
        var applyButton = el('button', {
          className: 'success', type: 'button', textContent: 'Apply',
          disabled: !job.source_url,
          title: job.source_url ? 'Open the application page' : 'This posting has no URL on file',
        });
        applyButton.addEventListener('click', function (event) {
          event.stopPropagation();
          if (!job.source_url) return;
          window.open(job.source_url, '_blank', 'noopener');
        });

        var notInterested = el('button', { className: 'danger', type: 'button', textContent: 'Not Interested' });
        notInterested.addEventListener('click', function (event) {
          event.stopPropagation();
          submitJobFit(job.id, 'removed');
        });

        var inlineHost = el('div', { className: 'interested-inline-tools' });
        var card = el('div', { className: 'row-item interested-card', tabIndex: 0 }, [
          el('div', { className: 'row' }, [
            el('div', {}, body),
            el('div', { className: 'row-actions' }, [applyButton, notInterested]),
          ]),
          inlineHost,
        ]);
        card.setAttribute('role', 'group');
        card.setAttribute('aria-expanded', 'false');
        card.setAttribute('aria-label', job.title + ' — click to show or hide ApplyGo tools');

        function toggleCard() {
          var section = document.getElementById('interested-detail-section');
          var isOpen = activeInterestedJobId === job.id && section.parentElement === inlineHost && section.style.display !== 'none';
          var previous = list.querySelector('.interested-card.is-expanded');
          if (previous) {
            previous.classList.remove('is-expanded');
            previous.setAttribute('aria-expanded', 'false');
          }
          parkInterestedDetail();
          if (isOpen) {
            activeInterestedJobId = null;
            return;
          }
          card.classList.add('is-expanded');
          card.setAttribute('aria-expanded', 'true');
          showInterestedDetail(job, inlineHost);
        }

        card.addEventListener('click', function (event) {
          if (event.target.closest('a, button, input, textarea, select, iframe, .interested-inline-tools')) return;
          toggleCard();
        });
        card.addEventListener('keydown', function (event) {
          if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          toggleCard();
        });

        list.appendChild(card);
        if (expandedJobId === job.id) expandedEntry = { job: job, card: card, host: inlineHost };
      });

      // A live refresh keeps an explicitly opened card open, but the initial list starts fully
      // collapsed. If the active job left Interested, the reusable tools remain parked and hidden.
      if (expandedEntry) {
        expandedEntry.card.classList.add('is-expanded');
        expandedEntry.card.setAttribute('aria-expanded', 'true');
        var detailSection = document.getElementById('interested-detail-section');
        expandedEntry.host.appendChild(detailSection);
        detailSection.style.display = 'block';
        activeInterestedJobId = expandedEntry.job.id;
      } else {
        activeInterestedJobId = null;
      }
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

      var alreadyApplied = Boolean(job.applied_at);
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
      // The API omits revoked sessions; keep this defensive filter so a stale/cached response
      // cannot briefly put one back into Settings after the user revoked it.
      devices.filter(function (device) { return !device.revoked; }).forEach(function (device) {
        var isCurrent = device.id === currentId;
        var titleLine = [el('span', { className: 'row-title', textContent: device.device_name })];
        if (isCurrent) titleLine.push(el('span', { className: 'badge possible', textContent: 'this device' }));
        var children = [
          el('div', {}, [
            el('div', { className: 'row-title-line' }, titleLine),
            el('div', { className: 'row-meta', textContent: 'Last seen ' + new Date(device.last_seen_at).toLocaleString() }),
          ]),
        ];
        var revoke = el('button', { className: 'danger', type: 'button', textContent: 'Revoke' });
        revoke.addEventListener('click', async function () {
          await api('/devices/' + encodeURIComponent(device.id) + '/revoke', { method: 'POST' });
          if (isCurrent) { goToEnroll(); return; }
          loadDevices();
        });
        children.push(el('div', { className: 'row-actions' }, [revoke]));
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
      countsHost.appendChild(dataRow('Career preferences', String(counts.role_signals || 0)));
      countsHost.appendChild(dataRow('Role examples', String(counts.role_examples || 0)));
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
        { id: 'notes', name: 'Notes', note: 'Freeform career evidence on Profile → Notes.' },
        { id: 'role_signals', name: 'Career preferences', note: 'What you wrote on Careers → Preferences.' },
        { id: 'role_examples', name: 'Career examples', note: 'Good/bad job examples on Careers → Examples.' },
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

    // One state -> one card. The credentials form (Step 1) and Connect button (Step 3) sections
    // are shown/hidden/relabeled from here rather than duplicated per state, so there's a single
    // source of truth for "what does the user see right now."
    function renderGmailStatus(status) {
      var card = document.getElementById('gmail-status-card');
      card.innerHTML = '';
      var checkButton = document.getElementById('gmail-check-replies-button');
      var notConnectedHint = document.getElementById('gmail-not-connected-hint');
      var setupDetails = document.getElementById('gmail-setup-details');
      var setupSummary = document.getElementById('gmail-setup-summary');
      var connectSection = document.getElementById('gmail-connect-section');

      document.getElementById('gmail-redirect-uri').textContent = status.redirect_uri || '';
      if (document.activeElement !== document.getElementById('gmail-client-id')) {
        document.getElementById('gmail-client-id').value = status.client_id || '';
      }

      var title, meta, badgeClass, actions = [];

      if (status.state === 'not_configured') {
        title = 'Not configured';
        meta = 'Google OAuth credentials have not been entered yet.';
        badgeClass = 'queued';
        setupDetails.open = true;
        setupSummary.textContent = 'Set up Gmail';
        connectSection.style.display = 'none';
      } else if (status.state === 'ready') {
        title = 'Ready to connect';
        meta = 'Google credentials are saved' + (status.using_env_fallback ? ' (via environment variables)' : '') +
          '. Your Gmail account is not connected yet.';
        badgeClass = 'possible';
        setupDetails.open = false;
        setupSummary.textContent = 'Update Google credentials';
        connectSection.style.display = '';
      } else if (status.state === 'needs_reconnect') {
        title = 'Connection expired — needs attention';
        meta = 'Google needs you to reconnect Gmail. This can happen periodically; your ApplyGo data is unaffected.';
        badgeClass = 'warn';
        setupDetails.open = false;
        setupSummary.textContent = 'Update Google credentials';
        connectSection.style.display = 'none';
        var reconnect = el('button', { type: 'button', textContent: 'Reconnect Gmail' });
        reconnect.addEventListener('click', function () { window.location.href = '/gmail/connect'; });
        actions.push(reconnect);
      } else {
        title = 'Connected' + (status.email_address ? ' as ' + status.email_address : '');
        meta = status.connected_at ? 'Connected ' + new Date(status.connected_at).toLocaleString() : '';
        badgeClass = 'strong';
        setupDetails.open = false;
        setupSummary.textContent = 'Update Google credentials';
        connectSection.style.display = 'none';
        var disconnect = el('button', { className: 'danger', type: 'button', textContent: 'Disconnect' });
        disconnect.addEventListener('click', async function () {
          disconnect.disabled = true;
          await api('/gmail/disconnect', { method: 'POST' });
          await loadGmailStatus();
        });
        actions.push(disconnect);
      }

      var connectedNow = status.state === 'connected';
      checkButton.style.display = connectedNow ? '' : 'none';
      notConnectedHint.style.display = connectedNow ? 'none' : '';

      var body = [
        el('div', { className: 'row-title-line' }, [
          el('span', { className: 'row-title', textContent: title }),
          el('span', { className: 'badge ' + badgeClass, textContent: status.state.split('_').join(' ') }),
        ]),
        el('div', { className: 'row-meta', textContent: meta }),
      ];
      card.appendChild(el('div', { className: 'row-item' }, [
        el('div', { className: 'row' }, [el('div', {}, body), el('div', { className: 'row-actions' }, actions)]),
      ]));
    }

    async function loadGmailStatus() {
      var res = await api('/gmail/status');
      var data = await res.json();
      renderGmailStatus(data);
    }

    document.getElementById('gmail-credentials-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('gmail-credentials-status');
      var clientId = document.getElementById('gmail-client-id').value.trim();
      var clientSecret = document.getElementById('gmail-client-secret').value.trim();
      if (!clientId || !clientSecret) {
        statusEl.textContent = 'Enter both the Client ID and Client Secret.';
        statusEl.className = 'status error';
        return;
      }
      statusEl.textContent = 'Saving…';
      statusEl.className = 'status';
      try {
        var res = await api('/gmail/credentials', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
        });
        if (!res.ok) throw new Error(errorMessage(await res.json(), 'save_failed'));
        // The secret itself is never echoed back or kept in the field once saved -- only the
        // Client ID (not sensitive) is redisplayed, by loadGmailStatus below.
        document.getElementById('gmail-client-secret').value = '';
        statusEl.textContent = 'Credentials saved. Click Connect Gmail below.';
        statusEl.className = 'status success';
        await loadGmailStatus();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('gmail-toggle-secret').addEventListener('click', function () {
      var input = document.getElementById('gmail-client-secret');
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      this.textContent = showing ? 'Show' : 'Hide';
    });

    document.getElementById('gmail-copy-redirect').addEventListener('click', async function () {
      var button = this;
      var value = document.getElementById('gmail-redirect-uri').textContent;
      try {
        await navigator.clipboard.writeText(value);
      } catch (err) {
        window.prompt('Copy this URL:', value);
        return;
      }
      var original = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(function () { button.textContent = original; }, 1500);
    });

    // A real top-level navigation, not an api()/fetch() call -- the browser has to follow Google's
    // redirect chain itself, which a fetch() would just consume internally.
    document.getElementById('gmail-connect-button').addEventListener('click', function () {
      window.location.href = '/gmail/connect';
    });

    document.getElementById('gmail-check-replies-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('gmail-check-status');
      var button = this;
      button.disabled = true;
      statusEl.textContent = 'Checking for replies…';
      statusEl.className = 'status';
      try {
        var res = await api('/gmail/check-replies', { method: 'POST' });
        if (!res.ok) throw new Error(errorMessage(await res.json(), 'gmail_check_failed'));
        var data = await readNdjson(res, function (event) {
          statusEl.textContent = 'Checking… ' + event.done + ' of ' + event.total + ' (' + event.company + ')' +
            (event.found ? ' — ' + event.found + ' possible match' + (event.found === 1 ? '' : 'es') : '');
        });
        gmailReplyMatches = data.matches || {};
        gmailReplySkipped = {};
        (data.skipped || []).forEach(function (id) { gmailReplySkipped[id] = true; });
        var foundCount = Object.keys(gmailReplyMatches).filter(function (id) { return gmailReplyMatches[id].length; }).length;
        statusEl.textContent = 'Checked ' + data.checked + ' applied job' + (data.checked === 1 ? '' : 's') +
          ' — ' + foundCount + ' with possible replies.';
        statusEl.className = 'status success';
        renderAppliedList();
      } catch (err) {
        if (err.message === 'gmail_reconnect_required') {
          statusEl.textContent = 'Gmail needs reconnecting — see Settings → Email.';
          await loadGmailStatus();
        } else {
          statusEl.textContent = 'Error: ' + err.message;
        }
        statusEl.className = 'status error';
      } finally {
        button.disabled = false;
      }
    });

    // Friendly copy for every error handleGmailCallback can redirect back with. Kept out of the
    // primary message: raw Google error text (gmail_error_detail, when present) only ever shows in
    // the "Technical details" disclosure, never inline.
    var GMAIL_ERROR_MESSAGES = {
      access_denied: 'Gmail was not connected because permission was not granted. Nothing was changed.',
      invalid_client: 'ApplyGo could not authenticate with the Google credentials you entered. Check the Client ID and Client Secret in Google Cloud and try again.',
      redirect_mismatch: 'Google does not recognize this ApplyGo URL. Make sure the redirect URI shown below is entered exactly in your Google OAuth client’s Authorized redirect URIs.',
      invalid_request: 'That connection attempt expired or was invalid. Click Connect Gmail to try again.',
      not_configured: 'Google credentials are not set up yet. Save your Client ID and Client Secret below first.',
      google_error: 'Google reported a problem completing the connection.',
      exchange_failed: 'ApplyGo could not complete the connection with Google.',
    };

    // Google's redirect back after Connect Gmail lands here with a query param either way -- jump
    // straight to Settings > Email so the result is immediately visible, rather than leaving the
    // user on whatever tab happened to be active before they clicked Connect.
    (function () {
      var params = new URLSearchParams(window.location.search);
      var connected = params.get('gmail') === 'connected';
      var errorCode = params.get('gmail_error');
      if (!connected && !errorCode) return;
      window.history.replaceState({}, '', window.location.pathname);
      document.querySelector('[data-tab="settings"]').click();
      document.querySelector('[data-settings-subtab="email"]').click();

      var messageEl = document.getElementById('gmail-flow-message');
      if (connected) {
        messageEl.textContent = 'Gmail connected. ApplyGo can now check your inbox for job-related replies.';
        messageEl.className = 'status success';
        return;
      }
      messageEl.textContent = GMAIL_ERROR_MESSAGES[errorCode] || 'Something went wrong connecting Gmail.';
      messageEl.className = 'status error';
      var detail = params.get('gmail_error_detail');
      if (detail) {
        document.getElementById('gmail-error-technical').textContent = detail;
        document.getElementById('gmail-error-details').style.display = '';
      }
    })();

    loadProfile();
    loadRoleSignals();
    loadRoleExamples();
    loadDocuments();
    loadNotes();
    loadResumes();
    loadCompanies();
    loadCompanySearchTerms();
    loadJobs();
    loadDevices();
    loadGmailStatus();
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
  /^\/applications\/answer$/,
  /^\/applications\/generate-answer$/,
  /^\/applications\/resolve-option$/,
  /^\/applications\/events$/,
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
 * evals.ts staying schema-agnostic avoids a circular import back into index.ts for the five schemas
 * that are defined here (STRUCTURED_PROFILE_JSON_SCHEMA, RESUME_BASE_SCHEMA, COVER_LETTER_SCHEMA,
 * GENERATE_ANSWER_SCHEMA, RESOLVE_OPTION_SCHEMA).
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
    case "fit.criteria":
      return { kind: "structured", schema: CARE_ABOUT_TOPICS_SCHEMA, toolName: "submit_topics", maxTokens: 1200 };
    case "profile.structure":
      // Retained only so an eval case saved before the profile/create rename can still be replayed
      // against the schema it was actually generated with -- new cases are saved under "profile.create".
      return { kind: "structured", schema: STRUCTURED_PROFILE_JSON_SCHEMA, toolName: "submit_structured_profile", maxTokens: 2000 };
    case "profile.create":
      return { kind: "structured", schema: CAREER_PROFILE_SCHEMA, toolName: "submit_structured_profile", maxTokens: 16000 };
    case "profile.improve_audit":
      return { kind: "structured", schema: IMPROVE_AUDIT_SCHEMA, toolName: "submit_improve_questions", maxTokens: 8000 };
    case "profile.improve_apply":
      return { kind: "structured", schema: CAREER_PROFILE_SCHEMA, toolName: "submit_updated_profile", maxTokens: 16000 };
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
    case "application.generate_answer":
      return { kind: "structured", schema: GENERATE_ANSWER_SCHEMA, toolName: "submit_drafted_answer", maxTokens: 1200 };
    case "application.resolve_option":
      return { kind: "structured", schema: RESOLVE_OPTION_SCHEMA, toolName: "submit_resolved_option", maxTokens: 500 };
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
  if (method === "GET" && path === "/dev/langfuse") {
    return json({
      configured: langfuseConfigured(env),
      host: env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || "https://cloud.langfuse.com",
    });
  }

  const traceMatch = path.match(/^\/dev\/traces\/(.+)$/);
  if (method === "GET" && traceMatch) {
    const trace = await getTrace(env.DB, decodeURIComponent(traceMatch[1]));
    if (!trace) return json({ error: "not_found" }, 404);
    // Only resolved when this particular call was actually sent to Langfuse -- most won't be, if
    // Langfuse isn't configured at all, and langfuseTraceUrl itself no-ops in that case anyway.
    const langfuseUrl = trace.langfuse_trace_id ? await langfuseTraceUrl(env, trace.langfuse_trace_id) : null;
    return json({ trace: { ...trace, langfuse_url: langfuseUrl } });
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
    if (request.method === "POST" && url.pathname === "/devices/read-only") return createReadOnlyToken(request, env);
    if (request.method === "GET" && url.pathname === "/companies/search-terms") return getCompanySearchTerms(request, env);
    if (request.method === "PUT" && url.pathname === "/companies/search-terms") return setCompanySearchTerms(request, env);
    if (request.method === "POST" && url.pathname === "/companies/search-terms/regenerate") return regenerateCompanySearchTerms(request, env);
    if (request.method === "POST" && url.pathname === "/companies/discover") return discoverCompanies(request, env, ctx);
    if (request.method === "POST" && url.pathname === "/companies/scan") return scanCompanies(request, env, ctx);
    const companyMatch = url.pathname.match(/^\/companies\/([^/]+)$/);
    if (request.method === "PATCH" && companyMatch) return updateCompany(request, env, companyMatch[1]);
    if (request.method === "DELETE" && companyMatch) return deleteCompany(request, env, companyMatch[1]);
    if (request.method === "GET" && url.pathname === "/jobs") return listJobs(request, env);
    if (request.method === "POST" && url.pathname === "/jobs") return createJob(request, env);
    if (request.method === "POST" && url.pathname === "/jobs/process") return processJobs(request, env, ctx);
    if (request.method === "PATCH" && url.pathname === "/jobs/match-threshold") return setMatchThreshold(request, env);
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
    if (request.method === "GET" && url.pathname === "/profile/improve/questions") return listImproveQuestions(request, env);
    if (request.method === "POST" && url.pathname === "/profile/improve/audit") return findProfileImprovements(request, env);
    if (request.method === "POST" && url.pathname === "/profile/improve/apply") return applyImproveAnswers(request, env);
    const improveQuestionMatch = url.pathname.match(/^\/profile\/improve\/questions\/([^/]+)$/);
    if (request.method === "PUT" && improveQuestionMatch) return saveImproveAnswer(request, env, improveQuestionMatch[1]);
    const improveDismissMatch = url.pathname.match(/^\/profile\/improve\/questions\/([^/]+)\/dismiss$/);
    if (request.method === "POST" && improveDismissMatch) return dismissImproveQuestion(request, env, improveDismissMatch[1]);
    if (request.method === "GET" && url.pathname === "/role-signals") return listRoleSignals(request, env);
    if (request.method === "POST" && url.pathname === "/role-signals") return createRoleSignal(request, env);
    const roleSignalMatch = url.pathname.match(/^\/role-signals\/([^/]+)$/);
    if (request.method === "DELETE" && roleSignalMatch) return deleteRoleSignal(request, env, roleSignalMatch[1]);
    if (request.method === "GET" && url.pathname === "/role-examples") return listRoleExamples(request, env);
    if (request.method === "POST" && url.pathname === "/role-examples") return createRoleExample(request, env);
    const roleExampleMatch = url.pathname.match(/^\/role-examples\/([^/]+)$/);
    if (request.method === "PATCH" && roleExampleMatch) return updateRoleExample(request, env, roleExampleMatch[1]);
    if (request.method === "DELETE" && roleExampleMatch) return deleteRoleExample(request, env, roleExampleMatch[1]);
    if (request.method === "PUT" && url.pathname === "/desired-roles") return saveDesiredRoles(request, env);
    if (request.method === "POST" && url.pathname === "/desired-roles/analyze") return analyzeDesiredRoles(request, env);
    if (request.method === "GET" && url.pathname === "/role-market") return getRoleMarketResearch(request, env);
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
    if (request.method === "POST" && url.pathname === "/gmail/credentials") return saveGoogleOAuthCredentials(request, env);
    if (request.method === "GET" && url.pathname === "/gmail/connect") return startGmailConnect(request, env);
    if (request.method === "GET" && url.pathname === "/gmail/callback") return handleGmailCallback(request, env);
    if (request.method === "GET" && url.pathname === "/gmail/status") return getGmailStatus(request, env);
    if (request.method === "POST" && url.pathname === "/gmail/disconnect") return disconnectGmail(request, env);
    if (request.method === "POST" && url.pathname === "/gmail/check-replies") return checkGmailReplies(request, env, ctx);
    if (request.method === "POST" && url.pathname === "/applications/match") return matchApplication(request, env);
    if (request.method === "POST" && url.pathname === "/applications/generate-answer") return generateApplicationAnswer(request, env);
    if (request.method === "POST" && url.pathname === "/applications/resolve-option") return resolveApplicationOption(request, env);
    if (request.method === "POST" && url.pathname === "/applications/answer") return saveApplicationAgentAnswer(request, env);
    if (request.method === "POST" && url.pathname === "/applications/events") return recordAgentEvents(request, env);
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
