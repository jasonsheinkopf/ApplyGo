-- Repairs the contradictory rows 0030's backfill exposed: nine companies stored a real careers or
-- board URL while reporting job_source_status='no_board'. That is the contradiction reported from
-- the UI ("no job board" shown beside a working Greenhouse/iCIMS link), and it is now a state
-- invariant violation (see stateViolations in src/companystate.ts), so it has to be fixed in data
-- as well as prevented in code.
--
-- Two distinct causes, fixed separately below.
--
-- Cause 1: the stored URL *is* an ATS board, but ats_provider was never set from it. ATS patterns
-- only ever ran against careers-page HTML, never against a URL already resolved and saved, so
-- "General Matter" sat at ats_provider='none' with https://job-boards.greenhouse.io/generalmatter
-- on the same row -- a readable board whose jobs were never imported. detectAtsFromUrl (companies.ts)
-- closes the gap going forward; these UPDATEs recover the rows already affected. Only the hostname
-- patterns are matched here, deliberately: SQL LIKE is the wrong tool for the full pattern set, and
-- the next scan re-derives anything this misses.
--
-- Cause 2: the URL is a genuine careers page on the company's own site with no ATS behind it. That
-- is the new 'careers_only' state, not 'no_board' -- the link is the useful thing to show.

-- Readable providers: recover both the provider and the org token from the stored URL.
UPDATE companies SET ats_provider = 'greenhouse',
       ats_token = CASE WHEN ats_token IN ('', 'none') THEN
         rtrim(replace(replace(board_url, 'https://job-boards.greenhouse.io/', ''), 'https://boards.greenhouse.io/', ''), '/')
       ELSE ats_token END,
       job_source_status = 'supported'
 WHERE job_source_status = 'no_board' AND board_url LIKE '%greenhouse.io/%';

UPDATE companies SET ats_provider = 'lever',
       ats_token = CASE WHEN ats_token IN ('', 'none') THEN rtrim(replace(board_url, 'https://jobs.lever.co/', ''), '/') ELSE ats_token END,
       job_source_status = 'supported'
 WHERE job_source_status = 'no_board' AND board_url LIKE '%jobs.lever.co/%';

UPDATE companies SET ats_provider = 'ashby',
       ats_token = CASE WHEN ats_token IN ('', 'none') THEN rtrim(replace(board_url, 'https://jobs.ashbyhq.com/', ''), '/') ELSE ats_token END,
       job_source_status = 'supported'
 WHERE job_source_status = 'no_board' AND board_url LIKE '%jobs.ashbyhq.com/%';

-- Detect-only providers: the board is real and linkable, just not readable by this app.
UPDATE companies SET ats_provider = 'icims', job_source_status = 'unsupported_ats'
 WHERE job_source_status = 'no_board' AND board_url LIKE '%.icims.com%';
UPDATE companies SET ats_provider = 'workday', job_source_status = 'unsupported_ats'
 WHERE job_source_status = 'no_board' AND board_url LIKE '%.myworkdayjobs.com%';
UPDATE companies SET ats_provider = 'taleo', job_source_status = 'unsupported_ats'
 WHERE job_source_status = 'no_board' AND board_url LIKE '%taleo.net%';
UPDATE companies SET ats_provider = 'successfactors', job_source_status = 'unsupported_ats'
 WHERE job_source_status = 'no_board' AND board_url LIKE '%successfactors.%';
UPDATE companies SET ats_provider = 'workable', job_source_status = 'unsupported_ats'
 WHERE job_source_status = 'no_board' AND board_url LIKE '%apply.workable.com%';
UPDATE companies SET ats_provider = 'jobvite', job_source_status = 'unsupported_ats'
 WHERE job_source_status = 'no_board' AND board_url LIKE '%jobvite.com%';
UPDATE companies SET ats_provider = 'adp', job_source_status = 'unsupported_ats'
 WHERE job_source_status = 'no_board' AND board_url LIKE '%workforcenow.adp.com%';

-- Cause 2: everything still contradictory is a real careers page with no identifiable ATS.
UPDATE companies SET job_source_status = 'careers_only'
 WHERE job_source_status = 'no_board' AND board_url != '';

-- 'none' was the old sentinel for "looked, found nothing". With job_source_status now carrying that
-- meaning, an ats_provider of 'none' beside no board URL is just noise in the UI.
UPDATE companies SET ats_provider = '' WHERE ats_provider = 'none' AND board_url = '';
