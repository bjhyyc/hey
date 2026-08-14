const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const HEARTBEAT_SCHEMA_VERSION = "petpack-runtime-heartbeat/v1";
const RUNTIME_ROLES = new Set(["outbox-dispatcher", "studio-worker"]);

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function requiredRole(value) {
  if (typeof value !== "string" || !RUNTIME_ROLES.has(value)) {
    throw new Error("Runtime heartbeat role is invalid");
  }
  return value;
}

function loadRuntimeHeartbeatConfig(environment = process.env, role) {
  const selectedRole = requiredRole(role);
  const mode = typeof environment.PETPACK_PLATFORM_MODE === "string"
    ? environment.PETPACK_PLATFORM_MODE.trim()
    : "development";
  const filePath = typeof environment.PETPACK_RUNTIME_HEARTBEAT_FILE === "string"
    ? environment.PETPACK_RUNTIME_HEARTBEAT_FILE.trim()
    : "";
  if (!filePath) {
    if (mode === "production") throw new Error("Production runtime heartbeat file is required");
    return null;
  }
  if (!path.isAbsolute(filePath)) throw new Error("Runtime heartbeat file must be an absolute path");
  const intervalMs = boundedInteger(
    environment.PETPACK_RUNTIME_HEARTBEAT_INTERVAL_MS,
    10_000,
    1_000,
    60_000,
    "Runtime heartbeat interval"
  );
  const maximumAgeMs = boundedInteger(
    environment.PETPACK_RUNTIME_HEARTBEAT_MAX_AGE_MS,
    45_000,
    5_000,
    300_000,
    "Runtime heartbeat maximum age"
  );
  if (maximumAgeMs < intervalMs * 2) {
    throw new Error("Runtime heartbeat maximum age must be at least two intervals");
  }
  return Object.freeze({ role: selectedRole, filePath, intervalMs, maximumAgeMs });
}

async function assertSafeHeartbeatPath(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error("Runtime heartbeat file must be absolute");
  const parent = path.dirname(filePath);
  const parentStat = await fsp.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Runtime heartbeat parent must be a real directory");
  }
  const realParent = await fsp.realpath(parent);
  if (path.resolve(realParent) !== path.resolve(parent)) {
    throw new Error("Runtime heartbeat parent must not traverse a link");
  }
  try {
    const targetStat = await fsp.lstat(filePath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error("Runtime heartbeat target must be a regular file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({ parent: realParent, filePath: path.join(realParent, path.basename(filePath)) });
}

async function writeHeartbeatAtomically(filePath, record) {
  const safe = await assertSafeHeartbeatPath(filePath);
  const temporaryPath = path.join(
    safe.parent,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  const payload = `${JSON.stringify(record)}\n`;
  let created = false;
  try {
    await fsp.writeFile(temporaryPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
    const temporaryStat = await fsp.lstat(temporaryPath);
    if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()) {
      throw new Error("Runtime heartbeat temporary file is invalid");
    }
    await fsp.rename(temporaryPath, safe.filePath);
    created = false;
  } finally {
    if (created) await fsp.unlink(temporaryPath).catch(() => undefined);
  }
}

class RuntimeHeartbeat {
  constructor({ config, probe, logger = console, now = () => Date.now(), pid = process.pid } = {}) {
    if (!config || typeof config !== "object") throw new Error("Runtime heartbeat configuration is required");
    requiredRole(config.role);
    if (typeof probe !== "function") throw new Error("Runtime heartbeat readiness probe is required");
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Runtime heartbeat PID is invalid");
    this.config = config;
    this.probe = probe;
    this.logger = logger;
    this.now = now;
    this.pid = pid;
    this.running = false;
    this.timer = null;
    this.activeTick = null;
    this.consecutiveFailures = 0;
  }

  async _write({ ready, status, errorName = null }) {
    const record = Object.freeze({
      schemaVersion: HEARTBEAT_SCHEMA_VERSION,
      role: this.config.role,
      pid: this.pid,
      ready,
      status,
      updatedAt: new Date(this.now()).toISOString(),
      consecutiveFailures: this.consecutiveFailures,
      ...(errorName ? { errorName } : {})
    });
    await writeHeartbeatAtomically(this.config.filePath, record);
    return record;
  }

  async _tick() {
    try {
      const result = await this.probe();
      if (result?.ready === false || result?.ok === false) throw new Error("Runtime readiness probe failed");
      this.consecutiveFailures = 0;
      return await this._write({ ready: true, status: "ready" });
    } catch (error) {
      this.consecutiveFailures += 1;
      await this._write({ ready: false, status: "unhealthy", errorName: error?.name || "Error" });
      return Object.freeze({ ready: false, error });
    }
  }

  _schedule() {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.activeTick = this._tick()
        .catch((error) => {
          this.logger.error?.("petpack.runtime_heartbeat.write_failed", {
            role: this.config.role,
            errorName: error?.name || "Error"
          });
        })
        .finally(() => {
          this.activeTick = null;
          this._schedule();
        });
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  async start() {
    if (this.running) throw new Error("Runtime heartbeat is already running");
    this.running = true;
    const initial = await this._tick();
    if (initial.ready !== true) {
      this.running = false;
      throw new Error("Runtime heartbeat initial readiness probe failed");
    }
    this._schedule();
    return Object.freeze({ ready: true, role: this.config.role, maximumAgeMs: this.config.maximumAgeMs });
  }

  async stop() {
    if (!this.running && !this.activeTick) return;
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.activeTick) await this.activeTick;
    await this._write({ ready: false, status: "stopped" });
  }
}

function createRuntimeHeartbeatFromEnvironment({ environment = process.env, role, probe, logger = console } = {}) {
  const config = loadRuntimeHeartbeatConfig(environment, role);
  return config ? new RuntimeHeartbeat({ config, probe, logger }) : null;
}

module.exports = {
  HEARTBEAT_SCHEMA_VERSION,
  RuntimeHeartbeat,
  assertSafeHeartbeatPath,
  createRuntimeHeartbeatFromEnvironment,
  loadRuntimeHeartbeatConfig,
  writeHeartbeatAtomically
};
