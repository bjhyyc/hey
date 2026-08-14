import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  OutboxDispatcherRuntime,
  assertOutboxSchemaReady,
  loadOutboxRuntimeConfig
} = require("../../platform/src/runtime/create-outbox-dispatcher");

function dependencies({ dispatchResults = [{ claimed: 0 }] } = {}) {
  const database = {
    assertReady: vi.fn(async () => ({ ready: true })),
    query: vi.fn(async () => ({ rows: [{ has_outbox: true, has_run: true, has_execution: true }] })),
    close: vi.fn(async () => undefined)
  };
  const queue = {
    assertReady: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => undefined)
  };
  const dispatcher = {
    dispatchBatch: vi.fn(async () => dispatchResults.shift() || { claimed: 0 })
  };
  return { database, queue, dispatcher };
}

describe("outbox dispatcher runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates bounded runtime settings", () => {
    expect(loadOutboxRuntimeConfig({})).toMatchObject({
      pollIntervalMs: 1000,
      batchLimit: 25,
      leaseSeconds: 60
    });
    expect(() => loadOutboxRuntimeConfig({ PETPACK_OUTBOX_BATCH_LIMIT: "101" })).toThrow(/batch limit/);
    expect(() => loadOutboxRuntimeConfig({ PETPACK_OUTBOX_LEASE_SECONDS: "4" })).toThrow(/lease duration/);
  });

  it("fails readiness when the durable outbox schema is absent", async () => {
    await expect(assertOutboxSchemaReady({
      query: vi.fn(async () => ({ rows: [{ has_outbox: false, has_run: true }] }))
    })).rejects.toThrow(/schema is not ready/);
  });

  it("polls immediately, uses the busy delay, and closes both resources", async () => {
    vi.useFakeTimers();
    const deps = dependencies({ dispatchResults: [{ claimed: 2 }, { claimed: 0 }] });
    const runtime = new OutboxDispatcherRuntime({
      ...deps,
      config: {
        pollIntervalMs: 100,
        busyIntervalMs: 10,
        maximumErrorBackoffMs: 1000,
        batchLimit: 20,
        leaseSeconds: 45
      },
      logger: { warn: vi.fn() }
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.dispatcher.dispatchBatch).toHaveBeenCalledWith({ limit: 20, leaseSeconds: 45 });
    await vi.advanceTimersByTimeAsync(10);
    expect(deps.dispatcher.dispatchBatch).toHaveBeenCalledTimes(2);
    expect(runtime.status()).toMatchObject({ running: true, consecutiveFailures: 0 });
    await expect(runtime.assertReady()).resolves.toMatchObject({ ready: true, consecutiveFailures: 0 });

    await runtime.close();
    expect(deps.queue.close).toHaveBeenCalledOnce();
    expect(deps.database.close).toHaveBeenCalledOnce();
    expect(runtime.status()).toMatchObject({ running: false, closed: true });
  });

  it("backs off after failures without terminating the process loop", async () => {
    vi.useFakeTimers();
    const deps = dependencies();
    deps.dispatcher.dispatchBatch
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue({ claimed: 0 });
    const logger = { warn: vi.fn() };
    const runtime = new OutboxDispatcherRuntime({
      ...deps,
      config: {
        pollIntervalMs: 50,
        busyIntervalMs: 0,
        maximumErrorBackoffMs: 1000,
        batchLimit: 25,
        leaseSeconds: 60
      },
      logger
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.status().consecutiveFailures).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith("petpack.outbox.dispatch_cycle_failed", expect.objectContaining({
      consecutiveFailures: 1,
      errorName: "Error"
    }));
    await vi.advanceTimersByTimeAsync(50);
    expect(deps.dispatcher.dispatchBatch).toHaveBeenCalledTimes(2);
    expect(runtime.status().consecutiveFailures).toBe(0);
    await runtime.close();
  });

  it("fails readiness after repeated dispatch errors", async () => {
    const deps = dependencies();
    const runtime = new OutboxDispatcherRuntime({
      ...deps,
      config: loadOutboxRuntimeConfig(),
      logger: { warn: vi.fn() }
    });
    runtime.running = true;
    runtime.consecutiveFailures = 3;
    await expect(runtime.assertReady()).rejects.toThrow(/repeated dispatch failures/);
    runtime.running = false;
    await runtime.close();
  });

  it("closes dependencies when readiness fails", async () => {
    const deps = dependencies();
    deps.queue.assertReady.mockRejectedValue(new Error("redis unavailable"));
    const runtime = new OutboxDispatcherRuntime({
      ...deps,
      config: loadOutboxRuntimeConfig(),
      logger: { warn: vi.fn() }
    });
    await expect(runtime.start()).rejects.toThrow(/redis unavailable/);
    expect(deps.queue.close).toHaveBeenCalledOnce();
    expect(deps.database.close).toHaveBeenCalledOnce();
  });
});
