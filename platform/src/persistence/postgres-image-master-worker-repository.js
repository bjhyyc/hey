const crypto = require("node:crypto");

const { PROVIDER_OPERATIONS } = require("../domain/provider-cost-accounting");
const { PRODUCTION_STATES } = require("../domain/production-state-machine");
const {
  IMAGE_CONSTRAINTS_VERSION,
  IMAGE_PROMPT_CONTENT_POLICY_VERSION
} = require("../providers/modelark-client");
const {
  assertPositiveByteSize,
  assertPrivateObjectKey,
  normalizeSha256
} = require("../storage/private-object-store");
const { JOB_NAMES } = require("../workflow/production-workflow");
const { recordUsageAttempt, recordUsageOutcome } = require("./provider-usage-ledger");

const GENERATION_JOB_KIND = Object.freeze({
  [JOB_NAMES.GENERATE_AWAKE]: "awake",
  [JOB_NAMES.GENERATE_SLEEP]: "sleep"
});
const FINALIZER_JOB_KIND = Object.freeze({
  [JOB_NAMES.FINALIZE_AWAKE]: "awake",
  [JOB_NAMES.FINALIZE_SLEEP]: "sleep"
});

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function") {
    throw new Error("A PostgreSQL transaction runner is required");
  }
  return database;
}

function requireQuery(transaction) {
  if (!transaction || typeof transaction.query !== "function") {
    throw new Error("A PostgreSQL query interface is required");
  }
  return transaction;
}

function rows(result) {
  return Array.isArray(result && result.rows) ? result.rows : [];
}

function oneRow(result, message) {
  const found = rows(result);
  if (found.length !== 1) throw new Error(message);
  return found[0];
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeErrorCode(value, fallback) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
    ? value.toLowerCase()
    : fallback;
}

function normalizeModelReference(value) {
  const reference = parseJsonObject(value, "Seedream model reference");
  requiredString(reference.registryVersion, "Seedream registry version", 128);
  requiredString(reference.endpointId, "Seedream endpoint ID", 256);
  const serialized = canonicalJson(reference);
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    throw new Error("Seedream model reference exceeds the persistence limit");
  }
  return JSON.parse(serialized);
}

function normalizeClaimInput({ jobId, jobName, runId, maxAttempts, leaseSeconds, leaseOwner, modelReference, outputSize } = {}) {
  const kind = GENERATION_JOB_KIND[jobName];
  if (!kind) throw new Error("Unsupported master-image generation job");
  const normalizedOutputSize = outputSize === undefined || outputSize === null || outputSize === ""
    ? null
    : requiredString(outputSize, "Seedream output size", 128);
  return {
    jobId: requiredString(jobId, "Queue job ID"),
    jobName,
    kind,
    runId: requiredString(runId, "Production run ID", 128),
    maxAttempts: positiveInteger(maxAttempts, "Maximum attempts", 100),
    leaseSeconds: positiveInteger(leaseSeconds, "Execution lease seconds", 3600),
    leaseOwner: requiredString(leaseOwner, "Execution lease owner", 256),
    modelReference: normalizeModelReference(modelReference),
    outputSize: normalizedOutputSize
  };
}

function normalizeArtifact(artifact, { normalized = false } = {}) {
  if (!artifact || typeof artifact !== "object") throw new Error("Master image artifact metadata is required");
  const contentType = requiredString(artifact.contentType, "Master image content type", 256);
  const providerTypeAllowed = contentType.toLowerCase().startsWith("image/") || contentType === "application/octet-stream";
  if (normalized ? contentType !== "image/png" : !providerTypeAllowed) {
    throw new Error(normalized ? "Normalized master must use image/png" : "Archived Seedream output must be an image");
  }
  return {
    objectKey: assertPrivateObjectKey(artifact.objectKey),
    sha256: normalizeSha256(artifact.sha256, "Master image checksum"),
    byteSize: assertPositiveByteSize(Number(artifact.byteSize), "Master image byte size"),
    contentType
  };
}

function normalizeQaReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report) || typeof report.ok !== "boolean") {
    throw new Error("Master image QA report must contain a boolean result");
  }
  const serialized = JSON.stringify(report);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
    throw new Error("Master image QA report exceeds the persistence limit");
  }
  return { report: JSON.parse(serialized), serialized };
}

function normalizeReferenceMetrics(report) {
  const parsed = parseJsonObject(report, "Awake master QA report");
  const metrics = parsed.referenceMetrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error("Awake master QA report has no immutable reference metrics");
  }
  const output = {};
  for (const key of ["groundBaselineY", "torsoHeightPx", "headHeightPx", "shoulderWidthPx", "centerX"]) {
    const value = Number(metrics[key]);
    if (!Number.isFinite(value)) throw new Error(`Awake master reference metric ${key} is invalid`);
    output[key] = value;
  }
  return output;
}

function assertRunWorkflowJob(job, { expectedName, runId } = {}) {
  if (!job || job.name !== expectedName || job.dedupeKey !== job.options?.jobId) {
    throw new Error("A deterministic master finalizer job is required");
  }
  if (!job.data || job.data.runId !== runId || Object.keys(job.data).some((key) => key !== "runId")) {
    throw new Error("Master finalizer payload may contain only its production run ID");
  }
  if (!Number.isInteger(job.options?.attempts) || job.options.attempts < 1 || job.options.attempts > 100) {
    throw new Error("Master finalizer requires a bounded attempt count");
  }
  return job;
}

function mapRun(row) {
  return {
    id: row.run_id,
    projectId: row.project_id,
    orderId: row.order_id,
    characterRevisionId: row.character_revision_id || null,
    state: row.run_state,
    awakeGenerationAttempts: Number(row.awake_generation_attempts || 0),
    sleepGenerationAttempts: Number(row.sleep_generation_attempts || 0),
    failureCode: row.failure_code || null,
    version: Number(row.run_version)
  };
}

function currentGenerationAttempt(row, kind) {
  const value = Number(kind === "awake" ? row.awake_generation_attempts : row.sleep_generation_attempts);
  if (!Number.isSafeInteger(value) || value < 0 || (kind === "awake" && value < 1)) {
    throw new Error("Production run master generation attempt is invalid");
  }
  return value;
}

