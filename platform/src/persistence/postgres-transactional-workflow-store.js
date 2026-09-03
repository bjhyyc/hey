const crypto = require("node:crypto");

const { REQUIRED_ACTION_IDS, assertActionId } = require("../domain/action-catalog");
const { PRODUCTION_STATES } = require("../domain/production-state-machine");
const { JOB_NAMES } = require("../workflow/production-workflow");
const { CHARACTER_CANVAS_V1 } = require("../qa/character-canvas-v1");

function requireId(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function") {
    throw new Error("A PostgreSQL transaction runner is required");
  }
  return database;
}

function requireTransactionQuery(tx) {
  if (!tx || typeof tx.query !== "function") throw new Error("A PostgreSQL transaction query interface is required");
  return tx;
}

function oneRow(result, message) {
  const found = Array.isArray(result && result.rows) ? result.rows : [];
  if (found.length !== 1) throw new Error(message);
  return found[0];
}

function requireVersion(run, label) {
  if (!run || !Number.isSafeInteger(run.version) || run.version < 0) {
    throw new Error(`${label} requires a current optimistic-lock version`);
  }
  return run.version;
}

function assertWorkflowJob(job) {
  if (!job || typeof job !== "object") throw new Error("Workflow job is required");
  const name = requireId(job.name, "Workflow job name");
  if (!Object.values(JOB_NAMES).includes(name)) throw new Error("Workflow job name is unsupported");
  const dedupeKey = requireId(job.dedupeKey, "Workflow job dedupe key");
  if (!job.data || typeof job.data !== "object" || typeof job.data.runId !== "string") {
    throw new Error("Workflow job must contain a run ID");
  }
  const allowedDataKeys = new Set(["runId", "actionId"]);
  if (Object.keys(job.data).some((key) => !allowedDataKeys.has(key))) {
    throw new Error("Workflow job data may contain only server-side IDs");
  }
  const requiresActionId = [
    JOB_NAMES.GENERATE_VIDEO,
    JOB_NAMES.POLL_VIDEO,
    JOB_NAMES.PROCESS_VIDEO_ACTION,
    JOB_NAMES.FINALIZE_VIDEO_ACTION
  ].includes(name);
  if (requiresActionId !== Boolean(job.data.actionId)) {
    throw new Error("Only per-action video jobs may include an action ID");
  }
  if (job.data.actionId) assertActionId(job.data.actionId);
  if (!job.options || !Number.isInteger(job.options.attempts) || job.options.attempts < 1) {
    throw new Error("Workflow job requires a positive attempt limit");
  }
  if (job.options.jobId !== dedupeKey) {
    throw new Error("Workflow job options.jobId must equal its deterministic dedupe key");
  }
  return job;
}

