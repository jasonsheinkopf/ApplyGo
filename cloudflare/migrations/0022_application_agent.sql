-- Storage for the in-page application agent (extension/agent.js).
--
-- Two things the old single answer bank couldn't express:
--
-- 1. Not every answer deserves to be remembered forever. "Why do you want to work at Acme?" is
--    true of exactly one application; storing it in the shared bank would hand the next company a
--    letter addressed to someone else. job_application_answers is the per-job home for those, kept
--    as its own table rather than a nullable job_id on application_answers so the existing
--    upsert-by-question_key path (and its unique index) keeps working untouched.
--
-- 2. Why an answer was classified the way it was. `category` records the agent's storage decision
--    on the durable bank so a later reviewer can see whether something was kept because it's a
--    stable fact (phone number), a standing preference (willing to relocate), or a contextual value
--    that may go stale (salary expectation, notice period).
ALTER TABLE application_answers ADD COLUMN category TEXT NOT NULL DEFAULT 'reusable';

CREATE TABLE IF NOT EXISTS job_application_answers (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  question_text TEXT NOT NULL,
  answer TEXT NOT NULL,
  answer_type TEXT NOT NULL DEFAULT 'text',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_answers_key
  ON job_application_answers(profile_id, job_id, question_key);

-- The agent's decision log: which field, which resolution path won, whether the browser actually
-- kept the value, what the user was asked and why. Deliberately records the *decision*, not the
-- answer text for anything sensitive -- see recordAgentEvents() in index.ts, which drops values for
-- NEVER_INFER categories before writing. Retained for debugging and for later Langfuse/eval work
-- on how well the agent triages a real form.
CREATE TABLE IF NOT EXISTS application_agent_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES job_postings(id) ON DELETE SET NULL,
  application_url TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  field_name TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_events_job ON application_agent_events(profile_id, created_at DESC);
