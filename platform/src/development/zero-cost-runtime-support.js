const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const EXPECTED_PROJECT_ROOT = path.win32.resolve("D:\\PetPackStudio-Rebuild-20260813");
const REHEARSAL_TMP_ROOT = path.resolve(PROJECT_ROOT, ".tmp");
const DEFAULT_COMPONENTS_MODULE = path.resolve(__dirname, "zero-cost-worker-components.js");

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const parts = normalized.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 127;
}

function requireLoopbackUrl(value, label, protocols) {
  let parsed;
  try { parsed = new URL(requiredString(value, label)); } catch { throw new Error(`${label} is invalid`); }
  if (!protocols.includes(parsed.protocol) || !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`${label} must target loopback only`);
  }
  return parsed;
}

function normalizedPathKey(value) {
  return path.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
}

function assertExpectedProjectRoot() {
  if (normalizedPathKey(PROJECT_ROOT) !== normalizedPathKey(EXPECTED_PROJECT_ROOT)) {
    throw new Error(`Zero-cost rehearsal is pinned to ${EXPECTED_PROJECT_ROOT}`);
  }
}

function assertNoReparsePoint(absolute, label) {
  const relative = path.relative(REHEARSAL_TMP_ROOT, absolute);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = REHEARSAL_TMP_ROOT;
  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`${label} must not traverse a symlink or reparse point`);
    const real = fs.realpathSync.native(current);
    if (normalizedPathKey(real) !== normalizedPathKey(current)) {
      throw new Error(`${label} must not traverse a symlink or reparse point`);
    }
  }
}

