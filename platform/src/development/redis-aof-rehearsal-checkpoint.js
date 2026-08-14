"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { REQUIRED_ACTION_IDS } = require("../domain/action-catalog");
const {
  BullMqWorkflowQueue,
  loadBullMqConfig,
  safeBullJobId
} = require("../queue/bullmq-workflow-queue");
const { JOB_NAMES } = require("../workflow/production-workflow");
const { PROJECT_ROOT, requireProjectPath } = require("./zero-cost-runtime-support");

const REDIS_AOF_REHEARSAL_BASE = path.join(PROJECT_ROOT, ".tmp", "redis-aof-rehearsals");
const REDIS_AOF_CONTROL_ENV = "PETPACK_REHEARSAL_REDIS_AOF_CONTROL_ROOT";
const REDIS_AOF_DELAY_MS = 60_000;
const CHECKPOINT_STATES = Object.freeze([
  "wait",
  "delayed",
  "active",
  "failed",
  "prioritized",
  "waiting-children",
  "repeat"
]);
const FINAL_STATES = Object.freeze([...CHECKPOINT_STATES, "completed"]);
const SNAPSHOT_COUNT_STATES = Object.freeze([
  "waiting",
  "delayed",
  "active",
  "failed",
  "prioritized",
  "waiting-children",
  "repeat",
  "completed"
]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function normalizedPathKey(value) {
  return path.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalJson(value, label) {
  const visit = (current) => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (Array.isArray(current)) return Object.freeze(current.map(visit));
    if (current && typeof current === "object" &&
        [Object.prototype, null].includes(Object.getPrototypeOf(current))) {
      return Object.freeze(Object.fromEntries(
        Object.keys(current).sort().map((key) => [key, visit(current[key])])
      ));
    }
    throw new Error(`${label} contains a non-JSON value`);
  };
  return visit(value);
}

function assertRedisAofControlRoot(value) {
  const absolute = requireProjectPath(value, "Redis AOF rehearsal control root");
  const relative = path.relative(REDIS_AOF_REHEARSAL_BASE, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Redis AOF rehearsal control root escaped its approved project temp base");
  }
  const stats = fs.lstatSync(absolute);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Redis AOF rehearsal control root must be a real directory");
  }
  const real = fs.realpathSync.native(absolute);
  if (normalizedPathKey(real) !== normalizedPathKey(absolute)) {
    throw new Error("Redis AOF rehearsal control root must not be a link or reparse point");
  }
  return real;
}

function loadRedisAofCheckpointConfig(environment = process.env) {
  const configured = environment[REDIS_AOF_CONTROL_ENV];
  if (configured === undefined || configured === null || configured === "") return null;
  if (environment.NODE_ENV === "production" || environment.PETPACK_PLATFORM_MODE === "production") {
    throw new Error("Redis AOF rehearsal is forbidden in production mode");
  }
  const controlRoot = assertRedisAofControlRoot(configured);
  return Object.freeze({
    controlRoot,
    readyPath: path.join(controlRoot, "ready.json"),
    resumePath: path.join(controlRoot, "resume.json"),
    delayMs: REDIS_AOF_DELAY_MS
  });
}

function parseOutboxPayload(row) {
  let payload = row?.payload;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { throw new Error("Redis AOF rehearsal outbox payload is invalid JSON"); }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Redis AOF rehearsal outbox payload is invalid");
  }
  return payload;
}

function validateVideoOutboxRows(rows, runId) {
  if (!Array.isArray(rows) || rows.length !== REQUIRED_ACTION_IDS.length) {
    throw new Error("Redis AOF checkpoint requires exactly seven video outbox rows");
  }
  const actions = [];
  for (const row of rows) {
    const payload = parseOutboxPayload(row);
    if (row.status !== "pending" || Number(row.attempts) !== 0 || row.job_name !== JOB_NAMES.GENERATE_VIDEO ||
        payload.name !== JOB_NAMES.GENERATE_VIDEO || payload.data?.runId !== runId ||
        payload.options?.jobId !== row.dedupe_key || Object.hasOwn(payload.options || {}, "delay")) {
      throw new Error("Redis AOF checkpoint found an unsafe video outbox row");
    }
    actions.push(payload.data?.actionId);
  }
  if (new Set(actions).size !== REQUIRED_ACTION_IDS.length ||
      [...actions].sort().join("|") !== [...REQUIRED_ACTION_IDS].sort().join("|")) {
    throw new Error("Redis AOF checkpoint video action set is incomplete");
  }
  return rows;
}

