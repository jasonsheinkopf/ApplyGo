-- Manual workflow state, kept separate from the AI's own evaluation state.
--
-- Until now, marking a job Interested overwrote fit_status, and rejecting one zeroed fit_score --
-- the real AI rating was gone the moment a manual decision touched the row. manual_status is a
-- second, independent axis: normal | interested | removed. fit_status/fit_score/fit_reason etc.
-- stay exactly what the scoring pipeline wrote and are never touched by a manual action again, so
-- Good Match vs Bad Match can be derived live from fit_score + a threshold at any time, and a
-- removed job's original rating is never lost.
ALTER TABLE job_postings ADD COLUMN manual_status TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE job_postings ADD COLUMN removed_at TEXT;
-- Snapshot of manual_status ('normal' or 'interested') taken the moment Remove is clicked, so
-- Re-add knows whether to return the job to Interested or let its rating recompute its bucket.
ALTER TABLE job_postings ADD COLUMN removed_from_status TEXT;
ALTER TABLE job_postings ADD COLUMN removal_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_jobs_manual_status ON job_postings(manual_status);

-- Carry existing interested/applied jobs over to the new column so they don't vanish into Unrated
-- or Bad Match; their fit_status is left untouched.
UPDATE job_postings SET manual_status = 'interested' WHERE fit_status IN ('interested', 'applied');
