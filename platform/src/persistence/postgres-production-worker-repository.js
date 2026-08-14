const crypto = require("node:crypto");

const { assertActionId } = require("../domain/action-catalog");
const { PROVIDER_OPERATIONS } = require("../domain/provider-cost-accounting");
const { PRODUCTION_STATES } = require("../domain/production-state-machine");
const { assertPositiveByteSize, assertPrivateObjectKey, normalizeSha256 } = require("../storage/private-object-store");
const { JOB_NAMES } = require("../workflow/production-workflow");
const { recordUsageAttempt, recordUsageOutcome } = require("./provider-usage-ledger");

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function") {
    throw new Error("A PostgreSQL transaction runner is required");
  }
  return database;
}

function requireQuery(transaction) {
  if (!transaction || typeof transaction.query !== "function") {
    throw new Error("A PostgreSQL transaction query interface is required");
  }
  return transaction;
}

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function rows(result) {
  return Array.isArray(result && result.rows) ? result.rows : [];
}

function oneRow(result, message) {
  const found = rows(result);
  if (found.length !== 1) throw new Error(message);
  return found[0];
}

function parseJsonObject(value, label) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error(`${label} is invalid JSON`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed;
}

function normalizeErrorCode(value, fallback) {
  if (typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) return value.toLowerCase();
  return fallback;
}

function normalizeClaimInput({ jobId, runId, actionId, maxAttempts, leaseSeconds, leaseOwner } = {}) {
  const normalizedActionId = requiredString(actionId, "Action ID", 64);
  assertActionId(normalizedActionId);
  return {
    jobId: requiredString(jobId, "Queue job ID"),
    runId: requiredString(runId, "Production run ID", 128),
    actionId: normalizedActionId,
    maxAttempts: positiveInteger(maxAttempts, "Maximum attempts", 100),
    leaseSeconds: positiveInteger(leaseSeconds, "Execution lease seconds", 3600),
    leaseOwner: requiredString(leaseOwner, "Execution lease owner", 256)
  };
}

function assertActionWorkflowJob(job, { expectedName, runId, actionId } = {}) {
  if (!job || job.name !== expectedName || job.dedupeKey !== job.options?.jobId) {
    throw new Error("A deterministic action workflow job is required");
  }
  if (!job.data || job.data.runId !== runId || job.data.actionId !== actionId) {
    throw new Error("Action workflow job ownership does not match its production action");
  }
  if (Object.keys(job.data).some((key) => !["runId", "actionId"].includes(key))) {
    throw new Error("Action workflow job payload may contain only server-side IDs");
  }
  if (!Number.isInteger(job.options?.attempts) || job.options.attempts < 1) {
    throw new Error("Action workflow job requires a positive attempt limit");
  }
  return job;
}

function normalizeDelaySeconds(value) {
  return positiveInteger(value, "Outbox delay seconds", 3600);
}

function normalizeArchivedArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") throw new Error("Archived provider output metadata is required");
  if (typeof artifact.contentType !== "string" || !artifact.contentType.trim() || artifact.contentType.length > 256) {
    throw new Error("Archived provider output content type is required");
  }
  return {
    objectKey: assertPrivateObjectKey(artifact.objectKey),
    sha256: normalizeSha256(artifact.sha256, "Archived provider output checksum"),
    byteSize: assertPositiveByteSize(Number(artifact.byteSize), "Archived provider output byte size"),
    contentType: artifact.contentType.trim()
  };
}

function normalizeProcessedArtifact(artifact) {
  const normalized = normalizeArchivedArtifact(artifact);
  if (normalized.contentType !== "video/webm") {
    throw new Error("Processed action media must use the video/webm content type");
  }
  return normalized;
}

function normalizeQaPayload(report, expectedOk) {
  if (!report || typeof report !== "object" || Array.isArray(report) || report.ok !== expectedOk) {
    throw new Error(`Action QA report must record ok=${expectedOk}`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(report);
  } catch {
    throw new Error("Action QA report must be JSON serializable");
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
    throw new Error("Action QA report exceeds the persistence limit");
  }
  return { report: JSON.parse(serialized), serialized };
}

function normalizePolicyVersion(value) {
  return requiredString(value, "Action QA policy version", 128);
}

function normalizeDuration(value, label) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) {
    throw new Error(`${label} is invalid`);
  }
  return duration;
}

function normalizeReferenceMetrics(report) {
  const payload = parseJsonObject(report, "Master-frame QA report");
  const metrics = payload.referenceMetrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error("Master-frame QA report has no immutable reference metrics");
  }
  const required = ["groundBaselineY", "torsoHeightPx", "headHeightPx", "shoulderWidthPx", "centerX"];
  const normalized = {};
  for (const key of required) {
    const value = Number(metrics[key]);
    if (!Number.isFinite(value)) throw new Error(`Master-frame reference metric ${key} is invalid`);
    normalized[key] = value;
  }
  return normalized;
}

