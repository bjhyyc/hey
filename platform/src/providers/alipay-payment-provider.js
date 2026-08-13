const crypto = require("node:crypto");

const {
  PAYMENT_METHODS,
  PAYMENT_STATES,
  assertAmountFen,
  assertPaymentMethod,
  reconcileProviderPayment
} = require("../domain/payment-state-machine");

const ALIPAY_METHODS = Object.freeze({
  pagePay: "alipay.trade.page.pay",
  queryOrder: "alipay.trade.query",
  refund: "alipay.trade.refund"
});

const DEFAULT_ALIPAY_GATEWAY_URL = "https://openapi.alipay.com/gateway.do";

function optionalString(env, name) {
  const value = env && env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function requireProductionSetting(value, label, errors) {
  if (!value) errors.push(`${label} is required`);
}

function loadAlipayConfig(env = process.env) {
  const mode = optionalString(env, "PETPACK_PLATFORM_MODE") || "development";
  const config = {
    mode,
    appId: optionalString(env, "ALIPAY_APP_ID"),
    sellerId: optionalString(env, "ALIPAY_SELLER_ID"),
    privateKey: optionalString(env, "ALIPAY_PRIVATE_KEY"),
    publicKey: optionalString(env, "ALIPAY_PUBLIC_KEY"),
    notifyBaseUrl: optionalString(env, "ALIPAY_NOTIFY_BASE_URL"),
    returnBaseUrl: optionalString(env, "ALIPAY_RETURN_BASE_URL"),
    gatewayUrl: optionalString(env, "ALIPAY_GATEWAY_URL") || DEFAULT_ALIPAY_GATEWAY_URL,
    allowSimulatedPayments: optionalString(env, "ALIPAY_ALLOW_SIMULATED_PAYMENTS") === "true"
  };
  if (mode === "production" || mode === "test") {
    const errors = [];
    requireProductionSetting(config.appId, "ALIPAY_APP_ID", errors);
    requireProductionSetting(config.sellerId, "ALIPAY_SELLER_ID", errors);
    requireProductionSetting(config.privateKey, "ALIPAY_PRIVATE_KEY", errors);
    requireProductionSetting(config.publicKey, "ALIPAY_PUBLIC_KEY", errors);
    requireProductionSetting(config.notifyBaseUrl, "ALIPAY_NOTIFY_BASE_URL", errors);
    requireProductionSetting(config.returnBaseUrl, "ALIPAY_RETURN_BASE_URL", errors);
    requireProductionSetting(config.gatewayUrl, "ALIPAY_GATEWAY_URL", errors);
    if (config.allowSimulatedPayments) errors.push("ALIPAY_ALLOW_SIMULATED_PAYMENTS must be disabled outside development");
    if (errors.length > 0) throw new Error(`Alipay configuration is not deployment-ready: ${errors.join("; ")}`);
  }
  return config;
}

function requireId(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function createCheckoutRequest({ order, returnUrl }) {
  if (!order || typeof order !== "object") throw new Error("Order is required");
  const platformOrderId = requireId(order.id, "Platform order ID");
  const paymentMethod = assertPaymentMethod(order.paymentMethod);
  return {
    platformOrderId,
    amountFen: assertAmountFen(order.amountFen),
    currency: "CNY",
    paymentMethod,
    subject: typeof order.displayName === "string" && order.displayName.trim()
      ? `${order.displayName.trim()}的桌宠素材包`.slice(0, 256)
      : "PetPack Studio 桌宠素材包",
    returnUrl: requireId(returnUrl, "Return URL")
  };
}

function digestNotification(rawNotification) {
  const material = typeof rawNotification === "string"
    ? rawNotification
    : JSON.stringify(rawNotification || {});
  return crypto.createHash("sha256").update(material).digest("hex");
}

function createServerReturnUrl(returnBaseUrl, platformOrderId) {
  const target = new URL(requireId(returnBaseUrl, "Alipay return base URL"));
  target.searchParams.set("order", platformOrderId);
  return target.toString();
}

function createServerNotificationUrl(notifyBaseUrl, platformOrderId) {
  const target = new URL(requireId(notifyBaseUrl, "Alipay notification base URL"));
  const basePath = target.pathname.replace(/\/+$/, "");
  target.pathname = `${basePath}/${encodeURIComponent(requireId(platformOrderId, "Platform order ID"))}`;
  return target.toString();
}

function requireOrderStore(orderStore) {
  if (!orderStore || typeof orderStore.getPaymentOrder !== "function") {
    throw new Error("An authoritative server-side payment order store is required");
  }
  return orderStore;
}

function requirePaymentEventStore(eventStore, { requireSecureNotificationStore = false } = {}) {
  if (!eventStore || typeof eventStore.appendIdempotent !== "function") {
    throw new Error("An idempotent payment event store is required");
  }
  if (requireSecureNotificationStore && typeof eventStore.storeEncryptedNotification !== "function") {
    throw new Error("A secure raw payment-notification store is required");
  }
  return eventStore;
}

/**
 * Server-side adapter around the official Alipay OpenAPI client. The injected
 * client owns RSA2 request signing, response verification, and API field
 * mapping. Browser return URLs remain display-only; a verified asynchronous
 * notification plus an authoritative trade query is required before payment.
 */
class AlipayPaymentProvider {
  constructor({ config, alipayClient, notificationVerifier, eventStore, orderStore, logger = console } = {}) {
    if (!config) throw new Error("Alipay server configuration is required");
    if (!alipayClient || typeof alipayClient.pagePay !== "function" || typeof alipayClient.queryOrder !== "function" || typeof alipayClient.refund !== "function") {
      throw new Error("An Alipay OpenAPI server client is required");
    }
    if (!notificationVerifier || typeof notificationVerifier.verify !== "function") {
      throw new Error("An Alipay notification verifier is required");
    }
    this.config = config;
    this.alipayClient = alipayClient;
    this.notificationVerifier = notificationVerifier;
    this.eventStore = requirePaymentEventStore(eventStore, { requireSecureNotificationStore: true });
    this.orderStore = requireOrderStore(orderStore);
    this.logger = logger;
  }

  async createCheckout({ platformOrderId, idempotencyKey }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    const request = createCheckoutRequest({
      order,
      returnUrl: createServerReturnUrl(this.config.returnBaseUrl, order.id)
    });
    const response = await this.alipayClient.pagePay({
      ...request,
      notifyUrl: createServerNotificationUrl(this.config.notifyBaseUrl, order.id),
      idempotencyKey: requireId(idempotencyKey, "Checkout idempotency key")
    });
    if (!response || !response.checkoutUrl) {
      throw new Error("Alipay page-pay response is incomplete");
    }
    // Page-pay URL generation happens before Alipay assigns trade_no. Keep the
    // merchant order ID as the checkout reference until the verified callback
    // and trade query supply the authoritative Alipay trade number.
    const providerOrderId = response.providerOrderId || request.platformOrderId;
    await this.eventStore.appendIdempotent({
      idempotencyKey: `checkout:${idempotencyKey}`,
      type: "checkout_created",
      platformOrderId: request.platformOrderId,
      providerOrderId,
      paymentMethod: request.paymentMethod
    });
    this.logger.info?.("petpack.alipay.checkout_created", {
      platformOrderId: request.platformOrderId,
      paymentMethod: request.paymentMethod
    });
    return {
      provider: "ALIPAY",
      providerOrderId,
      checkoutUrl: response.checkoutUrl,
      paymentMethod: request.paymentMethod,
      state: PAYMENT_STATES.PENDING_PAYMENT
    };
  }

  async handleNotification({ platformOrderId, rawNotification }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    let notification;
    let verificationError = null;
    try {
      notification = await this.notificationVerifier.verify(rawNotification, {
        expectedAppId: this.config.appId,
        expectedSellerId: this.config.sellerId
      });
    } catch (error) {
      verificationError = error;
    }
    const verifiedNotification = {
      valid: Boolean(
        !verificationError &&
        notification &&
        notification.valid &&
        notification.appId === this.config.appId &&
        notification.sellerId === this.config.sellerId &&
        notification.platformOrderId === order.id
      ),
      providerOrderId: notification && notification.providerOrderId,
      status: notification && notification.status
    };
    const notificationDigest = digestNotification(rawNotification);
    // Persist receipt before querying Alipay. A transient query failure must never
    // make a valid asynchronous callback disappear from the audit trail.
    await this.eventStore.appendIdempotent({
      idempotencyKey: `notification-received:${order.id}:${notificationDigest}`,
      type: "payment_notification_received",
      platformOrderId: order.id,
      providerOrderId: verifiedNotification.providerOrderId || null,
      rawNotificationDigest: notificationDigest,
      signatureValid: verifiedNotification.valid,
      verificationError: verificationError ? "notification_verification_failed" : null
    });
    await this.eventStore.storeEncryptedNotification({
      idempotencyKey: `notification-raw:${order.id}:${notificationDigest}`,
      platformOrderId: order.id,
      providerOrderId: verifiedNotification.providerOrderId || null,
      rawNotification
    });
    let queriedOrder = null;
    if (verifiedNotification.valid) {
      try {
        queriedOrder = await this.alipayClient.queryOrder({
          platformOrderId: requireId(order.id, "Platform order ID"),
          providerOrderId: requireId(verifiedNotification.providerOrderId, "Alipay provider order ID")
        });
      } catch (error) {
        this.logger.warn?.("petpack.alipay.provider_query_failed", {
          platformOrderId: order.id,
          providerOrderId: verifiedNotification.providerOrderId,
          error: error && error.message ? error.message : "provider_query_failed"
        });
      }
    }
    const reconciliation = reconcileProviderPayment({ order, verifiedNotification, queriedOrder });
    await this.eventStore.appendIdempotent({
      idempotencyKey: reconciliation.paymentEventKey,
      type: "payment_notification_reconciled",
      platformOrderId: order.id,
      providerOrderId: reconciliation.providerOrderId || verifiedNotification.providerOrderId || null,
      signatureValid: verifiedNotification.valid,
      state: reconciliation.state,
      reason: reconciliation.reason
    });
    this.logger.info?.("petpack.alipay.notification_reconciled", {
      platformOrderId: order.id,
      signatureValid: verifiedNotification.valid,
      state: reconciliation.state
    });
    return reconciliation;
  }

  async refund({ platformOrderId, refundId, amountFen, reason, idempotencyKey }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    const request = {
      platformOrderId: requireId(order && order.id, "Platform order ID"),
      providerOrderId: requireId(order && order.providerOrderId, "Alipay provider order ID"),
      refundId: requireId(refundId, "Refund ID"),
      amountFen: assertAmountFen(amountFen),
      reason: requireId(reason, "Refund reason"),
      idempotencyKey: requireId(idempotencyKey, "Refund idempotency key")
    };
    if (request.amountFen > Number(order.amountFen)) {
      throw new Error("Refund amount cannot exceed the paid order amount");
    }
    const response = await this.alipayClient.refund(request);
    await this.eventStore.appendIdempotent({
      idempotencyKey: `refund:${request.idempotencyKey}`,
      type: "refund_requested",
      platformOrderId: request.platformOrderId,
      providerOrderId: request.providerOrderId,
      refundId: request.refundId,
      amountFen: request.amountFen
    });
    return {
      ...response,
      state: PAYMENT_STATES.REFUND_PENDING
    };
  }
}

/** Development-only simulation. It deliberately has no external checkout and
 * must not be enabled in test or production configuration. */
class SimulatedPaymentProvider {
  constructor({ eventStore, orderStore, logger = console } = {}) {
    this.eventStore = requirePaymentEventStore(eventStore);
    this.orderStore = requireOrderStore(orderStore);
    this.logger = logger;
  }

  async createCheckout({ platformOrderId, idempotencyKey }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    const request = createCheckoutRequest({
      order,
      returnUrl: createServerReturnUrl("http://localhost/payment-return", order.id)
    });
    const providerOrderId = `sim_${crypto.createHash("sha256").update(`${request.platformOrderId}|${idempotencyKey}`).digest("hex").slice(0, 24)}`;
    await this.eventStore.appendIdempotent({
      idempotencyKey: `checkout:${idempotencyKey}`,
      type: "checkout_created_simulated",
      platformOrderId: request.platformOrderId,
      providerOrderId,
      paymentMethod: request.paymentMethod
    });
    return {
      provider: "ALIPAY_SIMULATED",
      providerOrderId,
      checkoutUrl: `petpack-dev://checkout/${encodeURIComponent(providerOrderId)}`,
      paymentMethod: request.paymentMethod,
      state: PAYMENT_STATES.PENDING_PAYMENT
    };
  }

  async handleNotification({ platformOrderId, rawNotification }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    const paid = Boolean(rawNotification && rawNotification.type === "development_payment_confirmed" && rawNotification.platformOrderId === order.id);
    const state = paid ? PAYMENT_STATES.PAID : PAYMENT_STATES.PAYMENT_REVIEW;
    await this.eventStore.appendIdempotent({
      idempotencyKey: `simulated-notification:${order.id}:${digestNotification(rawNotification)}`,
      type: "payment_notification_reconciled_simulated",
      platformOrderId: order.id,
      signatureValid: paid,
      state
    });
    return {
      state,
      reason: paid ? "development_simulated_payment_confirmed" : "development_simulated_payment_rejected"
    };
  }

  async refund({ platformOrderId, refundId, amountFen, reason, idempotencyKey }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    const request = {
      platformOrderId: order.id,
      refundId: requireId(refundId, "Refund ID"),
      amountFen: assertAmountFen(amountFen),
      reason: requireId(reason, "Refund reason"),
      idempotencyKey: requireId(idempotencyKey, "Refund idempotency key")
    };
    if (request.amountFen > Number(order.amountFen)) {
      throw new Error("Refund amount cannot exceed the paid order amount");
    }
    await this.eventStore.appendIdempotent({
      idempotencyKey: `simulated-refund:${request.idempotencyKey}`,
      type: "refund_confirmed_simulated",
      ...request
    });
    return { state: PAYMENT_STATES.REFUNDED, refundId: request.refundId };
  }
}

function createPaymentProvider({ config, ...dependencies }) {
  if (config && config.mode === "development" && config.allowSimulatedPayments) {
    return new SimulatedPaymentProvider(dependencies);
  }
  return new AlipayPaymentProvider({ config, ...dependencies });
}

module.exports = {
  PAYMENT_METHODS,
  ALIPAY_METHODS,
  AlipayPaymentProvider,
  DEFAULT_ALIPAY_GATEWAY_URL,
  SimulatedPaymentProvider,
  createCheckoutRequest,
  createServerNotificationUrl,
  createServerReturnUrl,
  createPaymentProvider,
  digestNotification,
  loadAlipayConfig
};
