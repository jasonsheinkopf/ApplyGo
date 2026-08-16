import assert from "node:assert/strict";
import test from "node:test";

import {
  type ApplyGoConfig,
  ApplyGoError,
  TOOLS,
  TOOL_NAMES,
  callApplyGo,
  findTool,
  shapeCompany,
  shapeJob,
} from "./tools.ts";

const COMPANIES = {
  companies: [
    {
      id: "c1", name: "Acme Robotics", source_name: "Acme Robotics, Inc.", website: "https://acme.com",
      identity_status: "verified", job_source_status: "supported", ats_provider: "greenhouse",
      board_url: "https://job-boards.greenhouse.io/acme", website_confidence: 92,
      website_evidence: 'schema.org Organization name "Acme Robotics"', location: "Remote",
      open_jobs: 4, signal: "Hiring for: ML Engineer",
    },
    {
      id: "c2", name: "Sargent Lundy", website: "https://sargentlundy.com",
      identity_status: "verified", job_source_status: "unsupported_ats", ats_provider: "icims",
      board_url: "https://careers-sargentlundy.icims.com/", location: "Chicago", open_jobs: 0,
    },
    {
      id: "c3", name: "Match Made Tech", website: "", identity_status: "unresolved",
      job_source_status: "pending", website_evidence: "no reachable candidate", location: "", open_jobs: 0,
    },
  ],
  company_pipeline: {
    identity_pending: 0, identity_verified: 2, identity_ambiguous: 0, identity_unresolved: 1,
    identity_not_a_company: 0, source_supported: 1, source_unsupported_ats: 1,
    source_careers_only: 0, source_no_board: 0, prescreen_jobs: 722,
  },
};

const JOBS = {
  jobs: [
    { id: "j1", title: "ML Engineer", company: "Acme Robotics", location: "Remote", source_url: "https://x/1",
      fit_status: "strong", fit_score: 88, fit_reason: "Strong overlap", manual_status: "normal",
      raw_description: "Full description here", fit_missing_json: [] },
    { id: "j2", title: "Data Analyst", company: "Acme Robotics", fit_status: "applied", fit_score: 71,
      manual_status: "normal", applied_at: "2026-08-01" },
    { id: "j3", title: "Backend Engineer", company: "Other Co", fit_status: "unassessed", fit_score: null,
      manual_status: "normal" },
    { id: "j4", title: "Platform Engineer", company: "Acme Robotics", fit_status: "interested", fit_score: 79,
      manual_status: "normal", interested_at: "2026-08-10" },
  ],
  pipeline: { good_fit: 2, bad_fit: 1, interested: 1, applied: 1, total: 4 },
};

/** Records every request so the read-only guarantee can be asserted, not assumed. */
function mockApplyGo(routes: Record<string, unknown> = { "/companies": COMPANIES, "/jobs": JOBS }) {
  const seen: { url: string; method: string; hasBody: boolean }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url: url.toString(), method: init?.method ?? "GET", hasBody: init?.body !== undefined });
    const body = routes[url.pathname];
    if (body === undefined) return new Response("not found", { status: 404 });
    return Response.json(body);
  }) as typeof fetch;
  return { seen, config: { baseUrl: "https://applygo.test", token: "ro-token", fetchImpl } as ApplyGoConfig };
}

// ---------------------------------------------------------------------------
// The read-only guarantee
// ---------------------------------------------------------------------------

test("no tool exposes a mutation -- names alone must never suggest one", () => {
  const forbidden = /^(create|update|delete|apply|remove|set|edit|send|submit|dismiss|write|patch|post)_/;
  for (const name of TOOL_NAMES) {
    assert.doesNotMatch(name, forbidden, `${name} reads as a mutation`);
  }
  assert.ok(TOOL_NAMES.every((n) => /^(search|get|list)_/.test(n)), "every tool must be a search/get/list");
});