function isFinalizedState({ kind, qaPassed, generationAttempt, run }) {
  if (kind === "awake") {
    if (qaPassed) return run.state !== PRODUCTION_STATES.AWAKE_GENERATING;
    return run.state === PRODUCTION_STATES.FAILED;
  }
  if (qaPassed) {
    return ![PRODUCTION_STATES.SLEEP_GENERATING].includes(run.state);
  }
  return run.state === PRODUCTION_STATES.FAILED ||
    (run.state === PRODUCTION_STATES.SLEEP_GENERATING && run.sleepGenerationAttempts > generationAttempt);
}

class PostgresImageMasterWorkerRepository {
  constructor({ database, idFactory = crypto.randomUUID, logger = console } = {}) {
    this.database = requireDatabase(database);
    if (typeof idFactory !== "function") throw new Error("A UUID ID factory is required");
    this.idFactory = idFactory;
    this.logger = logger;
  }

  async _loadRun(tx, runId) {
    const run = oneRow(await tx.query(
      `SELECT run.id AS run_id, run.project_id, run.order_id, run.character_revision_id,
              run.state AS run_state, run.awake_generation_attempts, run.sleep_generation_attempts,
              run.failure_code, run.version AS run_version, order_record.status AS order_status
         FROM production_run run
         JOIN customer_order order_record
           ON order_record.id = run.order_id
          AND order_record.project_id = run.project_id
         JOIN pet_project project ON project.id = run.project_id
        WHERE run.id = $1
        FOR UPDATE OF run`,
      [runId]
    ), "Production run was not found for master-image work");
    if (run.order_status !== "paid") throw new Error("Master-image work requires a paid order");
    return run;
  }

  async _loadExecution(tx, jobId) {
    return oneRow(await tx.query(
      `SELECT id AS execution_id, job_id, job_name, run_id AS execution_run_id,
              action_id, status AS execution_status, attempts, max_attempts,
              lease_token, leased_until,
              (status = 'leased' AND leased_until > now()) AS lease_active
         FROM production_job_execution
        WHERE job_id = $1
        FOR UPDATE`,
      [jobId]
    ), "Master-image execution was not found");
  }

  async _lockRunForExecutionJob(tx, jobId) {
    const binding = oneRow(await tx.query(
      "SELECT run_id FROM production_job_execution WHERE job_id = $1",
      [jobId]
    ), "Master-image execution run binding was not found");
    return this._loadRun(tx, binding.run_id);
  }

  async _loadPublishedPrompt(tx, kind) {
    const prompt = oneRow(await tx.query(
      `SELECT version.id AS prompt_version_id, version.version AS prompt_version_label,
              version.prompt, version.negative_prompt, version.immutable_constraints_version,
              version.content_policy_version
         FROM image_prompt_template template
         JOIN image_prompt_version version
           ON version.id = template.current_published_version_id
          AND version.template_id = template.id
          AND version.status = 'published'
          AND version.published_at IS NOT NULL
          AND version.content_policy_approved_at IS NOT NULL
          AND version.content_policy_approved_by IS NOT NULL
          AND version.disabled_at IS NULL
        WHERE template.kind = $1
          AND template.disabled_at IS NULL`,
      [kind]
    ), `No published ${kind} master-image prompt is available`);
    if (prompt.immutable_constraints_version !== IMAGE_CONSTRAINTS_VERSION) {
      throw new Error("Published image prompt targets a different immutable constraint version");
    }
    if (prompt.content_policy_version !== IMAGE_PROMPT_CONTENT_POLICY_VERSION) {
      throw new Error("Published image prompt has no compatible brand-neutral content-policy approval");
    }
    return prompt;
  }

  async _loadAwakeReferences(tx, run, sourcePhotoRevisionId) {
    const result = rows(await tx.query(
      `SELECT reservation.ordinal, reservation.source_photo_revision_id,
              asset.id AS media_asset_id, asset.object_key, asset.sha256,
              asset.byte_size, asset.content_type
         FROM source_photo_upload_reservation reservation
         JOIN source_photo photo
           ON photo.project_id = reservation.project_id
          AND photo.ordinal = reservation.ordinal
         JOIN media_asset asset
           ON asset.id = photo.media_asset_id
          AND asset.project_id = reservation.project_id
          AND asset.run_id = $2
          AND asset.kind = 'source_photo'
          AND asset.deleted_at IS NULL
        WHERE reservation.project_id = $1
          AND reservation.status = 'accepted'
          AND ($3::uuid IS NULL OR reservation.source_photo_revision_id = $3::uuid)
        ORDER BY reservation.ordinal
        FOR UPDATE OF reservation, photo, asset`,
      [run.project_id, run.run_id, sourcePhotoRevisionId || null]
    ));
    if (result.length !== 2 || Number(result[0].ordinal) !== 1 || Number(result[1].ordinal) !== 2) {
      throw new Error("Exactly two accepted source photos are required for the awake master");
    }
    const revisions = [...new Set(result.map((row) => row.source_photo_revision_id).filter(Boolean))];
    if (revisions.length !== 1) throw new Error("Awake source photos have no single immutable revision");
    return {
      sourcePhotoRevisionId: revisions[0],
      references: result.map((row) => ({
        mediaAssetId: row.media_asset_id,
        objectKey: assertPrivateObjectKey(row.object_key),
        sha256: normalizeSha256(row.sha256, "Source photo checksum"),
        byteSize: assertPositiveByteSize(Number(row.byte_size), "Source photo byte size"),
        contentType: requiredString(row.content_type, "Source photo content type", 256)
      }))
    };
  }

