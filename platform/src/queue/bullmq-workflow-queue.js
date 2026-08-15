const crypto = require("node:crypto");

const { assertWorkflowJob } = require("../persistence/postgres-transactional-workflow-store");

const DEFAULT_QUEUE_NAME = "petpack-production";
const DEFAULT_QUEUE_PREFIX = "petpack";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIN_DEFERRED_RETRY_MS = 1000;
const MAX_DEFERRED_RETRY_MS = 24 * 60 * 60 * 1000;
const QUEUE_COUNT_NAMES = Object.freeze([
  "waiting", "active", "completed", "failed", "delayed", "paused",
  "prioritized", "waiting-children"
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

function loadBullMqConfig(environment = process.env) {
  let url;
  try {
    url = new URL(requiredString(environment.PETPACK_REDIS_URL, "Redis connection URL"));
  } catch (_error) {
    throw new Error("Redis connection URL is invalid");
  }
  if (url.protocol !== "rediss:" || !url.hostname || !url.username || !url.password || url.hash || url.search) {
    throw new Error("Redis queue requires an authenticated rediss:// URL without query or fragment data");
  }
  const databaseText = url.pathname.replace(/^\//, "");
  const database = databaseText === "" ? 0 : Number(databaseText);
  if (!Number.isSafeInteger(database) || database < 0 || database > 15) {
    throw new Error("Redis database index must be between 0 and 15");
  }
  const queueName = (environment.PETPACK_QUEUE_NAME || DEFAULT_QUEUE_NAME).trim();
  const prefix = (environment.PETPACK_QUEUE_PREFIX || DEFAULT_QUEUE_PREFIX).trim();
  if (!NAME_PATTERN.test(queueName)) throw new Error("BullMQ queue name is invalid");
  if (!NAME_PATTERN.test(prefix)) throw new Error("BullMQ queue prefix is invalid");
  const ca = requiredString(environment.PETPACK_REDIS_CA_PEM, "Redis CA certificate");
  return Object.freeze({
    queueName,
    prefix,
    host: url.hostname,
    port: url.port ? boundedInteger(url.port, 6379, 1, 65_535, "Redis port") : 6379,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ca,
    concurrency: boundedInteger(environment.PETPACK_QUEUE_WORKER_CONCURRENCY, 4, 1, 64, "BullMQ worker concurrency")
  });
}

function createRedisConnectionOptions(config, { worker = false } = {}) {
  if (!config || typeof config !== "object") throw new Error("BullMQ configuration is required");
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    db: config.database,
    tls: {
      ca: config.ca,
      servername: config.host,
      rejectUnauthorized: true
    },
    enableReadyCheck: true,
    maxRetriesPerRequest: worker ? null : 1
  };
}

function safeBullJobId(value) {
  const sourceId = requiredString(value, "BullMQ job ID");
  if (sourceId.length > 512) throw new Error("BullMQ job ID is too long");
  if (!sourceId.includes(":")) return sourceId;
  return `petpack-${crypto.createHash("sha256").update(sourceId).digest("hex")}`;
}

class BullMqWorkflowQueue {
  constructor({ config, QueueClass, logger = console } = {}) {
    this.config = config || loadBullMqConfig();
    const Queue = QueueClass || require("bullmq").Queue;
    this.queue = new Queue(this.config.queueName, {
      connection: createRedisConnectionOptions(this.config),
      prefix: this.config.prefix
    });
    this.logger = logger;
  }

  async enqueue(job) {
    const safeJob = assertWorkflowJob(job);
    const jobId = safeBullJobId(safeJob.options.jobId);
    const queued = await this.queue.add(safeJob.name, safeJob.data, {
      ...safeJob.options,
      jobId,
      // BullMQ reserves ':' in job IDs, while PostgreSQL stores the original
      // workflow dedupe key. Preserve that source ID in job options so workers
      // can address the same durable execution after validating its mapping.
      sourceDedupeKey: safeJob.dedupeKey
    });
    this.logger.info?.("petpack.queue.job_enqueued", { name: safeJob.name, jobId });
    return { jobId: String(queued?.id || jobId), sourceDedupeKey: safeJob.dedupeKey, name: safeJob.name };
  }

  async assertReady() {
    if (typeof this.queue.waitUntilReady === "function") await this.queue.waitUntilReady();
    await this.getJobCounts();
    return Object.freeze({ ok: true });
  }

  async getJobCounts() {
    if (typeof this.queue.getJobCounts !== "function") {
      return Object.freeze(Object.fromEntries(QUEUE_COUNT_NAMES.map((name) => [name, 0])));
    }
    const counts = await this.queue.getJobCounts(...QUEUE_COUNT_NAMES);
    return Object.freeze({
      ...Object.fromEntries(QUEUE_COUNT_NAMES.map((name) => [name, 0])),
      ...(counts && typeof counts === "object" ? counts : {})
    });
  }

  async close() {
    await this.queue.close();
  }
}

function normalizeBullMqJob(job) {
  const bullJobId = safeBullJobId(String(job?.id || ""));
  const configuredSource = job?.opts?.sourceDedupeKey;
  const sourceDedupeKey = configuredSource === undefined
    ? bullJobId
    : requiredString(configuredSource, "BullMQ source dedupe key");
  if (safeBullJobId(sourceDedupeKey) !== bullJobId) {
    throw new Error("BullMQ source dedupe key does not match its queue job ID");
  }
  const options = { ...(job?.opts || {}), jobId: sourceDedupeKey };
  delete options.sourceDedupeKey;
  return {
    name: requiredString(job?.name, "BullMQ job name"),
    data: job?.data,
    id: sourceDedupeKey,
    opts: options,
    options,
    dedupeKey: sourceDedupeKey
  };
}

function deferredRetryDelayMs(error) {
  const value = Number(error?.retryAfterMs);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(MAX_DEFERRED_RETRY_MS, Math.max(MIN_DEFERRED_RETRY_MS, Math.ceil(value)));
}

class BullMqWorkflowWorker {
  constructor({ config, handler, WorkerClass, DelayedErrorClass, logger = console } = {}) {
    this.config = config || loadBullMqConfig();
    if (!handler || typeof handler.process !== "function") throw new Error("A production job handler is required");
    const Worker = WorkerClass || require("bullmq").Worker;
    const DelayedError = DelayedErrorClass || require("bullmq").DelayedError;
    if (typeof DelayedError !== "function") throw new Error("BullMQ DelayedError is required");
    this.handler = handler;
    this.logger = logger;
    this.DelayedError = DelayedError;
    this.worker = new Worker(
      this.config.queueName,
      (job, token) => this._process(job, token),
      {
        connection: createRedisConnectionOptions(this.config, { worker: true }),
        prefix: this.config.prefix,
        concurrency: this.config.concurrency,
        autorun: false
      }
    );
    this.running = false;
    this.runPromise = null;
    this.runFailure = null;
    this.worker.on?.("failed", (job, error) => {
      this.logger.warn?.("petpack.queue.job_failed", {
        name: job?.name || "unknown",
        jobId: job?.id ? String(job.id) : "unknown",
        errorName: error?.name || "Error"
      });
    });
    this.worker.on?.("error", (error) => {
      this.logger.error?.("petpack.queue.worker_error", { errorName: error?.name || "Error" });
    });
  }

  async _process(job, token) {
    try {
      return await this.handler.process(normalizeBullMqJob(job));
    } catch (error) {
      const retryAfterMs = deferredRetryDelayMs(error);
      if (retryAfterMs === null || typeof job?.moveToDelayed !== "function" ||
          typeof token !== "string" || !token) {
        throw error;
      }
      const delayedUntil = Date.now() + retryAfterMs;
      await job.moveToDelayed(delayedUntil, token);
      try {
        this.logger.info?.("petpack.queue.job_deferred_for_lease", {
          name: job?.name || "unknown",
          jobId: job?.id ? String(job.id) : "unknown",
          retryAfterMs,
          errorCode: typeof error?.code === "string" ? error.code : "lease_busy"
        });
      } catch {
        // Once the active job has moved, BullMQ must receive DelayedError even
        // if an injected logger is unhealthy.
      }
      throw new this.DelayedError();
    }
  }

  async start() {
    if (this.running) throw new Error("BullMQ workflow worker is already running");
    this.running = true;
    this.runFailure = null;
    this.runPromise = Promise.resolve(this.worker.run()).then(
      () => {
        if (this.running) {
          this.runFailure = new Error("BullMQ workflow worker stopped unexpectedly");
          this.running = false;
          this.logger.error?.("petpack.queue.worker_stopped", { errorName: this.runFailure.name });
        }
      },
      (error) => {
        if (this.running) {
          this.runFailure = error instanceof Error ? error : new Error("BullMQ workflow worker failed");
          this.running = false;
          this.logger.error?.("petpack.queue.worker_stopped", { errorName: this.runFailure.name });
        }
      }
    );
    if (typeof this.worker.waitUntilReady === "function") await this.worker.waitUntilReady();
    return Object.freeze({ ready: true, concurrency: this.config.concurrency });
  }

  async assertReady() {
    if (!this.running || this.runFailure) throw new Error("BullMQ workflow worker is not running");
    if (typeof this.worker.waitUntilReady === "function") await this.worker.waitUntilReady();
    const client = this.worker.client ? await this.worker.client : null;
    if (client && typeof client.ping === "function") {
      const pong = await client.ping();
      if (pong !== "PONG") throw new Error("BullMQ Redis readiness probe failed");
    }
    return Object.freeze({ ok: true });
  }

  async close() {
    this.running = false;
    await this.worker.close();
    await this.runPromise;
    this.runPromise = null;
  }
}

module.exports = {
  BullMqWorkflowQueue,
  BullMqWorkflowWorker,
  DEFAULT_QUEUE_NAME,
  DEFAULT_QUEUE_PREFIX,
  QUEUE_COUNT_NAMES,
  createRedisConnectionOptions,
  deferredRetryDelayMs,
  loadBullMqConfig,
  normalizeBullMqJob,
  safeBullJobId
};