test("every tool issues only GET requests, and never sends a body", async () => {
  // The strongest available check: run all of them and inspect what actually went over the wire.
  for (const tool of TOOLS) {
    const { seen, config } = mockApplyGo();
    // Enough arguments for each tool to actually reach the network, so this asserts against real
    // traffic rather than against calls that bailed out early on validation.
    const args: Record<string, unknown> = {};
    if ("id" in tool.inputSchema.properties) args.id = "j1";
    if ("company" in tool.inputSchema.properties) args.company = "Acme";
    if (tool.name === "get_company") args.name = "Acme Robotics";
    await tool.run(config, args);
    assert.ok(seen.length > 0, `${tool.name} made no request`);
    for (const call of seen) {
      assert.equal(call.method, "GET", `${tool.name} used ${call.method}`);
      assert.equal(call.hasBody, false, `${tool.name} sent a request body`);
    }
  }
});

test("callApplyGo reports a read-only refusal from the server distinctly", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 403 })) as typeof fetch;
  await assert.rejects(
    () => callApplyGo({ baseUrl: "https://x.test", token: "t", fetchImpl }, "/companies"),
    (err: ApplyGoError) => err.status === 403 && /read-only/i.test(err.message),
  );
});

test("callApplyGo explains an expired token instead of failing opaquely", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  await assert.rejects(
    () => callApplyGo({ baseUrl: "https://x.test", token: "t", fetchImpl }, "/companies"),
    (err: ApplyGoError) => err.status === 401 && /devices\/read-only/.test(err.message),
  );
});

test("callApplyGo sends the token as a bearer credential", async () => {
  let auth = "";
  const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    return Response.json({});
  }) as typeof fetch;
  await callApplyGo({ baseUrl: "https://x.test", token: "ro-abc", fetchImpl }, "/companies");
  assert.equal(auth, "Bearer ro-abc");
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("every tool has a name, a description, and a valid object schema", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.name.length > 0);
    assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.inputSchema.properties, "object");
    for (const required of tool.inputSchema.required ?? []) {
      assert.ok(required in tool.inputSchema.properties, `${tool.name} requires undeclared "${required}"`);
    }
  }
});

test("findTool resolves known tools and rejects unknown ones", () => {
  assert.ok(findTool("search_jobs"));
  assert.equal(findTool("delete_everything"), undefined);
});

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

test("search_companies filters on the two state axes independently", async () => {
  const { config } = mockApplyGo();
  const verified = (await findTool("search_companies")!.run(config, { identity_status: "verified" })) as any;
  assert.equal(verified.total_matched, 2);

  // The point of the split: a verified company can still be unscannable.
  const unsupported = (await findTool("search_companies")!.run(config, { job_source_status: "unsupported_ats" })) as any;
  assert.equal(unsupported.total_matched, 1);
  assert.equal(unsupported.companies[0].name, "Sargent Lundy");
  assert.equal(unsupported.companies[0].identity_status, "verified");
});

test("search_companies matches on name, location, and hiring signal", async () => {
  const { config } = mockApplyGo();
  const byName = (await findTool("search_companies")!.run(config, { query: "acme" })) as any;
  assert.equal(byName.total_matched, 1);
  const bySignal = (await findTool("search_companies")!.run(config, { query: "ML Engineer" })) as any;
  assert.equal(bySignal.total_matched, 1);
});

test("search_companies caps its result set and reports the true match count", async () => {
  const { config } = mockApplyGo();
  const result = (await findTool("search_companies")!.run(config, { limit: 1 })) as any;
  assert.equal(result.total_matched, 3);
  assert.equal(result.returned, 1);
  assert.equal(result.companies.length, 1);
});

test("get_company surfaces the evidence behind an unresolved website", async () => {
  const { config } = mockApplyGo();
  const result = (await findTool("get_company")!.run(config, { name: "Match Made Tech" })) as any;
  assert.equal(result.found, true);
  assert.equal(result.company.identity_status, "unresolved");
  assert.equal(result.company.website_evidence, "no reachable candidate");
});

