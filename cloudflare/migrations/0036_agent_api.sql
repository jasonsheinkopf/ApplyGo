-- Chat/job-agent integration.
--
-- Agent credentials deliberately live outside device_sessions. The main app treats every
-- device-session scope except read_only as a normal full session; putting an agent token there
-- would therefore accidentally give a compromised agent arbitrary access to every current and
-- future mutating route. Keeping this credential store separate means an ago_* token is recognized
-- only by src/agent-gateway.ts and only for its small, explicit allowlist.

CREATE TABLE IF NOT EXISTS agent_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  permissions_json TEXT NOT NULL DEFAULT '["profile:read","profile:write"]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_credentials_active
  ON agent_credentials(revoked_at, expires_at);

-- One interview checklist per canonical profile. "fresh" resets only these confirmation flags;
-- it never deletes existing ApplyGo data. That makes it safe to re-run onboarding conversationally
-- while the website remains a transparent view/editor of the same underlying record.
CREATE TABLE IF NOT EXISTS agent_onboarding_state (
  profile_id TEXT PRIMARY KEY REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'continue',
  resume_confirmed INTEGER NOT NULL DEFAULT 0,
  career_direction_confirmed INTEGER NOT NULL DEFAULT 0,
  locations_confirmed INTEGER NOT NULL DEFAULT 0,
  dealbreakers_confirmed INTEGER NOT NULL DEFAULT 0,
  priorities_confirmed INTEGER NOT NULL DEFAULT 0,
  extra_evidence_confirmed INTEGER NOT NULL DEFAULT 0,
  profile_dirty INTEGER NOT NULL DEFAULT 0,
  career_dirty INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Intentionally stores action names and small summaries, never raw resume/note content or tokens.
CREATE TABLE IF NOT EXISTS agent_activity (
  id TEXT PRIMARY KEY,
  credential_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_activity_created
  ON agent_activity(created_at DESC);