function validatePendingVideoOutboxProgress(rows, runId) {
  if (!Array.isArray(rows) || rows.length > REQUIRED_ACTION_IDS.length) {
    throw new Error("Redis AOF checkpoint found too many video outbox rows");
  }
  const actions = new Set();
  for (const row of rows) {
    const payload = parseOutboxPayload(row);
    const actionId = payload.data?.actionId;
    if (row.status !== "pending" || Number(row.attempts) !== 0 || row.job_name !== JOB_NAMES.GENERATE_VIDEO ||
        payload.name !== JOB_NAMES.GENERATE_VIDEO || payload.data?.runId !== runId ||
        payload.options?.jobId !== row.dedupe_key || Object.hasOwn(payload.options || {}, "delay") ||
        !REQUIRED_ACTION_IDS.includes(actionId) || actions.has(actionId)) {
      throw new Error("Redis AOF checkpoint observed unsafe pending video outbox progress");
    }
    actions.add(actionId);
  }
  return rows;
}

async function waitForPendingRedisAofVideoOutboxRows({
  database,
  runId,
  timeoutMs = 120_000,
  intervalMs = 50
} = {}) {
  if (!database || typeof database.query !== "function") {
    throw new Error("Redis AOF pending-video checkpoint requires a queryable database");
  }
  const safeRunId = requiredString(runId, "Redis AOF pending-video run ID");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000 ||
      !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 1_000) {
    throw new Error("Redis AOF pending-video wait bounds are invalid");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await database.query(
      `SELECT id, job_name, status, attempts, dedupe_key, payload
         FROM outbox_job
        WHERE aggregate_type = 'production_run'
          AND aggregate_id = $1
          AND job_name = 'petpack.generate-video-action'
        ORDER BY payload #>> '{data,actionId}', id`,
      [safeRunId]
    );
    const rows = validatePendingVideoOutboxProgress(result.rows, safeRunId);
    if (rows.length === REQUIRED_ACTION_IDS.length) {
      validateVideoOutboxRows(rows, safeRunId);
      return Object.freeze({
        runId: safeRunId,
        rowCount: rows.length,
        actionIds: Object.freeze(rows.map((row) => parseOutboxPayload(row).data.actionId).sort())
      });
    }
    await sleep(intervalMs);
  }
  throw new Error("Redis AOF checkpoint did not observe seven pristine video outbox rows in time");
}

async function prepareRedisAofVideoJobs({ database, runId, delayMs = REDIS_AOF_DELAY_MS } = {}) {
  if (!database || typeof database.transaction !== "function") throw new Error("Redis AOF checkpoint requires a database transaction");
  const safeRunId = requiredString(runId, "Redis AOF checkpoint run ID");
  if (delayMs !== REDIS_AOF_DELAY_MS) throw new Error("Redis AOF checkpoint delay is fixed");
  return database.transaction(async (transaction) => {
    if (!transaction || typeof transaction.query !== "function") throw new Error("Redis AOF checkpoint transaction is invalid");
    const selected = await transaction.query(
      `SELECT id, job_name, status, attempts, dedupe_key, payload
         FROM outbox_job
        WHERE aggregate_type = 'production_run'
          AND aggregate_id = $1
          AND job_name = 'petpack.generate-video-action'
        ORDER BY payload #>> '{data,actionId}', id
        FOR UPDATE`,
      [safeRunId]
    );
    const rows = validateVideoOutboxRows(selected.rows, safeRunId);
    const targetActionId = REQUIRED_ACTION_IDS[0];
    const target = rows.find((row) => parseOutboxPayload(row).data.actionId === targetActionId);
    if (!target) throw new Error("Redis AOF checkpoint delayed action is unavailable");
    const updated = await transaction.query(
      `UPDATE outbox_job
          SET payload = jsonb_set(payload, '{options,delay}', to_jsonb($3::integer), true),
              updated_at = now()
        WHERE id = $2
          AND aggregate_id = $1
          AND status = 'pending'
          AND attempts = 0
          AND job_name = 'petpack.generate-video-action'
          AND NOT (payload -> 'options' ? 'delay')
      RETURNING id, dedupe_key, payload #>> '{data,actionId}' AS action_id,
                (payload #>> '{options,delay}')::integer AS delay_ms`,
      [safeRunId, target.id, delayMs]
    );
    if (updated.rows.length !== 1 || updated.rows[0].dedupe_key !== target.dedupe_key ||
        updated.rows[0].action_id !== targetActionId || Number(updated.rows[0].delay_ms) !== delayMs) {
      throw new Error("Redis AOF checkpoint did not update exactly its selected video job");
    }
    return Object.freeze({
      runId: safeRunId,
      outboxId: updated.rows[0].id,
      delayedDedupeKey: updated.rows[0].dedupe_key,
      delayedActionId: targetActionId,
      delayMs
    });
  });
}

