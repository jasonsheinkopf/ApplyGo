-- The eval harness's dataset. A case is a saved prompt worth testing repeatedly (usually promoted
-- from a real llm_traces row, sometimes hand-authored); a run is one execution of that prompt
-- against one provider/model, scored by an LLM judge. See src/evals.ts for why replay deliberately
-- does NOT write into llm_traces -- an eval run isn't production spend, and mixing the two would
-- inflate the Cost tab's totals with experimentation nobody asked the app to do.
CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  -- The llm_traces row this was promoted from, if any. Not a foreign key -- traces are pruned on a
  -- rolling cap (see llm_traces' own comment), so this can outlive the row it points at; it's
  -- provenance, not a join target.
  source_trace_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_eval_cases_task ON eval_cases(task, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  -- The prompt actually sent for this run. Usually the case's prompt at the time, but a run can be
  -- fired with an edited prompt without mutating the case, so this is the one true reproducibility
  -- record for that specific run.
  prompt TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  response TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  judge_score INTEGER,
  judge_reasoning TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_case ON eval_runs(case_id, created_at DESC);
