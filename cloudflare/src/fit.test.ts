import assert from "node:assert/strict";
import test from "node:test";

import { assessPriorityOrder, titleTermsFromRoles, verdictForScore } from "./fit.ts";

// ---------------------------------------------------------------------------
// Title terms
// ---------------------------------------------------------------------------

const ROLES = `## AI Solutions Engineer  [PRIORITY 1]
Also posted as: Solutions Engineer, Customer Engineer
Seniority: Mid to senior
Title terms: Solutions Engineer, Solutions Architect, Customer Engineer
Keywords: customer-facing, solution design

## Agentic AI Engineer  [PRIORITY 1]
Title terms: Agent, Agentic, LLM Engineer
Must have: Agent or LLM orchestration work`;

test("title terms are collected from every lane in the roles document", () => {
  assert.deepEqual(titleTermsFromRoles(ROLES), [
    "solutions engineer",
    "solutions architect",
    "customer engineer",
    "agent",
    "agentic",
    "llm engineer",
  ]);
});

test("only the Title terms lines are read, not the neighbouring Also-posted-as or Keywords lines", () => {
  const terms = titleTermsFromRoles(ROLES);
  assert.equal(terms.includes("customer-facing"), false);
  assert.equal(terms.includes("mid to senior"), false);
  assert.equal(terms.includes("agent or llm orchestration work"), false);
});

test("duplicate terms across lanes collapse, and one-or-two character fragments are dropped", () => {
  const terms = titleTermsFromRoles("Title terms: AI, Agent, Agent\nTitle terms: Agent, ML");
  assert.deepEqual(terms, ["agent"]);
});

test("a roles document with no title terms yields nothing rather than throwing", () => {
  assert.deepEqual(titleTermsFromRoles("## Some Role\nSeniority: Mid"), []);
  assert.deepEqual(titleTermsFromRoles(""), []);
});

// ---------------------------------------------------------------------------
// Assessment ordering
// ---------------------------------------------------------------------------

/** Applies the generated ORDER BY to rows in memory, the way SQLite would. */
function sortByPriority(titles: string[], terms: string[]): string[] {
  const { binds } = assessPriorityOrder(terms);
  const termBinds = binds.slice(0, terms.length).map((b) => b.replaceAll("%", ""));
  const seniorBinds = binds.slice(terms.length).map((b) => b.replaceAll("%", ""));
  return titles
    .map((title, index) => ({
      title,
      onTarget: termBinds.some((t) => title.toLowerCase().includes(t)) ? 0 : 1,
      senior: seniorBinds.some((s) => title.toLowerCase().includes(s)) ? 1 : 0,
      index,
    }))
    .sort((a, b) => a.onTarget - b.onTarget || a.senior - b.senior || a.index - b.index)
    .map((row) => row.title);
}

test("on-target titles are assessed before everything else, whatever order the board listed them", () => {
  const terms = titleTermsFromRoles(ROLES);
  const boardOrder = [
    "Senior Software Engineer - Database Engine Internals",
    "Senior Software Engineer, Model Serving",
    "Sr. Solutions Architect - Public Sector",
    "Senior Data Scientist",
    "LLM Engineer, Inference",
  ];
  assert.deepEqual(sortByPriority(boardOrder, terms), [
    "Sr. Solutions Architect - Public Sector",
    "LLM Engineer, Inference",
    "Senior Software Engineer - Database Engine Internals",
    "Senior Software Engineer, Model Serving",
    "Senior Data Scientist",
  ]);
});

test("a seniority-marked title sinks below its peers but is still queued, never dropped", () => {
  const terms = titleTermsFromRoles(ROLES);
  const sorted = sortByPriority(
    ["Staff Solutions Architect", "Solutions Architect", "Principal Customer Engineer"],
    terms,
  );
  assert.deepEqual(sorted, ["Solutions Architect", "Staff Solutions Architect", "Principal Customer Engineer"]);
  assert.equal(sorted.length, 3, "ordering must not remove rows");
});

test("the fragment binds one parameter per LIKE, so no title text is ever interpolated into SQL", () => {
  const { sql, binds } = assessPriorityOrder(["solutions engineer", "agent"]);
  assert.equal((sql.match(/LIKE \?/g) ?? []).length, binds.length);
  assert.equal(sql.includes("solutions engineer"), false);
  assert.match(sql, /^ORDER BY /);
  assert.match(sql, /created_at ASC$/);
});

test("no title terms still produces valid SQL that falls back to the seniority and age ordering", () => {
  const { sql, binds } = assessPriorityOrder([]);
  assert.match(sql, /CASE WHEN 0 THEN 0 ELSE 1 END/);
  assert.equal((sql.match(/LIKE \?/g) ?? []).length, binds.length);
});

// ---------------------------------------------------------------------------
// Verdict banding, which the ordering above feeds
// ---------------------------------------------------------------------------

test("score bands map to the verdicts the Jobs tab filters on", () => {
  assert.equal(verdictForScore(70), "strong");
  assert.equal(verdictForScore(69), "possible");
  assert.equal(verdictForScore(40), "possible");
  assert.equal(verdictForScore(39), "reject");
  assert.equal(verdictForScore(0), "reject");
});
