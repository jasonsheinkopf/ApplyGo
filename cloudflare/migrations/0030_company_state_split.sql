-- Company pipeline v5: split "is this a real, identified company" from "can we read its jobs".
--
-- These were one overloaded `status`/`verify_reason` pair, and conflating them was a correctness
-- bug, not just a naming problem. A company whose official website is confirmed IS a verified
-- company -- whether or not ApplyGo happens to support the ATS it hires through. The old model
-- filed "we found their site and their Greenhouse board, but Greenhouse reads failed today" and
-- "we could not figure out who this employer is at all" under the same word, Unverified, which
-- made the Unverified tab useless and the funnel counts meaningless.
--
-- Two independent axes from here on:
--
--   identity_status    pending | verified | ambiguous | unresolved | not_a_company | dismissed
--   job_source_status  pending | supported | unsupported_ats | no_board | board_unreachable
--
-- The pipeline reads left to right: identity must reach `verified` before job_source is even
-- attempted, so a `pending` job_source on an `unresolved` company means "never tried", not "failed".
--
-- Additive only, and every backfill below is derived from data already on the row -- no column is
-- dropped and nothing is recomputed from the network. The legacy `status`/`verify_reason` columns
-- are intentionally left in place and still written for one release so a rollback stays possible.

-- The employer string exactly as the aggregator supplied it, before any cleaning. Evidence: when a
-- resolution goes wrong, the original string is usually the only way to see why.
ALTER TABLE companies ADD COLUMN source_name TEXT NOT NULL DEFAULT '';

-- Axis 1: who this company is.
ALTER TABLE companies ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'pending';

-- Why the resolver believes the website belongs to this company -- the page title / og:site_name /
-- schema.org Organization evidence it actually matched on. Kept for ambiguous rows especially,
-- where a human needs to see what was rejected and decide for themselves.
ALTER TABLE companies ADD COLUMN website_evidence TEXT NOT NULL DEFAULT '';

-- Axis 2: whether we can read this company's jobs.
ALTER TABLE companies ADD COLUMN job_source_status TEXT NOT NULL DEFAULT 'pending';

-- The canonical board URL, whatever the provider. Populated for unsupported providers too -- that
-- is the whole point of detecting them: "they hire through iCIMS, here is the link" beats "no job
-- board found", which is both useless and false.
ALTER TABLE companies ADD COLUMN board_url TEXT NOT NULL DEFAULT '';

-- When job-source resolution was last attempted, separate from last_scanned_at (reading the board)
-- and last_verified_at (identity). Three different questions, three different retry cadences.
ALTER TABLE companies ADD COLUMN job_source_checked_at TEXT;

-- --------------------------------------------------------------------------------------------
-- Backfill. Order matters: each statement only matches rows the previous ones left alone.
-- --------------------------------------------------------------------------------------------

UPDATE companies SET source_name = name WHERE source_name = '';

-- User-removed is orthogonal to both axes and wins over everything.
UPDATE companies SET identity_status = 'dismissed' WHERE status = 'dismissed';

-- Fully verified before: identity confirmed AND a readable board found.
UPDATE companies SET identity_status = 'verified', job_source_status = 'supported'
  WHERE status = 'verified';

-- The corrections this migration exists for. All three of these had a confirmed website and were
-- nonetheless labelled "unverified" -- they are verified companies with a job-source limitation.
UPDATE companies SET identity_status = 'verified', job_source_status = 'no_board'
  WHERE status = 'unverified' AND verify_reason = 'no_job_board';

UPDATE companies SET identity_status = 'verified', job_source_status = 'unsupported_ats'
  WHERE status = 'unverified' AND verify_reason = 'unsupported_ats';

UPDATE companies SET identity_status = 'verified', job_source_status = 'board_unreachable'
  WHERE status = 'unverified' AND verify_reason = 'board_unreachable';

-- Genuine identity failures stay identity failures.
UPDATE companies SET identity_status = 'unresolved', job_source_status = 'pending'
  WHERE status = 'unverified' AND verify_reason = 'no_website';

UPDATE companies SET identity_status = 'ambiguous', job_source_status = 'pending'
  WHERE status = 'unverified' AND verify_reason = 'ambiguous';

-- 'discovered' means never checked. A website already on the row means identity was in fact
-- established (manual entry, or a resolution that landed before the row was scanned).
UPDATE companies SET identity_status = 'verified'
  WHERE identity_status = 'pending' AND status = 'discovered' AND website != '';

-- Reconstruct board_url from the ATS identity already stored. For the five readable providers the
-- token is an org slug and the public board URL is derivable; for detect-only providers the token
-- was already stored as a bare host+path fragment, so it only needs a scheme.
UPDATE companies SET board_url = 'https://job-boards.greenhouse.io/' || ats_token
  WHERE board_url = '' AND ats_provider = 'greenhouse' AND ats_token != '';
UPDATE companies SET board_url = 'https://jobs.lever.co/' || ats_token
  WHERE board_url = '' AND ats_provider = 'lever' AND ats_token != '';
UPDATE companies SET board_url = 'https://jobs.ashbyhq.com/' || ats_token
  WHERE board_url = '' AND ats_provider = 'ashby' AND ats_token != '';
UPDATE companies SET board_url = 'https://careers.smartrecruiters.com/' || ats_token
  WHERE board_url = '' AND ats_provider = 'smartrecruiters' AND ats_token != '';
UPDATE companies SET board_url = 'https://' || ats_token
  WHERE board_url = '' AND ats_token != '' AND ats_token LIKE '%.%';

-- Last resort: a careers page we found but never resolved to a provider is still the best link.
UPDATE companies SET board_url = careers_url WHERE board_url = '' AND careers_url != '';

CREATE INDEX IF NOT EXISTS idx_companies_identity ON companies(profile_id, identity_status);
CREATE INDEX IF NOT EXISTS idx_companies_job_source ON companies(profile_id, job_source_status);
