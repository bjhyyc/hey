import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  SNAPSHOT_SCHEMA_VERSION,
  evaluateOperationsAlerts,
  normalizeQueueCounts,
  readOperationsSnapshot
} = require("../../platform/src/runtime/operations-snapshot");

const row = {
  outbox_pending: "2", outbox_leased: "1", outbox_failed: "3", outbox_dead: "0",
  outbox_ready: "4", outbox_expired_leases: "1", outbox_oldest_ready_seconds: "61",
  execution_pending: "2", execution_leased: "1", execution_retryable: "3",
  execution_succeeded: "4", execution_reconciliation_required: "0", execution_dead: "0",
  execution_expired_leases: "1"
};

describe("operations snapshot", () => {
  it("normalizes durable database and BullMQ counts without exposing payloads", async () => {
    const database = { query: vi.fn(async () => ({ rows: [row] })) };
    const queue = { getJobCounts: vi.fn(async () => ({ wait: 4, active: 1, failed: 0, completed: 8, delayed: 2 })) };
    const snapshot = await readOperationsSnapshot({ database, queue, now: () => 1_700_000_000_000 });
    expect(snapshot).toMatchObject({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt: "2023-11-14T22:13:20.000Z",
      outbox: { pending: 2, ready: 4, oldestReadySeconds: 61 },
      executions: { retryable: 3, expiredLeases: 1 },
      queue: { waiting: 4, active: 1, completed: 8, delayed: 2, failed: 0 }
    });
    expect(JSON.stringify(snapshot)).not.toContain("payload");
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(queue.getJobCounts).toHaveBeenCalledTimes(1);
  });

  it("fails closed for malformed counts and emits only bounded low-cardinality alerts", () => {
    expect(() => normalizeQueueCounts({ wait: "-1" })).toThrow(/non-negative/);
    const snapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      outbox: { oldestReadySeconds: 61, dead: 1 },
      executions: { dead: 1, reconciliationRequired: 1 },
      queue: { failed: 1 }
    };
    expect(evaluateOperationsAlerts(snapshot)).toEqual([
      { code: "outbox_oldest_ready", value: 61, threshold: 60 },
      { code: "outbox_dead", value: 1, threshold: 0 },
      { code: "execution_dead", value: 1, threshold: 0 },
      { code: "execution_reconciliation_required", value: 1, threshold: 0 },
      { code: "queue_failed", value: 1, threshold: 0 }
    ]);
  });
});
