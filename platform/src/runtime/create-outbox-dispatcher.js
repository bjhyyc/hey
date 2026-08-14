const { createPostgresDatabase } = require("../persistence/postgres-database");
const { PostgresOutboxDispatcher } = require("../persistence/postgres-transactional-workflow-store");
const { BullMqWorkflowQueue, loadBullMqConfig } = require("../queue/bullmq-workflow-queue");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function loadOutboxRuntimeConfig(environment = process.env) {
  return Object.freeze({
    pollIntervalMs: boundedInteger(environment.PETPACK_OUTBOX_POLL_INTERVAL_MS, 1_000, 50, 60_000, "Outbox poll interval"),
    busyIntervalMs: boundedInteger(environment.PETPACK_OUTBOX_BUSY_INTERVAL_MS, 25, 0, 1_000, "Outbox busy interval"),
    maximumErrorBackoffMs: boundedInteger(environment.PETPACK_OUTBOX_MAX_ERROR_BACKOFF_MS, 30_000, 1_000, 300_000, "Outbox maximum error backoff"),
    batchLimit: boundedInteger(environment.PETPACK_OUTBOX_BATCH_LIMIT, 25, 1, 100, "Outbox batch limit"),
    leaseSeconds: boundedInteger(environment.PETPACK_OUTBOX_LEASE_SECONDS, 60, 5, 600, "Outbox lease duration")
  });
}

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") throw new Error(`${label} must implement ${method}`);
  return value;
}

async function assertOutboxSchemaReady(database) {
  const result = await database.query(
    `SELECT to_regclass('public.outbox_job') IS NOT NULL AS has_outbox,
            to_regclass('public.production_run') IS NOT NULL AS has_run`
  );
  const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
  if (!row || row.has_outbox !== true || row.has_run !== true) throw new Error("PostgreSQL outbox schema is not ready");
  return Object.freeze({ ready: true });
}

function createInterruptibleWait({ setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let timer = null;
  let resolvePending = null;
  return Object.freeze({
    wait(milliseconds) {
      if (resolvePending) throw new Error("Outbox runtime attempted overlapping waits");
      if (milliseconds === 0) return Promise.resolve();
      return new Promise((resolve) => {
        resolvePending = resolve;
        timer = setTimeoutImpl(() => {
          timer = null;
          resolvePending = null;
          resolve();
        }, milliseconds);
      });
    },
    wake() {
      if (!resolvePending) return;
      if (timer !== null) clearTimeoutImpl(timer);
      const resolve = resolvePending;
      timer = null;
      resolvePending = null;
      resolve();
    }
  });
}

class OutboxDispatcherRuntime {
  constructor({ database, queue, dispatcher, config, logger = console, waitController } = {}) {
    this.database = requireMethod(requireMethod(database, "assertReady", "PostgreSQL database"), "close", "PostgreSQL database");
    requireMethod(this.database, "query", "PostgreSQL database");
    this.queue = requireMethod(requireMethod(queue, "assertReady", "BullMQ queue"), "close", "BullMQ queue");
    this.dispatcher = requireMethod(dispatcher, "dispatchBatch", "Outbox dispatcher");
    this.config = config || loadOutboxRuntimeConfig();
    this.logger = logger;
    this.waitController = waitController || createInterruptibleWait();
    requireMethod(requireMethod(this.waitController, "wait", "Outbox wait controller"), "wake", "Outbox wait controller");
    this.running = false;
    this.closed = false;
    this.loopPromise = null;
    this.consecutiveFailures = 0;
    this.lastDispatchAt = null;
    this.lastErrorAt = null;
  }

  _errorBackoffMs() {
    const exponent = Math.min(12, Math.max(0, this.consecutiveFailures - 1));
    return Math.min(this.config.maximumErrorBackoffMs, this.config.pollIntervalMs * (2 ** exponent));
  }

  async dispatchOnce() {
    const result = await this.dispatcher.dispatchBatch({
      limit: this.config.batchLimit,
      leaseSeconds: this.config.leaseSeconds
    });
    const claimed = Number(result && result.claimed);
    if (!Number.isSafeInteger(claimed) || claimed < 0 || claimed > this.config.batchLimit) {
      throw new Error("Outbox dispatcher returned an invalid claimed count");
    }
    this.lastDispatchAt = new Date().toISOString();
    return Object.freeze({ claimed });
  }

  async _runLoop() {
    while (this.running) {
      let delay = this.config.pollIntervalMs;
      try {
        const result = await this.dispatchOnce();
        this.consecutiveFailures = 0;
        delay = result.claimed > 0 ? this.config.busyIntervalMs : this.config.pollIntervalMs;
      } catch (error) {
        this.consecutiveFailures += 1;
        this.lastErrorAt = new Date().toISOString();
        delay = this._errorBackoffMs();
        this.logger.warn?.("petpack.outbox.dispatch_cycle_failed", {
          consecutiveFailures: this.consecutiveFailures,
          errorName: error?.name || "Error"
        });
      }
      if (this.running) await this.waitController.wait(delay);
    }
  }

  async start() {
    if (this.closed) throw new Error("Outbox runtime is closed");
    if (this.running) throw new Error("Outbox runtime is already running");
    try {
      await this.database.assertReady();
      await assertOutboxSchemaReady(this.database);
      await this.queue.assertReady();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
    this.running = true;
    this.loopPromise = this._runLoop();
    return Object.freeze({
      ready: true,
      batchLimit: this.config.batchLimit,
      leaseSeconds: this.config.leaseSeconds
    });
  }

  status() {
    return Object.freeze({
      running: this.running,
      closed: this.closed,
      consecutiveFailures: this.consecutiveFailures,
      lastDispatchAt: this.lastDispatchAt,
      lastErrorAt: this.lastErrorAt
    });
  }

  async assertReady() {
    if (!this.running || this.closed) throw new Error("Outbox runtime is not running");
    if (this.consecutiveFailures >= 3) throw new Error("Outbox runtime has repeated dispatch failures");
    await this.database.assertReady();
    await this.queue.assertReady();
    return Object.freeze({ ready: true, consecutiveFailures: this.consecutiveFailures });
  }

  async close() {
    if (this.closed) return;
    this.running = false;
    this.waitController.wake();
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
    const failures = [];
    try { await this.queue.close(); } catch (error) { failures.push(error); }
    try { await this.database.close(); } catch (error) { failures.push(error); }
    this.closed = true;
    if (failures.length) throw failures[0];
  }
}

async function createOutboxDispatcherRuntime({
  environment = process.env,
  PoolClass,
  QueueClass,
  database,
  queue,
  dispatcher,
  logger = console,
  waitController
} = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  const runtimeDatabase = database || createPostgresDatabase({ environment: hydrated, PoolClass, logger });
  try {
    const runtimeQueue = queue || new BullMqWorkflowQueue({
      config: loadBullMqConfig(hydrated),
      QueueClass,
      logger
    });
    const runtimeDispatcher = dispatcher || new PostgresOutboxDispatcher({
      database: runtimeDatabase,
      queue: runtimeQueue,
      logger
    });
    return new OutboxDispatcherRuntime({
      database: runtimeDatabase,
      queue: runtimeQueue,
      dispatcher: runtimeDispatcher,
      config: loadOutboxRuntimeConfig(hydrated),
      logger,
      waitController
    });
  } catch (error) {
    await runtimeDatabase.close().catch(() => undefined);
    throw error;
  }
}

module.exports = {
  OutboxDispatcherRuntime,
  assertOutboxSchemaReady,
  createInterruptibleWait,
  createOutboxDispatcherRuntime,
  loadOutboxRuntimeConfig
};
