-- "Interested" is a manual override on top of the two-tier AI verdict, the same way a user
-- rejection already is -- fit_status becomes 'interested' without touching fit_score/fit_reason,
-- so the score/reason that made it interesting stays visible. interested_at orders the new
-- Interested tab's list independently of posted_at/fit_score.
ALTER TABLE job_postings ADD COLUMN interested_at TEXT;
