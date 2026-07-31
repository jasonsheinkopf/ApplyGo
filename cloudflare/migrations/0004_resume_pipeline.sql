-- Resume generation pipeline state. Each resume version now carries the template and layout
-- knobs it was rendered with, the deterministic check results, and the latest design critique,
-- so a version can be re-rendered or reviewed again without recomputing any of it.
ALTER TABLE resumes ADD COLUMN template TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE resumes ADD COLUMN layout_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE resumes ADD COLUMN checks_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE resumes ADD COLUMN critique TEXT NOT NULL DEFAULT '';
ALTER TABLE resumes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
