const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { createPostgresDatabase } = require("../persistence/postgres-database");
const { verifyPetpackArchive } = require("../petpack/build");
const { REQUIRED_ACTION_IDS } = require("../domain/action-catalog");
const { createFixturePng } = require("./zero-cost-worker-components");
const { seedZeroCostDatabase } = require("./seed-zero-cost-rehearsal");
const {
  PROJECT_ROOT,
  buildZeroCostEnvironment,
  requireProjectPath,
  safeStartupFailure
} = require("./zero-cost-runtime-support");
const { importPetpack } = require(path.join(PROJECT_ROOT, "src", "main", "services", "petpack"));

const API_ENTRY = path.resolve(__dirname, "start-zero-cost-studio-api.js");
const OUTBOX_ENTRY = path.resolve(__dirname, "start-zero-cost-outbox.js");
const WORKER_ENTRY = path.resolve(__dirname, "start-zero-cost-studio-worker.js");
const DEFAULT_API_PORT = 18787;
const DEFAULT_OBJECT_PORT = 18991;
const CHILD_ENTRY_BY_ROLE = Object.freeze({
  api: API_ENTRY,
  outbox: OUTBOX_ENTRY,
  worker: WORKER_ENTRY
});

function normalizedPath(value) {
  return path.resolve(String(value || "")).replace(/[\\/]+$/, "").toLowerCase();
}

function requireOwnedChildRecord(record) {
  const expectedEntry = CHILD_ENTRY_BY_ROLE[record?.role];
  if (!expectedEntry || normalizedPath(record?.entry) !== normalizedPath(expectedEntry)) {
    throw new Error("Rehearsal child record has an unexpected role or entry");
  }
  const child = record?.child;
  if (!child || typeof child.kill !== "function" || !Array.isArray(child.spawnargs)) {
    throw new Error("Rehearsal child record is not an owned ChildProcess");
  }
  if (normalizedPath(child.spawnfile) !== normalizedPath(process.execPath) ||
      normalizedPath(child.spawnargs[1]) !== normalizedPath(expectedEntry)) {
    throw new Error("Rehearsal child process identity does not match its fixed entry");
  }
  return child;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function positivePort(value, fallback, label) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65535) throw new Error(`${label} is invalid`);
  return parsed;
}

function uniqueRehearsalId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `rehearsal-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeFaultPlan(value) {
  const input = value === undefined || value === null ? {} : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Rehearsal fault plan must be an object");
  const allowed = new Set(["apiAfterPhotos", "outboxAfterClaim", "outboxAfterEnqueue", "workerActiveLease"]);
  for (const [key, enabled] of Object.entries(input)) {
    if (!allowed.has(key) || typeof enabled !== "boolean") throw new Error("Rehearsal fault plan is invalid");
  }
  if (input.outboxAfterClaim === true && input.outboxAfterEnqueue === true) {
    throw new Error("Rehearsal outbox fault checkpoints must run in separate processes");
  }
  return Object.freeze({
    apiAfterPhotos: input.apiAfterPhotos === true,
    outboxAfterClaim: input.outboxAfterClaim === true,
    outboxAfterEnqueue: input.outboxAfterEnqueue === true,
    workerActiveLease: input.workerActiveLease === true
  });
}

async function createRehearsalEnvironment(environment = process.env) {
  const rehearsalId = uniqueRehearsalId();
  const root = requireProjectPath(
    path.join(PROJECT_ROOT, ".tmp", "zero-cost-rehearsals", rehearsalId),
    "Rehearsal run root"
  );
  const workerTempRoot = requireProjectPath(path.join(root, "worker-temp"), "Rehearsal worker temporary root");
  const objectRoot = requireProjectPath(path.join(root, "private-object-store"), "Rehearsal object root");
  const auditFile = requireProjectPath(path.join(root, "fixture-audit.jsonl"), "Rehearsal fixture audit file");
  const reportPath = requireProjectPath(path.join(root, "report.json"), "Rehearsal report path");
  const petpackPath = requireProjectPath(path.join(root, "delivery.petpack"), "Rehearsal PetPack path");
  const clientImportRoot = requireProjectPath(path.join(root, "client-import-user-data"), "Rehearsal client import root");
  await fsp.mkdir(workerTempRoot, { recursive: true });
  requireProjectPath(root, "Rehearsal run root");
  requireProjectPath(workerTempRoot, "Rehearsal worker temporary root");
  requireProjectPath(objectRoot, "Rehearsal object root");
  requireProjectPath(auditFile, "Rehearsal fixture audit file");
  requireProjectPath(reportPath, "Rehearsal report path");
  requireProjectPath(petpackPath, "Rehearsal PetPack path");
  requireProjectPath(clientImportRoot, "Rehearsal client import root");
  const apiPort = positivePort(environment.PETPACK_REHEARSAL_API_PORT, DEFAULT_API_PORT, "Rehearsal API port");
  const objectPort = positivePort(environment.PETPACK_REHEARSAL_OBJECT_PORT, DEFAULT_OBJECT_PORT, "Rehearsal object port");
  const generated = {
    ...environment,
    NODE_ENV: "development",
    PETPACK_PLATFORM_MODE: "development",
    PETPACK_API_PORT: String(apiPort),
    PETPACK_LOCAL_OBJECT_ROOT: objectRoot,
    PETPACK_LOCAL_OBJECT_BASE_URL: `http://127.0.0.1:${objectPort}`,
    PETPACK_LOCAL_OBJECT_SIGNING_SECRET: crypto.randomBytes(48).toString("base64url"),
    PETPACK_LOCAL_OBJECT_ALLOWED_ORIGINS: `http://127.0.0.1:${apiPort}`,
    PETPACK_WORKER_TEMP_ROOT: workerTempRoot,
    PETPACK_REHEARSAL_AUDIT_FILE: auditFile,
    PETPACK_SESSION_SIGNING_KEY: crypto.randomBytes(48).toString("base64url"),
    PETPACK_PAYMENT_NOTIFICATION_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    PETPACK_QUEUE_NAME: `petpack-${rehearsalId}`,
    PETPACK_QUEUE_PREFIX: `petpack-${rehearsalId}`
  };
  const safe = buildZeroCostEnvironment(generated, { role: "seed" });
  return Object.freeze({
    rehearsalId,
    root,
    reportPath,
    petpackPath,
    clientImportRoot,
    apiOrigin: `http://127.0.0.1:${apiPort}`,
    environment: safe
  });
}

