-- Read-only credentials, for the MCP server (and anything else that should be able to look at
-- ApplyGo's data without being able to change it).
--
-- Deliberately a scope on the existing device_sessions table rather than a second token system:
-- one place tokens are minted, one place they are checked, one place they are revoked. A parallel
-- credential store would mean two revocation paths, and the one nobody remembers is the one that
-- leaks.
--
-- The enforcement rule is a single line in requireSession: a 'read_only' session may only make
-- GET/HEAD requests. That is what makes the guarantee auditable -- every mutating route in the app
-- is covered by construction, including routes added later, rather than by remembering to annotate
-- each one.
ALTER TABLE device_sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';

CREATE INDEX IF NOT EXISTS idx_device_scope ON device_sessions(scope, revoked_at);
