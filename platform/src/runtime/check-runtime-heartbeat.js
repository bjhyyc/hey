const fsp = require("node:fs/promises");
const path = require("node:path");

const { HEARTBEAT_SCHEMA_VERSION, loadRuntimeHeartbeatConfig } = require("./runtime-heartbeat");

const MAX_HEARTBEAT_BYTES = 4096;
const MAX_CLOCK_SKEW_MS = 5000;

async function assertRuntimeHeartbeat({
  filePath,
  expectedRole,
  maximumAgeMs,
  now = Date.now(),
  processKill = process.kill.bind(process)
} = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("Runtime heartbeat file must be absolute");
  }
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_HEARTBEAT_BYTES) {
    throw new Error("Runtime heartbeat file is invalid");
  }
  const raw = await fsp.readFile(filePath, "utf8");
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error("Runtime heartbeat JSON is invalid");
  }
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      record.schemaVersion !== HEARTBEAT_SCHEMA_VERSION || record.role !== expectedRole ||
      record.ready !== true || record.status !== "ready") {
    throw new Error("Runtime heartbeat is not ready");
  }
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) throw new Error("Runtime heartbeat PID is invalid");
  const updatedAt = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt > now + MAX_CLOCK_SKEW_MS || now - updatedAt > maximumAgeMs) {
    throw new Error("Runtime heartbeat is stale");
  }
  try {
    processKill(record.pid, 0);
  } catch {
    throw new Error("Runtime heartbeat process is not alive");
  }
  return Object.freeze({ ready: true, role: record.role, pid: record.pid, updatedAt: record.updatedAt });
}

async function main({ environment = process.env } = {}) {
  const role = typeof environment.PETPACK_RUNTIME_ROLE === "string"
    ? environment.PETPACK_RUNTIME_ROLE.trim()
    : "";
  const config = loadRuntimeHeartbeatConfig(environment, role);
  if (!config) throw new Error("Runtime heartbeat configuration is required");
  return assertRuntimeHeartbeat({
    filePath: config.filePath,
    expectedRole: config.role,
    maximumAgeMs: config.maximumAgeMs
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.runtime_heartbeat.unhealthy", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  });
}

module.exports = { assertRuntimeHeartbeat, main };
