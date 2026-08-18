const crypto = require("node:crypto");

const { createModelReference } = require("../config/model-registry");
const { REQUIRED_ACTION_IDS, assertActionId, createVideoJobSnapshot } = require("../domain/action-catalog");
const {
  assertCharacterMasterView,
  PRODUCTION_STATES,
  canAdvanceFromVideoGeneration,
  completeVideoAction,
  startProductionRun,
  transitionProductionRun
} = require("../domain/production-state-machine");

const JOB_NAMES = Object.freeze({
  AWAIT_PHOTOS: "petpack.await-photos",
  GENERATE_FRONT: "petpack.generate-front-master",
  FINALIZE_FRONT: "petpack.finalize-front-master",
  GENERATE_SIDE: "petpack.generate-side-master",
  FINALIZE_SIDE: "petpack.finalize-side-master",
  GENERATE_SLEEP: "petpack.generate-sleep-master",
  FINALIZE_SLEEP: "petpack.finalize-sleep-master",
  GENERATE_VIDEO: "petpack.generate-video-action",
  POLL_VIDEO: "petpack.poll-video-action",
  PROCESS_VIDEO_ACTION: "petpack.process-video-action",
  FINALIZE_VIDEO_ACTION: "petpack.finalize-video-action",
  PROCESS_MEDIA: "petpack.process-media",
  BUILD_PACKAGE: "petpack.build-package",
  VALIDATE_PACKAGE: "petpack.validate-package",
  DELIVERY_READY: "petpack.prepare-delivery"
});
const PACKAGE_RUN_LEVEL_JOB_NAMES = new Set([
  JOB_NAMES.PROCESS_MEDIA,
  JOB_NAMES.BUILD_PACKAGE,
  JOB_NAMES.VALIDATE_PACKAGE,
  JOB_NAMES.DELIVERY_READY
]);