  async _loadSleepReference(tx, run, awakeCandidateId) {
    const row = oneRow(await tx.query(
      `SELECT revision.awake_candidate_id, candidate.id AS candidate_id,
              asset.id AS media_asset_id, asset.object_key, asset.sha256,
              asset.byte_size, asset.content_type, qa.report AS qa_report
         FROM character_revision revision
         JOIN image_candidate candidate
           ON candidate.id = revision.awake_candidate_id
          AND candidate.project_id = revision.project_id
          AND candidate.run_id = $1
          AND candidate.kind = 'awake'
          AND candidate.qa_status = 'passed'
         JOIN media_asset asset
           ON asset.id = candidate.media_asset_id
          AND asset.project_id = revision.project_id
          AND asset.run_id = $1
          AND asset.kind = 'awake_master'
          AND asset.deleted_at IS NULL
         JOIN qa_report qa
           ON qa.id = candidate.qa_report_id
          AND qa.project_id = revision.project_id
          AND qa.run_id = $1
          AND qa.subject_kind = 'image'
          AND qa.status = 'passed'
          AND qa.subject_media_asset_id = asset.id
        WHERE revision.id = $2
          AND revision.project_id = $3
          AND ($4::uuid IS NULL OR candidate.id = $4::uuid)
        FOR UPDATE OF revision, candidate, asset, qa`,
      [run.run_id, run.character_revision_id, run.project_id, awakeCandidateId || null]
    ), "Approved awake master is unavailable for sleeping-master generation");
    return {
      awakeCandidateId: row.candidate_id,
      referenceMetrics: normalizeReferenceMetrics(row.qa_report),
      references: [{
        mediaAssetId: row.media_asset_id,
        objectKey: assertPrivateObjectKey(row.object_key),
        sha256: normalizeSha256(row.sha256, "Awake master checksum"),
        byteSize: assertPositiveByteSize(Number(row.byte_size), "Awake master byte size"),
        contentType: requiredString(row.content_type, "Awake master content type", 256)
      }]
    };
  }

  async _loadGeneration(tx, jobId) {
    const found = rows(await tx.query(
      `SELECT generation.*, prompt.prompt, prompt.negative_prompt,
              provider_asset.object_key AS provider_object_key,
              provider_asset.sha256 AS provider_sha256,
              provider_asset.byte_size AS provider_byte_size,
              provider_asset.content_type AS provider_content_type
         FROM master_image_generation generation
         JOIN image_prompt_version prompt
           ON prompt.id = generation.prompt_version_id
          AND prompt.version = generation.prompt_version_label
         LEFT JOIN media_asset provider_asset ON provider_asset.id = generation.provider_output_asset_id
        WHERE generation.job_id = $1
        FOR UPDATE OF generation`,
      [jobId]
    ));
    return found.length === 1 ? found[0] : null;
  }

  async _createGeneration(tx, claim, run) {
    const prompt = await this._loadPublishedPrompt(tx, claim.kind);
    const input = claim.kind === "awake"
      ? await this._loadAwakeReferences(tx, run)
      : await this._loadSleepReference(tx, run);
    const generationAttempt = currentGenerationAttempt(run, claim.kind);
    const id = this.idFactory();
    const inserted = rows(await tx.query(
      `INSERT INTO master_image_generation
        (id, job_id, run_id, project_id, order_id, kind, generation_attempt,
         source_photo_revision_id, parent_awake_candidate_id,
         prompt_version_id, prompt_version_label, model_reference, output_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, 'pending')
       RETURNING id`,
      [
        id, claim.jobId, run.run_id, run.project_id, run.order_id, claim.kind, generationAttempt,
        input.sourcePhotoRevisionId || null, input.awakeCandidateId || null,
        prompt.prompt_version_id, prompt.prompt_version_label,
        JSON.stringify(claim.modelReference), claim.outputSize
      ]
    ));
    if (inserted.length !== 1) throw new Error("Immutable master-image generation snapshot could not be created");
    return this._loadGeneration(tx, claim.jobId);
  }

  async _loadGenerationReferences(tx, run, generation) {
    return generation.kind === "awake"
      ? this._loadAwakeReferences(tx, run, generation.source_photo_revision_id)
      : this._loadSleepReference(tx, run, generation.parent_awake_candidate_id);
  }

  async _markExecutionSucceeded(tx, executionId) {
    await tx.query(
      `UPDATE production_job_execution
          SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
              leased_until = NULL, completed_at = COALESCE(completed_at, now()), updated_at = now()
        WHERE id = $1`,
      [executionId]
    );
  }

  async _failRun(tx, run, failureCode) {
    if (run.run_state === PRODUCTION_STATES.FAILED) return;
    const result = oneRow(await tx.query(
      `UPDATE production_run
          SET state = 'failed', failure_code = $2, version = version + 1, updated_at = now()
        WHERE id = $1 AND state = $3 AND version = $4
      RETURNING version`,
      [run.run_id, normalizeErrorCode(failureCode, "master_image_failed"), run.run_state, Number(run.run_version)]
    ), "Production run changed while failing master-image work");
    await tx.query(
      `INSERT INTO production_run_event
        (id, run_id, previous_state, next_state, expected_version, resulting_version)
       VALUES ($1, $2, $3, 'failed', $4, $5)`,
      [this.idFactory(), run.run_id, run.run_state, Number(run.run_version), Number(result.version)]
    );
    run.run_state = PRODUCTION_STATES.FAILED;
    run.run_version = Number(result.version);
  }

