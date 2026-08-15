-- Profile → Careers → Resume refactor.
--
-- Additive only: no column is dropped and no row is rewritten, because this database already holds
-- real candidate data. Old structured profiles stay exactly where they are in
-- candidate_profiles.structured_json and are read through a legacy adapter (see readCareerProfile
-- in src/profile.ts) until the candidate regenerates from their source documents.

-- Cached labor-market research, one row per (role family, location) pair.
--
-- Separate from the role analysis itself because the two have different failure modes and
-- different lifetimes: role discovery reasons about the candidate and must stay reproducible, while
-- market data comes from external sources that can be slow, blocked, or temporarily gone. Caching
-- it here means a page load never re-researches an unchanged role, and a provider outage degrades
-- to "data not yet available" instead of taking the Roles page down with it.
CREATE TABLE IF NOT EXISTS role_market_research (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  -- Lowercased "<role title>|<locations>", the only two inputs the research depends on.
  cache_key TEXT NOT NULL,
  role_title TEXT NOT NULL,
  locations TEXT NOT NULL DEFAULT '',
  -- Full RoleMarketResearch record, including its source attributions and the unavailable flag.
  research_json TEXT NOT NULL DEFAULT '{}',
  researched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_role_market_key ON role_market_research(profile_id, cache_key);

-- Which career path a resume is the baseline for.
--
-- Empty for the job-specific resumes that already exist (they are identified by job_id) and for
-- pre-refactor versions, so this reads as "no career path claimed" rather than needing a backfill.
ALTER TABLE resumes ADD COLUMN role_family TEXT NOT NULL DEFAULT '';
