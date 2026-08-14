import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  POSTGRES_INFRASTRUCTURE_RETRY_MS,
  PostgresDatabase,
  PostgresInfrastructureError,
  isTransientPostgresError
} = require("../../platform/src/persistence/postgres-database");
const { BullMqWorkflowWorker } = require("../../platform/src/queue/bullmq-workflow-queue");

const QUEUE_CONFIG = Object.freeze({
  queueName: "petpack-postgres-failure-test",
  prefix: "petpack-postgres-failure-test",
  host: "redis.invalid",
  port: 6379,
  username: "test-user",
  password: "test-password",
  database: 0,
  ca: "test-ca",
  concurrency: 1
});

class FakeBullWorker {
  constructor(_name, processor) {
    this.processor = processor;
  }

  on() {}
  async run() {}
  async waitUntilReady() {}
  async close() {}
}

class FakeDelayedError extends Error {
  constructor() {
    super("bullmq:movedToDelayed");
    this.name = "DelayedError";
  }
}

function pool(overrides = {}) {
  return {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(async () => undefined),
    ...overrides
  };
}

describe("PostgreSQL transient infrastructure failures", () => {
  it("recognizes only connection and server-availability error classes", () => {
    for (const code of ["08006", "57P01", "57P02", "57P03", "53300", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]) {
      expect(isTransientPostgresError({ code }), code).toBe(true);
    }
    for (const code of ["23514", "23505", "22P02", "42501", "P0001", undefined]) {
      expect(isTransientPostgresError({ code }), String(code)).toBe(false);
    }
  });

  it("turns a direct connection outage into a bounded delayed-retry signal", async () => {
    const cause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const database = new PostgresDatabase({
      pool: pool({ query: vi.fn(async () => { throw cause; }) }),
      logger: { debug() {}, warn() {}, error() {} }
    });

    await expect(database.query("SELECT 1")).rejects.toMatchObject({
      name: "PostgresInfrastructureError",
      code: "postgres_temporarily_unavailable",
      retryAfterMs: POSTGRES_INFRASTRUCTURE_RETRY_MS,
      cause
    });
  });

  it("does not hide constraints or application SQL errors as infrastructure", async () => {
    const cause = Object.assign(new Error("check failed"), { code: "23514" });
    const database = new PostgresDatabase({
      pool: pool({ query: vi.fn(async () => { throw cause; }) }),
      logger: { debug() {}, warn() {}, error() {} }
    });

    await expect(database.query("SELECT 1")).rejects.toBe(cause);
    expect(cause).not.toHaveProperty("retryAfterMs");
  });

  it("classifies pool-connect failure before a transaction starts", async () => {
    const cause = Object.assign(new Error("server starting"), { code: "57P03" });
    const database = new PostgresDatabase({
      pool: pool({ connect: vi.fn(async () => { throw cause; }) }),
      logger: { debug() {}, warn() {}, error() {} }
    });

    await expect(database.transaction(async () => undefined)).rejects.toBeInstanceOf(PostgresInfrastructureError);
  });

  it("still attempts rollback and releases the client after a mid-transaction outage", async () => {
    const cause = Object.assign(new Error("connection lost"), { code: "08006" });
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(cause)
        .mockRejectedValueOnce(cause),
      release: vi.fn()
    };
    const database = new PostgresDatabase({
      pool: pool({ connect: vi.fn(async () => client) }),
      logger: { debug() {}, warn: vi.fn(), error: vi.fn() }
    });

    await expect(database.transaction(async (transaction) => transaction.query("SELECT work")))
      .rejects.toMatchObject({ code: "postgres_temporarily_unavailable", retryAfterMs: 5_000 });
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("handles idle pool disconnect events without crashing the process", async () => {
    const events = new EventEmitter();
    const databasePool = Object.assign(events, pool());
    const logger = { debug() {}, warn() {}, error: vi.fn() };
    const database = new PostgresDatabase({ pool: databasePool, logger });

    expect(() => events.emit("error", Object.assign(new Error("administrator shutdown"), { code: "57P01" })))
      .not.toThrow();
    expect(logger.error).toHaveBeenCalledWith("petpack.postgres.pool_error", {
      errorName: "Error",
      errorCode: "postgres_temporarily_unavailable"
    });

    await database.close();
    expect(events.listenerCount("error")).toBe(0);
  });

  it("moves a PostgreSQL infrastructure failure to BullMQ delayed without consuming attempts", async () => {
    const cause = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const database = new PostgresDatabase({
      pool: pool({ query: vi.fn(async () => { throw cause; }) }),
      logger: { debug() {}, warn() {}, error() {} }
    });
    const handler = {
      process: vi.fn(async () => database.query("SELECT 1"))
    };
    const runtime = new BullMqWorkflowWorker({
      config: QUEUE_CONFIG,
      handler,
      WorkerClass: FakeBullWorker,
      DelayedErrorClass: FakeDelayedError,
      logger: { info() {}, warn() {}, error() {} }
    });
    const job = {
      id: "postgres-outage-job",
      name: "petpack.generate-front-master",
      data: { runId: "run-postgres-outage" },
      opts: { jobId: "postgres-outage-job", attempts: 1 },
      attemptsMade: 0,
      moveToDelayed: vi.fn(async () => undefined)
    };
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);

    await expect(runtime.worker.processor(job, "bull-lock-token"))
      .rejects.toMatchObject({ name: "DelayedError" });

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      2_000_000 + POSTGRES_INFRASTRUCTURE_RETRY_MS,
      "bull-lock-token"
    );
    expect(job.attemptsMade).toBe(0);
  });
});
