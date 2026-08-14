import { describe, expect, it, vi } from "vitest";

import queueModule from "../../platform/src/queue/bullmq-workflow-queue.js";

const { BullMqWorkflowWorker } = queueModule;

const config = Object.freeze({
  queueName: "health-contract",
  prefix: "petpack-health-contract",
  host: "localhost",
  port: 6379,
  username: "worker",
  password: "fixture-password",
  database: 15,
  ca: "fixture-ca",
  concurrency: 1
});

class ReadyWorker {
  constructor() {
    this._resolveRun = null;
    this.client = Promise.resolve({ ping: vi.fn(async () => "PONG") });
  }
  on() {}
  run() { return new Promise((resolve) => { this._resolveRun = resolve; }); }
  async waitUntilReady() {}
  async close() { this._resolveRun?.(); }
}

class FailedWorker extends ReadyWorker {
  run() { return Promise.reject(new Error("worker loop failed")); }
}

describe("BullMQ worker health", () => {
  it("probes the running loop and its Redis client", async () => {
    const runtime = new BullMqWorkflowWorker({
      config,
      handler: { process: vi.fn() },
      WorkerClass: ReadyWorker,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    await runtime.start();
    await expect(runtime.assertReady()).resolves.toEqual({ ok: true });
    const client = await runtime.worker.client;
    expect(client.ping).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("fails closed after the BullMQ processing loop exits unexpectedly", async () => {
    const runtime = new BullMqWorkflowWorker({
      config,
      handler: { process: vi.fn() },
      WorkerClass: FailedWorker,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    await runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(runtime.assertReady()).rejects.toThrow(/not running/);
    await runtime.close();
  });
});
