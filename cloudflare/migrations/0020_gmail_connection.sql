-- Read-only Gmail connection state, so the app can search the candidate's inbox for replies from
-- companies they've applied to (src/gmail.ts). Deliberately a separate column from
-- preferences_json rather than a new key inside it: getProfile() already spreads preferences_json
-- verbatim into GET /profile's response, and access/refresh tokens must never reach the browser.
-- Only GET /gmail/status reads this column, and only to return a token-free derived shape.
ALTER TABLE candidate_profiles ADD COLUMN gmail_json TEXT NOT NULL DEFAULT '{}';
