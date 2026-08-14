const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { loadModelRegistry } = require("../config/model-registry");
const { createTrustedFileProbe } = require("../media/ffprobe-media-probe");
const { MediaWorker, runProcess } = require("../media/media-worker");
const { PrivateMasterImageWorkspace } = require("../media/private-master-image-workspace");
const { PrivateMediaWorkspace } = require("../media/private-media-workspace");
const { PrivatePetpackWorkspace } = require("../petpack/private-petpack-workspace");
const { PostgresImageMasterWorkerRepository } = require("../persistence/postgres-image-master-worker-repository");
const { PostgresPetPackStudioRepository } = require("../persistence/postgres-petpack-studio-repository");
const { PostgresPetpackWorkerRepository } = require("../persistence/postgres-petpack-worker-repository");
const { createPostgresDatabase } = require("../persistence/postgres-database");
const { PostgresProductionWorkerRepository } = require("../persistence/postgres-production-worker-repository");
const { PostgresTransactionalWorkflowStore } = require("../persistence/postgres-transactional-workflow-store");
const { ModelArkClient } = require("../providers/modelark-client");
const { BullMqWorkflowWorker, loadBullMqConfig } = require("../queue/bullmq-workflow-queue");
const { PrivateObjectStore } = require("../storage/private-object-store");
const { createTencentCosPrivateObjectDriver } = require("../storage/tencent-cos-private-object-driver");
const { ImageMasterWorker } = require("../workers/image-master-worker");
const { PetpackPipelineWorker } = require("../workers/petpack-pipeline-worker");
const { ProductionJobWorker } = require("../workers/production-job-worker");
const { WorkflowJobRouter } = require("../workers/workflow-job-router");
const { ProductionWorkflow } = require("../workflow/production-workflow");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

function boundedInteger(value, fallback, minimum, maximum, label, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === "" || value === null)) return null;
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function requiredAbsolutePath(value, fallback, label, { production = false } = {}) {
  const selected = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (production && !path.isAbsolute(selected)) throw new Error(`${label} must be an absolute path in production`);
  return selected;
}

function loadStudioWorkerRuntimeConfig(environment = process.env) {
  const mode = typeof environment.PETPACK_PLATFORM_MODE === "string" && environment.PETPACK_PLATFORM_MODE.trim()
    ? environment.PETPACK_PLATFORM_MODE.trim()
    : "development";
  if (!["development", "test", "production"].includes(mode)) {
    throw new Error("PETPACK_PLATFORM_MODE must be development, test, or production");
  }
  const production = mode === "production";
  const deliveryRetentionDays = boundedInteger(
    environment.PETPACK_DELIVERY_RETENTION_DAYS,
    null,
    1,
    3650,
    "Delivery retention days",
    { nullable: true }
  );
  if (production && deliveryRetentionDays === null) {
    throw new Error("Production delivery retention days are required");
  }
  return Object.freeze({
    mode,
    production,
    tempRoot: requiredAbsolutePath(environment.PETPACK_WORKER_TEMP_ROOT, os.tmpdir(), "Worker temporary root", { production }),
    ffmpegPath: requiredAbsolutePath(environment.FFMPEG_PATH, "ffmpeg", "FFmpeg path", { production }),
    ffprobePath: requiredAbsolutePath(environment.FFPROBE_PATH, "ffprobe", "ffprobe path", { production }),
    masterLeaseSeconds: boundedInteger(environment.PETPACK_MASTER_JOB_LEASE_SECONDS, 900, 30, 3600, "Master job lease seconds"),
    videoLeaseSeconds: boundedInteger(environment.PETPACK_VIDEO_JOB_LEASE_SECONDS, 120, 30, 3600, "Video job lease seconds"),
    videoProcessingLeaseSeconds: boundedInteger(environment.PETPACK_VIDEO_PROCESSING_LEASE_SECONDS, 900, 30, 3600, "Video processing lease seconds"),
    petpackLeaseSeconds: boundedInteger(environment.PETPACK_PETPACK_JOB_LEASE_SECONDS, 180, 30, 3600, "PetPack job lease seconds"),
    providerPollDelaySeconds: boundedInteger(environment.PETPACK_PROVIDER_POLL_DELAY_SECONDS, 15, 5, 3600, "Provider poll delay seconds"),
    providerPollQueryAttempts: boundedInteger(environment.PETPACK_PROVIDER_POLL_QUERY_ATTEMPTS, 3, 1, 20, "Provider poll query attempts"),
    maximumProviderPolls: boundedInteger(environment.PETPACK_MAX_PROVIDER_POLLS, 120, 1, 1000, "Maximum provider polls"),
    heavyJobConcurrency: boundedInteger(environment.PETPACK_HEAVY_JOB_CONCURRENCY, 1, 1, 16, "Heavy job concurrency"),
    deliveryRetentionDays
  });
}

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") throw new Error(`${label} must implement ${method}`);
  return value;
}

