// The remote MCP server Claude.ai connects to as a Connector: one tool per Agent API v1 route
// (see agent-gateway.ts and docs/architecture/chat-agent-api.md), speaking MCP's Streamable HTTP
// transport over plain Workers fetch -- no Durable Object, no session state, because every tool
// call here is already a stateless request/response against D1 through the existing gateway.
//
// This module deliberately does not import agent-gateway.ts (and agent-gateway.ts does not import
// from here at module scope either -- only inside the request handler) to avoid a circular
// module dependency between "the gateway that wires up the OAuth-protected route" and "the MCP
// tools that route calls back through the gateway." Instead the caller (agent-gateway.ts) hands in
// a `callAgent` function that already knows how to invoke handleAgentRequest in-process; this file
// only knows how to turn each Agent API response into a tool result. That also makes the tool
// definitions below testable with a fake `callAgent`, without standing up a Worker.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

/** One call into the existing /agent/v1/* surface. Status is kept alongside the body so a tool can decide whether to report a real error or a normal empty result. */
export type AgentCall = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(status: number, body: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: `ApplyGo returned HTTP ${status}: ${JSON.stringify(body)}` }], isError: true };
}

async function run(call: AgentCall, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<ToolResult> {
  const { status, body: responseBody } = await call(method, path, body);
  if (status >= 400) return errorResult(status, responseBody);
  return textResult(responseBody);
}

/**
 * Answering a profile question is the one tool that composes two Agent API calls into one MCP
 * call (save the answer, then commit it into candidate_evidence) -- pulled out as its own function
 * so that composition is unit-testable without going through the MCP transport, in particular the
 * short-circuit if the save itself fails.
 */
export async function answerProfileQuestion(call: AgentCall, id: string, answer: string): Promise<ToolResult> {
  const saved = await run(call, "PUT", `/agent/v1/profile/questions/${encodeURIComponent(id)}`, { answer });
  if (saved.isError) return saved;
  const applied = await run(call, "POST", "/agent/v1/profile/questions/apply", {});
  if (applied.isError) return applied;
  return textResult({ saved: JSON.parse(saved.content[0].text), applied: JSON.parse(applied.content[0].text) });
}

/** Builds a fresh McpServer with every ApplyGo tool registered against the given caller. One instance per request -- see handleMcpRequest below. */
export function buildApplyGoMcpServer(call: AgentCall): McpServer {
  const server = new McpServer({ name: "applygo", version: "1.1.0" });

  server.registerTool(
    "search_companies",
    {
      title: "Search companies",
      description:
        "Search the companies ApplyGo has discovered. identity_status says whether the company itself was " +
        "identified; job_source_status says whether ApplyGo can read its job board. These are independent -- " +
        "a verified company can still have an unreadable board.",
      inputSchema: {
        query: z.string().optional().describe("Substring match on company name, location, or hiring signal."),
        identity_status: z.enum(["pending", "verified", "ambiguous", "unresolved", "not_a_company", "dismissed"]).optional(),
        job_source_status: z.enum(["pending", "supported", "unsupported_ats", "careers_only", "no_board", "board_unreachable"]).optional(),
        limit: z.number().optional().describe("Max rows (default 25, max 200)."),
      },
    },
    async ({ query, identity_status, job_source_status, limit }) => {
      const { status, body } = await call("GET", "/agent/v1/companies");
      if (status >= 400) return errorResult(status, body);
      const max = Math.min(Math.max(Number(limit) || 25, 1), 200);
      const needle = (query ?? "").toLowerCase();
      const rows = (Array.isArray(body.companies) ? body.companies as Record<string, unknown>[] : [])
        .filter((c) => !identity_status || String(c.identity_status) === identity_status)
        .filter((c) => !job_source_status || String(c.job_source_status) === job_source_status)
        .filter((c) => !needle || [c.name, c.location, c.signal].some((f) => String(f ?? "").toLowerCase().includes(needle)));
      return textResult({ total_matched: rows.length, returned: Math.min(rows.length, max), companies: rows.slice(0, max) });
    },
  );

  server.registerTool(
    "get_company",
    {
      title: "Get company",
      description: "Full detail for one company by id or exact name, including why its website was or was not confirmed.",
      inputSchema: { id: z.string().optional(), name: z.string().optional() },
    },
    async ({ id, name }) => {
      if (!id && !name) return errorResult(400, { error: "provide either id or name" });
      const { status, body } = await call("GET", "/agent/v1/companies");
      if (status >= 400) return errorResult(status, body);
      const rows = Array.isArray(body.companies) ? body.companies as Record<string, unknown>[] : [];
      const found = rows.find((c) => (id && String(c.id) === id) || (name && String(c.name).toLowerCase() === name.toLowerCase()));
      return textResult(found ? { found: true, company: found } : { found: false, message: `No company matching ${id || name}.` });
    },
  );

  server.registerTool(
    "search_jobs",
    {
      title: "Search jobs",
      description:
        "Search imported job postings already on file. Statuses: unassessed (waiting in Pre-screen), " +
        "screened_in/screened_out, strong/possible/reject (scored), interested, applied. " +
        "Use search_for_new_jobs first if the candidate wants ApplyGo to go look for postings it doesn't have yet.",
      inputSchema: {
        query: z.string().optional(),
        company: z.string().optional(),
        status: z.string().optional().describe("fit_status value, e.g. 'strong', 'interested', 'applied', 'unassessed'."),
        min_score: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ query, company, status: fitStatus, min_score, limit }) => {
      const { status, body } = await call("GET", "/agent/v1/jobs");
      if (status >= 400) return errorResult(status, body);
      const max = Math.min(Math.max(Number(limit) || 25, 1), 200);
      const minScore = min_score === undefined ? null : Number(min_score);
      const needle = (query ?? "").toLowerCase();
      const rows = (Array.isArray(body.jobs) ? body.jobs as Record<string, unknown>[] : [])
        .filter((j) => !fitStatus || String(j.fit_status) === fitStatus)
        .filter((j) => !company || String(j.company).toLowerCase().includes(company.toLowerCase()))
        .filter((j) => minScore === null || Number(j.fit_score ?? -1) >= minScore)
        .filter((j) => !needle || [j.title, j.company, j.location].some((f) => String(f ?? "").toLowerCase().includes(needle)))
        .sort((a, b) => Number(b.fit_score ?? -1) - Number(a.fit_score ?? -1));
      return textResult({ total_matched: rows.length, returned: Math.min(rows.length, max), jobs: rows.slice(0, max) });
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description: "Full detail for one job by id, including its description, fit score, reasoning, and missing requirements.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const { status, body } = await call("GET", "/agent/v1/jobs");
      if (status >= 400) return errorResult(status, body);
      const found = (Array.isArray(body.jobs) ? body.jobs as Record<string, unknown>[] : []).find((j) => String(j.id) === id);
      return textResult(found ? { found: true, job: found } : { found: false, message: `No job with id ${id}.` });
    },
  );

  server.registerTool(
    "get_shortlist",
    {
      title: "Get ranked shortlist",
      description: "The current best-fit jobs, ranked, with the reasoning behind each score -- without running a new evaluation pass first.",
      inputSchema: { min_score: z.number().optional().describe("Default 60."), limit: z.number().optional().describe("Default 20.") },
    },
    async ({ min_score, limit }) => {
      const query = new URLSearchParams();
      if (min_score !== undefined) query.set("min_score", String(min_score));
      if (limit !== undefined) query.set("limit", String(limit));
      const suffix = query.toString() ? `?${query.toString()}` : "";
      return run(call, "GET", `/agent/v1/jobs/shortlist${suffix}`);
    },
  );

  server.registerTool(
    "list_applications",
    {
      title: "List applications",
      description: "Jobs the candidate has applied to or marked interested in -- their live applications.",
      inputSchema: { company: z.string().optional(), status: z.enum(["applied", "interested"]).optional() },
    },
    async ({ company, status: filterStatus }) => {
      const { status, body } = await call("GET", "/agent/v1/jobs");
      if (status >= 400) return errorResult(status, body);
      const rows = (Array.isArray(body.jobs) ? body.jobs as Record<string, unknown>[] : [])
        .filter((j) => String(j.fit_status) === "applied" || String(j.fit_status) === "interested" || String(j.manual_status) === "interested")
        .filter((j) => !filterStatus || String(j.fit_status) === filterStatus)
        .filter((j) => !company || String(j.company).toLowerCase().includes(company.toLowerCase()));
      return textResult({ total: rows.length, applications: rows });
    },
  );

  server.registerTool(
    "get_application_status",
    {
      title: "Get application status",
      description: "The status of the candidate's application(s) to a specific company. Matches the company name loosely.",
      inputSchema: { company: z.string() },
    },
    async ({ company }) => {
      const { status, body } = await call("GET", "/agent/v1/jobs");
      if (status >= 400) return errorResult(status, body);
      const rows = (Array.isArray(body.jobs) ? body.jobs as Record<string, unknown>[] : [])
        .filter((j) => String(j.company).toLowerCase().includes(company.toLowerCase()));
      if (!rows.length) return textResult({ found: false, message: `No jobs on file for a company matching "${company}".` });
      const applied = rows.filter((j) => String(j.fit_status) === "applied");
      const interested = rows.filter((j) => String(j.fit_status) === "interested");
      return textResult({
        found: true,
        applied_count: applied.length,
        interested_count: interested.length,
        other_jobs_on_file: rows.length - applied.length - interested.length,
        applications: [...applied, ...interested],
      });
    },
  );

  server.registerTool(
    "get_pipeline_status",
    {
      title: "Get pipeline status",
      description: "Diagnose the discovery/evaluation pipeline: the company/job funnel, plus recent model failures, discovery streams with pages remaining, and duplicate postings.",
      inputSchema: {},
    },
    async () => run(call, "GET", "/agent/v1/pipeline/status"),
  );

  server.registerTool(
    "discover_companies",
    {
      title: "Discover companies",
      description: "Search job aggregators for new employers matching the candidate's current search terms and preferences, and add them to the tracked company list.",
      inputSchema: { focus: z.string().optional().describe("Optional free-text nudge for this discovery pass.") },
    },
    async ({ focus }) => run(call, "POST", "/agent/v1/companies/discover", focus ? { focus } : {}),
  );

  server.registerTool(
    "scan_companies",
    {
      title: "Scan companies for postings",
      description: "Re-scan tracked companies' job boards for new or updated postings. Does not score fit -- run evaluate_jobs afterward, or use search_for_new_jobs to do both.",
      inputSchema: {
        company_id: z.string().optional().describe("Scan only this one company; omit to scan the batch due for a re-check."),
        limit: z.number().optional(),
      },
    },
    async ({ company_id, limit }) => run(call, "POST", "/agent/v1/companies/scan", { company_id, limit }),
  );

  server.registerTool(
    "search_for_new_jobs",
    {
      title: "Search for new jobs",
      description:
        "Scan tracked companies for new postings and score them, then report only what's new since the call " +
        "started. This is 'go find me more jobs' -- for re-scoring what's already on file, use evaluate_jobs.",
      inputSchema: { provider: z.enum(["anthropic", "openai"]).optional() },
    },
    async ({ provider }) => run(call, "POST", "/agent/v1/jobs/search", { provider }),
  );

  server.registerTool(
    "evaluate_jobs",
    {
      title: "Evaluate job fit",
      description:
        "Run ApplyGo's fit pipeline (cheap screen, then a full scored assessment) over whatever postings are " +
        "currently unassessed, then return a ranked shortlist with rationale for each. Safe to call repeatedly.",
      inputSchema: {
        provider: z.enum(["anthropic", "openai"]).optional(),
        min_score: z.number().optional().describe("Floor for the returned shortlist, default 40."),
        limit: z.number().optional().describe("Default 20."),
      },
    },
    async ({ provider, min_score, limit }) => run(call, "POST", "/agent/v1/jobs/evaluate", { provider, min_score, limit }),
  );

  server.registerTool(
    "update_search_preferences",
    {
      title: "Update search preferences",
      description:
        "Update the candidate's own stated search constraints and priorities -- locations, dealbreakers, and " +
        "what to surface when comparing jobs. Changing any of these invalidates stale derived role analysis " +
        "so it gets regenerated rather than silently reused.",
      inputSchema: {
        desired_locations: z.string().optional(),
        dealbreakers: z.string().optional(),
        care_about: z.string().optional(),
      },
    },
    async (patch) => run(call, "PUT", "/agent/v1/preferences", patch),
  );

  server.registerTool(
    "list_profile_questions",
    {
      title: "List open profile questions",
      description: "Open questions from ApplyGo's Profile > Improve workflow -- gaps found between the candidate's evidence and the jobs it's been matched against.",
      inputSchema: {},
    },
    async () => run(call, "GET", "/agent/v1/profile/questions"),
  );

  server.registerTool(
    "audit_profile_gaps",
    {
      title: "Audit profile for gaps",
      description: "Look for new gaps between the candidate's profile and the jobs it's been matched against, adding any found to the open question list.",
      inputSchema: {},
    },
    async () => run(call, "POST", "/agent/v1/profile/questions/audit", {}),
  );

  server.registerTool(
    "answer_profile_question",
    {
      title: "Answer a profile question",
      description: "Record the candidate's answer to one open profile question and commit it into their evidence record.",
      inputSchema: { id: z.string(), answer: z.string() },
    },
    async ({ id, answer }) => answerProfileQuestion(call, id, answer),
  );

  server.registerTool(
    "generate_resume",
    {
      title: "Generate tailored resume",
      description:
        "Generate a resume tailored to one specific job, grounded only in the candidate's stored evidence -- " +
        "it will not state a qualification the profile doesn't back.",
      inputSchema: { job_id: z.string(), provider: z.enum(["anthropic", "openai"]).optional(), regenerate: z.boolean().optional() },
    },
    async (body) => run(call, "POST", "/agent/v1/materials/resume", body),
  );

  server.registerTool(
    "generate_cover_letter",
    {
      title: "Generate cover letter",
      description: "Generate a cover letter tailored to one specific job, grounded only in the candidate's stored evidence.",
      inputSchema: { job_id: z.string(), provider: z.enum(["anthropic", "openai"]).optional(), regenerate: z.boolean().optional() },
    },
    async (body) => run(call, "POST", "/agent/v1/materials/cover-letter", body),
  );

  return server;
}

/**
 * Handles one HTTP request against the MCP endpoint: fresh server + fresh stateless transport per
 * request, matching the SDK's documented pattern for a Workers/serverless deployment (no
 * `sessionIdGenerator` -- there is no in-memory session to keep alive between requests in a
 * Workers isolate, and none of these tools need one; each call is a self-contained request against
 * D1 through the gateway).
 */
export async function handleMcpRequest(request: Request, call: AgentCall): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = buildApplyGoMcpServer(call);
  await server.connect(transport);
  return transport.handleRequest(request);
}
