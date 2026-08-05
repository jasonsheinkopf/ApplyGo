-- Ask once, remember forever.
--
-- Every ATS asks the same handful of questions (work authorization, sponsorship, veteran status,
-- disability disclosure, notice period, salary expectations), and retyping them is most of the
-- tedium of applying. question_key is a normalized fingerprint of the question rather than its
-- literal wording, so "Are you legally authorized to work in the United States?" and "Are you
-- authorized to work in the US?" resolve to the same stored answer across different companies.
--
-- Deliberately separate from candidate_evidence: that table holds free-text material a model reads
-- and rewrites, whereas these are exact values typed verbatim into a form field. Conflating them
-- would invite a model to paraphrase an answer where only the literal string is correct.
CREATE TABLE IF NOT EXISTS application_answers (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  question_text TEXT NOT NULL,
  answer TEXT NOT NULL,
  answer_type TEXT NOT NULL DEFAULT 'text',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_answers_key ON application_answers(profile_id, question_key);

-- 'applied' is a manual override on fit_status, exactly like 'interested' before it: it doesn't
-- touch fit_score or fit_reason, so the score that made the job worth pursuing survives the move.
ALTER TABLE job_postings ADD COLUMN applied_at TEXT;
