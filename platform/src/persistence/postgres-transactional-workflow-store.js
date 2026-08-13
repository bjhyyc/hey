const crypto = require("node:crypto");

const { REQUIRED_ACTION_IDS, assertActionId } = require("../domain/action-catalog");
const { PRODUCTION_STATES } = require("../domain/production-state-machine");
const { JOB_NAMES } = require("../workflow/production-workflow");

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
    const awakeMaster = assertPrivateMasterFrame(masterFrames && masterFrames.awakeMaster, "Awake master");
    const sleepMaster = assertPrivateMasterFrame(masterFrames && masterFrames.sleepMaster, "Sleeping master");
    const saved = await tx.query(
      `INSERT INTO production_run_master_frame
        (run_id, awake_master_object_key, sleep_master_object_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (run_id) DO UPDATE
         SET awake_master_object_key = EXCLUDED.awake_master_object_key,
             sleep_master_object_key = EXCLUDED.sleep_master_object_key,
             updated_at = now()
       WHERE production_run_master_frame.awake_master_object_key = EXCLUDED.awake_master_object_key
         AND production_run_master_frame.sleep_master_object_key = EXCLUDED.sleep_master_object_key
       RETURNING run_id`,
      [run.id, awakeMaster.objectKey, sleepMaster.objectKey]
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
        (id, project_id, order_id, state, prompt_snapshot, awake_generation_attempts, sleep_generation_attempts, failure_code, version)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 0)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id, project_id, order_id, character_revision_id, state, version, updated_at`,
      [
        requireId(run.id, "Run ID"),
        requireId(run.projectId, "Project ID"),
        requireId(run.orderId, "Order ID"),
        requireId(run.state, "Run state"),
        serializeJson(run.promptSnapshot),
        Number(run.awakeGenerationAttempts || 0),
        Number(run.sleepGenerationAttempts || 0),
        run.failureCode || null
      ]
    );
    if (inserted.rows.length > 0) return { run: mapRunRow(inserted.rows[0], run), created: true };
    const existing = await tx.query(
      "SELECT id, project_id, order_id, character_revision_id, state, version, updated_at FROM production_run WHERE order_id = $1 FOR UPDATE",
      [run.orderId]
    );
    if (existing.rows.length !== 1) throw new Error("Unable to recover an idempotent production run");
    const existingRun = mapRunRow(existing.rows[0], run);
    if (existingRun.projectId !== run.projectId || existingRun.orderId !== run.orderId) {
      throw new Error("Idempotent production run ownership does not match the requested order");
    }
    return { run: existingRun, created: false };
  }

  async _updateRun(tx, previousRun, run) {
    const expectedVersion = requireVersion(previousRun, "A persisted run transition");
    const result = await tx.query(
      `UPDATE production_run
          SET state = $2,
              prompt_snapshot = $3::jsonb,
              awake_generation_attempts = $4,
              sleep_generation_attempts = $5,
              character_revision_id = COALESCE($6::uuid, character_revision_id),
              failure_code = $7,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND state = $8 AND version = $9
      RETURNING id, project_id, order_id, character_revision_id, state, version, updated_at`,
      [
        requireId(run.id, "Run ID"),
        requireId(run.state, "Run state"),
        serializeJson(run.promptSnapshot),
        Number(run.awakeGenerationAttempts || 0),
        Number(run.sleepGenerationAttempts || 0),
        run.characterRevisionId || null,
        run.failureCode || null,
        requireId(previousRun.state, "Previous run state"),
        expectedVersion
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

  async _claimConfirmedAwakeCharacter(tx, { run, awakeCandidateId }) {
    const candidate = await tx.query(
      `SELECT candidate.id,
               candidate.project_id,
               revision.id AS character_revision_id
         FROM production_run
         JOIN image_candidate candidate
           ON candidate.id = $2
           AND candidate.project_id = production_run.project_id
           AND candidate.run_id = production_run.id
           AND candidate.order_id = production_run.order_id
           AND candidate.generation_attempt = production_run.awake_generation_attempts
         JOIN master_image_generation generation
           ON generation.image_candidate_id = candidate.id
          AND generation.run_id = production_run.id
          AND generation.project_id = production_run.project_id
          AND generation.order_id = production_run.order_id
          AND generation.kind = 'awake'
          AND generation.generation_attempt = production_run.awake_generation_attempts
          AND generation.status = 'qa_passed'
         JOIN media_asset asset
           ON asset.id = candidate.media_asset_id
          AND asset.id = generation.normalized_media_asset_id
          AND asset.project_id = production_run.project_id
          AND asset.run_id = production_run.id
          AND asset.kind = 'awake_master'
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
         LEFT JOIN character_revision revision
           ON revision.awake_candidate_id = candidate.id
        WHERE production_run.id = $1
          AND candidate.kind = 'awake'
          AND candidate.qa_status = 'passed'
        FOR UPDATE OF candidate`,
      [run.id, requireId(awakeCandidateId, "Awake candidate ID")]
    );
    if (candidate.rows.length !== 1) {
      throw new Error("The selected awake character is not a quality-approved candidate for this production run");
    }
    const row = candidate.rows[0];
    // Confirmation is meaningful even when a prior request already created the
    // immutable revision. Mark the selected QA-approved candidate in either
    // case, so an idempotent retry never leaves a usable character unconfirmed.
    const confirmCandidate = async () => tx.query(
      `UPDATE image_candidate
          SET confirmed_at = COALESCE(confirmed_at, now())
        WHERE id = $1 AND project_id = $2 AND qa_status = 'passed'`,
      [row.id, row.project_id]
    );
    if (row.character_revision_id) {
      await confirmCandidate();
      return row.character_revision_id;
    }

    const characterRevisionId = this.idFactory();
    const created = await tx.query(
      `INSERT INTO character_revision
        (id, project_id, awake_candidate_id, canvas_id, approved_by_user_at)
       VALUES ($1, $2, $3, 'character_canvas_v1', now())
       ON CONFLICT (awake_candidate_id) DO NOTHING
       RETURNING id`,
      [characterRevisionId, row.project_id, row.id]
    );
    if (created.rows.length === 1) {
      await confirmCandidate();
      return created.rows[0].id;
    }
    const existing = await tx.query(
      `SELECT id
         FROM character_revision
        WHERE awake_candidate_id = $1
        FOR UPDATE`,
      [row.id]
    );
    if (existing.rows.length !== 1) {
      throw new Error("Confirmed awake character revision could not be recovered");
    }
    await confirmCandidate();
    return existing.rows[0].id;
  }

  /**
   * User confirmation is a production boundary: the selected quality-approved
   * awake candidate, immutable character revision, sleep transition, and
   * sleep-generation outbox job must succeed or roll back together.
   */
  async confirmAwakeCandidateAndCommitTransition({ previousRun, run, awakeCandidateId, jobs = [] } = {}) {
    if (!previousRun || previousRun.id !== (run && run.id)) {
      throw new Error("Awake-character confirmation requires one persisted production run transition");
    }
    if (previousRun.state !== PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION || run.state !== PRODUCTION_STATES.SLEEP_GENERATING) {
      throw new Error("Awake-character confirmation has an invalid production state transition");
    }
    if (!Array.isArray(jobs) || jobs.length !== 1) {
      throw new Error("Awake-character confirmation requires exactly one sleeping-master generation job");
    }
    return this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      const characterRevisionId = await this._claimConfirmedAwakeCharacter(tx, { run, awakeCandidateId });
      const next = { ...run, characterRevisionId };
      const transition = await this._updateRun(tx, previousRun, next);
      const committedRun = { ...transition.run, completedActions: run.completedActions || [] };
      await this._recordTransition(tx, { previousRun, run: committedRun });
      for (const job of jobs) {
        if (!job || !job.data || job.data.runId !== committedRun.id || job.name !== JOB_NAMES.GENERATE_SLEEP) {
          throw new Error("Awake-character confirmation must enqueue the sleeping-master job for its run");
        }
        await this._insertOutbox(tx, job);
      }
      this.logger.info?.("petpack.persistence.awake_character_confirmed", {
        runId: committedRun.id,
        characterRevisionId,
        awakeCandidateId
      });
      return committedRun;
    });
  }

  async getPromptGateMasters({ runId } = {}) {
    const result = await this.database.transaction(async (transaction) => {
      const tx = requireTransactionQuery(transaction);
      return tx.query(
        `SELECT awake_master_object_key, sleep_master_object_key
           FROM production_run_master_frame
          WHERE run_id = $1`,
        [requireId(runId, "Run ID")]
      );
    });
    if (!result || result.rows.length !== 1) return null;
    return {
      awakeMaster: { objectKey: result.rows[0].awake_master_object_key },
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
    this.queue = queue;
    this.leaseTokenFactory = leaseTokenFactory;
    this.maxAttempts = maxAttempts;
    this.baseRetrySeconds = baseRetrySeconds;
    this.maxRetrySeconds = maxRetrySeconds;
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
    for (const message of messages) {
      try {
        assertWorkflowJob({ ...message.payload, dedupeKey: message.dedupeKey });
        await this.queue.enqueue({ ...message.payload, dedupeKey: message.dedupeKey });
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

module.exports = {
  PostgresOutboxDispatcher,
  PostgresTransactionalWorkflowStore,
  assertWorkflowJob
};
