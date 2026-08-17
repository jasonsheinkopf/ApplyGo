-- Per-job requirement/evidence analysis for Interested jobs, plus linking Improve questions back
-- to the jobs that raised them.
--
-- "Analyze per job, question globally": each Interested job gets its own persisted answer to "what
-- does this employer want, and what evidence does this candidate have for it", reusing the
-- existing requirement-extraction/evidence-plan pipeline (src/philosophy.ts's extractJobRequirements
-- and planEvidence, already built for resume tailoring -- see loadEvidencePlan in src/index.ts).
-- Candidate questions, however, stay centralized in profile_improvement_questions (0029) rather than
-- living here, because the same piece of evidence can resolve the same gap across many jobs at once.

CREATE TABLE IF NOT EXISTS job_requirement_coverage (
  job_id TEXT PRIMARY KEY REFERENCES job_postings(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  -- Serialized philosophy.ts EvidencePlan: role_summary/requirements come along for free inside the
  -- cached requirements, and coverage[] carries the proven/partial/unproven verdict + evidence per
  -- requirement -- this app's existing three-tier stand-in for
  -- SUPPORTED/PARTIALLY_SUPPORTED/UNKNOWN-or-NOT_SUPPORTED.
  plan_json TEXT NOT NULL DEFAULT '{}',
  -- Same fingerprint profile_improvement_questions uses (profileVersionTag), so a later profile
  -- change can be detected without diffing the whole structured record.
  profile_version TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  -- pending: not yet analyzed (no provider configured when marked Interested, or analysis still
  -- running). ready: plan_json holds a usable analysis. failed: the LLM call errored; the job stays
  -- usable, just without a coverage indicator, and a later view can retry.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_requirement_coverage_profile ON job_requirement_coverage(profile_id);

-- Which Interested jobs' gaps a given Improve question was raised for, so answering it can trigger
-- a targeted re-check of just those jobs' coverage instead of every Interested job, and so clicking
-- an Interested card's "N profile improvements available" can jump to the questions that matter for
-- that specific job. A question with no related jobs is an ordinary profile-wide gap, same as before
-- this migration existed.
ALTER TABLE profile_improvement_questions ADD COLUMN related_job_ids TEXT NOT NULL DEFAULT '[]';