async function assertStudioWorkerSchemaReady(database) {
  requireMethod(database, "query", "PostgreSQL database");
  const result = await database.query(
    `SELECT to_regclass('public.production_job_execution') IS NOT NULL AS has_execution,
            to_regclass('public.master_image_generation') IS NOT NULL AS has_master_generation,
            to_regclass('public.petpack_input_snapshot') IS NOT NULL AS has_petpack_snapshot,
            to_regclass('public.provider_usage_attempt') IS NOT NULL AS has_usage_attempt,
            EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'production_run'
                 AND column_name = 'side_generation_attempts'
            ) AS has_side_master,
            EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'payment_event'
                 AND column_name = 'adapter_version'
            ) AS has_kaipay_adapter_version`
  );
  const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
  const required = [
    "has_execution", "has_master_generation", "has_petpack_snapshot",
    "has_usage_attempt", "has_side_master", "has_kaipay_adapter_version"
  ];
  if (!row || required.some((name) => row[name] !== true)) {
    throw new Error("PostgreSQL Studio Worker schema is not ready through migration 014");
  }
  return Object.freeze({ ready: true, migration: 14 });
}

async function assertWorkerTempRoot(tempRoot) {
  const stat = await fsp.lstat(tempRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Worker temporary root must be a real directory");
  return fsp.realpath(tempRoot);
}

async function loadWorkerComponentsModule({ environment = process.env, context = {} } = {}) {
  const modulePath = typeof environment.PETPACK_WORKER_COMPONENTS_MODULE === "string"
    ? environment.PETPACK_WORKER_COMPONENTS_MODULE.trim()
    : "";
  if (!modulePath || !path.isAbsolute(modulePath)) {
    throw new Error("PETPACK_WORKER_COMPONENTS_MODULE must be an absolute path");
  }
  const stat = fs.lstatSync(modulePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Worker components module must be a regular non-symbolic file");
  }
  const loaded = require(modulePath);
  const factory = typeof loaded === "function" ? loaded : loaded?.createWorkerComponents;
  if (typeof factory !== "function") throw new Error("Worker components module must export createWorkerComponents");
  const components = await factory({ ...context, environment });
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    throw new Error("Worker components module returned an invalid component set");
  }
  return components;
}

function validateWorkerComponents(components, { production }) {
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    throw new Error("Studio Worker components are required");
  }
  requireMethod(components.masterImageProcessor, "normalizeAndInspect", "Master image processor");
  requireMethod(components.mattingService, "createMatteAndMetrics", "Matting service");
  requireMethod(components.mattingService, "inspectProcessedAction", "Matting service");
  requireMethod(components.deliveryValidator, "describe", "PetPack delivery validator");
  requireMethod(components.deliveryValidator, "validate", "PetPack delivery validator");
  if (!production) {
    requireMethod(components.modelArkClient, "createVideoTask", "Development ModelArk fixture client");
    requireMethod(components.modelArkClient, "getVideoTask", "Development ModelArk fixture client");
  } else {
    if (components.productionAssured !== true) {
      throw new Error("Production Studio Worker components must be explicitly production-assured");
    }
    requireMethod(components.qaPolicyProvider, "getPolicy", "Production QA policy provider");
  }
  if (components.close !== undefined && typeof components.close !== "function") {
    throw new Error("Worker components close hook must be a function");
  }
  return components;
}