function requiredId(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function createDedupeKey({ orderId, stage, inputRevision, actionId = "" } = {}) {
  const material = [
    requiredId(orderId, "orderId"),
    requiredId(stage, "stage"),
    requiredId(inputRevision, "inputRevision"),
    actionId ? requiredId(actionId, "actionId") : ""
  ].join("|");
  return `petpack:${crypto.createHash("sha256").update(material).digest("hex")}`;
}

function createWorkflowJob({ name, run, inputRevision, actionId, attempts = 3 } = {}) {
  if (!Object.values(JOB_NAMES).includes(name)) throw new Error("Unsupported PetPack workflow job");
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("Workflow job attempts must be a positive integer");
  if (actionId) assertActionId(actionId);
  const dedupeKey = createDedupeKey({
    orderId: run.orderId,
    stage: name,
    inputRevision,
    actionId
  });
  return {
    name,
    data: {
      runId: requiredId(run.id, "runId"),
      ...(actionId ? { actionId } : {})
    },
    options: {
      jobId: dedupeKey,
      attempts,
      // Package jobs also hold a durable PostgreSQL lease. A crashed BullMQ
      // worker can be redelivered before that lease expires, so the queue retry
      // delay must outlive the short base lease instead of acknowledging busy.
      backoff: {
        type: "exponential",
        delay: PACKAGE_RUN_LEVEL_JOB_NAMES.has(name) ? 5 * 60 * 1000 : 5000
      },
      removeOnComplete: false,
      removeOnFail: false
    },
    dedupeKey
  };
}

function requireRunStore(runStore) {
  const supportsAtomicCommit = runStore && typeof runStore.commitTransition === "function";
  const supportsFallback = runStore && typeof runStore.saveRun === "function" && typeof runStore.saveVideoJobSnapshots === "function";
  if (!supportsAtomicCommit && !supportsFallback) {
    throw new Error("A production run store is required");
  }
  return runStore;
}

function requireWorkflowQueue(queue, { optional = false } = {}) {
  if (optional && (!queue || typeof queue.enqueue !== "function")) return null;
  if (!queue || typeof queue.enqueue !== "function") {
    throw new Error("An idempotent workflow queue is required");
  }
  return queue;
}

function requirePromptStore(promptStore) {
  if (!promptStore || typeof promptStore.listPublishedMetadata !== "function") {
    throw new Error("A server-side prompt metadata store is required");
  }
  return promptStore;
}

/**
 * Orchestrates durable state changes and queue messages. Queue payloads contain
 * only IDs; workers load encrypted/private source media and prompt text from
 * server stores, preventing prompt or provider URLs from reaching browsers.
 */
class ProductionWorkflow {
  constructor({
    runStore,
    queue,
    promptStore,
    modelRegistry,
    maxCharacterMasterQaRetries = 2,
    maxSleepMasterRetries = 2,
    logger = console
  } = {}) {
    this.runStore = requireRunStore(runStore);
    this.queue = requireWorkflowQueue(queue, { optional: typeof this.runStore.commitTransition === "function" });
    this.promptStore = requirePromptStore(promptStore);
    if (!modelRegistry) throw new Error("A ModelArk model registry is required");
    if (!Number.isInteger(maxSleepMasterRetries) || maxSleepMasterRetries < 0) {
      throw new Error("maxSleepMasterRetries must be a non-negative integer");
    }
    if (!Number.isInteger(maxCharacterMasterQaRetries) || maxCharacterMasterQaRetries < 0) {
      throw new Error("maxCharacterMasterQaRetries must be a non-negative integer");
    }
    this.modelRegistry = modelRegistry;
    this.maxSleepMasterRetries = maxSleepMasterRetries;
    this.maxCharacterMasterQaRetries = maxCharacterMasterQaRetries;
    this.logger = logger;
  }

  async _commit({ previousRun = null, run, snapshots = [], jobs = [], masterFrames = null } = {}) {
    let committedRun = run;
    if (typeof this.runStore.commitTransition === "function") {
      committedRun = await this.runStore.commitTransition({ previousRun, run, snapshots, jobs, masterFrames }) || run;
    } else {
      // The dependency-injected fallback keeps unit tests and local prototypes
      // usable. Production persistence supplies `commitTransition`, which
      // writes the run transition, action snapshots, and outbox rows together.
      if (snapshots.length > 0) await this.runStore.saveVideoJobSnapshots({ runId: run.id, snapshots });
      if (masterFrames && typeof this.runStore.savePromptGateMasters === "function") {
        await this.runStore.savePromptGateMasters({ runId: run.id, ...masterFrames });
      }
      await this.runStore.saveRun(run);
      for (const job of jobs) await this.queue.enqueue(job);
    }
    this.logger.info?.("petpack.workflow.transition", {
      runId: committedRun.id,
      state: committedRun.state,
      jobs: jobs.map((job) => job.name),
      actionIds: jobs.map((job) => job.data.actionId).filter(Boolean)
    });
    return committedRun;
  }

  async _saveAndQueue(previousRun, run, job) {
    return this._commit({ previousRun, run, jobs: job ? [job] : [] });
  }

  async startPaidOrder({ order, projectId, runId, species }) {
    const run = startProductionRun({
      order,
      projectId,
      runId,
      modelRegistryVersion: this.modelRegistry.version,
      species
    });
    const job = createWorkflowJob({
      name: JOB_NAMES.AWAIT_PHOTOS,
      run,
      inputRevision: "awaiting-source-photos",
      attempts: 1
    });
    return this._saveAndQueue(null, run, job);
  }

  async photosAccepted({ run, sourcePhotoRevisionId }) {
    const next = transitionProductionRun(run, "photosAccepted");
    const job = createWorkflowJob({
      name: JOB_NAMES.GENERATE_FRONT,
      run: next,
      inputRevision: `${requiredId(sourcePhotoRevisionId, "sourcePhotoRevisionId")}:front-${next.frontGenerationAttempts}`,
      attempts: this.modelRegistry.modelArk.image.maxRetries + 1
    });
    return this._saveAndQueue(run, next, job);
  }

  async regenerateCharacterMaster({ run, sourcePhotoRevisionId, view }) {
    const safeView = assertCharacterMasterView(view);
    const next = transitionProductionRun(run, "characterRegenerationRequested", { view: safeView });
    const job = createWorkflowJob({
      name: safeView === "front" ? JOB_NAMES.GENERATE_FRONT : JOB_NAMES.GENERATE_SIDE,
      run: next,
      inputRevision: `${requiredId(sourcePhotoRevisionId, "sourcePhotoRevisionId")}:${safeView}-${next[`${safeView}GenerationAttempts`]}`,
      attempts: this.modelRegistry.modelArk.image.maxRetries + 1
    });
    this.logger.info?.("petpack.workflow.character_regeneration_accepted", {
      runId: run.id,
      view: safeView,
      userRegenerationsUsed: next[`${safeView}UserRegenerationsUsed`]
    });
    return this._saveAndQueue(run, next, job);
  }

  async characterMasterGenerated({ run, view, candidateId }) {
    const safeView = assertCharacterMasterView(view);
    const next = transitionProductionRun(run, "characterMasterGenerated", { view: safeView });
    let job = null;
    if (safeView === "front" && Number(run.sideGenerationAttempts || 0) === 0) {
      job = createWorkflowJob({
        name: JOB_NAMES.GENERATE_SIDE,
        run: next,
        inputRevision: `${requiredId(candidateId, "Front candidate ID")}:side-${next.sideGenerationAttempts}`,
        attempts: this.modelRegistry.modelArk.image.maxRetries + 1
      });
    }
    return this._saveAndQueue(run, next, job);
  }

  async characterMasterQaFailed({ run, view }) {
    if (!run || run.state !== PRODUCTION_STATES.AWAKE_GENERATING) {
      throw new Error("Character-master QA can fail only while a character master is generating");
    }
    const safeView = assertCharacterMasterView(view);
    const retries = Number(run[`${safeView}QaRetries`] || 0);
    if (retries < this.maxCharacterMasterQaRetries) {
      const retried = transitionProductionRun(run, "characterMasterQaRetry", { view: safeView });
      const job = createWorkflowJob({
        name: safeView === "front" ? JOB_NAMES.GENERATE_FRONT : JOB_NAMES.GENERATE_SIDE,
        run: retried,
        inputRevision: `${safeView}:internal-qa-retry-${retried[`${safeView}GenerationAttempts`]}`,
        attempts: this.modelRegistry.modelArk.image.maxRetries + 1
      });
      this.logger.warn?.("petpack.workflow.character_qa_retry_scheduled", {
        runId: run.id,
        view: safeView,
        qaRetry: retried[`${safeView}QaRetries`]
      });
      return this._saveAndQueue(run, retried, job);
    }
    const failed = {
      ...transitionProductionRun(run, "failed"),
      failureCode: `${safeView}_master_qa_failed`
    };
    this.logger.error?.("petpack.workflow.character_qa_retries_exhausted", {
      runId: run.id,
      view: safeView,
      qaRetries: retries
    });
    return this._saveAndQueue(run, failed);
  }

  async confirmCharacterMasters({ run, frontMasterRevisionId, sideMasterRevisionId }) {
    const next = transitionProductionRun(run, "characterConfirmed");
    const safeFrontMasterRevisionId = requiredId(frontMasterRevisionId, "frontMasterRevisionId");
    const safeSideMasterRevisionId = requiredId(sideMasterRevisionId, "sideMasterRevisionId");
    const job = createWorkflowJob({
      name: JOB_NAMES.GENERATE_SLEEP,
      run: next,
      inputRevision: `${safeFrontMasterRevisionId}:${safeSideMasterRevisionId}:sleep-${next.sleepGenerationAttempts}`,
      attempts: this.maxSleepMasterRetries + 1
    });
    if (typeof this.runStore.confirmCharacterCandidatesAndCommitTransition === "function") {
      const committedRun = await this.runStore.confirmCharacterCandidatesAndCommitTransition({
        previousRun: run,
        run: next,
        frontCandidateId: safeFrontMasterRevisionId,
        sideCandidateId: safeSideMasterRevisionId,
        jobs: [job]
      });
      this.logger.info?.("petpack.workflow.transition", {
        runId: committedRun.id,
        state: committedRun.state,
        jobs: [job.name],
        actionIds: []
      });
      return committedRun;
    }
    return this._saveAndQueue(run, next, job);
  }

  async sleepMasterQaFailed({ run }) {
    const retried = transitionProductionRun(run, "sleepMasterQaRetry");
    if (retried.sleepGenerationAttempts > this.maxSleepMasterRetries) {
      const failed = {
        ...transitionProductionRun(retried, "failed"),
        failureCode: "sleep_master_qa_failed"
      };
      return this._saveAndQueue(run, failed);
    }
    const job = createWorkflowJob({
      name: JOB_NAMES.GENERATE_SLEEP,
      run: retried,
      inputRevision: `${requiredId(run.characterRevisionId, "Character revision ID")}:sleep-${retried.sleepGenerationAttempts}`,
      attempts: 1
    });
    return this._saveAndQueue(run, retried, job);
  }

  async sleepMasterQaPassed({ run, frontMaster, sideMaster, sleepMaster }) {
    const awaitingPromptGate = transitionProductionRun(run, "sleepMasterQaPassed");
    // Persist the gate before querying admin metadata. If one of the seven
    // prompts is unpublished, operations can correct it without regenerating a
    // valid sleeping master or losing the run's recoverable state.
    const persistedPromptGate = await this._commit({
      previousRun: run,
      run: awaitingPromptGate,
      masterFrames: { frontMaster, sideMaster, sleepMaster }
    });
    return this.resumeAwaitingPromptGate({ run: persistedPromptGate, frontMaster, sideMaster, sleepMaster });
  }

  async resumeAwaitingPromptGate({ run, frontMaster, sideMaster, sleepMaster } = {}) {
    if (!run || run.state !== PRODUCTION_STATES.AWAITING_PROMPT_GATE) {
      throw new Error("Prompt gate can be resumed only after a valid sleeping master is ready");
    }
    let masters = { frontMaster, sideMaster, sleepMaster };
    if ((!masters.frontMaster || !masters.sideMaster || !masters.sleepMaster) && typeof this.runStore.getPromptGateMasters === "function") {
      masters = await this.runStore.getPromptGateMasters({ runId: run.id });
    }
    if (!masters || !masters.frontMaster || !masters.sideMaster || !masters.sleepMaster) {
      throw new Error("Prompt gate resume requires persisted front, side, and sleeping master frames");
    }
    if (run.modelRegistryVersion !== this.modelRegistry.version) {
      throw new Error("The production run's frozen model registry is not loaded; refusing to switch models mid-run");
    }
    const promptVersions = await this.promptStore.listPublishedMetadata({ species: run.species });
    const videoRun = transitionProductionRun(run, "promptsVerified", { promptVersions });
    const byAction = new Map(promptVersions.map((version) => [version.actionId, version]));
    const videoReference = createModelReference(this.modelRegistry, "video");
    const snapshots = REQUIRED_ACTION_IDS.map((actionId) => createVideoJobSnapshot({
      actionId,
      promptVersion: byAction.get(actionId),
      frontMaster: masters.frontMaster,
      sideMaster: masters.sideMaster,
      sleepMaster: masters.sleepMaster,
      modelReference: videoReference
    }));
    const videoJobs = snapshots.map((snapshot) => createWorkflowJob({
        name: JOB_NAMES.GENERATE_VIDEO,
        run: videoRun,
        inputRevision: `${snapshot.promptVersionId}:${snapshot.firstFrameObjectKey}:${snapshot.lastFrameObjectKey}`,
        actionId: snapshot.actionId,
        attempts: this.modelRegistry.modelArk.video.maxRetries + 1
      }));
    const persistedVideoRun = await this._commit({ previousRun: run, run: videoRun, snapshots, jobs: videoJobs });
    this.logger.info?.("petpack.workflow.video_generation_released", { runId: videoRun.id, actionCount: snapshots.length });
    return persistedVideoRun;
  }

  async videoActionQaPassed({ run, actionId, actionRevisionId, providerTaskId }) {
    const safeProviderTaskId = requiredId(providerTaskId, "providerTaskId");
    if (typeof this.runStore.completeVideoActionAndMaybeQueue === "function") {
      const potentialNext = { ...run, state: PRODUCTION_STATES.MEDIA_PROCESSING };
      const job = createWorkflowJob({
        name: JOB_NAMES.PROCESS_MEDIA,
        run: potentialNext,
        inputRevision: requiredId(actionRevisionId, "actionRevisionId"),
        attempts: 3
      });
      return this.runStore.completeVideoActionAndMaybeQueue({ run, actionId, actionRevisionId, providerTaskId: safeProviderTaskId, job });
    }
    const completed = completeVideoAction(run, actionId);
    if (!canAdvanceFromVideoGeneration(completed)) {
      return this._commit({ previousRun: run, run: completed });
    }
    const next = transitionProductionRun(completed, "videosGenerated");
    const job = createWorkflowJob({
      name: JOB_NAMES.PROCESS_MEDIA,
      run: next,
      inputRevision: requiredId(actionRevisionId, "actionRevisionId"),
      attempts: 3
    });
    return this._saveAndQueue(run, next, job);
  }

  async mediaProcessed({ run, mediaRevisionId }) {
    const next = transitionProductionRun(run, "mediaProcessed");
    const job = createWorkflowJob({
      name: JOB_NAMES.BUILD_PACKAGE,
      run: next,
      inputRevision: requiredId(mediaRevisionId, "mediaRevisionId"),
      attempts: 2
    });
    return this._saveAndQueue(run, next, job);
  }

  async packageBuilt({ run, packageRevisionId }) {
    const next = transitionProductionRun(run, "packageBuilt");
    const job = createWorkflowJob({
      name: JOB_NAMES.VALIDATE_PACKAGE,
      run: next,
      inputRevision: requiredId(packageRevisionId, "packageRevisionId"),
      attempts: 1
    });
    return this._saveAndQueue(run, next, job);
  }

  async packageValidated({ run, packageRevisionId }) {
    if (!run || run.state !== PRODUCTION_STATES.VALIDATING) {
      throw new Error("A validated PetPack can be queued for delivery only while the run is validating");
    }
    const job = createWorkflowJob({
      name: JOB_NAMES.DELIVERY_READY,
      run,
      inputRevision: requiredId(packageRevisionId, "packageRevisionId"),
      attempts: 3
    });
    if (typeof this.runStore.commitJobs === "function") {
      await this.runStore.commitJobs({ run, jobs: [job] });
    } else {
      await this.queue.enqueue(job);
    }
    return run;
  }

  async deliveryReady({ run }) {
    const next = transitionProductionRun(run, "deliveryReady");
    return this._saveAndQueue(run, next);
  }
}

module.exports = {
  JOB_NAMES,
  PACKAGE_RUN_LEVEL_JOB_NAMES,
  ProductionWorkflow,
  createDedupeKey,
  createWorkflowJob
};