function serializeJson(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function assertPrivateMasterFrame(master, label) {
  if (!master || typeof master.objectKey !== "string" || !master.objectKey.startsWith("private/")) {
    throw new Error(`${label} must reference a private object key`);
  }
  return master;
}

function mapRunRow(row, fallback) {
  return {
    ...fallback,
    id: row.id || fallback.id,
    projectId: row.project_id || fallback.projectId,
    orderId: row.order_id || fallback.orderId,
    modelRegistryVersion: row.model_registry_version || fallback.modelRegistryVersion,
    species: row.species || fallback.species,
    characterRevisionId: row.character_revision_id || fallback.characterRevisionId || null,
    state: row.state,
    version: Number(row.version),
    updatedAt: row.updated_at || fallback.updatedAt
  };
}

/**
 * PostgreSQL persistence adapter for state transitions. All state mutations,
 * immutable prompt/action snapshots, and outbox rows are committed in one
 * database transaction. It intentionally needs only a tiny `transaction` +
 * `query` interface so the actual `pg` connection lifecycle stays in the web
 * deployment package rather than the Electron application.
 */
class PostgresTransactionalWorkflowStore {
  constructor({ database, idFactory = crypto.randomUUID, logger = console } = {}) {
    this.database = requireDatabase(database);
    if (typeof idFactory !== "function") throw new Error("A UUID ID factory is required");
    this.idFactory = idFactory;
    this.logger = logger;
  }

  async _insertOutbox(tx, job) {
    const safeJob = assertWorkflowJob(job);
    await tx.query(
      `INSERT INTO outbox_job
        (id, aggregate_type, aggregate_id, job_name, payload, dedupe_key, status, available_at)
       VALUES ($1, 'production_run', $2, $3, $4::jsonb, $5, 'pending', now())
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        this.idFactory(),
        safeJob.data.runId,
        safeJob.name,
        serializeJson({ name: safeJob.name, data: safeJob.data, options: safeJob.options }),
        safeJob.dedupeKey
      ]
    );
  }

  async _insertSnapshots(tx, run, snapshots) {
    if (snapshots.length === 0) return;
    if (snapshots.length !== REQUIRED_ACTION_IDS.length) {
      throw new Error("Video release requires exactly seven immutable action snapshots");
    }
    const snapshotActionIds = snapshots.map((snapshot) => snapshot && snapshot.actionId);
    if (REQUIRED_ACTION_IDS.some((actionId) => !snapshotActionIds.includes(actionId))) {
      throw new Error("Video release snapshots are missing a canonical action");
    }
    for (const snapshot of snapshots) {
      assertActionId(snapshot.actionId);
      await tx.query(
        `INSERT INTO generation_action
          (id, run_id, action_id, prompt_version_id, prompt_version_label,
           model_reference, first_frame_object_key, last_frame_object_key, state)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'queued')
         ON CONFLICT (run_id, action_id) DO NOTHING`,
        [
          this.idFactory(),
          run.id,
          snapshot.actionId,
          requireId(snapshot.promptVersionId, "Prompt version ID"),
          requireId(snapshot.promptVersion, "Prompt version label"),
          serializeJson(snapshot.modelReference),
          requireId(snapshot.firstFrameObjectKey, "First-frame object key"),
          requireId(snapshot.lastFrameObjectKey, "Last-frame object key")
        ]
      );
    }
  }

  async _savePromptGateMasters(tx, run, masterFrames) {
    const frontMaster = assertPrivateMasterFrame(masterFrames && masterFrames.frontMaster, "Front master");
    const sideMaster = assertPrivateMasterFrame(masterFrames && masterFrames.sideMaster, "Side master");
    const sleepMaster = assertPrivateMasterFrame(masterFrames && masterFrames.sleepMaster, "Sleeping master");
    const saved = await tx.query(
      `INSERT INTO production_run_master_frame
        (run_id, front_master_object_key, side_master_object_key, sleep_master_object_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id) DO UPDATE
         SET front_master_object_key = EXCLUDED.front_master_object_key,
             side_master_object_key = EXCLUDED.side_master_object_key,
             sleep_master_object_key = EXCLUDED.sleep_master_object_key,
             updated_at = now()
       WHERE production_run_master_frame.front_master_object_key = EXCLUDED.front_master_object_key
         AND production_run_master_frame.side_master_object_key = EXCLUDED.side_master_object_key
         AND production_run_master_frame.sleep_master_object_key = EXCLUDED.sleep_master_object_key
       RETURNING run_id`,
      [run.id, frontMaster.objectKey, sideMaster.objectKey, sleepMaster.objectKey]
    );
    if (saved.rows.length !== 1) {
      throw new Error("Prompt-gate master frames are immutable once stored for a run");
    }
  }

  async _recordTransition(tx, { previousRun, run }) {
    await tx.query(
      `INSERT INTO production_run_event
        (id, run_id, previous_state, next_state, expected_version, resulting_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        this.idFactory(),
        run.id,
        previousRun ? previousRun.state : null,
        run.state,
        previousRun ? previousRun.version : null,
        run.version
      ]
    );
  }

  async _createRun(tx, run) {
    const inserted = await tx.query(
      `INSERT INTO production_run
        (id, project_id, order_id, state, model_registry_version, prompt_snapshot,
         front_generation_attempts, side_generation_attempts,
         front_user_regenerations_used, side_user_regenerations_used,
         front_qa_retries, side_qa_retries, sleep_generation_attempts, failure_code, species, version)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, 0)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id, project_id, order_id, character_revision_id, state, model_registry_version, species, version, updated_at`,
      [
        requireId(run.id, "Run ID"),
        requireId(run.projectId, "Project ID"),
        requireId(run.orderId, "Order ID"),
        requireId(run.state, "Run state"),
        requireId(run.modelRegistryVersion, "Model registry version"),
        serializeJson(run.promptSnapshot),
        Number(run.frontGenerationAttempts || 0),
        Number(run.sideGenerationAttempts || 0),
        Number(run.frontUserRegenerationsUsed || 0),
        Number(run.sideUserRegenerationsUsed || 0),
        Number(run.frontQaRetries || 0),
        Number(run.sideQaRetries || 0),
        Number(run.sleepGenerationAttempts || 0),
        run.failureCode || null,
        requireId(run.species, "Run species")
      ]
    );
    if (inserted.rows.length > 0) return { run: mapRunRow(inserted.rows[0], run), created: true };
    const existing = await tx.query(
      "SELECT id, project_id, order_id, character_revision_id, state, model_registry_version, species, version, updated_at FROM production_run WHERE order_id = $1 FOR UPDATE",
      [run.orderId]
    );
    if (existing.rows.length !== 1) throw new Error("Unable to recover an idempotent production run");
    const existingRun = mapRunRow(existing.rows[0], run);
    if (existingRun.projectId !== run.projectId || existingRun.orderId !== run.orderId ||
        existingRun.modelRegistryVersion !== run.modelRegistryVersion) {
      throw new Error("Idempotent production run ownership does not match the requested order");
    }
    return { run: existingRun, created: false };
  }

  async _updateRun(tx, previousRun, run) {
    const expectedVersion = requireVersion(previousRun, "A persisted run transition");
    const frozenModelRegistryVersion = requireId(previousRun.modelRegistryVersion, "Frozen model registry version");
    if (requireId(run.modelRegistryVersion, "Model registry version") !== frozenModelRegistryVersion) {
      throw new Error("Production run cannot switch model registry versions");
    }
    const result = await tx.query(
      `UPDATE production_run
          SET state = $2,
              prompt_snapshot = $3::jsonb,
              front_generation_attempts = $4,
              side_generation_attempts = $5,
              front_user_regenerations_used = $6,
              side_user_regenerations_used = $7,
              front_qa_retries = $8,
              side_qa_retries = $9,
              sleep_generation_attempts = $10,
              character_revision_id = COALESCE($11::uuid, character_revision_id),
              failure_code = $12,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND state = $13 AND version = $14 AND model_registry_version = $15
      RETURNING id, project_id, order_id, character_revision_id, state, model_registry_version, version, updated_at`,
      [
        requireId(run.id, "Run ID"),
        requireId(run.state, "Run state"),
        serializeJson(run.promptSnapshot),
        Number(run.frontGenerationAttempts || 0),
        Number(run.sideGenerationAttempts || 0),
        Number(run.frontUserRegenerationsUsed || 0),
        Number(run.sideUserRegenerationsUsed || 0),
        Number(run.frontQaRetries || 0),
        Number(run.sideQaRetries || 0),
        Number(run.sleepGenerationAttempts || 0),
        run.characterRevisionId || null,
        run.failureCode || null,
        requireId(previousRun.state, "Previous run state"),
        expectedVersion,
        frozenModelRegistryVersion
      ]
    );
    if (result.rows.length !== 1) {
      throw new Error("Production run changed concurrently; reload before retrying the transition");
    }
    return { run: mapRunRow(result.rows[0], run), created: true };
  }

  async commitTransition({ previousRun = null, run, snapshots = [], jobs = [], masterFrames = null } = {}) {
    if (!run || typeof run !== "object") throw new Error("Next production run is required");
    if (previousRun && previousRun.id !== run.id) throw new Error("Production run transition IDs do not match");
    if (!Array.isArray(snapshots) || !Array.isArray(jobs)) throw new Error("Snapshots and jobs must be arrays");
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const transition = previousRun ? await this._updateRun(tx, previousRun, run) : await this._createRun(tx, run);
      const committedRun = { ...transition.run, completedActions: run.completedActions || [] };
      // A duplicated paid callback may find the unique order-owned run already
      // created. Do not append a second event or reset its outbox work.
      if (!transition.created) return committedRun;
      await this._recordTransition(tx, { previousRun, run: committedRun });
      if (masterFrames) await this._savePromptGateMasters(tx, committedRun, masterFrames);
      await this._insertSnapshots(tx, committedRun, snapshots);
      for (const job of jobs) {
        if (!job || !job.data || job.data.runId !== committedRun.id) {
          throw new Error("Workflow outbox job must belong to the transitioned run");
        }
        await this._insertOutbox(tx, job);
      }
      this.logger.info?.("petpack.persistence.transition_committed", {
        runId: committedRun.id,
        state: committedRun.state,
        jobs: jobs.length,
        snapshots: snapshots.length
      });
      return committedRun;
    });
  }

  /**
   * Administrator rerun of one failed video action: the run transition
   * (failed -> video_generating), the action reset, and the regeneration job
   * commit in a single transaction. The reset mirrors
   * `requeueVideoActionAfterQaFailure`: every provider-owned field is cleared
   * because the submission claim skips any action that still carries one, and
   * retry_count increments so the rerun's dedupe key can never collide with an
   * earlier QA-retry or admin-rerun job.
   */
  async commitAdminActionRerun({ previousRun = null, run, actionId, jobFactory } = {}) {
    if (!run || typeof run !== "object") throw new Error("Next production run is required");
    if (!previousRun || previousRun.id !== run.id) throw new Error("Administrator action rerun requires the persisted failed run");
    assertActionId(actionId);
    if (typeof jobFactory !== "function") throw new Error("Administrator action rerun requires a job factory");
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const transition = await this._updateRun(tx, previousRun, run);
      const committedRun = { ...transition.run, completedActions: run.completedActions || [] };
      await this._recordTransition(tx, { previousRun, run: committedRun });
      const reset = await tx.query(
        `UPDATE generation_action
            SET state = 'queued',
                retry_count = retry_count + 1,
                provider_task_id = NULL,
                provider_request_id = NULL,
                provider_poll_count = 0,
                provider_output_asset_id = NULL,
                media_asset_id = NULL,
                qa_report_id = NULL,
                processing_policy_version = NULL,
                processor_version = NULL,
                admin_qa_override = NULL,
                updated_at = now()
          WHERE run_id = $1 AND action_id = $2 AND state = 'failed'
        RETURNING retry_count`,
        [committedRun.id, actionId]
      );
      if (!Array.isArray(reset.rows) || reset.rows.length !== 1) {
        throw new Error("The failed action could not be reset for an administrator rerun");
      }
      const job = jobFactory(Number(reset.rows[0].retry_count));
      const safeJob = assertWorkflowJob(job);
      if (safeJob.data.runId !== committedRun.id || safeJob.data.actionId !== actionId) {
        throw new Error("Administrator rerun job must belong to the reset action");
      }
      await this._insertOutbox(tx, safeJob);
      this.logger.info?.("petpack.persistence.admin_action_rerun_committed", {
        runId: committedRun.id,
        actionId,
        retryCount: Number(reset.rows[0].retry_count)
      });
      return committedRun;
    });
  }

  _assertOverride(override) {
    if (!override || typeof override.actorId !== "string" || !override.actorId.trim() ||
        typeof override.reason !== "string" || !override.reason.trim()) {
      throw new Error("A QA override requires the authorizing administrator and a reason");
    }
    return {
      actorId: override.actorId.trim(),
      reason: override.reason.trim().slice(0, 200),
      authorizedAt: new Date().toISOString()
    };
  }

  /**
   * The override flips the REJECTED image report in place: status becomes
   * passed, `ok`/`errors` flip, the machine verdict is kept under
   * `overriddenVerdict` and the authorization sits beside it. Everything else
   * the worker measured - kind, frame, appearance, chroma, processing,
   * provenance - stays exactly where it was, because the packaging gate later
   * re-reads this same report and refuses a run whose confirmed master carries
   * no top-level `kind` and `provenance` (2026-09-02: seven passed videos died
   * at that gate behind an override that had moved them). A second report for
   * the same subject is not an option either - `qa_report_image_subject_unique_idx`
   * allows one image report per subject asset, and every worker path that
   * resolves a master's report joins on that asset expecting exactly one row.
   */
  async _overrideRejectedQaReport(tx, { generation, override }) {
    const authorization = {
      ...override,
      overriddenQaReportId: generation.qa_report_id || null
    };
    const updated = await tx.query(
      `UPDATE qa_report
          SET status = 'passed',
              report = report || jsonb_build_object(
                'ok', true,
                'errors', '[]'::jsonb,
                'adminOverride', $4::jsonb,
                'overriddenVerdict', jsonb_build_object(
                  'ok', report->'ok',
                  'errors', COALESCE(report->'errors', '[]'::jsonb),
                  'warnings', COALESCE(report->'warnings', '[]'::jsonb)
                )
              )
        WHERE run_id = $1
          AND subject_kind = 'image'
          AND status = 'failed'
          AND subject_media_asset_id = $2::uuid
          AND source_media_asset_id = $3::uuid
          AND policy_version = $5
          AND processor_version = $6
       RETURNING id`,
      [
        generation.run_id, generation.normalized_media_asset_id, generation.provider_output_asset_id,
        serializeJson(authorization), generation.processing_policy_version, generation.processor_version
      ]
    );
    if (!Array.isArray(updated.rows) || updated.rows.length !== 1) {
      throw new Error("The rejected master's QA report could not be overridden");
    }
    return updated.rows[0].id;
  }

  async _promoteOverriddenMasterCandidate(tx, { run, view, generationId, override }) {
    const assetKind = `${view === "sleep" ? "sleep" : view}_master`;
    const generation = oneRow(await tx.query(
      `SELECT generation.id, generation.project_id, generation.run_id, generation.order_id,
              generation.kind, generation.generation_attempt, generation.image_candidate_id,
              generation.provider_output_asset_id, generation.normalized_media_asset_id,
              generation.processing_policy_version, generation.processor_version,
              generation.qa_report_id,
              generation.parent_front_candidate_id, generation.parent_side_candidate_id
         FROM master_image_generation generation
         JOIN media_asset asset
           ON asset.id = generation.normalized_media_asset_id
          AND asset.project_id = generation.project_id
          AND asset.run_id = generation.run_id
          AND asset.kind = $4::media_kind
          AND asset.deleted_at IS NULL
        WHERE generation.id = $1
          AND generation.run_id = $2
          AND generation.kind = $3
          AND generation.status = 'qa_failed'
          AND generation.image_candidate_id IS NOT NULL
          AND generation.provider_output_asset_id IS NOT NULL
          AND generation.processing_policy_version IS NOT NULL
          AND generation.processor_version IS NOT NULL
        FOR UPDATE OF generation`,
      [requireId(generationId, "Master generation ID"), run.id, view, assetKind]
    ), "The selected master attempt is not a QA-rejected candidate of this run with retained media");
    const overrideReportId = await this._overrideRejectedQaReport(tx, { generation, override });
    const candidate = await tx.query(
      `UPDATE image_candidate
          SET qa_status = 'passed', qa_report_id = $2
        WHERE id = $1 AND qa_status = 'failed'
      RETURNING id`,
      [generation.image_candidate_id, overrideReportId]
    );
    if (!Array.isArray(candidate.rows) || candidate.rows.length !== 1) {
      throw new Error("The rejected candidate could not be promoted");
    }
    const promoted = await tx.query(
      `UPDATE master_image_generation
          SET status = 'qa_passed', qa_report_id = $2, updated_at = now()
        WHERE id = $1 AND status = 'qa_failed'
      RETURNING id`,
      [generation.id, overrideReportId]
    );
    if (!Array.isArray(promoted.rows) || promoted.rows.length !== 1) {
      throw new Error("The rejected master generation could not be promoted");
    }
    return { generation, overrideReportId };
  }

  /**
   * Administrator force-pass of a rejected front/side master. QA failure left
   * a complete normalized candidate on record (asset, candidate row, failed
   * report), so this is pure promotion plus the run transition: the image
   * reappears on the customer's confirmation list and the customer - never
   * the administrator - confirms it. A front override before the side view
   * ever generated also starts the side generation, mirroring the ordinary
   * characterMasterGenerated step.
   */
  async commitAdminMasterQaOverride({ previousRun = null, run, view, generationId, override, sideJobFactory = null } = {}) {
    if (!run || typeof run !== "object") throw new Error("Next production run is required");
    if (!previousRun || previousRun.id !== run.id) throw new Error("A QA override requires the persisted failed run");
    if (!["front", "side"].includes(view)) throw new Error("Master QA override view must be front or side");
    const safeOverride = this._assertOverride(override);
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const transition = await this._updateRun(tx, previousRun, run);
      const committedRun = { ...transition.run, completedActions: run.completedActions || [] };
      await this._recordTransition(tx, { previousRun, run: committedRun });
      const { generation } = await this._promoteOverriddenMasterCandidate(tx, {
        run: committedRun,
        view,
        generationId,
        override: safeOverride
      });
      if (committedRun.state === PRODUCTION_STATES.AWAKE_GENERATING) {
        if (typeof sideJobFactory !== "function") {
          throw new Error("A side-generation job factory is required when the side view has never generated");
        }
        const job = assertWorkflowJob(sideJobFactory(generation.image_candidate_id));
        if (job.name !== JOB_NAMES.GENERATE_SIDE || job.data.runId !== committedRun.id) {
          throw new Error("The override's side-generation job must belong to this run");
        }
        await this._insertOutbox(tx, job);
      }
      this.logger.warn?.("petpack.persistence.admin_master_override_committed", {
        runId: committedRun.id,
        view,
        generationId,
        state: committedRun.state
      });
      return committedRun;
    });
  }

  /**
   * Administrator resume of a run that died at the seven-action media gate
   * (`production_evidence_provenance_invalid` and its neighbours). Nothing is
   * regenerated: the masters, the seven passed videos and their reports are
   * all still on record, so the run simply returns to media_processing and a
   * fresh process-media job is queued. The gate's dead execution row is
   * retargeted at that job - one run-level execution per job name is what the
   * worker's claim expects to find - and the project leaves `failed` with it.
   */
  async commitAdminMediaProcessingResume({ previousRun = null, run, job } = {}) {
    if (!run || typeof run !== "object") throw new Error("Next production run is required");
    if (!previousRun || previousRun.id !== run.id) throw new Error("A packaging resume requires the persisted failed run");
    const safeJob = assertWorkflowJob(job);
    if (safeJob.name !== JOB_NAMES.PROCESS_MEDIA || safeJob.data.runId !== run.id) {
      throw new Error("The packaging resume must queue this run's process-media job");
    }
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const transition = await this._updateRun(tx, previousRun, run);
      const committedRun = { ...transition.run, completedActions: run.completedActions || [] };
      await this._recordTransition(tx, { previousRun, run: committedRun });
      const retargeted = await tx.query(
        `UPDATE production_job_execution
            SET job_id = $2, status = 'pending', attempts = 0, transient_attempts = 0,
                lease_token = NULL, lease_owner = NULL, leased_until = NULL,
                last_error_code = NULL, updated_at = now()
          WHERE run_id = $1
            AND job_name = $3
            AND action_id IS NULL
            AND status = 'dead'
        RETURNING id`,
        [committedRun.id, safeJob.options.jobId, JOB_NAMES.PROCESS_MEDIA]
      );
      if (!Array.isArray(retargeted.rows) || retargeted.rows.length !== 1) {
        throw new Error("The run has no dead media-gate execution to resume");
      }
      await tx.query(
        `UPDATE pet_project SET state = 'producing', updated_at = now()
          WHERE id = $1 AND state = 'failed'`,
        [committedRun.projectId]
      );
      await this._insertOutbox(tx, safeJob);
      this.logger.warn?.("petpack.persistence.admin_media_processing_resumed", {
        runId: committedRun.id,
        jobId: safeJob.options.jobId,
        state: committedRun.state
      });
      return committedRun;
    });
  }

  /**
   * Administrator force-pass of a rejected sleeping master. The customer never
   * picks the sleeping master, so the administrator's choice is final: the
   * candidate is promoted, bound to the confirmed character revision, the
   * prompt-gate master frames are stored, and the run advances to
   * awaiting_prompt_gate - all in one transaction. Releasing the seven video
   * actions is the caller's next step via resumeAwaitingPromptGate, which is
   * already crash-recoverable from exactly this state.
   */
  async commitAdminSleepQaOverride({ previousRun = null, run, generationId, override } = {}) {
    if (!run || typeof run !== "object") throw new Error("Next production run is required");
    if (!previousRun || previousRun.id !== run.id) throw new Error("A QA override requires the persisted failed run");
    if (!previousRun.characterRevisionId) throw new Error("Sleeping-master override requires a confirmed character revision");
    const safeOverride = this._assertOverride(override);
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const transition = await this._updateRun(tx, previousRun, run);
      const committedRun = { ...transition.run, completedActions: run.completedActions || [] };
      await this._recordTransition(tx, { previousRun, run: committedRun });
      const { generation } = await this._promoteOverriddenMasterCandidate(tx, {
        run: committedRun,
        view: "sleep",
        generationId,
        override: safeOverride
      });
      const revision = await tx.query(
        `UPDATE character_revision
            SET sleep_candidate_id = COALESCE(sleep_candidate_id, $2)
          WHERE id = $1
            AND project_id = $3
            AND front_candidate_id = $4
            AND side_candidate_id = $5
            AND (sleep_candidate_id IS NULL OR sleep_candidate_id = $2)
        RETURNING id`,
        [
          previousRun.characterRevisionId,
          generation.image_candidate_id,
          generation.project_id,
          generation.parent_front_candidate_id,
          generation.parent_side_candidate_id
        ]
      );
      if (!Array.isArray(revision.rows) || revision.rows.length !== 1) {
        throw new Error("The overridden sleeping master could not be bound to the approved character revision");
      }
      const frames = oneRow(await tx.query(
        `SELECT front_asset.object_key AS front_object_key,
                side_asset.object_key AS side_object_key,
                sleep_asset.object_key AS sleep_object_key
           FROM image_candidate front_candidate
           JOIN media_asset front_asset ON front_asset.id = front_candidate.media_asset_id
           JOIN image_candidate side_candidate ON side_candidate.id = $2
           JOIN media_asset side_asset ON side_asset.id = side_candidate.media_asset_id
           JOIN image_candidate sleep_candidate ON sleep_candidate.id = $3
           JOIN media_asset sleep_asset ON sleep_asset.id = sleep_candidate.media_asset_id
          WHERE front_candidate.id = $1`,
        [generation.parent_front_candidate_id, generation.parent_side_candidate_id, generation.image_candidate_id]
      ), "The override's master frames could not be resolved");
      await this._savePromptGateMasters(tx, committedRun, {
        frontMaster: { objectKey: frames.front_object_key },
        sideMaster: { objectKey: frames.side_object_key },
        sleepMaster: { objectKey: frames.sleep_object_key }
      });
      this.logger.warn?.("petpack.persistence.admin_sleep_override_committed", {
        runId: committedRun.id,
        generationId,
        state: committedRun.state
      });
      return committedRun;
    });
  }

  /**
   * Administrator force-pass of one rejected provider video. Rejected videos
   * have no processed artifact - QA fails before upload - so the chosen
   * provider source re-enters media processing with a durable override marker
   * on the action; the processing pass runs matting, normalization, and QA in
   * full, records the verdict, but does not block on it. Every reset path
   * clears the marker so it is consumed by exactly one pass.
   */
  async commitAdminActionQaOverride({ previousRun = null, run, actionId, sourceAssetId, override, jobFactory } = {}) {
    if (!run || typeof run !== "object") throw new Error("Next production run is required");
    if (!previousRun || previousRun.id !== run.id) throw new Error("A QA override requires the persisted failed run");
    assertActionId(actionId);
    const safeAssetId = requireId(sourceAssetId, "Rejected provider video asset ID");
    const safeOverride = this._assertOverride(override);
    if (typeof jobFactory !== "function") throw new Error("Administrator action override requires a job factory");
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const transition = await this._updateRun(tx, previousRun, run);
      const committedRun = { ...transition.run, completedActions: run.completedActions || [] };
      await this._recordTransition(tx, { previousRun, run: committedRun });
      // The chosen asset must be a provider video this exact action produced
      // and QA rejected; the failed report rows are the attribution record.
      const chosen = await tx.query(
        `SELECT asset.id
           FROM media_asset asset
          WHERE asset.id = $1::uuid
            AND asset.run_id = $2
            AND asset.kind = 'provider_output'
            AND asset.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM qa_report rejection
               WHERE rejection.run_id = $2
                 AND rejection.action_id = $3
                 AND rejection.subject_kind = 'video'
                 AND rejection.status = 'failed'
                 AND rejection.source_media_asset_id = asset.id
            )`,
        [safeAssetId, committedRun.id, actionId]
      );
      if (!Array.isArray(chosen.rows) || chosen.rows.length !== 1) {
        throw new Error("The selected video is not a QA-rejected provider output of this action");
      }
      const reset = await tx.query(
        `UPDATE generation_action
            SET state = 'succeeded',
                provider_output_asset_id = $3::uuid,
                media_asset_id = NULL,
                qa_report_id = NULL,
                processing_policy_version = NULL,
                processor_version = NULL,
                admin_qa_override = $4::jsonb,
                updated_at = now()
          WHERE run_id = $1
            AND action_id = $2
            AND state = 'failed'
        RETURNING retry_count`,
        [committedRun.id, actionId, safeAssetId, serializeJson(safeOverride)]
      );
      // No provider_task_id condition here: a retry-exhausted action - the
      // main rescue case - has its provider fields cleared by the retry reset,
      // and the guard above already proves attribution through the rejected
      // report. Requiring the task id made the video override impossible for
      // exactly the actions it exists for (found live, 2026-09-03). The
      // worker's processing claim needs run=video_generating, state=succeeded
      // and the provider_output_asset_id this update writes; not the task id.
      if (!Array.isArray(reset.rows) || reset.rows.length !== 1) {
        throw new Error("The failed action could not be staged for an override processing pass");
      }
      const job = assertWorkflowJob(jobFactory(Number(reset.rows[0].retry_count)));
      if (job.name !== JOB_NAMES.PROCESS_VIDEO_ACTION || job.data.runId !== committedRun.id || job.data.actionId !== actionId) {
        throw new Error("Administrator override job must reprocess the overridden action");
      }
      await this._insertOutbox(tx, job);
      this.logger.warn?.("petpack.persistence.admin_action_override_committed", {
        runId: committedRun.id,
        actionId,
        sourceAssetId: safeAssetId
      });
      return committedRun;
    });
  }

  async commitJobs({ run, jobs = [] } = {}) {
    if (!run || !run.id || !run.state) throw new Error("Production run is required");
    if (!Array.isArray(jobs) || jobs.length === 0) throw new Error("At least one workflow job is required");
    jobs.forEach(assertWorkflowJob);
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const current = oneRow(await tx.query(
        `SELECT id, state, version
           FROM production_run
          WHERE id = $1
          FOR UPDATE`,
        [run.id]
      ), "Production run was not found while committing workflow jobs");
      if (current.state !== run.state || Number(current.version) !== requireVersion(run, "Production run")) {
        throw new Error("Production run changed before workflow jobs were committed");
      }
      for (const job of jobs) await this._insertOutbox(tx, job);
      return run;
    });
  }

  /**
   * How many quality-approved masters this run holds for a view. A failed
   * regeneration asks this before deciding whether the order can fall back to
   * a version the customer already saw, or has nothing to fall back to.
   */
  async countApprovedCharacterCandidates({ runId, view } = {}) {
    if (!["front", "side"].includes(view)) throw new Error("Character candidate view must be front or side");
    const result = await this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      return tx.query(
        `SELECT count(*)::int AS approved
           FROM image_candidate candidate
           JOIN master_image_generation generation
             ON generation.image_candidate_id = candidate.id
            AND generation.run_id = candidate.run_id
            AND generation.kind = $2
            AND generation.status = 'qa_passed'
          WHERE candidate.run_id = $1
            AND candidate.kind = $2
            AND candidate.qa_status = 'passed'`,
        [requireId(runId, "Run ID"), view]
      );
    });
    return result && result.rows.length === 1 ? Number(result.rows[0].approved) : 0;
  }

  /**
   * Regeneration keeps every earlier version on record, and an owner who spends
   * their regenerations may well prefer the first one, so any attempt up to the
   * run's current count may be confirmed - the generation and QA rows are keyed
   * on the candidate's own attempt rather than the run's latest.
   */
  async _claimConfirmedCharacterCandidate(tx, { run, candidateId, view }) {
    if (!["front", "side"].includes(view)) throw new Error("Confirmed character view must be front or side");
    const attemptColumn = view === "front" ? "front_generation_attempts" : "side_generation_attempts";
    const candidate = await tx.query(
      `SELECT candidate.id,
               candidate.project_id
         FROM production_run
         JOIN image_candidate candidate
           ON candidate.id = $2
           AND candidate.project_id = production_run.project_id
           AND candidate.run_id = production_run.id
           AND candidate.order_id = production_run.order_id
           AND candidate.generation_attempt <= production_run.${attemptColumn}
         JOIN master_image_generation generation
           ON generation.image_candidate_id = candidate.id
          AND generation.run_id = production_run.id
          AND generation.project_id = production_run.project_id
          AND generation.order_id = production_run.order_id
          AND generation.kind = $3
          AND generation.generation_attempt = candidate.generation_attempt
          AND generation.status = 'qa_passed'
         JOIN media_asset asset
           ON asset.id = candidate.media_asset_id
          AND asset.id = generation.normalized_media_asset_id
          AND asset.project_id = production_run.project_id
          AND asset.run_id = production_run.id
          AND asset.kind = ($3 || '_master')::media_kind
          AND asset.deleted_at IS NULL
         JOIN qa_report qa
           ON qa.id = candidate.qa_report_id
          AND qa.id = generation.qa_report_id
          AND qa.project_id = production_run.project_id
          AND qa.run_id = production_run.id
          AND qa.subject_kind = 'image'
          AND qa.status = 'passed'
          AND qa.source_media_asset_id = generation.provider_output_asset_id
          AND qa.subject_media_asset_id = asset.id
          AND qa.policy_version = generation.processing_policy_version
          AND qa.processor_version = generation.processor_version
        WHERE production_run.id = $1
          AND candidate.kind = $3
          AND candidate.qa_status = 'passed'
        FOR UPDATE OF candidate`,
      [run.id, requireId(candidateId, `${view} candidate ID`), view]
    );
    if (candidate.rows.length !== 1) {
      throw new Error(`The selected ${view} character is not a quality-approved candidate of this production run`);
    }
    return candidate.rows[0];
  }

  async _claimConfirmedCharacterMasters(tx, { run, frontCandidateId, sideCandidateId }) {
    const front = await this._claimConfirmedCharacterCandidate(tx, { run, candidateId: frontCandidateId, view: "front" });
    const side = await this._claimConfirmedCharacterCandidate(tx, { run, candidateId: sideCandidateId, view: "side" });
    if (front.project_id !== side.project_id) throw new Error("Confirmed character masters belong to different projects");
    const confirmCandidate = (row) => tx.query(
      `UPDATE image_candidate
          SET confirmed_at = COALESCE(confirmed_at, now())
        WHERE id = $1 AND project_id = $2 AND qa_status = 'passed'`,
      [row.id, row.project_id]
    );

    const characterRevisionId = this.idFactory();
    const created = await tx.query(
      `INSERT INTO character_revision
        (id, project_id, front_candidate_id, side_candidate_id, canvas_id, approved_by_user_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [characterRevisionId, front.project_id, front.id, side.id, CHARACTER_CANVAS_V1.id]
    );
    if (created.rows.length === 1) {
      await confirmCandidate(front);
      await confirmCandidate(side);
      return created.rows[0].id;
    }
    const existing = await tx.query(
      `SELECT id
         FROM character_revision
        WHERE front_candidate_id = $1 AND side_candidate_id = $2
        FOR UPDATE`,
      [front.id, side.id]
    );
    if (existing.rows.length !== 1) {
      throw new Error("Confirmed character revision could not be recovered");
    }
    await confirmCandidate(front);
    await confirmCandidate(side);
    return existing.rows[0].id;
  }

  /**
   * User confirmation is a production boundary: the selected quality-approved
   * awake candidate, immutable character revision, sleep transition, and
   * sleep-generation outbox job must succeed or roll back together.
   */
  async confirmCharacterCandidatesAndCommitTransition({ previousRun, run, frontCandidateId, sideCandidateId, jobs = [] } = {}) {
    if (!previousRun || previousRun.id !== (run && run.id)) {
      throw new Error("Character confirmation requires one persisted production run transition");
    }
    if (previousRun.state !== PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION || run.state !== PRODUCTION_STATES.SLEEP_GENERATING) {
      throw new Error("Character confirmation has an invalid production state transition");
    }
    if (!Array.isArray(jobs) || jobs.length !== 1) {
      throw new Error("Character confirmation requires exactly one sleeping-master generation job");
    }
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const characterRevisionId = await this._claimConfirmedCharacterMasters(tx, { run, frontCandidateId, sideCandidateId });
      const next = { ...run, characterRevisionId };
      const transition = await this._updateRun(tx, previousRun, next);
      const committedRun = { ...transition.run, completedActions: run.completedActions || [] };
      await this._recordTransition(tx, { previousRun, run: committedRun });
      for (const job of jobs) {
        if (!job || !job.data || job.data.runId !== committedRun.id || job.name !== JOB_NAMES.GENERATE_SLEEP) {
          throw new Error("Character confirmation must enqueue the sleeping-master job for its run");
        }
        await this._insertOutbox(tx, job);
      }
      this.logger.info?.("petpack.persistence.character_masters_confirmed", {
        runId: committedRun.id,
        characterRevisionId,
        frontCandidateId,
        sideCandidateId
      });
      return committedRun;
    });
  }

  async getPromptGateMasters({ runId } = {}) {
    const result = await this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      return tx.query(
        `SELECT front_master_object_key, side_master_object_key, sleep_master_object_key
           FROM production_run_master_frame
          WHERE run_id = $1`,
        [requireId(runId, "Run ID")]
      );
    });
    if (!result || result.rows.length !== 1) return null;
    return {
      frontMaster: { objectKey: result.rows[0].front_master_object_key },
      sideMaster: { objectKey: result.rows[0].side_master_object_key },
      sleepMaster: { objectKey: result.rows[0].sleep_master_object_key }
    };
  }

  /**
   * Seven action rows are the concurrency authority. Each worker claims only
   * its own row; when the seventh QA pass is committed, this same transaction
   * advances the run and writes exactly one processing outbox job.
   */
  async completeVideoActionAndMaybeQueue({ run, actionId, actionRevisionId, providerTaskId, job } = {}) {
    if (!run || run.state !== PRODUCTION_STATES.VIDEO_GENERATING) {
      throw new Error("Video action completion requires a video-generating run");
    }
    assertActionId(actionId);
    assertWorkflowJob(job);
    if (job.data.runId !== run.id) throw new Error("Processing job must belong to the completed run");
    if (job.name !== JOB_NAMES.PROCESS_MEDIA || job.data.actionId) {
      throw new Error("Video action completion may enqueue only the run-level media-processing job");
    }
    const safeActionRevisionId = requireId(actionRevisionId, "Action media revision ID");
    const safeProviderTaskId = requireId(providerTaskId, "Provider task ID");
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const locked = await tx.query(
        "SELECT id, state, version FROM production_run WHERE id = $1 FOR UPDATE",
        [run.id]
      );
      if (locked.rows.length !== 1 || locked.rows[0].state !== PRODUCTION_STATES.VIDEO_GENERATING) {
        throw new Error("Video action completion is no longer available for this run");
      }
      const updatedAction = await tx.query(
        `WITH expected_action AS (
           SELECT generation_action.id
             FROM generation_action
             JOIN production_run ON production_run.id = generation_action.run_id
             JOIN media_asset ON media_asset.id = generation_action.media_asset_id
             JOIN qa_report ON qa_report.id = generation_action.qa_report_id
            WHERE generation_action.run_id = $1
              AND generation_action.action_id = $2
              AND generation_action.provider_task_id = $4
              AND generation_action.state = 'processed'
              AND generation_action.media_asset_id = $3
              AND media_asset.run_id = generation_action.run_id
              AND media_asset.project_id = production_run.project_id
              AND media_asset.kind = 'action_video'
              AND media_asset.deleted_at IS NULL
              AND qa_report.run_id = generation_action.run_id
              AND qa_report.project_id = production_run.project_id
              AND qa_report.action_id = generation_action.action_id
              AND qa_report.subject_kind = 'video'
              AND qa_report.status = 'passed'
              AND qa_report.source_media_asset_id = generation_action.provider_output_asset_id
              AND qa_report.subject_media_asset_id = generation_action.media_asset_id
              AND qa_report.processor_version = generation_action.processor_version
              AND qa_report.policy_version = generation_action.processing_policy_version
         )
         UPDATE generation_action
            SET state = 'qa_passed', updated_at = now()
           FROM expected_action
          WHERE generation_action.id = expected_action.id
        RETURNING generation_action.id`,
        [run.id, actionId, safeActionRevisionId, safeProviderTaskId]
      );
      if (!updatedAction || updatedAction.rows.length !== 1) {
        throw new Error("Video QA callback is stale, incomplete, or does not own this run's action asset");
      }
      const rows = await tx.query(
        "SELECT action_id FROM generation_action WHERE run_id = $1 AND state = 'qa_passed' ORDER BY action_id",
        [run.id]
      );
      const passedActionIds = new Set(rows.rows.map((row) => row.action_id));
      const completedActions = REQUIRED_ACTION_IDS.filter((requiredActionId) => passedActionIds.has(requiredActionId));
      const allActionsPassed = REQUIRED_ACTION_IDS.every((requiredActionId) => completedActions.includes(requiredActionId));
      if (!allActionsPassed) {
        return { ...run, version: Number(locked.rows[0].version), completedActions };
      }
      const updated = await tx.query(
        `UPDATE production_run
            SET state = $2, version = version + 1, updated_at = now()
          WHERE id = $1 AND state = $3 AND version = $4
        RETURNING id, state, version, updated_at`,
        [run.id, PRODUCTION_STATES.MEDIA_PROCESSING, PRODUCTION_STATES.VIDEO_GENERATING, Number(locked.rows[0].version)]
      );
      if (updated.rows.length !== 1) throw new Error("Production run changed while final video QA was committed");
      const next = mapRunRow(updated.rows[0], { ...run, completedActions });
      await this._recordTransition(tx, { previousRun: { ...run, version: Number(locked.rows[0].version) }, run: next });
      await this._insertOutbox(tx, job);
      return next;
    });
  }
}

/**
 * Leases committed outbox rows and sends their ID-only payloads to BullMQ (or
 * another compatible queue). A repeat publish is safe because every workflow
 * job uses its deterministic `options.jobId` as the queue idempotency key.
 */
class PostgresOutboxDispatcher {
  constructor({
    database,
    queue,
    leaseTokenFactory = crypto.randomUUID,
    maxAttempts = 8,
    baseRetrySeconds = 5,
    maxRetrySeconds = 600,
    afterClaim = null,
    afterEnqueue = null,
    logger = console
  } = {}) {
    this.database = requireDatabase(database);
    if (!queue || typeof queue.enqueue !== "function") throw new Error("An idempotent queue is required for outbox dispatch");
    if (typeof leaseTokenFactory !== "function") throw new Error("An outbox lease-token factory is required");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error("Outbox maximum attempts must be between 1 and 100");
    }
    if (!Number.isInteger(baseRetrySeconds) || baseRetrySeconds < 1 || baseRetrySeconds > 3600) {
      throw new Error("Outbox base retry delay must be between 1 and 3600 seconds");
    }
    if (!Number.isInteger(maxRetrySeconds) || maxRetrySeconds < baseRetrySeconds || maxRetrySeconds > 86400) {
      throw new Error("Outbox maximum retry delay must be at least the base delay and at most one day");
    }
    if (afterClaim !== null && typeof afterClaim !== "function") {
      throw new Error("Outbox after-claim hook must be a function");
    }
    if (afterEnqueue !== null && typeof afterEnqueue !== "function") {
      throw new Error("Outbox after-enqueue hook must be a function");
    }
    this.queue = queue;
    this.leaseTokenFactory = leaseTokenFactory;
    this.maxAttempts = maxAttempts;
    this.baseRetrySeconds = baseRetrySeconds;
    this.maxRetrySeconds = maxRetrySeconds;
    this.afterClaim = afterClaim;
    this.afterEnqueue = afterEnqueue;
    this.logger = logger;
  }

  _retryDelaySeconds(attempts) {
    const exponent = Math.max(0, Number(attempts || 1) - 1);
    return Math.min(this.maxRetrySeconds, this.baseRetrySeconds * (2 ** exponent));
  }

  async claimBatch({ limit = 25, leaseSeconds = 60 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Outbox dispatch limit must be between 1 and 100");
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 600) throw new Error("Outbox lease must be between 1 and 600 seconds");
    const leaseToken = requireId(this.leaseTokenFactory(), "Outbox lease token");
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const claimed = await tx.query(
        `WITH candidates AS (
           SELECT id
             FROM outbox_job
            WHERE (
                status IN ('pending', 'failed')
                OR (status = 'leased' AND leased_until <= now())
              )
              AND available_at <= now()
            ORDER BY available_at, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE outbox_job AS outbox
            SET status = 'leased',
                lease_token = $3,
                leased_until = now() + ($2 * interval '1 second'),
                attempts = attempts + 1
           FROM candidates
          WHERE outbox.id = candidates.id
        RETURNING outbox.id, outbox.payload, outbox.dedupe_key, outbox.lease_token, outbox.attempts`,
        [limit, leaseSeconds, leaseToken]
      );
      return claimed.rows.map((row) => ({
        id: row.id,
        payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
        dedupeKey: row.dedupe_key,
        leaseToken: row.lease_token || leaseToken,
        attempts: Number(row.attempts || 0)
      }));
    });
  }

  async dispatchBatch(options) {
    const messages = await this.claimBatch(options);
    if (messages.length > 0 && this.afterClaim) {
      await this.afterClaim(Object.freeze(messages.map((message) => Object.freeze({
        id: message.id,
        jobName: message.payload?.name || null,
        dedupeKey: message.dedupeKey
      }))));
    }
    for (const message of messages) {
      try {
        assertWorkflowJob({ ...message.payload, dedupeKey: message.dedupeKey });
        await this.queue.enqueue({ ...message.payload, dedupeKey: message.dedupeKey });
        if (this.afterEnqueue) {
          await this.afterEnqueue(Object.freeze({
            id: message.id,
            jobName: message.payload?.name || null,
            dedupeKey: message.dedupeKey
          }));
        }
        await this.database.transaction(async (transaction) => {
          const tx = requireTransactionQuery(transaction);
          await tx.query(
            "UPDATE outbox_job SET status = 'sent', leased_until = NULL, lease_token = NULL, updated_at = now() WHERE id = $1 AND status = 'leased' AND lease_token = $2",
            [message.id, message.leaseToken]
          );
        });
      } catch (error) {
        const retryDelaySeconds = this._retryDelaySeconds(message.attempts);
        await this.database.transaction(async (transaction) => {
          const tx = requireTransactionQuery(transaction);
          await tx.query(
            `UPDATE outbox_job
                SET status = CASE WHEN attempts >= $3 THEN 'dead' ELSE 'failed' END,
                    available_at = CASE
                      WHEN attempts >= $3 THEN available_at
                      ELSE now() + ($4 * interval '1 second')
                    END,
                    last_error_code = $5,
                    leased_until = NULL,
                    lease_token = NULL,
                    updated_at = now()
              WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
            [message.id, message.leaseToken, this.maxAttempts, retryDelaySeconds, "outbox_dispatch_failed"]
          );
        });
        this.logger.warn?.("petpack.persistence.outbox_dispatch_failed", {
          outboxId: message.id,
          errorCode: "outbox_dispatch_failed"
        });
      }
    }
    return { claimed: messages.length };
  }
}

