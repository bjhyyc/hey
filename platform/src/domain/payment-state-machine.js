const crypto = require("node:crypto");

const PAYMENT_METHODS = Object.freeze(["KAIPAY"]);
const PAYMENT_STATES = Object.freeze({
  DRAFT: "draft",
  PENDING_PAYMENT: "pending_payment",
  PAID: "paid",
  PAYMENT_REVIEW: "payment_review",
  EXPIRED: "expired",
  REFUND_PENDING: "refund_pending",
  REFUNDED: "refunded"
});

// Provider-specific wire statuses are translated by the Kaipay adapter. The
// core payment state machine deliberately accepts only these canonical values
// so a newly introduced or misspelled provider status can never mark an order
// paid by accident.
const SUCCESS_PROVIDER_STATUSES = new Set(["PAID"]);
const PENDING_PROVIDER_STATUSES = new Set(["PENDING"]);
const EXPIRED_PROVIDER_STATUSES = new Set(["EXPIRED"]);
const FAILED_PROVIDER_STATUSES = new Set(["FAILED"]);
const REFUNDED_PROVIDER_STATUSES = new Set(["REFUNDED"]);

function assertPaymentMethod(method) {
  if (!PAYMENT_METHODS.includes(method)) {
    throw new Error("PetPack Studio accepts only KAIPAY payments");
  }
  return method;
}

function assertAmountFen(amountFen) {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
    throw new Error("Payment amountFen must be a positive integer");
  }
  return amountFen;
}

function normalizeProviderStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function providerStatusToPaymentState(status) {
  const normalized = normalizeProviderStatus(status);
  if (SUCCESS_PROVIDER_STATUSES.has(normalized)) return PAYMENT_STATES.PAID;
  if (PENDING_PROVIDER_STATUSES.has(normalized)) return PAYMENT_STATES.PENDING_PAYMENT;
  if (EXPIRED_PROVIDER_STATUSES.has(normalized)) return PAYMENT_STATES.EXPIRED;
  if (FAILED_PROVIDER_STATUSES.has(normalized)) return PAYMENT_STATES.PAYMENT_REVIEW;
  if (REFUNDED_PROVIDER_STATUSES.has(normalized)) return PAYMENT_STATES.REFUNDED;
  return PAYMENT_STATES.PAYMENT_REVIEW;
}

function createPaymentEventIdempotencyKey({ platformOrderId, providerOrderId, eventType, providerStatus }) {
  const material = [platformOrderId, providerOrderId || "", eventType, normalizeProviderStatus(providerStatus)].join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
}

function reconcileQueriedProviderPayment({ order, queriedOrder, confirmedByNotification = false }) {
  if (!order || !order.id) throw new Error("Platform order is required");
  if (!queriedOrder) throw new Error("An authoritative provider query is required");

  const mismatches = [];
  if (queriedOrder.platformOrderId !== order.id) mismatches.push("platform_order_id");
  if (order.providerOrderId && queriedOrder.providerOrderId !== order.providerOrderId) mismatches.push("provider_order_id");
  if (Number(queriedOrder.amountFen) !== Number(order.amountFen)) mismatches.push("amount");
  if (queriedOrder.currency && queriedOrder.currency !== "CNY") mismatches.push("currency");
  if (queriedOrder.paymentMethod && queriedOrder.paymentMethod !== order.paymentMethod) mismatches.push("payment_method");
  if (queriedOrder.paymentChannel && order.paymentChannel && queriedOrder.paymentChannel !== order.paymentChannel) mismatches.push("payment_channel");
  if (queriedOrder.providerCode && order.paymentProviderCode && queriedOrder.providerCode !== order.paymentProviderCode) mismatches.push("provider_code");
  if (queriedOrder.scene && order.paymentScene && queriedOrder.scene !== order.paymentScene) mismatches.push("payment_scene");
  if (mismatches.length > 0) {
    return {
      state: PAYMENT_STATES.PAYMENT_REVIEW,
      reason: `provider_query_mismatch:${mismatches.join(",")}`,
      providerOrderId: order.providerOrderId || queriedOrder.providerOrderId,
      paymentEventKey: createPaymentEventIdempotencyKey({
        platformOrderId: order.id,
        providerOrderId: queriedOrder.providerOrderId,
        eventType: "query_mismatch",
        providerStatus: queriedOrder.status
      })
    };
  }

  const state = providerStatusToPaymentState(queriedOrder.status);
  return {
    state,
    reason: state === PAYMENT_STATES.PAID
      ? (confirmedByNotification ? "verified_notification_and_provider_query" : "authoritative_provider_query")
      : "provider_query_not_paid",
    providerOrderId: queriedOrder.providerOrderId,
    paymentEventKey: createPaymentEventIdempotencyKey({
      platformOrderId: order.id,
      providerOrderId: queriedOrder.providerOrderId,
      eventType: "provider_query",
      providerStatus: queriedOrder.status
    })
  };
}

function reconcileProviderPayment({
  order,
  verifiedNotification,
  queriedOrder
}) {
  if (!order || !order.id) throw new Error("Platform order is required");
  if (!verifiedNotification || verifiedNotification.valid !== true) {
    return {
      state: PAYMENT_STATES.PAYMENT_REVIEW,
      reason: "notification_signature_invalid",
      paymentEventKey: createPaymentEventIdempotencyKey({
        platformOrderId: order.id,
        providerOrderId: verifiedNotification && verifiedNotification.providerOrderId,
        eventType: "notification_rejected",
        providerStatus: verifiedNotification && verifiedNotification.status
      })
    };
  }
  if (!queriedOrder) {
    return {
      state: PAYMENT_STATES.PAYMENT_REVIEW,
      reason: "provider_query_missing",
      paymentEventKey: createPaymentEventIdempotencyKey({
        platformOrderId: order.id,
        providerOrderId: verifiedNotification.providerOrderId,
        eventType: "query_missing",
        providerStatus: verifiedNotification.status
      })
    };
  }

  if (queriedOrder.providerOrderId !== verifiedNotification.providerOrderId) {
    return {
      state: PAYMENT_STATES.PAYMENT_REVIEW,
      reason: "provider_query_mismatch:provider_order_id",
      providerOrderId: order.providerOrderId || verifiedNotification.providerOrderId,
      paymentEventKey: createPaymentEventIdempotencyKey({
        platformOrderId: order.id,
        providerOrderId: queriedOrder.providerOrderId,
        eventType: "query_mismatch",
        providerStatus: queriedOrder.status
      })
    };
  }
  return reconcileQueriedProviderPayment({ order, queriedOrder, confirmedByNotification: true });
}

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_STATES,
  assertAmountFen,
  assertPaymentMethod,
  createPaymentEventIdempotencyKey,
  normalizeProviderStatus,
  providerStatusToPaymentState,
  reconcileQueriedProviderPayment,
  reconcileProviderPayment
};
