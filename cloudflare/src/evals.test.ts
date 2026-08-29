import assert from "node:assert/strict";
import test from "node:test";

import {
  type ScoredRun,
  caseIsExperimentReady,
  screenCaseBatches,
  screenCaseNotes,
  summarizeExperiment,
} from "./evals.ts";

/** Terse fixture builder -- most tests only care about case, variant and score. */
function run(case_id: string, variant: string, judge_score: number | null, extra: Partial<ScoredRun> = {}): ScoredRun {
  return { case_id, variant, ok: 1, judge_score, cost_usd: 0.01, latency_ms: 1000, ...extra };
}

// ---------------------------------------------------------------------------
// Per-variant statistics
// ---------------------------------------------------------------------------

test("each variant reports count, mean, median and spread over its scored runs", () => {
  const { variants } = summarizeExperiment([
    run("a", "control", 40),
    run("b", "control", 60),
    run("c", "control", 80),
  ]);
  const control = variants[0];
  assert.equal(control.scored, 3);
  assert.equal(control.mean_score, 60);
  assert.equal(control.median_score, 60);
  assert.equal(control.stdev_score, 16.33);
});

test("failed runs are counted separately and never fold into the score statistics", () => {
  const { variants } = summarizeExperiment([
    run("a", "control", 90),
    run("b", "control", null, { ok: 0 }),
    run("c", "control", null, { ok: 0 }),
  ]);
  assert.equal(variants[0].scored, 1);
  assert.equal(variants[0].failed, 2);
  assert.equal(variants[0].mean_score, 90, "a failed run must not drag the mean toward zero");
});

test("the control variant sorts first however the labels compare alphabetically", () => {
  const { variants } = summarizeExperiment([run("a", "zebra", 50), run("a", "control", 50)]);
  assert.deepEqual(variants.map((v) => v.variant), ["control", "zebra"]);
});

test("a single scored run has a mean but no spread, rather than a spread of zero", () => {
  const { variants } = summarizeExperiment([run("a", "control", 70)]);
  assert.equal(variants[0].mean_score, 70);
  assert.equal(variants[0].stdev_score, null, "one sample cannot evidence consistency");
});

// ---------------------------------------------------------------------------
// Head-to-head pairing
// ---------------------------------------------------------------------------

test("head-to-head counts wins, losses and ties against the control", () => {
  const { head_to_head } = summarizeExperiment([
    run("a", "control", 50), run("a", "candidate", 70),
    run("b", "control", 60), run("b", "candidate", 40),
    run("c", "control", 80), run("c", "candidate", 80),
  ]);
  const [candidate] = head_to_head;
  assert.equal(candidate.wins, 1);
  assert.equal(candidate.losses, 1);
  assert.equal(candidate.ties, 1);
  assert.equal(candidate.paired, 3);
  assert.equal(candidate.mean_delta, 0);
});

test("a case only one arm scored is excluded, so failing the hard cases cannot inflate a variant", () => {
  // The candidate scores brilliantly on the easy case and errors on the hard one. An unpaired
  // mean would read 95 vs 50 and call it a triumph; pairing correctly reports a single case.
  const { head_to_head, variants } = summarizeExperiment([
    run("easy", "control", 50), run("easy", "candidate", 95),
    run("hard", "control", 50), run("hard", "candidate", null, { ok: 0 }),
  ]);
  assert.equal(head_to_head[0].paired, 1, "only the case both arms scored may be compared");
  assert.equal(head_to_head[0].mean_delta, 45);
  assert.equal(variants.find((v) => v.variant === "candidate")?.failed, 1);
});

test("no overlapping cases yields an empty comparison rather than a fabricated one", () => {
  const { head_to_head } = summarizeExperiment([
    run("a", "control", 50),
    run("b", "candidate", 90),
  ]);
  assert.equal(head_to_head[0].paired, 0);
  assert.equal(head_to_head[0].mean_delta, null);
});

test("several candidates are each compared against the same control", () => {
  const { head_to_head } = summarizeExperiment([
    run("a", "control", 50), run("a", "v1", 60), run("a", "v2", 40),
  ]);
  assert.deepEqual(head_to_head.map((h) => h.variant).sort(), ["v1", "v2"]);
});

// ---------------------------------------------------------------------------
// Verdict — the part that decides whether a change ships
// ---------------------------------------------------------------------------

/** Ten paired cases where the candidate leads by a fixed margin. */
function paired(margin: number, n = 10): ScoredRun[] {
  return Array.from({ length: n }, (_, i) => [
    run(`case${i}`, "control", 50),
    run(`case${i}`, "candidate", 50 + margin),
  ]).flat();
}

test("a thin sample is refused as a result no matter how large the gap looks", () => {
  const summary = summarizeExperiment(paired(40, 3));
  assert.match(summary.verdict, /too few to call/);
  assert.doesNotMatch(summary.verdict, /better by/);
});