function queueDelegate(queue) {
  const delegate = queue?.queue || queue;
  if (!delegate || typeof delegate.getJobs !== "function") throw new Error("Redis AOF checkpoint queue cannot list jobs");
  return delegate;
}

function normalizeQueueJob(job, state) {
  const id = requiredString(String(job?.id || ""), "Redis AOF checkpoint BullMQ job ID");
  const data = canonicalJson(job?.data, "Redis AOF checkpoint BullMQ job data");
  const options = canonicalJson(job?.opts, "Redis AOF checkpoint BullMQ job options");
  const sourceDedupeKey = requiredString(options.sourceDedupeKey, "Redis AOF checkpoint source dedupe key");
  const optionJobId = requiredString(options.jobId, "Redis AOF checkpoint option job ID");
  if (safeBullJobId(sourceDedupeKey) !== id || optionJobId !== id) {
    throw new Error("Redis AOF checkpoint BullMQ job identity changed");
  }
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1 ||
      options.removeOnComplete !== false || options.removeOnFail !== false ||
      options.backoff?.type !== "exponential" || !Number.isSafeInteger(options.backoff?.delay) ||
      options.backoff.delay < 1) {
    throw new Error("Redis AOF checkpoint BullMQ execution options are invalid");
  }
  const delay = Number(options.delay ?? job?.delay ?? 0);
  const timestamp = Number(job?.timestamp);
  const attemptsMade = Number(job?.attemptsMade ?? 0);
  if (!Number.isSafeInteger(delay) || delay < 0 || !Number.isSafeInteger(timestamp) || timestamp < 1 ||
      !Number.isSafeInteger(attemptsMade) || attemptsMade < 0) {
    throw new Error("Redis AOF checkpoint BullMQ timing metadata is invalid");
  }
  return Object.freeze({
    state: state === "wait" ? "waiting" : state,
    id,
    sourceDedupeKey,
    name: requiredString(job?.name, "Redis AOF checkpoint BullMQ job name"),
    runId: requiredString(data.runId, "Redis AOF checkpoint BullMQ run ID"),
    actionId: typeof data.actionId === "string" ? data.actionId : null,
    data,
    options,
    delay,
    timestamp,
    attemptsMade
  });
}

async function collectQueueSnapshot(queue, { states = CHECKPOINT_STATES } = {}) {
  const delegate = queueDelegate(queue);
  if (typeof delegate.isPaused !== "function" || await delegate.isPaused()) {
    throw new Error("Redis AOF checkpoint queue is paused or cannot prove its running state");
  }
  const jobs = [];
  for (const state of states) {
    const found = await delegate.getJobs([state], 0, -1, true);
    if (!Array.isArray(found)) throw new Error("Redis AOF checkpoint queue returned an invalid job list");
    for (const job of found) jobs.push(normalizeQueueJob(job, state));
  }
  jobs.sort((left, right) => left.id.localeCompare(right.id) || left.state.localeCompare(right.state));
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) {
    throw new Error("Redis AOF checkpoint queue returned duplicate job identities");
  }
  const counts = Object.freeze(Object.fromEntries(
    SNAPSHOT_COUNT_STATES.map((state) => [
      state,
      jobs.filter((job) => job.state === state).length
    ])
  ));
  return Object.freeze({ counts, jobs: Object.freeze(jobs), sha256: sha256Json(jobs) });
}

