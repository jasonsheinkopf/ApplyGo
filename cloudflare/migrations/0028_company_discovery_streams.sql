-- Companies pipeline v4: resumable Adzuna discovery (one row per search-term/location stream,
-- so repeated "Find companies" clicks continue where the last one left off instead of re-querying
-- page 1 of the same terms forever), plus a search-grounded website-resolution fallback for
-- companies the deterministic slug-guess can't place.
--
-- Additive only, same discipline as every migration since 0017.

-- One row per (term, location) combination actually queried against Adzuna. The pair itself is the
-- stream's identity -- no separate fingerprint/hash column needed, a changed term or location is
-- simply a different row, and a term dropped from the candidate's configured list just stops being
-- selected by discoverCompanies rather than needing explicit cleanup.
CREATE TABLE IF NOT EXISTS company_discovery_streams (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  -- The next Adzuna page this stream hasn't fetched yet. Starts at 1, not 0 -- Adzuna's own paging
  -- is 1-indexed.
  next_page INTEGER NOT NULL DEFAULT 1,
  -- True once Adzuna has confirmed there's nothing left for this term/location (next_page would
  -- exceed the result count, or a page came back empty). A rate-limited (429) response never sets
  -- this -- that's "try again later", not "nothing more here".
  exhausted INTEGER NOT NULL DEFAULT 0,
  -- Adzuna's own reported total result count for this query, last time it was seen. Used to decide
  -- exhaustion without needing to keep paging until an empty page proves it.
  total_available INTEGER,
  -- Running count of postings actually pulled from this stream across every page fetched so far --
  -- the real, honest "Discovery" number the Companies Sankey shows, since it's what ApplyGo has
  -- actually looked at, not just what Adzuna claims exists.
  postings_seen INTEGER NOT NULL DEFAULT 0,
  last_searched_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_streams_key ON company_discovery_streams(profile_id, term, location);
CREATE INDEX IF NOT EXISTS idx_discovery_streams_pending ON company_discovery_streams(profile_id, exhausted, last_searched_at);

-- Which website-resolution path found this company's domain, and how sure it was. 'guess' (the
-- existing deterministic slug+TLD path), 'search' (the web-search fallback below), or 'manual' (the
-- candidate typed it in). Confidence is only meaningful for 'search' -- a guess or a manual entry is
-- either verified or it isn't, there's no partial-confidence state for those.
ALTER TABLE companies ADD COLUMN website_source TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN website_confidence INTEGER;

-- No migration needed for the value itself: verify_reason gains 'ambiguous' (a search fallback that
-- couldn't confidently tell two same-named companies apart) alongside the existing four reasons,
-- same already-unconstrained TEXT column.
