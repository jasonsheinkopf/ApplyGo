-- The strong-model tier-2 assessment call already reads the full posting description; this bundles
-- a few more structured fields it can pull out at no extra LLM-call cost: how many years of
-- experience the posting actually states as required, whether it's remote/hybrid/onsite, and any
-- stated pay. Bundled as one JSON column, same pattern as fit_missing_json, rather than three new
-- nullable columns for data that's often simply not stated.
ALTER TABLE job_postings ADD COLUMN fit_detail_json TEXT NOT NULL DEFAULT '{}';
