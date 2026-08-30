import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRequirements } from "./philosophy.ts";

test("normalizeRequirements recovers the double-encoded shape observed live in llm_traces", () => {
  // Captured verbatim from a real resume.requirements trace (task=resume.requirements,
  // model=claude-sonnet-5): the model wrapped its whole answer as a JSON string under a
  // top-level "requirements" key instead of matching the schema flatly. Before the fix,
  // `for (const item of raw.requirements ?? [])` iterated the string's characters and every
  // requirement silently vanished -- normalizeRequirements returned zero requirements for a
  // job description that plainly had many.
  const raw = {
    requirements:
      '{"role_summary": "Build and scale technical demo experiences.", "requirements": [' +
      '{"text": "Build prototypes, LLM agents, and reference flows", "kind": "responsibility"},' +
      '{"text": "Strong engineering depth across software architectures", "kind": "must_have"},' +
      '{"text": "Based in San Francisco, CA with hybrid work model", "kind": "must_have"}' +
      "]}",
  };

  const result = normalizeRequirements(raw);

  assert.equal(result.role_summary, "Build and scale technical demo experiences.");
  assert.equal(result.requirements.length, 3);
  assert.equal(result.requirements[0].text, "Build prototypes, LLM agents, and reference flows");
  assert.equal(result.requirements[0].kind, "responsibility");
  assert.equal(result.requirements[1].kind, "must_have");
});

test("normalizeRequirements still handles the normal, flat shape", () => {
  const result = normalizeRequirements({
    role_summary: "A normal role.",
    requirements: [
      { text: "Python", kind: "must_have" },
      { text: "SQL", kind: "must_have" },
    ],
  });
  assert.equal(result.requirements.length, 2);
  assert.equal(result.requirements[1].text, "SQL");
});

test("normalizeRequirements returns empty, not throws, on unparseable garbage", () => {
  const result = normalizeRequirements({ role_summary: "x", requirements: "not json at all" });
  assert.deepEqual(result.requirements, []);
  assert.equal(result.role_summary, "x");
});

test("normalizeRequirements dedupes and caps at 25 in the repaired shape too", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ text: `req ${i}`, kind: "responsibility" }));
  const raw = { requirements: JSON.stringify({ role_summary: "", requirements: many }) };
  const result = normalizeRequirements(raw);
  assert.equal(result.requirements.length, 25);
});
