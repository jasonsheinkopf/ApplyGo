-- The resume doctrine agent's storage (src/philosophy.ts).
--
-- Three additions, all nullable/defaulted so every existing row stays valid:
--
--  * resumes.is_master -- marks the deliberately-oversized archive document. There is at most one
--    per profile, and it is the source the tailored versions are filtered down from, so it needs to
--    be findable by flag rather than by guessing from a name.
--  * resumes.plan_json -- the evidence plan (per-role feature/include/compress/omit decisions plus
--    the requirement coverage report) that produced this version. Stored so the candidate can see
--    WHY a role was dropped, and so a revision can reuse the plan instead of re-deriving it.
--  * job_postings.requirements_json -- the parsed requirements model for a posting. Cached because
--    a posting's requirements don't change between the first resume and the fourth revision, and
--    re-extracting them per revision is a model call bought for nothing.
ALTER TABLE resumes ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resumes ADD COLUMN plan_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE job_postings ADD COLUMN requirements_json TEXT NOT NULL DEFAULT '{}';

-- Partial: only the master row is looked up this way, and there is one per profile at most.
CREATE INDEX IF NOT EXISTS idx_resumes_master ON resumes(profile_id) WHERE is_master = 1;
