-- Prompt A/B testing on top of the existing eval harness.
--
-- The harness could already replay one saved prompt against different models (see 0016_evals.sql
-- and src/evals.ts). What it could not do is the comparison that actually improves a prompt: run
-- two or more *wordings* of the same instruction over one shared set of cases and say, with
-- numbers, which one did better. These three additions are what that needs.
--
-- The design rule is that an experiment groups runs rather than replacing them. An eval_run is
-- still one prompt sent to one model and scored once; an experiment is a label over a set of them
-- plus the hypothesis someone was testing. That keeps every existing run valid and lets a single
-- run be read on its own or as part of a comparison.

CREATE TABLE IF NOT EXISTS eval_experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Which pipeline task's prompt is under test, e.g. 'jobs.prescreen' or 'fit.assess'. Matches
  -- eval_cases.task so an experiment can pull its case set by task.
  task TEXT NOT NULL,
  -- What the person running this expected to happen, recorded BEFORE the result is known. Written
  -- down because an experiment whose hypothesis is reconstructed afterwards can always be made to
  -- look successful, and the point of the harness is to be able to be wrong.
  hypothesis TEXT NOT NULL DEFAULT '',
  -- running | complete | failed. A crashed experiment stays visible as a failed one rather than
  -- silently looking like a finished experiment that happened to produce few runs.
  status TEXT NOT NULL DEFAULT 'running',
  -- Which variant label is the incumbent, so head-to-head comparison has a fixed reference point
  -- instead of whichever variant happens to sort first.
  control_variant TEXT NOT NULL DEFAULT 'control',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_experiments_task ON eval_experiments(task, created_at DESC);

-- Null for the ordinary one-off replays the harness already supported; set for runs that belong to
-- a comparison. Not a foreign key for the same reason source_trace_id isn't: an experiment can be
-- deleted while its runs remain independently meaningful.
ALTER TABLE eval_runs ADD COLUMN experiment_id TEXT;

-- Which arm of the experiment produced this run ('control', 'candidate', or any label the caller
-- chose). Empty for non-experiment runs.
ALTER TABLE eval_runs ADD COLUMN variant TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_eval_runs_experiment ON eval_runs(experiment_id, variant);

-- The variables that produced this case's prompt, and the managed prompt they were compiled
-- against.
--
-- Without these a case is a frozen string, which is enough to compare models but useless for
-- comparing prompts: there is no way to re-render the same job posting through a different
-- template. Storing the inputs alongside the output makes a case a reusable fixture rather than a
-- transcript. Existing cases keep '{}' and simply can't be used as experiment fixtures, which is
-- honest -- their inputs genuinely weren't recorded.
ALTER TABLE eval_cases ADD COLUMN variables_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE eval_cases ADD COLUMN prompt_name TEXT NOT NULL DEFAULT '';
