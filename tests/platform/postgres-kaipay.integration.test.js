import crypto from "node:crypto";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import databaseModule from "../../platform/src/persistence/postgres-database.js";
import repositoryModule from "../../platform/src/persistence/postgres-petpack-studio-repository.js";
import kaipayModule from "../../platform/src/providers/kaipay-payment-provider.js";

const platformRequire = createRequire(new URL("../../platform/package.json", import.meta.url));
const { Pool } = platformRequire("pg");
const { PostgresDatabase } = databaseModule;
const { PostgresPetPackStudioRepository } = repositoryModule;
const { KaipayPaymentProvider } = kaipayModule;

const connectionString = process.env.PETPACK_TEST_POSTGRES_URL || "";
const integration = connectionString ? describe : describe.skip;

integration("PostgreSQL Kaipay persistence integration", () => {
  const ids = {
    user: crypto.randomUUID(),
    plan: crypto.randomUUID(),
    project: crypto.randomUUID(),
    order: crypto.randomUUID()
  };
  const providerOrderId = `kp-${crypto.randomUUID()}`;
  let pool;
  let database;
  let repository;

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 2 });
    database = new PostgresDatabase({ pool, logger: { debug() {}, warn() {}, error() {} } });
    repository = new PostgresPetPackStudioRepository({
      database,
      paymentNotificationEncryptionKey: Buffer.alloc(32, 11),
      logger: { info() {}, warn() {}, error() {} }
    });
    await pool.query("INSERT INTO app_user (id, phone_hash) VALUES ($1, $2)", [ids.user, `phone-${ids.user}`]);
    await pool.query(
      `INSERT INTO product_plan (id, code, name, amount_fen, enabled)
       VALUES ($1, $2, 'Kaipay integration plan', 1990, true)`,
      [ids.plan, `kaipay-${ids.plan}`]
    );
    await pool.query(
      `INSERT INTO pet_project (id, user_id, display_name, state)
       VALUES ($1, $2, 'Kaipay pet', 'awaiting_payment')`,
      [ids.project, ids.user]
    );
    await pool.query(
      `INSERT INTO customer_order
        (id, user_id, project_id, plan_id, amount_fen, payment_method, status)
       VALUES ($1, $2, $3, $4, 1990, 'KAIPAY', 'pending_payment')`,
      [ids.order, ids.user, ids.project, ids.plan]
    );
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  it("persists checkout, encrypted raw callback, idempotent audit, and verified paid transition", async () => {
    const notificationProtocol = {
      verify: vi.fn(async (rawBytes) => {
        expect(Buffer.isBuffer(rawBytes)).toBe(true);
        return {
          valid: true,
          merchantId: "merchant-integration",
          platformOrderId: ids.order,
          providerOrderId,
          status: "PAID"
        };
      }),
      acknowledge: vi.fn(async () => ({ status: 200, contentType: "text/plain", body: "integration-ok" }))
    };
    const client = {
      createCheckout: vi.fn(async () => ({ providerOrderId, checkoutUrl: "https://pay.example/integration" })),
      queryOrder: vi.fn(async () => ({
        platformOrderId: ids.order,
        providerOrderId,
        amountFen: 1990,
        currency: "CNY",
        paymentMethod: "KAIPAY",
        status: "PAID"
      })),
      refund: vi.fn()
    };
    const provider = new KaipayPaymentProvider({
      config: {
        mode: "production",
        merchantId: "merchant-integration",
        credentialsJson: '{"fixture":"integration-only"}',
        notifyBaseUrl: "https://api.heyirmy.com/api/payments/kaipay/notify",
        returnBaseUrl: "https://heyirmy.com/projects/payment-return",
        adapterVersion: "integration/v1",
        allowSimulatedPayments: false
      },
      kaipayClient: client,
      notificationProtocol,
      eventStore: repository,
      orderStore: repository,
      logger: { info() {}, warn() {} }
    });

    const checkout = await provider.createCheckout({ platformOrderId: ids.order, idempotencyKey: `checkout:${ids.order}` });
    expect(checkout.provider).toBe("KAIPAY");
    const raw = Buffer.from(`signed-callback-${ids.order}`);
    const reconciliation = await provider.handleNotification({ platformOrderId: ids.order, rawNotification: raw });
    const applied = await repository.markOrderPaymentState({ platformOrderId: ids.order, reconciliation });
    expect(applied).toMatchObject({ status: "paid", providerOrderId, productionRunNeeded: true });

    const duplicate = await provider.handleNotification({ platformOrderId: ids.order, rawNotification: raw });
    const duplicateApplied = await repository.markOrderPaymentState({ platformOrderId: ids.order, reconciliation: duplicate });
    expect(duplicateApplied.status).toBe("paid");

    const attempts = await pool.query(
      "SELECT provider, payment_method, amount_fen, adapter_version FROM payment_attempt WHERE order_id = $1",
      [ids.order]
    );
    expect(attempts.rows).toEqual([{
      provider: "KAIPAY",
      payment_method: "KAIPAY",
      amount_fen: 1990,
      adapter_version: "integration/v1"
    }]);
    const encrypted = await pool.query(
      `SELECT raw_notification_ciphertext, raw_notification_digest
         FROM payment_event
        WHERE order_id = $1 AND event_type = 'payment_notification_raw'`,
      [ids.order]
    );
    expect(encrypted.rows).toHaveLength(1);
    expect(Buffer.isBuffer(encrypted.rows[0].raw_notification_ciphertext)).toBe(true);
    expect(encrypted.rows[0].raw_notification_ciphertext.includes(raw)).toBe(false);
    expect(encrypted.rows[0].raw_notification_digest).toBe(crypto.createHash("sha256").update(raw).digest("hex"));
    expect(await repository.countLegacyOpenPayments()).toBe(0);
  });
});
