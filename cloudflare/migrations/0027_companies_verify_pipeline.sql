-- Companies pipeline v3: replace company-level AI fit scoring with a purely operational
-- Discovery -> Verify -> (existing) job-board scan model. A company is monitored because a real
-- job search found it and its board can be read -- never because an LLM judged its industry
-- "relevant" to the candidate. That judgment belongs at the job level, where it already lives
-- (job_postings.fit_score/fit_status, unaffected by this migration).
--
-- Additive only: no column is dropped and no row is rewritten destructively. fit_score/fit_reason/
-- fit_screened_at/signal (added in 0026) are kept for backward compatibility but are no longer
-- written by any active code path -- see src/companies.ts and src/index.ts.

-- The specific, inspectable reason a company failed verification. Empty for anything that isn't
-- currently unverified (discovered/verified/dismissed all leave this blank).
ALTER TABLE companies ADD COLUMN verify_reason TEXT NOT NULL DEFAULT '';

-- Separate from last_scanned_at on purpose: verifying (does a real, readable job board exist for
-- this company) and scanning (reading that board for postings) are different questions with
-- different failure modes, even though today's code answers both in the same pass the first time a
-- company is checked.
ALTER TABLE companies ADD COLUMN last_verified_at TEXT;

-- Backfill: fold the old reachable/unreachable/unresolved/dismissed vocabulary into
-- discovered/verified/unverified/dismissed. Order matters -- each statement's WHERE clause only
-- ever matches rows the previous statements didn't touch, so there's no double-migration risk.

-- 'unreachable' (legacy, already historical-only before this migration) and 'unresolved' (no
-- confirmed website) both become the new unverified/no_website.
UPDATE companies SET status = 'unverified', verify_reason = 'no_website'
  WHERE status IN ('unreachable', 'unresolved');

-- A 'reachable' company with a confirmed website but no board found at all.
UPDATE companies SET status = 'unverified', verify_reason = 'no_job_board'
  WHERE status = 'reachable' AND ats_provider = 'none';

-- A 'reachable' company whose board was detected but isn't one of the five this app can read.
UPDATE companies SET status = 'unverified', verify_reason = 'unsupported_ats'
  WHERE status = 'reachable' AND ats_provider NOT IN
    ('', 'none', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday');

-- A 'reachable' company already resolved to one of the five readable providers is genuinely verified.
UPDATE companies SET status = 'verified'
  WHERE status = 'reachable' AND ats_provider IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday');

-- A 'reachable' company that was inserted but never got as far as any ATS resolution attempt --
-- treated as freshly discovered, eligible for a first verify pass same as a brand new row.
UPDATE companies SET status = 'discovered'
  WHERE status = 'reachable' AND ats_provider = '';

-- 'dismissed' rows are untouched -- user-removed is orthogonal to verification state.