class StudioWorkerRuntime {
  constructor({ database, queueWorker, config, components = {}, logger = console } = {}) {
    this.database = requireMethod(requireMethod(database, "assertReady", "PostgreSQL database"), "close", "PostgreSQL database");
    requireMethod(this.database, "query", "PostgreSQL database");
    this.queueWorker = requireMethod(requireMethod(queueWorker, "start", "BullMQ workflow worker"), "close", "BullMQ workflow worker");
    this.config = config || loadStudioWorkerRuntimeConfig();
    this.components = components;
    this.logger = logger;
    this.started = false;
    this.closed = false;
  }

  async start() {
    if (this.closed) throw new Error("Studio Worker runtime is closed");
    if (this.started) throw new Error("Studio Worker runtime is already running");
    try {
      await this.database.assertReady();
      await assertStudioWorkerSchemaReady(this.database);
      const tempRoot = await assertWorkerTempRoot(this.config.tempRoot);
      const ready = await this.queueWorker.start();
      this.started = true;
      this.logger.info?.("petpack.studio_worker.started", {
        mode: this.config.mode,
        concurrency: ready?.concurrency,
        tempRootReady: Boolean(tempRoot)
      });
      return Object.freeze({ ready: true, mode: this.config.mode, concurrency: ready?.concurrency || null });
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    const failures = [];
    try { await this.queueWorker.close(); } catch (error) { failures.push(error); }
    if (typeof this.components.close === "function") {
      try { await this.components.close(); } catch (error) { failures.push(error); }
    }
    try { await this.database.close(); } catch (error) { failures.push(error); }
    this.started = false;
    this.closed = true;
    if (failures.length) throw failures[0];
  }
}

async function createStudioWorkerRuntime({
  environment = process.env,
  PoolClass,
  WorkerClass,
  database,
  objectDriver,
  objectStore,
  modelRegistry,
  workerComponents,
  queueWorker,
  logger = console,
  fetchImpl = globalThis.fetch
} = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  const config = loadStudioWorkerRuntimeConfig(hydrated);
  const runtimeDatabase = database || createPostgresDatabase({ environment: hydrated, PoolClass, logger });
  let componentsToClose = null;
  try {
    const runtimeModelRegistry = modelRegistry || loadModelRegistry(hydrated);
    const runtimeObjectDriver = objectDriver || createTencentCosPrivateObjectDriver({ environment: hydrated });
    const runtimeObjectStore = objectStore || new PrivateObjectStore({
      driver: runtimeObjectDriver,
      fetchImpl,
      logger
    });
    const rawComponents = workerComponents || await loadWorkerComponentsModule({
      environment: hydrated,
      context: {
        database: runtimeDatabase,
        modelRegistry: runtimeModelRegistry,
        objectDriver: runtimeObjectDriver,
        objectStore: runtimeObjectStore,
        tempRoot: config.tempRoot,
        logger
      }
    });
    componentsToClose = rawComponents;
    const components = validateWorkerComponents(rawComponents, { production: config.production });
    const runStore = new PostgresTransactionalWorkflowStore({ database: runtimeDatabase, logger });
    const promptStore = new PostgresPetPackStudioRepository({ database: runtimeDatabase, logger });
    const workflow = new ProductionWorkflow({
      runStore,
      promptStore,
      modelRegistry: runtimeModelRegistry,
      logger
    });
    const imageRepository = new PostgresImageMasterWorkerRepository({ database: runtimeDatabase, logger });
    const productionRepository = new PostgresProductionWorkerRepository({ database: runtimeDatabase, logger });
    const petpackRepository = new PostgresPetpackWorkerRepository({ database: runtimeDatabase, logger });
    const masterWorkspace = new PrivateMasterImageWorkspace({
      driver: runtimeObjectDriver,
      tempRoot: config.tempRoot,
      logger
    });
    const mediaWorkspace = new PrivateMediaWorkspace({
      driver: runtimeObjectDriver,
      tempRoot: config.tempRoot,
      logger
    });
    const petpackWorkspace = new PrivatePetpackWorkspace({
      driver: runtimeObjectDriver,
      tempRoot: config.tempRoot,
      logger
    });
    const modelArkClient = components.modelArkClient || new ModelArkClient({
      registry: runtimeModelRegistry,
      fetchImpl,
      logger
    });
    const probeAsset = components.probeAsset || createTrustedFileProbe({ ffprobePath: config.ffprobePath });
    const runMediaPlan = components.runMediaPlan || ((plan) => runProcess({
      ...plan,
      executable: config.ffmpegPath
    }));
    const mediaWorker = new MediaWorker({
      mattingService: components.mattingService,
      probeAsset,
      runPlan: runMediaPlan,
      logger
    });
    const imageMasterWorker = new ImageMasterWorker({
      repository: imageRepository,
      modelArkClient,
      objectStore: runtimeObjectStore,
      masterWorkspace,
      masterImageProcessor: components.masterImageProcessor,
      masterImageProcessorRegistry: components.masterImageProcessorRegistry,
      workflow,
      modelRegistry: runtimeModelRegistry,
      qaPolicyProvider: components.qaPolicyProvider,
      leaseSeconds: config.masterLeaseSeconds,
      productionMode: config.production,
      logger
    });
    const productionJobWorker = new ProductionJobWorker({
      repository: productionRepository,
      modelArkClient,
      objectStore: runtimeObjectStore,
      leaseSeconds: config.videoLeaseSeconds,
      pollDelaySeconds: config.providerPollDelaySeconds,
      pollQueryAttempts: config.providerPollQueryAttempts,
      maxProviderPolls: config.maximumProviderPolls,
      mediaWorker,
      mediaWorkspace,
      workflow,
      qaPolicyProvider: components.qaPolicyProvider,
      productionMode: config.production,
      processingLeaseSeconds: config.videoProcessingLeaseSeconds,
      logger
    });
    const petpackPipelineWorker = new PetpackPipelineWorker({
      repository: petpackRepository,
      workspace: petpackWorkspace,
      deliveryValidator: components.deliveryValidator,
      deliveryValidatorRegistry: components.deliveryValidatorRegistry || [],
      probeAsset,
      leaseSeconds: config.petpackLeaseSeconds,
      maxConcurrentHeavyJobs: config.heavyJobConcurrency,
      productionMode: config.production,
      deliveryRetentionDays: config.deliveryRetentionDays,
      logger
    });
    const router = new WorkflowJobRouter({ imageMasterWorker, productionJobWorker, petpackPipelineWorker });
    const runtimeQueueWorker = queueWorker || new BullMqWorkflowWorker({
      config: loadBullMqConfig(hydrated),
      handler: router,
      WorkerClass,
      logger
    });
    return new StudioWorkerRuntime({
      database: runtimeDatabase,
      queueWorker: runtimeQueueWorker,
      config,
      components: {
        ...components,
        workflow,
        modelArkClient,
        probeAsset,
        imageMasterWorker,
        productionJobWorker,
        petpackPipelineWorker,
        router
      },
      logger
    });
  } catch (error) {
    if (typeof componentsToClose?.close === "function") {
      await componentsToClose.close().catch(() => undefined);
    }
    await runtimeDatabase.close().catch(() => undefined);
    throw error;
  }
}

module.exports = {
  StudioWorkerRuntime,
  assertStudioWorkerSchemaReady,
  assertWorkerTempRoot,
  createStudioWorkerRuntime,
  loadStudioWorkerRuntimeConfig,
  loadWorkerComponentsModule,
  validateWorkerComponents
};
