"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { Pool } = require("pg");

const {
  PostgresDatabase,
  isPostgresInfrastructureError
} = require("../persistence/postgres-database");

const POLL_INTERVAL_MS = 200;
const OUTAGE_TIMEOUT_MS = 30_000;
const RECOVERY_TIMEOUT_MS = 45_000;

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertApprovedControlRoot(controlRoot) {
  const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
  const approvedBase = fs.realpathSync.native(path.join(repositoryRoot, ".tmp", "data-tls-rehearsals"));
  const resolved = fs.realpathSync.native(controlRoot);
  if (resolved === approvedBase || !resolved.startsWith(`${approvedBase}${path.sep}`)) {
    throw new Error("PostgreSQL outage control root escaped the approved rehearsal directory");
  }
  if (fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error("PostgreSQL outage control root must not be a link");
  }
  return resolved;
}

function writeExclusiveJson(directory, name, value) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  return target;
}

async function queryTls(database) {
  const result = await database.query(
    `SELECT current_setting('server_version_num')::integer AS version_num,
            ssl,
            version AS tls_version
       FROM pg_stat_ssl
      WHERE pid = pg_backend_pid()`
  );
  const row = result?.rows?.[0];
  if (!row || Number(row.version_num) < 150_000 || row.ssl !== true || !/^TLSv1\.[23]$/.test(row.tls_version)) {
    throw new Error("PostgreSQL TLS recovery probe returned invalid evidence");
  }
  return Object.freeze({
    versionNumber: Number(row.version_num),
    tlsVersion: row.tls_version
  });
}

async function waitForOutage(database) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= OUTAGE_TIMEOUT_MS) {
    try {
      await queryTls(database);
    } catch (error) {
      if (isPostgresInfrastructureError(error) && error.retryAfterMs === 5_000) {
        return Object.freeze({
          observedAt: new Date().toISOString(),
          errorCode: error.code,
          retryAfterMs: error.retryAfterMs
        });
      }
      throw error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("PostgreSQL outage was not observed within the bounded timeout");
}

async function waitForRecovery(database) {
  const startedAt = Date.now();
  let infrastructureFailures = 0;
  while (Date.now() - startedAt <= RECOVERY_TIMEOUT_MS) {
    try {
      return Object.freeze({
        ...(await queryTls(database)),
        recoveredAt: new Date().toISOString(),
        infrastructureFailures
      });
    } catch (error) {
      if (!isPostgresInfrastructureError(error)) throw error;
      infrastructureFailures += 1;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error("PostgreSQL did not recover within the bounded timeout");
}

async function main(environment = process.env) {
  if (environment.PETPACK_PLATFORM_MODE === "production") {
    throw new Error("PostgreSQL outage rehearsal is forbidden in production");
  }
  const controlRoot = assertApprovedControlRoot(
    requiredString(environment.PETPACK_REHEARSAL_CONTROL_ROOT, "PostgreSQL outage control root")
  );
  const connectionString = requiredString(
    environment.PETPACK_REHEARSAL_POSTGRES_URL,
    "PostgreSQL outage rehearsal URL"
  );
  const caPath = requiredString(
    environment.PETPACK_REHEARSAL_POSTGRES_CA_FILE,
    "PostgreSQL outage rehearsal CA file"
  );
  const ca = fs.readFileSync(caPath, "utf8");
  const pool = new Pool({
    connectionString,
    ssl: { ca, rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 1_000,
    application_name: "petpack-postgres-outage-rehearsal"
  });
  const database = new PostgresDatabase({
    pool,
    statementTimeoutMs: 5_000,
    logger: { debug() {}, warn() {}, error() {} }
  });

  try {
    const before = await queryTls(database);
    writeExclusiveJson(controlRoot, "ready.json", {
      schemaVersion: "petpack-postgres-outage-ready/v1",
      readyAt: new Date().toISOString(),
      ...before
    });

    const outage = await waitForOutage(database);
    writeExclusiveJson(controlRoot, "outage-observed.json", {
      schemaVersion: "petpack-postgres-outage-observed/v1",
      ...outage
    });

    const recovered = await waitForRecovery(database);
    const reportPath = writeExclusiveJson(controlRoot, "node-report.json", {
      schemaVersion: "petpack-postgres-outage-recovery/v1",
      before,
      outage,
      recovered,
      businessAttemptsConsumed: 0,
      productionServiceUsed: false,
      externalProviderCallCount: 0
    });
    process.stdout.write(`POSTGRES_OUTAGE_RECOVERY_OK=${reportPath}\n`);
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`POSTGRES_OUTAGE_RECOVERY_FAILED=${error?.name || "Error"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertApprovedControlRoot,
  main,
  queryTls,
  waitForOutage,
  waitForRecovery
};