function assertRedisAofQueueSnapshot(snapshot, prepared) {
  if (!snapshot || !prepared || snapshot.jobs.length !== REQUIRED_ACTION_IDS.length ||
      snapshot.counts.waiting !== REQUIRED_ACTION_IDS.length - 1 || snapshot.counts.delayed !== 1 ||
      snapshot.counts.active !== 0 || snapshot.counts.failed !== 0 || snapshot.counts.prioritized !== 0 ||
      snapshot.counts["waiting-children"] !== 0 || snapshot.counts.repeat !== 0) {
    throw new Error("Redis AOF checkpoint queue has not reached six waiting and one delayed job");
  }
  const actions = snapshot.jobs.map((job) => job.actionId).sort();
  if (snapshot.jobs.some((job) => job.runId !== prepared.runId || job.name !== JOB_NAMES.GENERATE_VIDEO) ||
      actions.join("|") !== [...REQUIRED_ACTION_IDS].sort().join("|")) {
    throw new Error("Redis AOF checkpoint queue contains an unexpected workflow job");
  }
  const delayed = snapshot.jobs.filter((job) => job.state === "delayed");
  if (delayed.length !== 1 || delayed[0].sourceDedupeKey !== prepared.delayedDedupeKey ||
      delayed[0].actionId !== prepared.delayedActionId || delayed[0].delay !== prepared.delayMs) {
    throw new Error("Redis AOF checkpoint delayed job does not match its durable outbox row");
  }
  if (snapshot.jobs.some((job) => job.state === "waiting" && job.delay !== 0)) {
    throw new Error("Redis AOF checkpoint waiting jobs unexpectedly carry delay metadata");
  }
  return snapshot;
}

function defaultQueueFactory(environment, logger) {
  return new BullMqWorkflowQueue({ config: loadBullMqConfig(environment), logger });
}

async function closeQueue(queue) {
  if (queue && typeof queue.close === "function") await queue.close();
  else if (queue?.queue && typeof queue.queue.close === "function") await queue.queue.close();
}

async function queryVideoOutboxState(database, runId) {
  const result = await database.query(
    `SELECT id, status, attempts, dedupe_key
       FROM outbox_job
      WHERE aggregate_type = 'production_run'
        AND aggregate_id = $1
        AND job_name = 'petpack.generate-video-action'
      ORDER BY dedupe_key`,
    [runId]
  );
  if (result.rows.some((row) => row.status === "failed" || row.status === "dead" || Number(row.attempts) > 1)) {
    throw new Error("Redis AOF checkpoint outbox dispatch entered a failure state");
  }
  return result.rows;
}

async function waitForRedisAofQueueCheckpoint({
  database,
  environment,
  prepared,
  queueFactory = defaultQueueFactory,
  logger = console,
  timeoutMs = 60_000,
  intervalMs = 50
} = {}) {
  if (!database || typeof database.query !== "function") throw new Error("Redis AOF checkpoint requires a queryable database");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 1_000) {
    throw new Error("Redis AOF checkpoint wait bounds are invalid");
  }
  const queue = queueFactory(environment, logger);
  try {
    if (typeof queue.assertReady === "function") await queue.assertReady();
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot = null;
    while (Date.now() < deadline) {
      const outboxRows = await queryVideoOutboxState(database, prepared.runId);
      lastSnapshot = await collectQueueSnapshot(queue);
      const dispatched = outboxRows.length === REQUIRED_ACTION_IDS.length &&
        outboxRows.every((row) => row.status === "sent" && Number(row.attempts) === 1);
      if (dispatched) {
        try { return assertRedisAofQueueSnapshot(lastSnapshot, prepared); } catch { /* bounded retry */ }
      }
      await sleep(intervalMs);
    }
    throw Object.assign(new Error("Redis AOF checkpoint queue did not reach its durable state in time"), { lastSnapshot });
  } finally {
    await closeQueue(queue);
  }
}

async function collectFrozenRedisAofQueueSnapshot({
  environment,
  prepared,
  queueFactory = defaultQueueFactory,
  logger = console
} = {}) {
  const queue = queueFactory(environment, logger);
  try {
    if (typeof queue.assertReady === "function") await queue.assertReady();
    return assertRedisAofQueueSnapshot(await collectQueueSnapshot(queue), prepared);
  } finally {
    await closeQueue(queue);
  }
}

async function writeExclusiveJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return filePath;
}

