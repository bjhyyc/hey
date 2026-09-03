import { describe, expect, it, vi } from "vitest";

import paymentStateMachine from "../../platform/src/domain/payment-state-machine.js";
import kaipayModule from "../../platform/src/providers/kaipay-payment-provider.js";
import kaipayV3Module from "../../platform/src/providers/kaipay-v3.js";
import simulatedModule from "../../platform/src/providers/simulated-payment-provider.js";
import factoryModule from "../../platform/src/providers/payment-provider-factory.js";
import httpModule from "../../platform/src/http/petpack-studio-http-api.js";
import secretModule from "../../platform/src/runtime/load-secret-files.js";
import repositoryModule from "../../platform/src/persistence/postgres-petpack-studio-repository.js";
import studioServiceModule from "../../platform/src/api/petpack-studio-service.js";

const { assertPaymentMethod, providerStatusToPaymentState } = paymentStateMachine;
const {
  KaipayPaymentProvider,
  loadKaipayConfig,
  normalizeAcknowledgement,
  requireCanonicalStatus
} = kaipayModule;
const { SimulatedPaymentProvider } = simulatedModule;
const { createPaymentProvider } = factoryModule;
const { createPetPackStudioHttpApi } = httpModule;
const { DEFAULT_SECRET_FILE_MAPPINGS } = secretModule;
const { encryptPaymentNotification, normalizePaymentNotificationEncryptionKey } = repositoryModule;
const { PetPackStudioService } = studioServiceModule;
const { KAIPAY_V3_ADAPTER_VERSION, credentialVersionFor } = kaipayV3Module;

const TEST_API_KEY = "pk_live_test_123456";
const TEST_API_SECRET = "test-api-secret-at-least-32-bytes";
const TEST_CREDENTIAL_VERSION = credentialVersionFor({ apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET });
const TEST_CREDENTIALS_JSON = JSON.stringify({
  active: { apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET },
  previous: []
});

function order(overrides = {}) {
  return {
    id: "order-1",
    amountFen: 1990,
    currency: "CNY",
    paymentMethod: "KAIPAY",
    displayName: "淘淘",
    providerOrderId: "kp-order-1",
    paymentCredentialVersion: TEST_CREDENTIAL_VERSION,
    paymentChannel: "ALIPAY",
    paymentProviderCode: "alipay",
    paymentPayMethod: "alipay",
    paymentScene: "web",
    ...overrides
  };
}

function stores(value = order()) {
  return {
    orderStore: { getPaymentOrder: vi.fn(async () => value) },
    eventStore: {
      appendIdempotent: vi.fn(async () => undefined),
      storeEncryptedNotification: vi.fn(async () => undefined)
    }
  };
}

function productionConfig(overrides = {}) {
  return {
    mode: "production",
    credentialsJson: TEST_CREDENTIALS_JSON,
    apiBaseUrl: "https://api.kaipay.cn",
    notifyBaseUrl: "https://api.heyirmy.com/api/payments/kaipay/notify",
    returnBaseUrl: "https://heyirmy.com/projects/payment-return",
    adapterVersion: KAIPAY_V3_ADAPTER_VERSION,
    defaultChannel: "ALIPAY",
    alipayProvider: "alipay",
    alipayPayMethod: "alipay",
    alipayScene: "web",
    wechatProvider: "wechat",
    wechatPayMethod: "wechat",
    wechatScene: "native",
    selectedMerchantCode: "",
    requestTimeoutMs: "15000",
    allowSimulatedPayments: false,
    ...overrides
  };
}

