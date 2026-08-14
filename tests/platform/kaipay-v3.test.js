import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import v3Module from "../../platform/src/providers/kaipay-v3.js";
import factoryModule from "../../platform/src/providers/payment-provider-factory.js";
import probeModule from "../../platform/src/runtime/verify-kaipay-runtime.js";

const {
  KAIPAY_V3_ADAPTER_VERSION,
  KaipayV3Client,
  KaipayV3NotificationProtocol,
  createRequestSignature,
  credentialVersionFor,
  parseV3Credentials,
  sha256Hex
} = v3Module;
const { createPaymentProvider } = factoryModule;
const { assertSceneCapability, runKaipayCapabilitiesProbe } = probeModule;

const API_KEY = "pk_live_test_123456";
const API_SECRET = "test-api-secret-at-least-32-bytes";
const CREDENTIALS_JSON = JSON.stringify({ active: { apiKey: API_KEY, apiSecret: API_SECRET }, previous: [] });
const NOW_MS = 1_786_721_600_000;
const NONCE = "9f4b0b2c1a6d4e7f";

function config(overrides = {}) {
  return {
    mode: "production",
    credentialsJson: CREDENTIALS_JSON,
    apiBaseUrl: "https://api.kaipay.cn",
    notifyBaseUrl: "https://api.heyirmy.com/api/payments/kaipay/notify",
    returnBaseUrl: "https://heyirmy.com/projects/payment-return",
    adapterVersion: KAIPAY_V3_ADAPTER_VERSION,
    defaultChannel: "ALIPAY",
    alipayScene: "web",
    wechatScene: "native",
    selectedMerchantCode: "",
    requestTimeoutMs: "15000",
    allowSimulatedPayments: false,
    ...overrides
  };
}

function jsonResponse(data, { status = 200, code = 0 } = {}) {
  const text = JSON.stringify({ code, data, msg: code === 0 ? "成功" : "失败" });
  return {
    ok: status >= 200 && status <= 299,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? String(Buffer.byteLength(text)) : null },
    text: vi.fn(async () => text)
  };
}

function client(fetchImpl) {
  return new KaipayV3Client({
    config: config(),
    fetchImpl,
    now: () => NOW_MS,
    nonceFactory: () => NONCE
  });
}

