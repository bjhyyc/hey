import { describe, expect, it, vi } from "vitest";

import epayModule from "../../platform/src/providers/kaipay-epay-v1.js";
import paymentFactoryModule from "../../platform/src/providers/payment-provider-factory.js";
import kaipayProbeModule from "../../platform/src/runtime/verify-kaipay-runtime.js";

const {
  KAIPAY_EPAY_V1_ADAPTER_VERSION,
  KaipayEpayV1Client,
  KaipayEpayV1NotificationProtocol,
  createKaipayEpayV1Adapters,
  parseEpayCredentials,
  signEpayParams,
  verifyEpaySignature
} = epayModule;
const { createPaymentProvider } = paymentFactoryModule;
const { runKaipayMerchantProbe } = kaipayProbeModule;

function config(overrides = {}) {
  return {
    mode: "production",
    merchantId: "1001",
    credentialsJson: '{"epayKey":"test-secret-key"}',
    apiBaseUrl: "https://api.kaipay.cn",
    adapterVersion: KAIPAY_EPAY_V1_ADAPTER_VERSION,
    defaultChannel: "ALIPAY",
    requestTimeoutMs: "15000",
    ...overrides
  };
}

function jsonResponse(payload, { status = 200 } = {}) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status <= 299,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? String(Buffer.byteLength(text)) : null },
    text: vi.fn(async () => text)
  };
}