describe("Kaipay payment contract", () => {
  it("accepts only the canonical KAIPAY method and canonical provider statuses", () => {
    expect(assertPaymentMethod("KAIPAY")).toBe("KAIPAY");
    expect(() => assertPaymentMethod("ALIPAY")).toThrow(/only KAIPAY/);
    expect(() => assertPaymentMethod("kaipay")).toThrow(/only KAIPAY/);
    expect(providerStatusToPaymentState("PAID")).toBe("paid");
    expect(providerStatusToPaymentState("TRADE_SUCCESS")).toBe("payment_review");
    expect(requireCanonicalStatus("pending")).toBe("PENDING");
    expect(() => requireCanonicalStatus("TRADE_SUCCESS")).toThrow(/unknown canonical/);
  });

  it("loads production config only with pinned adapter, valid opaque credentials, and HTTPS callbacks", () => {
    const config = loadKaipayConfig({
      PETPACK_PLATFORM_MODE: "production",
      KAIPAY_CREDENTIALS_JSON: TEST_CREDENTIALS_JSON,
      KAIPAY_API_BASE_URL: "https://api.kaipay.cn",
      KAIPAY_NOTIFY_BASE_URL: "https://api.heyirmy.com/api/payments/kaipay/notify",
      KAIPAY_RETURN_BASE_URL: "https://heyirmy.com/projects/payment-return",
      KAIPAY_ADAPTER_VERSION: KAIPAY_V3_ADAPTER_VERSION,
      KAIPAY_DEFAULT_CHANNEL: "ALIPAY",
      KAIPAY_ALIPAY_PROVIDER: "fuyou",
      KAIPAY_ALIPAY_PAY_METHOD: "alipay",
      KAIPAY_ALIPAY_SCENE: "native",
      KAIPAY_WECHAT_PROVIDER: "fuyou",
      KAIPAY_WECHAT_PAY_METHOD: "wechat",
      KAIPAY_WECHAT_SCENE: "native",
      KAIPAY_REQUEST_TIMEOUT_MS: "15000"
    });
    expect(config.mode).toBe("production");
    expect(config).toEqual(expect.objectContaining({
      alipayProvider: "fuyou", alipayPayMethod: "alipay", alipayScene: "native",
      wechatProvider: "fuyou", wechatPayMethod: "wechat", wechatScene: "native"
    }));
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => loadKaipayConfig({
      PETPACK_PLATFORM_MODE: "production",
      KAIPAY_CREDENTIALS_JSON: "not-json",
      KAIPAY_API_BASE_URL: "https://example.com",
      KAIPAY_NOTIFY_BASE_URL: "http://api.heyirmy.com/notify",
      KAIPAY_RETURN_BASE_URL: "https://heyirmy.com/return",
      KAIPAY_ADAPTER_VERSION: "v1",
      KAIPAY_ALLOW_SIMULATED_PAYMENTS: "true"
    })).toThrow(/not deployment-ready/);
    expect(() => loadKaipayConfig({
      PETPACK_PLATFORM_MODE: "production",
      KAIPAY_CREDENTIALS_JSON: TEST_CREDENTIALS_JSON,
      KAIPAY_API_BASE_URL: "https://api.kaipay.cn",
      KAIPAY_NOTIFY_BASE_URL: "https://api.heyirmy.com/api/payments/kaipay/notify",
      KAIPAY_RETURN_BASE_URL: "https://heyirmy.com/projects/payment-return",
      KAIPAY_ADAPTER_VERSION: KAIPAY_V3_ADAPTER_VERSION,
      KAIPAY_DEFAULT_CHANNEL: "ALIPAY",
      KAIPAY_ALIPAY_PROVIDER: "fuyou",
      KAIPAY_ALIPAY_PAY_METHOD: "alipay",
      KAIPAY_ALIPAY_SCENE: "native",
      KAIPAY_WECHAT_PROVIDER: "fuyou",
      KAIPAY_WECHAT_SCENE: "native",
      KAIPAY_REQUEST_TIMEOUT_MS: "15000"
    })).toThrow(/KAIPAY_WECHAT_PAY_METHOD is required/);
    expect(loadKaipayConfig({ PETPACK_PLATFORM_MODE: "development" })).toEqual(expect.objectContaining({
      alipayProvider: "alipay", alipayPayMethod: "alipay", alipayScene: "web",
      wechatProvider: "wechat", wechatPayMethod: "wechat", wechatScene: "native"
    }));
    expect(() => new KaipayPaymentProvider({
      config: { mode: "production", adapterVersion: "v1" }
    })).toThrow(/credentials|configuration/i);
  });

  it("creates checkout only through an injected versioned adapter and never exposes credentials", async () => {
    const state = stores();
    const client = {
      createCheckout: vi.fn(async () => ({
        providerOrderId: "kp-123",
        credentialVersion: TEST_CREDENTIAL_VERSION,
        providerCode: "alipay",
        payMethod: "alipay",
        scene: "web",
        nextAction: { type: "redirect", url: "https://pay.example/checkout/123" }
      })),
      queryOrder: vi.fn(),
      refund: vi.fn()
    };
    const provider = new KaipayPaymentProvider({
      config: productionConfig(),
      kaipayClient: client,
      notificationProtocol: { verify: vi.fn(), acknowledge: vi.fn() },
      ...state
    });
    const result = await provider.createCheckout({ platformOrderId: "order-1", idempotencyKey: "idem-1", paymentChannel: "ALIPAY" });
    expect(result).toEqual(expect.objectContaining({
      provider: "KAIPAY",
      providerOrderId: "kp-123",
      paymentMethod: "KAIPAY",
      paymentChannel: "ALIPAY",
      nextAction: { type: "redirect", url: "https://pay.example/checkout/123" },
      state: "pending_payment"
    }));
    expect(client.createCheckout).toHaveBeenCalledWith(expect.objectContaining({
      platformOrderId: "order-1",
      amountFen: 1990,
      currency: "CNY",
      paymentMethod: "KAIPAY",
      paymentChannel: "ALIPAY",
      notifyUrl: "https://api.heyirmy.com/api/payments/kaipay/notify/order-1"
    }));
    expect(JSON.stringify(client.createCheckout.mock.calls)).not.toContain(TEST_API_SECRET);
    expect(state.eventStore.appendIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      adapterVersion: KAIPAY_V3_ADAPTER_VERSION,
      credentialVersion: TEST_CREDENTIAL_VERSION,
      paymentChannel: "ALIPAY",
      providerCode: "alipay",
      payMethod: "alipay",
      scene: "web"
    }));
  });

  it("freezes the configured Fuyou route and returns only a native QR action", async () => {
    const state = stores(order({
      providerOrderId: null,
      paymentCredentialVersion: null,
      paymentChannel: null,
      paymentProviderCode: null,
      paymentPayMethod: null,
      paymentScene: null
    }));
    const client = {
      createCheckout: vi.fn(async () => ({
        providerOrderId: "kp-fuyou-1",
        credentialVersion: TEST_CREDENTIAL_VERSION,
        providerCode: "fuyou",
        payMethod: "alipay",
        scene: "native",
        nextAction: { type: "qr_code", qrCode: "https://qr.example/kp-fuyou-1" }
      })),
      queryOrder: vi.fn(),
      refund: vi.fn()
    };
    const provider = new KaipayPaymentProvider({
      config: productionConfig({
        alipayProvider: "fuyou", alipayPayMethod: "alipay", alipayScene: "native",
        wechatProvider: "fuyou", wechatPayMethod: "wechat", wechatScene: "native"
      }),
      kaipayClient: client,
      notificationProtocol: { verify: vi.fn(), acknowledge: vi.fn() },
      ...state
    });
    const result = await provider.createCheckout({
      platformOrderId: "order-1", idempotencyKey: "idem-fuyou-1", paymentChannel: "ALIPAY"
    });
    expect(client.createCheckout).toHaveBeenCalledWith(expect.objectContaining({
      paymentChannel: "ALIPAY", providerCode: "fuyou", payMethod: "alipay", scene: "native"
    }));
    expect(state.eventStore.appendIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      paymentChannel: "ALIPAY", providerCode: "fuyou", payMethod: "alipay", scene: "native"
    }));
    expect(result).toEqual(expect.objectContaining({
      providerCode: "fuyou", payMethod: "alipay", scene: "native",
      nextAction: expect.objectContaining({ type: "qr_code" })
    }));
  });

  it("marks payment paid only after verified notification and authoritative query agree", async () => {
    const state = stores(order({ paymentPayMethod: null }));
    const protocol = {
      verify: vi.fn(async () => ({
        valid: true,
        platformOrderId: "order-1",
        providerOrderId: "kp-order-1",
        providerCode: "alipay",
        payMethod: "alipay",
        scene: "web",
        eventId: "evt-paid-1",
        credentialVersion: TEST_CREDENTIAL_VERSION,
        status: "PAID"
      })),
      acknowledge: vi.fn(async () => ({ status: 204, contentType: "", body: "" }))
    };
    const client = {
      createCheckout: vi.fn(),
      queryOrder: vi.fn(async () => ({
        platformOrderId: "order-1",
        providerOrderId: "kp-order-1",
        amountFen: 1990,
        currency: "CNY",
        paymentMethod: "KAIPAY",
        paymentChannel: "ALIPAY",
        providerCode: "alipay",
        payMethod: "alipay",
        scene: "web",
        status: "PAID"
      })),
      refund: vi.fn()
    };
    const provider = new KaipayPaymentProvider({ config: productionConfig(), kaipayClient: client, notificationProtocol: protocol, ...state });
    const result = await provider.handleNotification({
      platformOrderId: "order-1",
      rawNotification: Buffer.from('{"eventId":"evt-paid-1"}'),
      notificationHeaders: { "x-kpay-api-version": "v3" }
    });
    expect(result.state).toBe("paid");
    expect(result.applyToOrder).toBe(true);
    expect(result.acknowledgement).toEqual({ status: 204, contentType: "", body: "" });
    expect(state.eventStore.storeEncryptedNotification).toHaveBeenCalledOnce();
    expect(client.queryOrder).toHaveBeenCalledOnce();
    await expect(provider.handleNotification({ platformOrderId: "order-1", rawNotification: { parsed: true } }))
      .rejects.toThrow(/original bytes/);
  });

  it("uses the frozen V3 credential for an authoritative status query when a webhook is missed", async () => {
    const state = stores(order({ paymentPayMethod: null }));
    const client = {
      createCheckout: vi.fn(),
      queryOrder: vi.fn(async () => ({
        platformOrderId: "order-1",
        providerOrderId: "kp-order-1",
        amountFen: 1990,
        currency: "CNY",
        paymentMethod: "KAIPAY",
        paymentChannel: "ALIPAY",
        providerCode: "alipay",
        payMethod: "alipay",
        scene: "web",
        status: "PAID",
        nextAction: { type: "none" }
      })),
      refund: vi.fn()
    };
    const provider = new KaipayPaymentProvider({
      config: productionConfig(),
      kaipayClient: client,
      notificationProtocol: { verify: vi.fn(), acknowledge: vi.fn() },
      ...state
    });
    const result = await provider.queryStatus({ platformOrderId: "order-1" });
    expect(result).toEqual(expect.objectContaining({
      state: "paid",
      reason: "authoritative_provider_query",
      applyToOrder: true,
      providerOrderId: "kp-order-1",
      nextAction: { type: "none" }
    }));
    expect(client.queryOrder).toHaveBeenCalledWith(expect.objectContaining({
      credentialVersion: TEST_CREDENTIAL_VERSION,
      paymentChannel: "ALIPAY",
      providerCode: "alipay",
      payMethod: "alipay",
      scene: "web"
    }));
    expect(state.eventStore.appendIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      type: "payment_status_queried",
      state: "paid",
      credentialVersion: TEST_CREDENTIAL_VERSION
    }));
  });

  it("canonicalizes a provider-refunded order so the refund poll can converge", async () => {
    // 2026-09-03: the first real refund completed at Kaipay, and the
    // reconciliation poll then died recording the queried status - REFUNDED
    // was missing from the repository's status whitelist. The provider layer
    // must deliver state "refunded" with a payment event key end to end.
    const state = stores(order({ paymentPayMethod: null }));
    const client = {
      createCheckout: vi.fn(),
      queryOrder: vi.fn(async () => ({
        platformOrderId: "order-1",
        providerOrderId: "kp-order-1",
        amountFen: 1990,
        currency: "CNY",
        paymentMethod: "KAIPAY",
        paymentChannel: "ALIPAY",
        providerCode: "alipay",
        payMethod: "alipay",
        scene: "web",
        status: "REFUNDED",
        nextAction: { type: "none" }
      })),
      refund: vi.fn()
    };
    const provider = new KaipayPaymentProvider({
      config: productionConfig(),
      kaipayClient: client,
      notificationProtocol: { verify: vi.fn(), acknowledge: vi.fn() },
      ...state
    });
    const result = await provider.queryStatus({ platformOrderId: "order-1" });
    expect(result.state).toBe("refunded");
    expect(typeof result.paymentEventKey).toBe("string");
    expect(result.paymentEventKey.length).toBe(64);
    expect(state.eventStore.appendIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      type: "payment_status_queried",
      state: "refunded",
      providerStatus: "REFUNDED"
    }));
  });

  it("never infers a missing payMethod for Fuyou or combines a partial frozen route with config", async () => {
    const queryOrder = vi.fn();
    const provider = new KaipayPaymentProvider({
      config: productionConfig({
        alipayProvider: "fuyou", alipayPayMethod: "alipay", alipayScene: "native"
      }),
      kaipayClient: { createCheckout: vi.fn(), queryOrder, refund: vi.fn() },
      notificationProtocol: { verify: vi.fn(), acknowledge: vi.fn() },
      ...stores(order({
        paymentProviderCode: "fuyou",
        paymentPayMethod: null,
        paymentScene: "native"
      }))
    });
    await expect(provider.queryStatus({ platformOrderId: "order-1" })).rejects.toThrow(/pay method is required/);
    await expect(provider.createCheckout({
      platformOrderId: "order-1", idempotencyKey: "idem-partial", paymentChannel: "ALIPAY"
    })).rejects.toThrow(/pay method is required/);
    expect(queryOrder).not.toHaveBeenCalled();
    expect(provider.client.createCheckout).not.toHaveBeenCalled();
  });

  it("connects the payment-status fallback to the single paid-workflow transaction", async () => {
    const project = { id: "project-1", userId: "user-1" };
    const pendingOrder = { ...order(), projectId: project.id, status: "pending" };
    const paidOrder = {
      ...pendingOrder,
      status: "paid",
      productionRunId: "run-1",
      productionRunNeeded: true
    };
    const repository = Object.fromEntries([
      "createProjectOrder", "listUserProjects", "reserveSourcePhoto", "getReservedSourcePhoto",
      "acceptSourcePhoto", "getRunByProject", "getSourcePhotoRevision", "getCharacterCandidate",
      "getCharacterCandidates", "getDeliveryForProject", "authorizeDeliveryDownload",
      "createPhotoPrecheck", "findPhotoPrecheckByFingerprint", "getPhotoPrecheck", "countRecentPhotoPrechecks"
    ].map((name) => [name, vi.fn()]));
    repository.getProjectBundle = vi.fn(async () => ({ project, order: pendingOrder }));
    repository.markOrderPaymentState = vi.fn(async () => paidOrder);
    const paymentProvider = {
      createCheckout: vi.fn(),
      handleNotification: vi.fn(),
      queryStatus: vi.fn(async () => ({
        state: "paid",
        applyToOrder: true,
        providerOrderId: pendingOrder.providerOrderId,
        nextAction: { type: "none" }
      }))
    };
    const workflow = {
      startPaidOrder: vi.fn(),
      photosAccepted: vi.fn(),
      confirmCharacterMasters: vi.fn(),
      regenerateCharacterMaster: vi.fn()
    };
    const objectStore = {
      createUploadGrant: vi.fn(),
      createDownloadGrant: vi.fn(),
      verifyUploadedObject: vi.fn()
    };
    const service = new PetPackStudioService({ repository, paymentProvider, objectStore, workflow });
    const result = await service.refreshPaymentStatus({ actor: { id: "user-1", role: "user" }, projectId: project.id });
    expect(result).toEqual({ order: { id: pendingOrder.id, status: "paid" }, nextAction: { type: "none" } });
    expect(paymentProvider.queryStatus).toHaveBeenCalledWith({ platformOrderId: pendingOrder.id });
    expect(repository.markOrderPaymentState).toHaveBeenCalledWith({
      platformOrderId: pendingOrder.id,
      reconciliation: expect.objectContaining({ state: "paid", applyToOrder: true })
    });
    expect(workflow.startPaidOrder).toHaveBeenCalledOnce();
    expect(workflow.startPaidOrder).toHaveBeenCalledWith({ order: paidOrder, projectId: project.id, runId: "run-1" });
  });

  it("fails closed when signature, identity, query, amount, or canonical status cannot be proven", async () => {
    const state = stores();
    const provider = new KaipayPaymentProvider({
      config: productionConfig(),
      kaipayClient: {
        createCheckout: vi.fn(),
        queryOrder: vi.fn(async () => ({
          platformOrderId: "order-1", providerOrderId: "kp-order-1", amountFen: 1,
          currency: "CNY", paymentMethod: "KAIPAY", status: "TRADE_SUCCESS"
        })),
        refund: vi.fn()
      },
      notificationProtocol: {
        verify: vi.fn(async () => ({
          valid: true,
          platformOrderId: "order-1",
          providerOrderId: "kp-order-1",
          eventId: "evt-wrong-credential",
          credentialVersion: "kpv3-wrong-credential",
          status: "PAID"
        })),
        acknowledge: vi.fn(async () => ({ status: 200, contentType: "text/plain", body: "review" }))
      },
      ...state
    });
    const result = await provider.handleNotification({ platformOrderId: "order-1", rawNotification: "invalid" });
    expect(result.state).toBe("payment_review");
    expect(result.applyToOrder).toBe(false);
    expect(provider.client.queryOrder).not.toHaveBeenCalled();
  });

  it("does not let an unauthenticated callback move a customer order into review", async () => {
    const repository = Object.fromEntries([
      "createProjectOrder", "listUserProjects", "getProjectBundle", "reserveSourcePhoto",
      "getReservedSourcePhoto", "acceptSourcePhoto", "getRunByProject", "getSourcePhotoRevision",
      "getCharacterCandidate", "getCharacterCandidates", "getDeliveryForProject", "authorizeDeliveryDownload",
      "markOrderPaymentState",
    "createPhotoPrecheck", "findPhotoPrecheckByFingerprint", "getPhotoPrecheck", "countRecentPhotoPrechecks"
    ].map((name) => [name, vi.fn()]));
    const paymentProvider = {
      createCheckout: vi.fn(),
      queryStatus: vi.fn(),
      handleNotification: vi.fn(async () => ({
        state: "payment_review",
        applyToOrder: false,
        acknowledgement: { status: 400, contentType: "text/plain", body: "fail" }
      }))
    };
    const objectStore = {
      createUploadGrant: vi.fn(), createDownloadGrant: vi.fn(), verifyUploadedObject: vi.fn()
    };
    const workflow = {
      startPaidOrder: vi.fn(), photosAccepted: vi.fn(), confirmCharacterMasters: vi.fn(), regenerateCharacterMaster: vi.fn()
    };
    const service = new PetPackStudioService({ repository, paymentProvider, objectStore, workflow });
    const result = await service.handlePaymentNotification({
      platformOrderId: "order-1",
      rawNotification: "bad=callback",
      notificationHeaders: { "x-kpay-api-version": "v3" }
    });
    expect(result).toEqual({
      accepted: false,
      acknowledgement: { status: 400, contentType: "text/plain", body: "fail" }
    });
    expect(repository.markOrderPaymentState).not.toHaveBeenCalled();
    expect(workflow.startPaidOrder).not.toHaveBeenCalled();
  });

  it("keeps simulation development-only and production factory fail-closed", () => {
    const state = stores();
    const simulated = createPaymentProvider({
      config: { mode: "development", allowSimulatedPayments: true },
      ...state
    });
    expect(simulated.constructor.name).toBe("SimulatedPaymentProvider");
    expect(typeof simulated.handleNotification).toBe("function");
    expect(() => new SimulatedPaymentProvider({ mode: "production", ...state })).toThrow(/development/);
    const production = createPaymentProvider({
      config: productionConfig(),
      ...state
    });
    expect(production.constructor.name).toBe("KaipayPaymentProvider");
  });

  it("requires the server-only gateway token for customer routes but never for the Kaipay webhook", async () => {
    const service = {
      createCheckout: vi.fn(),
      refreshPaymentStatus: vi.fn(),
      listProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
      createSourcePhotoUploadGrants: vi.fn(), confirmSourcePhotoUpload: vi.fn(),
      regenerateCharacterMaster: vi.fn(), confirmCharacter: vi.fn(), getProjectView: vi.fn(),
      createPetpackDownload: vi.fn(),
      handlePaymentNotification: vi.fn(async () => ({
        accepted: true,
        acknowledgement: { status: 204, contentType: "", body: "" }
      }))
    };
    const token = "server-only-internal-token-at-least-32-bytes";
    const api = createPetPackStudioHttpApi({
      service,
      internalBearerToken: token,
      resolveActor: vi.fn(async () => ({ userId: "user-1", roles: ["user"] }))
    });
    const blocked = await api.handle({ method: "GET", path: "/api/projects" });
    expect(blocked).toMatchObject({ status: 401, body: { error: { code: "invalid_gateway" } } });
    const allowed = await api.handle({
      method: "GET",
      path: "/api/projects",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(allowed.status).toBe(200);
    service.refreshPaymentStatus.mockResolvedValueOnce({ order: { id: "order-1", status: "paid" }, nextAction: { type: "none" } });
    const refreshed = await api.handle({
      method: "POST",
      path: "/api/projects/project-1/payment-status",
      body: {},
      headers: { authorization: `Bearer ${token}` }
    });
    expect(refreshed).toMatchObject({ status: 200, body: { order: { id: "order-1", status: "paid" }, nextAction: { type: "none" } } });

    const callback = await api.handle({
      method: "POST",
      path: "/api/payments/kaipay/notify/order-1",
      rawBody: Buffer.from("signed-body"),
      headers: {
        "x-kpay-api-version": "v3",
        "x-kpay-event": "payment.order.paid",
        "x-kpay-timestamp": "1786690000",
        "x-kpay-nonce": "nonce-12345678",
        "x-kpay-signature-method": "HMAC-SHA256",
        "x-kpay-body-sha256": "a".repeat(64),
        "x-kpay-signature": "b".repeat(64)
      }
    });
    expect(callback.status).toBe(204);
  });

  it("uses the acknowledgement supplied by the adapter and leaves the old Alipay route closed", async () => {
    const requiredMethods = {
      createCheckout: vi.fn(), listProjects: vi.fn(), refreshPaymentStatus: vi.fn(), createSourcePhotoUploadGrants: vi.fn(),
      confirmSourcePhotoUpload: vi.fn(), regenerateCharacterMaster: vi.fn(), confirmCharacter: vi.fn(),
      getProjectView: vi.fn(), createPetpackDownload: vi.fn(),
      handlePaymentNotification: vi.fn(async () => ({
        accepted: true,
        acknowledgement: { status: 204, contentType: "", body: "" }
      }))
    };
    const api = createPetPackStudioHttpApi({ service: requiredMethods, resolveActor: vi.fn(async () => null) });
    const result = await api.handle({
      method: "POST",
      path: "/api/payments/kaipay/notify/order-1",
      rawBody: Buffer.from("signed-body"),
      headers: {
        "x-kpay-api-version": "v3",
        "x-kpay-event": "payment.order.paid",
        "x-kpay-timestamp": "1786690000",
        "x-kpay-nonce": "nonce-12345678",
        "x-kpay-signature-method": "HMAC-SHA256",
        "x-kpay-body-sha256": "a".repeat(64),
        "x-kpay-signature": "b".repeat(64)
      }
    });
    expect(result).toEqual(expect.objectContaining({ status: 204, body: "" }));
    expect(result.headers?.["content-type"]).toBeUndefined();
    expect(requiredMethods.handlePaymentNotification).toHaveBeenLastCalledWith(expect.objectContaining({
      platformOrderId: "order-1",
      rawNotification: Buffer.from("signed-body"),
      notificationHeaders: expect.objectContaining({
        "X-KPay-API-Version": "v3",
        "X-KPay-Event": "payment.order.paid"
      })
    }));
    const officialGet = await api.handle({
      method: "GET",
      path: "/api/payments/kaipay/notify/order-1?pid=1001&trade_no=kp-1&sign=abc"
    });
    expect(officialGet.status).toBe(404);
    const legacy = await api.handle({ method: "POST", path: "/api/payments/alipay/notify/order-1", rawBody: Buffer.from("x") });
    expect(legacy.status).toBe(404);
  });

  it("rejects malformed provider acknowledgements and maps the Kaipay secret file only", () => {
    expect(normalizeAcknowledgement({ status: 200, contentType: "text/plain", body: "ok" })).toEqual({ status: 200, contentType: "text/plain", body: "ok" });
    expect(normalizeAcknowledgement({ status: 204, contentType: "", body: "" })).toEqual({ status: 204, contentType: "", body: "" });
    expect(normalizeAcknowledgement({ status: 503, contentType: "text/plain", body: "retry" }).status).toBe(503);
    expect(() => normalizeAcknowledgement({ status: 302, contentType: "text/plain", body: "redirect" })).toThrow(/invalid/);
    expect(DEFAULT_SECRET_FILE_MAPPINGS.KAIPAY_CREDENTIALS_JSON).toBe("KAIPAY_CREDENTIALS_JSON_FILE");
    expect(DEFAULT_SECRET_FILE_MAPPINGS.PETPACK_PAYMENT_NOTIFICATION_ENCRYPTION_KEY).toBe("PETPACK_PAYMENT_NOTIFICATION_ENCRYPTION_KEY_FILE");
    expect(DEFAULT_SECRET_FILE_MAPPINGS.ALIPAY_PRIVATE_KEY).toBeUndefined();
  });

  it("encrypts raw callback bytes with an independent 256-bit authenticated key", () => {
    const key = Buffer.alloc(32, 7);
    const iv = Buffer.alloc(12, 9);
    const raw = Buffer.from("sensitive-provider-callback");
    const encrypted = encryptPaymentNotification(raw, key, iv);
    expect(encrypted[0]).toBe(1);
    expect(encrypted.subarray(1, 13)).toEqual(iv);
    expect(encrypted.includes(raw)).toBe(false);
    expect(normalizePaymentNotificationEncryptionKey(key)).toEqual(key);
    expect(() => normalizePaymentNotificationEncryptionKey(Buffer.alloc(31))).toThrow(/32 bytes/);
  });

  it("requires exact raw callback bytes at the HTTP boundary", async () => {
    const service = {
      createCheckout: vi.fn(), listProjects: vi.fn(), refreshPaymentStatus: vi.fn(), createSourcePhotoUploadGrants: vi.fn(),
      confirmSourcePhotoUpload: vi.fn(), regenerateCharacterMaster: vi.fn(), confirmCharacter: vi.fn(),
      getProjectView: vi.fn(), createPetpackDownload: vi.fn(), handlePaymentNotification: vi.fn()
    };
    const api = createPetPackStudioHttpApi({ service, resolveActor: vi.fn(async () => null) });
    const result = await api.handle({
      method: "POST",
      path: "/api/payments/kaipay/notify/order-1",
      body: { parsed: true }
    });
    expect(result.status).toBe(400);
    expect(service.handlePaymentNotification).not.toHaveBeenCalled();
  });
});
