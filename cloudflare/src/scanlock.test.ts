import assert from "node:assert/strict";
import test from "node:test";

import { acquireScanLock, releaseScanLock, runPooled, type ScanLockDb } from "./scanlock.ts";

// ---------------------------------------------------------------------------
// runPooled: bounded concurrency
// ---------------------------------------------------------------------------

test("runPooled never runs more than `concurrency` items at once", async () => {
  const items = Array.from({ length: 30 }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;
  await runPooled(
    items,
    4,
    async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so other workers actually get a chance to start concurrently, exercising the real
      // race rather than a synchronous loop that could never overlap regardless of the bug.
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item;
    },
    async () => {},
  );
  assert.ok(maxInFlight <= 4, `expected at most 4 concurrent, saw ${maxInFlight}`);
  assert.equal(maxInFlight, 4, "should actually reach the configured concurrency, not run serially");
});

test("runPooled processes every item exactly once, regardless of list size", async () => {
  const items = Array.from({ length: 137 }, (_, i) => i);
  const seen: number[] = [];
  await runPooled(
    items,
    6,
    async (item) => item,
    async (_item, result) => {
      seen.push(result);
    },
  );
  assert.equal(seen.length, items.length);
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
});

test("runPooled with a tiny item list never exceeds the item count", async () => {
  const items = [1, 2];
  let maxInFlight = 0;
  let inFlight = 0;
  await runPooled(
    items,
    6,
    async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item;
    },
    async () => {},
  );
  assert.ok(maxInFlight <= 2);
});

test("one item's failure does not prevent the rest from completing, when the caller isolates errors", async () => {
  // runPooled itself just propagates whatever `fn` throws (via Promise.all) -- the app's actual
  // error isolation is the caller wrapping its own per-item logic in try/catch, exactly like
  // scanOneCompany's call site in src/index.ts ("one company's board timing out ... must not
  // abort every other company still in flight"). This test exercises that same pattern directly.
  const items = [1, 2, 3, 4, 5];
  const settled: number[] = [];
  await runPooled(
    items,
    3,
    async (item) => {
      try {
        if (item === 3) throw new Error("boom");
        return { ok: true, item };
      } catch (err) {
        return { ok: false, item, error: (err as Error).message };
      }
    },
    async (_item, result) => {
      settled.push(result.item);
    },
  );
  assert.equal(settled.length, items.length, "every item must still be reported, including the one that failed");
});

// ---------------------------------------------------------------------------
// Scan lock: duplicate-run prevention
// ---------------------------------------------------------------------------

/** In-memory fake matching the minimal D1 surface ScanLockDb needs, so these tests exercise the
 * real acquire/release SQL logic without a live D1 binding. */
function fakeScanLockDb(): ScanLockDb & { rows: Map<string, { run_id: string; started_at: string }> } {
  const rows = new Map<string, { run_id: string; started_at: string }>();
  return {
    rows,
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (query.startsWith("SELECT")) {
                const [scanType] = values as [string];
                return (rows.get(scanType) as T) ?? null;
              }
              return null;
            },
            async run(): Promise<unknown> {
              if (query.startsWith("INSERT")) {
                const [scanType, runId] = values as [string, string];
                rows.set(scanType, { run_id: runId, started_at: new Date().toISOString().replace("Z", "") });
              } else if (query.startsWith("DELETE")) {
                const [scanType, runId] = values as [string, string];
                if (rows.get(scanType)?.run_id === runId) rows.delete(scanType);
              }
              return {};
            },
          };
        },
      };
    },
  };
}

test("acquireScanLock refuses a second run while the first is still active", async () => {
  const db = fakeScanLockDb();
  const first = await acquireScanLock(db, "scan");
  assert.ok(first, "the first run must acquire the lock");
  const second = await acquireScanLock(db, "scan");
  assert.equal(second, null, "a concurrent second run must be refused, not silently allowed to double-scan");
});

test("acquireScanLock allows a new run once the previous lock has released", async () => {
  const db = fakeScanLockDb();
  const first = await acquireScanLock(db, "scan");
  assert.ok(first);
  await releaseScanLock(db, "scan", first!);
  const second = await acquireScanLock(db, "scan");
  assert.ok(second, "releasing must free the lock for the next run");
});

test("acquireScanLock treats a stale lock as abandoned and takes it over", async () => {
  const db = fakeScanLockDb();
  db.rows.set("scan", { run_id: "old-run", started_at: new Date(Date.now() - 20 * 60000).toISOString().replace("Z", "") });
  const runId = await acquireScanLock(db, "scan", 10);
  assert.ok(runId, "a lock older than staleMinutes must not block a new run forever");
  assert.notEqual(runId, "old-run");
});

test("releaseScanLock does not release a lock that belongs to a different (newer) run", async () => {
  const db = fakeScanLockDb();
  db.rows.set("scan", { run_id: "current-run", started_at: new Date().toISOString().replace("Z", "") });
  // A superseded run finally getting around to its own cleanup must not yank out the lock the
  // takeover run (acquireScanLock's stale-lock path) is now legitimately holding.
  await releaseScanLock(db, "scan", "superseded-run");
  assert.equal(db.rows.get("scan")?.run_id, "current-run");
});

test("scan and process are independent locks -- one running does not block the other", async () => {
  const db = fakeScanLockDb();
  const scanRun = await acquireScanLock(db, "scan");
  const processRun = await acquireScanLock(db, "process");
  assert.ok(scanRun);
  assert.ok(processRun);
});
