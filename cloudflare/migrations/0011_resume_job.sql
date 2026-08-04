-- Ties a resume version to the specific job it was tailored for. NULL means a general-purpose
-- version (what every existing resume already is) -- "the version for this job" is just
-- `SELECT * FROM resumes WHERE job_id = ?`, no back-reference column needed on job_postings.
ALTER TABLE resumes ADD COLUMN job_id TEXT REFERENCES job_postings(id) ON DELETE SET NULL;
