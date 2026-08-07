-- Every model call this app makes, recorded so the prompts can be inspected and compared rather
-- than guessed at. Prompt and response are stored in full: a trace you cannot read the input of is
-- useless for evaluating a prompt, which is the whole point of keeping them.
--
-- Retention is handled in code (oldest rows pruned past a cap) rather than by a TTL column, since
-- D1 has no scheduled cleanup and an unbounded write-only table would grow forever.
CREATE TABLE IF NOT EXISTS llm_traces (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Null, not zero, when the model has no published price on file. Zero would quietly understate
  -- spend; null lets the console say "unpriced" instead of lying.
  cost_usd REAL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The console's two access patterns: newest-first overall, and newest-first within one task.
CREATE INDEX IF NOT EXISTS idx_llm_traces_created ON llm_traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_traces_task_created ON llm_traces(task, created_at DESC);
