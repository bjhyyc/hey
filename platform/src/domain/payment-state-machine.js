const crypto = require("node:crypto");

const PAYMENT_METHODS = Object.freeze(["ALIPAY"]);
const PAYMENT_STATES = Object.freeze({
  DRAFT: "draft",
  PENDING_PAYMENT: "pending_payment",
  PAID: "paid",
  PAYMENT_REVIEW: "payment_review",
  EXPIRED: "expired",
  REFUND_PENDING: "refund_pending",
  REFUNDED: "refunded"
});

const SUCCESS_PROVIDER_STATUSES = new Set(["SUCCESS", "PAID", "TRADE_SUCCESS", "TRADE_FINISHED"]);
const PENDING_PROVIDER_STATUSES = new Set(["PROCESSING", "PENDING", "INIT", "CREATED", "WAIT_BUYER_PAY"]);
const EXPIRED_PROVIDER_STATUSES = new Set(["TIME_OUT", "TIMEOUT", "CLOSE", "CLOSED", "EXPIRED", "TRADE_CLOSED"]);
const FAILED_PROVIDER_STATUSES = new Set(["FAIL", "FAILED", "CANCELED", "CANCELLED"]);

function assertPaymentMethod(method) {
  if (!PAYMENT_METHODS.includes(method)) {
    throw new Error("PetPack Studio accepts only ALIPAY payments");
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
  return PAYMENT_STATES.PAYMENT_REVIEW;
}

function createPaymentEventIdempotencyKey({ platformOrderId, providerOrderId, eventType, providerStatus }) {
  const material = [platformOrderId, providerOrderId || "", eventType, normalizeProviderStatus(providerStatus)].join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
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

  const mismatches = [];
  if (queriedOrder.platformOrderId !== order.id) mismatches.push("platform_order_id");
  if (queriedOrder.providerOrderId !== verifiedNotification.providerOrderId) mismatches.push("provider_order_id");
  if (Number(queriedOrder.amountFen) !== Number(order.amountFen)) mismatches.push("amount");
  if (queriedOrder.currency && queriedOrder.currency !== "CNY") mismatches.push("currency");
  if (queriedOrder.paymentMethod && queriedOrder.paymentMethod !== order.paymentMethod) mismatches.push("payment_method");
  if (mismatches.length > 0) {
    return {
      state: PAYMENT_STATES.PAYMENT_REVIEW,
      reason: `provider_query_mismatch:${mismatches.join(",")}`,
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
    reason: state === PAYMENT_STATES.PAID ? "verified_notification_and_provider_query" : "provider_query_not_paid",
    providerOrderId: queriedOrder.providerOrderId,
    paymentEventKey: createPaymentEventIdempotencyKey({
      platformOrderId: order.id,
      providerOrderId: queriedOrder.providerOrderId,
      eventType: "provider_query",
      providerStatus: queriedOrder.status
    })
  };
}

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_STATES,
  assertAmountFen,
  assertPaymentMethod,
  createPaymentEventIdempotencyKey,
  normalizeProviderStatus,
  providerStatusToPaymentState,
  reconcileProviderPayment
};
