import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  StudioWorkerRuntime,
  assertStudioWorkerSchemaReady,
  createStudioWorkerRuntime,
  loadStudioWorkerRuntimeConfig,
  validateWorkerComponents
} = require("../../platform/src/runtime/create-studio-worker");

function readySchemaRow(overrides = {}) {
  return {
    has_execution: true,
    has_master_generation: true,
    has_petpack_snapshot: true,
    has_usage_attempt: true,
    has_side_master: true,
    has_kaipay_adapter_version: true,
    has_kaipay_v3_identity: true,
    ...overrides
  };
}

function fakeDatabase() {
  return {
    assertReady: vi.fn(async () => ({ ready: true })),
    query: vi.fn(async () => ({ rows: [readySchemaRow()] })),
    transaction: vi.fn(),
    close: vi.fn(async () => undefined)
  };
}

function fakeComponents() {
  return {
    modelArkClient: {
      createFrontMaster: vi.fn(), createSideMaster: vi.fn(), createSleepingMaster: vi.fn(),
      createVideoTask: vi.fn(), getVideoTask: vi.fn()
    },
    masterImageProcessor: {
      version: "fixture-master/v1",
      contractVersion: "character-canvas-v1-master-processor/v1",
      normalizeAndInspect: vi.fn()
    },
    mattingService: { createMatteAndMetrics: vi.fn(), inspectProcessedAction: vi.fn() },
    deliveryValidator: {
      describe: vi.fn(() => ({ validatorVersion: "fixture-validator/v1", validatorIdentity: "fixture" })),
      validate: vi.fn()
    },
    probeAsset: vi.fn(),
    runMediaPlan: vi.fn(),
    close: vi.fn(async () => undefined)
  };
}

describe("Studio Worker runtime", () => {
  it("loads bounded development settings and requires explicit production paths", () => {
    expect(loadStudioWorkerRuntimeConfig({ PETPACK_WORKER_TEMP_ROOT: path.resolve(".") })).toMatchObject({
      mode: "development",
      production: false,
      videoLeaseSeconds: 120,
      heavyJobConcurrency: 1,
      deliveryRetentionDays: null
    });
    expect(() => loadStudioWorkerRuntimeConfig({
      PETPACK_PLATFORM_MODE: "production",
      PETPACK_WORKER_TEMP_ROOT: "/work",
      FFMPEG_PATH: "ffmpeg",
      FFPROBE_PATH: "/usr/bin/ffprobe",
      PETPACK_DELIVERY_RETENTION_DAYS: "30"
    })).toThrow(/FFmpeg path must be an absolute path/);
    expect(() => loadStudioWorkerRuntimeConfig({
      PETPACK_PLATFORM_MODE: "production",
      PETPACK_WORKER_TEMP_ROOT: "/work",
      FFMPEG_PATH: "/usr/bin/ffmpeg",
      FFPROBE_PATH: "/usr/bin/ffprobe"
    })).toThrow(/retention days are required/);
  });

  it("requires worker tables, the side-master migration, and Kaipay V3 migration", async () => {
    await expect(assertStudioWorkerSchemaReady({
      query: vi.fn(async () => ({ rows: [readySchemaRow({ has_side_master: false })] }))
    })).rejects.toThrow(/migration 015/);
    await expect(assertStudioWorkerSchemaReady({
      query: vi.fn(async () => ({ rows: [readySchemaRow({ has_kaipay_v3_identity: false })] }))
    })).rejects.toThrow(/migration 015/);
    await expect(assertStudioWorkerSchemaReady({
      query: vi.fn(async () => ({ rows: [readySchemaRow()] }))
    })).resolves.toEqual({ ready: true, migration: 15 });
  });

  it("forbids a real provider fallback in development and requires production assurance", () => {
    const components = fakeComponents();
    expect(validateWorkerComponents(components, { production: false })).toBe(components);
    expect(() => validateWorkerComponents({ ...components, modelArkClient: undefined }, { production: false })).toThrow(/fixture client/);
    expect(() => validateWorkerComponents(components, { production: true })).toThrow(/production-assured/);
  });

  it("checks database and filesystem readiness before consuming jobs", async () => {
    const database = fakeDatabase();
    const queueWorker = {
      start: vi.fn(async () => ({ ready: true, concurrency: 4 })),
      assertReady: vi.fn(async () => ({ ok: true })),
      close: vi.fn(async () => undefined)
    };
    const components = { close: vi.fn(async () => undefined) };
    const runtime = new StudioWorkerRuntime({
      database,
      queueWorker,
      components,
      config: loadStudioWorkerRuntimeConfig({ PETPACK_WORKER_TEMP_ROOT: path.resolve(".") }),
      logger: { info: vi.fn() }
    });
    await expect(runtime.start()).resolves.toMatchObject({ ready: true, concurrency: 4 });
    await expect(runtime.assertReady()).resolves.toMatchObject({ ready: true, mode: "development" });
    expect(database.assertReady.mock.invocationCallOrder[0]).toBeLessThan(queueWorker.start.mock.invocationCallOrder[0]);
    await runtime.close();
    expect(queueWorker.close).toHaveBeenCalledOnce();
    expect(components.close).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes an unopened queue when readiness fails", async () => {
    const database = fakeDatabase();
    database.query.mockResolvedValue({ rows: [readySchemaRow({ has_execution: false })] });
    const queueWorker = {
      start: vi.fn(async () => ({ ready: true, concurrency: 4 })),
      assertReady: vi.fn(async () => ({ ok: true })),
      close: vi.fn(async () => undefined)
    };
    const runtime = new StudioWorkerRuntime({
      database,
      queueWorker,
      config: loadStudioWorkerRuntimeConfig({ PETPACK_WORKER_TEMP_ROOT: path.resolve(".") }),
      logger: { info: vi.fn() }
    });
    await expect(runtime.start()).rejects.toThrow(/schema is not ready/);
    expect(queueWorker.start).not.toHaveBeenCalled();
    expect(queueWorker.close).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("assembles all fifteen job types behind one BullMQ worker", async () => {
    class FakeBullWorker {
      constructor(_name, processor) {
        this.processor = processor;
      }
      on() {}
      async run() {}
      async waitUntilReady() {}
      async close() {}
    }
    const database = fakeDatabase();
    const objectDriver = {
      createSignedUpload: vi.fn(), createSignedDownload: vi.fn(), putPrivate: vi.fn(),
      getPrivate: vi.fn(), headPrivate: vi.fn()
    };
    const components = fakeComponents();
    const runtime = await createStudioWorkerRuntime({
      environment: {
        PETPACK_PLATFORM_MODE: "development",
        PETPACK_WORKER_TEMP_ROOT: path.resolve("."),
        PETPACK_REDIS_URL: "rediss://worker:password@localhost:6379/15",
        PETPACK_REDIS_CA_PEM: "fixture-ca",
        PETPACK_QUEUE_NAME: "petpack-test",
        PETPACK_QUEUE_PREFIX: "petpack-test",
        PETPACK_QUEUE_WORKER_CONCURRENCY: "2"
      },
      database,
      objectDriver,
      modelRegistry: {
        version: "fixture-registry/v1",
        modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
      },
      workerComponents: components,
      WorkerClass: FakeBullWorker,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    expect(runtime.components.router).toBeTruthy();
    expect(runtime.components.imageMasterWorker).toBeTruthy();
    expect(runtime.components.productionJobWorker).toBeTruthy();
    expect(runtime.components.petpackPipelineWorker).toBeTruthy();
    await runtime.start();
    await runtime.close();
  });
});
