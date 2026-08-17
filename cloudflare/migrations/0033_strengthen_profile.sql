-- Strengthen Profile: the job-scoped evidence workflow that replaces the Profile tab's generic
-- Improve audit and the Interested job's freeform "Ask" question.
--
-- Two changes, both additive. Nothing here rewrites or drops existing data: jobs analyzed before
-- this migration simply have no job_evidence_analysis row (the UI analyzes lazily on first open),
-- and questions asked by the old profile-wide audit keep working with NULL job/requirement columns.

-- The durable artifact this whole feature is built around.
--
-- Before this, a posting's requirements were extracted and matched against the profile on every
-- single resume build and then thrown away -- two model calls per build, re-deriving an answer that
-- had not changed. Persisting it makes that work reusable by the Strengthen page, the resume
-- writer, and the cover-letter writer alike, and makes the mapping
-- (requirement -> profile evidence -> gap -> clarification) an inspectable record rather than a
-- transient prompt fragment.
--
-- analysis_json holds the JobEvidenceAnalysis in src/strengthen.ts: the extracted requirements, the
-- graded coverage plan, and the profile fingerprint the grading was computed against. The counts
-- are denormalized out of it purely so list views can show readiness without parsing every blob.
CREATE TABLE IF NOT EXISTS job_evidence_analysis (
  -- One analysis per job, replaced in place on reanalysis. There is no history here on purpose:
  -- an old grading of a profile that has since changed is misleading, not useful.
  job_id TEXT PRIMARY KEY REFERENCES job_postings(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  -- Fingerprint of the structured profile the coverage was graded against, so the page can tell
  -- the candidate their analysis predates evidence they have since added.
  profile_version TEXT NOT NULL DEFAULT '',
  analysis_json TEXT NOT NULL,
  proven_count INTEGER NOT NULL DEFAULT 0,
  partial_count INTEGER NOT NULL DEFAULT 0,
  unproven_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_evidence_profile ON job_evidence_analysis(profile_id);

-- Questions stay in the profile-wide table rather than getting a job-scoped one of their own, and
-- that is the single most important schema decision in this feature.
--
-- The product requirement is that answering a question for job A means job B never has to ask it
-- again. That only holds if there is exactly one question history per candidate, queried across
-- every job. A per-job questions table would have made each posting start from zero -- the precise
-- opposite of the cumulative behavior this is for. So job_id is provenance (which posting prompted
-- this question), not ownership.
ALTER TABLE profile_improvement_questions ADD COLUMN job_id TEXT REFERENCES job_postings(id) ON DELETE SET NULL;

-- Which extracted requirement prompted the question, so the page can group a question under the
-- requirement it belongs to, and so a later reassessment can report whether answering it actually
-- moved that requirement's coverage.
ALTER TABLE profile_improvement_questions ADD COLUMN requirement_id TEXT NOT NULL DEFAULT '';
ALTER TABLE profile_improvement_questions ADD COLUMN requirement_text TEXT NOT NULL DEFAULT '';

-- ON DELETE SET NULL above means a deleted posting leaves its questions (and any answers already
-- given) intact and profile-wide, which is right: the evidence the candidate remembered is theirs,
-- and it should not evaporate because they deleted the posting that jogged their memory.
CREATE INDEX IF NOT EXISTS idx_improve_questions_job ON profile_improvement_questions(job_id, status);
