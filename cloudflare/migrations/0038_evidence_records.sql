-- The evidence layer: what was measured, what was decided, and the trail between them.
--
-- The harness already records eval_runs and eval_experiments -- one prompt, one model, one score.
-- That is enough to answer "which variant won" while an experiment is in front of you, and not
-- enough to answer the questions that matter months later: why is the pipeline configured this
-- way, what did we try that failed, can this chart be rebuilt, what evidence made us change our
-- minds. Those answers were living in conversation transcripts, which are not queryable and not
-- durable.
--
-- Two tables, deliberately separate:
--
--   evidence_records  -- a measurement. What was asked, how it was measured, over what sample,
--                        with the numbers preserved in structured form rather than prose.
--   decision_records  -- a change that was made, pointing at the evidence that caused it.
--
-- They are separate because the mapping is many-to-many and the lifecycles differ: evidence
-- outlives the decision it prompted, one decision can rest on several measurements, and a
-- measurement can later be *contradicted* by a better one without rewriting the decision history.
-- Collapsing them into one table would make "what did we believe at the time" unrecoverable.

CREATE TABLE IF NOT EXISTS evidence_records (
  id TEXT PRIMARY KEY,
  -- Stable human-readable handle, e.g. 'ev-2026-08-30-reason-tier-sonnet-vs-terra'. Decisions and
  -- reports cite this rather than a UUID, so a narrative summary stays traceable to its source.
  slug TEXT NOT NULL UNIQUE,
  -- model_comparison | prompt_experiment | coverage_expansion | defect_measurement |
  -- cost_measurement | calibration. Free text rather than a CHECK constraint: a new kind of
  -- measurement should not require a migration before it can be recorded.
  kind TEXT NOT NULL,
  -- The question this set out to answer, written before the numbers were known.
  question TEXT NOT NULL,
  -- How it was measured, in enough detail to run it again: the configurations compared, the
  -- filters and thresholds, the model ids, the prompt or template versions.
  method TEXT NOT NULL DEFAULT '',
  -- What was measured over. Kept as a count AND a description, because "24 postings" and "24
  -- postings spanning scores 60-90 on a 3,266-posting board" support very different claims.
  sample_size INTEGER NOT NULL DEFAULT 0,
  sample_description TEXT NOT NULL DEFAULT '',
  -- The numbers, structured. This is the column that makes a chart reproducible: the aggregates a
  -- report quotes, and per-item rows where the per-item detail is the point. Prose belongs in
  -- `conclusion`; anything a graph is drawn from belongs here.
  metrics_json TEXT NOT NULL DEFAULT '{}',
  -- A handful of illustrative cases, so a reader can sanity-check the aggregate against reality.
  examples_json TEXT NOT NULL DEFAULT '[]',
  -- What was concluded, and how strongly. Confidence is recorded separately from the conclusion so
  -- a tentative finding cannot be quoted later as if it had been definitive.
  conclusion TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'low',      -- low | medium | high
  limitations TEXT NOT NULL DEFAULT '',
  -- Provenance: run ids, experiment ids, job posting ids, git sha, PR numbers, deployment.
  provenance_json TEXT NOT NULL DEFAULT '{}',
  -- Set when a later measurement overturns this one. The row is never deleted or edited to match
  -- the new finding -- being able to see that we once believed something else is the point.
  superseded_by TEXT,
  -- Career/interview value. Flagged sparingly and by exception: routine execution is not evidence
  -- of anything, and a marker that is always true carries no signal. See the columns below.
  career_evidence_candidate INTEGER NOT NULL DEFAULT 0,
  career_evidence_type TEXT NOT NULL DEFAULT '',
  career_evidence_strength TEXT NOT NULL DEFAULT '',
  career_evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_evidence_kind ON evidence_records(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_career ON evidence_records(career_evidence_candidate, career_evidence_strength);

CREATE TABLE IF NOT EXISTS decision_records (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  -- What changed, in the imperative: 'Stop rejecting every title containing "Lead"'.
  summary TEXT NOT NULL,
  -- Which part of the system: profile_rule | model_config | prompt | pipeline_code | schema |
  -- discovery.
  area TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  -- Evidence slugs, as a JSON array. The link that makes "why did we do this" answerable.
  evidence_slugs_json TEXT NOT NULL DEFAULT '[]',
  -- What else was on the table. Recorded because a decision with no alternatives reads as
  -- inevitable in hindsight, and the discarded option is often the more informative half.
  alternatives TEXT NOT NULL DEFAULT '',
  expected_benefit TEXT NOT NULL DEFAULT '',
  -- Filled in later, once the change has been running long enough to have an effect. Deliberately
  -- separate from expected_benefit so the two can disagree -- a prediction that did not come true
  -- is worth more than one quietly rewritten to match.
  observed_result TEXT NOT NULL DEFAULT '',
  -- Who or what made the call: human | agent | agent_with_human_approval.
  decided_by TEXT NOT NULL DEFAULT 'agent',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  reverted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_decision_area ON decision_records(area, created_at DESC);

-- Judge metadata on eval_runs. A judgment whose model, rubric and prompt version are unknown
-- cannot be compared against a later judgment, which makes it unusable for exactly the purpose a
-- judge exists to serve: adjudicating between two things that deterministic metrics cannot split.
ALTER TABLE eval_runs ADD COLUMN judge_model TEXT NOT NULL DEFAULT '';
ALTER TABLE eval_runs ADD COLUMN judge_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE eval_runs ADD COLUMN judge_rubric TEXT NOT NULL DEFAULT '';
-- Structured judge output: per-dimension scores, decisive evidence, weaknesses, and whether the
-- judge thought the evidence was sufficient at all. An overall preference with no dimensions
-- behind it is an opinion, not an adjudication.
ALTER TABLE eval_runs ADD COLUMN judge_detail_json TEXT NOT NULL DEFAULT '{}';
-- Which arm was shown first. Recorded so positional bias is measurable rather than assumed absent.
ALTER TABLE eval_runs ADD COLUMN judge_presentation_order TEXT NOT NULL DEFAULT '';
