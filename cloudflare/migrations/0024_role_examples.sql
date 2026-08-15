-- Good/bad job postings the candidate points at as concrete examples of what they do and don't
-- want, feeding the same roles/analyze pass as the Description notes, Locations, Dealbreakers and
-- Criteria tabs (see analyzeDesiredRoles in src/index.ts). Deliberately its own table rather than
-- another candidate_evidence category: an example carries a source URL plus parsed job data, not
-- just a claim string, and it is never a job_postings row -- job_postings doubles as the live Jobs
-- pipeline, and an example must never be mistaken for a discovered/applied-to job.
CREATE TABLE IF NOT EXISTS role_examples (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('good', 'bad')),
  source_url TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  -- Best-effort structured read of the posting: title, company, location, employment_type,
  -- description, responsibilities[], qualifications[], skills[]. Left as '{}' when the fetch or
  -- parse failed -- the example (URL + reason) is still saved either way.
  parsed_job_json TEXT NOT NULL DEFAULT '{}',
  fetch_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_role_examples_profile ON role_examples(profile_id, type, created_at DESC);