function mapVideoSubmission(row, { leaseToken, attempt }) {
  const modelReference = parseJsonObject(row.model_reference, "Video model reference");
  if (!["480p", "720p"].includes(modelReference.resolution) || typeof modelReference.endpointId !== "string" || !modelReference.endpointId) {
    throw new Error("Video action has no immutable 480p or 720p ModelArk reference");
  }
  const duration = Number(row.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Video action prompt duration is invalid");
  return {
    outcome: "claimed",
    jobId: row.job_id,
    runId: row.run_id,
    projectId: row.project_id,
    orderId: row.order_id,
    actionId: row.action_id,
    leaseToken,
    attempt,
    providerRequestId: row.provider_request_id || null,
    providerTaskId: row.provider_task_id || null,
    firstFrameObjectKey: row.first_frame_object_key,
    lastFrameObjectKey: row.last_frame_object_key,
    modelReference,
    promptVersion: {
      id: row.prompt_version_id,
      actionId: row.action_id,
      version: row.prompt_version_label,
      status: row.prompt_status,
      prompt: row.prompt,
      negativePrompt: row.negative_prompt || "",
      resolution: row.prompt_resolution,
      duration,
      frozenForRun: true
    }
  };
}

/**
 * Server-only persistence for ModelArk job execution. A queue delivery first
 * receives a short PostgreSQL lease. Provider submission intent is persisted
 * before the external request, preventing a transport timeout from causing a
 * blind duplicate Seedance submission.
 */
class PostgresProductionWorkerRepository {
  constructor({ database, idFactory = crypto.randomUUID, logger = console } = {}) {
    this.database = requireDatabase(database);
    if (typeof idFactory !== "function") throw new Error("A UUID ID factory is required");
    this.idFactory = idFactory;
    this.logger = logger;
  }

  async _insertDelayedOutbox(tx, job, delaySeconds) {
    const delay = normalizeDelaySeconds(delaySeconds);
    await tx.query(
      `INSERT INTO outbox_job
        (id, aggregate_type, aggregate_id, job_name, payload, dedupe_key, status, available_at)
       VALUES ($1, 'production_run', $2, $3, $4::jsonb, $5, 'pending', now() + ($6 * interval '1 second'))
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        this.idFactory(),
        job.data.runId,
        job.name,
        JSON.stringify({ name: job.name, data: job.data, options: job.options }),
        job.dedupeKey,
        delay
      ]
    );
  }

  async claimVideoSubmission(input = {}) {
    const claim = normalizeClaimInput(input);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await tx.query(
        `INSERT INTO production_job_execution
          (id, job_id, job_name, run_id, action_id, status, attempts, max_attempts)
         VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6)
         ON CONFLICT (job_id) DO NOTHING`,
        [this.idFactory(), claim.jobId, JOB_NAMES.GENERATE_VIDEO, claim.runId, claim.actionId, claim.maxAttempts]
      );
      const row = oneRow(await tx.query(
        `SELECT execution.id AS execution_id,
                execution.job_id,
                execution.job_name,
                execution.run_id AS execution_run_id,
                execution.action_id AS execution_action_id,
                execution.status AS execution_status,
                execution.attempts,
                execution.max_attempts,
                (execution.status = 'leased' AND execution.leased_until > now()) AS lease_active,
                run.id AS run_id,
                run.project_id,
                run.order_id,
                run.state AS run_state,
                action.action_id,
                action.state AS action_state,
                action.provider_request_id,
                action.provider_task_id,
                action.prompt_version_id,
                action.prompt_version_label,
                action.model_reference,
                action.first_frame_object_key,
                action.last_frame_object_key,
                prompt.status AS prompt_status,
                prompt.prompt,
                prompt.negative_prompt,
                prompt.resolution AS prompt_resolution,
                prompt.duration
           FROM production_job_execution execution
           JOIN production_run run ON run.id = execution.run_id
           JOIN generation_action action
             ON action.run_id = run.id
            AND action.action_id = execution.action_id
           JOIN prompt_version prompt
             ON prompt.id = action.prompt_version_id
            AND prompt.version = action.prompt_version_label
            AND prompt.published_at IS NOT NULL
           JOIN prompt_template template
             ON template.id = prompt.template_id
            AND template.action_id = action.action_id
          WHERE execution.job_id = $1
          FOR UPDATE OF execution, action`,
        [claim.jobId]
      ), "Video generation execution or immutable action snapshot was not found");

      if (row.job_name !== JOB_NAMES.GENERATE_VIDEO || row.execution_run_id !== claim.runId || row.execution_action_id !== claim.actionId) {
        throw new Error("Queue job ID is already bound to a different production action");
      }
      if (Number(row.max_attempts) !== claim.maxAttempts) {
        throw new Error("Queue job retry policy changed after execution was created");
      }
      if (row.provider_task_id || ["succeeded", "processed", "qa_passed"].includes(row.action_state)) {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, completed_at = COALESCE(completed_at, now()), updated_at = now()
            WHERE id = $1`,
          [row.execution_id]
        );
        return { outcome: row.action_state === "qa_passed" ? "already_completed" : "already_submitted", runId: claim.runId, actionId: claim.actionId };
      }
      if (row.execution_status === "reconciliation_required" || row.provider_request_id) {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'reconciliation_required', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, updated_at = now()
            WHERE id = $1`,
          [row.execution_id]
        );
        return { outcome: "reconciliation_required", runId: claim.runId, actionId: claim.actionId };
      }
      if (row.execution_status === "dead") {
        return { outcome: "dead", runId: claim.runId, actionId: claim.actionId };
      }
      if (row.lease_active) {
        return { outcome: "busy", runId: claim.runId, actionId: claim.actionId };
      }
      if (row.run_state !== PRODUCTION_STATES.VIDEO_GENERATING || !["queued", "failed"].includes(row.action_state)) {
        throw new Error("Video action is not in a submittable production state");
      }
      const previousAttempts = Number(row.attempts);
      if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0) throw new Error("Video execution attempt count is invalid");
      if (previousAttempts >= claim.maxAttempts) {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'dead', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, updated_at = now()
            WHERE id = $1`,
          [row.execution_id]
        );
        await tx.query(
          `UPDATE generation_action SET state = 'failed', updated_at = now()
            WHERE run_id = $1 AND action_id = $2 AND provider_task_id IS NULL`,
          [claim.runId, claim.actionId]
        );
        return { outcome: "dead", runId: claim.runId, actionId: claim.actionId };
      }

      const leaseToken = this.idFactory();
      const attempt = previousAttempts + 1;
      const leased = rows(await tx.query(
        `UPDATE production_job_execution
            SET status = 'leased', attempts = $2, lease_token = $3, lease_owner = $4,
                leased_until = now() + ($5 * interval '1 second'), last_error_code = NULL,
                updated_at = now()
          WHERE id = $1
        RETURNING id`,
        [row.execution_id, attempt, leaseToken, claim.leaseOwner, claim.leaseSeconds]
      ));
      if (leased.length !== 1) throw new Error("Video execution lease could not be acquired");
      return mapVideoSubmission(row, { leaseToken, attempt });
    });
  }

  async prepareVideoSubmission({ jobId, leaseToken, providerRequestId } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeRequestId = requiredString(providerRequestId, "ModelArk request ID", 256);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const updated = rows(await tx.query(
        `UPDATE generation_action action
            SET state = 'running',
                provider_request_id = $3,
                retry_count = GREATEST(action.retry_count, execution.attempts - 1),
                updated_at = now()
           FROM production_job_execution execution, production_run run, prompt_version prompt
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND run.id = execution.run_id
            AND action.run_id = execution.run_id
            AND action.action_id = execution.action_id
            AND prompt.id = action.prompt_version_id
            AND prompt.version = action.prompt_version_label
            AND action.provider_task_id IS NULL
            AND (action.provider_request_id IS NULL OR action.provider_request_id = $3)
        RETURNING action.id AS generation_action_id, action.run_id, action.action_id,
                  action.provider_request_id, action.model_reference,
                  execution.attempts AS worker_attempt, run.project_id, run.order_id,
                  prompt.resolution, prompt.duration AS requested_duration_seconds`,
        [safeJobId, safeLeaseToken, safeRequestId]
      ));
      if (updated.length !== 1) {
        throw new Error("Video submission intent could not be persisted under the active lease");
      }
      await recordUsageAttempt(tx, this.idFactory, {
        internalRequestId: safeRequestId,
        projectId: updated[0].project_id,
        orderId: updated[0].order_id,
        runId: updated[0].run_id,
        generationActionId: updated[0].generation_action_id,
        actionId: updated[0].action_id,
        operation: PROVIDER_OPERATIONS.SEEDANCE_VIDEO,
        workerAttempt: Number(updated[0].worker_attempt),
        modelReference: updated[0].model_reference,
        resolution: updated[0].resolution,
        requestedDurationSeconds: updated[0].requested_duration_seconds,
        requestedOutputCount: 1
      });
      return { providerRequestId: updated[0].provider_request_id };
    });
  }

  async completeVideoSubmission({ jobId, leaseToken, providerRequestId, providerTaskId, pollJob, pollDelaySeconds = 15 } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeRequestId = requiredString(providerRequestId, "ModelArk request ID", 256);
    const safeTaskId = requiredString(providerTaskId, "ModelArk task ID", 512);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const action = rows(await tx.query(
        `UPDATE generation_action action
            SET provider_task_id = COALESCE(action.provider_task_id, $4),
                state = 'running', updated_at = now()
           FROM production_job_execution execution
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND action.run_id = execution.run_id
            AND action.action_id = execution.action_id
            AND action.provider_request_id = $3
            AND (action.provider_task_id IS NULL OR action.provider_task_id = $4)
        RETURNING action.run_id, action.action_id`,
        [safeJobId, safeLeaseToken, safeRequestId, safeTaskId]
      ));
      if (action.length !== 1) throw new Error("ModelArk task could not be bound to its leased video action");
      await recordUsageOutcome(tx, this.idFactory, {
        internalRequestId: safeRequestId,
        eventType: "provider_accepted",
        providerTaskId: safeTaskId
      });
      const safePollJob = assertActionWorkflowJob(pollJob, {
        expectedName: JOB_NAMES.POLL_VIDEO,
        runId: action[0].run_id,
        actionId: action[0].action_id
      });
      await this._insertDelayedOutbox(tx, safePollJob, pollDelaySeconds);
      const execution = rows(await tx.query(
        `UPDATE production_job_execution
            SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
                leased_until = NULL, completed_at = now(), updated_at = now()
          WHERE job_id = $1 AND lease_token = $2::uuid AND status = 'leased'
        RETURNING id`,
        [safeJobId, safeLeaseToken]
      ));
      if (execution.length !== 1) throw new Error("Video submission execution could not be completed");
      return { runId: action[0].run_id, actionId: action[0].action_id };
    });
  }

  async claimVideoPoll(input = {}) {
    const claim = normalizeClaimInput(input);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await tx.query(
        `INSERT INTO production_job_execution
          (id, job_id, job_name, run_id, action_id, status, attempts, max_attempts)
         VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6)
         ON CONFLICT (job_id) DO NOTHING`,
        [this.idFactory(), claim.jobId, JOB_NAMES.POLL_VIDEO, claim.runId, claim.actionId, claim.maxAttempts]
      );
      const row = oneRow(await tx.query(
        `SELECT execution.id AS execution_id,
                execution.job_name,
                execution.run_id AS execution_run_id,
                execution.action_id AS execution_action_id,
                execution.status AS execution_status,
                execution.attempts,
                execution.max_attempts,
                (execution.status = 'leased' AND execution.leased_until > now()) AS lease_active,
                run.id AS run_id,
                run.project_id,
                run.order_id,
                run.state AS run_state,
                action.action_id,
                action.state AS action_state,
                action.provider_task_id,
                action.provider_poll_count
           FROM production_job_execution execution
           JOIN production_run run ON run.id = execution.run_id
           JOIN generation_action action
             ON action.run_id = run.id
            AND action.action_id = execution.action_id
          WHERE execution.job_id = $1
          FOR UPDATE OF execution, action`,
        [claim.jobId]
      ), "Video polling execution or action was not found");
      if (row.job_name !== JOB_NAMES.POLL_VIDEO || row.execution_run_id !== claim.runId || row.execution_action_id !== claim.actionId) {
        throw new Error("Queue poll job ID is already bound to a different production action");
      }
      if (Number(row.max_attempts) !== claim.maxAttempts) throw new Error("Queue poll retry policy changed after execution was created");
      if (["succeeded", "processed", "qa_passed"].includes(row.action_state)) {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, completed_at = COALESCE(completed_at, now()), updated_at = now()
            WHERE id = $1`,
          [row.execution_id]
        );
        return { outcome: "already_completed", runId: claim.runId, actionId: claim.actionId };
      }
      if (row.execution_status === "succeeded") {
        return { outcome: "already_polled", runId: claim.runId, actionId: claim.actionId };
      }
      if (row.execution_status === "reconciliation_required") return { outcome: "reconciliation_required", runId: claim.runId, actionId: claim.actionId };
      if (row.execution_status === "dead" || row.action_state === "failed") {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'dead', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, updated_at = now()
            WHERE id = $1`,
          [row.execution_id]
        );
        return { outcome: "dead", runId: claim.runId, actionId: claim.actionId };
      }
      if (row.lease_active) return { outcome: "busy", runId: claim.runId, actionId: claim.actionId };
      if (row.run_state !== PRODUCTION_STATES.VIDEO_GENERATING || row.action_state !== "running" || !row.provider_task_id) {
        throw new Error("Video action is not ready for authoritative provider polling");
      }
      const previousAttempts = Number(row.attempts);
      if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0) throw new Error("Video poll attempt count is invalid");
      if (previousAttempts >= claim.maxAttempts) {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'dead', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, updated_at = now()
            WHERE id = $1`,
          [row.execution_id]
        );
        await tx.query(
          `UPDATE generation_action SET state = 'failed', updated_at = now()
            WHERE run_id = $1 AND action_id = $2 AND state = 'running'`,
          [claim.runId, claim.actionId]
        );
        return { outcome: "dead", runId: claim.runId, actionId: claim.actionId };
      }
      const leaseToken = this.idFactory();
      const attempt = previousAttempts + 1;
      const leased = rows(await tx.query(
        `UPDATE production_job_execution
            SET status = 'leased', attempts = $2, lease_token = $3, lease_owner = $4,
                leased_until = now() + ($5 * interval '1 second'), last_error_code = NULL,
                updated_at = now()
          WHERE id = $1
        RETURNING id`,
        [row.execution_id, attempt, leaseToken, claim.leaseOwner, claim.leaseSeconds]
      ));
      if (leased.length !== 1) throw new Error("Video poll execution lease could not be acquired");
      return {
        outcome: "claimed",
        runId: row.run_id,
        projectId: row.project_id,
        orderId: row.order_id,
        actionId: row.action_id,
        providerTaskId: row.provider_task_id,
        pollCount: Number(row.provider_poll_count || 0),
        attempt,
        leaseToken
      };
    });
  }

  async completeVideoPollPending({ jobId, leaseToken, expectedPollCount, nextPollJob, pollDelaySeconds = 15 } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    if (!Number.isSafeInteger(expectedPollCount) || expectedPollCount < 0) throw new Error("Expected provider poll count is invalid");
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const action = rows(await tx.query(
        `UPDATE generation_action action
            SET provider_poll_count = provider_poll_count + 1, updated_at = now()
           FROM production_job_execution execution
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND action.run_id = execution.run_id
            AND action.action_id = execution.action_id
            AND action.state = 'running'
            AND action.provider_task_id IS NOT NULL
            AND action.provider_poll_count = $3
        RETURNING action.run_id, action.action_id, action.provider_poll_count`,
        [safeJobId, safeLeaseToken, expectedPollCount]
      ));
      if (action.length !== 1) throw new Error("Pending ModelArk task changed before its next poll could be scheduled");
      const safeNextJob = assertActionWorkflowJob(nextPollJob, {
        expectedName: JOB_NAMES.POLL_VIDEO,
        runId: action[0].run_id,
        actionId: action[0].action_id
      });
      await this._insertDelayedOutbox(tx, safeNextJob, pollDelaySeconds);
      const execution = rows(await tx.query(
        `UPDATE production_job_execution
            SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
                leased_until = NULL, completed_at = now(), updated_at = now()
          WHERE job_id = $1 AND lease_token = $2::uuid AND status = 'leased'
        RETURNING id`,
        [safeJobId, safeLeaseToken]
      ));
      if (execution.length !== 1) throw new Error("Video poll execution could not be completed");
      return { pollCount: Number(action[0].provider_poll_count) };
    });
  }

  async markVideoProviderOutputSucceeded({ jobId, leaseToken, providerTaskId } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeTaskId = requiredString(providerTaskId, "ModelArk task ID", 512);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const binding = oneRow(await tx.query(
        `SELECT action.provider_request_id
           FROM production_job_execution execution
           JOIN generation_action action
             ON action.run_id = execution.run_id
            AND action.action_id = execution.action_id
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND action.state = 'running'
            AND action.provider_task_id = $3
          FOR UPDATE OF execution, action`,
        [safeJobId, safeLeaseToken, safeTaskId]
      ), "Successful ModelArk output is not bound to the active poll execution");
      await recordUsageOutcome(tx, this.idFactory, {
        internalRequestId: binding.provider_request_id,
        eventType: "output_succeeded",
        outputCount: 1
      });
      return { providerTaskBound: true };
    });
  }

  async completeVideoPollSuccess({ jobId, leaseToken, providerTaskId, artifact, processJob } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeTaskId = requiredString(providerTaskId, "ModelArk task ID", 512);
    const safeArtifact = normalizeArchivedArtifact(artifact);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const binding = oneRow(await tx.query(
        `SELECT execution.id AS execution_id,
                run.id AS run_id,
                run.project_id,
                action.action_id,
                action.provider_request_id
           FROM production_job_execution execution
           JOIN production_run run ON run.id = execution.run_id
           JOIN generation_action action
             ON action.run_id = run.id
            AND action.action_id = execution.action_id
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND action.state = 'running'
            AND action.provider_task_id = $3
          FOR UPDATE OF execution, action`,
        [safeJobId, safeLeaseToken, safeTaskId]
      ), "Successful ModelArk output no longer matches its leased action");
      const media = rows(await tx.query(
        `INSERT INTO media_asset
          (id, project_id, run_id, kind, object_key, sha256, content_type, byte_size)
         VALUES ($1, $2, $3, 'provider_output', $4, $5, $6, $7)
         ON CONFLICT (object_key) DO UPDATE SET object_key = EXCLUDED.object_key
           WHERE media_asset.project_id = EXCLUDED.project_id
             AND media_asset.run_id = EXCLUDED.run_id
             AND media_asset.kind = 'provider_output'
             AND media_asset.sha256 = EXCLUDED.sha256
             AND media_asset.content_type = EXCLUDED.content_type
             AND media_asset.byte_size = EXCLUDED.byte_size
         RETURNING id`,
        [this.idFactory(), binding.project_id, binding.run_id, safeArtifact.objectKey, safeArtifact.sha256, safeArtifact.contentType, safeArtifact.byteSize]
      ));
      if (media.length !== 1) throw new Error("Archived provider output conflicts with an existing private media asset");
      const action = rows(await tx.query(
        `UPDATE generation_action
            SET state = 'succeeded', provider_output_asset_id = $4, updated_at = now()
          WHERE run_id = $1 AND action_id = $2 AND provider_task_id = $3 AND state = 'running'
        RETURNING run_id, action_id`,
        [binding.run_id, binding.action_id, safeTaskId, media[0].id]
      ));
      if (action.length !== 1) throw new Error("Archived provider output could not complete its generation action");
      const safeProcessJob = assertActionWorkflowJob(processJob, {
        expectedName: JOB_NAMES.PROCESS_VIDEO_ACTION,
        runId: binding.run_id,
        actionId: binding.action_id
      });
      await this._insertDelayedOutbox(tx, safeProcessJob, 1);
      const execution = rows(await tx.query(
        `UPDATE production_job_execution
            SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
                leased_until = NULL, completed_at = now(), updated_at = now()
          WHERE id = $1 AND lease_token = $2::uuid AND status = 'leased'
        RETURNING id`,
        [binding.execution_id, safeLeaseToken]
      ));
      if (execution.length !== 1) throw new Error("Successful video poll execution could not be completed");
      return { runId: binding.run_id, actionId: binding.action_id, mediaAssetId: media[0].id };
    });
  }

  async claimVideoProcessing(input = {}) {
    const claim = normalizeClaimInput(input);
    const jobName = input.jobName === undefined ? JOB_NAMES.PROCESS_VIDEO_ACTION : input.jobName;
    if (![JOB_NAMES.PROCESS_VIDEO_ACTION, JOB_NAMES.FINALIZE_VIDEO_ACTION].includes(jobName)) {
      throw new Error("Unsupported video processing job name");
    }
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await tx.query(
        `INSERT INTO production_job_execution
          (id, job_id, job_name, run_id, action_id, status, attempts, max_attempts)
         VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6)
         ON CONFLICT (job_id) DO NOTHING`,
        [this.idFactory(), claim.jobId, jobName, claim.runId, claim.actionId, claim.maxAttempts]
      );
      const row = oneRow(await tx.query(
        `SELECT execution.id AS execution_id,
                execution.job_name,
                execution.run_id AS execution_run_id,
                execution.action_id AS execution_action_id,
                execution.status AS execution_status,
                execution.attempts,
                execution.max_attempts,
                (execution.status = 'leased' AND execution.leased_until > now()) AS lease_active,
                run.id AS run_id,
                run.project_id,
                run.order_id,
                run.state AS run_state,
                run.version AS run_version,
                action.action_id,
                action.state AS action_state,
                action.provider_task_id,
                action.provider_output_asset_id,
                action.media_asset_id,
                action.qa_report_id,
                action.processing_policy_version,
                action.processor_version,
                processing_prompt.duration AS requested_duration,
                source.object_key AS source_object_key,
                source.sha256 AS source_sha256,
                source.byte_size AS source_byte_size,
                first_master.object_key AS first_master_object_key,
                first_master.sha256 AS first_master_sha256,
                first_master.byte_size AS first_master_byte_size,
                last_master.object_key AS last_master_object_key,
                last_master.sha256 AS last_master_sha256,
                last_master.byte_size AS last_master_byte_size,
                master_qa.report AS master_qa_report,
                final_asset.kind AS final_asset_kind,
                final_asset.project_id AS final_asset_project_id,
                final_asset.run_id AS final_asset_run_id,
                final_asset.content_type AS final_asset_content_type,
                final_asset.deleted_at AS final_asset_deleted_at,
                final_qa.status AS final_qa_status,
                final_qa.project_id AS final_qa_project_id,
                final_qa.run_id AS final_qa_run_id,
                final_qa.action_id AS final_qa_action_id,
                final_qa.subject_kind AS final_qa_subject_kind,
                final_qa.source_media_asset_id AS final_qa_source_asset_id,
                final_qa.subject_media_asset_id AS final_qa_subject_asset_id,
                final_qa.processor_version AS final_qa_processor_version,
                final_qa.policy_version AS final_qa_policy_version
           FROM production_job_execution execution
           JOIN production_run run ON run.id = execution.run_id
           JOIN generation_action action
             ON action.run_id = run.id
            AND action.action_id = execution.action_id
           JOIN prompt_version processing_prompt
             ON processing_prompt.id = action.prompt_version_id
            AND processing_prompt.version = action.prompt_version_label
            AND processing_prompt.published_at IS NOT NULL
           LEFT JOIN media_asset source
             ON source.id = action.provider_output_asset_id
            AND source.project_id = run.project_id
            AND source.run_id = run.id
            AND source.kind = 'provider_output'
            AND source.deleted_at IS NULL
           LEFT JOIN media_asset first_master
             ON first_master.object_key = action.first_frame_object_key
            AND first_master.project_id = run.project_id
            AND first_master.run_id = run.id
            AND first_master.kind IN ('front_master', 'sleep_master')
            AND first_master.deleted_at IS NULL
           LEFT JOIN media_asset last_master
             ON last_master.object_key = action.last_frame_object_key
            AND last_master.project_id = run.project_id
            AND last_master.run_id = run.id
            AND last_master.kind IN ('front_master', 'sleep_master')
            AND last_master.deleted_at IS NULL
            LEFT JOIN image_candidate master_candidate
              ON master_candidate.media_asset_id = first_master.id
             AND master_candidate.project_id = run.project_id
             AND master_candidate.run_id = run.id
             AND master_candidate.order_id = run.order_id
             AND master_candidate.qa_status = 'passed'
            LEFT JOIN master_image_generation master_generation
              ON master_generation.image_candidate_id = master_candidate.id
             AND master_generation.run_id = run.id
             AND master_generation.project_id = run.project_id
             AND master_generation.order_id = run.order_id
             AND master_generation.normalized_media_asset_id = first_master.id
             AND master_generation.qa_report_id = master_candidate.qa_report_id
             AND master_generation.status = 'qa_passed'
            LEFT JOIN qa_report master_qa
              ON master_qa.id = master_candidate.qa_report_id
             AND master_qa.id = master_generation.qa_report_id
             AND master_qa.project_id = run.project_id
             AND master_qa.run_id = run.id
             AND master_qa.subject_kind = 'image'
             AND master_qa.status = 'passed'
             AND master_qa.source_media_asset_id = master_generation.provider_output_asset_id
             AND master_qa.subject_media_asset_id = first_master.id
             AND master_qa.policy_version = master_generation.processing_policy_version
             AND master_qa.processor_version = master_generation.processor_version
           LEFT JOIN media_asset final_asset ON final_asset.id = action.media_asset_id
           LEFT JOIN qa_report final_qa ON final_qa.id = action.qa_report_id
          WHERE execution.job_id = $1
          FOR UPDATE OF execution, action`,
        [claim.jobId]
      ), "Video processing execution or action was not found");
      if (row.job_name !== jobName || row.execution_run_id !== claim.runId || row.execution_action_id !== claim.actionId) {
        throw new Error("Queue processing job ID is already bound to a different production action");
      }
      if (Number(row.max_attempts) !== claim.maxAttempts) throw new Error("Queue processing retry policy changed after execution was created");
      if (row.action_state === "qa_passed") {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, completed_at = COALESCE(completed_at, now()), updated_at = now()
            WHERE id = $1`,
          [row.execution_id]
        );
        return { outcome: "already_completed", runId: claim.runId, actionId: claim.actionId };
      }
      if (row.lease_active) return { outcome: "busy", runId: claim.runId, actionId: claim.actionId };
      const previousAttempts = Number(row.attempts);
      if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0) throw new Error("Video processing attempt count is invalid");
      if (row.action_state === "processed") {
        if (row.run_state !== PRODUCTION_STATES.VIDEO_GENERATING || !row.provider_task_id ||
            !row.media_asset_id || row.final_asset_kind !== "action_video" ||
            !row.processing_policy_version || !row.processor_version ||
            row.final_asset_project_id !== row.project_id || row.final_asset_run_id !== row.run_id ||
            row.final_asset_content_type !== "video/webm" || row.final_asset_deleted_at ||
            !row.qa_report_id || row.final_qa_status !== "passed" ||
            row.final_qa_project_id !== row.project_id || row.final_qa_run_id !== row.run_id ||
            row.final_qa_action_id !== row.action_id || row.final_qa_subject_kind !== "video" ||
            row.final_qa_source_asset_id !== row.provider_output_asset_id ||
            row.final_qa_subject_asset_id !== row.media_asset_id ||
            row.final_qa_processor_version !== row.processor_version ||
            row.final_qa_policy_version !== row.processing_policy_version) {
          throw new Error("Processed video action has an invalid final media or QA binding");
        }
        const leaseToken = this.idFactory();
        const finalizeAttempt = Math.max(previousAttempts, 1);
        const leased = rows(await tx.query(
          `UPDATE production_job_execution
              SET status = 'leased', attempts = $2, lease_token = $3, lease_owner = $4,
                  leased_until = now() + ($5 * interval '1 second'), last_error_code = NULL,
                  updated_at = now()
            WHERE id = $1
          RETURNING id`,
          [row.execution_id, finalizeAttempt, leaseToken, claim.leaseOwner, claim.leaseSeconds]
        ));
        if (leased.length !== 1) throw new Error("Video finalization execution lease could not be acquired");
        return {
          outcome: "finalize_pending",
          runId: row.run_id,
          projectId: row.project_id,
          orderId: row.order_id,
          run: {
            id: row.run_id,
            projectId: row.project_id,
            orderId: row.order_id,
            state: row.run_state,
            version: Number(row.run_version)
          },
          actionId: row.action_id,
          providerTaskId: row.provider_task_id,
          mediaAssetId: row.media_asset_id,
          processingPolicyVersion: row.processing_policy_version || null,
          processorVersion: row.processor_version || null,
          attempt: finalizeAttempt,
          leaseToken
        };
      }
      if (jobName === JOB_NAMES.FINALIZE_VIDEO_ACTION) {
        throw new Error("Video finalization job requires an already processed action");
      }
      if (row.execution_status === "reconciliation_required") {
        return { outcome: "reconciliation_required", runId: claim.runId, actionId: claim.actionId };
      }
      if (row.execution_status === "dead" || row.action_state === "failed") {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'dead', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, updated_at = now()
            WHERE id = $1`,
          [row.execution_id]
        );
        return { outcome: "dead", runId: claim.runId, actionId: claim.actionId };
      }
      if (row.execution_status === "succeeded") {
        throw new Error("Completed processing execution has no QA-passed action");
      }
      if (row.run_state !== PRODUCTION_STATES.VIDEO_GENERATING || row.action_state !== "succeeded") {
        throw new Error("Video action is not ready for media processing");
      }
      if (!row.provider_task_id || !row.provider_output_asset_id || !row.source_object_key || !row.source_sha256 || !row.source_byte_size) {
        throw new Error("Video action has no intact archived provider source");
      }
      if (!row.first_master_object_key || !row.first_master_sha256 || !row.first_master_byte_size ||
          !row.last_master_object_key || !row.last_master_sha256 || !row.last_master_byte_size) {
        throw new Error("Video action master-frame integrity records are unavailable");
      }
      if (previousAttempts >= claim.maxAttempts) {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'dead', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, updated_at = now()
            WHERE id = $1`,
          [row.execution_id]
        );
        await tx.query(
          `UPDATE generation_action SET state = 'failed', updated_at = now()
            WHERE run_id = $1 AND action_id = $2 AND state = 'succeeded'`,
          [claim.runId, claim.actionId]
        );
        return { outcome: "dead", runId: claim.runId, actionId: claim.actionId };
      }
      const leaseToken = this.idFactory();
      const attempt = previousAttempts + 1;
      const leased = rows(await tx.query(
        `UPDATE production_job_execution
            SET status = 'leased', attempts = $2, lease_token = $3, lease_owner = $4,
                leased_until = now() + ($5 * interval '1 second'), last_error_code = NULL,
                updated_at = now()
          WHERE id = $1
        RETURNING id`,
        [row.execution_id, attempt, leaseToken, claim.leaseOwner, claim.leaseSeconds]
      ));
      if (leased.length !== 1) throw new Error("Video processing execution lease could not be acquired");
      return {
        outcome: "claimed",
        runId: row.run_id,
        projectId: row.project_id,
        orderId: row.order_id,
        run: {
          id: row.run_id,
          projectId: row.project_id,
          orderId: row.order_id,
          state: row.run_state,
          version: Number(row.run_version)
        },
        actionId: row.action_id,
        providerTaskId: row.provider_task_id,
        sourceAssetId: row.provider_output_asset_id,
        sourceObjectKey: assertPrivateObjectKey(row.source_object_key),
        sourceSha256: normalizeSha256(row.source_sha256, "Archived provider source checksum"),
        sourceByteSize: assertPositiveByteSize(Number(row.source_byte_size), "Archived provider source byte size"),
        firstMasterObjectKey: assertPrivateObjectKey(row.first_master_object_key),
        expectedFirstMasterHash: normalizeSha256(row.first_master_sha256, "First master checksum"),
        firstMasterByteSize: assertPositiveByteSize(Number(row.first_master_byte_size), "First master byte size"),
        lastMasterObjectKey: assertPrivateObjectKey(row.last_master_object_key),
        expectedLastMasterHash: normalizeSha256(row.last_master_sha256, "Last master checksum"),
        lastMasterByteSize: assertPositiveByteSize(Number(row.last_master_byte_size), "Last master byte size"),
        referenceMetrics: normalizeReferenceMetrics(row.master_qa_report),
        requestedDuration: normalizeDuration(row.requested_duration, "Frozen action duration"),
        mediaAssetId: row.media_asset_id || null,
        processingPolicyVersion: row.processing_policy_version || null,
        processorVersion: row.processor_version || null,
        attempt,
        leaseToken
      };
    });
  }

  async bindVideoProcessingPolicy({ jobId, leaseToken, policyVersion, processorVersion } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safePolicyVersion = normalizePolicyVersion(policyVersion);
    const safeProcessorVersion = requiredString(processorVersion, "Media processor version", 128);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const bound = rows(await tx.query(
        `UPDATE generation_action action
            SET processing_policy_version = COALESCE(action.processing_policy_version, $3),
                processor_version = COALESCE(action.processor_version, $4),
                updated_at = now()
           FROM production_job_execution execution
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND execution.job_name = 'petpack.process-video-action'
            AND action.run_id = execution.run_id
            AND action.action_id = execution.action_id
            AND action.state = 'succeeded'
            AND (action.processing_policy_version IS NULL OR action.processing_policy_version = $3)
            AND (action.processor_version IS NULL OR action.processor_version = $4)
        RETURNING action.processing_policy_version, action.processor_version`,
        [safeJobId, safeLeaseToken, safePolicyVersion, safeProcessorVersion]
      ));
      if (bound.length !== 1) throw new Error("Action processing policy snapshot could not be frozen under the active lease");
      return {
        policyVersion: bound[0].processing_policy_version,
        processorVersion: bound[0].processor_version
      };
    });
  }

  async renewVideoProcessingLease({ jobId, leaseToken, leaseSeconds } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeLeaseSeconds = positiveInteger(leaseSeconds, "Execution lease seconds", 3600);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const renewed = rows(await tx.query(
        `UPDATE production_job_execution execution
            SET leased_until = now() + ($3 * interval '1 second'), updated_at = now()
           FROM generation_action action
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND execution.job_name IN ('petpack.process-video-action', 'petpack.finalize-video-action')
            AND action.run_id = execution.run_id
            AND action.action_id = execution.action_id
            AND action.state IN ('succeeded', 'processed', 'qa_passed')
        RETURNING execution.id`,
        [safeJobId, safeLeaseToken, safeLeaseSeconds]
      ));
      if (renewed.length !== 1) {
        throw Object.assign(new Error("Video processing lease was lost"), { code: "processing_lease_lost" });
      }
      return { renewed: true };
    });
  }

  async saveVideoProcessingResult({
    jobId,
    leaseToken,
    sourceAssetId,
    artifact,
    qaReport,
    policyVersion,
    processorVersion,
    finalizeJob
  } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeSourceAssetId = requiredString(sourceAssetId, "Provider source media asset ID", 128);
    const safeArtifact = normalizeProcessedArtifact(artifact);
    const safeQa = normalizeQaPayload(qaReport, true);
    const safePolicyVersion = normalizePolicyVersion(policyVersion);
    const safeProcessorVersion = requiredString(processorVersion, "Media processor version", 128);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const binding = oneRow(await tx.query(
        `SELECT execution.id AS execution_id,
                run.id AS run_id,
                run.project_id,
                action.action_id,
                action.provider_task_id
           FROM production_job_execution execution
           JOIN production_run run ON run.id = execution.run_id
           JOIN generation_action action
             ON action.run_id = run.id
            AND action.action_id = execution.action_id
           JOIN media_asset source
             ON source.id = action.provider_output_asset_id
            AND source.id = $3::uuid
            AND source.project_id = run.project_id
            AND source.run_id = run.id
            AND source.kind = 'provider_output'
            AND source.deleted_at IS NULL
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND execution.job_name = 'petpack.process-video-action'
            AND run.state = 'video_generating'
            AND action.state = 'succeeded'
            AND action.processing_policy_version = $4
            AND action.processor_version = $5
            AND action.provider_task_id IS NOT NULL
          FOR UPDATE OF execution, action`,
        [safeJobId, safeLeaseToken, safeSourceAssetId, safePolicyVersion, safeProcessorVersion]
      ), "Processed media no longer matches its leased production action");
      const media = rows(await tx.query(
        `INSERT INTO media_asset
          (id, project_id, run_id, kind, object_key, sha256, content_type, byte_size)
         VALUES ($1, $2, $3, 'action_video', $4, $5, $6, $7)
         ON CONFLICT (object_key) DO UPDATE SET object_key = EXCLUDED.object_key
           WHERE media_asset.project_id = EXCLUDED.project_id
             AND media_asset.run_id = EXCLUDED.run_id
             AND media_asset.kind = 'action_video'
             AND media_asset.sha256 = EXCLUDED.sha256
             AND media_asset.content_type = EXCLUDED.content_type
             AND media_asset.byte_size = EXCLUDED.byte_size
         RETURNING id`,
        [this.idFactory(), binding.project_id, binding.run_id, safeArtifact.objectKey, safeArtifact.sha256, safeArtifact.contentType, safeArtifact.byteSize]
      ));
      if (media.length !== 1) throw new Error("Processed action output conflicts with an existing private media asset");
      const qaReportId = this.idFactory();
      const qa = rows(await tx.query(
        `INSERT INTO qa_report
          (id, project_id, run_id, action_id, subject_kind, status, policy_version, report,
           source_media_asset_id, subject_media_asset_id, processor_version)
         VALUES ($1, $2, $3, $4, 'video', 'passed', $5, $6::jsonb, $7::uuid, $8::uuid, $9)
        RETURNING id`,
        [
          qaReportId,
          binding.project_id,
          binding.run_id,
          binding.action_id,
          safePolicyVersion,
          safeQa.serialized,
          safeSourceAssetId,
          media[0].id,
          safeProcessorVersion
        ]
      ));
      if (qa.length !== 1) throw new Error("Processed action QA report could not be stored");
      const action = rows(await tx.query(
        `UPDATE generation_action
            SET state = 'processed', media_asset_id = $4, qa_report_id = $5, updated_at = now()
          WHERE run_id = $1
            AND action_id = $2
            AND provider_task_id = $3
            AND provider_output_asset_id = $6::uuid
            AND state = 'succeeded'
        RETURNING run_id, action_id`,
        [binding.run_id, binding.action_id, binding.provider_task_id, media[0].id, qa[0].id, safeSourceAssetId]
      ));
      if (action.length !== 1) throw new Error("Processed action media could not be bound to its generation action");
      const safeFinalizeJob = assertActionWorkflowJob(finalizeJob, {
        expectedName: JOB_NAMES.FINALIZE_VIDEO_ACTION,
        runId: binding.run_id,
        actionId: binding.action_id
      });
      await this._insertDelayedOutbox(tx, safeFinalizeJob, 1);
      return {
        runId: binding.run_id,
        actionId: binding.action_id,
        providerTaskId: binding.provider_task_id,
        mediaAssetId: media[0].id,
        qaReportId: qa[0].id
      };
    });
  }

  async failVideoProcessingQa({
    jobId,
    leaseToken,
    sourceAssetId,
    qaReport,
    policyVersion,
    processorVersion,
    errorCode = "action_qa_failed"
  } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeSourceAssetId = requiredString(sourceAssetId, "Provider source media asset ID", 128);
    const safeQa = normalizeQaPayload(qaReport, false);
    const safePolicyVersion = normalizePolicyVersion(policyVersion);
    const safeProcessorVersion = requiredString(processorVersion, "Media processor version", 128);
    const safeErrorCode = normalizeErrorCode(errorCode, "action_qa_failed");
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const binding = oneRow(await tx.query(
        `SELECT execution.id AS execution_id,
                run.id AS run_id,
                run.project_id,
                action.action_id
           FROM production_job_execution execution
           JOIN production_run run ON run.id = execution.run_id
           JOIN generation_action action
             ON action.run_id = run.id
            AND action.action_id = execution.action_id
           JOIN media_asset source
             ON source.id = action.provider_output_asset_id
            AND source.id = $3::uuid
            AND source.project_id = run.project_id
            AND source.run_id = run.id
            AND source.kind = 'provider_output'
            AND source.deleted_at IS NULL
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND execution.job_name = 'petpack.process-video-action'
            AND run.state = 'video_generating'
            AND action.state = 'succeeded'
            AND action.processing_policy_version = $4
            AND action.processor_version = $5
            AND action.provider_task_id IS NOT NULL
          FOR UPDATE OF execution, action`,
        [safeJobId, safeLeaseToken, safeSourceAssetId, safePolicyVersion, safeProcessorVersion]
      ), "Failed action QA no longer matches its leased production action");
      const qaReportId = this.idFactory();
      await tx.query(
        `INSERT INTO qa_report
          (id, project_id, run_id, action_id, subject_kind, status, policy_version, report,
           source_media_asset_id, processor_version)
         VALUES ($1, $2, $3, $4, 'video', 'failed', $5, $6::jsonb, $7::uuid, $8)`,
        [
          qaReportId,
          binding.project_id,
          binding.run_id,
          binding.action_id,
          safePolicyVersion,
          safeQa.serialized,
          safeSourceAssetId,
          safeProcessorVersion
        ]
      );
      const action = rows(await tx.query(
        `UPDATE generation_action
            SET state = 'failed', qa_report_id = $3, updated_at = now()
          WHERE run_id = $1 AND action_id = $2 AND state = 'succeeded'
        RETURNING action_id`,
        [binding.run_id, binding.action_id, qaReportId]
      ));
      if (action.length !== 1) throw new Error("Failed action QA could not be bound to its generation action");
      const execution = rows(await tx.query(
        `UPDATE production_job_execution
            SET status = 'dead', lease_token = NULL, lease_owner = NULL,
                leased_until = NULL, last_error_code = $3,
                completed_at = now(), updated_at = now()
          WHERE job_id = $1 AND lease_token = $2::uuid AND status = 'leased'
        RETURNING id`,
        [safeJobId, safeLeaseToken, safeErrorCode]
      ));
      if (execution.length !== 1) throw new Error("Failed action QA execution could not be completed");
      return { status: "dead", runId: binding.run_id, actionId: binding.action_id };
    });
  }

  async completeVideoProcessingExecution({ jobId, leaseToken } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const completed = rows(await tx.query(
        `UPDATE production_job_execution execution
            SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
                leased_until = NULL, completed_at = now(), updated_at = now()
           FROM generation_action action
           JOIN production_run run ON run.id = action.run_id
           JOIN media_asset asset
             ON asset.id = action.media_asset_id
            AND asset.run_id = action.run_id
            AND asset.project_id = run.project_id
            AND asset.kind = 'action_video'
            AND asset.content_type = 'video/webm'
            AND asset.deleted_at IS NULL
           JOIN qa_report report
             ON report.id = action.qa_report_id
            AND report.run_id = action.run_id
            AND report.project_id = run.project_id
            AND report.action_id = action.action_id
            AND report.subject_kind = 'video'
            AND report.status = 'passed'
            AND report.source_media_asset_id = action.provider_output_asset_id
            AND report.subject_media_asset_id = action.media_asset_id
            AND report.processor_version = action.processor_version
            AND report.policy_version = action.processing_policy_version
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.job_name IN ('petpack.process-video-action', 'petpack.finalize-video-action')
            AND action.run_id = execution.run_id
            AND action.action_id = execution.action_id
            AND action.state = 'qa_passed'
        RETURNING execution.run_id, execution.action_id`,
        [safeJobId, safeLeaseToken]
      ));
      if (completed.length !== 1) throw new Error("QA-passed video processing execution could not be completed");
      return { runId: completed[0].run_id, actionId: completed[0].action_id };
    });
  }

  async releaseVideoProcessingForRetry({ jobId, leaseToken, errorCode } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeErrorCode = normalizeErrorCode(errorCode, "media_processing_error");
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const row = oneRow(await tx.query(
        `SELECT execution.id, execution.run_id, execution.action_id,
                execution.attempts, execution.max_attempts, action.state AS action_state
           FROM production_job_execution execution
           JOIN generation_action action
             ON action.run_id = execution.run_id
            AND action.action_id = execution.action_id
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.job_name IN ('petpack.process-video-action', 'petpack.finalize-video-action')
          FOR UPDATE OF execution, action`,
        [safeJobId, safeLeaseToken]
      ), "Active video processing execution lease was not found");
      if (row.action_state === "qa_passed") {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, completed_at = COALESCE(completed_at, now()), updated_at = now()
            WHERE id = $1`,
          [row.id]
        );
        return { status: "succeeded", exhausted: false };
      }
      const exhausted = Number(row.attempts) >= Number(row.max_attempts);
      const nextStatus = exhausted ? "dead" : "retryable";
      await tx.query(
        `UPDATE production_job_execution
            SET status = $3, lease_token = NULL, lease_owner = NULL, leased_until = NULL,
                last_error_code = $4, updated_at = now()
          WHERE job_id = $1 AND lease_token = $2::uuid AND status = 'leased'`,
        [safeJobId, safeLeaseToken, nextStatus, safeErrorCode]
      );
      if (exhausted && row.action_state === "succeeded") {
        await tx.query(
          `UPDATE generation_action SET state = 'failed', updated_at = now()
            WHERE run_id = $1 AND action_id = $2 AND state = 'succeeded'`,
          [row.run_id, row.action_id]
        );
      }
      this.logger.warn?.("petpack.worker.video_processing_released", {
        runId: row.run_id,
        actionId: row.action_id,
        status: nextStatus,
        errorCode: safeErrorCode
      });
      return { status: nextStatus, exhausted };
    });
  }

  async releaseVideoPollForRetry({ jobId, leaseToken, errorCode } = {}) {
    return this._settleExecution({ jobId, leaseToken, status: "retryable", errorCode, resetRejectedAction: false, providerTaskExpected: true });
  }

  async markVideoPollFailed({ jobId, leaseToken, errorCode } = {}) {
    return this._settleExecution({ jobId, leaseToken, status: "dead", errorCode, resetRejectedAction: false, failAction: true, providerTaskExpected: true, usageEventType: "provider_failed" });
  }

  async markVideoPollUnknown({ jobId, leaseToken, errorCode } = {}) {
    return this._settleExecution({ jobId, leaseToken, status: "reconciliation_required", errorCode, resetRejectedAction: false, failAction: true, providerTaskExpected: true, usageEventType: "provider_status_unknown" });
  }

  async releaseVideoClaimForRetry({ jobId, leaseToken, errorCode } = {}) {
    return this._settleExecution({ jobId, leaseToken, status: "retryable", errorCode, resetRejectedAction: false });
  }

  async markVideoSubmissionRejected({ jobId, leaseToken, errorCode } = {}) {
    return this._settleExecution({ jobId, leaseToken, status: "retryable", errorCode, resetRejectedAction: true, usageEventType: "explicitly_rejected" });
  }

  async markVideoSubmissionUnknown({ jobId, leaseToken, errorCode } = {}) {
    return this._settleExecution({ jobId, leaseToken, status: "reconciliation_required", errorCode, resetRejectedAction: false, failAction: true, usageEventType: "submission_unknown" });
  }

  async _settleExecution({ jobId, leaseToken, status, errorCode, resetRejectedAction, failAction = false, providerTaskExpected = false, usageEventType = null }) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeErrorCode = normalizeErrorCode(errorCode, "worker_error");
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const execution = oneRow(await tx.query(
        `SELECT execution.id, execution.run_id, execution.action_id,
                execution.attempts, execution.max_attempts,
                action.provider_request_id
           FROM production_job_execution execution
           JOIN generation_action action
             ON action.run_id = execution.run_id
            AND action.action_id = execution.action_id
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
          FOR UPDATE OF execution, action`,
        [safeJobId, safeLeaseToken]
      ), "Active video execution lease was not found");
      const exhausted = Number(execution.attempts) >= Number(execution.max_attempts);
      const nextStatus = status === "reconciliation_required" ? status : exhausted ? "dead" : status;
      if (usageEventType) {
        if (!execution.provider_request_id) throw new Error("Video outcome has no immutable provider usage attempt");
        await recordUsageOutcome(tx, this.idFactory, {
          internalRequestId: execution.provider_request_id,
          eventType: usageEventType,
          reasonCode: safeErrorCode
        });
      }
      await tx.query(
        `UPDATE production_job_execution
            SET status = $3, lease_token = NULL, lease_owner = NULL, leased_until = NULL,
                last_error_code = $4, updated_at = now()
          WHERE job_id = $1 AND lease_token = $2::uuid AND status = 'leased'`,
        [safeJobId, safeLeaseToken, nextStatus, safeErrorCode]
      );
      if (resetRejectedAction) {
        await tx.query(
          `UPDATE generation_action
              SET state = $3, provider_request_id = NULL, updated_at = now()
            WHERE run_id = $1 AND action_id = $2 AND provider_task_id IS NULL`,
          [execution.run_id, execution.action_id, exhausted ? "failed" : "queued"]
        );
      } else if (failAction || exhausted) {
        await tx.query(
          `UPDATE generation_action SET state = 'failed', updated_at = now()
            WHERE run_id = $1
              AND action_id = $2
              AND (($3::boolean AND provider_task_id IS NOT NULL)
                OR (NOT $3::boolean AND provider_task_id IS NULL))`,
          [execution.run_id, execution.action_id, Boolean(providerTaskExpected)]
        );
      }
      this.logger.warn?.("petpack.worker.video_execution_settled", {
        runId: execution.run_id,
        actionId: execution.action_id,
        status: nextStatus,
        errorCode: safeErrorCode
      });
      return { status: nextStatus, exhausted };
    });
  }
}

module.exports = {
  PostgresProductionWorkerRepository,
  assertActionWorkflowJob,
  mapVideoSubmission,
  normalizeClaimInput,
  normalizeErrorCode,
  normalizeArchivedArtifact,
  normalizeProcessedArtifact,
  normalizeQaPayload
};
