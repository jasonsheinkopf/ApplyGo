-- The strong-tier assessment now rates a posting 0-100 rather than picking strong/possible/reject
-- directly, so the actual number is stored and filterable rather than only the derived bucket.
-- fit_status is still written (derived from the score via verdictForScore() in src/fit.ts) so the
-- existing hide/show/sort logic that keys off it keeps working unchanged.
ALTER TABLE job_postings ADD COLUMN fit_score INTEGER;