  async claimMasterGeneration(input = {}) {
    const claim = normalizeClaimInput(input);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await tx.query(
        `INSERT INTO production_job_execution
          (id, job_id, job_name, run_id, action_id, status, attempts, max_attempts)
         VALUES ($1, $2, $3, $4, NULL, 'pending', 0, $5)
         ON CONFLICT (job_id) DO NOTHING`,
        [this.idFactory(), claim.jobId, claim.jobName, claim.runId, claim.maxAttempts]
      );
      const run = await this._loadRun(tx, claim.runId);
      const execution = await this._loadExecution(tx, claim.jobId);
      if (execution.job_name !== claim.jobName || execution.execution_run_id !== claim.runId || execution.action_id !== null) {
        throw new Error("Queue job ID is already bound to different production work");
      }
      if (Number(execution.max_attempts) !== claim.maxAttempts) {
        throw new Error("Master-image retry policy changed after execution creation");
      }
      let generation = await this._loadGeneration(tx, claim.jobId);
      if (!generation) generation = await this._createGeneration(tx, claim, run);
      if (generation.run_id !== run.run_id || generation.project_id !== run.project_id ||
          generation.order_id !== run.order_id || generation.kind !== claim.kind) {
        throw new Error("Master-image generation ownership is inconsistent");
      }
      const frozenReference = normalizeModelReference(generation.model_reference);
      if (canonicalJson(frozenReference) !== canonicalJson(claim.modelReference) || (generation.output_size || null) !== claim.outputSize) {
        throw new Error("Master-image job was frozen to a different ModelArk configuration");
      }
      if (["qa_passed", "qa_failed", "processed"].includes(generation.status)) {
        await this._markExecutionSucceeded(tx, execution.execution_id);
        return { outcome: "already_processed", runId: claim.runId, kind: claim.kind };
      }
      if (execution.execution_status === "succeeded") {
        throw new Error("Master-image execution completed without a persisted QA result");
      }
      if (execution.execution_status === "reconciliation_required" || generation.status === "reconciliation_required" ||
          (generation.provider_request_id && !generation.provider_output_asset_id)) {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'reconciliation_required', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, updated_at = now()
            WHERE id = $1`,
          [execution.execution_id]
        );
        return { outcome: "reconciliation_required", runId: claim.runId, kind: claim.kind };
      }
      if (execution.execution_status === "dead" || generation.status === "dead") {
        return { outcome: "dead", runId: claim.runId, kind: claim.kind };
      }
      if (!["pending", "retryable", "leased"].includes(execution.execution_status)) {
        throw new Error("Master-image execution has an unsupported recoverable state");
      }
      if (execution.lease_active) return { outcome: "busy", runId: claim.runId, kind: claim.kind };
      const expectedState = claim.kind === "awake" ? PRODUCTION_STATES.AWAKE_GENERATING : PRODUCTION_STATES.SLEEP_GENERATING;
      if (run.run_state !== expectedState || Number(generation.generation_attempt) !== currentGenerationAttempt(run, claim.kind)) {
        throw new Error("Master-image generation is not current for this production run");
      }
      const previousAttempts = Number(execution.attempts);
      if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0) throw new Error("Master-image execution attempt count is invalid");
      if (previousAttempts >= claim.maxAttempts) {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'dead', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, last_error_code = 'master_image_attempts_exhausted', updated_at = now()
            WHERE id = $1`,
          [execution.execution_id]
        );
        await tx.query(
          `UPDATE master_image_generation
              SET status = 'dead', last_error_code = 'master_image_attempts_exhausted', updated_at = now()
            WHERE id = $1`,
          [generation.id]
        );
        await this._failRun(tx, run, "master_image_attempts_exhausted");
        return { outcome: "dead", runId: claim.runId, kind: claim.kind };
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
        [execution.execution_id, attempt, leaseToken, claim.leaseOwner, claim.leaseSeconds]
      ));
      if (leased.length !== 1) throw new Error("Master-image execution lease could not be acquired");
      const referenceInput = await this._loadGenerationReferences(tx, run, generation);
      const providerOutput = generation.provider_output_asset_id ? {
        mediaAssetId: generation.provider_output_asset_id,
        objectKey: assertPrivateObjectKey(generation.provider_object_key),
        sha256: normalizeSha256(generation.provider_sha256, "Archived Seedream checksum"),
        byteSize: assertPositiveByteSize(Number(generation.provider_byte_size), "Archived Seedream byte size"),
        contentType: requiredString(generation.provider_content_type, "Archived Seedream content type", 256)
      } : null;
      return {
        outcome: "claimed",
        stage: providerOutput ? "process" : "submit",
        jobId: claim.jobId,
        runId: run.run_id,
        projectId: run.project_id,
        orderId: run.order_id,
        kind: claim.kind,
        generationId: generation.id,
        generationAttempt: Number(generation.generation_attempt),
        sourcePhotoRevisionId: generation.source_photo_revision_id || null,
        awakeCandidateId: generation.parent_awake_candidate_id || null,
        leaseToken,
        attempt,
        modelReference: frozenReference,
        outputSize: generation.output_size || null,
        promptVersion: {
          id: generation.prompt_version_id,
          version: generation.prompt_version_label,
          prompt: requiredString(generation.prompt, "Frozen image prompt", 20000),
          negativePrompt: generation.negative_prompt || "",
          constraintsVersion: IMAGE_CONSTRAINTS_VERSION
        },
        references: referenceInput.references,
        referenceMetrics: referenceInput.referenceMetrics || null,
        providerOutput,
        processingPolicyVersion: generation.processing_policy_version || null,
        processorVersion: generation.processor_version || null
      };
    });
  }

  async prepareMasterSubmission({ jobId, leaseToken, providerRequestId } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeRequestId = requiredString(providerRequestId, "Seedream request ID", 256);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await this._lockRunForExecutionJob(tx, safeJobId);
      const updated = rows(await tx.query(
        `UPDATE master_image_generation generation
            SET provider_request_id = $3, status = 'provider_calling', updated_at = now()
           FROM production_job_execution execution
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND generation.job_id = execution.job_id
            AND generation.run_id = execution.run_id
            AND generation.status = 'pending'
            AND (generation.provider_request_id IS NULL OR generation.provider_request_id = $3)
        RETURNING generation.id, generation.run_id, generation.project_id, generation.order_id,
                  generation.kind, generation.model_reference, generation.output_size,
                  execution.attempts AS worker_attempt`,
        [safeJobId, safeLeaseToken, safeRequestId]
      ));
      if (updated.length !== 1) throw new Error("Seedream submission intent could not be persisted under the active lease");
      await recordUsageAttempt(tx, this.idFactory, {
        internalRequestId: safeRequestId,
        projectId: updated[0].project_id,
        orderId: updated[0].order_id,
        runId: updated[0].run_id,
        masterImageGenerationId: updated[0].id,
        operation: updated[0].kind === "awake"
          ? PROVIDER_OPERATIONS.SEEDREAM_AWAKE
          : PROVIDER_OPERATIONS.SEEDREAM_SLEEP,
        workerAttempt: Number(updated[0].worker_attempt),
        modelReference: updated[0].model_reference,
        outputSize: updated[0].output_size,
        requestedOutputCount: 1
      });
      return { providerRequestId: safeRequestId };
    });
  }

  async markMasterSubmissionRejected({ jobId, leaseToken, errorCode } = {}) {
    return this._settleSubmissionFailure({ jobId, leaseToken, errorCode, unknown: false });
  }

  async markMasterProviderAccepted({ jobId, leaseToken, providerRequestId } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeRequestId = requiredString(providerRequestId, "Seedream request ID", 256);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await this._lockRunForExecutionJob(tx, safeJobId);
      const binding = oneRow(await tx.query(
        `SELECT generation.id, generation.provider_request_id
           FROM master_image_generation generation
           JOIN production_job_execution execution ON execution.job_id = generation.job_id
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND generation.provider_request_id = $3
            AND generation.status = 'provider_calling'
          FOR UPDATE OF generation, execution`,
        [safeJobId, safeLeaseToken, safeRequestId]
      ), "Accepted Seedream request is not bound to the active execution");
      await recordUsageOutcome(tx, this.idFactory, {
        internalRequestId: binding.provider_request_id,
        eventType: "provider_accepted"
      });
      return { providerRequestId: binding.provider_request_id };
    });
  }

  async markMasterProviderOutputSucceeded({ jobId, leaseToken, providerRequestId } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeRequestId = requiredString(providerRequestId, "Seedream request ID", 256);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await this._lockRunForExecutionJob(tx, safeJobId);
      const binding = oneRow(await tx.query(
        `SELECT generation.id, generation.provider_request_id
           FROM master_image_generation generation
           JOIN production_job_execution execution ON execution.job_id = generation.job_id
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND generation.provider_request_id = $3
            AND generation.status = 'provider_calling'
          FOR UPDATE OF generation, execution`,
        [safeJobId, safeLeaseToken, safeRequestId]
      ), "Successful Seedream output is not bound to the active execution");
      await recordUsageOutcome(tx, this.idFactory, {
        internalRequestId: binding.provider_request_id,
        eventType: "output_succeeded",
        outputCount: 1
      });
      return { providerRequestId: binding.provider_request_id };
    });
  }

  async markMasterSubmissionUnknown({ jobId, leaseToken, errorCode } = {}) {
    return this._settleSubmissionFailure({ jobId, leaseToken, errorCode, unknown: true });
  }

  async _settleSubmissionFailure({ jobId, leaseToken, errorCode, unknown }) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const code = normalizeErrorCode(errorCode, unknown ? "seedream_submission_unknown" : "seedream_submission_rejected");
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await this._lockRunForExecutionJob(tx, safeJobId);
      const status = unknown ? "reconciliation_required" : "pending";
      const generation = rows(await tx.query(
        `UPDATE master_image_generation generation
            SET status = $3,
                last_error_code = $4, updated_at = now()
           FROM production_job_execution execution
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND generation.job_id = execution.job_id
            AND generation.status = 'provider_calling'
        RETURNING generation.id, generation.provider_request_id`,
        [safeJobId, safeLeaseToken, status, code]
      ));
      if (generation.length !== 1) throw new Error("Seedream submission failure could not be recorded");
      await recordUsageOutcome(tx, this.idFactory, {
        internalRequestId: generation[0].provider_request_id,
        eventType: unknown ? "submission_unknown" : "explicitly_rejected",
        reasonCode: code
      });
      if (!unknown) {
        const cleared = rows(await tx.query(
          `UPDATE master_image_generation
              SET provider_request_id = NULL, updated_at = now()
            WHERE id = $1 AND status = 'pending' AND provider_request_id = $2
          RETURNING id`,
          [generation[0].id, generation[0].provider_request_id]
        ));
        if (cleared.length !== 1) throw new Error("Rejected Seedream request ID could not be cleared after accounting");
      }
      const executionStatus = unknown ? "reconciliation_required" : "retryable";
      const execution = rows(await tx.query(
        `UPDATE production_job_execution
            SET status = $3, lease_token = NULL, lease_owner = NULL, leased_until = NULL,
                last_error_code = $4, updated_at = now()
          WHERE job_id = $1 AND lease_token = $2::uuid AND status = 'leased'
        RETURNING id`,
        [safeJobId, safeLeaseToken, executionStatus, code]
      ));
      if (execution.length !== 1) throw new Error("Seedream execution failure could not be recorded");
      return { status: executionStatus };
    });
  }

  async _insertMediaExact(tx, { projectId, runId, kind, artifact }) {
    const inserted = rows(await tx.query(
      `INSERT INTO media_asset
        (id, project_id, run_id, kind, object_key, sha256, content_type, byte_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (object_key) DO UPDATE
         SET object_key = media_asset.object_key
       WHERE media_asset.project_id = EXCLUDED.project_id
         AND media_asset.run_id = EXCLUDED.run_id
         AND media_asset.kind = EXCLUDED.kind
         AND media_asset.sha256 = EXCLUDED.sha256
         AND media_asset.content_type = EXCLUDED.content_type
         AND media_asset.byte_size = EXCLUDED.byte_size
         AND media_asset.deleted_at IS NULL
       RETURNING id`,
      [this.idFactory(), projectId, runId, kind, artifact.objectKey, artifact.sha256, artifact.contentType, artifact.byteSize]
    ));
    if (inserted.length !== 1) throw new Error("Private image object key is already bound to different media");
    return inserted[0].id;
  }

  async saveMasterProviderOutput({ jobId, leaseToken, providerRequestId, artifact } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeRequestId = requiredString(providerRequestId, "Seedream request ID", 256);
    const normalized = normalizeArtifact(artifact);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await this._lockRunForExecutionJob(tx, safeJobId);
      const binding = oneRow(await tx.query(
        `SELECT generation.id, generation.run_id, generation.project_id,
                generation.provider_output_asset_id
           FROM master_image_generation generation
           JOIN production_job_execution execution ON execution.job_id = generation.job_id
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND generation.provider_request_id = $3
            AND generation.status IN ('provider_calling', 'provider_archived')
          FOR UPDATE OF generation, execution`,
        [safeJobId, safeLeaseToken, safeRequestId]
      ), "Archived Seedream output is not bound to the active execution");
      const mediaAssetId = await this._insertMediaExact(tx, {
        projectId: binding.project_id,
        runId: binding.run_id,
        kind: "provider_output",
        artifact: normalized
      });
      if (binding.provider_output_asset_id && binding.provider_output_asset_id !== mediaAssetId) {
        throw new Error("Seedream generation is already bound to a different provider output");
      }
      const updated = rows(await tx.query(
        `UPDATE master_image_generation
            SET provider_output_asset_id = COALESCE(provider_output_asset_id, $2),
                status = 'provider_archived', updated_at = now()
          WHERE id = $1
            AND (provider_output_asset_id IS NULL OR provider_output_asset_id = $2)
        RETURNING id`,
        [binding.id, mediaAssetId]
      ));
      if (updated.length !== 1) throw new Error("Seedream provider output could not be bound immutably");
      return { mediaAssetId, ...normalized };
    });
  }

  async bindMasterProcessingPolicy({ jobId, leaseToken, policyVersion, processorVersion } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safePolicy = requiredString(policyVersion, "Master QA policy version", 128);
    const safeProcessor = requiredString(processorVersion, "Master processor version", 128);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await this._lockRunForExecutionJob(tx, safeJobId);
      const updated = rows(await tx.query(
        `UPDATE master_image_generation generation
            SET processing_policy_version = COALESCE(processing_policy_version, $3),
                processor_version = COALESCE(processor_version, $4), updated_at = now()
           FROM production_job_execution execution
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND generation.job_id = execution.job_id
            AND generation.status = 'provider_archived'
            AND (generation.processing_policy_version IS NULL OR generation.processing_policy_version = $3)
            AND (generation.processor_version IS NULL OR generation.processor_version = $4)
        RETURNING generation.processing_policy_version, generation.processor_version`,
        [safeJobId, safeLeaseToken, safePolicy, safeProcessor]
      ));
      if (updated.length !== 1) throw new Error("Master processing versions could not be frozen");
      return { policyVersion: updated[0].processing_policy_version, processorVersion: updated[0].processor_version };
    });
  }

  async renewMasterLease({ jobId, leaseToken, leaseSeconds } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const safeLeaseSeconds = positiveInteger(leaseSeconds, "Master execution lease seconds", 3600);
    return this.database.transaction(async (transaction) => {
      const renewed = rows(await requireQuery(transaction).query(
        `UPDATE production_job_execution execution
            SET leased_until = now() + ($3 * interval '1 second'), updated_at = now()
           FROM master_image_generation generation
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND generation.job_id = execution.job_id
        RETURNING execution.id`,
        [safeJobId, safeLeaseToken, safeLeaseSeconds]
      ));
      if (renewed.length !== 1) throw Object.assign(new Error("Master-image lease was lost"), { code: "master_lease_lost" });
      return { renewed: true };
    });
  }

  async _insertOutboxExact(tx, job) {
    const payload = JSON.stringify({ name: job.name, data: job.data, options: job.options });
    const inserted = rows(await tx.query(
      `INSERT INTO outbox_job
        (id, aggregate_type, aggregate_id, job_name, payload, dedupe_key, status)
       VALUES ($1, 'production_run', $2, $3, $4::jsonb, $5, 'pending')
       ON CONFLICT (dedupe_key) DO UPDATE
         SET updated_at = outbox_job.updated_at
       WHERE outbox_job.aggregate_type = 'production_run'
         AND outbox_job.aggregate_id = EXCLUDED.aggregate_id
         AND outbox_job.job_name = EXCLUDED.job_name
         AND outbox_job.payload = EXCLUDED.payload
       RETURNING id`,
      [this.idFactory(), job.data.runId, job.name, payload, job.dedupeKey]
    ));
    if (inserted.length !== 1) throw new Error("Outbox dedupe key is bound to different master-image work");
  }

  async saveMasterResult({ jobId, leaseToken, artifact, qaReport, policyVersion, processorVersion, finalizerJob } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const normalizedArtifact = normalizeArtifact(artifact, { normalized: true });
    const qa = normalizeQaReport(qaReport);
    const safePolicy = requiredString(policyVersion, "Master QA policy version", 128);
    const safeProcessor = requiredString(processorVersion, "Master processor version", 128);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const lockedRun = await this._lockRunForExecutionJob(tx, safeJobId);
      const binding = oneRow(await tx.query(
        `SELECT generation.*, execution.id AS execution_id,
                execution.run_id AS execution_run_id,
                execution.job_name AS execution_job_name,
                run.character_revision_id
           FROM master_image_generation generation
           JOIN production_job_execution execution ON execution.job_id = generation.job_id
           JOIN production_run run ON run.id = generation.run_id
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
            AND execution.leased_until > now()
            AND generation.status = 'provider_archived'
            AND generation.provider_output_asset_id IS NOT NULL
            AND generation.processing_policy_version = $3
            AND generation.processor_version = $4
          FOR UPDATE OF generation, execution`,
        [safeJobId, safeLeaseToken, safePolicy, safeProcessor]
      ), "Master result is not bound to the active execution");
      const expectedFinalizer = binding.kind === "awake" ? JOB_NAMES.FINALIZE_AWAKE : JOB_NAMES.FINALIZE_SLEEP;
      const safeFinalizer = assertRunWorkflowJob(finalizerJob, { expectedName: expectedFinalizer, runId: binding.run_id });
      const mediaAssetId = await this._insertMediaExact(tx, {
        projectId: binding.project_id,
        runId: binding.run_id,
        kind: `${binding.kind}_master`,
        artifact: normalizedArtifact
      });
      const qaReportId = this.idFactory();
      const qaRows = rows(await tx.query(
        `INSERT INTO qa_report
          (id, project_id, run_id, action_id, subject_kind, status, policy_version,
           report, source_media_asset_id, subject_media_asset_id, processor_version)
         VALUES ($1, $2, $3, NULL, 'image', $4, $5, $6::jsonb, $7, $8, $9)
         RETURNING id`,
        [
          qaReportId, binding.project_id, binding.run_id, qa.report.ok ? "passed" : "failed",
          safePolicy, qa.serialized, binding.provider_output_asset_id, mediaAssetId, safeProcessor
        ]
      ));
      if (qaRows.length !== 1) throw new Error("Master image QA report could not be persisted");
      const candidateId = this.idFactory();
      const modelReference = normalizeModelReference(binding.model_reference);
      const candidates = rows(await tx.query(
        `INSERT INTO image_candidate
          (id, project_id, run_id, order_id, media_asset_id, kind, parent_candidate_id,
           model_registry_version, provider_request_id, qa_status, qa_report_id, generation_attempt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          candidateId, binding.project_id, binding.run_id, binding.order_id, mediaAssetId, binding.kind,
          binding.parent_awake_candidate_id, modelReference.registryVersion,
          binding.provider_request_id, qa.report.ok ? "passed" : "failed", qaReportId,
          Number(binding.generation_attempt)
        ]
      ));
      if (candidates.length !== 1) throw new Error("Master image candidate could not be persisted");
      if (binding.kind === "sleep" && qa.report.ok) {
        const revision = rows(await tx.query(
          `UPDATE character_revision
              SET sleep_candidate_id = COALESCE(sleep_candidate_id, $2)
            WHERE id = $1
              AND project_id = $3
              AND awake_candidate_id = $4
              AND (sleep_candidate_id IS NULL OR sleep_candidate_id = $2)
          RETURNING id`,
          [lockedRun.character_revision_id, candidateId, binding.project_id, binding.parent_awake_candidate_id]
        ));
        if (revision.length !== 1) throw new Error("Sleeping master could not be bound to the approved character revision");
      }
      const status = qa.report.ok ? "qa_passed" : "qa_failed";
      const generation = rows(await tx.query(
        `UPDATE master_image_generation
            SET normalized_media_asset_id = $2, image_candidate_id = $3, qa_report_id = $4,
                finalizer_job_id = $5, status = $6, updated_at = now()
          WHERE id = $1 AND status = 'provider_archived'
        RETURNING id`,
        [binding.id, mediaAssetId, candidateId, qaReportId, safeFinalizer.dedupeKey, status]
      ));
      if (generation.length !== 1) throw new Error("Master generation result could not be committed");
      await this._insertOutboxExact(tx, safeFinalizer);
      const execution = rows(await tx.query(
        `UPDATE production_job_execution
            SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
                leased_until = NULL, completed_at = now(), updated_at = now()
          WHERE id = $1 AND lease_token = $2::uuid AND status = 'leased'
        RETURNING id`,
        [binding.execution_id, safeLeaseToken]
      ));
      if (execution.length !== 1) throw new Error("Master generation execution could not be completed");
      this.logger.info?.("petpack.persistence.master_result_saved", {
        runId: binding.run_id,
        kind: binding.kind,
        qaPassed: qa.report.ok
      });
      return { candidateId, mediaAssetId, qaReportId, qaPassed: qa.report.ok };
    });
  }

  async releaseMasterClaimForRetry({ jobId, leaseToken, errorCode } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const code = normalizeErrorCode(errorCode, "master_image_processing_failed");
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const run = await this._lockRunForExecutionJob(tx, safeJobId);
      const binding = oneRow(await tx.query(
        `SELECT execution.id AS execution_id, execution.attempts, execution.max_attempts,
                generation.id AS generation_id, generation.run_id
           FROM production_job_execution execution
           JOIN master_image_generation generation ON generation.job_id = execution.job_id
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
          FOR UPDATE OF execution, generation`,
        [safeJobId, safeLeaseToken]
      ), "Master-image retry release is not bound to an active lease");
      const exhausted = Number(binding.attempts) >= Number(binding.max_attempts);
      await tx.query(
        `UPDATE production_job_execution
            SET status = $3, lease_token = NULL, lease_owner = NULL, leased_until = NULL,
                last_error_code = $4, updated_at = now()
          WHERE id = $1 AND lease_token = $2::uuid`,
        [binding.execution_id, safeLeaseToken, exhausted ? "dead" : "retryable", code]
      );
      await tx.query(
        `UPDATE master_image_generation
            SET status = CASE WHEN $2::boolean THEN 'dead' ELSE status END,
                last_error_code = $3, updated_at = now()
          WHERE id = $1`,
        [binding.generation_id, exhausted, code]
      );
      if (exhausted) {
        await this._failRun(tx, run, code);
      }
      return { status: exhausted ? "dead" : "retryable" };
    });
  }

  async claimMasterFinalization({ jobId, jobName, runId, maxAttempts, leaseSeconds, leaseOwner } = {}) {
    const kind = FINALIZER_JOB_KIND[jobName];
    if (!kind) throw new Error("Unsupported master-image finalizer job");
    const input = {
      jobId: requiredString(jobId, "Queue job ID"),
      jobName,
      runId: requiredString(runId, "Production run ID", 128),
      maxAttempts: positiveInteger(maxAttempts, "Maximum attempts", 100),
      leaseSeconds: positiveInteger(leaseSeconds, "Execution lease seconds", 3600),
      leaseOwner: requiredString(leaseOwner, "Execution lease owner", 256)
    };
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await tx.query(
        `INSERT INTO production_job_execution
          (id, job_id, job_name, run_id, action_id, status, attempts, max_attempts)
         VALUES ($1, $2, $3, $4, NULL, 'pending', 0, $5)
         ON CONFLICT (job_id) DO NOTHING`,
        [this.idFactory(), input.jobId, input.jobName, input.runId, input.maxAttempts]
      );
      const run = await this._loadRun(tx, input.runId);
      const execution = await this._loadExecution(tx, input.jobId);
      if (execution.job_name !== input.jobName || execution.execution_run_id !== input.runId || execution.action_id !== null) {
        throw new Error("Master finalizer queue ID is bound to different work");
      }
      if (Number(execution.max_attempts) !== input.maxAttempts) throw new Error("Master finalizer retry policy changed");
      const generation = oneRow(await tx.query(
        `SELECT generation.*, candidate.qa_status,
                output.id AS output_asset_id, output.object_key AS output_object_key,
                output.sha256 AS output_sha256, output.byte_size AS output_byte_size,
                output.content_type AS output_content_type,
                awake.id AS awake_asset_id, awake.object_key AS awake_object_key,
                awake.sha256 AS awake_sha256, awake.byte_size AS awake_byte_size,
                awake.content_type AS awake_content_type
           FROM master_image_generation generation
           JOIN image_candidate candidate ON candidate.id = generation.image_candidate_id
           JOIN media_asset output ON output.id = generation.normalized_media_asset_id
           LEFT JOIN image_candidate awake_candidate ON awake_candidate.id = generation.parent_awake_candidate_id
           LEFT JOIN media_asset awake ON awake.id = awake_candidate.media_asset_id
          WHERE generation.finalizer_job_id = $1
            AND generation.run_id = $2
            AND generation.kind = $3
            AND generation.status IN ('qa_passed', 'qa_failed')
          FOR UPDATE OF generation, candidate, output`,
        [input.jobId, input.runId, kind]
      ), "Finalized master-image result was not found");
      const qaPassed = generation.status === "qa_passed" && generation.qa_status === "passed";
      if (qaPassed !== (generation.status === "qa_passed")) throw new Error("Master generation and candidate QA states disagree");
      const mappedRun = mapRun(run);
      if (isFinalizedState({ kind, qaPassed, generationAttempt: Number(generation.generation_attempt), run: mappedRun })) {
        await this._markExecutionSucceeded(tx, execution.execution_id);
        return { outcome: "already_finalized", runId: input.runId, kind };
      }
      if (execution.execution_status === "succeeded") {
        throw new Error("Master finalizer completed before the production transition was committed");
      }
      const expectedState = kind === "awake" ? PRODUCTION_STATES.AWAKE_GENERATING : PRODUCTION_STATES.SLEEP_GENERATING;
      if (mappedRun.state !== expectedState) throw new Error("Master finalizer is not current for the production run");
      if (execution.lease_active) return { outcome: "busy", runId: input.runId, kind };
      if (execution.execution_status === "dead") return { outcome: "dead", runId: input.runId, kind };
      if (!["pending", "retryable", "leased"].includes(execution.execution_status)) {
        throw new Error("Master finalizer has an unsupported recoverable state");
      }
      const previousAttempts = Number(execution.attempts);
      if (previousAttempts >= input.maxAttempts) {
        await tx.query(
          `UPDATE production_job_execution
              SET status = 'dead', lease_token = NULL, lease_owner = NULL,
                  leased_until = NULL, last_error_code = 'master_finalization_exhausted', updated_at = now()
            WHERE id = $1`,
          [execution.execution_id]
        );
        await this._failRun(tx, run, "master_finalization_exhausted");
        return { outcome: "dead", runId: input.runId, kind };
      }
      const leaseToken = this.idFactory();
      const attempt = previousAttempts + 1;
      await tx.query(
        `UPDATE production_job_execution
            SET status = 'leased', attempts = $2, lease_token = $3, lease_owner = $4,
                leased_until = now() + ($5 * interval '1 second'), last_error_code = NULL,
                updated_at = now()
          WHERE id = $1`,
        [execution.execution_id, attempt, leaseToken, input.leaseOwner, input.leaseSeconds]
      );
      const outputMaster = {
        mediaAssetId: generation.output_asset_id,
        objectKey: assertPrivateObjectKey(generation.output_object_key),
        sha256: normalizeSha256(generation.output_sha256, "Finalized master checksum"),
        byteSize: assertPositiveByteSize(Number(generation.output_byte_size), "Finalized master byte size"),
        contentType: requiredString(generation.output_content_type, "Finalized master content type", 256)
      };
      const awakeMaster = kind === "sleep" ? {
        mediaAssetId: generation.awake_asset_id,
        objectKey: assertPrivateObjectKey(generation.awake_object_key),
        sha256: normalizeSha256(generation.awake_sha256, "Approved awake master checksum"),
        byteSize: assertPositiveByteSize(Number(generation.awake_byte_size), "Approved awake master byte size"),
        contentType: requiredString(generation.awake_content_type, "Approved awake master content type", 256)
      } : outputMaster;
      return {
        outcome: "claimed",
        run: mappedRun,
        runId: input.runId,
        orderId: run.order_id,
        kind,
        qaPassed,
        generationId: generation.id,
        generationAttempt: Number(generation.generation_attempt),
        candidateId: generation.image_candidate_id,
        awakeCandidateId: generation.parent_awake_candidate_id || generation.image_candidate_id,
        awakeMaster,
        sleepMaster: kind === "sleep" ? outputMaster : null,
        leaseToken,
        attempt
      };
    });
  }

  async completeMasterFinalization({ jobId, leaseToken } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      await this._lockRunForExecutionJob(tx, safeJobId);
      const row = oneRow(await tx.query(
        `SELECT execution.id AS execution_id, execution.job_name,
                generation.kind, generation.generation_attempt, generation.status,
                run.id AS run_id, run.project_id, run.order_id, run.character_revision_id,
                run.state AS run_state, run.awake_generation_attempts, run.sleep_generation_attempts,
                run.failure_code, run.version AS run_version
           FROM production_job_execution execution
           JOIN master_image_generation generation ON generation.finalizer_job_id = execution.job_id
           JOIN production_run run ON run.id = generation.run_id
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
          FOR UPDATE OF execution, generation`,
        [safeJobId, safeLeaseToken]
      ), "Master finalizer completion is not bound to an active lease");
      const qaPassed = row.status === "qa_passed";
      if (!isFinalizedState({
        kind: row.kind,
        qaPassed,
        generationAttempt: Number(row.generation_attempt),
        run: mapRun(row)
      })) {
        throw new Error("Production run did not commit the master-image finalization");
      }
      const completed = rows(await tx.query(
        `UPDATE production_job_execution
            SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
                leased_until = NULL, completed_at = now(), updated_at = now()
          WHERE id = $1 AND lease_token = $2::uuid AND status = 'leased'
        RETURNING id`,
        [row.execution_id, safeLeaseToken]
      ));
      if (completed.length !== 1) throw new Error("Master finalizer execution could not be completed");
      return { status: "succeeded", runId: row.run_id, kind: row.kind };
    });
  }

  async releaseMasterFinalizationForRetry({ jobId, leaseToken, errorCode } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLeaseToken = requiredString(leaseToken, "Execution lease token", 128);
    const code = normalizeErrorCode(errorCode, "master_finalization_failed");
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const execution = oneRow(await tx.query(
        `SELECT id, attempts, max_attempts
           FROM production_job_execution
          WHERE job_id = $1 AND lease_token = $2::uuid AND status = 'leased'
          FOR UPDATE`,
        [safeJobId, safeLeaseToken]
      ), "Master finalizer retry release is not bound to an active lease");
      const exhausted = Number(execution.attempts) >= Number(execution.max_attempts);
      await tx.query(
        `UPDATE production_job_execution
            SET status = $3, lease_token = NULL, lease_owner = NULL, leased_until = NULL,
                last_error_code = $4, updated_at = now()
          WHERE id = $1 AND lease_token = $2::uuid`,
        [execution.id, safeLeaseToken, exhausted ? "dead" : "retryable", code]
      );
      return { status: exhausted ? "dead" : "retryable" };
    });
  }
}

module.exports = {
  FINALIZER_JOB_KIND,
  GENERATION_JOB_KIND,
  PostgresImageMasterWorkerRepository,
  assertRunWorkflowJob,
  canonicalJson,
  isFinalizedState,
  normalizeArtifact,
  normalizeQaReport
};
