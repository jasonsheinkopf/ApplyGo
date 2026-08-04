-- One cover letter per job -- regenerating replaces it (no revision history, unlike resumes),
-- since a cover letter is cheap to redo and always singular per application. content_html is
-- stored directly (no PDF/R2 pipeline): a cover letter is one page of plain text, so a rendered
-- HTML preview is enough for now, and it's easy to add a PDF export later the same way resumes
-- got theirs if that turns out to matter.
CREATE TABLE IF NOT EXISTS cover_letters (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  content_html TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cover_letters_job ON cover_letters(job_id);
