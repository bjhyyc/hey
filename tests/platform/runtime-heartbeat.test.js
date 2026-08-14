import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  RuntimeHeartbeat,
  loadRuntimeHeartbeatConfig
} = require("../../platform/src/runtime/runtime-heartbeat");
const { assertRuntimeHeartbeat } = require("../../platform/src/runtime/check-runtime-heartbeat");

const testRoot = path.resolve(".tmp", "runtime-heartbeat-tests");
let caseRoot;

beforeEach(async () => {
  await fsp.mkdir(testRoot, { recursive: true });
  caseRoot = await fsp.mkdtemp(path.join(testRoot, "case-"));
});

afterEach(async () => {
  if (caseRoot && fs.existsSync(caseRoot)) await fsp.rm(caseRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runtime heartbeat", () => {
  it("requires an absolute heartbeat path in production and bounds its freshness", () => {
    expect(() => loadRuntimeHeartbeatConfig({ PETPACK_PLATFORM_MODE: "production" }, "studio-worker"))
      .toThrow(/heartbeat file is required/);
    expect(() => loadRuntimeHeartbeatConfig({
      PETPACK_PLATFORM_MODE: "production",
      PETPACK_RUNTIME_HEARTBEAT_FILE: "relative.json"
    }, "studio-worker")).toThrow(/absolute path/);
    expect(() => loadRuntimeHeartbeatConfig({
      PETPACK_PLATFORM_MODE: "production",
      PETPACK_RUNTIME_HEARTBEAT_FILE: path.join(caseRoot, "worker.json"),
      PETPACK_RUNTIME_HEARTBEAT_INTERVAL_MS: "10000",
      PETPACK_RUNTIME_HEARTBEAT_MAX_AGE_MS: "15000"
    }, "studio-worker")).toThrow(/at least two intervals/);
  });

  it("writes an atomic ready record and marks it stopped without deleting the file", async () => {
    const filePath = path.join(caseRoot, "worker.json");
    const config = loadRuntimeHeartbeatConfig({
      PETPACK_PLATFORM_MODE: "production",
      PETPACK_RUNTIME_HEARTBEAT_FILE: filePath
    }, "studio-worker");
    const heartbeat = new RuntimeHeartbeat({
      config,
      probe: vi.fn(async () => ({ ready: true })),
      logger: { error: vi.fn() }
    });

    await heartbeat.start();
    await expect(assertRuntimeHeartbeat({
      filePath,
      expectedRole: "studio-worker",
      maximumAgeMs: config.maximumAgeMs,
      processKill: vi.fn()
    })).resolves.toMatchObject({ ready: true, role: "studio-worker", pid: process.pid });

    await heartbeat.stop();
    expect(fs.existsSync(filePath)).toBe(true);
    const stopped = JSON.parse(await fsp.readFile(filePath, "utf8"));
    expect(stopped).toMatchObject({ ready: false, status: "stopped", role: "studio-worker" });
  });

  it("fails closed for an unhealthy, stale, substituted, or dead heartbeat", async () => {
    const filePath = path.join(caseRoot, "outbox.json");
    const updatedAt = new Date(1_000_000).toISOString();
    const record = {
      schemaVersion: "petpack-runtime-heartbeat/v1",
      role: "outbox-dispatcher",
      pid: process.pid,
      ready: true,
      status: "ready",
      updatedAt,
      consecutiveFailures: 0
    };
    await fsp.writeFile(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    await expect(assertRuntimeHeartbeat({
      filePath,
      expectedRole: "outbox-dispatcher",
      maximumAgeMs: 45_000,
      now: 1_100_000,
      processKill: vi.fn()
    })).rejects.toThrow(/stale/);
    await expect(assertRuntimeHeartbeat({
      filePath,
      expectedRole: "studio-worker",
      maximumAgeMs: 45_000,
      now: 1_000_001,
      processKill: vi.fn()
    })).rejects.toThrow(/not ready/);
    await expect(assertRuntimeHeartbeat({
      filePath,
      expectedRole: "outbox-dispatcher",
      maximumAgeMs: 45_000,
      now: 1_000_001,
      processKill: vi.fn(() => { throw new Error("missing"); })
    })).rejects.toThrow(/not alive/);
  });

  it("does not report initial readiness when the runtime probe fails", async () => {
    const filePath = path.join(caseRoot, "worker.json");
    const config = loadRuntimeHeartbeatConfig({
      PETPACK_PLATFORM_MODE: "production",
      PETPACK_RUNTIME_HEARTBEAT_FILE: filePath
    }, "studio-worker");
    const heartbeat = new RuntimeHeartbeat({
      config,
      probe: vi.fn(async () => { throw new Error("redis unavailable"); }),
      logger: { error: vi.fn() }
    });

    await expect(heartbeat.start()).rejects.toThrow(/initial readiness/);
    const record = JSON.parse(await fsp.readFile(filePath, "utf8"));
    expect(record).toMatchObject({ ready: false, status: "unhealthy", consecutiveFailures: 1 });
  });
});
