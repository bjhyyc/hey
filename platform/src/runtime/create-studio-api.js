const { AdminCostService } = require("../api/admin-cost-service");
const { AdminImagePromptService } = require("../api/admin-image-prompt-service");
const { AdminOperationsService } = require("../api/admin-operations-service");
const { AdminPromptService } = require("../api/admin-prompt-service");
const { PetPackStudioService } = require("../api/petpack-studio-service");
const { createCloudBasePhoneAuth } = require("../auth/create-cloudbase-phone-auth");
const { loadModelRegistry } = require("../config/model-registry");
const { createPetPackStudioHttpApi } = require("../http/petpack-studio-http-api");
const { createNodeHttpServer } = require("../http/node-http-server");
const { PostgresPetPackStudioRepository } = require("../persistence/postgres-petpack-studio-repository");
const { PostgresProductionControlsRepository } = require("../persistence/postgres-production-controls-repository");
const { createPostgresDatabase } = require("../persistence/postgres-database");
const { PostgresTransactionalWorkflowStore } = require("../persistence/postgres-transactional-workflow-store");
const { loadKaipayConfig } = require("../providers/kaipay-payment-provider");
const { createPaymentProvider } = require("../providers/payment-provider-factory");
const { PrivateObjectStore } = require("../storage/private-object-store");
const { createTencentCosPrivateObjectDriver } = require("../storage/tencent-cos-private-object-driver");
const { ProductionWorkflow } = require("../workflow/production-workflow");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

function boundedPort(value) {
  const parsed = value === undefined || value === "" ? 8787 : Number(value);
  if (!Number.isSafeInteger(parsed) || (parsed !== 0 && parsed < 1_024) || parsed > 65_535) {
    throw new Error("Studio API port must be 0 for a test or between 1024 and 65535");
  }
  return parsed;
}

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") throw new Error(`${label} must implement ${method}`);
  return value;
}

function loadStudioApiRuntimeConfig(environment = process.env) {
  const mode = typeof environment.PETPACK_PLATFORM_MODE === "string" && environment.PETPACK_PLATFORM_MODE.trim()
    ? environment.PETPACK_PLATFORM_MODE.trim()
    : "development";
  if (!["development", "test", "production"].includes(mode)) {
    throw new Error("PETPACK_PLATFORM_MODE must be development, test, or production");
  }
  const production = mode === "production";
  const internalBearerToken = typeof environment.PETPACK_STUDIO_INTERNAL_TOKEN === "string"
    ? environment.PETPACK_STUDIO_INTERNAL_TOKEN
    : "";
  if (production && (internalBearerToken.length < 32 || internalBearerToken.length > 4096 || /[\r\n\u0000]/.test(internalBearerToken))) {
    throw new Error("Production Studio API requires a strong internal gateway token");
  }
  return Object.freeze({
    mode,
    host: production ? "0.0.0.0" : "127.0.0.1",
    port: boundedPort(environment.PETPACK_API_PORT || environment.PETPACK_LOCAL_API_PORT),
    allowNonLoopback: production,
    phoneAuthExchangeEnabled: environment.PETPACK_PHONE_AUTH_ENABLED === "true",
    internalBearerToken
  });
}

async function assertStudioApiSchemaReady(database) {
  requireMethod(database, "query", "PostgreSQL database");
  const result = await database.query(
    `SELECT to_regclass('public.customer_order') IS NOT NULL AS has_order,
            to_regclass('public.pet_project') IS NOT NULL AS has_project,
            to_regclass('public.production_run') IS NOT NULL AS has_run,
            to_regclass('public.outbox_job') IS NOT NULL AS has_outbox,
            to_regclass('public.payment_event') IS NOT NULL AS has_payment_event,
            to_regclass('public.prompt_version') IS NOT NULL AS has_video_prompts,
            to_regclass('public.image_prompt_version') IS NOT NULL AS has_image_prompts,
             EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'payment_event'
                 AND column_name = 'adapter_version'
             ) AS has_kaipay_adapter_version,
             EXISTS (
               SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'payment_attempt'
                  AND column_name = 'credential_version'
             ) AND EXISTS (
               SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'payment_event'
                  AND column_name = 'provider_event_id'
             ) AS has_kaipay_v3_identity`
  );
  const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
  const required = [
    "has_order", "has_project", "has_run", "has_outbox", "has_payment_event",
    "has_video_prompts", "has_image_prompts", "has_kaipay_adapter_version",
    "has_kaipay_v3_identity"
  ];
  if (!row || required.some((name) => row[name] !== true)) {
    throw new Error("PostgreSQL Studio API schema is not ready through migration 015");
  }
  return Object.freeze({ ready: true, migration: 15 });
}

class StudioApiRuntime {
  constructor({ database, httpServer, config, logger = console, components = {} } = {}) {
    this.database = requireMethod(requireMethod(database, "assertReady", "PostgreSQL database"), "close", "PostgreSQL database");
    requireMethod(this.database, "query", "PostgreSQL database");
    this.httpServer = requireMethod(requireMethod(httpServer, "start", "Studio HTTP server"), "close", "Studio HTTP server");
    this.config = config || loadStudioApiRuntimeConfig();
    this.logger = logger;
    this.components = Object.freeze({ ...components });
    this.started = false;
    this.closed = false;
  }

