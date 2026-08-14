import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  PostgresSentOutboxReconciler
} = require("../../platform/src/persistence/postgres-transactional-workflow-store");
const {
  OutboxDispatcherRuntime,
  loadOutboxRuntimeConfig
} = require("../../platform/src/runtime/create-outbox-dispatcher");

function durableJob({ suffix = "one" } = {}) {
  const dedupeKey = `petpack-${suffix}`;
  return {
    id: `10000000-0000-4000-8000-00000000000${suffix === "one" ? "1" : "2"}`,
    job_name: "petpack.generate-front-master",
    payload: {
      name: "petpack.generate-front-master",
      data: { runId: "20000000-0000-4000-8000-000000000001" },
      options: { jobId: dedupeKey, attempts: 3 }
    },
    dedupe_key: dedupeKey,
    created_at: suffix === "one" ? "2026-08-13T20:00:00.000Z" : "2026-08-13T20:00:01.000Z"
  };
}

function databaseWithRows(rows) {
  const query = vi.fn(async () => ({ rows }));
  return {
    query,
    transaction: vi.fn(async (callback) => callback({ query }))
  };
}

describe("sent outbox reconciliation", () => {
  it("replays durable non-terminal jobs with their original deterministic ID", async () => {
    const database = databaseWithRows([durableJob()]);
    const queue = { enqueue: vi.fn(async (job) => ({ jobId: job.dedupeKey })) };
    const reconciler = new PostgresSentOutboxReconciler({ database, queue, logger: { info: vi.fn() } });

    const result = await reconciler.replayBatch({ limit: 10 });

    expect(result).toEqual({
      scanned: 1,
      replayed: 1,
      complete: true,
      nextCursor: {
        createdAt: "2026-08-13T20:00:00.000Z",
        id: "10000000-0000-4000-8000-000000000001"
      }
    });
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      name: "petpack.generate-front-master",
      dedupeKey: "petpack-one",
      options: expect.objectContaining({ jobId: "petpack-one" })
    }));
    const sql = database.query.mock.calls[0][0];
    expect(sql).toContain("outbox.status = 'sent'");
    expect(sql).toContain("run.state NOT IN ('deliverable', 'failed')");
    expect(sql).toContain("execution.status IN ('pending', 'leased', 'retryable')");
    expect(sql).toContain("outbox.job_name <> 'petpack.await-photos'");
  });

  it("paginates without mutating durable outbox status", async () => {
    const first = durableJob({ suffix: "one" });
    const second = durableJob({ suffix: "two" });
    const database = databaseWithRows([first]);
    const queue = { enqueue: vi.fn(async () => undefined) };
    const reconciler = new PostgresSentOutboxReconciler({ database, queue });

    const firstResult = await reconciler.replayBatch({ limit: 1 });
    database.query.mockResolvedValueOnce({ rows: [second] });
    const secondResult = await reconciler.replayBatch({ limit: 1, cursor: firstResult.nextCursor });

    expect(firstResult.complete).toBe(false);
    expect(secondResult.nextCursor.id).toBe(second.id);
    expect(database.query.mock.calls[1][1]).toEqual([
      1,
      firstResult.nextCursor.createdAt,
      firstResult.nextCursor.id
    ]);
    expect(database.query.mock.calls.flatMap((call) => call[0])).not.toContain("UPDATE outbox_job");
  });

  it("fails closed when durable metadata and payload disagree", async () => {
    const row = durableJob();
    row.job_name = "petpack.generate-side-master";
    const queue = { enqueue: vi.fn(async () => undefined) };
    const reconciler = new PostgresSentOutboxReconciler({ database: databaseWithRows([row]), queue });

    await expect(reconciler.replayBatch()).rejects.toThrow(/does not match/);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("runs a bounded reconciliation scan immediately and then on its interval", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const database = {
      assertReady: vi.fn(async () => ({ ready: true })),
      query: vi.fn(async () => ({ rows: [{ has_outbox: true, has_run: true, has_execution: true }] })),
      close: vi.fn(async () => undefined)
    };
    const queue = {
      assertReady: vi.fn(async () => ({ ok: true })),
      close: vi.fn(async () => undefined)
    };
    const dispatcher = { dispatchBatch: vi.fn(async () => ({ claimed: 0 })) };
    const reconciler = {
      replayBatch: vi.fn()
        .mockResolvedValueOnce({ replayed: 1, complete: false, nextCursor: { createdAt: "2026-08-13T20:00:00.000Z", id: "row-1" } })
        .mockResolvedValueOnce({ replayed: 1, complete: true, nextCursor: null })
        .mockResolvedValue({ replayed: 0, complete: true, nextCursor: null })
    };
    const runtime = new OutboxDispatcherRuntime({
      database,
      queue,
      dispatcher,
      reconciler,
      now: () => now,
      logger: { warn: vi.fn() },
      config: {
        pollIntervalMs: 100,
        busyIntervalMs: 10,
        maximumErrorBackoffMs: 1000,
        batchLimit: 25,
        leaseSeconds: 60,
        reconcileIntervalMs: 5000,
        reconcileBatchLimit: 10
      }
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconciler.replayBatch).toHaveBeenNthCalledWith(1, { limit: 10, cursor: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(reconciler.replayBatch).toHaveBeenNthCalledWith(2, {
      limit: 10,
      cursor: { createdAt: "2026-08-13T20:00:00.000Z", id: "row-1" }
    });
    expect(runtime.status()).toMatchObject({ lastReplayed: 1, reconciliationInProgress: false });

    now = 5_999;
    await vi.advanceTimersByTimeAsync(100);
    expect(reconciler.replayBatch).toHaveBeenCalledTimes(2);
    now = 6_000;
    await vi.advanceTimersByTimeAsync(100);
    expect(reconciler.replayBatch).toHaveBeenCalledTimes(3);
    await runtime.close();
    vi.useRealTimers();
  });

  it("bounds reconciliation configuration", () => {
    expect(loadOutboxRuntimeConfig({})).toMatchObject({
      reconcileIntervalMs: 60_000,
      reconcileBatchLimit: 100
    });
    expect(() => loadOutboxRuntimeConfig({ PETPACK_OUTBOX_RECONCILE_INTERVAL_MS: "4999" })).toThrow(/interval/);
    expect(() => loadOutboxRuntimeConfig({ PETPACK_OUTBOX_RECONCILE_BATCH_LIMIT: "101" })).toThrow(/batch limit/);
  });
});
