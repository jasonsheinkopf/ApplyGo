-- Job-scoped clarifying Q&A reuses candidate_evidence -- the same table notes and role-signals
-- already share, distinguished only by category -- rather than a new table. job_id lets these
-- entries be queried per job: both to show a job's own Q&A history, and later to feed a
-- job-tailored resume/cover-letter generation step the same evidence.
ALTER TABLE candidate_evidence ADD COLUMN job_id TEXT REFERENCES job_postings(id) ON DELETE SET NULL;
