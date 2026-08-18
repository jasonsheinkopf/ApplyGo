-- Direct ATS discovery: finding a company's real job board is now the primary success condition,
-- not finding its corporate website. See companystate.ts and atsdiscovery.ts for the architecture.
--
-- Additive only. Three new columns:
--
--   failure_reason    -- structured diagnostic for *why* the current job_source_status is a failure
--                         state (see companies.ts's FailureReason) -- distinguishes "genuinely
--                         cannot reach this" (dns_or_network, timeout, budget_exhausted) from
--                         "something is deliberately blocking us" (http_403/429, probable_captcha,
--                         cloudflare_challenge, login_required) from "the page is fine and nothing
--                         useful was on it" (empty string, the prior behavior).
--
--   discovery_method   -- how the currently-stored website/board was found: '' (not yet discovered),
--                         'reuse' (already-known data, no rediscovery needed), 'direct_ats' (the
--                         provider sweep found it with no website involved), 'website' (found via
--                         the careers-page route), 'search' (the paid web-search fallback), or
--                         'manual' (typed in by the candidate). Purely descriptive -- no invariant
--                         depends on it -- kept for the Companies pipeline debug view.
--
--   ats_verified_at    -- when an ATS provider/token was last (re)confirmed, distinct from
--                         last_verified_at (identity) and last_scanned_at (a board read actually
--                         ran) for the same reason job_source_checked_at already exists: three
--                         different questions, three different retry cadences.
--
-- No backfill needed: every existing row already has an identity_status/job_source_status that
-- correctly reflects what was known before this migration, and these are purely additive diagnostic
-- fields for future writes, not a reclassification of past state.

ALTER TABLE companies ADD COLUMN failure_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN discovery_method TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN ats_verified_at TEXT;

-- A company that already has a readable ATS provider stored counts as 'reuse' from now on -- the
-- next scan that touches it will read its saved board directly rather than rediscovering anything,
-- so the debug view should say so rather than showing a blank "how was this found".
UPDATE companies SET discovery_method = 'reuse' WHERE ats_provider != '' AND discovery_method = '';