describe("Kaipay Pay API V3", () => {
  it("builds the documented canonical HMAC request", () => {
    const bodyBytes = Buffer.from('{"merchantOrderNo":"order-1"}', "utf8");
    const result = createRequestSignature({
      method: "POST",
      pathWithQuery: "/pay/api/v3/order/create",
      timestamp: String(Math.floor(NOW_MS / 1000)),
      nonce: NONCE,
      bodyBytes,
      apiSecret: API_SECRET
    });
    const expectedBodySha = crypto.createHash("sha256").update(bodyBytes).digest("hex");
    const expectedCanonical = ["POST", "/pay/api/v3/order/create", String(Math.floor(NOW_MS / 1000)), NONCE, expectedBodySha].join("\n");
    expect(result.canonicalText).toBe(expectedCanonical);
    expect(result.signature).toBe(crypto.createHmac("sha256", API_SECRET).update(expectedCanonical).digest("hex"));
  });

  it("pins an immutable credential version and retains explicitly listed old secrets", () => {
    const old = { apiKey: "pk_live_old_123456", apiSecret: "old-api-secret-at-least-32-bytes" };
    const parsed = parseV3Credentials(JSON.stringify({
      active: { apiKey: API_KEY, apiSecret: API_SECRET },
      previous: [old]
    }));
    expect(parsed.active.credentialVersion).toBe(credentialVersionFor({ apiKey: API_KEY, apiSecret: API_SECRET }));
    expect(parsed.previous[0].credentialVersion).toBe(credentialVersionFor(old));
    expect(() => parseV3Credentials(JSON.stringify({ active: { apiKey: API_KEY, apiSecret: API_SECRET }, previous: [{ apiKey: API_KEY, apiSecret: API_SECRET }] })))
      .toThrow(/duplicate credential/);
  });

  it("creates an Alipay web redirect with exact signed V3 headers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      apiVersion: "v3",
      orderNo: "P202608140001",
      merchantOrderNo: "order-1",
      amount: 19.9,
      currency: "CNY",
      status: "requires_action",
      provider: "alipay",
      scene: "web",
      nextAction: { type: "redirect", url: "https://openapi.alipay.com/gateway.do?token=safe" }
    }));
    const result = await client(fetchImpl).createCheckout({
      platformOrderId: "order-1",
      amountFen: 1990,
      paymentChannel: "ALIPAY",
      subject: "淘淘的桌宠素材包",
      description: "7 个动作视频、三张母图及 PetPack 桌宠素材包",
      notifyUrl: "https://api.heyirmy.com/api/payments/kaipay/notify/order-1",
      returnUrl: "https://heyirmy.com/projects/payment-return?order=order-1"
    });
    expect(result).toEqual(expect.objectContaining({
      providerOrderId: "P202608140001",
      paymentChannel: "ALIPAY",
      providerCode: "alipay",
      scene: "web",
      status: "PENDING",
      nextAction: { type: "redirect", url: "https://openapi.alipay.com/gateway.do?token=safe" }
    }));
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.kaipay.cn/pay/api/v3/order/create");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual(expect.objectContaining({
      "X-API-Key": API_KEY,
      "X-KPay-Timestamp": String(Math.floor(NOW_MS / 1000)),
      "X-KPay-Nonce": NONCE,
      "X-KPay-Signature-Method": "HMAC-SHA256"
    }));
    expect(options.headers).not.toHaveProperty("X-API-Secret");
    const body = JSON.parse(options.body);
    expect(body).toEqual(expect.objectContaining({
      merchantOrderNo: "order-1",
      amount: 19.9,
      provider: "alipay",
      scene: "web",
      payer: {}
    }));
    expect(options.headers["X-KPay-Body-SHA256"]).toBe(sha256Hex(Buffer.from(options.body)));
  });

  it("creates a WeChat native QR action without a return URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      apiVersion: "v3", orderNo: "P202608140002", merchantOrderNo: "order-2", amount: 19.9,
      currency: "CNY", status: "requires_action", provider: "wechat", scene: "native",
      nextAction: { type: "qr_code", qrCode: "weixin://wxpay/bizpayurl?pr=safe" }
    }));
    const result = await client(fetchImpl).createCheckout({
      platformOrderId: "order-2", amountFen: 1990, paymentChannel: "WXPAY",
      subject: "团团的桌宠素材包", description: "PetPack",
      notifyUrl: "https://api.heyirmy.com/api/payments/kaipay/notify/order-2",
      returnUrl: "https://heyirmy.com/projects/payment-return?order=order-2"
    });
    expect(result.nextAction).toEqual({ type: "qr_code", qrCode: "weixin://wxpay/bizpayurl?pr=safe" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty("returnUrl");
  });

  it("queries and refunds with the frozen order credential", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        apiVersion: "v3", orderNo: "P202608140001", merchantOrderNo: "order-1", amount: 19.9,
        actualAmount: 19.9, currency: "CNY", status: "succeeded", provider: "alipay", scene: "web",
        nextAction: { type: "none" }
      }))
      .mockResolvedValueOnce(jsonResponse({
        apiVersion: "v3", orderNo: "P202608140001", refundRequestNo: "refund-1", idempotentReplay: false,
        result: { action: "requested", status: "pending", requestNo: "refund-1", requiresApproval: true }
      }));
    const credentialVersion = credentialVersionFor({ apiKey: API_KEY, apiSecret: API_SECRET });
    const v3 = client(fetchImpl);
    await expect(v3.queryOrder({
      platformOrderId: "order-1", providerOrderId: "P202608140001", credentialVersion,
      paymentChannel: "ALIPAY", providerCode: "alipay", scene: "web"
    })).resolves.toEqual(expect.objectContaining({ status: "PAID", amountFen: 1990, credentialVersion }));
    await expect(v3.refund({
      providerOrderId: "P202608140001", refundId: "refund-1", amountFen: 1990,
      reason: "用户申请退款", credentialVersion
    })).resolves.toEqual(expect.objectContaining({ providerStatus: "pending", requiresApproval: true }));
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("orderNo")).toBe("P202608140001");
  });

  it("verifies the raw V3 webhook before parsing and returns an empty 204 acknowledgement", async () => {
    const credentialVersion = credentialVersionFor({ apiKey: API_KEY, apiSecret: API_SECRET });
    const body = Buffer.from(JSON.stringify({
      apiVersion: "v3", eventId: "evt-1", eventType: "payment.order.paid",
      orderNo: "P202608140001", merchantOrderNo: "order-1", amount: 19.9, actualAmount: 19.9,
      currency: "CNY", provider: "alipay", status: "paid", payMethod: "alipay", payTime: "2026-08-14T12:00:00Z"
    }));
    const timestamp = String(Math.floor(NOW_MS / 1000));
    const bodySha = sha256Hex(body);
    const signature = crypto.createHmac("sha256", API_SECRET)
      .update([timestamp, NONCE, "payment.order.paid", bodySha].join("\n"))
      .digest("hex");
    const protocol = new KaipayV3NotificationProtocol({ config: config(), now: () => NOW_MS });
    const verified = await protocol.verify(body, {
      expectedPlatformOrderId: "order-1", expectedProviderOrderId: "P202608140001",
      expectedProviderCode: "alipay", expectedAmountFen: 1990, expectedCredentialVersion: credentialVersion,
      headers: {
        "X-KPay-API-Version": "v3", "X-KPay-Event": "payment.order.paid",
        "X-KPay-Timestamp": timestamp, "X-KPay-Nonce": NONCE,
        "X-KPay-Signature-Method": "HMAC-SHA256", "X-KPay-Body-SHA256": bodySha,
        "X-KPay-Signature": signature
      }
    });
    expect(verified).toEqual(expect.objectContaining({ valid: true, eventId: "evt-1", status: "PAID", credentialVersion }));
    expect(await protocol.acknowledge({ verified: true, state: "paid" })).toEqual({ status: 204, contentType: "", body: "" });
    await expect(protocol.verify(Buffer.from(body.toString().replace("19.9", "20.9")), {
      expectedCredentialVersion: credentialVersion,
      headers: { "X-KPay-API-Version": "v3", "X-KPay-Event": "payment.order.paid", "X-KPay-Timestamp": timestamp,
        "X-KPay-Nonce": NONCE, "X-KPay-Signature-Method": "HMAC-SHA256", "X-KPay-Body-SHA256": bodySha, "X-KPay-Signature": signature }
    })).rejects.toThrow(/signature/);
  });

  it("uses V3 in the production factory and performs a read-only capabilities probe", async () => {
    const capabilities = {
      apiVersion: "v3",
      providers: [
        { provider: "alipay", payMethods: ["alipay"], scenes: [{ scene: "web", actionType: "redirect", requiredFields: ["notifyUrl"] }] },
        { provider: "wechat", payMethods: ["wechat"], scenes: [{ scene: "native", actionType: "qr_code", requiredFields: ["notifyUrl"] }] }
      ]
    };
    const fetchImpl = vi.fn(async () => jsonResponse(capabilities));
    const environment = {
      PETPACK_PLATFORM_MODE: "production", KAIPAY_CREDENTIALS_JSON: CREDENTIALS_JSON,
      KAIPAY_API_BASE_URL: "https://api.kaipay.cn", KAIPAY_NOTIFY_BASE_URL: "https://api.heyirmy.com/api/payments/kaipay/notify",
      KAIPAY_RETURN_BASE_URL: "https://heyirmy.com/projects/payment-return", KAIPAY_ADAPTER_VERSION: KAIPAY_V3_ADAPTER_VERSION,
      KAIPAY_DEFAULT_CHANNEL: "ALIPAY", KAIPAY_ALIPAY_SCENE: "web", KAIPAY_WECHAT_SCENE: "native",
      KAIPAY_REQUEST_TIMEOUT_MS: "15000", KAIPAY_ALLOW_SIMULATED_PAYMENTS: "false"
    };
    await expect(runKaipayCapabilitiesProbe({ environment, fetchImpl })).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.kaipay.cn/pay/api/v3/capabilities");
    expect(() => assertSceneCapability([
      { provider: "wechat", payMethods: ["wechat"], scenes: [{ scene: "native", actionType: "redirect", requiredFields: ["notifyUrl"] }] }
    ], { channel: "WXPAY", scene: "native" })).toThrow(/capabilities/);

    const injected = {
      createCheckout: vi.fn(), queryOrder: vi.fn(), refund: vi.fn()
    };
    const provider = createPaymentProvider({
      config: config(), kaipayClient: injected,
      notificationProtocol: { verify: vi.fn(), acknowledge: vi.fn() },
      orderStore: { getPaymentOrder: vi.fn() },
      eventStore: { appendIdempotent: vi.fn(), storeEncryptedNotification: vi.fn() }
    });
    expect(provider.client).toBe(injected);
  });
});
