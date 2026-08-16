-- Companies pipeline v2: deterministic, job-market-grounded discovery (Adzuna) plus a batched LLM
-- fit score replace LLM-recall as the primary "Find companies" mechanism. See src/adzuna.ts and
-- src/companies.ts. proposeCompanies()/`companies/discover` becomes an explicit, separately
-- triggered supplemental path rather than being deleted.
--
-- Additive only: no column is dropped and no row is rewritten, because this database already holds
-- real candidate data.

-- Candidate fit score for a company, set once by the batched companies.screen LLM call and never
-- touched by a threshold change -- same store-once/re-partition-by-threshold split job_postings'
-- fit_score already uses.
ALTER TABLE companies ADD COLUMN fit_score INTEGER;
ALTER TABLE companies ADD COLUMN fit_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN fit_screened_at TEXT;

-- Deterministic "what we saw this company hiring for" signal, built from sampled Adzuna postings at
-- discovery time. Kept separate from `bio` -- bio stays an LLM-authored company description for
-- source='ai'/'manual' rows; this is always machine-built, and is what the fit-screening prompt
-- reads in place of an LLM-authored bio for source='adzuna' rows.
ALTER TABLE companies ADD COLUMN signal TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_companies_unscreened ON companies(profile_id, fit_score);

-- No migration needed for the values these columns hold: `status` gains 'unresolved' (discovered via
-- Adzuna, no verified real website found -- see resolveCompanyDomain) alongside the existing
-- reachable/unreachable/dismissed, and `source` gains 'adzuna' alongside the existing ai/manual. Both
-- are already-unconstrained TEXT columns.
