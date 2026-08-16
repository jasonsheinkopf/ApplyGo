-- Improve workflow: persisted audit questions and answers.
--
-- Deliberately separate from candidate_profiles.structured_json. The canonical profile is the
-- reconciled, LLM-integrated record; a saved answer is raw candidate input that has not yet been
-- integrated (and might describe something the integration pass decides not to add verbatim), so it
-- needs its own durable home rather than being written straight into the structured JSON. See
-- src/prompts.ts (profile/improve-audit, profile/improve-apply) and the /profile/improve/* routes
-- in src/index.ts.

CREATE TABLE IF NOT EXISTS profile_improvement_questions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  -- Which generation of the structured profile this question was generated against, so a later
  -- Create regeneration or Apply pass can tell whether a still-pending question was asked about a
  -- version of the record that has since changed underneath it.
  profile_version TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  entity_label TEXT NOT NULL DEFAULT '',
  target_field TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  priority INTEGER NOT NULL DEFAULT 0,
  question TEXT NOT NULL,
  why_it_matters TEXT NOT NULL DEFAULT '',
  answer_type TEXT NOT NULL DEFAULT 'long_text',
  answer TEXT NOT NULL DEFAULT '',
  -- pending -> answered -> applied, or pending/answered -> dismissed. "obsolete" marks a question a
  -- later audit pass has superseded without the candidate ever acting on it, so it stops rendering
  -- without pretending the candidate dismissed it themselves.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'applied', 'dismissed', 'obsolete')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  answered_at TEXT,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_improve_questions_profile ON profile_improvement_questions(profile_id, status);

-- One row per completed audit run, purely so re-running "Find Improvements" can tell how many
-- unresolved questions already exist for the current profile version without re-scanning the
-- questions table's full history on every click, and so the UI can show when the audit last ran.
CREATE TABLE IF NOT EXISTS profile_improvement_audits (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  profile_version TEXT NOT NULL DEFAULT '',
  questions_generated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_improve_audits_profile ON profile_improvement_audits(profile_id, created_at DESC);
