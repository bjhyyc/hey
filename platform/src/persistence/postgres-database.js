const DEFAULT_POOL_MAX = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const MINIMUM_POSTGRES_VERSION = 150_000;
const APPLICATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const ISOLATION_LEVELS = new Map([
  ["read committed", "READ COMMITTED"],
  ["repeatable read", "REPEATABLE READ"],
  ["serializable", "SERIALIZABLE"]
]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseConnectionString(value) {
  const connectionString = requiredString(value, "PostgreSQL connection URL");
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("PostgreSQL connection URL is invalid");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password) {
    throw new Error("PostgreSQL connection URL is invalid");
  }
  if (url.hash || url.pathname.length < 2) throw new Error("PostgreSQL connection URL is invalid");
  return { connectionString, url };
}

function loadPostgresDatabaseConfig(environment = process.env) {
  const parsed = parseConnectionString(environment.PETPACK_POSTGRES_URL);
  const mode = environment.PETPACK_PLATFORM_MODE === "production" ? "production" : "development";
  const applicationName = (environment.PETPACK_POSTGRES_APPLICATION_NAME || "petpack-studio-api").trim();
  if (!APPLICATION_NAME_PATTERN.test(applicationName)) throw new Error("PostgreSQL application name is invalid");

  let connectionString = parsed.connectionString;
  let ssl = false;
  if (mode === "production") {
    const ca = requiredString(environment.PETPACK_POSTGRES_CA_PEM, "PostgreSQL CA certificate");
    const sslMode = parsed.url.searchParams.get("sslmode");
    if (sslMode !== "verify-full") throw new Error("Production PostgreSQL requires sslmode=verify-full");
    const sanitized = new URL(parsed.url);
    sanitized.searchParams.delete("sslmode");
    connectionString = sanitized.toString();
    ssl = Object.freeze({ ca, rejectUnauthorized: true });
  }

  return Object.freeze({
    connectionString,
    ssl,
    mode,
    applicationName,
    poolMax: boundedInteger(environment.PETPACK_POSTGRES_POOL_MAX, DEFAULT_POOL_MAX, 1, 50, "PostgreSQL pool size"),
    connectionTimeoutMs: boundedInteger(environment.PETPACK_POSTGRES_CONNECTION_TIMEOUT_MS, DEFAULT_CONNECTION_TIMEOUT_MS, 500, 30_000, "PostgreSQL connection timeout"),
    idleTimeoutMs: boundedInteger(environment.PETPACK_POSTGRES_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, 1_000, 120_000, "PostgreSQL idle timeout"),
    statementTimeoutMs: boundedInteger(environment.PETPACK_POSTGRES_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS, 1_000, 120_000, "PostgreSQL statement timeout")
  });
}

function requirePool(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function" || typeof pool.end !== "function") {
    throw new Error("A PostgreSQL pool is required");
  }
  return pool;
}

function isolationLevel(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "read committed";
  const sql = ISOLATION_LEVELS.get(normalized);
  if (!sql) throw new Error("PostgreSQL transaction isolation level is invalid");
  return sql;
}

class PostgresDatabase {
  constructor({ pool, statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS, logger = console } = {}) {
    this.pool = requirePool(pool);
    this.statementTimeoutMs = boundedInteger(statementTimeoutMs, DEFAULT_STATEMENT_TIMEOUT_MS, 1_000, 120_000, "PostgreSQL statement timeout");
    this.logger = logger;
    this.closed = false;
  }

  async query(text, values) {
    if (this.closed) throw new Error("PostgreSQL database is closed");
    return this.pool.query(text, values);
  }

  async transaction(callback, { isolation = "read committed" } = {}) {
    if (this.closed) throw new Error("PostgreSQL database is closed");
    if (typeof callback !== "function") throw new Error("PostgreSQL transaction callback is required");
    const client = await this.pool.connect();
    const startedAt = Date.now();
    let began = false;
    try {
      await client.query("BEGIN");
      began = true;
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel(isolation)}`);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${this.statementTimeoutMs}ms`]);
      const tx = Object.freeze({ query: client.query.bind(client) });
      const result = await callback(tx);
      await client.query("COMMIT");
      this.logger.debug?.("petpack.postgres.transaction_committed", { durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          this.logger.error?.("petpack.postgres.rollback_failed", {
            errorName: rollbackError && rollbackError.name ? rollbackError.name : "Error"
          });
        }
      }
      this.logger.warn?.("petpack.postgres.transaction_failed", {
        durationMs: Date.now() - startedAt,
        errorName: error && error.name ? error.name : "Error"
      });
      throw error;
    } finally {
      client.release();
    }
  }

  async assertReady() {
    const result = await this.query(
      `SELECT current_setting('server_version_num')::integer AS version_num,
              to_regclass('public.app_user') IS NOT NULL AS has_app_user,
              to_regclass('public.auth_identity') IS NOT NULL AS has_auth_identity`
    );
    const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
    if (!row || Number(row.version_num) < MINIMUM_POSTGRES_VERSION || row.has_app_user !== true || row.has_auth_identity !== true) {
      throw new Error("PostgreSQL schema is not ready");
    }
    return Object.freeze({ ready: true, versionNumber: Number(row.version_num) });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

function createPostgresDatabase({ environment = process.env, PoolClass, pool, logger = console } = {}) {
  const config = loadPostgresDatabaseConfig(environment);
  let databasePool = pool;
  if (!databasePool) {
    const PgPool = PoolClass || require("pg").Pool;
    databasePool = new PgPool({
      connectionString: config.connectionString,
      ssl: config.ssl,
      max: config.poolMax,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      idleTimeoutMillis: config.idleTimeoutMs,
      application_name: config.applicationName
    });
  }
  return new PostgresDatabase({ pool: databasePool, statementTimeoutMs: config.statementTimeoutMs, logger });
}

module.exports = {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  MINIMUM_POSTGRES_VERSION,
  PostgresDatabase,
  createPostgresDatabase,
  loadPostgresDatabaseConfig
};
