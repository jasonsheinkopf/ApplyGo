// Bounded concurrency and duplicate-run prevention for Find Jobs (and any other multi-item scan
// this app runs). Split out from index.ts so both pieces are unit-testable without pulling in the
// whole Worker entrypoint -- see runPooled and acquireScanLock/releaseScanLock's own comments for
// why each exists.

/**
 * Runs `fn` over `items` with at most `concurrency` in flight at once, calling `onSettle` as each
 * one finishes (in completion order, not list order) so progress can still stream live rather than
 * only once the whole batch is done. Company board scans and job-fit LLM calls are both purely
 * I/O-bound -- almost all of their time is spent waiting on a fetch or a model response, not on
 * CPU -- so running a handful at once instead of one after another cuts wall-clock time roughly by
 * the concurrency factor for free, which is what turns "several minutes across multiple rounds"
 * into "under a minute in one click" for a realistic company list or posting backlog.
 *
 * This is also the app's only defense against an uncontrolled `Promise.all(items.map(...))` fan-out:
 * no matter how large `items` is, at most `concurrency` external fetches from this loop are ever
 * in flight at once.
 */
export async function runPooled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  onSettle: (item: T, result: R) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      const result = await fn(item);
      await onSettle(item, result);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()));
}

/** The minimal D1 surface acquireScanLock/releaseScanLock need, so tests can pass a lightweight
 * mock instead of a real D1Database. */
export type ScanLockDb = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

/**
 * Prevents two Find Jobs runs of the same stage (scan, or screen/assess) from executing at once --
 * a double-click, a second tab, or a client retry firing a second full run while one is still in
 * flight, which would otherwise double this invocation's real subrequest usage for no benefit (the
 * two runs would just re-read and re-score largely the same rows). A plain D1 row is enough: each
 * stage already lives entirely inside one bounded Worker invocation (see scanCompanies/processJobs
 * in src/index.ts), so there is no cross-invocation coordination to do that would justify a
 * Durable Object.
 *
 * `staleMinutes` bounds how long a lock can outlive its run: if the previous holder's isolate was
 * recycled or its connection dropped without releasing the lock, a new run is still allowed to
 * start once the old one is older than this, rather than the feature being stuck locked out
 * forever by one interrupted run.
 *
 * Returns the new run's id (to pass to releaseScanLock later) when the lock was acquired, or null
 * when another run already holds it and isn't stale yet.
 */
export async function acquireScanLock(db: ScanLockDb, scanType: string, staleMinutes = 10): Promise<string | null> {
  const runId = crypto.randomUUID();
  const existing = await db
    .prepare("SELECT run_id, started_at FROM scan_locks WHERE scan_type = ?")
    .bind(scanType)
    .first<{ run_id: string; started_at: string }>();
  if (existing) {
    const ageMinutes = (Date.now() - new Date(`${existing.started_at}Z`).getTime()) / 60000;
    if (ageMinutes < staleMinutes) return null;
  }
  await db
    .prepare(
      `INSERT INTO scan_locks (scan_type, run_id, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(scan_type) DO UPDATE SET run_id = excluded.run_id, started_at = excluded.started_at`,
    )
    .bind(scanType, runId)
    .run();
  return runId;
}

/** Only releases the lock if it still belongs to this run -- a stale-lock takeover (see
 * acquireScanLock) must not have its lock yanked out from under it by the run it superseded
 * finally getting around to cleaning up after itself. */
export async function releaseScanLock(db: ScanLockDb, scanType: string, runId: string): Promise<void> {
  await db.prepare("DELETE FROM scan_locks WHERE scan_type = ? AND run_id = ?").bind(scanType, runId).run();
}
