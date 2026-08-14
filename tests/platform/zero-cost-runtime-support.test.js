import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  DEFAULT_COMPONENTS_MODULE,
  PROJECT_ROOT,
  REHEARSAL_TMP_ROOT,
  buildZeroCostEnvironment,
  createLoopbackOnlyFetch,
  isLoopbackHostname,
  requireProjectPath,
  safeStartupFailure
} = require("../../platform/src/development/zero-cost-runtime-support");
const { uuidFromLabel } = require("../../platform/src/development/seed-zero-cost-rehearsal");
const {
  DEFAULT_SECRET_FILE_MAPPINGS,
  hydrateEnvironmentFromSecretFiles
} = require("../../platform/src/runtime/load-secret-files");

function baseEnvironment() {
  return {
    NODE_ENV: "development",
    PETPACK_PLATFORM_MODE: "development",
    PETPACK_POSTGRES_URL: "postgresql://fixture:password@127.0.0.1:5432/petpack",
    PETPACK_REDIS_URL: "rediss://fixture:password@127.0.0.1:6380/15",
    PETPACK_REDIS_CA_PEM: "fixture-ca",
    PETPACK_LOCAL_OBJECT_ROOT: path.join(PROJECT_ROOT, ".tmp", "zero-cost-test", "objects"),
    PETPACK_WORKER_TEMP_ROOT: path.join(PROJECT_ROOT, ".tmp", "zero-cost-test", "worker"),
    PETPACK_REHEARSAL_AUDIT_FILE: path.join(PROJECT_ROOT, ".tmp", "zero-cost-test", "audit.jsonl"),
    PETPACK_LOCAL_OBJECT_BASE_URL: "http://127.0.0.1:18991",
    PETPACK_LOCAL_OBJECT_SIGNING_SECRET: "a".repeat(64),
    PETPACK_SESSION_SIGNING_KEY: "b".repeat(64)
  };
}

