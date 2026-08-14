const crypto = require("node:crypto");

const {
  PAYMENT_STATES,
  assertAmountFen,
  createPaymentEventIdempotencyKey
} = require("../domain/payment-state-machine");
const { digestNotification } = require("./payment-provider-common");

function requireId(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requireStore(store, method, label) {
  if (!store || typeof store[method] !== "function") throw new Error(`${label} is required`);
  return store;
}

class SimulatedPaymentProvider {
  constructor({ mode, eventStore, orderStore } = {}) {
    if (mode !== "development") throw new Error("Simulated payments are restricted to development mode");
    this.eventStore = requireStore(eventStore, "appendIdempotent", "An idempotent payment event store");
    this.orderStore = requireStore(orderStore, "getPaymentOrder", "An authoritative payment order store");
  }

  async createCheckout({ platformOrderId, idempotencyKey, paymentChannel = "ALIPAY" }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    if (order.paymentMethod !== "KAIPAY") throw new Error("Simulated checkout requires a KAIPAY order");
    const key = requireId(idempotencyKey, "Checkout idempotency key");
    if (!["ALIPAY", "WXPAY"].includes(paymentChannel)) throw new Error("Simulated checkout payment channel is invalid");
    const providerOrderId = `sim_${crypto.createHash("sha256").update(`${order.id}|${key}`).digest("hex").slice(0, 24)}`;
    await this.eventStore.appendIdempotent({
      idempotencyKey: `checkout:${key}`,
      type: "checkout_created_simulated",
      platformOrderId: order.id,
      providerOrderId,
      paymentMethod: order.paymentMethod,
      paymentChannel,
      amountFen: order.amountFen,
      provider: "KAIPAY",
      adapterVersion: "simulated/v1"
    });
    return {
      provider: "KAIPAY_SIMULATED",
      providerOrderId,
      nextAction: { type: "none" },
      paymentMethod: "KAIPAY",
      paymentChannel,
      state: PAYMENT_STATES.PENDING_PAYMENT
    };
  }

  async handleNotification({ platformOrderId, rawNotification }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    let notification = rawNotification;
    if (Buffer.isBuffer(notification) || typeof notification === "string") {
      try { notification = JSON.parse(Buffer.isBuffer(notification) ? notification.toString("utf8") : notification); } catch (_error) { notification = null; }
    }
    const paid = Boolean(notification && notification.type === "development_payment_confirmed" && notification.platformOrderId === order.id);
    const state = paid ? PAYMENT_STATES.PAID : PAYMENT_STATES.PAYMENT_REVIEW;
    const providerOrderId = order.providerOrderId || `sim_${crypto.createHash("sha256").update(order.id).digest("hex").slice(0, 24)}`;
    const providerStatus = paid ? "PAID" : "FAILED";
    const paymentEventKey = createPaymentEventIdempotencyKey({
      platformOrderId: order.id,
      providerOrderId,
      eventType: "simulated_notification",
      providerStatus
    });
    await this.eventStore.appendIdempotent({
      idempotencyKey: `simulated-notification:${order.id}:${digestNotification(rawNotification)}`,
      type: "payment_notification_reconciled_simulated",
      platformOrderId: order.id,
      signatureValid: paid,
      state,
      provider: "KAIPAY",
      providerStatus,
      adapterVersion: "simulated/v1"
    });
    return {
      state,
      reason: paid ? "development_simulated_payment_confirmed" : "development_simulated_payment_rejected",
      providerOrderId,
      paymentEventKey,
      acknowledgement: { status: 200, contentType: "text/plain; charset=utf-8", body: "development-only" }
    };
  }

  async queryStatus({ platformOrderId }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    const state = Object.values(PAYMENT_STATES).includes(order.status)
      ? order.status
      : PAYMENT_STATES.PENDING_PAYMENT;
    const providerOrderId = order.providerOrderId || `sim_${crypto.createHash("sha256").update(order.id).digest("hex").slice(0, 24)}`;
    return {
      state,
      reason: "development_simulated_status_query",
      providerOrderId,
      paymentEventKey: createPaymentEventIdempotencyKey({
        platformOrderId: order.id,
        providerOrderId,
        eventType: "simulated_query",
        providerStatus: state
      }),
      applyToOrder: true,
      nextAction: { type: "none" }
    };
  }

  async refund({ platformOrderId, refundId, amountFen, reason, idempotencyKey }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    const safeAmount = assertAmountFen(amountFen);
    if (safeAmount > Number(order.amountFen)) throw new Error("Refund amount cannot exceed the paid order amount");
    const safeRefundId = requireId(refundId, "Refund ID");
    const safeKey = requireId(idempotencyKey, "Refund idempotency key");
    await this.eventStore.appendIdempotent({
      idempotencyKey: `simulated-refund:${safeKey}`,
      type: "refund_confirmed_simulated",
      platformOrderId: order.id,
      refundId: safeRefundId,
      amountFen: safeAmount,
      reason: requireId(reason, "Refund reason"),
      provider: "KAIPAY",
      adapterVersion: "simulated/v1"
    });
    return { state: PAYMENT_STATES.REFUNDED, refundId: safeRefundId };
  }
}

module.exports = { SimulatedPaymentProvider };
