import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  assertLoopbackRedisUrl,
  createDurableRecoveryRow,
  verifyEmptyRedisQueueRecovery
} = require("../../platform/src/development/verify-empty-redis-queue-recovery");

const root = path.resolve(import.meta.dirname, "..", "..");

class FakeQueue {
  constructor() {
    this.jobs = new Map();
  }

  async add(name, data, options) {
    this.jobs.set(options.jobId, { id: options.jobId, name, data });
    return { id: options.jobId };
  }

  async waitUntilReady() {}
  async getJobCounts() { return { wait: this.jobs.size }; }
  async getWaitingCount() { return this.jobs.size; }
  async close() {}
}

describe("empty Redis queue recovery rehearsal", () => {
  it("restores one deterministic durable job into an empty queue", async () => {
    const environment = {
      NODE_ENV: "development",
      PETPACK_PLATFORM_MODE: "development",
      PETPACK_REDIS_URL: "rediss://petpack:secret@127.0.0.1:56380/15",
      PETPACK_REDIS_CA_PEM: "test-ca",
      PETPACK_REDIS_RECOVERY_PHASE: "recovered",
      PETPACK_REDIS_RECOVERY_SEED: "stable-seed",
      PETPACK_QUEUE_NAME: "petpack-loss-test",
      PETPACK_QUEUE_PREFIX: "petpack-loss-test"
    };
    const report = await verifyEmptyRedisQueueRecovery({
      environment,
      QueueClass: FakeQueue,
      logger: { info: vi.fn() }
    });
    expect(report).toMatchObject({
      phase: "recovered",
      waitingBefore: 0,
      waitingAfter: 1,
      replayed: 1
    });
    expect(report.deterministicJobSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the same job identity across source and recovered namespaces", () => {
    expect(createDurableRecoveryRow("same").dedupe_key).toBe(createDurableRecoveryRow("same").dedupe_key);
    expect(createDurableRecoveryRow("same").dedupe_key).not.toBe(createDurableRecoveryRow("different").dedupe_key);
  });

  it("is development-only and loopback-only", async () => {
    expect(() => assertLoopbackRedisUrl("rediss://user:pass@localhost:6379/15")).not.toThrow();
    expect(() => assertLoopbackRedisUrl("rediss://user:pass@redis.example.com:6379/15")).toThrow(/loopback/);
    await expect(verifyEmptyRedisQueueRecovery({
      environment: { NODE_ENV: "production" }
    })).rejects.toThrow(/forbidden/);
  });

  it("never encodes destructive Redis or Docker operations in the tracked harness", () => {
    const harness = fs.readFileSync(
      path.join(root, "ops", "lighthouse", "data", "run-local-queue-loss-rehearsal.ps1"),
      "utf8"
    );
    expect(harness).toContain('simulation = "fresh-empty-queue-namespace"');
    expect(harness).not.toMatch(/FLUSHALL|FLUSHDB|UNLINK|docker\s+(rm|prune|stop|restart)|Remove-Item/i);
    expect(harness).not.toMatch(/--mount|--volume|-v\s/i);
  });
});
