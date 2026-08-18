-- Interested-job "Analyze Job" evidence-gap workflow: two small additive pieces on top of the
-- existing job_requirement_coverage (0033) + profile_improvement_questions (0029) machinery.
--
-- confirmed_no distinguishes "the candidate explicitly said they don't have this experience" from
-- plain 'dismissed' (skip -- "I don't want to answer this right now"). Both leave the question out
-- of the open set, but only a confirmed_no is a genuine, durable qualification gap that should keep
-- showing as such rather than reading as "not yet asked". See dismissImproveQuestion in src/index.ts.
ALTER TABLE profile_improvement_questions ADD COLUMN confirmed_no INTEGER NOT NULL DEFAULT 0;

-- Lets the Interested-job workspace show "72% -> 81%" after a re-analysis pass integrates newly
-- captured evidence, without a separate history table -- one prior snapshot is all the UI needs.
-- Left NULL until the first recompute, so an ordinary (pipeline-assessed) score is never mistaken
-- for having gone through Re-analyze Job. See recomputeJobFit in src/index.ts.
ALTER TABLE job_postings ADD COLUMN fit_score_previous INTEGER;
ALTER TABLE job_postings ADD COLUMN fit_reason_previous TEXT NOT NULL DEFAULT '';
ALTER TABLE job_postings ADD COLUMN fit_reassessed_at TEXT;