test("a gap inside judge noise is reported as a wash, not a narrow win", () => {
  const summary = summarizeExperiment(paired(2));
  assert.match(summary.verdict, /no meaningful difference/);
});

test("a clear improvement over enough cases is called a win, with the record attached", () => {
  const summary = summarizeExperiment(paired(15));
  assert.match(summary.verdict, /better by 15 points/);
  assert.match(summary.verdict, /10W\/0L\/0T over 10 cases/);
});

test("a clear regression is named as one rather than softened", () => {
  const summary = summarizeExperiment(paired(-20));
  assert.match(summary.verdict, /worse by 20 points/);
});

test("an experiment with only a control says so instead of claiming a result", () => {
  const summary = summarizeExperiment([run("a", "control", 50)]);
  assert.match(summary.verdict, /No candidate variant/);
});

test("an empty experiment produces an empty summary rather than throwing", () => {
  const summary = summarizeExperiment([]);
  assert.deepEqual(summary.variants, []);
  assert.deepEqual(summary.head_to_head, []);
});

// ---------------------------------------------------------------------------
// Cases that can actually take part in an experiment
// ---------------------------------------------------------------------------

test("a case without recorded inputs is not experiment-ready", () => {
  // Every case created before migration 0037's columns were written looks like this. It replays
  // fine against another model; it cannot be rendered through another wording.
  assert.equal(caseIsExperimentReady({ variables_json: "{}" }), false);
  assert.equal(caseIsExperimentReady({ variables_json: "" }), false);
  assert.equal(caseIsExperimentReady({ variables_json: null }), false);
  assert.equal(caseIsExperimentReady({ variables_json: "not json" }), false);
});

test("a case carrying its inputs is experiment-ready", () => {
  assert.equal(caseIsExperimentReady({ variables_json: '{"postings":"[]"}' }), true);
});

// ---------------------------------------------------------------------------
// Batching -- the part that decides whether the eval measures anything
// ---------------------------------------------------------------------------

function labelled(n: number, label: "keep" | "drop"): ScreenCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${label}-${i}`,
    title: `${label} title ${i}`,
    location: "San Francisco, CA",
    label,
    why: "test fixture",
  }));
}
type ScreenCase = Parameters<typeof screenCaseBatches>[0][number];

test("every batch contains both labels, so keeping everything cannot score perfectly", () => {
  const batches = screenCaseBatches([...labelled(9, "keep"), ...labelled(9, "drop")], 6);
  assert.ok(batches.length > 0);
  for (const batch of batches) {
    assert.ok(batch.some((p) => p.label === "keep"), "a batch of only drops rewards dropping everything");
    assert.ok(batch.some((p) => p.label === "drop"), "a batch of only keeps rewards keeping everything");
  }
});

test("no batch is emitted when one label is missing entirely", () => {
  assert.deepEqual(screenCaseBatches(labelled(20, "keep"), 5), []);
  assert.deepEqual(screenCaseBatches(labelled(20, "drop"), 5), []);
  assert.deepEqual(screenCaseBatches([], 5), []);
});

test("a scarce label is spread across batches rather than spent on the first one", () => {
  // Two drops among many keeps must produce two usable batches, not one batch holding both.
  const batches = screenCaseBatches([...labelled(12, "keep"), ...labelled(2, "drop")], 6);
  assert.equal(batches.length, 2);
  for (const batch of batches) {
    assert.equal(batch.filter((p) => p.label === "drop").length, 1);
  }
});

test("batches respect the requested size", () => {
  const batches = screenCaseBatches([...labelled(10, "keep"), ...labelled(10, "drop")], 4);
  for (const batch of batches) assert.ok(batch.length <= 4, `batch of ${batch.length} exceeds 4`);
});

// ---------------------------------------------------------------------------
// The grading key handed to the judge
// ---------------------------------------------------------------------------

test("the grading key names every posting under the verdict it should have received", () => {
  const batch = [...labelled(2, "keep"), ...labelled(1, "drop")];
  const notes = screenCaseNotes(batch);
  const mustKeep = notes.slice(notes.indexOf("MUST KEEP"), notes.indexOf("SHOULD DROP"));
  const shouldDrop = notes.slice(notes.indexOf("SHOULD DROP"));
  assert.ok(mustKeep.includes("keep-0") && mustKeep.includes("keep-1"));
  assert.ok(shouldDrop.includes("drop-0"));
  assert.ok(!mustKeep.includes("drop-0"), "a should-drop must not appear under MUST KEEP");
});

test("the grading key states the asymmetry, and refuses to reward keeping everything", () => {
  const notes = screenCaseNotes([...labelled(1, "keep"), ...labelled(1, "drop")]);
  assert.match(notes, /permanently/, "a wrong drop is the permanent error and must be named as such");
  assert.match(notes, /keeps everything is not a good response/);
});
