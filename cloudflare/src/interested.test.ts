import assert from "node:assert/strict";
import test from "node:test";

import { type InterestedJobGap, relatedJobIdsFor, renderJobRequirementContext, requirementDedupeKey } from "./interested.ts";

function gapMap(entries: [string, InterestedJobGap][]): Map<string, InterestedJobGap> {
  return new Map(entries);
}

test("requirementDedupeKey merges near-duplicate phrasing", () => {
  assert.equal(requirementDedupeKey("SQL"), requirementDedupeKey("sql!"));
  assert.equal(requirementDedupeKey("SQL / relational databases"), requirementDedupeKey("sql relational databases"));
  assert.notEqual(requirementDedupeKey("SQL"), requirementDedupeKey("NoSQL"));
});

test("renderJobRequirementContext returns empty string with no gaps -- keeps general Improve mode unchanged", () => {
  assert.equal(renderJobRequirementContext(new Map()), "");
});

test("renderJobRequirementContext ranks requirements by how many jobs share them", () => {
  const gaps = gapMap([
    ["sql", { requirement: "SQL", kind: "preferred", jobIds: ["a"], jobLabels: ["Acme"] }],
    [
      "public speaking",
      { requirement: "public speaking", kind: "must_have", jobIds: ["b", "c", "d"], jobLabels: ["Beta", "Gamma", "Delta"] },
    ],
  ]);
  const text = renderJobRequirementContext(gaps);
  const speakingIndex = text.indexOf("public speaking");
  const sqlIndex = text.indexOf('"SQL"');
  assert.ok(speakingIndex >= 0 && sqlIndex >= 0);
  assert.ok(speakingIndex < sqlIndex, "the requirement shared by more jobs should be listed first");
  assert.match(text, /wanted by 3 Interested roles/);
  assert.match(text, /wanted by 1 Interested role\b/);
  assert.match(text, /\(required\)/);
  assert.match(text, /\(preferred\/related\)/);
});

test("renderJobRequirementContext never fabricates a requirement it wasn't given", () => {
  const gaps = gapMap([["docker", { requirement: "Docker", kind: "preferred", jobIds: ["a"], jobLabels: ["Acme @ Acme Corp"] }]]);
  const text = renderJobRequirementContext(gaps);
  assert.match(text, /"Docker"/);
  assert.doesNotMatch(text, /Kubernetes/);
});

test("relatedJobIdsFor matches a question to jobs sharing its underlying requirement", () => {
  const gaps = gapMap([
    ["sql relational databases", { requirement: "SQL / relational databases", kind: "preferred", jobIds: ["job-1", "job-2"], jobLabels: ["A", "B"] }],
  ]);
  const question = { category: "sql", target_field: "tools_technologies", question: "Have you worked with SQL or relational databases?" };
  assert.deepEqual(relatedJobIdsFor(question, gaps).sort(), ["job-1", "job-2"]);
});

test("relatedJobIdsFor returns nothing for an unrelated question -- no false badge", () => {
  const gaps = gapMap([["public speaking", { requirement: "public speaking", kind: "must_have", jobIds: ["job-1"], jobLabels: ["A"] }]]);
  const question = { category: "leadership", target_field: "scope_and_scale", question: "How many engineers did you manage?" };
  assert.deepEqual(relatedJobIdsFor(question, gaps), []);
});

test("relatedJobIdsFor ignores short/stopword tokens so it doesn't over-match everything", () => {
  const gaps = gapMap([["sql", { requirement: "SQL", kind: "preferred", jobIds: ["job-1"], jobLabels: ["A"] }]]);
  const question = { category: "other", target_field: "", question: "Did you have to lead this from the start?" };
  assert.deepEqual(relatedJobIdsFor(question, gaps), []);
});