test("get_company reports a clean miss instead of throwing", async () => {
  const { config } = mockApplyGo();
  const result = (await findTool("get_company")!.run(config, { id: "nope" })) as any;
  assert.equal(result.found, false);
  assert.match(result.message, /No company matching/);
});

test("get_company requires at least one identifier", async () => {
  const { config } = mockApplyGo();
  await assert.rejects(() => findTool("get_company")!.run(config, {}), /Provide either id or name/);
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

test("search_jobs filters by status, company, and score, and sorts best first", async () => {
  const { config } = mockApplyGo();
  const strong = (await findTool("search_jobs")!.run(config, { status: "strong" })) as any;
  assert.equal(strong.total_matched, 1);

  const acme = (await findTool("search_jobs")!.run(config, { company: "Acme" })) as any;
  assert.equal(acme.total_matched, 3);
  assert.equal(acme.jobs[0].fit_score, 88, "highest score first");

  const scored = (await findTool("search_jobs")!.run(config, { min_score: 75 })) as any;
  assert.equal(scored.total_matched, 2);
});

test("search_jobs omits the description, get_job includes it", async () => {
  const { config } = mockApplyGo();
  const list = (await findTool("search_jobs")!.run(config, { query: "ML Engineer" })) as any;
  assert.equal(list.jobs[0].description, undefined, "listings stay compact");

  const one = (await findTool("get_job")!.run(config, { id: "j1" })) as any;
  assert.equal(one.found, true);
  assert.equal(one.job.description, "Full description here");
});

test("get_job reports a missing record rather than throwing", async () => {
  const { config } = mockApplyGo();
  assert.equal(((await findTool("get_job")!.run(config, { id: "nope" })) as any).found, false);
});

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

test("list_applications returns applied and interested jobs only", async () => {
  const { config } = mockApplyGo();
  const result = (await findTool("list_applications")!.run(config, {})) as any;
  assert.equal(result.total, 2);
  assert.deepEqual(result.applications.map((a: any) => a.status).sort(), ["applied", "interested"]);
});

test("get_application_status answers 'what is the status of my Acme application'", async () => {
  const { config } = mockApplyGo();
  const result = (await findTool("get_application_status")!.run(config, { company: "acme" })) as any;
  assert.equal(result.found, true);
  assert.equal(result.applied_count, 1);
  assert.equal(result.interested_count, 1);
  assert.equal(result.other_jobs_on_file, 1);
});

test("get_application_status is honest when there is nothing on file", async () => {
  const { config } = mockApplyGo();
  const result = (await findTool("get_application_status")!.run(config, { company: "Nonexistent" })) as any;
  assert.equal(result.found, false);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

test("get_pipeline_summary labels its units and never mixes companies with jobs", async () => {
  const { config } = mockApplyGo();
  const result = (await findTool("get_pipeline_summary")!.run(config, {})) as any;
  assert.equal(result.companies.unit, "companies");
  assert.equal(result.jobs.unit, "jobs");
  assert.equal(result.companies.discovered, 3);
  assert.equal(result.companies.verified, 2);
  // The shared handoff number, reported in jobs because that is what it counts.
  assert.equal(result.jobs.waiting_in_prescreen, 722);
});

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

test("shapeCompany exposes both axes and drops empty fields rather than emitting nulls", () => {
  const shaped = shapeCompany(COMPANIES.companies[2] as Record<string, unknown>);
  assert.equal(shaped.identity_status, "unresolved");
  assert.equal(shaped.job_source_status, "pending");
  assert.equal(shaped.website, undefined);
  assert.equal(shaped.location, undefined);
});

test("shapeJob never leaks internal columns the model has no use for", () => {
  const shaped = shapeJob(JOBS.jobs[0] as Record<string, unknown>, true);
  for (const leaked of ["company_id", "external_id", "raw_description_hash", "screened_at"]) {
    assert.equal(shaped[leaked], undefined);
  }
  assert.equal(shaped.description, "Full description here");
});