function requireProjectPath(value, label) {
  assertExpectedProjectRoot();
  const absolute = path.resolve(requiredString(value, label));
  const relative = path.relative(REHEARSAL_TMP_ROOT, absolute);
  if (!path.isAbsolute(absolute) || relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a descendant of ${REHEARSAL_TMP_ROOT}`);
  }
  assertNoReparsePoint(absolute, label);
  return absolute;
}

function buildZeroCostEnvironment(environment = process.env, { role } = {}) {
  if (!["api", "outbox", "worker", "seed"].includes(role)) throw new Error("Zero-cost runtime role is invalid");
  if (environment.PETPACK_PLATFORM_MODE === "production" || environment.NODE_ENV === "production") {
    throw new Error("Zero-cost rehearsal is forbidden in production mode");
  }
  requireLoopbackUrl(environment.PETPACK_POSTGRES_URL, "Rehearsal PostgreSQL URL", ["postgres:", "postgresql:"]);
  if (role === "outbox" || role === "worker") {
    requireLoopbackUrl(environment.PETPACK_REDIS_URL, "Rehearsal Redis URL", ["rediss:"]);
  }
  const objectRoot = requireProjectPath(environment.PETPACK_LOCAL_OBJECT_ROOT, "Rehearsal object root");
  const workerTempRoot = requireProjectPath(environment.PETPACK_WORKER_TEMP_ROOT, "Rehearsal worker temporary root");
  const auditFile = requireProjectPath(environment.PETPACK_REHEARSAL_AUDIT_FILE, "Rehearsal audit file");
  requireLoopbackUrl(environment.PETPACK_LOCAL_OBJECT_BASE_URL, "Rehearsal object base URL", ["http:"]);
  requiredString(environment.PETPACK_LOCAL_OBJECT_SIGNING_SECRET, "Rehearsal object signing secret");
  requiredString(environment.PETPACK_SESSION_SIGNING_KEY, "Rehearsal session signing key");
  const selectedComponentsModule = path.resolve(environment.PETPACK_WORKER_COMPONENTS_MODULE || DEFAULT_COMPONENTS_MODULE);
  if (selectedComponentsModule !== DEFAULT_COMPONENTS_MODULE) {
    throw new Error("Zero-cost rehearsal must use the pinned development components module");
  }
  const fileFreeEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.endsWith("_FILE"))
  );
  return {
    ...fileFreeEnvironment,
    NODE_ENV: "development",
    PETPACK_PLATFORM_MODE: "development",
    PETPACK_POSTGRES_APPLICATION_NAME: `petpack-zero-cost-${role}`,
    PETPACK_LOCAL_OBJECT_ROOT: objectRoot,
    PETPACK_WORKER_TEMP_ROOT: workerTempRoot,
    PETPACK_REHEARSAL_AUDIT_FILE: auditFile,
    TEMP: workerTempRoot,
    TMP: workerTempRoot,
    TMPDIR: workerTempRoot,
    PETPACK_WORKER_COMPONENTS_MODULE: DEFAULT_COMPONENTS_MODULE,
    PETPACK_LOCAL_OBJECT_SERVE: role === "api" ? "1" : "0",
    KAIPAY_ALLOW_SIMULATED_PAYMENTS: "true",
    KAIPAY_MERCHANT_ID: "",
    KAIPAY_CREDENTIALS_JSON: "",
    KAIPAY_NOTIFY_BASE_URL: "",
    KAIPAY_RETURN_BASE_URL: "",
    KAIPAY_ADAPTER_VERSION: "",
    PETPACK_OBJECT_STORE_ENDPOINT: "",
    PETPACK_OBJECT_STORE_BUCKET: "",
    PETPACK_OBJECT_STORE_REGION: "",
    PETPACK_OBJECT_STORE_ACCESS_KEY_ID: "",
    PETPACK_OBJECT_STORE_SECRET_ACCESS_KEY: "",
    CLOUDBASE_ENV_ID: "zero-cost-fixture",
    CLOUDBASE_REGION: "ap-shanghai",
    CLOUDBASE_AUTH_BASE_URL: "",
    PETPACK_PHONE_AUTH_ENABLED: "false",
    PETPACK_STUDIO_SESSION_COOKIE_NAME: "petpack_rehearsal_session",
    PETPACK_SESSION_COOKIE_SECURE: "false",
    PETPACK_AUTH_POLICY_VERSION: "zero-cost-rehearsal/v1",
    PETPACK_SESSION_TTL_SECONDS: "14400",
    MODEL_REGISTRY_VERSION: "zero-cost-rehearsal-v1",
    MODELARK_BASE_URL: "http://127.0.0.1/zero-cost-fixture",
    MODELARK_REGION: "loopback",
    MODELARK_API_KEY: "",
    MODELARK_SEEDREAM_ENDPOINT_ID: "fixture-seedream",
    MODELARK_SEEDREAM_OUTPUT_SIZE: "854x480",
    MODELARK_SEEDANCE_ENDPOINT_ID: "fixture-seedance",
    MODELARK_VIDEO_RESOLUTION: "480p",
    MODELARK_VIDEO_CALLBACK_BASE_URL: "",
    MODELARK_VIDEO_CALLBACK_SECRET: "",
    PETPACK_QUEUE_WORKER_CONCURRENCY: environment.PETPACK_QUEUE_WORKER_CONCURRENCY || "7",
    PETPACK_PROVIDER_POLL_DELAY_SECONDS: environment.PETPACK_PROVIDER_POLL_DELAY_SECONDS || "5",
    PETPACK_MASTER_JOB_LEASE_SECONDS: environment.PETPACK_MASTER_JOB_LEASE_SECONDS || "30",
    PETPACK_VIDEO_JOB_LEASE_SECONDS: environment.PETPACK_VIDEO_JOB_LEASE_SECONDS || "30",
    PETPACK_VIDEO_PROCESSING_LEASE_SECONDS: environment.PETPACK_VIDEO_PROCESSING_LEASE_SECONDS || "30",
    PETPACK_PETPACK_JOB_LEASE_SECONDS: environment.PETPACK_PETPACK_JOB_LEASE_SECONDS || "30",
    PETPACK_OUTBOX_POLL_INTERVAL_MS: environment.PETPACK_OUTBOX_POLL_INTERVAL_MS || "100",
    PETPACK_OUTBOX_BUSY_INTERVAL_MS: environment.PETPACK_OUTBOX_BUSY_INTERVAL_MS || "10"
  };
}

function createLoopbackOnlyFetch(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  return async (input, init) => {
    let parsed;
    try { parsed = new URL(input instanceof URL ? input.toString() : String(input)); } catch {
      throw Object.assign(new Error("Zero-cost rehearsal blocked an invalid network target"), { code: "zero_cost_network_blocked" });
    }
    if (!["http:", "https:"].includes(parsed.protocol) || !isLoopbackHostname(parsed.hostname)) {
      throw Object.assign(new Error("Zero-cost rehearsal blocked a non-loopback network target"), { code: "zero_cost_external_network_blocked" });
    }
    return fetchImpl(parsed, init);
  };
}

function notifyReady(payload) {
  if (typeof process.send === "function") process.send({ type: "ready", ...payload });
}

function safeStartupFailure(error) {
  const rawMessage = typeof error?.message === "string" ? error.message : "Startup failed";
  const message = rawMessage
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1<redacted>@")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
  return {
    errorName: error?.name || "Error",
    code: typeof error?.code === "string" ? error.code : "startup_failed",
    message
  };
}

function installGracefulShutdown({ close, label, logger = console } = {}) {
  if (typeof close !== "function") throw new Error("Zero-cost shutdown hook is required");
  let closing;
  const handle = (signal) => {
    if (!closing) {
      closing = Promise.resolve().then(() => close(signal)).catch((error) => {
        logger.error?.(`petpack.zero_cost.${label}.stop_failed`, { errorName: error?.name || "Error" });
        process.exitCode = 1;
      });
    }
    return closing;
  };
  process.once("SIGTERM", () => handle("SIGTERM"));
  process.once("SIGINT", () => handle("SIGINT"));
  return handle;
}

module.exports = {
  DEFAULT_COMPONENTS_MODULE,
  EXPECTED_PROJECT_ROOT,
  PROJECT_ROOT,
  REHEARSAL_TMP_ROOT,
  assertExpectedProjectRoot,
  buildZeroCostEnvironment,
  createLoopbackOnlyFetch,
  installGracefulShutdown,
  isLoopbackHostname,
  notifyReady,
  requireLoopbackUrl,
  requireProjectPath,
  safeStartupFailure
};
