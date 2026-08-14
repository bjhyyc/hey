const crypto = require("node:crypto");

const {
  PostgresSentOutboxReconciler
} = require("../persistence/postgres-transactional-workflow-store");
const {
  BullMqWorkflowQueue,
  loadBullMqConfig
} = require("../queue/bullmq-workflow-queue");

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function assertLoopbackRedisUrl(value) {
  let parsed;
  try { parsed = new URL(requiredString(value, "Redis recovery URL")); } catch {
    throw new Error("Redis recovery URL is invalid");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "rediss:" || !["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Redis recovery rehearsal must use loopback rediss only");
  }
  return parsed;
}

function createDurableRecoveryRow(seed) {
  const digest = crypto.createHash("sha256").update(requiredString(seed, "Recovery seed")).digest("hex");
  const dedupeKey = `petpack:${digest}`;
  return Object.freeze({
    id: "30000000-0000-4000-8000-000000000001",
    job_name: "petpack.generate-front-master",
    payload: Object.freeze({
      name: "petpack.generate-front-master",
      data: Object.freeze({ runId: "40000000-0000-4000-8000-000000000001" }),
      options: Object.freeze({
        jobId: dedupeKey,
        attempts: 3,
        backoff: Object.freeze({ type: "exponential", delay: 5000 }),
        removeOnComplete: false,
        removeOnFail: false
      })
    }),
    dedupe_key: dedupeKey,
    created_at: "2026-08-13T20:00:00.000Z"
  });
}

function createFixtureDatabase(row) {
  return Object.freeze({
    async transaction(callback) {
      return callback({
        async query() {
          return { rows: [row] };
        }
      });
    }
  });
}

async function verifyEmptyRedisQueueRecovery({ environment = process.env, QueueClass, logger = console } = {}) {
  if (environment.NODE_ENV === "production" || environment.PETPACK_PLATFORM_MODE === "production") {
    throw new Error("Redis loss recovery rehearsal is forbidden in production mode");
  }
  assertLoopbackRedisUrl(environment.PETPACK_REDIS_URL);
  const phase = requiredString(environment.PETPACK_REDIS_RECOVERY_PHASE, "Redis recovery phase");
  if (!new Set(["source", "recovered"]).has(phase)) throw new Error("Redis recovery phase is invalid");
  const seed = requiredString(environment.PETPACK_REDIS_RECOVERY_SEED, "Redis recovery seed");
  const row = createDurableRecoveryRow(seed);
  const queue = new BullMqWorkflowQueue({
    config: loadBullMqConfig(environment),
    QueueClass,
    logger
  });
  try {
    await queue.assertReady();
    const waitingBefore = await queue.queue.getWaitingCount();
    if (waitingBefore !== 0) throw new Error("Redis recovery rehearsal queue was not empty before replay");
    const reconciler = new PostgresSentOutboxReconciler({
      database: createFixtureDatabase(row),
      queue,
      logger
    });
    const replay = await reconciler.replayBatch({ limit: 10 });
    const waitingAfter = await queue.queue.getWaitingCount();
    if (replay.replayed !== 1 || waitingAfter !== 1) {
      throw new Error("Redis recovery rehearsal did not restore the durable queue job");
    }
    return Object.freeze({
      schemaVersion: "petpack-empty-redis-recovery/v1",
      phase,
      waitingBefore,
      waitingAfter,
      replayed: replay.replayed,
      deterministicJobSha256: crypto.createHash("sha256").update(row.dedupe_key).digest("hex")
    });
  } finally {
    await queue.close();
  }
}

if (require.main === module) {
  verifyEmptyRedisQueueRecovery({
    logger: {
      info() {},
      warn() {},
      error() {}
    }
  }).then((report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }).catch((error) => {
    process.stderr.write(`petpack.empty_redis_recovery.failed ${JSON.stringify({
      errorName: error?.name || "Error",
      code: typeof error?.code === "string" ? error.code : "recovery_rehearsal_failed"
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertLoopbackRedisUrl,
  createDurableRecoveryRow,
  verifyEmptyRedisQueueRecovery
};
