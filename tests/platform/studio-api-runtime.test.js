import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  StudioApiRuntime,
  assertStudioApiSchemaReady,
  createStudioApiRuntime,
  loadStudioApiRuntimeConfig
} = require("../../platform/src/runtime/create-studio-api");

function readySchemaRow(overrides = {}) {
  return {
    has_order: true,
    has_project: true,
    has_run: true,
    has_outbox: true,
    has_payment_event: true,
    has_video_prompts: true,
    has_image_prompts: true,
    has_kaipay_adapter_version: true,
    has_kaipay_v3_identity: true,
    ...overrides
  };
}

function runtimeDependencies() {
  const database = {
    assertReady: vi.fn(async () => ({ ready: true })),
    query: vi.fn(async () => ({ rows: [readySchemaRow()] })),
    close: vi.fn(async () => undefined)
  };
  const httpServer = {
    start: vi.fn(async () => ({ host: "127.0.0.1", port: 8787 })),
    close: vi.fn(async () => undefined)
  };
  return { database, httpServer };
}

describe("Studio API runtime", () => {
  it("uses a loopback development bind and an explicit production container bind", () => {
    expect(loadStudioApiRuntimeConfig({ PETPACK_API_PORT: "0" })).toMatchObject({
      mode: "development",
      host: "127.0.0.1",
      port: 0,
      allowNonLoopback: false,
      phoneAuthExchangeEnabled: false
    });
    expect(loadStudioApiRuntimeConfig({
      PETPACK_PLATFORM_MODE: "production",
      PETPACK_API_PORT: "8787",
      PETPACK_PHONE_AUTH_ENABLED: "true",
      PETPACK_STUDIO_INTERNAL_TOKEN: "internal-token-at-least-32-bytes-long"
    })).toMatchObject({
      mode: "production",
      host: "0.0.0.0",
      port: 8787,
      allowNonLoopback: true,
      phoneAuthExchangeEnabled: true,
      internalBearerToken: "internal-token-at-least-32-bytes-long"
    });
    expect(() => loadStudioApiRuntimeConfig({
      PETPACK_PLATFORM_MODE: "production",
      PETPACK_API_PORT: "8787"
    })).toThrow(/internal gateway token/);
    expect(() => loadStudioApiRuntimeConfig({ PETPACK_PLATFORM_MODE: "preview" })).toThrow(/development, test, or production/);
    expect(() => loadStudioApiRuntimeConfig({ PETPACK_API_PORT: "80" })).toThrow(/port/);
  });

  it("requires the full Studio and Kaipay V3 schema through migration 015", async () => {
    await expect(assertStudioApiSchemaReady({
      query: vi.fn(async () => ({ rows: [readySchemaRow({ has_kaipay_adapter_version: false })] }))
    })).rejects.toThrow(/migration 015/);
    await expect(assertStudioApiSchemaReady({
      query: vi.fn(async () => ({ rows: [readySchemaRow({ has_kaipay_v3_identity: false })] }))
    })).rejects.toThrow(/migration 015/);
    await expect(assertStudioApiSchemaReady({
      query: vi.fn(async () => ({ rows: [readySchemaRow()] }))
    })).resolves.toEqual({ ready: true, migration: 15 });
  });

  it("checks readiness before listening and closes cleanly", async () => {
    const deps = runtimeDependencies();
    const runtime = new StudioApiRuntime({
      ...deps,
      config: loadStudioApiRuntimeConfig({ PETPACK_API_PORT: "0" }),
      logger: { info: vi.fn() }
    });
    await expect(runtime.start()).resolves.toEqual({ host: "127.0.0.1", port: 8787, mode: "development" });
    expect(deps.database.assertReady.mock.invocationCallOrder[0]).toBeLessThan(deps.httpServer.start.mock.invocationCallOrder[0]);
    await runtime.close();
    expect(deps.httpServer.close).toHaveBeenCalledOnce();
    expect(deps.database.close).toHaveBeenCalledOnce();
  });

  it("fails closed and releases the database when schema readiness fails", async () => {
    const deps = runtimeDependencies();
    deps.database.query.mockResolvedValue({ rows: [readySchemaRow({ has_image_prompts: false })] });
    const runtime = new StudioApiRuntime({
      ...deps,
      config: loadStudioApiRuntimeConfig(),
      logger: { info: vi.fn() }
    });
    await expect(runtime.start()).rejects.toThrow(/schema is not ready/);
    expect(deps.httpServer.start).not.toHaveBeenCalled();
    expect(deps.database.close).toHaveBeenCalledOnce();
  });

  it("assembles an injectable full API without requiring real cloud or payment calls", async () => {
    const deps = runtimeDependencies();
    const authBundle = {
      authService: {
        exchangeCloudBaseAccessToken: vi.fn(),
        revokeSessionToken: vi.fn()
      },
      resolveActor: vi.fn(async () => null),
      cookieName: "petpack_session",
      secureSessionCookie: false
    };
    const repository = {
      getPromptVersions: vi.fn(), savePromptVersions: vi.fn(), getPromptHistory: vi.fn(),
      getImagePromptVersions: vi.fn(), getImagePromptHistory: vi.fn(), saveImagePromptVersions: vi.fn(),
      listAdminOperations: vi.fn()
    };
    const controlsRepository = { publishPriceCard: vi.fn(), summarizeProviderUsage: vi.fn() };
    const workflow = { startPaidOrder: vi.fn(), photosAccepted: vi.fn(), confirmCharacterMasters: vi.fn(), regenerateCharacterMaster: vi.fn() };
    const objectStore = { createUploadGrant: vi.fn(), createDownloadGrant: vi.fn(), verifyUploadedObject: vi.fn() };
    const paymentProvider = { createCheckout: vi.fn(), queryStatus: vi.fn(), handleNotification: vi.fn() };
    const service = {
      createCheckout: vi.fn(), listProjects: vi.fn(), refreshPaymentStatus: vi.fn(), createSourcePhotoUploadGrants: vi.fn(),
      confirmSourcePhotoUpload: vi.fn(), regenerateCharacterMaster: vi.fn(), confirmCharacter: vi.fn(),
      getProjectView: vi.fn(), createPetpackDownload: vi.fn(), handlePaymentNotification: vi.fn()
    };
    const runtime = await createStudioApiRuntime({
      environment: { PETPACK_API_PORT: "0" },
      ...deps,
      authBundle,
      repository,
      controlsRepository,
      runStore: {},
      modelRegistry: { version: "fixture" },
      workflow,
      objectDriver: {},
      objectStore,
      paymentProvider,
      service,
      httpServer: deps.httpServer,
      logger: { info: vi.fn() }
    });
    expect(runtime.components.api.routes.CREATE_CHECKOUT).toBe("POST /api/checkout");
    await runtime.start();
    await runtime.close();
  });
});