async function waitForResume(config, nonce, { timeoutMs = 120_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stats = await fsp.lstat(config.resumePath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Redis AOF resume evidence must be a regular file");
      const resume = JSON.parse(await fsp.readFile(config.resumePath, "utf8"));
      if (resume?.schemaVersion !== "petpack-redis-aof-resume/v1" || resume.nonce !== nonce ||
          !/^[a-f0-9]{64}$/.test(String(resume.containerId || "")) || resume.sameContainerRestarted !== true) {
        throw new Error("Redis AOF resume evidence is invalid");
      }
      return Object.freeze(resume);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(intervalMs);
  }
  throw new Error("Redis AOF rehearsal did not receive bounded restart evidence");
}

async function performRedisAofRestartHandshake({
  config,
  environment,
  prepared,
  before,
  queueFactory = defaultQueueFactory,
  logger = console
} = {}) {
  if (!config || !before) throw new Error("Redis AOF restart handshake is incomplete");
  const nonce = crypto.randomBytes(24).toString("hex");
  await writeExclusiveJson(config.readyPath, {
    schemaVersion: "petpack-redis-aof-ready/v1",
    nonce,
    readyAt: new Date().toISOString(),
    queueName: environment.PETPACK_QUEUE_NAME,
    queuePrefix: environment.PETPACK_QUEUE_PREFIX,
    prepared,
    before
  });
  const resume = await waitForResume(config, nonce);
  const after = await collectFrozenRedisAofQueueSnapshot({ environment, prepared, queueFactory, logger });
  if (after.sha256 !== before.sha256 || JSON.stringify(after.jobs) !== JSON.stringify(before.jobs)) {
    throw new Error("Redis AOF restart changed waiting or delayed workflow jobs");
  }
  return Object.freeze({
    schemaVersion: "petpack-redis-aof-checkpoint/v1",
    containerId: resume.containerId,
    sameContainerRestarted: true,
    before,
    after,
    restoredJobCount: after.jobs.length
  });
}

async function collectFinalRedisAofQueueContract({
  database,
  environment,
  runId,
  queueFactory = defaultQueueFactory,
  logger = console
} = {}) {
  const result = await database.query(
    `SELECT dedupe_key, status
       FROM outbox_job
      WHERE aggregate_type = 'production_run' AND aggregate_id = $1
      ORDER BY dedupe_key`,
    [runId]
  );
  if (result.rows.length !== 39 || result.rows.some((row) => row.status !== "sent")) {
    throw new Error("Redis AOF final queue contract requires 39 sent outbox jobs");
  }
  const expected = new Map(result.rows.map((row) => [safeBullJobId(row.dedupe_key), row.dedupe_key]));
  if (expected.size !== result.rows.length) {
    throw new Error("Redis AOF final queue contract found duplicate BullMQ identities");
  }
  const queue = queueFactory(environment, logger);
  try {
    if (typeof queue.assertReady === "function") await queue.assertReady();
    const snapshot = await collectQueueSnapshot(queue, { states: FINAL_STATES });
    if (snapshot.counts.waiting !== 0 || snapshot.counts.delayed !== 0 || snapshot.counts.active !== 0 ||
        snapshot.counts.failed !== 0 || snapshot.counts.prioritized !== 0 ||
        snapshot.counts["waiting-children"] !== 0 || snapshot.counts.repeat !== 0 ||
        snapshot.counts.completed !== 39 || snapshot.jobs.length !== 39 ||
        snapshot.jobs.some((job) => job.state !== "completed" || expected.get(job.id) !== job.sourceDedupeKey)) {
      throw new Error("Redis AOF final BullMQ queue is not fully and exactly drained");
    }
    return Object.freeze({
      schemaVersion: "petpack-redis-aof-final-queue/v1",
      counts: snapshot.counts,
      completedJobSha256: snapshot.sha256,
      outboxJobCount: result.rows.length
    });
  } finally {
    await closeQueue(queue);
  }
}

module.exports = {
  CHECKPOINT_STATES,
  FINAL_STATES,
  REDIS_AOF_CONTROL_ENV,
  REDIS_AOF_DELAY_MS,
  REDIS_AOF_REHEARSAL_BASE,
  assertRedisAofControlRoot,
  assertRedisAofQueueSnapshot,
  collectFinalRedisAofQueueContract,
  collectFrozenRedisAofQueueSnapshot,
  collectQueueSnapshot,
  loadRedisAofCheckpointConfig,
  performRedisAofRestartHandshake,
  prepareRedisAofVideoJobs,
  validatePendingVideoOutboxProgress,
  validateVideoOutboxRows,
  waitForPendingRedisAofVideoOutboxRows,
  waitForRedisAofQueueCheckpoint,
  waitForResume
};
