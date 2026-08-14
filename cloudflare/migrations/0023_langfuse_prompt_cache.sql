CREATE TABLE IF NOT EXISTS langfuse_prompt_cache (
  prompt_name TEXT PRIMARY KEY,
  prompt_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