describe("Kaipay EPay V1 legacy adapter isolation", () => {
  it("implements the documented ASCII-sort MD5 signature exactly", () => {
    const params = {
      pid: "1001",
      type: "alipay",
      out_trade_no: "ORDER_20240501001",
      notify_url: "https://your.example/notify",
      name: "账户充值",
      money: "10.00",
      sign_type: "MD5",
      empty: ""
    };
    const signature = signEpayParams(params, "test-secret-key");
    expect(signature).toBe("91f8364af6e8e22ac0509f056715f2ff");
    expect(verifyEpaySignature({ ...params, sign: signature }, "test-secret-key")).toBe(true);
    expect(verifyEpaySignature({ ...params, money: "10.01", sign: signature }, "test-secret-key")).toBe(false);
  });

  it("creates a signed mapi checkout for the selected WeChat channel", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1,
      msg: "success",
      trade_no: "202608140001",
      payurl: "https://pay.kaipay.cn/cashier/202608140001",
      money: "19.90",
      real_money: "19.90"
    }));
    const client = new KaipayEpayV1Client({ config: config(), fetchImpl });
    const result = await client.createCheckout({
      platformOrderId: "order-1",
      amountFen: 1990,
      subject: "淘淘的桌宠素材包",
      notifyUrl: "https://api.heyirmy.com/api/payments/kaipay/notify/order-1",
      returnUrl: "https://heyirmy.com/projects/payment-return?order=order-1",
      paymentChannel: "WXPAY"
    });
    expect(result).toEqual({
      providerOrderId: "202608140001",
      checkoutUrl: "https://pay.kaipay.cn/cashier/202608140001",
      paymentChannel: "WXPAY"
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.kaipay.cn/epay/mapi");
    expect(options.method).toBe("POST");
    const body = new URLSearchParams(options.body);
    expect(Object.fromEntries(body)).toEqual(expect.objectContaining({
      pid: "1001",
      type: "wxpay",
      out_trade_no: "order-1",
      money: "19.90",
      device: "pc",
      sign_type: "MD5"
    }));
    expect(verifyEpaySignature(Object.fromEntries(body), "test-secret-key")).toBe(true);
  });

  it("queries the authoritative order and maps only documented trade states", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1,
      msg: "success",
      pid: 1001,
      trade_no: "202608140001",
      out_trade_no: "order-1",
      type: "alipay",
      name: "淘淘的桌宠素材包",
      money: "19.90",
      trade_status: "TRADE_SUCCESS",
      addtime: "2026-08-14 12:00:00",
      endtime: "2026-08-14 12:01:00"
    }));
    const client = new KaipayEpayV1Client({ config: config(), fetchImpl });
    const result = await client.queryOrder({ platformOrderId: "order-1", providerOrderId: "202608140001" });
    expect(result).toEqual({
      platformOrderId: "order-1",
      providerOrderId: "202608140001",
      amountFen: 1990,
      currency: "CNY",
      paymentMethod: "KAIPAY",
      status: "PAID"
    });
    const target = new URL(fetchImpl.mock.calls[0][0]);
    expect(target.origin + target.pathname).toBe("https://api.kaipay.cn/epay/api");
    expect(target.searchParams.get("act")).toBe("order");
    expect(target.searchParams.get("pid")).toBe("1001");
    expect(target.searchParams.get("key")).toBe("test-secret-key");
    expect(target.searchParams.get("out_trade_no")).toBe("order-1");
  });

  it("performs the documented read-only merchant query without returning account details", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1,
      msg: "success",
      pid: 1001,
      username: "merchant_name",
      money: "0.00",
      status: 1
    }));
    const client = new KaipayEpayV1Client({ config: config(), fetchImpl });
    await expect(client.queryMerchant()).resolves.toEqual({ ok: true, accountActive: true });
    const target = new URL(fetchImpl.mock.calls[0][0]);
    expect(target.origin + target.pathname).toBe("https://api.kaipay.cn/epay/api");
    expect(target.searchParams.get("act")).toBe("query");
    expect(target.searchParams.get("pid")).toBe("1001");
    expect(target.searchParams.get("key")).toBe("test-secret-key");

    const inactiveClient = new KaipayEpayV1Client({
      config: config(),
      fetchImpl: vi.fn(async () => jsonResponse({ code: 1, pid: 1001, username: "merchant_name", money: "1.00", status: 0 }))
    });
    await expect(inactiveClient.queryMerchant()).rejects.toThrow(/not active/);
  });

  it("cannot be selected by the V3 production capability probe", async () => {
    const fetchImpl = vi.fn();
    const environment = {
      PETPACK_PLATFORM_MODE: "production",
      KAIPAY_MERCHANT_ID: "1001",
      KAIPAY_CREDENTIALS_JSON: '{"epayKey":"test-secret-key"}',
      KAIPAY_API_BASE_URL: "https://api.kaipay.cn",
      KAIPAY_NOTIFY_BASE_URL: "https://api.heyirmy.com/api/payments/kaipay/notify",
      KAIPAY_RETURN_BASE_URL: "https://heyirmy.com/projects/payment-return",
      KAIPAY_ADAPTER_VERSION: KAIPAY_EPAY_V1_ADAPTER_VERSION,
      KAIPAY_DEFAULT_CHANNEL: "ALIPAY",
      KAIPAY_REQUEST_TIMEOUT_MS: "15000",
      KAIPAY_ALLOW_SIMULATED_PAYMENTS: "false"
    };
    await expect(runKaipayMerchantProbe({ environment, fetchImpl })).rejects.toThrow(/V3|credentials|deployment-ready/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("verifies the official GET notification and returns exact success text only for paid reconciliation", async () => {
    const protocol = new KaipayEpayV1NotificationProtocol({ config: config() });
    const params = {
      pid: "1001",
      trade_no: "202608140001",
      out_trade_no: "order-1",
      type: "alipay",
      name: "淘淘的桌宠素材包",
      money: "19.90",
      trade_status: "TRADE_SUCCESS",
      sign_type: "MD5"
    };
    params.sign = signEpayParams(params, "test-secret-key");
    const verified = await protocol.verify(new URLSearchParams(params).toString(), {
      expectedMerchantId: "1001",
      expectedPlatformOrderId: "order-1"
    });
    expect(verified).toEqual({
      valid: true,
      merchantId: "1001",
      platformOrderId: "order-1",
      providerOrderId: "202608140001",
      status: "PAID"
    });
    await expect(protocol.verify(`${new URLSearchParams(params)}&pid=1001`, {
      expectedMerchantId: "1001",
      expectedPlatformOrderId: "order-1"
    })).rejects.toThrow(/query is invalid/);
    expect(await protocol.acknowledge({ verified: true, state: "paid" })).toEqual({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "success"
    });
    expect((await protocol.acknowledge({ verified: true, state: "payment_review", reason: "provider_query_missing" })).status).toBe(503);
    expect((await protocol.acknowledge({ verified: false, state: "payment_review" })).status).toBe(400);
  });

  it("pins the official production gateway, strict secret schema, adapter version, and disables guessed refunds", async () => {
    expect(parseEpayCredentials('{"epayKey":"test-secret-key"}')).toEqual({ epayKey: "test-secret-key" });
    expect(() => parseEpayCredentials('{"key":"test-secret-key"}')).toThrow(/only epayKey/);
    expect(() => new KaipayEpayV1Client({ config: config({ apiBaseUrl: "https://example.com" }), fetchImpl: vi.fn() }))
      .toThrow(/official domestic gateway/);
    expect(() => createKaipayEpayV1Adapters({ config: config({ adapterVersion: "unreviewed/v2" }), fetchImpl: vi.fn() }))
      .toThrow(/KAIPAY_ADAPTER_VERSION/);
    const client = new KaipayEpayV1Client({ config: config(), fetchImpl: vi.fn() });
    await expect(client.refund({})).rejects.toMatchObject({ code: "kaipay_refund_protocol_unavailable" });
  });

  it("cannot be selected by the production payment-provider factory", () => {
    const orderStore = {
      getPaymentOrder: vi.fn()
    };
    const eventStore = {
      appendIdempotent: vi.fn(async () => undefined),
      storeEncryptedNotification: vi.fn(async () => undefined)
    };
    expect(() => createPaymentProvider({
      config: {
        ...config(),
        notifyBaseUrl: "https://api.heyirmy.com/api/payments/kaipay/notify",
        returnBaseUrl: "https://heyirmy.com/projects/payment-return",
        allowSimulatedPayments: false
      },
      fetchImpl: vi.fn(),
      orderStore,
      eventStore,
      logger: { info() {}, warn() {} }
    })).toThrow(/V3|KAIPAY_ADAPTER_VERSION/i);
  });
});