function collectChildOutput(child, role, logger) {
  const write = (level, chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      if (line.includes("petpack.postgres.transaction_committed")) continue;
      logger[level]?.(`petpack.zero_cost.${role}.child`, { line: line.slice(0, 1000) });
    }
  };
  child.stdout?.on("data", (chunk) => write("debug", chunk));
  child.stderr?.on("data", (chunk) => write("warn", chunk));
}

async function startChild({ role, entry, environment, logger = console, timeoutMs = 30_000 } = {}) {
  const expectedEntry = CHILD_ENTRY_BY_ROLE[role];
  const resolvedEntry = path.resolve(String(entry || ""));
  if (!expectedEntry || normalizedPath(resolvedEntry) !== normalizedPath(expectedEntry)) {
    throw new Error("Rehearsal child role and entry are not allowlisted");
  }
  const child = spawn(process.execPath, [resolvedEntry], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    shell: false
  });
  const messages = [];
  child.on("message", (message) => {
    if (message && typeof message === "object") messages.push(message);
  });
  collectChildOutput(child, role, logger);
  let ready;
  try {
    ready = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => finish(reject, new Error(`${role} did not become ready in time`)), timeoutMs);
      child.once("error", (error) => finish(reject, error));
      child.once("exit", (code) => finish(reject, new Error(`${role} exited before ready with code ${code}`)));
      child.on("message", (message) => {
        if (message && message.type === "ready" && message.role === role) finish(resolve, message);
      });
    });
  } catch (error) {
    try { await stopChild({ role, entry: resolvedEntry, child, messages }, { timeoutMs: 5_000 }); } catch (stopError) { error.stopError = stopError; }
    throw error;
  }
  return { role, entry: resolvedEntry, child, messages, ready };
}

async function stopChild(record, { timeoutMs = 30_000 } = {}) {
  const child = requireOwnedChildRecord(record);
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  if (!result) throw new Error(`${record.role} did not stop gracefully; it was left for operator inspection`);
}

async function hardKillChild(record, { timeoutMs = 5_000 } = {}) {
  const child = requireOwnedChildRecord(record);
  if (child.exitCode !== null) throw new Error(`${record.role} already exited before its hard-kill checkpoint`);
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  if (child.kill("SIGKILL") !== true) throw new Error(`${record.role} rejected the exact child hard-kill request`);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  if (!result) throw new Error(`${record.role} did not exit after its owned ChildProcess handle was hard-killed`);
  return Object.freeze(result);
}

