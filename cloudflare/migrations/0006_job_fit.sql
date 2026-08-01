-- Fit assessment: a keyword/location match is not the same as being a plausible candidate for a
-- role. Every scanned posting gets a verdict comparing its actual requirements against the
-- candidate's structured profile, so the Jobs tab can default to hiding postings that require
-- something the candidate evidently doesn't have (a language, a degree, years of experience)
-- instead of making the user triage every irrelevant result by hand.
ALTER TABLE job_postings ADD COLUMN fit_status TEXT NOT NULL DEFAULT 'unassessed';
ALTER TABLE job_postings ADD COLUMN fit_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE job_postings ADD COLUMN fit_missing_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE job_postings ADD COLUMN assessed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_fit_status ON job_postings(fit_status);

-- User-confirmed reasons a job wasn't a fit. Deliberately separate from the AI's own per-job
-- fit_reason: only a reason the *user* submits (typically confirming or editing what the AI
-- said) becomes a durable signal fed back into future assessments, so an AI misjudgment can't
-- reinforce itself into a permanent rule. job_id is nullable and detaches on delete so removing
-- a job from the list never loses the reason it taught the system.
CREATE TABLE IF NOT EXISTS job_feedback (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES job_postings(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_feedback_profile ON job_feedback(profile_id, created_at DESC);
