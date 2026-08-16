import assert from "node:assert/strict";
import test from "node:test";

import {
  type CompanyState,
  canHaveJobSource,
  explainState,
  isScannable,
  reconcileCompanyState,
  stateViolations,
} from "./companystate.ts";

const state = (overrides: Partial<CompanyState> = {}): CompanyState => ({
  identity: "pending",
  jobSource: "pending",
  website: "",
  websiteConfidence: null,
  websiteEvidence: "",
  boardUrl: "",
  atsProvider: "",
  atsToken: "",
  ...overrides,
});

const verified = (overrides: Partial<CompanyState> = {}) =>
  state({ identity: "verified", website: "https://acme.com", ...overrides });

// ---------------------------------------------------------------------------
// The core architectural correction
// ---------------------------------------------------------------------------

test("a company with a confirmed website stays VERIFIED even when its ATS is unsupported", () => {
  // This is the whole point of the split. Previously this row read "unverified", which said the
  // employer was in doubt when in fact only ApplyGo's reach was.
  const s = verified({ jobSource: "unsupported_ats", atsProvider: "icims", boardUrl: "https://acme.icims.com" });
  assert.deepEqual(stateViolations(s), []);
  assert.equal(s.identity, "verified");
  assert.equal(reconcileCompanyState(s).repaired.length, 0);
});

test("an unsupported ATS is described as an ApplyGo limitation, not a company defect", () => {
  const text = explainState({ identity: "verified", jobSource: "unsupported_ats", atsProvider: "iCIMS" });
  assert.match(text, /ApplyGo cannot read/i);
  assert.match(text, /Website confirmed/i);
});

test("only a verified identity can have a job source at all", () => {
  assert.equal(canHaveJobSource("verified"), true);
  for (const identity of ["pending", "ambiguous", "unresolved", "not_a_company", "dismissed"] as const) {
    assert.equal(canHaveJobSource(identity), false, identity);
  }
});

test("isScannable requires both axes to be good", () => {
  assert.equal(isScannable({ identity: "verified", jobSource: "supported" }), true);
  assert.equal(isScannable({ identity: "verified", jobSource: "unsupported_ats" }), false);
  assert.equal(isScannable({ identity: "ambiguous", jobSource: "supported" }), false);
});

// ---------------------------------------------------------------------------
// Invariants: contradictions must be structurally impossible
// ---------------------------------------------------------------------------

test("a stored board URL alongside 'no job board' is a violation -- the exact reported UI bug", () => {
  const s = verified({ jobSource: "no_board", boardUrl: "https://job-boards.greenhouse.io/acme" });
  assert.ok(stateViolations(s).some((v) => /no_board but a board URL/.test(v)));
});

test("reconcile repairs board-URL-vs-no_board by trusting the URL, which is the fact", () => {
  const { state: fixed, repaired } = reconcileCompanyState(
    verified({ jobSource: "no_board", boardUrl: "https://acme.icims.com", atsProvider: "icims" }),
  );
  assert.equal(fixed.jobSource, "unsupported_ats", "a known provider with a URL is unsupported_ats, not no_board");
  assert.ok(repaired.length > 0);
  assert.deepEqual(stateViolations(fixed), []);
});

test("a careers URL with no identified provider repairs to careers_only, never no_board", () => {
  // Nine real rows looked like this: a working careers URL filed as "no job board found". The URL
  // is the useful thing to show, so the state has to admit it exists.
  const { state: fixed } = reconcileCompanyState(verified({ jobSource: "no_board", boardUrl: "https://acme.com/careers" }));
  assert.equal(fixed.jobSource, "careers_only");
  assert.deepEqual(stateViolations(fixed), []);
});

test("careers_only without a URL collapses back to no_board", () => {
  const { state: fixed } = reconcileCompanyState(verified({ jobSource: "careers_only" }));
  assert.equal(fixed.jobSource, "no_board");
  assert.deepEqual(stateViolations(fixed), []);
});

test("verified-without-a-website is a violation and repairs to unresolved", () => {
  const s = state({ identity: "verified" });
  assert.ok(stateViolations(s).some((v) => /verified but no website/.test(v)));
  assert.equal(reconcileCompanyState(s).state.identity, "unresolved");
});

test("unresolved-with-a-website repairs to ambiguous rather than silently claiming verified", () => {
  // Promoting it to verified would accept an unproven domain, which is the failure mode the
  // resolver's evidence check exists to prevent. Ambiguous is the honest state.
  const { state: fixed } = reconcileCompanyState(state({ identity: "unresolved", website: "https://maybe.com" }));
  assert.equal(fixed.identity, "ambiguous");
  assert.deepEqual(stateViolations(fixed), []);
});

test("a job source on a non-verified identity is reset to pending", () => {
  const { state: fixed, repaired } = reconcileCompanyState(state({ identity: "unresolved", jobSource: "supported", atsProvider: "greenhouse" }));
  assert.equal(fixed.jobSource, "pending");
  assert.ok(repaired.some((r) => /cannot have one|-> pending/.test(r)));
});

test("'supported' without an identified provider cannot stand", () => {
  const { state: fixed } = reconcileCompanyState(verified({ jobSource: "supported" }));
  assert.notEqual(fixed.jobSource, "supported");
  assert.deepEqual(stateViolations(fixed), []);
});

test("website confidence is clamped into 0-100", () => {
  assert.equal(reconcileCompanyState(verified({ websiteConfidence: 140 })).state.websiteConfidence, 100);
  assert.equal(reconcileCompanyState(verified({ websiteConfidence: -5 })).state.websiteConfidence, 0);
});

test("dismissed wins over everything and preserves the evidence underneath", () => {
  const s = state({ identity: "dismissed", website: "https://acme.com", boardUrl: "https://acme.com/jobs", atsProvider: "greenhouse" });
  const { state: fixed } = reconcileCompanyState(s);
  assert.equal(fixed.identity, "dismissed");
  // Re-adding must not require re-resolving the company from scratch.
  assert.equal(fixed.website, "https://acme.com");
  assert.equal(fixed.boardUrl, "https://acme.com/jobs");
});

test("reconcile is idempotent -- a repaired state repairs to itself", () => {
  const messy = verified({ jobSource: "no_board", boardUrl: "https://acme.icims.com", atsProvider: "icims", websiteConfidence: 250 });
  const once = reconcileCompanyState(messy).state;
  const twice = reconcileCompanyState(once);
  assert.deepEqual(twice.state, once);
  assert.deepEqual(twice.repaired, [], "a second pass must find nothing left to fix");
});

test("every legal state combination is violation-free", () => {
  const legal: CompanyState[] = [
    state(),
    state({ identity: "unresolved" }),
    state({ identity: "ambiguous", website: "https://maybe.com", websiteConfidence: 40 }),
    state({ identity: "not_a_company" }),
    state({ identity: "dismissed" }),
    verified(),
    verified({ jobSource: "supported", atsProvider: "greenhouse", atsToken: "acme", boardUrl: "https://job-boards.greenhouse.io/acme" }),
    verified({ jobSource: "unsupported_ats", atsProvider: "icims", boardUrl: "https://acme.icims.com" }),
    verified({ jobSource: "no_board" }),
    verified({ jobSource: "careers_only", boardUrl: "https://acme.com/careers" }),
    verified({ jobSource: "board_unreachable", atsProvider: "greenhouse", boardUrl: "https://job-boards.greenhouse.io/acme" }),
  ];
  for (const s of legal) {
    assert.deepEqual(stateViolations(s), [], JSON.stringify({ identity: s.identity, jobSource: s.jobSource }));
  }
});
