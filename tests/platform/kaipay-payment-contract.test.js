import { describe, expect, it, vi } from "vitest";

import paymentStateMachine from "../../platform/src/domain/payment-state-machine.js";
import kaipayModule from "../../platform/src/providers/kaipay-payment-provider.js";
import simulatedModule from "../../platform/src/providers/simulated-payment-provider.js";
import factoryModule from "../../platform/src/providers/payment-provider-factory.js";
import httpModule from "../../platform/src/http/petpack-studio-http-api.js";
import secretModule from "../../platform/src/runtime/load-secret-files.js";
import repositoryModule from "../../platform/src/persistence/postgres-petpack-studio-repository.js";

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

function order(overrides = {}) {
  return {
    id: "order-1",
    amountFen: 1990,
    currency: "CNY",
    paymentMethod: "KAIPAY",
    displayName: "淘淘",
    providerOrderId: "kp-order-1",
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
    merchantId: "merchant-1",
    credentialsJson: '{"token":"not-a-real-secret"}',
    notifyBaseUrl: "https://api.heyirmy.com/api/payments/kaipay/notify",
    returnBaseUrl: "https://heyirmy.com/projects/payment-return",
    adapterVersion: "kaipay-api-debugger/v1",
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
      KAIPAY_MERCHANT_ID: "merchant-1",
      KAIPAY_CREDENTIALS_JSON: '{"credential":"value"}',
      KAIPAY_NOTIFY_BASE_URL: "https://api.heyirmy.com/api/payments/kaipay/notify",
      KAIPAY_RETURN_BASE_URL: "https://heyirmy.com/projects/payment-return",
      KAIPAY_ADAPTER_VERSION: "kaipay-api-debugger/v1"
    });
    expect(config.mode).toBe("production");
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => loadKaipayConfig({
      PETPACK_PLATFORM_MODE: "production",
      KAIPAY_MERCHANT_ID: "merchant-1",
      KAIPAY_CREDENTIALS_JSON: "not-json",
      KAIPAY_NOTIFY_BASE_URL: "http://api.heyirmy.com/notify",
      KAIPAY_RETURN_BASE_URL: "https://heyirmy.com/return",
      KAIPAY_ADAPTER_VERSION: "v1",
      KAIPAY_ALLOW_SIMULATED_PAYMENTS: "true"
    })).toThrow(/not deployment-ready/);
    expect(() => new KaipayPaymentProvider({
      config: { mode: "production", adapterVersion: "v1" }
    })).toThrow(/merchant ID/);
  });

  it("creates checkout only through an injected versioned adapter and never exposes credentials", async () => {
    const state = stores();
    const client = {
      createCheckout: vi.fn(async (request) => ({ providerOrderId: "kp-123", checkoutUrl: "https://pay.example/checkout/123" })),
      queryOrder: vi.fn(),
      refund: vi.fn()
    };
    const provider = new KaipayPaymentProvider({
      config: productionConfig(),
      kaipayClient: client,
      notificationProtocol: { verify: vi.fn(), acknowledge: vi.fn() },
      ...state
    });
    const result = await provider.createCheckout({ platformOrderId: "order-1", idempotencyKey: "idem-1" });
    expect(result).toEqual(expect.objectContaining({ provider: "KAIPAY", providerOrderId: "kp-123", paymentMethod: "KAIPAY", state: "pending_payment" }));
    expect(client.createCheckout).toHaveBeenCalledWith(expect.objectContaining({
      platformOrderId: "order-1",
      amountFen: 1990,
      currency: "CNY",
      paymentMethod: "KAIPAY",
      notifyUrl: "https://api.heyirmy.com/api/payments/kaipay/notify/order-1"
    }));
    expect(JSON.stringify(client.createCheckout.mock.calls)).not.toContain("not-a-real-secret");
  });

  it("marks payment paid only after verified notification and authoritative query agree", async () => {
    const state = stores();
    const protocol = {
      verify: vi.fn(async () => ({
        valid: true,
        merchantId: "merchant-1",
        platformOrderId: "order-1",
        providerOrderId: "kp-order-1",
        status: "PAID"
      })),
      acknowledge: vi.fn(async () => ({ status: 200, contentType: "text/plain; charset=utf-8", body: "provider-defined-ok" }))
    };
    const client = {
      createCheckout: vi.fn(),
      queryOrder: vi.fn(async () => ({
        platformOrderId: "order-1",
        providerOrderId: "kp-order-1",
        amountFen: 1990,
        currency: "CNY",
        paymentMethod: "KAIPAY",
        status: "PAID"
      })),
      refund: vi.fn()
    };
    const provider = new KaipayPaymentProvider({ config: productionConfig(), kaipayClient: client, notificationProtocol: protocol, ...state });
    const result = await provider.handleNotification({ platformOrderId: "order-1", rawNotification: Buffer.from("signed-provider-body") });
    expect(result.state).toBe("paid");
    expect(result.acknowledgement.body).toBe("provider-defined-ok");
    expect(state.eventStore.storeEncryptedNotification).toHaveBeenCalledOnce();
    expect(client.queryOrder).toHaveBeenCalledOnce();
    await expect(provider.handleNotification({ platformOrderId: "order-1", rawNotification: { parsed: true } }))
      .rejects.toThrow(/original bytes/);
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
        verify: vi.fn(async () => ({ valid: true, merchantId: "wrong-merchant", platformOrderId: "order-1", providerOrderId: "kp-order-1", status: "PAID" })),
        acknowledge: vi.fn(async () => ({ status: 200, contentType: "text/plain", body: "review" }))
      },
      ...state
    });
    const result = await provider.handleNotification({ platformOrderId: "order-1", rawNotification: "invalid" });
    expect(result.state).toBe("payment_review");
    expect(provider.client.queryOrder).not.toHaveBeenCalled();
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
    expect(() => createPaymentProvider({
      config: productionConfig(),
      ...state
    })).toThrow(/Kaipay client adapter/);
  });

  it("uses the acknowledgement supplied by the adapter and leaves the old Alipay route closed", async () => {
    const requiredMethods = {
      createCheckout: vi.fn(), listProjects: vi.fn(), createSourcePhotoUploadGrants: vi.fn(),
      confirmSourcePhotoUpload: vi.fn(), regenerateCharacterMaster: vi.fn(), confirmCharacter: vi.fn(),
      getProjectView: vi.fn(), createPetpackDownload: vi.fn(),
      handlePaymentNotification: vi.fn(async () => ({
        accepted: true,
        acknowledgement: { status: 202, contentType: "text/plain; charset=utf-8", body: "kaipay-protocol-ack" }
      }))
    };
    const api = createPetPackStudioHttpApi({ service: requiredMethods, resolveActor: vi.fn(async () => null) });
    const result = await api.handle({
      method: "POST",
      path: "/api/payments/kaipay/notify/order-1",
      rawBody: Buffer.from("signed-body")
    });
    expect(result).toEqual(expect.objectContaining({
      status: 202,
      headers: expect.objectContaining({ "content-type": "text/plain; charset=utf-8" }),
      body: "kaipay-protocol-ack"
    }));
    const legacy = await api.handle({ method: "POST", path: "/api/payments/alipay/notify/order-1", rawBody: Buffer.from("x") });
    expect(legacy.status).toBe(404);
  });

  it("rejects malformed provider acknowledgements and maps the Kaipay secret file only", () => {
    expect(normalizeAcknowledgement({ status: 200, contentType: "text/plain", body: "ok" })).toEqual({ status: 200, contentType: "text/plain", body: "ok" });
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
      createCheckout: vi.fn(), listProjects: vi.fn(), createSourcePhotoUploadGrants: vi.fn(),
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