/**
 * Re-publishes durable `sent` outbox rows whose PostgreSQL execution has not
 * reached a terminal outcome. This is the recovery path after Redis loses its
 * queue data: BullMQ receives the original deterministic job ID, so an intact
 * queue treats the publish as a no-op while an empty queue is reconstructed.
 * Completed, dead, and reconciliation-required executions are never replayed.
 */
class PostgresSentOutboxReconciler {
  constructor({ database, queue, logger = console } = {}) {
    this.database = requireDatabase(database);
    if (!queue || typeof queue.enqueue !== "function") throw new Error("An idempotent queue is required for outbox reconciliation");
    this.queue = queue;
    this.logger = logger;
  }

  async replayBatch({ limit = 100, cursor = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Outbox reconciliation limit must be between 1 and 100");
    }
    const cursorCreatedAt = cursor === null ? null : requireId(cursor?.createdAt, "Outbox reconciliation cursor timestamp");
    const cursorId = cursor === null ? null : requireId(cursor?.id, "Outbox reconciliation cursor ID");
    if (cursorCreatedAt !== null && !Number.isFinite(Date.parse(cursorCreatedAt))) {
      throw new Error("Outbox reconciliation cursor timestamp is invalid");
    }

    const rows = await this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const result = await tx.query(
        `SELECT outbox.id, outbox.job_name, outbox.payload, outbox.dedupe_key, outbox.created_at
           FROM outbox_job AS outbox
           JOIN production_run AS run
             ON run.id = outbox.aggregate_id
            AND outbox.aggregate_type = 'production_run'
           LEFT JOIN production_job_execution AS execution
             ON execution.job_id = outbox.dedupe_key
          WHERE outbox.status = 'sent'
            AND outbox.job_name <> 'petpack.await-photos'
            AND run.state NOT IN ('deliverable', 'failed')
            AND (
              execution.id IS NULL
              OR execution.status IN ('pending', 'leased', 'retryable')
            )
            AND (
              $2::timestamptz IS NULL
              OR outbox.created_at > $2::timestamptz
              OR (outbox.created_at = $2::timestamptz AND outbox.id > $3::uuid)
            )
          ORDER BY outbox.created_at, outbox.id
          LIMIT $1`,
        [limit, cursorCreatedAt, cursorId]
      );
      return result.rows;
    });

    let replayed = 0;
    for (const row of rows) {
      const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      const job = assertWorkflowJob({ ...payload, dedupeKey: row.dedupe_key });
      if (job.name !== row.job_name) throw new Error("Outbox reconciliation payload does not match its durable job name");
      await this.queue.enqueue(job);
      replayed += 1;
    }

    const last = rows.at(-1);
    const nextCursor = last
      ? Object.freeze({
        createdAt: new Date(last.created_at).toISOString(),
        id: requireId(last.id, "Outbox reconciliation row ID")
      })
      : null;
    if (replayed > 0) {
      this.logger.info?.("petpack.persistence.sent_outbox_replayed", { replayed });
    }
    return Object.freeze({
      scanned: rows.length,
      replayed,
      complete: rows.length < limit,
      nextCursor
    });
  }
}

module.exports = {
  PostgresOutboxDispatcher,
  PostgresSentOutboxReconciler,
  PostgresTransactionalWorkflowStore,
  assertWorkflowJob
};
