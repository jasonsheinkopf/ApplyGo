-- Target companies: the list of employers worth watching, kept independently of any single
-- job posting. Jobs are discovered by scanning these companies' own job boards, so the company
-- list is the durable thing and postings come and go against it.
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Normalized name used for dedupe, so "Acme, Inc." and "Acme Inc" don't both get added.
  name_key TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  careers_url TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  why_fit TEXT NOT NULL DEFAULT '',
  -- Which applicant tracking system hosts their board, and the board's token/slug on it.
  -- Empty until a scan resolves it; 'none' once we've looked and found no supported board.
  ats_provider TEXT NOT NULL DEFAULT '',
  ats_token TEXT NOT NULL DEFAULT '',
  -- reachable | unreachable | dismissed
  status TEXT NOT NULL DEFAULT 'reachable',
  source TEXT NOT NULL DEFAULT 'ai',
  scan_note TEXT NOT NULL DEFAULT '',
  last_scanned_at TEXT,
  open_jobs INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_profile_key ON companies(profile_id, name_key);
CREATE INDEX IF NOT EXISTS idx_companies_scanned ON companies(profile_id, last_scanned_at);

-- Link postings back to the company they were scanned from. Manually added jobs leave these empty.
ALTER TABLE job_postings ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE job_postings ADD COLUMN external_id TEXT NOT NULL DEFAULT '';
ALTER TABLE job_postings ADD COLUMN location TEXT NOT NULL DEFAULT '';
ALTER TABLE job_postings ADD COLUMN posted_at TEXT;
ALTER TABLE job_postings ADD COLUMN ats_provider TEXT NOT NULL DEFAULT '';

-- Re-scanning a board must not duplicate postings. Partial so manually added jobs, which have
-- no company_id and no external_id, are never caught by this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_company_external
  ON job_postings(company_id, external_id)
  WHERE company_id IS NOT NULL AND external_id != '';

CREATE INDEX IF NOT EXISTS idx_jobs_company ON job_postings(company_id);
