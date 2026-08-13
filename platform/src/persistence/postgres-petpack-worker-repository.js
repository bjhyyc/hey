const crypto = require("node:crypto");

const { PRODUCTION_STATES } = require("../domain/production-state-machine");
const {
  PETPACK_BUILD_POLICY_VERSION,
  PETPACK_CONTENT_TYPE,
  PETPACK_VALIDATION_POLICY_VERSION,
  createPackageInputRevision,
  normalizeBoundedJson,
  normalizePackageInputActions,
  normalizePetpackArtifact,
  requiredString
} = require("../petpack/package-contract");
const { assertPrivateObjectKey, normalizeSha256 } = require("../storage/private-object-store");
const { JOB_NAMES } = require("../workflow/production-workflow");

const PACKAGE_JOB_NAMES = new Set([
  JOB_NAMES.PROCESS_MEDIA,
  JOB_NAMES.BUILD_PACKAGE,
  JOB_NAMES.VALIDATE_PACKAGE,
  JOB_NAMES.DELIVERY_READY
]);

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

function rows(result) {
  return Array.isArray(result && result.rows) ? result.rows : [];
}

function oneRow(result, message) {
  const found = rows(result);
  if (found.length !== 1) throw new Error(message);
  return found[0];
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeErrorCode(value, fallback = "petpack_job_failed") {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
    ? value.toLowerCase()
    : fallback;
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

function normalizeRunClaimInput({ jobId, runId, maxAttempts, leaseSeconds, leaseOwner } = {}) {
  return {
    jobId: requiredString(jobId, "Queue job ID"),
    runId: requiredString(runId, "Production run ID", 128),
    maxAttempts: positiveInteger(maxAttempts, "Maximum attempts", 100),
    leaseSeconds: positiveInteger(leaseSeconds, "Execution lease seconds", 3600),
    leaseOwner: requiredString(leaseOwner, "Execution lease owner", 256)
  };
}

function assertRunWorkflowJob(job, { expectedName, runId } = {}) {
  if (!job || job.name !== expectedName || job.dedupeKey !== job.options?.jobId) {
    throw new Error("A deterministic run-level workflow job is required");
  }
  if (!job.data || (runId !== undefined && job.data.runId !== runId) ||
      Object.keys(job.data).some((key) => key !== "runId")) {
    throw new Error("Run-level workflow job payload may contain only its production run ID");
  }
  if (!Number.isInteger(job.options?.attempts) || job.options.attempts < 1 || job.options.attempts > 100) {
    throw new Error("Run-level workflow job requires a bounded attempt limit");
  }
  return job;
}

function mapActionRow(row) {
  return {
    actionId: row.action_id,
    generationActionId: row.generation_action_id,
    mediaAssetId: row.media_asset_id,
    qaReportId: row.qa_report_id,
    promptVersionId: row.prompt_version_id,
    promptVersionLabel: row.prompt_version_label,
    objectKey: assertPrivateObjectKey(row.object_key),
    sha256: normalizeSha256(row.sha256, `${row.action_id} action checksum`),
    byteSize: Number(row.byte_size),
    contentType: row.content_type,
    processingPolicyVersion: row.processing_policy_version,
    processorVersion: row.processor_version,
    qa: parseJsonObject(row.qa_report, `${row.action_id} action QA report`)
  };
}

function mapActions(result) {
  return normalizePackageInputActions(rows(result).map(mapActionRow));
}

function normalizeValidationDescriptor(value) {
  if (!value || typeof value !== "object") throw new Error("PetPack validator descriptor is required");
  return {
    policyVersion: requiredString(value.policyVersion, "PetPack validation policy version", 128),
    validatorVersion: requiredString(value.validatorVersion, "PetPack validator version", 128),
    validatorIdentity: requiredString(value.validatorIdentity, "PetPack validator identity", 1024)
  };
}

function normalizeClaimedPetpackArtifact(value) {
  return {
    mediaAssetId: requiredString(value?.mediaAssetId, "PetPack media asset ID", 128),
    ...normalizePetpackArtifact(value)
  };
}

class PostgresPetpackWorkerRepository {
  constructor({ database, idFactory = crypto.randomUUID, logger = console } = {}) {
    this.database = requireDatabase(database);
    if (typeof idFactory !== "function") throw new Error("A UUID ID factory is required");
    this.idFactory = idFactory;
    this.logger = logger;
  }

  async _insertExecution(tx, claim, jobName) {
    if (!PACKAGE_JOB_NAMES.has(jobName)) throw new Error("Unsupported PetPack run-level job name");
    await tx.query(
      `INSERT INTO production_job_execution
        (id, job_id, job_name, run_id, action_id, status, attempts, max_attempts)
       VALUES ($1, $2, $3, $4, NULL, 'pending', 0, $5)
       ON CONFLICT DO NOTHING`,
      [this.idFactory(), claim.jobId, jobName, claim.runId, claim.maxAttempts]
    );
    const execution = oneRow(await tx.query(
      `SELECT id, job_id, job_name, run_id, action_id, status, attempts, max_attempts,
              lease_token, leased_until,
              (status = 'leased' AND leased_until > now()) AS lease_active
         FROM production_job_execution
        WHERE job_id = $1
           OR (run_id = $2 AND job_name = $3 AND action_id IS NULL)
        FOR UPDATE`,
      [claim.jobId, claim.runId, jobName]
    ), "PetPack execution could not be created or recovered");
    if (execution.job_id !== claim.jobId || execution.job_name !== jobName || execution.run_id !== claim.runId || execution.action_id !== null) {
      throw new Error("PetPack queue job is already bound to another run or stage");
    }
    if (Number(execution.max_attempts) !== claim.maxAttempts) {
      throw new Error("PetPack queue retry policy changed after execution was created");
    }
    return execution;
  }

  async _loadRun(tx, runId, { lock = true } = {}) {
    if (!lock) {
      return oneRow(await tx.query(
        `SELECT run.id AS run_id, run.project_id, run.order_id, run.state AS run_state,
                run.version AS run_version, order_record.status AS order_status,
                order_record.delivery_status AS order_delivery_status,
                project.display_name AS project_name, project.state AS project_state
           FROM production_run run
           JOIN customer_order order_record
             ON order_record.id = run.order_id AND order_record.project_id = run.project_id
           JOIN pet_project project ON project.id = run.project_id
          WHERE run.id = $1`,
        [runId]
      ), "PetPack production run was not found");
    }
    // Cross-service lock order is explicit: run -> order -> project -> delivery
    // -> build/assets/QA. Multi-table FOR UPDATE does not promise tuple-lock
    // acquisition order and can deadlock with refund/download transactions.
    const run = oneRow(await tx.query(
      `SELECT id AS run_id, project_id, order_id, state AS run_state, version AS run_version
         FROM production_run WHERE id = $1 FOR UPDATE`,
      [runId]
    ), "PetPack production run was not found");
    const order = oneRow(await tx.query(
      `SELECT status AS order_status, delivery_status AS order_delivery_status
         FROM customer_order
        WHERE id = $1 AND project_id = $2
        FOR UPDATE`,
      [run.order_id, run.project_id]
    ), "PetPack production order ownership is invalid");
    const project = oneRow(await tx.query(
      `SELECT display_name AS project_name, state AS project_state
         FROM pet_project WHERE id = $1 FOR UPDATE`,
      [run.project_id]
    ), "PetPack production project was not found");
    return { ...run, ...order, ...project };
  }

  async _leaseExecution(tx, execution, claim) {
    if (execution.status === "succeeded") return { outcome: "already_completed" };
    if (execution.status === "dead" || execution.status === "reconciliation_required") return { outcome: execution.status };
    if (execution.lease_active) {
      const remaining = new Date(execution.leased_until).getTime() - Date.now();
      return { outcome: "busy", retryAfterMs: Math.max(1000, Number.isFinite(remaining) ? remaining : 1000) };
    }
    const attempts = Number(execution.attempts);
    if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error("PetPack execution attempt count is invalid");
    if (attempts >= claim.maxAttempts) {
      await tx.query(
        `UPDATE production_job_execution
            SET status = 'dead', lease_token = NULL, lease_owner = NULL,
                leased_until = NULL, updated_at = now()
          WHERE id = $1`,
        [execution.id]
      );
      return { outcome: "dead", exhausted: true };
    }
    const leaseToken = this.idFactory();
    const attempt = attempts + 1;
    const leased = rows(await tx.query(
      `UPDATE production_job_execution
          SET status = 'leased', attempts = $2, lease_token = $3, lease_owner = $4,
              leased_until = now() + ($5 * interval '1 second'),
              last_error_code = NULL, updated_at = now()
        WHERE id = $1
      RETURNING id`,
      [execution.id, attempt, leaseToken, claim.leaseOwner, claim.leaseSeconds]
    ));
    if (leased.length !== 1) throw new Error("PetPack execution lease could not be acquired");
    return { outcome: "claimed", leaseToken, attempt };
  }

  async _loadCurrentActions(tx, runId, { lock = false } = {}) {
    return mapActions(await tx.query(
      `SELECT action.id AS generation_action_id, action.action_id,
              action.media_asset_id, action.qa_report_id,
              action.prompt_version_id, action.prompt_version_label,
              action.processing_policy_version, action.processor_version,
              asset.object_key, asset.sha256, asset.byte_size, asset.content_type,
              qa.report AS qa_report
         FROM generation_action action
         JOIN production_run run ON run.id = action.run_id
         JOIN media_asset asset
           ON asset.id = action.media_asset_id
          AND asset.project_id = run.project_id
          AND asset.run_id = run.id
          AND asset.kind = 'action_video'
          AND asset.content_type = 'video/webm'
          AND asset.deleted_at IS NULL
          AND (asset.expires_at IS NULL OR asset.expires_at > now())
         JOIN qa_report qa
           ON qa.id = action.qa_report_id
          AND qa.project_id = run.project_id
          AND qa.run_id = run.id
          AND qa.action_id = action.action_id
          AND qa.subject_kind = 'video'
          AND qa.status = 'passed'
          AND qa.source_media_asset_id = action.provider_output_asset_id
          AND qa.subject_media_asset_id = asset.id
          AND qa.policy_version = action.processing_policy_version
          AND qa.processor_version = action.processor_version
         JOIN media_asset source
           ON source.id = action.provider_output_asset_id
          AND source.project_id = run.project_id
          AND source.run_id = run.id
          AND source.kind = 'provider_output'
         JOIN prompt_version prompt
           ON prompt.id = action.prompt_version_id
          AND prompt.version = action.prompt_version_label
        WHERE action.run_id = $1
          AND action.state = 'qa_passed'
        ORDER BY action.action_id
        ${lock ? "FOR UPDATE OF action, asset, qa" : ""}`,
      [runId]
    ));
  }

  async _loadSnapshotActions(tx, { snapshotId, runId, lock = false }) {
    return mapActions(await tx.query(
      `SELECT action.id AS generation_action_id, input.action_id,
              input.media_asset_id, input.qa_report_id,
              input.prompt_version_id, input.prompt_version_label,
              input.processing_policy_version, input.processor_version,
              asset.object_key, asset.sha256, asset.byte_size, asset.content_type,
              qa.report AS qa_report
         FROM petpack_input_action input
         JOIN generation_action action
           ON action.id = input.generation_action_id
          AND action.run_id = $2
          AND action.action_id = input.action_id
          AND action.state = 'qa_passed'
          AND action.media_asset_id = input.media_asset_id
          AND action.qa_report_id = input.qa_report_id
          AND action.prompt_version_id = input.prompt_version_id
          AND action.prompt_version_label = input.prompt_version_label
          AND action.processing_policy_version = input.processing_policy_version
          AND action.processor_version = input.processor_version
         JOIN production_run run ON run.id = action.run_id
         JOIN media_asset asset
           ON asset.id = input.media_asset_id
          AND asset.project_id = run.project_id
          AND asset.run_id = run.id
          AND asset.kind = 'action_video'
          AND asset.sha256 = input.media_sha256
          AND asset.content_type = 'video/webm'
          AND asset.deleted_at IS NULL
          AND (asset.expires_at IS NULL OR asset.expires_at > now())
         JOIN qa_report qa
           ON qa.id = input.qa_report_id
          AND qa.project_id = run.project_id
          AND qa.run_id = run.id
          AND qa.action_id = input.action_id
          AND qa.subject_kind = 'video'
          AND qa.status = 'passed'
          AND qa.source_media_asset_id = action.provider_output_asset_id
          AND qa.subject_media_asset_id = input.media_asset_id
          AND qa.policy_version = input.processing_policy_version
          AND qa.processor_version = input.processor_version
        WHERE input.snapshot_id = $1
        ORDER BY input.action_id
        ${lock ? "FOR UPDATE OF input, action, asset, qa" : ""}`,
      [snapshotId, runId]
    ));
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
    if (inserted.length !== 1) throw new Error("Outbox dedupe key is bound to different package work");
  }

  async _advanceRun(tx, run, fromState, toState, failureCode = null) {
    const updated = oneRow(await tx.query(
      `UPDATE production_run
          SET state = $3, failure_code = $4, version = version + 1, updated_at = now()
        WHERE id = $1 AND state = $2 AND version = $5
      RETURNING version`,
      [run.run_id, fromState, toState, failureCode, Number(run.run_version)]
    ), "Production run changed while committing package work");
    await tx.query(
      `INSERT INTO production_run_event
        (id, run_id, previous_state, next_state, expected_version, resulting_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [this.idFactory(), run.run_id, fromState, toState, Number(run.run_version), Number(updated.version)]
    );
    return Number(updated.version);
  }

  async _completeExecution(tx, { jobId, leaseToken }) {
    const completed = rows(await tx.query(
      `UPDATE production_job_execution
          SET status = 'succeeded', lease_token = NULL, lease_owner = NULL,
              leased_until = NULL, completed_at = COALESCE(completed_at, now()), updated_at = now()
        WHERE job_id = $1 AND lease_token = $2::uuid
          AND status = 'leased' AND leased_until > now()
      RETURNING id`,
      [jobId, leaseToken]
    ));
    if (completed.length !== 1) throw new Error("Active PetPack execution lease was lost before commit");
  }

  async _failRun(tx, run, failureCode) {
    if ([PRODUCTION_STATES.FAILED, PRODUCTION_STATES.DELIVERABLE].includes(run.run_state)) return;
    await this._advanceRun(tx, run, run.run_state, PRODUCTION_STATES.FAILED, failureCode);
    await tx.query(
      `UPDATE pet_project SET state = 'failed', updated_at = now()
        WHERE id = $1 AND state <> 'deliverable'`,
      [run.project_id]
    );
  }

  async claimMediaSnapshot(input = {}) {
    const claim = normalizeRunClaimInput(input);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const execution = await this._insertExecution(tx, claim, JOB_NAMES.PROCESS_MEDIA);
      const run = await this._loadRun(tx, claim.runId);
      if (execution.status === "succeeded") return { outcome: "already_completed", runId: claim.runId };
      if (run.order_status !== "paid") throw new Error("Only a paid order may enter PetPack packaging");
      if (run.run_state !== PRODUCTION_STATES.MEDIA_PROCESSING) {
        throw new Error("Production run is not at the seven-action media gate");
      }
      const actions = await this._loadCurrentActions(tx, claim.runId, { lock: true });
      const lease = await this._leaseExecution(tx, execution, claim);
      if (lease.exhausted) await this._failRun(tx, run, "package_media_gate_attempts_exhausted");
      if (lease.outcome !== "claimed") return { ...lease, runId: claim.runId };
      return {
        ...lease,
        runId: run.run_id,
        projectId: run.project_id,
        orderId: run.order_id,
        projectName: requiredString(run.project_name, "Pet project display name", 256),
        runVersion: Number(run.run_version),
        actions
      };
    });
  }

  async completeMediaSnapshot({ jobId, leaseToken, revisionSha256, packageName, actions, buildJob } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLease = requiredString(leaseToken, "Execution lease token", 128);
    const safePackageName = requiredString(packageName, "Frozen PetPack display name", 256);
    const normalizedActions = normalizePackageInputActions(actions);
    const revision = normalizeSha256(revisionSha256, "Package input revision");
    assertRunWorkflowJob(buildJob, { expectedName: JOB_NAMES.BUILD_PACKAGE });
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const execution = oneRow(await tx.query(
        `SELECT id, run_id
           FROM production_job_execution
          WHERE job_id = $1 AND lease_token = $2::uuid
            AND job_name = $3 AND status = 'leased' AND leased_until > now()
          FOR UPDATE`,
        [safeJobId, safeLease, JOB_NAMES.PROCESS_MEDIA]
      ), "Active media-gate execution lease was not found");
      const run = await this._loadRun(tx, execution.run_id);
      assertRunWorkflowJob(buildJob, { expectedName: JOB_NAMES.BUILD_PACKAGE, runId: run.run_id });
      if (run.run_state !== PRODUCTION_STATES.MEDIA_PROCESSING || run.order_status !== "paid") {
        throw new Error("Production run left the media gate before its snapshot committed");
      }
      if (requiredString(run.project_name, "Pet project display name", 256) !== safePackageName) {
        throw new Error("Pet project display name changed before package input snapshot commit");
      }
      const computed = createPackageInputRevision({
        runId: run.run_id,
        packageName: safePackageName,
        actions: normalizedActions
      });
      if (computed.revisionSha256 !== revision) {
        throw new Error("Package input revision does not match its frozen name and seven actions");
      }
      const live = createPackageInputRevision({
        runId: run.run_id,
        packageName: safePackageName,
        actions: await this._loadCurrentActions(tx, run.run_id, { lock: true })
      });
      if (live.revisionSha256 !== revision) throw new Error("Seven-action inputs changed before snapshot commit");

      const snapshotId = this.idFactory();
      const snapshot = rows(await tx.query(
        `INSERT INTO petpack_input_snapshot (id, run_id, revision_sha256, package_name, action_count)
         VALUES ($1, $2, $3, $4, 7)
         ON CONFLICT (run_id) DO UPDATE
           SET revision_sha256 = petpack_input_snapshot.revision_sha256
         WHERE petpack_input_snapshot.revision_sha256 = EXCLUDED.revision_sha256
           AND petpack_input_snapshot.package_name = EXCLUDED.package_name
           AND petpack_input_snapshot.action_count = 7
         RETURNING id`,
        [snapshotId, run.run_id, revision, safePackageName]
      ));
      if (snapshot.length !== 1) throw new Error("Production run already has a different package input snapshot");
      const persistedSnapshotId = snapshot[0].id;
      for (const action of live.actions) {
        const persisted = rows(await tx.query(
          `INSERT INTO petpack_input_action
            (snapshot_id, action_id, generation_action_id, media_asset_id, qa_report_id,
             prompt_version_id, prompt_version_label, media_sha256,
             processing_policy_version, processor_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (snapshot_id, action_id) DO UPDATE
             SET media_sha256 = petpack_input_action.media_sha256
           WHERE petpack_input_action.generation_action_id = EXCLUDED.generation_action_id
             AND petpack_input_action.media_asset_id = EXCLUDED.media_asset_id
             AND petpack_input_action.qa_report_id = EXCLUDED.qa_report_id
             AND petpack_input_action.prompt_version_id = EXCLUDED.prompt_version_id
             AND petpack_input_action.prompt_version_label = EXCLUDED.prompt_version_label
             AND petpack_input_action.media_sha256 = EXCLUDED.media_sha256
             AND petpack_input_action.processing_policy_version = EXCLUDED.processing_policy_version
             AND petpack_input_action.processor_version = EXCLUDED.processor_version
           RETURNING action_id`,
          [
            persistedSnapshotId, action.actionId, action.generationActionId, action.mediaAssetId,
            action.qaReportId, action.promptVersionId, action.promptVersionLabel, action.sha256,
            action.processingPolicyVersion, action.processorVersion
          ]
        ));
        if (persisted.length !== 1) throw new Error(`${action.actionId} snapshot conflicts with persisted package input`);
      }
      await this._advanceRun(tx, run, PRODUCTION_STATES.MEDIA_PROCESSING, PRODUCTION_STATES.PACKAGING);
      await this._insertOutboxExact(tx, buildJob);
      await this._completeExecution(tx, { jobId: safeJobId, leaseToken: safeLease });
      return { snapshotId: persistedSnapshotId, revisionSha256: revision };
    });
  }

  async claimPackageBuild(input = {}) {
    const claim = normalizeRunClaimInput(input);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const execution = await this._insertExecution(tx, claim, JOB_NAMES.BUILD_PACKAGE);
      const run = await this._loadRun(tx, claim.runId);
      if (execution.status === "succeeded") return { outcome: "already_completed", runId: claim.runId };
      if (run.order_status !== "paid" || run.run_state !== PRODUCTION_STATES.PACKAGING) {
        throw new Error("Production run is not ready for PetPack construction");
      }
      const snapshot = oneRow(await tx.query(
        `SELECT id, revision_sha256, package_name, action_count
           FROM petpack_input_snapshot WHERE run_id = $1 FOR UPDATE`,
        [run.run_id]
      ), "PetPack input snapshot was not found");
      if (Number(snapshot.action_count) !== 7) throw new Error("PetPack input snapshot is incomplete");
      const actions = await this._loadSnapshotActions(tx, { snapshotId: snapshot.id, runId: run.run_id });
      const computed = createPackageInputRevision({
        runId: run.run_id,
        packageName: snapshot.package_name,
        actions
      });
      if (computed.revisionSha256 !== snapshot.revision_sha256) throw new Error("PetPack input snapshot checksum is invalid");
      const existing = rows(await tx.query("SELECT id FROM petpack_build WHERE run_id = $1", [run.run_id]));
      if (existing.length > 0) throw new Error("Unfinalized package execution found an existing build");
      const lease = await this._leaseExecution(tx, execution, claim);
      if (lease.exhausted) await this._failRun(tx, run, "package_build_attempts_exhausted");
      if (lease.outcome !== "claimed") return { ...lease, runId: claim.runId };
      return {
        ...lease,
        runId: run.run_id,
        projectId: run.project_id,
        orderId: run.order_id,
        projectName: snapshot.package_name,
        snapshotId: snapshot.id,
        revisionSha256: snapshot.revision_sha256,
        actions
      };
    });
  }

  async renewRunJobLease({ jobId, leaseToken, leaseSeconds } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLease = requiredString(leaseToken, "Execution lease token", 128);
    const seconds = positiveInteger(leaseSeconds, "Execution lease seconds", 3600);
    return this.database.transaction(async (transaction) => {
      const renewed = rows(await requireQuery(transaction).query(
        `UPDATE production_job_execution
            SET leased_until = now() + ($3 * interval '1 second'), updated_at = now()
          WHERE job_id = $1 AND lease_token = $2::uuid
            AND status = 'leased' AND leased_until > now()
        RETURNING id`,
        [safeJobId, safeLease, seconds]
      ));
      if (renewed.length !== 1) throw new Error("PetPack execution lease could not be renewed");
      return { renewed: true };
    });
  }

  async completePackageBuild({
    jobId,
    leaseToken,
    snapshotId,
    revisionSha256,
    artifact,
    packageId,
    manifest,
    buildReport,
    builderVersion,
    validator,
    validateJob
  } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLease = requiredString(leaseToken, "Execution lease token", 128);
    const safeSnapshotId = requiredString(snapshotId, "PetPack input snapshot ID", 128);
    const revision = normalizeSha256(revisionSha256, "PetPack input revision");
    const storedArtifact = normalizePetpackArtifact(artifact);
    const safePackageId = requiredString(packageId, "PetPack package ID", 128);
    const safeBuilderVersion = requiredString(builderVersion, "PetPack builder version", 128);
    const validationDescriptor = normalizeValidationDescriptor(validator);
    const manifestJson = normalizeBoundedJson(manifest, "PetPack manifest", 256 * 1024);
    if (manifestJson.value.packageId !== safePackageId) throw new Error("PetPack manifest package ID does not match its build identity");
    const reportJson = normalizeBoundedJson(buildReport, "PetPack build report");
    if (reportJson.value.ok !== true || normalizeSha256(reportJson.value.sha256, "Build report checksum") !== storedArtifact.sha256) {
      throw new Error("PetPack build report is not bound to the stored archive");
    }
    assertRunWorkflowJob(validateJob, { expectedName: JOB_NAMES.VALIDATE_PACKAGE });
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const execution = oneRow(await tx.query(
        `SELECT id, run_id
           FROM production_job_execution
          WHERE job_id = $1 AND lease_token = $2::uuid
            AND job_name = $3 AND status = 'leased' AND leased_until > now()
          FOR UPDATE`,
        [safeJobId, safeLease, JOB_NAMES.BUILD_PACKAGE]
      ), "Active package-build execution lease was not found");
      const run = await this._loadRun(tx, execution.run_id);
      assertRunWorkflowJob(validateJob, { expectedName: JOB_NAMES.VALIDATE_PACKAGE, runId: run.run_id });
      if (run.run_state !== PRODUCTION_STATES.PACKAGING || run.order_status !== "paid") {
        throw new Error("Production run left packaging before its build committed");
      }
      const snapshot = oneRow(await tx.query(
        `SELECT id, revision_sha256, package_name FROM petpack_input_snapshot
          WHERE id = $1 AND run_id = $2 FOR UPDATE`,
        [safeSnapshotId, run.run_id]
      ), "PetPack input snapshot no longer belongs to the build run");
      const actions = await this._loadSnapshotActions(tx, { snapshotId: snapshot.id, runId: run.run_id, lock: true });
      const live = createPackageInputRevision({
        runId: run.run_id,
        packageName: snapshot.package_name,
        actions
      });
      if (snapshot.revision_sha256 !== revision || live.revisionSha256 !== revision) {
        throw new Error("PetPack build inputs changed before persistence");
      }

      const mediaAssetId = this.idFactory();
      const media = rows(await tx.query(
        `INSERT INTO media_asset
          (id, project_id, run_id, kind, object_key, sha256, content_type, byte_size)
         VALUES ($1, $2, $3, 'final_petpack', $4, $5, $6, $7)
         ON CONFLICT (object_key) DO UPDATE
           SET object_key = media_asset.object_key
         WHERE media_asset.project_id = EXCLUDED.project_id
           AND media_asset.run_id = EXCLUDED.run_id
           AND media_asset.kind = 'final_petpack'
           AND media_asset.sha256 = EXCLUDED.sha256
           AND media_asset.content_type = EXCLUDED.content_type
           AND media_asset.byte_size = EXCLUDED.byte_size
           AND media_asset.deleted_at IS NULL
         RETURNING id`,
        [
          mediaAssetId, run.project_id, run.run_id, storedArtifact.objectKey,
          storedArtifact.sha256, PETPACK_CONTENT_TYPE, storedArtifact.byteSize
        ]
      ));
      if (media.length !== 1) throw new Error("PetPack object key is bound to different media");
      const persistedMediaId = media[0].id;
      const buildId = this.idFactory();
      const build = rows(await tx.query(
        `INSERT INTO petpack_build
          (id, run_id, project_id, order_id, media_asset_id, package_id,
           manifest, sha256, input_snapshot_id, status, builder_version, build_report,
           validation_policy_version, validator_version, validator_identity)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'built', $10, $11::jsonb,
                 $12, $13, $14)
         ON CONFLICT (run_id) DO UPDATE
           SET updated_at = petpack_build.updated_at
         WHERE petpack_build.project_id = EXCLUDED.project_id
           AND petpack_build.order_id = EXCLUDED.order_id
           AND petpack_build.media_asset_id = EXCLUDED.media_asset_id
           AND petpack_build.package_id = EXCLUDED.package_id
           AND petpack_build.manifest = EXCLUDED.manifest
           AND petpack_build.sha256 = EXCLUDED.sha256
           AND petpack_build.input_snapshot_id = EXCLUDED.input_snapshot_id
           AND petpack_build.builder_version = EXCLUDED.builder_version
           AND petpack_build.build_report = EXCLUDED.build_report
           AND petpack_build.validation_policy_version = EXCLUDED.validation_policy_version
           AND petpack_build.validator_version = EXCLUDED.validator_version
           AND petpack_build.validator_identity = EXCLUDED.validator_identity
           AND petpack_build.status = 'built'
         RETURNING id`,
        [
          buildId, run.run_id, run.project_id, run.order_id, persistedMediaId, safePackageId,
          manifestJson.serialized, storedArtifact.sha256, snapshot.id, safeBuilderVersion, reportJson.serialized,
          validationDescriptor.policyVersion, validationDescriptor.validatorVersion, validationDescriptor.validatorIdentity
        ]
      ));
      if (build.length !== 1) throw new Error("Production run already has a different PetPack build");
      await this._advanceRun(tx, run, PRODUCTION_STATES.PACKAGING, PRODUCTION_STATES.VALIDATING);
      await this._insertOutboxExact(tx, validateJob);
      await this._completeExecution(tx, { jobId: safeJobId, leaseToken: safeLease });
      return { buildId: build[0].id, mediaAssetId: persistedMediaId, sha256: storedArtifact.sha256 };
    });
  }

  async claimPackageValidation(input = {}) {
    const claim = normalizeRunClaimInput(input);
    const descriptor = normalizeValidationDescriptor(input.validator);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const execution = await this._insertExecution(tx, claim, JOB_NAMES.VALIDATE_PACKAGE);
      const run = await this._loadRun(tx, claim.runId);
      if (execution.status === "succeeded") return { outcome: "already_completed", runId: claim.runId };
      if (run.order_status !== "paid" || run.run_state !== PRODUCTION_STATES.VALIDATING) {
        throw new Error("Production run is not ready for PetPack delivery validation");
      }
      const build = oneRow(await tx.query(
        `SELECT build.id, build.input_snapshot_id, build.package_id, build.media_asset_id, build.sha256,
                build.status, build.validation_policy_version, build.validator_version,
                build.validator_identity, asset.object_key, asset.sha256 AS asset_sha256,
                asset.byte_size, asset.content_type, asset.deleted_at, asset.expires_at
           FROM petpack_build build
           JOIN media_asset asset
             ON asset.id = build.media_asset_id
            AND asset.project_id = build.project_id
            AND asset.run_id = build.run_id
            AND asset.kind = 'final_petpack'
          WHERE build.run_id = $1
            AND build.project_id = $2
            AND build.order_id = $3
          FOR UPDATE OF build, asset`,
        [run.run_id, run.project_id, run.order_id]
      ), "PetPack build was not found for validation");
      if (!["built", "validating"].includes(build.status) || build.deleted_at ||
          (build.expires_at && new Date(build.expires_at) <= new Date()) ||
          build.sha256 !== build.asset_sha256 || build.content_type !== PETPACK_CONTENT_TYPE) {
        throw new Error("PetPack build has an invalid private archive binding");
      }
      const lease = await this._leaseExecution(tx, execution, claim);
      if (lease.exhausted) await this._failRun(tx, run, "package_validation_attempts_exhausted");
      if (lease.outcome !== "claimed") return { ...lease, runId: claim.runId };
      const bound = rows(await tx.query(
        `UPDATE petpack_build
            SET status = 'validating',
                validation_policy_version = COALESCE(validation_policy_version, $2),
                validator_version = COALESCE(validator_version, $3),
                validator_identity = COALESCE(validator_identity, $4),
                updated_at = now()
          WHERE id = $1
            AND (validation_policy_version IS NULL OR validation_policy_version = $2)
            AND (validator_version IS NULL OR validator_version = $3)
            AND (validator_identity IS NULL OR validator_identity = $4)
        RETURNING id`,
        [build.id, descriptor.policyVersion, descriptor.validatorVersion, descriptor.validatorIdentity]
      ));
      if (bound.length !== 1) throw new Error("PetPack validation identity changed after it was frozen");
      const actions = await this._loadSnapshotActions(tx, {
        snapshotId: build.input_snapshot_id,
        runId: run.run_id
      });
      return {
        ...lease,
        runId: run.run_id,
        projectId: run.project_id,
        orderId: run.order_id,
        buildId: build.id,
        snapshotId: build.input_snapshot_id,
        packageId: build.package_id,
        artifact: {
          mediaAssetId: build.media_asset_id,
          objectKey: build.object_key,
          sha256: build.sha256,
          byteSize: Number(build.byte_size),
          contentType: build.content_type
        },
        validator: descriptor,
        actions
      };
    });
  }

  async getPackageValidationDescriptor({ runId } = {}) {
    const safeRunId = requiredString(runId, "Production run ID", 128);
    return this.database.transaction(async (transaction) => {
      const row = oneRow(await requireQuery(transaction).query(
        `SELECT build.validation_policy_version, build.validator_version, build.validator_identity
           FROM production_run run
           JOIN customer_order order_record
             ON order_record.id = run.order_id AND order_record.project_id = run.project_id
           JOIN petpack_build build
             ON build.run_id = run.id
            AND build.project_id = run.project_id
            AND build.order_id = run.order_id
          WHERE run.id = $1
            AND run.state = 'validating'
            AND order_record.status = 'paid'
            AND build.status IN ('built', 'validating')`,
        [safeRunId]
      ), "Frozen PetPack validator descriptor was not found");
      return normalizeValidationDescriptor({
        policyVersion: row.validation_policy_version,
        validatorVersion: row.validator_version,
        validatorIdentity: row.validator_identity
      });
    });
  }

  async completePackageValidation({ jobId, leaseToken, buildId, artifact, report, deliveryJob } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLease = requiredString(leaseToken, "Execution lease token", 128);
    const safeBuildId = requiredString(buildId, "PetPack build ID", 128);
    const expectedArtifact = normalizeClaimedPetpackArtifact(artifact);
    const qa = normalizeBoundedJson(report, "PetPack delivery validation report", 1024 * 1024);
    if (qa.value.ok !== true || qa.value.archive?.ok !== true || qa.value.media?.ok !== true ||
        qa.value.originalImport?.ok !== true || qa.value.interactions?.ok !== true) {
      throw new Error("PetPack delivery validation report is not fully passing");
    }
    if (normalizeSha256(qa.value.packageSha256, "Validation report package checksum") !== expectedArtifact.sha256 ||
        Number(qa.value.packageByteSize) !== expectedArtifact.byteSize) {
      throw new Error("PetPack validation report is not bound to its claimed archive bytes");
    }
    assertRunWorkflowJob(deliveryJob, { expectedName: JOB_NAMES.DELIVERY_READY });
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const row = oneRow(await tx.query(
        `SELECT execution.run_id, run.project_id, run.order_id, run.state AS run_state,
                build.id AS build_id, build.media_asset_id, build.status AS build_status,
                build.sha256 AS build_sha256,
                build.validation_policy_version, build.validator_version, build.validator_identity,
                asset.object_key, asset.sha256 AS asset_sha256, asset.byte_size, asset.content_type,
                asset.deleted_at, asset.expires_at
           FROM production_job_execution execution
           JOIN production_run run ON run.id = execution.run_id
           JOIN petpack_build build ON build.run_id = run.id
           JOIN media_asset asset
             ON asset.id = build.media_asset_id
            AND asset.project_id = run.project_id
            AND asset.run_id = run.id
            AND asset.kind = 'final_petpack'
          WHERE execution.job_id = $1
            AND execution.lease_token = $2::uuid
            AND execution.job_name = $3
            AND execution.status = 'leased'
            AND execution.leased_until > now()
          FOR UPDATE OF execution, run, build, asset`,
        [safeJobId, safeLease, JOB_NAMES.VALIDATE_PACKAGE]
      ), "Active package-validation execution lease was not found");
      assertRunWorkflowJob(deliveryJob, { expectedName: JOB_NAMES.DELIVERY_READY, runId: row.run_id });
      if (row.build_id !== safeBuildId || row.media_asset_id !== expectedArtifact.mediaAssetId ||
          row.object_key !== expectedArtifact.objectKey || row.run_state !== PRODUCTION_STATES.VALIDATING ||
          row.build_status !== "validating" || row.deleted_at ||
          (row.expires_at && new Date(row.expires_at) <= new Date()) ||
          row.build_sha256 !== expectedArtifact.sha256 || row.asset_sha256 !== expectedArtifact.sha256 ||
          Number(row.byte_size) !== expectedArtifact.byteSize || row.content_type !== expectedArtifact.contentType ||
          row.content_type !== PETPACK_CONTENT_TYPE) {
        throw new Error("PetPack validation bindings changed before commit");
      }
      if (qa.value.policyVersion !== row.validation_policy_version ||
          qa.value.validatorVersion !== row.validator_version ||
          qa.value.validatorIdentity !== row.validator_identity) {
        throw new Error("PetPack validation report does not use the frozen validator policy");
      }
      const packageQaId = this.idFactory();
      const importQaId = this.idFactory();
      const packageReport = normalizeBoundedJson({
        ok: true,
        packageSha256: qa.value.packageSha256,
        packageByteSize: qa.value.packageByteSize,
        validatorIdentity: qa.value.validatorIdentity,
        validatorVersion: qa.value.validatorVersion,
        archive: qa.value.archive,
        media: qa.value.media,
        errors: []
      }, "PetPack package QA report", 768 * 1024);
      const importReport = normalizeBoundedJson({
        ok: true,
        packageSha256: qa.value.packageSha256,
        validatorIdentity: qa.value.validatorIdentity,
        validatorVersion: qa.value.validatorVersion,
        originalImport: qa.value.originalImport,
        interactions: qa.value.interactions,
        errors: []
      }, "Desktop Pet import QA report", 256 * 1024);
      await tx.query(
        `INSERT INTO qa_report
          (id, project_id, run_id, action_id, subject_kind, status, policy_version,
           report, source_media_asset_id, subject_media_asset_id, processor_version,
           petpack_build_id, validator_version)
         VALUES
          ($1, $3, $4, NULL, 'petpack', 'passed', $5, $6::jsonb, NULL, $7, $8, $2, $8),
          ($9, $3, $4, NULL, 'desktop_import', 'passed', $5, $10::jsonb, NULL, $7, $8, $2, $8)`,
        [
          packageQaId, row.build_id, row.project_id, row.run_id, row.validation_policy_version,
          packageReport.serialized, row.media_asset_id, row.validator_version,
          importQaId, importReport.serialized
        ]
      );
      const updated = rows(await tx.query(
        `UPDATE petpack_build
            SET status = 'validated', package_qa_report_id = $2,
                import_qa_report_id = $3,
                original_import_verified_at = now(),
                customized_interactions_verified_at = now(),
                validated_at = now(), failure_code = NULL, updated_at = now()
          WHERE id = $1 AND status = 'validating'
        RETURNING id`,
        [row.build_id, packageQaId, importQaId]
      ));
      if (updated.length !== 1) throw new Error("PetPack build could not be promoted to validated");
      await this._insertOutboxExact(tx, deliveryJob);
      await this._completeExecution(tx, { jobId: safeJobId, leaseToken: safeLease });
      return { buildId: row.build_id, packageQaReportId: packageQaId, importQaReportId: importQaId };
    });
  }

  async failPackageValidation({ jobId, leaseToken, buildId, artifact, report, errorCode = "petpack_validation_failed" } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLease = requiredString(leaseToken, "Execution lease token", 128);
    const safeBuildId = requiredString(buildId, "PetPack build ID", 128);
    const expectedArtifact = normalizeClaimedPetpackArtifact(artifact);
    const code = normalizeErrorCode(errorCode, "petpack_validation_failed");
    const qa = normalizeBoundedJson(report, "Failed PetPack validation report", 1024 * 1024);
    if (qa.value.ok !== false) throw new Error("Failed PetPack validation must record ok=false");
    if (normalizeSha256(qa.value.packageSha256, "Failed validation report package checksum") !== expectedArtifact.sha256 ||
        Number(qa.value.packageByteSize) !== expectedArtifact.byteSize) {
      throw new Error("Failed PetPack validation report is not bound to its claimed archive bytes");
    }
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const row = oneRow(await tx.query(
        `SELECT execution.run_id, run.project_id, run.order_id, run.state AS run_state,
                run.version AS run_version, build.id AS build_id, build.media_asset_id,
                build.sha256 AS build_sha256, build.validation_policy_version, build.validator_version,
                asset.object_key, asset.sha256 AS asset_sha256, asset.byte_size, asset.content_type,
                asset.deleted_at, asset.expires_at
           FROM production_job_execution execution
           JOIN production_run run ON run.id = execution.run_id
           JOIN petpack_build build ON build.run_id = run.id
           JOIN media_asset asset
             ON asset.id = build.media_asset_id
            AND asset.project_id = run.project_id
            AND asset.run_id = run.id
            AND asset.kind = 'final_petpack'
          WHERE execution.job_id = $1 AND execution.lease_token = $2::uuid
            AND execution.job_name = $3 AND execution.status = 'leased'
            AND execution.leased_until > now()
           FOR UPDATE OF execution, run, build, asset`,
        [safeJobId, safeLease, JOB_NAMES.VALIDATE_PACKAGE]
      ), "Active failed package-validation execution lease was not found");
      if (row.build_id !== safeBuildId || row.media_asset_id !== expectedArtifact.mediaAssetId ||
          row.object_key !== expectedArtifact.objectKey || row.build_sha256 !== expectedArtifact.sha256 ||
          row.asset_sha256 !== expectedArtifact.sha256 || Number(row.byte_size) !== expectedArtifact.byteSize ||
          row.content_type !== expectedArtifact.contentType || row.deleted_at ||
          (row.expires_at && new Date(row.expires_at) <= new Date()) ||
          row.run_state !== PRODUCTION_STATES.VALIDATING) {
        throw new Error("Failed PetPack validation no longer owns its build");
      }
      await tx.query(
        `INSERT INTO qa_report
          (id, project_id, run_id, action_id, subject_kind, status, policy_version,
           report, source_media_asset_id, subject_media_asset_id, processor_version,
           petpack_build_id, validator_version)
         VALUES ($1, $2, $3, NULL, 'petpack', 'failed', $4, $5::jsonb,
                 NULL, $6, $7, $8, $7)`,
        [
          this.idFactory(), row.project_id, row.run_id,
          row.validation_policy_version || PETPACK_VALIDATION_POLICY_VERSION,
          qa.serialized, row.media_asset_id, row.validator_version, row.build_id
        ]
      );
      await tx.query(
        `UPDATE petpack_build
            SET status = 'validation_failed', failure_code = $2, updated_at = now()
          WHERE id = $1`,
        [row.build_id, code]
      );
      await tx.query(
        `UPDATE production_job_execution
            SET status = 'dead', lease_token = NULL, lease_owner = NULL, leased_until = NULL,
                last_error_code = $3, updated_at = now()
          WHERE job_id = $1 AND lease_token = $2::uuid`,
        [safeJobId, safeLease, code]
      );
      await this._failRun(tx, row, code);
      return { status: "validation_failed", buildId: row.build_id };
    });
  }

  async releaseRunJobForRetry({ jobId, leaseToken, errorCode } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLease = requiredString(leaseToken, "Execution lease token", 128);
    const code = normalizeErrorCode(errorCode);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const execution = oneRow(await tx.query(
        `SELECT execution.id, execution.run_id, execution.attempts, execution.max_attempts,
                run.project_id, run.order_id, run.state AS run_state, run.version AS run_version
           FROM production_job_execution execution
           JOIN production_run run ON run.id = execution.run_id
          WHERE execution.job_id = $1 AND execution.lease_token = $2::uuid
            AND execution.status = 'leased'
          FOR UPDATE OF execution, run`,
        [safeJobId, safeLease]
      ), "Active PetPack execution lease was not found");
      const exhausted = Number(execution.attempts) >= Number(execution.max_attempts);
      const nextStatus = exhausted ? "dead" : "retryable";
      await tx.query(
        `UPDATE production_job_execution
            SET status = $3, lease_token = NULL, lease_owner = NULL, leased_until = NULL,
                last_error_code = $4, updated_at = now()
          WHERE job_id = $1 AND lease_token = $2::uuid AND status = 'leased'`,
        [safeJobId, safeLease, nextStatus, code]
      );
      if (exhausted) await this._failRun(tx, execution, code);
      this.logger.warn?.("petpack.worker.package_execution_settled", {
        runId: execution.run_id,
        status: nextStatus,
        errorCode: code
      });
      return { status: nextStatus, exhausted };
    });
  }

  async claimDeliveryReady(input = {}) {
    const claim = normalizeRunClaimInput(input);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const execution = await this._insertExecution(tx, claim, JOB_NAMES.DELIVERY_READY);
      const run = await this._loadRun(tx, claim.runId);
      const existingDelivery = rows(await tx.query(
        `SELECT id, petpack_build_id, status FROM delivery
          WHERE order_id = $1 FOR UPDATE`,
        [run.order_id]
      ));
      if (execution.status === "succeeded") {
        if (run.run_state !== PRODUCTION_STATES.DELIVERABLE || existingDelivery[0]?.status !== "ready") {
          throw new Error("Completed delivery execution has no ready delivery");
        }
        return { outcome: "already_completed", runId: claim.runId };
      }
      if (run.run_state !== PRODUCTION_STATES.VALIDATING || run.order_status !== "paid") {
        throw new Error("Only a paid, validated production run may become deliverable");
      }
      const lease = await this._leaseExecution(tx, execution, claim);
      if (lease.exhausted) await this._failRun(tx, run, "package_delivery_attempts_exhausted");
      if (lease.outcome !== "claimed") return { ...lease, runId: claim.runId };
      return {
        ...lease,
        runId: run.run_id,
        projectId: run.project_id,
        orderId: run.order_id
      };
    });
  }

  async completeDeliveryReady({ jobId, leaseToken, retentionDays = null } = {}) {
    const safeJobId = requiredString(jobId, "Queue job ID");
    const safeLease = requiredString(leaseToken, "Execution lease token", 128);
    const days = retentionDays === null ? null : positiveInteger(retentionDays, "Delivery retention days", 3650);
    return this.database.transaction(async (transaction) => {
      const tx = requireQuery(transaction);
      const execution = oneRow(await tx.query(
        `SELECT id, run_id
           FROM production_job_execution
          WHERE job_id = $1 AND lease_token = $2::uuid
            AND job_name = $3 AND status = 'leased' AND leased_until > now()
          FOR UPDATE`,
        [safeJobId, safeLease, JOB_NAMES.DELIVERY_READY]
      ), "Active delivery execution lease was not found");
      const run = await this._loadRun(tx, execution.run_id);
      const existingDelivery = rows(await tx.query(
        `SELECT id, order_id, petpack_build_id, status
           FROM delivery WHERE order_id = $1 FOR UPDATE`,
        [run.order_id]
      ));
      if (run.run_state !== PRODUCTION_STATES.VALIDATING || run.order_status !== "paid") {
        throw new Error("Only a paid, validated production run may become deliverable");
      }
      const build = oneRow(await tx.query(
        `SELECT build.id, build.project_id, build.run_id, build.order_id,
                build.media_asset_id, build.sha256, build.status,
                build.package_qa_report_id, build.import_qa_report_id,
                build.validation_policy_version, build.validator_version,
                build.original_import_verified_at, build.customized_interactions_verified_at,
                build.validated_at, asset.sha256 AS asset_sha256,
                asset.content_type, asset.byte_size, asset.deleted_at, asset.expires_at,
                package_qa.status AS package_qa_status,
                package_qa.subject_kind AS package_qa_subject_kind,
                package_qa.subject_media_asset_id AS package_qa_asset_id,
                package_qa.petpack_build_id AS package_qa_build_id,
                package_qa.project_id AS package_qa_project_id,
                package_qa.run_id AS package_qa_run_id,
                package_qa.policy_version AS package_qa_policy_version,
                package_qa.validator_version AS package_qa_validator_version,
                package_qa.processor_version AS package_qa_processor_version,
                import_qa.status AS import_qa_status,
                import_qa.subject_kind AS import_qa_subject_kind,
                import_qa.subject_media_asset_id AS import_qa_asset_id,
                import_qa.petpack_build_id AS import_qa_build_id,
                import_qa.project_id AS import_qa_project_id,
                import_qa.run_id AS import_qa_run_id,
                import_qa.policy_version AS import_qa_policy_version,
                import_qa.validator_version AS import_qa_validator_version,
                import_qa.processor_version AS import_qa_processor_version
           FROM petpack_build build
           JOIN media_asset asset
             ON asset.id = build.media_asset_id
            AND asset.project_id = build.project_id
             AND asset.run_id = build.run_id
             AND asset.kind = 'final_petpack'
             AND asset.content_type = $4
             AND asset.byte_size > 0
           JOIN qa_report package_qa
             ON package_qa.id = build.package_qa_report_id
            AND package_qa.subject_kind = 'petpack'
            AND package_qa.status = 'passed'
            AND package_qa.project_id = build.project_id
            AND package_qa.run_id = build.run_id
            AND package_qa.action_id IS NULL
            AND package_qa.source_media_asset_id IS NULL
            AND package_qa.subject_media_asset_id = build.media_asset_id
            AND package_qa.petpack_build_id = build.id
            AND package_qa.policy_version = build.validation_policy_version
            AND package_qa.validator_version = build.validator_version
            AND package_qa.processor_version = build.validator_version
           JOIN qa_report import_qa
             ON import_qa.id = build.import_qa_report_id
            AND import_qa.subject_kind = 'desktop_import'
            AND import_qa.status = 'passed'
            AND import_qa.project_id = build.project_id
            AND import_qa.run_id = build.run_id
            AND import_qa.action_id IS NULL
            AND import_qa.source_media_asset_id IS NULL
            AND import_qa.subject_media_asset_id = build.media_asset_id
            AND import_qa.petpack_build_id = build.id
            AND import_qa.policy_version = build.validation_policy_version
            AND import_qa.validator_version = build.validator_version
            AND import_qa.processor_version = build.validator_version
          WHERE build.run_id = $1 AND build.project_id = $2 AND build.order_id = $3
          FOR UPDATE OF build, asset, package_qa, import_qa`,
        [run.run_id, run.project_id, run.order_id, PETPACK_CONTENT_TYPE]
      ), "Validated PetPack build was not found for delivery");
      if (build.status !== "validated" || build.sha256 !== build.asset_sha256 || build.deleted_at ||
          (build.expires_at && new Date(build.expires_at) <= new Date()) ||
          build.content_type !== PETPACK_CONTENT_TYPE || Number(build.byte_size) < 1 ||
          !build.original_import_verified_at || !build.customized_interactions_verified_at || !build.validated_at ||
          build.package_qa_report_id === build.import_qa_report_id ||
          build.package_qa_status !== "passed" || build.import_qa_status !== "passed" ||
          build.package_qa_subject_kind !== "petpack" || build.import_qa_subject_kind !== "desktop_import" ||
          build.package_qa_asset_id !== build.media_asset_id || build.import_qa_asset_id !== build.media_asset_id ||
          build.package_qa_build_id !== build.id || build.import_qa_build_id !== build.id ||
          build.package_qa_project_id !== build.project_id || build.import_qa_project_id !== build.project_id ||
          build.package_qa_run_id !== build.run_id || build.import_qa_run_id !== build.run_id ||
          build.package_qa_policy_version !== build.validation_policy_version ||
          build.import_qa_policy_version !== build.validation_policy_version ||
          build.package_qa_validator_version !== build.validator_version ||
          build.import_qa_validator_version !== build.validator_version ||
          build.package_qa_processor_version !== build.validator_version ||
          build.import_qa_processor_version !== build.validator_version) {
        throw new Error("PetPack delivery evidence is incomplete or inconsistent");
      }
      if (existingDelivery.length === 1 && (existingDelivery[0].petpack_build_id !== build.id ||
          !["pending", "ready"].includes(existingDelivery[0].status))) {
        throw new Error("An existing delivery cannot be rebound or revived");
      }
      const deliveryId = existingDelivery[0]?.id || this.idFactory();
      const delivery = rows(await tx.query(
        `INSERT INTO delivery
          (id, order_id, petpack_build_id, status, expires_at)
         VALUES ($1, $2, $3, 'ready',
                 CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END)
         ON CONFLICT (order_id) DO UPDATE
            SET status = 'ready',
                expires_at = CASE
                  WHEN delivery.status = 'pending' THEN EXCLUDED.expires_at
                  ELSE delivery.expires_at
                END,
                updated_at = now()
         WHERE delivery.petpack_build_id = EXCLUDED.petpack_build_id
           AND delivery.status IN ('pending', 'ready')
         RETURNING id`,
        [deliveryId, run.order_id, build.id, days]
      ));
      if (delivery.length !== 1) throw new Error("Ready PetPack delivery could not be created idempotently");
      const order = rows(await tx.query(
        `UPDATE customer_order
            SET delivery_status = 'ready', updated_at = now()
          WHERE id = $1 AND project_id = $2 AND status = 'paid'
        RETURNING id`,
        [run.order_id, run.project_id]
      ));
      if (order.length !== 1) throw new Error("Paid order changed before PetPack delivery commit");
      await tx.query(
        `UPDATE pet_project SET state = 'deliverable', updated_at = now()
          WHERE id = $1`,
        [run.project_id]
      );
      await this._advanceRun(tx, run, PRODUCTION_STATES.VALIDATING, PRODUCTION_STATES.DELIVERABLE);
      await this._completeExecution(tx, { jobId: safeJobId, leaseToken: safeLease });
      return { outcome: "ready", runId: run.run_id, deliveryId: delivery[0].id };
    });
  }
}

module.exports = {
  PACKAGE_JOB_NAMES,
  PostgresPetpackWorkerRepository,
  assertRunWorkflowJob,
  mapActionRow,
  normalizeRunClaimInput,
  normalizeClaimedPetpackArtifact,
  normalizeValidationDescriptor
};
