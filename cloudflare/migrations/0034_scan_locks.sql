-- Prevents two Find Jobs runs (scan or screen/assess stage) from executing concurrently --
-- double-clicking, a second browser tab, or a client retry firing a second full scan while one is
-- still in flight. Deliberately a plain D1 row, not a Durable Object: a Find Jobs run already
-- lives entirely inside one bounded Worker invocation per stage (see scanCompanies/processJobs in
-- src/index.ts), so a simple "is one already running" check-and-set is enough -- there is no
-- cross-invocation coordination or queueing to do.
--
-- `started_at` doubles as the staleness clock: if a lock is older than the stale window
-- (acquireScanLock's staleMinutes), it is treated as abandoned (isolate recycled, connection
-- dropped) and a new run is allowed to take over rather than the app being stuck locked out
-- forever by one interrupted run.
CREATE TABLE IF NOT EXISTS scan_locks (
  scan_type TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