  async start() {
    if (this.closed) throw new Error("Studio API runtime is closed");
    if (this.started) throw new Error("Studio API runtime is already running");
    try {
      await this.database.assertReady();
      await assertStudioApiSchemaReady(this.database);
      const address = await this.httpServer.start();
      this.started = true;
      this.logger.info?.("petpack.studio_api.started", {
        mode: this.config.mode,
        host: address.host,
        port: address.port,
        phoneAuthExchangeEnabled: this.config.phoneAuthExchangeEnabled
      });
      return Object.freeze({ ...address, mode: this.config.mode });
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    const failures = [];
    if (this.started) {
      try { await this.httpServer.close(); } catch (error) { failures.push(error); }
    }
    try { await this.database.close(); } catch (error) { failures.push(error); }
    this.started = false;
    this.closed = true;
    if (failures.length) throw failures[0];
  }
}

async function createStudioApiRuntime({
  environment = process.env,
  PoolClass,
  database,
  authBundle,
  repository,
  controlsRepository,
  runStore,
  modelRegistry,
  workflow,
  objectDriver,
  objectStore,
  paymentProvider,
  kaipayClient,
  notificationProtocol,
  service,
  adminPromptService,
  adminImagePromptService,
  adminOperationsService,
  adminCostService,
  api,
  httpServer,
  fetchImpl = globalThis.fetch,
  logger = console
} = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  const config = loadStudioApiRuntimeConfig(hydrated);
  const runtimeDatabase = database || createPostgresDatabase({ environment: hydrated, PoolClass, logger });
  try {
    const runtimeAuth = authBundle || createCloudBasePhoneAuth({
      database: runtimeDatabase,
      environment: hydrated,
      fetchImpl,
      logger
    });
    const runtimeRepository = repository || new PostgresPetPackStudioRepository({
      database: runtimeDatabase,
      paymentNotificationEncryptionKey: hydrated.PETPACK_PAYMENT_NOTIFICATION_ENCRYPTION_KEY,
      logger
    });
    const runtimeRunStore = runStore || new PostgresTransactionalWorkflowStore({ database: runtimeDatabase, logger });
    const runtimeModelRegistry = modelRegistry || loadModelRegistry(hydrated);
    const runtimeWorkflow = workflow || new ProductionWorkflow({
      runStore: runtimeRunStore,
      promptStore: runtimeRepository,
      modelRegistry: runtimeModelRegistry,
      logger
    });
    const runtimeObjectDriver = objectDriver || createTencentCosPrivateObjectDriver({ environment: hydrated });
    const runtimeObjectStore = objectStore || new PrivateObjectStore({
      driver: runtimeObjectDriver,
      fetchImpl,
      logger
    });
    const runtimePaymentProvider = paymentProvider || createPaymentProvider({
      config: loadKaipayConfig(hydrated),
      kaipayClient,
      notificationProtocol,
      fetchImpl,
      eventStore: runtimeRepository,
      orderStore: runtimeRepository,
      logger
    });
    const runtimeService = service || new PetPackStudioService({
      repository: runtimeRepository,
      paymentProvider: runtimePaymentProvider,
      objectStore: runtimeObjectStore,
      workflow: runtimeWorkflow,
      logger
    });
    const runtimeControlsRepository = controlsRepository || new PostgresProductionControlsRepository({
      database: runtimeDatabase,
      logger
    });
    const runtimeAdminPromptService = adminPromptService || new AdminPromptService({ repository: runtimeRepository, logger });
    const runtimeAdminImagePromptService = adminImagePromptService || new AdminImagePromptService({ repository: runtimeRepository, logger });
    const runtimeAdminOperationsService = adminOperationsService || new AdminOperationsService({ repository: runtimeRepository, logger });
    const runtimeAdminCostService = adminCostService || new AdminCostService({ repository: runtimeControlsRepository, logger });
    const runtimeApi = api || createPetPackStudioHttpApi({
      service: runtimeService,
      authService: runtimeAuth.authService,
      phoneAuthExchangeEnabled: config.phoneAuthExchangeEnabled,
      resolveActor: runtimeAuth.resolveActor,
      sessionCookieName: runtimeAuth.cookieName,
      secureSessionCookie: runtimeAuth.secureSessionCookie,
      internalBearerToken: config.internalBearerToken,
      adminPromptService: runtimeAdminPromptService,
      adminImagePromptService: runtimeAdminImagePromptService,
      adminOperationsService: runtimeAdminOperationsService,
      adminCostService: runtimeAdminCostService,
      logger
    });
    const runtimeHttpServer = httpServer || createNodeHttpServer({
      api: runtimeApi,
      host: config.host,
      port: config.port,
      allowNonLoopback: config.allowNonLoopback,
      healthCheck: async () => {
        await runtimeDatabase.assertReady();
        return { ready: true };
      },
      logger
    });
    return new StudioApiRuntime({
      database: runtimeDatabase,
      httpServer: runtimeHttpServer,
      config,
      logger,
      components: {
        auth: runtimeAuth,
        repository: runtimeRepository,
        controlsRepository: runtimeControlsRepository,
        runStore: runtimeRunStore,
        modelRegistry: runtimeModelRegistry,
        workflow: runtimeWorkflow,
        objectDriver: runtimeObjectDriver,
        objectStore: runtimeObjectStore,
        paymentProvider: runtimePaymentProvider,
        service: runtimeService,
        api: runtimeApi
      }
    });
  } catch (error) {
    await runtimeDatabase.close().catch(() => undefined);
    throw error;
  }
}

module.exports = {
  StudioApiRuntime,
  assertStudioApiSchemaReady,
  createStudioApiRuntime,
  loadStudioApiRuntimeConfig
};