describe("zero-cost runtime support", () => {
  it("pins all paid-provider boundaries to development fixtures", () => {
    const resolved = buildZeroCostEnvironment({
      ...baseEnvironment(),
      MODELARK_API_KEY: "must-not-be-used",
      KAIPAY_SELECTED_MERCHANT_CODE: "must-not-be-used",
      PETPACK_OBJECT_STORE_ACCESS_KEY_ID: "must-not-be-used",
      PETPACK_OBJECT_STORE_SECRET_ACCESS_KEY: "must-not-be-used",
      MODELARK_API_KEY_FILE: "D:\\production-secrets\\modelark",
      KAIPAY_CREDENTIALS_JSON_FILE: "D:\\production-secrets\\kaipay",
      PETPACK_OBJECT_STORE_ACCESS_KEY_ID_FILE: "D:\\production-secrets\\cos-id",
      PETPACK_OBJECT_STORE_SECRET_ACCESS_KEY_FILE: "D:\\production-secrets\\cos-key"
    }, { role: "worker" });
    expect(resolved).toMatchObject({
      NODE_ENV: "development",
      PETPACK_PLATFORM_MODE: "development",
      KAIPAY_ALLOW_SIMULATED_PAYMENTS: "true",
      KAIPAY_SELECTED_MERCHANT_CODE: "",
      CLOUDBASE_AUTH_BASE_URL: "",
      PETPACK_OBJECT_STORE_ACCESS_KEY_ID: "",
      PETPACK_OBJECT_STORE_SECRET_ACCESS_KEY: "",
      MODELARK_API_KEY: "",
      MODELARK_BASE_URL: "http://127.0.0.1/zero-cost-fixture",
      MODELARK_SEEDREAM_ENDPOINT_ID: "fixture-seedream",
      MODELARK_SEEDANCE_ENDPOINT_ID: "fixture-seedance",
      MODELARK_VIDEO_RESOLUTION: "480p",
      PETPACK_WORKER_COMPONENTS_MODULE: DEFAULT_COMPONENTS_MODULE,
      PETPACK_LOCAL_OBJECT_SERVE: "0",
      TEMP: baseEnvironment().PETPACK_WORKER_TEMP_ROOT,
      TMP: baseEnvironment().PETPACK_WORKER_TEMP_ROOT,
      TMPDIR: baseEnvironment().PETPACK_WORKER_TEMP_ROOT
    });
    const productionSecretFileSettings = Object.values(DEFAULT_SECRET_FILE_MAPPINGS);
    expect(Object.keys(resolved).filter((key) => productionSecretFileSettings.includes(key))).toEqual([]);
    expect(() => hydrateEnvironmentFromSecretFiles({ environment: resolved })).not.toThrow();
    expect(buildZeroCostEnvironment(baseEnvironment(), { role: "api" }).PETPACK_LOCAL_OBJECT_SERVE).toBe("1");
  });

  it("rejects production, non-loopback services, and paths outside the isolated .tmp root", () => {
    expect(() => buildZeroCostEnvironment({ ...baseEnvironment(), NODE_ENV: "production" }, { role: "api" }))
      .toThrow(/forbidden in production/i);
    expect(() => buildZeroCostEnvironment({
      ...baseEnvironment(), PETPACK_POSTGRES_URL: "postgresql://u:p@db.example.com/petpack"
    }, { role: "api" })).toThrow(/loopback/i);
    expect(() => buildZeroCostEnvironment({
      ...baseEnvironment(), PETPACK_LOCAL_OBJECT_ROOT: "C:\\outside"
    }, { role: "api" })).toThrow(/descendant of/i);
    expect(() => buildZeroCostEnvironment({
      ...baseEnvironment(), PETPACK_LOCAL_OBJECT_ROOT: PROJECT_ROOT
    }, { role: "api" })).toThrow(/descendant of/i);
    expect(() => buildZeroCostEnvironment({
      ...baseEnvironment(), PETPACK_LOCAL_OBJECT_ROOT: "D:\\桌宠"
    }, { role: "api" })).toThrow(/descendant of/i);
  });

  it("rejects a junction/reparse point inside the isolated .tmp root", () => {
    const unique = `zero-cost-reparse-${process.pid}-${Date.now()}`;
    const link = path.join(REHEARSAL_TMP_ROOT, unique);
    fs.symlinkSync(PROJECT_ROOT, link, "junction");
    expect(() => requireProjectPath(path.join(link, "must-not-write"), "Rehearsal test path"))
      .toThrow(/symlink or reparse point/i);
  });

  it("blocks every non-loopback fetch before the injected transport is called", async () => {
    const transport = vi.fn(async () => ({ ok: true }));
    const safeFetch = createLoopbackOnlyFetch(transport);
    await expect(safeFetch("https://ark.cn-beijing.volces.com/api/v3"))
      .rejects.toMatchObject({ code: "zero_cost_external_network_blocked" });
    expect(transport).not.toHaveBeenCalled();
    await expect(safeFetch("http://127.0.0.1:18000/fixture")).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("recognizes loopback variants and creates stable valid seed UUIDs", () => {
    expect(["127.0.0.1", "127.42.1.8", "localhost", "::1"].every(isLoopbackHostname)).toBe(true);
    expect(isLoopbackHostname("10.0.0.1")).toBe(false);
    const id = uuidFromLabel("same-label");
    expect(uuidFromLabel("same-label")).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("redacts URI credentials from development startup diagnostics", () => {
    const diagnostic = safeStartupFailure(Object.assign(
      new Error("failed for rediss://default:super-secret@127.0.0.1:6380/0\nnext"),
      { code: "fixture_failed" }
    ));
    expect(diagnostic).toMatchObject({ code: "fixture_failed", errorName: "Error" });
    expect(diagnostic.message).toContain("rediss://<redacted>@127.0.0.1:6380/0 next");
    expect(diagnostic.message).not.toContain("super-secret");
  });
});
