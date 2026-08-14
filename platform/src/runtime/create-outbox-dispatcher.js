const { createPostgresDatabase } = require("../persistence/postgres-database");
const {
  PostgresOutboxDispatcher,
  PostgresSentOutboxReconciler
} = require("../persistence/postgres-transactional-workflow-store");
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
    leaseSeconds: boundedInteger(environment.PETPACK_OUTBOX_LEASE_SECONDS, 60, 5, 600, "Outbox lease duration"),
    reconcileIntervalMs: boundedInteger(environment.PETPACK_OUTBOX_RECONCILE_INTERVAL_MS, 60_000, 5_000, 3_600_000, "Outbox reconciliation interval"),
    reconcileBatchLimit: boundedInteger(environment.PETPACK_OUTBOX_RECONCILE_BATCH_LIMIT, 100, 1, 100, "Outbox reconciliation batch limit")
  });
}

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") throw new Error(`${label} must implement ${method}`);
  return value;
}

async function assertOutboxSchemaReady(database) {
  const result = await database.query(
    `SELECT to_regclass('public.outbox_job') IS NOT NULL AS has_outbox,
            to_regclass('public.production_run') IS NOT NULL AS has_run,
            to_regclass('public.production_job_execution') IS NOT NULL AS has_execution`
  );
  const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
  if (!row || row.has_outbox !== true || row.has_run !== true || row.has_execution !== true) {
    throw new Error("PostgreSQL outbox schema is not ready");
  }
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
  constructor({ database, queue, dispatcher, reconciler = null, config, logger = console, waitController, now = Date.now } = {}) {
    this.database = requireMethod(requireMethod(database, "assertReady", "PostgreSQL database"), "close", "PostgreSQL database");
    requireMethod(this.database, "query", "PostgreSQL database");
    this.queue = requireMethod(requireMethod(queue, "assertReady", "BullMQ queue"), "close", "BullMQ queue");
    this.dispatcher = requireMethod(dispatcher, "dispatchBatch", "Outbox dispatcher");
    this.reconciler = reconciler === null ? null : requireMethod(reconciler, "replayBatch", "Sent outbox reconciler");
    this.config = config || loadOutboxRuntimeConfig();
    this.logger = logger;
    this.waitController = waitController || createInterruptibleWait();
    requireMethod(requireMethod(this.waitController, "wait", "Outbox wait controller"), "wake", "Outbox wait controller");
    if (typeof now !== "function") throw new Error("Outbox runtime clock is required");
    this.now = now;
    this.running = false;
    this.closed = false;
    this.loopPromise = null;
    this.consecutiveFailures = 0;
    this.lastDispatchAt = null;
    this.lastErrorAt = null;
    this.lastReconcileAt = null;
    this.lastReplayed = 0;
    this.reconcileCursor = null;
    this.nextReconcileAt = 0;
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

  async reconcileOnce() {
    if (!this.reconciler) return Object.freeze({ replayed: 0, complete: true });
    const result = await this.reconciler.replayBatch({
      limit: this.config.reconcileBatchLimit,
      cursor: this.reconcileCursor
    });
    const replayed = Number(result?.replayed);
    if (!Number.isSafeInteger(replayed) || replayed < 0 || replayed > this.config.reconcileBatchLimit) {
      throw new Error("Outbox reconciler returned an invalid replay count");
    }
    if (typeof result?.complete !== "boolean") throw new Error("Outbox reconciler returned an invalid completion state");
    if (!result.complete && (!result.nextCursor || typeof result.nextCursor !== "object")) {
      throw new Error("Outbox reconciler omitted its continuation cursor");
    }
    const currentTime = this.now();
    this.lastReconcileAt = new Date(currentTime).toISOString();
    this.lastReplayed = replayed;
    this.reconcileCursor = result.complete ? null : result.nextCursor;
    this.nextReconcileAt = result.complete ? currentTime + this.config.reconcileIntervalMs : currentTime;
    return Object.freeze({ replayed, complete: result.complete });
  }

  async _runLoop() {
    while (this.running) {
      let delay = this.config.pollIntervalMs;
      try {
        const result = await this.dispatchOnce();
        const reconciliation = this.reconciler && this.now() >= this.nextReconcileAt
          ? await this.reconcileOnce()
          : { replayed: 0, complete: true };
        this.consecutiveFailures = 0;
        delay = result.claimed > 0 || reconciliation.replayed > 0 || !reconciliation.complete
          ? this.config.busyIntervalMs
          : this.config.pollIntervalMs;
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
      lastErrorAt: this.lastErrorAt,
      lastReconcileAt: this.lastReconcileAt,
      lastReplayed: this.lastReplayed,
      reconciliationInProgress: this.reconcileCursor !== null
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
  reconciler,
  afterClaim,
  logger = console,
  waitController
} = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  if (afterClaim !== undefined && hydrated.PETPACK_PLATFORM_MODE === "production") {
    throw new Error("Outbox after-claim hooks are forbidden in production");
  }
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
      afterClaim: afterClaim || null,
      logger
    });
    const runtimeReconciler = reconciler === undefined
      ? new PostgresSentOutboxReconciler({ database: runtimeDatabase, queue: runtimeQueue, logger })
      : reconciler;
    return new OutboxDispatcherRuntime({
      database: runtimeDatabase,
      queue: runtimeQueue,
      dispatcher: runtimeDispatcher,
      reconciler: runtimeReconciler,
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
