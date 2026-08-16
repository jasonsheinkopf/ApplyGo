// The ApplyGo MCP server's tools, defined independently of the MCP transport.
//
// Split out from server.js on purpose: the tool definitions, their schemas, their filtering, and
// the guarantee that none of them can write are all testable without standing up a stdio server or
// mocking the SDK. server.js does nothing but register what this file exports.
//
// Every tool is a read. That is enforced in three places, deliberately overlapping:
//
//   1. Here -- callApplyGo only ever issues GET requests. There is no code path that sends a body.
//   2. In ApplyGo -- requireSession rejects any non-GET from a read_only credential (403), so even
//      a modified client holding this token cannot mutate anything.
//   3. In the token -- the credential this server uses is minted with scope 'read_only'.
//
// The middle one is the guarantee that actually matters, because it holds regardless of what the
// client does. The other two mean a bug here surfaces as a failure rather than as a write.

export type ApplyGoConfig = {
  /** e.g. http://127.0.0.1:8787 for local dev, or the deployed Worker URL. */
  baseUrl: string;
  /** A scope:'read_only' token from POST /devices/read-only. */
  token: string;
  fetchImpl?: typeof fetch;
};

export class ApplyGoError extends Error {
  // Written out rather than declared as a constructor parameter property: Node's type-stripping
  // loader (which runs these tests) does not support that syntax.
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApplyGoError";
    this.status = status;
  }
}

/**
 * The only way this server talks to ApplyGo. GET-only by construction -- there is no parameter to
 * make it send anything else.
 */
export async function callApplyGo(config: ApplyGoConfig, path: string, query: Record<string, string | undefined> = {}): Promise<unknown> {
  const url = new URL(path, config.baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  const doFetch = config.fetchImpl ?? fetch;
  const res = await doFetch(url.toString(), {
    method: "GET",
    headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
  });
  if (res.status === 401) throw new ApplyGoError("ApplyGo rejected the token. Mint a new one with POST /devices/read-only.", 401);
  if (res.status === 403) throw new ApplyGoError("This credential is read-only and the request was refused.", 403);
  if (!res.ok) throw new ApplyGoError(`ApplyGo returned HTTP ${res.status} for ${path}`, res.status);
  return res.json();
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

const asArray = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value as Record<string, unknown>[] : []);
const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const lower = (value: unknown): string => str(value).toLowerCase();

/** Substring match across several fields, the same "does this row look relevant" test the UI uses. */
function matches(haystack: string[], needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return haystack.some((h) => h.toLowerCase().includes(n));
}

/**
 * Company shape returned to the model. Includes both state axes and the evidence behind the
 * website, because "why is this company unresolved" is exactly the kind of question this server
 * exists to answer, and a bare status cannot answer it.
 */
export function shapeCompany(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: str(row.id),
    name: str(row.name),
    source_name: str(row.source_name) || undefined,
    website: str(row.website) || undefined,
    identity_status: str(row.identity_status),
    job_source_status: str(row.job_source_status),
    ats_provider: str(row.ats_provider) || undefined,
    board_url: str(row.board_url) || str(row.careers_url) || undefined,
    website_confidence: row.website_confidence ?? undefined,
    website_evidence: str(row.website_evidence) || undefined,
    location: str(row.location) || undefined,
    open_jobs: Number(row.open_jobs ?? 0),
    hiring_signal: str(row.signal) || undefined,
    last_scanned_at: str(row.last_scanned_at) || undefined,
  };
}

export function shapeJob(row: Record<string, unknown>, full = false): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: str(row.id),
    title: str(row.title),
    company: str(row.company),
    location: str(row.location) || undefined,
    url: str(row.source_url) || undefined,
    status: str(row.fit_status),
    manual_status: str(row.manual_status) || undefined,
    fit_score: row.fit_score ?? undefined,
    fit_reason: str(row.fit_reason) || undefined,
    posted_at: str(row.posted_at) || undefined,
    applied_at: str(row.applied_at) || undefined,
  };
  if (full) {
    base.description = str(row.raw_description) || undefined;
    base.missing_requirements = row.fit_missing_json ?? undefined;
    base.fit_facts = row.fit_detail_json ?? undefined;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (config: ApplyGoConfig, args: Record<string, unknown>) => Promise<unknown>;
};

