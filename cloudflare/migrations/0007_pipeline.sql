-- Two-tier job filtering.
--
-- Finding listings is cheap; judging them is not. Sending every scraped posting to a strong
-- model alongside the full candidate profile is the expensive way to do this, so the work is
-- split: a compact profile keeps the input small, a cheap model drops the obvious misses in
-- bulk, and only survivors reach the strong model.
--
-- fit_status is the pipeline's state machine:
--   unassessed   -- scraped, nothing spent on it yet
--   screened_out -- cheap tier said no; kept so re-scans don't re-pay for it
--   screened_in  -- cheap tier said maybe; queued for the strong model
--   strong       -- strong tier: good match          (shown)
--   possible     -- strong tier: worth a look        (shown)
--   reject       -- strong tier or the user said no  (hidden)

-- A short, token-cheap rendering of the profile used for every match call. Derived
-- deterministically from structured_json rather than generated, so it costs nothing and cannot
-- drift out of sync with the profile it describes.
ALTER TABLE candidate_profiles ADD COLUMN match_profile TEXT NOT NULL DEFAULT '';

-- When the cheap tier last ran on a posting, separate from assessed_at so the pipeline can tell
-- "never screened" from "screened, awaiting the strong model".
ALTER TABLE job_postings ADD COLUMN screened_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_screened ON job_postings(fit_status, screened_at);
