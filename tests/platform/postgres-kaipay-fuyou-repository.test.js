import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { PostgresPetPackStudioRepository } = require("../../platform/src/persistence/postgres-petpack-studio-repository");

const ADAPTER_VERSION = "kaipay-pay-api-v3-hmac-sha256/1";
const CREDENTIAL_VERSION = `kpv3-${"a".repeat(64)}`;

function repositoryFor(query) {
  return new PostgresPetPackStudioRepository({
    database: { transaction: vi.fn(async (callback) => callback({ query })) },
    idFactory: vi.fn()
      .mockReturnValueOnce("attempt-id")
      .mockReturnValueOnce("event-id")
  });
}

function checkoutEvent(overrides = {}) {
  return {
    platformOrderId: "order-1",
    idempotencyKey: "checkout:idem-1",
    type: "checkout_created",
    provider: "KAIPAY",
    providerOrderId: "fuyou-order-1",
    paymentMethod: "KAIPAY",
    amountFen: 1990,
    adapterVersion: ADAPTER_VERSION,
    credentialVersion: CREDENTIAL_VERSION,
    paymentChannel: "ALIPAY",
    payMethod: "alipay",
    providerCode: "fuyou",
    scene: "native",
    ...overrides
  };
}

describe("PostgreSQL Kaipay Fuyou identity persistence", () => {
  it.each([
    ["ALIPAY", "alipay"],
    ["WXPAY", "wechat"]
  ])("writes the immutable %s Fuyou route without dropping payMethod", async (paymentChannel, payMethod) => {
    const query = vi.fn(async (sql) => {
      if (sql.includes("FROM customer_order")) {
        return { rows: [{ id: "order-1", amount_fen: 1990, payment_method: "KAIPAY" }] };
      }
      if (sql.includes("INSERT INTO payment_attempt")) return { rows: [{ id: "attempt-id" }] };
      if (sql.includes("INSERT INTO payment_event")) return { rows: [{ id: "event-id" }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = repositoryFor(query);

    await expect(repository.appendIdempotent(checkoutEvent({ paymentChannel, payMethod })))
      .resolves.toEqual({ inserted: true });

    const attemptCall = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO payment_attempt"));
    expect(attemptCall).toBeDefined();
    expect(attemptCall[0]).toContain("payment_channel, pay_method, provider_code, payment_scene");
    expect(attemptCall[1]).toEqual([
      "attempt-id", "order-1", "KAIPAY", "fuyou-order-1", "KAIPAY", 1990,
      "checkout:idem-1", ADAPTER_VERSION, CREDENTIAL_VERSION,
      paymentChannel, payMethod, "fuyou", "native"
    ]);
  });

  it("rejects a Fuyou route whose channel and wire pay method disagree", async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes("FROM customer_order")) {
        return { rows: [{ id: "order-1", amount_fen: 1990, payment_method: "KAIPAY" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = repositoryFor(query);

    await expect(repository.appendIdempotent(checkoutEvent({ payMethod: "wechat" })))
      .rejects.toThrow(/route identity is invalid/);
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects Fuyou under an adapter version that was not frozen by migration 016", async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes("FROM customer_order")) {
        return { rows: [{ id: "order-1", amount_fen: 1990, payment_method: "KAIPAY" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = repositoryFor(query);

    await expect(repository.appendIdempotent(checkoutEvent({
      adapterVersion: "kaipay-pay-api-v3-hmac-sha256/2"
    }))).rejects.toThrow(/route identity is invalid/);
    expect(query).toHaveBeenCalledOnce();
  });

  it("includes payMethod in checkout idempotency identity comparisons", async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes("FROM customer_order")) {
        return { rows: [{ id: "order-1", amount_fen: 1990, payment_method: "KAIPAY" }] };
      }
      if (sql.includes("INSERT INTO payment_attempt")) return { rows: [] };
      if (sql.includes("FROM payment_attempt")) {
        return { rows: [{
          order_id: "order-1",
          provider: "KAIPAY",
          provider_order_id: "fuyou-order-1",
          payment_method: "KAIPAY",
          amount_fen: 1990,
          adapter_version: ADAPTER_VERSION,
          credential_version: CREDENTIAL_VERSION,
          payment_channel: "ALIPAY",
          pay_method: "wechat",
          provider_code: "fuyou",
          payment_scene: "native"
        }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = repositoryFor(query);

    await expect(repository.appendIdempotent(checkoutEvent()))
      .rejects.toThrow(/idempotency key belongs to another checkout/);
    expect(query.mock.calls.find(([sql]) => sql.includes("FROM payment_attempt"))?.[0])
      .toContain("payment_channel, pay_method, provider_code, payment_scene");
  });

  it("reads payMethod, providerCode, and scene from the latest frozen attempt", async () => {
    const query = vi.fn(async (sql) => {
      expect(sql).toContain("attempt.pay_method AS payment_pay_method");
      expect(sql).toContain("pay_method, provider_code, payment_scene");
      return { rows: [{
        order_id: "order-1",
        order_user_id: "user-1",
        project_id: "project-1",
        plan_id: "plan-1",
        amount_fen: 1990,
        currency: "CNY",
        payment_method: "KAIPAY",
        order_status: "pending_payment",
        version: 0,
        provider_order_id: "fuyou-order-1",
        payment_credential_version: CREDENTIAL_VERSION,
        payment_channel: "ALIPAY",
        payment_pay_method: "alipay",
        payment_provider_code: "fuyou",
        payment_scene: "native"
      }] };
    });
    const repository = repositoryFor(query);

    await expect(repository.getPaymentOrder("order-1")).resolves.toMatchObject({
      paymentChannel: "ALIPAY",
      paymentPayMethod: "alipay",
      paymentProviderCode: "fuyou",
      paymentScene: "native",
      paymentCredentialVersion: CREDENTIAL_VERSION
    });
  });
});