/** Statuses that mean "the candidate has an application in flight". */
const APPLICATION_STATUSES = new Set(["applied", "interested"]);

export const TOOLS: ToolDefinition[] = [
  {
    name: "search_companies",
    description:
      "Search the companies ApplyGo has discovered. Filter by name and by pipeline state. " +
      "identity_status says whether the company itself was identified (verified/ambiguous/unresolved); " +
      "job_source_status says whether ApplyGo can read its jobs (supported/unsupported_ats/careers_only/no_board). " +
      "These are independent: a verified company can still have an unreadable job board.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring match on company name, location, or hiring signal." },
        identity_status: { type: "string", enum: ["pending", "verified", "ambiguous", "unresolved", "not_a_company", "dismissed"] },
        job_source_status: { type: "string", enum: ["pending", "supported", "unsupported_ats", "careers_only", "no_board", "board_unreachable"] },
        limit: { type: "number", description: "Max rows (default 25, max 200)." },
      },
    },
    async run(config, args) {
      const data = (await callApplyGo(config, "/companies")) as Record<string, unknown>;
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 200);
      const rows = asArray(data.companies)
        .filter((c) => !args.identity_status || str(c.identity_status) === args.identity_status)
        .filter((c) => !args.job_source_status || str(c.job_source_status) === args.job_source_status)
        .filter((c) => matches([str(c.name), str(c.location), str(c.signal)], str(args.query)));
      return { total_matched: rows.length, returned: Math.min(rows.length, limit), companies: rows.slice(0, limit).map(shapeCompany) };
    },
  },

  {
    name: "get_company",
    description: "Full detail for one company by id or exact name, including why its website was or was not confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Company id." },
        name: { type: "string", description: "Exact company name, if the id is unknown." },
      },
    },
    async run(config, args) {
      if (!args.id && !args.name) throw new ApplyGoError("Provide either id or name.");
      const data = (await callApplyGo(config, "/companies")) as Record<string, unknown>;
      const rows = asArray(data.companies);
      const found = rows.find((c) => (args.id && str(c.id) === args.id) || (args.name && lower(c.name) === lower(args.name)));
      if (!found) return { found: false, message: `No company matching ${str(args.id || args.name)}.` };
      return { found: true, company: shapeCompany(found) };
    },
  },

  {
    name: "search_jobs",
    description:
      "Search imported job postings. Filter by text, company, and pipeline status. " +
      "Statuses: unassessed (waiting in Pre-screen), screened_in/screened_out, strong/possible/reject (scored), interested, applied.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring match on title, company, or location." },
        company: { type: "string", description: "Restrict to one company name." },
        status: { type: "string", description: "fit_status value, e.g. 'strong', 'interested', 'applied', 'unassessed'." },
        min_score: { type: "number", description: "Only jobs scored at or above this (0-100)." },
        limit: { type: "number", description: "Max rows (default 25, max 200)." },
      },
    },
    async run(config, args) {
      const data = (await callApplyGo(config, "/jobs")) as Record<string, unknown>;
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 200);
      const minScore = args.min_score === undefined ? null : Number(args.min_score);
      const rows = asArray(data.jobs)
        .filter((j) => !args.status || str(j.fit_status) === args.status)
        .filter((j) => !args.company || lower(j.company).includes(lower(args.company)))
        .filter((j) => minScore === null || Number(j.fit_score ?? -1) >= minScore)
        .filter((j) => matches([str(j.title), str(j.company), str(j.location)], str(args.query)))
        .sort((a, b) => Number(b.fit_score ?? -1) - Number(a.fit_score ?? -1));
      return { total_matched: rows.length, returned: Math.min(rows.length, limit), jobs: rows.slice(0, limit).map((j) => shapeJob(j)) };
    },
  },

  {
    name: "get_job",
    description: "Full detail for one job by id, including its description, fit score, reasoning, and missing requirements.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(config, args) {
      const data = (await callApplyGo(config, "/jobs")) as Record<string, unknown>;
      const found = asArray(data.jobs).find((j) => str(j.id) === str(args.id));
      if (!found) return { found: false, message: `No job with id ${str(args.id)}.` };
      return { found: true, job: shapeJob(found, true) };
    },
  },

  {
    name: "list_applications",
    description:
      "Jobs the candidate has applied to or marked interested in -- their live applications. " +
      "Optionally filter by company or status.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string" },
        status: { type: "string", enum: ["applied", "interested"] },
        limit: { type: "number" },
      },
    },
    async run(config, args) {
      const data = (await callApplyGo(config, "/jobs")) as Record<string, unknown>;
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
      const rows = asArray(data.jobs)
        .filter((j) => APPLICATION_STATUSES.has(str(j.fit_status)) || str(j.manual_status) === "interested")
        .filter((j) => !args.status || str(j.fit_status) === args.status)
        .filter((j) => !args.company || lower(j.company).includes(lower(args.company)))
        .sort((a, b) => str(b.applied_at || b.interested_at).localeCompare(str(a.applied_at || a.interested_at)));
      return { total: rows.length, applications: rows.slice(0, limit).map((j) => shapeJob(j)) };
    },
  },

  {
    name: "get_application_status",
    description:
      "The status of the candidate's application to a specific company -- answers questions like " +
      "'what's the status of my Acme application?'. Matches the company name loosely.",
    inputSchema: { type: "object", properties: { company: { type: "string" } }, required: ["company"] },
    async run(config, args) {
      const data = (await callApplyGo(config, "/jobs")) as Record<string, unknown>;
      const rows = asArray(data.jobs).filter((j) => lower(j.company).includes(lower(args.company)));
      if (!rows.length) return { found: false, message: `No jobs on file for a company matching "${str(args.company)}".` };
      const applied = rows.filter((j) => str(j.fit_status) === "applied");
      const interested = rows.filter((j) => str(j.fit_status) === "interested");
      return {
        found: true,
        company_query: str(args.company),
        applied_count: applied.length,
        interested_count: interested.length,
        other_jobs_on_file: rows.length - applied.length - interested.length,
        applications: [...applied, ...interested].map((j) => shapeJob(j)),
      };
    },
  },

  {
    name: "get_pipeline_summary",
    description:
      "Counts for the whole pipeline: companies by identity and job-source state, and jobs by stage. " +
      "Company stages count companies and job stages count jobs -- the two are never added together.",
    inputSchema: { type: "object", properties: {} },
    async run(config) {
      const [companies, jobs] = await Promise.all([
        callApplyGo(config, "/companies") as Promise<Record<string, unknown>>,
        callApplyGo(config, "/jobs") as Promise<Record<string, unknown>>,
      ]);
      const c = (companies.company_pipeline ?? {}) as Record<string, number>;
      const j = (jobs.counts ?? jobs.pipeline ?? {}) as Record<string, number>;
      return {
        companies: {
          unit: "companies",
          discovered: (c.identity_pending ?? 0) + (c.identity_verified ?? 0) + (c.identity_ambiguous ?? 0) +
            (c.identity_unresolved ?? 0) + (c.identity_not_a_company ?? 0),
          verified: c.identity_verified ?? 0,
          ambiguous: c.identity_ambiguous ?? 0,
          unresolved: c.identity_unresolved ?? 0,
          scannable: c.source_supported ?? 0,
          unsupported_board: c.source_unsupported_ats ?? 0,
          careers_page_only: c.source_careers_only ?? 0,
          no_board: c.source_no_board ?? 0,
        },
        jobs: {
          unit: "jobs",
          waiting_in_prescreen: c.prescreen_jobs ?? 0,
          good_fit: j.good_fit ?? 0,
          bad_fit: j.bad_fit ?? 0,
          interested: j.interested ?? 0,
          applied: j.applied ?? 0,
          total: j.total ?? 0,
        },
      };
    },
  },
];

/** Names only, for registration and for asserting no write tool ever appears. */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
