import assert from "node:assert/strict";
import test from "node:test";

import { pickJudgeProvider, selectDisagreements } from "./evidence.ts";

// ---------------------------------------------------------------------------
// Spending the judge budget where it can still change a decision
// ---------------------------------------------------------------------------

type Row = { case_id: string; a: number | null; b: number | null };
const read = (r: Row) => r;

test("cases the two arms broadly agree on are not sent to a judge", () => {
  // 78 vs 76 is inside judge noise; paying to adjudicate it buys nothing.
  const picked = selectDisagreements<Row>(
    [{ case_id: "close", a: 78, b: 76 }, { case_id: "far", a: 80, b: 18 }],
    read,
  );
  assert.deepEqual(picked.map((p) => p.case_id), ["far"]);
});

test("the widest disagreements come first, because that is where the budget belongs", () => {
  const picked = selectDisagreements<Row>(
    [
      { case_id: "gap25", a: 70, b: 45 },
      { case_id: "gap62", a: 80, b: 18 },
      { case_id: "gap39", a: 54, b: 15 },
    ],
    read,
  );
  assert.deepEqual(picked.map((p) => p.case_id), ["gap62", "gap39", "gap25"]);
});

test("a case only one arm scored is skipped rather than treated as disagreement", () => {
  // Otherwise a failed run in one arm becomes a quality signal about the other, which is exactly
  // the trap the paired statistics elsewhere exist to avoid.
  const picked = selectDisagreements<Row>(
    [{ case_id: "half", a: 90, b: null }, { case_id: "none", a: null, b: null }],
    read,
  );
  assert.deepEqual(picked, []);
});

test("the number of adjudications is capped, so cost stays bounded by choice not by luck", () => {
  const many: Row[] = Array.from({ length: 40 }, (_, i) => ({ case_id: `c${i}`, a: 90, b: 10 }));
  assert.equal(selectDisagreements<Row>(many, read, { limit: 5 }).length, 5);
});

test("the disagreement threshold is configurable for a task with a different noise floor", () => {
  const rows: Row[] = [{ case_id: "gap10", a: 60, b: 50 }];
  assert.equal(selectDisagreements<Row>(rows, read).length, 0, "default 20-point floor excludes it");
  assert.equal(selectDisagreements<Row>(rows, read, { minGap: 8 }).length, 1);
});

// ---------------------------------------------------------------------------
// Which model judges is configuration, not architecture
// ---------------------------------------------------------------------------

test("the requested judge is used when its key is configured", () => {
  const env = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" };
  assert.equal(pickJudgeProvider(env, "openai"), "openai");
  assert.equal(pickJudgeProvider(env, "anthropic"), "anthropic");
  assert.equal(pickJudgeProvider(env), "anthropic", "defaults to one judge so runs stay comparable");
});

test("a judge with no key falls back rather than leaving the comparison unjudged", () => {
  // An unjudged comparison is worth nothing; one judged by the other vendor is at least labelled.
  assert.equal(pickJudgeProvider({ OPENAI_API_KEY: "k" }), "openai");
  assert.equal(pickJudgeProvider({ ANTHROPIC_API_KEY: "k" }, "openai"), "anthropic");
});
