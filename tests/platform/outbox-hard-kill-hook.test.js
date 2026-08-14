import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  PostgresOutboxDispatcher
} = require("../../platform/src/persistence/postgres-transactional-workflow-store");
const {
  createOutboxDispatcherRuntime
} = require("../../platform/src/runtime/create-outbox-dispatcher");
const {
  CHILD_ENTRY_BY_ROLE,
  requireOwnedChildRecord
} = require("../../platform/src/development/run-zero-cost-rehearsal");

describe("outbox hard-kill checkpoint", () => {
  it("runs the after-claim hook after the durable lease and before queue enqueue", async () => {
    const order = [];
    const database = {
      async transaction(callback) {
        return callback({
          async query(sql) {
            if (sql.includes("WITH candidates")) {
              order.push("claim");
              return { rows: [{
                id: "10000000-0000-4000-8000-000000000001",
                payload: {
                  name: "petpack.generate-front-master",
                  data: { runId: "20000000-0000-4000-8000-000000000001" },
                  options: { jobId: "petpack:front", attempts: 3, backoff: { type: "exponential", delay: 5000 } }
                },
                dedupe_key: "petpack:front",
                lease_token: "30000000-0000-4000-8000-000000000001",
                attempts: 1
              }] };
            }
            order.push("mark-sent");
            return { rows: [] };
          }
        });
      }
    };
    const queue = { enqueue: vi.fn(async () => { order.push("enqueue"); }) };
    const afterClaim = vi.fn(async (messages) => {
      order.push("checkpoint");
      expect(messages).toEqual([{
        id: "10000000-0000-4000-8000-000000000001",
        jobName: "petpack.generate-front-master",
        dedupeKey: "petpack:front"
      }]);
    });
    const dispatcher = new PostgresOutboxDispatcher({ database, queue, afterClaim });

    await expect(dispatcher.dispatchBatch({ limit: 1, leaseSeconds: 5 })).resolves.toEqual({ claimed: 1 });
    expect(order).toEqual(["claim", "checkpoint", "enqueue", "mark-sent"]);
  });

  it("runs the post-enqueue hook before the durable sent marker", async () => {
    const order = [];
    const database = {
      async transaction(callback) {
        return callback({
          async query(sql) {
            if (sql.includes("WITH candidates")) {
              order.push("claim");
              return { rows: [{
                id: "10000000-0000-4000-8000-000000000001",
                payload: {
                  name: "petpack.generate-front-master",
                  data: { runId: "20000000-0000-4000-8000-000000000001" },
                  options: { jobId: "petpack:front", attempts: 3, backoff: { type: "exponential", delay: 5000 } }
                },
                dedupe_key: "petpack:front",
                lease_token: "30000000-0000-4000-8000-000000000001",
                attempts: 1
              }] };
            }
            order.push("mark-sent");
            return { rows: [] };
          }
        });
      }
    };
    const queue = { enqueue: vi.fn(async () => { order.push("enqueue"); }) };
    const afterEnqueue = vi.fn(async (message) => {
      order.push("checkpoint");
      expect(message).toEqual({
        id: "10000000-0000-4000-8000-000000000001",
        jobName: "petpack.generate-front-master",
        dedupeKey: "petpack:front"
      });
    });
    const dispatcher = new PostgresOutboxDispatcher({ database, queue, afterEnqueue });

    await expect(dispatcher.dispatchBatch({ limit: 1, leaseSeconds: 5 })).resolves.toEqual({ claimed: 1 });
    expect(order).toEqual(["claim", "enqueue", "checkpoint", "mark-sent"]);
  });

  it("rejects an injected after-claim hook in production before opening resources", async () => {
    await expect(createOutboxDispatcherRuntime({
      environment: { PETPACK_PLATFORM_MODE: "production" },
      afterEnqueue() {}
    })).rejects.toThrow(/forbidden in production/i);
  });

  it("does not emit a post-enqueue checkpoint when the queue rejects the publish", async () => {
    const database = {
      async transaction(callback) {
        return callback({
          async query(sql) {
            if (sql.includes("WITH candidates")) {
              return { rows: [{
                id: "10000000-0000-4000-8000-000000000001",
                payload: {
                  name: "petpack.generate-front-master",
                  data: { runId: "20000000-0000-4000-8000-000000000001" },
                  options: { jobId: "petpack:front", attempts: 3, backoff: { type: "exponential", delay: 5000 } }
                },
                dedupe_key: "petpack:front",
                lease_token: "30000000-0000-4000-8000-000000000001",
                attempts: 1
              }] };
            }
            return { rows: [] };
          }
        });
      }
    };
    const afterEnqueue = vi.fn();
    const dispatcher = new PostgresOutboxDispatcher({
      database,
      queue: { enqueue: vi.fn(async () => { throw new Error("redis unavailable"); }) },
      afterEnqueue
    });

    await expect(dispatcher.dispatchBatch({ limit: 1, leaseSeconds: 5 })).resolves.toEqual({ claimed: 1 });
    expect(afterEnqueue).not.toHaveBeenCalled();
  });

  it("pins owned child records to the exact Node executable and role entry", () => {
    const child = {
      spawnfile: process.execPath,
      spawnargs: [process.execPath, CHILD_ENTRY_BY_ROLE.api],
      kill() {}
    };
    expect(requireOwnedChildRecord({ role: "api", entry: CHILD_ENTRY_BY_ROLE.api, child })).toBe(child);
    expect(() => requireOwnedChildRecord({
      role: "api",
      entry: CHILD_ENTRY_BY_ROLE.worker,
      child
    })).toThrow(/unexpected role or entry/i);
  });

  it("contains no broad process, Docker, Redis, or filesystem destruction fallback", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "..", "platform", "src", "development", "run-zero-cost-rehearsal.js"),
      "utf8"
    );
    expect(source).toContain('child.kill("SIGKILL")');
    expect(source).not.toMatch(/\b(?:taskkill|Stop-Process|process\.kill|tree-kill|FLUSHALL|FLUSHDB|Remove-Item)\b/i);
    expect(source).not.toMatch(/docker\s+(?:rm|prune|stop|restart|volume)/i);
    expect(source).not.toMatch(/\brm\s+-/i);

    const wrapper = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "..", "ops", "lighthouse", "data", "run-local-hard-kill-rehearsal.ps1"),
      "utf8"
    );
    expect(wrapper).toContain("$Process.Kill($true)");
    expect(wrapper).toContain("& $pgCtl stop -D $dataDir -m fast");
    expect(wrapper).toContain("& $dockerExe inspect");
    expect(wrapper).toContain('[ValidateSet("all", "outbox-after-enqueue")]');
    expect(wrapper).not.toMatch(/\b(?:taskkill|Stop-Process|FLUSHALL|FLUSHDB|Remove-Item|Clear-Content)\b/i);
    expect(wrapper).not.toMatch(/docker\s+(?:rm|prune|stop|restart|volume)/i);
    expect(wrapper).not.toMatch(/\brm\s+-/i);
  });
});