async function waitForChildCheckpoint(record, checkpoint, { timeoutMs = 120_000 } = {}) {
  const child = requireOwnedChildRecord(record);
  const matches = (message) => message?.type === "checkpoint" && message.role === record.role && message.checkpoint === checkpoint;
  const existing = record.messages.find(matches);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      callback(value);
    };
    const onMessage = (message) => {
      if (matches(message)) finish(resolve, message);
    };
    const onExit = (code) => finish(reject, new Error(`${record.role} exited before checkpoint ${checkpoint} with code ${code}`));
    const timer = setTimeout(
      () => finish(reject, new Error(`${record.role} did not reach checkpoint ${checkpoint} in time`)),
      timeoutMs
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function request(apiOrigin, route, { method = "GET", body, cookie, expectedStatus } = {}) {
  const response = await fetch(new URL(route, apiOrigin), {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  const accepted = expectedStatus === undefined ? response.ok : response.status === expectedStatus;
  if (!accepted) {
    const error = new Error(`Rehearsal HTTP ${method} ${route} failed with ${response.status}`);
    error.response = parsed;
    throw error;
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

async function waitForProject({ apiOrigin, projectId, cookie, predicate, timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = (await request(apiOrigin, `/api/projects/${encodeURIComponent(projectId)}`, { cookie })).body;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const error = new Error("Rehearsal project did not reach its expected state in time");
  error.lastProjectView = last;
  throw error;
}

async function readAudit(auditPath) {
  let text;
  try { text = await fsp.readFile(auditPath, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForVideoSubmissions({ database, runId, count = REQUIRED_ACTION_IDS.length, timeoutMs = 60_000 } = {}) {
  if (!database || typeof database.query !== "function") throw new Error("Rehearsal database is required at the restart checkpoint");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await database.query(
      `SELECT count(*)::integer AS total_actions,
              count(*) FILTER (WHERE provider_task_id IS NOT NULL)::integer AS bound_provider_tasks,
              (SELECT count(*)::integer
                 FROM production_job_execution execution
                WHERE execution.run_id = $1
                  AND execution.job_name = 'petpack.generate-video-action'
                  AND execution.status = 'reconciliation_required') AS reconciliation_required
         FROM generation_action
        WHERE run_id = $1`,
      [runId]
    );
    const checkpoint = result.rows[0] || {};
    if (Number(checkpoint.reconciliation_required) > 0) {
      throw new Error("Rehearsal reached reconciliation before the safe worker restart checkpoint");
    }
    if (Number(checkpoint.total_actions) === count && Number(checkpoint.bound_provider_tasks) === count) return checkpoint;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Rehearsal did not persist all fixture provider task IDs before the restart checkpoint");
}

async function waitForActiveVideoPollLease({ database, runId, count = REQUIRED_ACTION_IDS.length, timeoutMs = 45_000 } = {}) {
  if (!database || typeof database.query !== "function") throw new Error("Rehearsal database is required at the active-lease checkpoint");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await database.query(
      `SELECT (SELECT count(*)::integer FROM generation_action action
                WHERE action.run_id = $1) AS total_actions,
              (SELECT count(*)::integer FROM generation_action action
                WHERE action.run_id = $1 AND action.provider_task_id IS NOT NULL) AS bound_provider_tasks,
              (SELECT count(*)::integer FROM production_job_execution execution
                WHERE execution.run_id = $1
                  AND execution.job_name = 'petpack.poll-video-action'
                  AND execution.status = 'leased'
                  AND execution.leased_until > now()) AS active_poll_leases,
              (SELECT count(*)::integer FROM production_job_execution execution
                WHERE execution.run_id = $1
                  AND execution.status = 'reconciliation_required') AS reconciliation_required`,
      [runId]
    );
    const checkpoint = result.rows[0] || {};
    if (Number(checkpoint.reconciliation_required) > 0) {
      throw new Error("Rehearsal reached reconciliation before the active worker lease checkpoint");
    }
    if (Number(checkpoint.total_actions) === count &&
        Number(checkpoint.bound_provider_tasks) === count &&
        Number(checkpoint.active_poll_leases) > 0) {
      return checkpoint;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Rehearsal did not reach an active video poll lease before hard-kill");
}

async function collectDatabaseReport(database, projectId) {
  const runResult = await database.query(
    `SELECT run.id, run.state, run.failure_code,
            (SELECT count(*)::integer FROM source_photo photo
              WHERE photo.project_id = run.project_id AND photo.accepted_at IS NOT NULL) AS confirmed_source_photos,
            (SELECT count(*)::integer FROM image_candidate c WHERE c.run_id = run.id AND c.qa_status = 'passed') AS passed_masters,
            (SELECT count(*)::integer FROM generation_action a WHERE a.run_id = run.id AND a.state = 'qa_passed') AS passed_actions,
            (SELECT count(*)::integer FROM qa_report qa WHERE qa.run_id = run.id AND qa.status = 'passed') AS passed_qa_reports,
            (SELECT count(*)::integer FROM qa_report qa WHERE qa.run_id = run.id AND qa.status <> 'passed') AS failed_qa_reports,
            (SELECT count(*)::integer FROM production_job_execution execution WHERE execution.run_id = run.id) AS total_executions,
            (SELECT count(*)::integer FROM production_job_execution execution
              WHERE execution.run_id = run.id AND execution.status = 'succeeded') AS succeeded_executions,
            (SELECT count(*)::integer FROM production_job_execution execution
              WHERE execution.run_id = run.id AND execution.status <> 'succeeded') AS incomplete_executions,
            (SELECT count(*)::integer FROM outbox_job o WHERE o.aggregate_id = run.id) AS total_outbox_jobs,
            (SELECT count(*)::integer FROM outbox_job o WHERE o.aggregate_id = run.id AND o.status = 'sent') AS sent_outbox_jobs,
            (SELECT count(*)::integer FROM outbox_job o WHERE o.aggregate_id = run.id AND o.status <> 'sent') AS unsent_outbox,
            (SELECT count(*)::integer FROM provider_usage_attempt u WHERE u.run_id = run.id) AS fixture_usage_attempts
       FROM production_run run
      WHERE run.project_id = $1`,
    [projectId]
  );
  if (runResult.rows.length !== 1) throw new Error("Rehearsal production run was not found");
  const delivery = await database.query(
    `SELECT delivery.status, asset.sha256, asset.byte_size, asset.content_type
       FROM delivery
       JOIN customer_order order_record ON order_record.id = delivery.order_id
       JOIN petpack_build build ON build.id = delivery.petpack_build_id
       JOIN media_asset asset ON asset.id = build.media_asset_id
      WHERE order_record.project_id = $1`,
    [projectId]
  );
  if (delivery.rows.length !== 1) throw new Error("Rehearsal delivery was not found");
  return { run: runResult.rows[0], delivery: delivery.rows[0] };
}

async function collectOutboxFaultEvidence(database, checkpoint) {
  if (!checkpoint?.outboxId || !checkpoint?.dedupeKey) return null;
  const result = await database.query(
    `SELECT outbox.id, outbox.status, outbox.attempts, outbox.dedupe_key,
            outbox.payload #>> '{options,jobId}' AS payload_job_id,
            execution.job_id AS execution_job_id,
            execution.status AS execution_status,
            execution.attempts AS execution_attempts,
            generation.provider_request_id
       FROM outbox_job outbox
       LEFT JOIN production_job_execution execution ON execution.job_id = outbox.dedupe_key
       LEFT JOIN master_image_generation generation ON generation.job_id = outbox.dedupe_key
      WHERE outbox.id = $1 AND outbox.dedupe_key = $2`,
    [checkpoint.outboxId, checkpoint.dedupeKey]
  );
  if (result.rows.length !== 1) throw new Error("Rehearsal outbox fault evidence is unavailable");
  const row = result.rows[0];
  return Object.freeze({
    outboxId: row.id,
    dedupeKey: row.dedupe_key,
    payloadJobId: row.payload_job_id,
    outboxStatus: row.status,
    outboxAttempts: Number(row.attempts),
    executionJobId: row.execution_job_id,
    executionStatus: row.execution_status,
    executionAttempts: Number(row.execution_attempts),
    providerRequestId: row.provider_request_id
  });
}

async function collectOutboxCheckpointEvidence(database, checkpoint) {
  if (!checkpoint?.outboxId || !checkpoint?.dedupeKey) {
    throw new Error("Rehearsal outbox checkpoint identity is incomplete");
  }
  const result = await database.query(
    `SELECT id, status, attempts, lease_token IS NOT NULL AS has_lease_token,
            dedupe_key, payload #>> '{options,jobId}' AS payload_job_id
       FROM outbox_job
      WHERE id = $1 AND dedupe_key = $2`,
    [checkpoint.outboxId, checkpoint.dedupeKey]
  );
  if (result.rows.length !== 1) throw new Error("Rehearsal outbox checkpoint row is unavailable");
  const row = result.rows[0];
  return Object.freeze({
    outboxId: row.id,
    status: row.status,
    attempts: Number(row.attempts),
    hasLeaseToken: row.has_lease_token === true,
    dedupeKey: row.dedupe_key,
    payloadJobId: row.payload_job_id
  });
}

function hasExactOutboxReplayEvidence(evidence) {
  return Boolean(evidence) &&
    evidence.preKillStatus === "leased" &&
    evidence.preKillAttempts === 1 &&
    evidence.preKillHasLeaseToken === true &&
    evidence.preKillDedupeKey === evidence.dedupeKey &&
    evidence.preKillPayloadJobId === evidence.dedupeKey &&
    evidence.outboxStatus === "sent" &&
    evidence.outboxAttempts === 2 &&
    evidence.executionStatus === "succeeded" &&
    evidence.executionAttempts === 1 &&
    evidence.dedupeKey === evidence.payloadJobId &&
    evidence.dedupeKey === evidence.executionJobId &&
    typeof evidence.providerRequestId === "string" && evidence.providerRequestId.length > 0 &&
    evidence.frontProviderCalls === 1;
}

function hasFinalDatabaseContract(databaseReport) {
  const run = databaseReport?.run || {};
  return Number(run.confirmed_source_photos) === 3 &&
    Number(run.passed_masters) === 3 &&
    Number(run.passed_actions) === 7 &&
    Number(run.passed_qa_reports) === 12 &&
    Number(run.failed_qa_reports) === 0 &&
    Number(run.total_executions) === 38 &&
    Number(run.succeeded_executions) === 38 &&
    Number(run.incomplete_executions) === 0 &&
    Number(run.total_outbox_jobs) === 39 &&
    Number(run.sent_outbox_jobs) === 39 &&
    Number(run.unsent_outbox) === 0 &&
    Number(run.fixture_usage_attempts) === 10 &&
    run.state === "deliverable" &&
    databaseReport?.delivery?.status === "ready";
}

async function waitForFinalDatabaseContract({
  database,
  projectId,
  timeoutMs = 60_000,
  intervalMs = 100,
  collectReport = collectDatabaseReport
}) {
  if (!database || typeof database.query !== "function") throw new Error("Final database contract requires a database");
  if (typeof collectReport !== "function") throw new Error("Final database contract collector is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("Final database contract timeout is invalid");
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 5_000) throw new Error("Final database contract interval is invalid");
  const deadline = Date.now() + timeoutMs;
  let lastReport = null;
  do {
    lastReport = await collectReport(database, projectId);
    if (hasFinalDatabaseContract(lastReport)) return lastReport;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw Object.assign(new Error("Rehearsal database did not reach the final drained contract"), {
    databaseReport: lastReport
  });
}

async function runZeroCostRehearsal({
  environment = process.env,
  logger = console,
  restartWorker = true,
  faultPlan
} = {}) {
  const faults = normalizeFaultPlan(faultPlan);
  const config = await createRehearsalEnvironment(environment);
  const database = createPostgresDatabase({ environment: config.environment, logger });
  const children = [];
  let apiRecord;
  let outboxRecord;
  let workerRecord;
  let workerRestarted = false;
  let apiHardKilled = false;
  let outboxHardKilled = false;
  let workerHardKilled = false;
  const faultCheckpoints = {};
  const stopAll = async () => {
    const failures = [];
    for (const record of [...children].reverse()) {
      try { await stopChild(record); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  };
  const signalHandler = () => stopAll().catch(() => undefined);
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    await database.assertReady();
    const seed = await seedZeroCostDatabase({ database, environment: config.environment });
    await database.close();

    apiRecord = await startChild({ role: "api", entry: API_ENTRY, environment: config.environment, logger });
    children.push(apiRecord);
    const initialOutboxEnvironment = faults.outboxAfterClaim || faults.outboxAfterEnqueue
      ? {
        ...config.environment,
        PETPACK_REHEARSAL_OUTBOX_HARD_KILL: faults.outboxAfterClaim ? "true" : "false",
        PETPACK_REHEARSAL_OUTBOX_POST_ENQUEUE_HARD_KILL: faults.outboxAfterEnqueue ? "true" : "false",
        PETPACK_OUTBOX_LEASE_SECONDS: "5"
      }
      : config.environment;
    outboxRecord = await startChild({ role: "outbox", entry: OUTBOX_ENTRY, environment: initialOutboxEnvironment, logger });
    children.push(outboxRecord);
    const outboxClaimCheckpoint = faults.outboxAfterClaim || faults.outboxAfterEnqueue
      ? waitForChildCheckpoint(
        outboxRecord,
        faults.outboxAfterClaim ? "claimed_before_enqueue" : "enqueued_before_mark_sent"
      )
      : null;
    const initialWorkerEnvironment = faults.workerActiveLease
      ? { ...config.environment, PETPACK_REHEARSAL_VIDEO_POLL_HOLD_MS: "20000" }
      : config.environment;
    workerRecord = await startChild({ role: "worker", entry: WORKER_ENTRY, environment: initialWorkerEnvironment, logger });
    children.push(workerRecord);

    const cookie = `${seed.sessionCookieName}=${seed.sessionToken}`;
    const auth = await request(config.apiOrigin, "/api/auth/session", { cookie });
    if (auth.body?.authenticated !== true) throw new Error("Rehearsal session did not authenticate");
    const checkout = await request(config.apiOrigin, "/api/checkout", {
      method: "POST",
      cookie,
      expectedStatus: 201,
      body: {
        planCode: seed.planCode,
        displayName: "Zero Cost Pet",
        paymentMethod: "KAIPAY",
        idempotencyKey: `checkout-${config.rehearsalId}`
      }
    });
    const projectId = checkout.body?.project?.id;
    const orderId = checkout.body?.order?.id;
    if (!projectId || !orderId || !String(checkout.body?.checkout?.checkoutUrl || "").startsWith("petpack-dev://")) {
      throw new Error("Rehearsal simulated checkout response is invalid");
    }
    await request(config.apiOrigin, `/api/payments/kaipay/notify/${encodeURIComponent(orderId)}`, {
      method: "POST",
      expectedStatus: 200,
      body: { type: "development_payment_confirmed", platformOrderId: orderId }
    });

    const photos = [0, 1, 2].map((variant) => {
      const bytes = createFixturePng({ kind: "source", variant });
      return { bytes, contentType: "image/png", sha256: sha256(bytes), byteSize: bytes.length };
    });
    const grants = await request(config.apiOrigin, `/api/projects/${encodeURIComponent(projectId)}/photos/upload-grants`, {
      method: "POST",
      cookie,
      expectedStatus: 201,
      body: { files: photos.map(({ bytes: _bytes, ...metadata }) => metadata) }
    });
    if (!Array.isArray(grants.body) || grants.body.length !== photos.length) throw new Error("Rehearsal upload grants are incomplete");
    for (let index = 0; index < photos.length; index += 1) {
      const upload = await fetch(grants.body[index].uploadUrl, {
        method: "PUT",
        headers: { "content-type": photos[index].contentType, "if-none-match": "*" },
        body: photos[index].bytes
      });
      if (upload.status !== 201) throw new Error(`Rehearsal photo ${index + 1} upload failed with ${upload.status}`);
      await request(config.apiOrigin, `/api/projects/${encodeURIComponent(projectId)}/photos/${index + 1}/confirm`, {
        method: "POST",
        cookie,
        body: { sha256: photos[index].sha256, byteSize: photos[index].byteSize }
      });
    }

    if (faults.outboxAfterClaim || faults.outboxAfterEnqueue) {
      const checkpoint = await outboxClaimCheckpoint;
      const checkpointDatabase = createPostgresDatabase({ environment: config.environment, logger });
      let databaseEvidence;
      try {
        databaseEvidence = await collectOutboxCheckpointEvidence(checkpointDatabase, checkpoint);
      } finally {
        await checkpointDatabase.close();
      }
      faultCheckpoints.outbox = Object.freeze({ ...checkpoint, database: databaseEvidence });
      await hardKillChild(outboxRecord);
      const outboxIndex = children.indexOf(outboxRecord);
      if (outboxIndex < 0) throw new Error("Hard-killed outbox child was not tracked");
      children.splice(outboxIndex, 1);
      outboxRecord = await startChild({
        role: "outbox",
        entry: OUTBOX_ENTRY,
        environment: {
          ...config.environment,
          PETPACK_REHEARSAL_OUTBOX_HARD_KILL: "false",
          PETPACK_REHEARSAL_OUTBOX_POST_ENQUEUE_HARD_KILL: "false",
          PETPACK_OUTBOX_LEASE_SECONDS: "5"
        },
        logger
      });
      children.push(outboxRecord);
      outboxHardKilled = true;
    }

    if (faults.apiAfterPhotos) {
      await hardKillChild(apiRecord);
      const apiIndex = children.indexOf(apiRecord);
      if (apiIndex < 0) throw new Error("Hard-killed API child was not tracked");
      children.splice(apiIndex, 1);
      apiRecord = await startChild({ role: "api", entry: API_ENTRY, environment: config.environment, logger });
      children.push(apiRecord);
      const recoveredAuth = await request(config.apiOrigin, "/api/auth/session", { cookie });
      if (recoveredAuth.body?.authenticated !== true) throw new Error("Rehearsal session did not survive the API hard-kill");
      faultCheckpoints.api = { sessionRecovered: true };
      apiHardKilled = true;
    }

    const confirmationView = await waitForProject({
      apiOrigin: config.apiOrigin,
      projectId,
      cookie,
      predicate: (view) => view?.characterCandidates?.canConfirm === true
    });
    const frontMasterRevisionId = confirmationView.characterCandidates.front?.id;
    const sideMasterRevisionId = confirmationView.characterCandidates.side?.id;
    if (!frontMasterRevisionId || !sideMasterRevisionId) throw new Error("Rehearsal character masters are incomplete");
    await request(config.apiOrigin, `/api/projects/${encodeURIComponent(projectId)}/character/confirm`, {
      method: "POST",
      cookie,
      expectedStatus: 202,
      body: { frontMasterRevisionId, sideMasterRevisionId }
    });

    if (faults.workerActiveLease) {
      const runLookup = createPostgresDatabase({ environment: config.environment, logger });
      try {
        const runRows = await runLookup.query("SELECT id FROM production_run WHERE project_id = $1", [projectId]);
        const runId = runRows.rows[0]?.id;
        if (!runId) throw new Error("Rehearsal run ID is unavailable at active-lease checkpoint");
        faultCheckpoints.worker = await waitForActiveVideoPollLease({ database: runLookup, runId });
      } finally {
        await runLookup.close();
      }
      await hardKillChild(workerRecord);
      const workerIndex = children.indexOf(workerRecord);
      if (workerIndex < 0) throw new Error("Hard-killed worker child was not tracked");
      children.splice(workerIndex, 1);
      workerRecord = await startChild({
        role: "worker",
        entry: WORKER_ENTRY,
        environment: { ...config.environment, PETPACK_REHEARSAL_VIDEO_POLL_HOLD_MS: "0" },
        logger
      });
      children.push(workerRecord);
      workerRestarted = true;
      workerHardKilled = true;
    } else if (restartWorker) {
      const runLookup = createPostgresDatabase({ environment: config.environment, logger });
      try {
        const runRows = await runLookup.query("SELECT id FROM production_run WHERE project_id = $1", [projectId]);
        const runId = runRows.rows[0]?.id;
        if (!runId) throw new Error("Rehearsal run ID is unavailable at restart checkpoint");
        await waitForVideoSubmissions({ database: runLookup, runId });
      } finally {
        await runLookup.close();
      }
      await stopChild(workerRecord);
      children.splice(children.indexOf(workerRecord), 1);
      workerRecord = await startChild({ role: "worker", entry: WORKER_ENTRY, environment: config.environment, logger });
      children.push(workerRecord);
      workerRestarted = true;
    }

    await waitForProject({
      apiOrigin: config.apiOrigin,
      projectId,
      cookie,
      predicate: (view) => view?.downloadReady === true,
      timeoutMs: faults.workerActiveLease ? 240_000 : 180_000
    });
    const download = await request(config.apiOrigin, `/api/projects/${encodeURIComponent(projectId)}/petpack-download`, {
      method: "POST",
      cookie,
      body: {}
    });
    const downloadResponse = await fetch(download.body.downloadUrl);
    if (!downloadResponse.ok) throw new Error(`Rehearsal PetPack download failed with ${downloadResponse.status}`);
    const petpackBytes = Buffer.from(await downloadResponse.arrayBuffer());
    const archive = await verifyPetpackArchive(petpackBytes);
    await fsp.writeFile(config.petpackPath, petpackBytes, { flag: "wx" });
    const clientImport = await importPetpack(config.petpackPath, config.clientImportRoot);
    if (!clientImport.ok) throw new Error(`Desktop client rejected the rehearsal PetPack: ${clientImport.error || "unknown error"}`);

    const reportDatabase = createPostgresDatabase({ environment: config.environment, logger });
    let databaseReport;
    let outboxFaultEvidence;
    try {
      databaseReport = await waitForFinalDatabaseContract({
        database: reportDatabase,
        projectId,
        timeoutMs: faults.workerActiveLease ? 60_000 : 30_000
      });
      outboxFaultEvidence = await collectOutboxFaultEvidence(reportDatabase, faultCheckpoints.outbox);
    } finally {
      await reportDatabase.close();
    }
    const audit = await readAudit(config.environment.PETPACK_REHEARSAL_AUDIT_FILE);
    const externalCalls = audit.filter((entry) => entry.external !== false);
    const fixtureEvents = Object.fromEntries(
      [...new Set(audit.map((entry) => entry.event))].sort().map((event) => [event, audit.filter((entry) => entry.event === event).length])
    );
    if (outboxFaultEvidence) {
      const preKillEvidence = faultCheckpoints.outbox?.database;
      outboxFaultEvidence = Object.freeze({
        ...outboxFaultEvidence,
        preKillStatus: preKillEvidence?.status,
        preKillAttempts: preKillEvidence?.attempts,
        preKillHasLeaseToken: preKillEvidence?.hasLeaseToken,
        preKillDedupeKey: preKillEvidence?.dedupeKey,
        preKillPayloadJobId: preKillEvidence?.payloadJobId,
        frontProviderCalls: audit.filter((entry) =>
          entry.event === "fixture.seedream" && entry.kind === "front" &&
          entry.requestId === outboxFaultEvidence.providerRequestId
        ).length
      });
    }
    const report = {
      rehearsalId: config.rehearsalId,
      completedAt: new Date().toISOString(),
      zeroCost: true,
      externalCallCount: externalCalls.length,
      workerRestarted,
      faultInjection: {
        apiHardKilled,
        outboxHardKilled,
        outboxAfterClaimHardKilled: outboxHardKilled && faults.outboxAfterClaim,
        outboxAfterEnqueueHardKilled: outboxHardKilled && faults.outboxAfterEnqueue,
        workerHardKilled,
        checkpoints: faultCheckpoints,
        outboxReplayEvidence: outboxFaultEvidence || null
      },
      projectId,
      orderId,
      workflow: {
        sourcePhotos: Number(databaseReport.run.confirmed_source_photos),
        passedMasters: Number(databaseReport.run.passed_masters),
        passedActions: Number(databaseReport.run.passed_actions),
        passedQaReports: Number(databaseReport.run.passed_qa_reports),
        failedQaReports: Number(databaseReport.run.failed_qa_reports),
        totalExecutions: Number(databaseReport.run.total_executions),
        succeededExecutions: Number(databaseReport.run.succeeded_executions),
        incompleteExecutions: Number(databaseReport.run.incomplete_executions),
        totalOutboxJobs: Number(databaseReport.run.total_outbox_jobs),
        sentOutboxJobs: Number(databaseReport.run.sent_outbox_jobs),
        runState: databaseReport.run.state,
        failureCode: databaseReport.run.failure_code,
        unsentOutboxJobs: Number(databaseReport.run.unsent_outbox),
        fixtureUsageAttempts: Number(databaseReport.run.fixture_usage_attempts)
      },
      delivery: {
        status: databaseReport.delivery.status,
        sha256: sha256(petpackBytes),
        byteSize: petpackBytes.length,
        archiveFileCount: archive.fileNames.length,
        packageId: archive.manifest.packageId,
        clientImport: {
          ok: true,
          packageId: clientImport.packageId,
          fileCount: clientImport.fileCount
        }
      },
      fixtureEvents,
      artifacts: { petpackPath: config.petpackPath, reportPath: config.reportPath }
    };
    if (report.externalCallCount !== 0 || report.workflow.sourcePhotos !== 3 || report.workflow.passedMasters !== 3 ||
        report.workflow.passedActions !== 7 || report.workflow.passedQaReports !== 12 || report.workflow.failedQaReports !== 0 ||
        report.workflow.totalExecutions !== 38 || report.workflow.succeededExecutions !== 38 || report.workflow.incompleteExecutions !== 0 ||
        report.workflow.totalOutboxJobs !== 39 || report.workflow.sentOutboxJobs !== 39 || report.workflow.unsentOutboxJobs !== 0 ||
         report.workflow.fixtureUsageAttempts !== 10 || report.workflow.runState !== "deliverable" || report.delivery.status !== "ready" ||
         report.delivery.clientImport.packageId !== report.delivery.packageId || report.delivery.clientImport.fileCount !== report.delivery.archiveFileCount ||
         (faults.apiAfterPhotos && !report.faultInjection.apiHardKilled) ||
         (faults.outboxAfterClaim && (!report.faultInjection.outboxHardKilled ||
           !hasExactOutboxReplayEvidence(report.faultInjection.outboxReplayEvidence))) ||
         (faults.outboxAfterEnqueue && (!report.faultInjection.outboxAfterEnqueueHardKilled ||
           !hasExactOutboxReplayEvidence(report.faultInjection.outboxReplayEvidence))) ||
         (faults.workerActiveLease && !report.faultInjection.workerHardKilled)) {
      throw Object.assign(new Error("Zero-cost rehearsal completed with an invalid final contract"), { report });
    }
    await fsp.writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    logger.info?.("petpack.zero_cost.completed", {
      rehearsalId: config.rehearsalId,
      externalCallCount: 0,
      workerRestarted,
      reportPath: config.reportPath,
      petpackPath: config.petpackPath
    });
    return report;
  } finally {
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    if (!database.closed) await database.close().catch(() => undefined);
    await stopAll();
  }
}

if (require.main === module) {
  const hardKillAll = process.env.PETPACK_REHEARSAL_HARD_KILL_ALL === "true";
  const hardKillPostEnqueue = process.env.PETPACK_REHEARSAL_HARD_KILL_OUTBOX_AFTER_ENQUEUE === "true";
  if (hardKillAll && hardKillPostEnqueue) throw new Error("Only one rehearsal hard-kill mode may be enabled");
  runZeroCostRehearsal({
    restartWorker: hardKillAll || hardKillPostEnqueue ? false : process.env.PETPACK_REHEARSAL_RESTART_WORKER !== "false",
    faultPlan: hardKillAll
      ? { apiAfterPhotos: true, outboxAfterClaim: true, workerActiveLease: true }
      : hardKillPostEnqueue
        ? { outboxAfterEnqueue: true }
        : undefined
  }).then((report) => {
    console.log(JSON.stringify({
      ok: true,
      rehearsalId: report.rehearsalId,
      externalCallCount: report.externalCallCount,
      workerRestarted: report.workerRestarted,
      faultInjection: report.faultInjection,
      reportPath: report.artifacts.reportPath,
      petpackPath: report.artifacts.petpackPath
    }));
  }).catch((error) => {
    console.error("petpack.zero_cost.rehearsal_failed", safeStartupFailure(error));
    process.exitCode = 1;
  });
}

module.exports = {
  CHILD_ENTRY_BY_ROLE,
  collectDatabaseReport,
  collectOutboxCheckpointEvidence,
  collectOutboxFaultEvidence,
  createRehearsalEnvironment,
  hardKillChild,
  hasExactOutboxReplayEvidence,
  hasFinalDatabaseContract,
  normalizeFaultPlan,
  readAudit,
  requireOwnedChildRecord,
  request,
  runZeroCostRehearsal,
  sha256,
  startChild,
  stopChild,
  uniqueRehearsalId,
  waitForActiveVideoPollLease,
  waitForChildCheckpoint,
  waitForFinalDatabaseContract,
  waitForProject,
  waitForVideoSubmissions
};
