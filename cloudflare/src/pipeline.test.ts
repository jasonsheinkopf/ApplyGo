import assert from "node:assert/strict";
import test from "node:test";

import {
  type CompanyCounts,
  PRESCREEN_PREDICATE,
  companyFunnel,
  companyToJobHandoff,
  funnelViolations,
  runSummaryLine,
} from "./pipeline.ts";

const counts = (overrides: Partial<CompanyCounts> = {}): CompanyCounts => ({
  identity_pending: 0,
  identity_verified: 0,
  identity_ambiguous: 0,
  identity_unresolved: 0,
  identity_not_a_company: 0,
  identity_dismissed: 0,
  source_pending: 0,
  source_supported: 0,
  source_unsupported_ats: 0,
  source_careers_only: 0,
  source_no_board: 0,
  source_board_unreachable: 0,
  discovery_postings: 0,
  total: 0,
  ...overrides,
});

/** The shape of the real local database after migrations 0030/0031. */
const REAL = counts({
  identity_verified: 387,
  identity_unresolved: 139,
  identity_ambiguous: 1,
  source_pending: 329,
  source_supported: 24,
  source_no_board: 19,
  source_careers_only: 7,
  source_unsupported_ats: 7,
  source_board_unreachable: 1,
  discovery_postings: 4200,
  total: 527,
});

test("the funnel reconciles on the real database's numbers", () => {
  assert.deepEqual(funnelViolations(companyFunnel(REAL)), []);
});

test("identity outcomes sum to the companies discovered", () => {
  const [identity] = companyFunnel(REAL);
  assert.equal(identity.total, 527, "387 verified + 139 unresolved + 1 ambiguous");
  assert.equal(identity.outcomes.reduce((a, o) => a + o.count, 0), identity.total);
});

test("the job-source stage takes in the verified count, not the discovered count", () => {
  // Drawing it against the discovered total is the mistake that makes a funnel silently lie:
  // unresolved companies never reach job-source resolution at all.
  const [, jobSource] = companyFunnel(REAL);
  assert.equal(jobSource.total, REAL.identity_verified);
  assert.equal(jobSource.outcomes.reduce((a, o) => a + o.count, 0), jobSource.total);
});

test("funnelViolations catches outcomes that do not sum to their stage total", () => {
  const broken = companyFunnel(REAL);
  broken[0].outcomes[0].count += 5;
  const problems = funnelViolations(broken);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /outcomes sum to \d+ but \d+ entered/);
});

test("funnelViolations catches a stage taking in more than the one before it passed", () => {
  const broken = companyFunnel(REAL);
  broken[1].total += 100;
  assert.ok(funnelViolations(broken).some((p) => /takes in \d+ but .* only passed \d+/.test(p)));
});

test("every stage declares its unit, and company stages are never counted in jobs", () => {
  for (const stage of companyFunnel(REAL)) {
    assert.equal(stage.unit, "companies", `${stage.label} must count companies`);
  }
});

test("the company -> job handoff keeps both units and never subtracts across them", () => {
  const handoff = companyToJobHandoff(REAL, 1842);
  assert.equal(handoff.fromUnit, "companies");
  assert.equal(handoff.toUnit, "jobs");
  assert.equal(handoff.fromCount, 24);
  assert.equal(handoff.toCount, 1842);
  // 24 companies producing 1,842 jobs is a unit change, not a loss or a gain. Nothing in the
  // handoff should ever try to make those two numbers reconcile.
  assert.notEqual(handoff.fromCount, handoff.toCount);
});

test("an empty pipeline still reconciles rather than producing a broken funnel", () => {
  assert.deepEqual(funnelViolations(companyFunnel(counts())), []);
});

test("dismissed companies are excluded from the funnel totals", () => {
  const withDismissed = counts({ ...REAL, identity_dismissed: 40 });
  const [identity] = companyFunnel(withDismissed);
  assert.equal(identity.total, 527, "removing a company must not change what the pipeline found");
  assert.deepEqual(funnelViolations(companyFunnel(withDismissed)), []);
});

test("the run summary labels every number with its unit and never mixes them", () => {
  const line = runSummaryLine(REAL, 1842, false);
  assert.match(line, /527 companies/);
  assert.match(line, /387 verified/);
  assert.match(line, /1842 jobs ready for pre-screen/);
  assert.match(line, /^Completed/);
  assert.match(runSummaryLine(REAL, 1842, true), /^Discovery running/);
});

test("the run summary singularizes correctly", () => {
  const one = counts({ identity_verified: 1, total: 1 });
  const line = runSummaryLine(one, 1, false);
  assert.match(line, /1 company/);
  assert.match(line, /1 job ready/);
});

test("Pre-screen has exactly one definition, shared by both pages", () => {
  // Companies' last node and Jobs' first node are the same rows. If this predicate is ever
  // duplicated instead of imported, the two pages can drift -- which is the bug it prevents.
  assert.match(PRESCREEN_PREDICATE, /company_id IS NOT NULL/);
  assert.match(PRESCREEN_PREDICATE, /fit_status = 'unassessed'/);
});
