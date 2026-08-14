const {
  PAYMENT_METHODS,
  PAYMENT_STATES,
  assertAmountFen,
  assertPaymentMethod,
  reconcileProviderPayment
} = require("../domain/payment-state-machine");
const { digestNotification } = require("./payment-provider-common");

const ADAPTER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;

function optionalString(env, name) {
  const value = env && env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function requireId(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requireRawNotification(value) {
  if (!(typeof value === "string" || Buffer.isBuffer(value))) {
    throw new Error("Kaipay notification must preserve the original bytes");
  }
  const size = Buffer.byteLength(value);
  if (size === 0 || size > 1024 * 1024) throw new Error("Kaipay notification size is invalid");
  return value;
}

function requireHttpsUrl(value, label) {
  const normalized = requireId(value, label);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_error) {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  return parsed.toString();
}

function validateCredentialsJson(value) {
  if (!value || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new Error("KAIPAY_CREDENTIALS_JSON is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    throw new Error("KAIPAY_CREDENTIALS_JSON is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("KAIPAY_CREDENTIALS_JSON is invalid");
  }
  return value;
}

function assertKaipayRuntimeConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Kaipay server configuration is required");
  if (config.mode === "production" || config.mode === "test") {
    requireId(config.merchantId, "Kaipay merchant ID");
    validateCredentialsJson(config.credentialsJson);
    requireHttpsUrl(config.notifyBaseUrl, "Kaipay notification base URL");
    requireHttpsUrl(config.returnBaseUrl, "Kaipay return base URL");
    if (!ADAPTER_VERSION_PATTERN.test(config.adapterVersion || "")) throw new Error("A pinned Kaipay adapter version is required outside development");
    if (config.allowSimulatedPayments === true) throw new Error("Simulated payments are forbidden outside development");
  }
  return config;
}

/**
 * Loads only the stable deployment boundary. Kaipay wire field names, signing
 * algorithms, endpoint paths, and callback acknowledgement formats belong to
 * the separately versioned adapter obtained from the official API debugger;
 * this module never guesses them.
 */
function loadKaipayConfig(env = process.env) {
  const mode = optionalString(env, "PETPACK_PLATFORM_MODE") || "development";
  const config = {
    mode,
    merchantId: optionalString(env, "KAIPAY_MERCHANT_ID"),
    credentialsJson: optionalString(env, "KAIPAY_CREDENTIALS_JSON"),
    notifyBaseUrl: optionalString(env, "KAIPAY_NOTIFY_BASE_URL"),
    returnBaseUrl: optionalString(env, "KAIPAY_RETURN_BASE_URL"),
    adapterVersion: optionalString(env, "KAIPAY_ADAPTER_VERSION"),
    allowSimulatedPayments: optionalString(env, "KAIPAY_ALLOW_SIMULATED_PAYMENTS") === "true"
  };
  if (mode === "production" || mode === "test") {
    const errors = [];
    if (!config.merchantId) errors.push("KAIPAY_MERCHANT_ID is required");
    if (!config.credentialsJson) errors.push("KAIPAY_CREDENTIALS_JSON is required");
    else {
      try { validateCredentialsJson(config.credentialsJson); } catch (error) { errors.push(error.message); }
    }
    if (!config.notifyBaseUrl) errors.push("KAIPAY_NOTIFY_BASE_URL is required");
    if (!config.returnBaseUrl) errors.push("KAIPAY_RETURN_BASE_URL is required");
    if (!ADAPTER_VERSION_PATTERN.test(config.adapterVersion)) errors.push("KAIPAY_ADAPTER_VERSION is invalid");
    if (config.notifyBaseUrl) {
      try { requireHttpsUrl(config.notifyBaseUrl, "KAIPAY_NOTIFY_BASE_URL"); } catch (error) { errors.push(error.message); }
    }
    if (config.returnBaseUrl) {
      try { requireHttpsUrl(config.returnBaseUrl, "KAIPAY_RETURN_BASE_URL"); } catch (error) { errors.push(error.message); }
    }
    if (config.allowSimulatedPayments) errors.push("KAIPAY_ALLOW_SIMULATED_PAYMENTS must be disabled outside development");
    if (errors.length > 0) throw new Error(`Kaipay configuration is not deployment-ready: ${errors.join("; ")}`);
  }
  return Object.freeze(assertKaipayRuntimeConfig(config));
}

function createCheckoutRequest({ order, returnUrl, notifyUrl }) {
  if (!order || typeof order !== "object") throw new Error("Order is required");
  return Object.freeze({
    platformOrderId: requireId(order.id, "Platform order ID"),
    amountFen: assertAmountFen(order.amountFen),
    currency: "CNY",
    paymentMethod: assertPaymentMethod(order.paymentMethod),
    subject: typeof order.displayName === "string" && order.displayName.trim()
      ? `${order.displayName.trim()}的桌宠素材包`.slice(0, 256)
      : "PetPack Studio 桌宠素材包",
    returnUrl: requireId(returnUrl, "Return URL"),
    notifyUrl: requireId(notifyUrl, "Notification URL")
  });
}

function createServerReturnUrl(returnBaseUrl, platformOrderId) {
  const target = new URL(requireId(returnBaseUrl, "Kaipay return base URL"));
  target.searchParams.set("order", requireId(platformOrderId, "Platform order ID"));
  return target.toString();
}

function createServerNotificationUrl(notifyBaseUrl, platformOrderId) {
  const target = new URL(requireId(notifyBaseUrl, "Kaipay notification base URL"));
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

function requirePaymentEventStore(eventStore, { secureNotifications = false } = {}) {
  if (!eventStore || typeof eventStore.appendIdempotent !== "function") {
    throw new Error("An idempotent payment event store is required");
  }
  if (secureNotifications && typeof eventStore.storeEncryptedNotification !== "function") {
    throw new Error("A secure raw payment-notification store is required");
  }
  return eventStore;
}

function requireClient(client) {
  const methods = ["createCheckout", "queryOrder", "refund"];
  const missing = methods.filter((method) => !client || typeof client[method] !== "function");
  if (missing.length) throw new Error(`The versioned Kaipay client adapter is incomplete: ${missing.join(", ")}`);
  return client;
}

function requireNotificationProtocol(protocol) {
  const methods = ["verify", "acknowledge"];
  const missing = methods.filter((method) => !protocol || typeof protocol[method] !== "function");
  if (missing.length) throw new Error(`The versioned Kaipay notification adapter is incomplete: ${missing.join(", ")}`);
  return protocol;
}

function requireCanonicalStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  if (!["PAID", "PENDING", "EXPIRED", "FAILED"].includes(status)) {
    throw new Error("Kaipay adapter returned an unknown canonical payment status");
  }
  return status;
}

function normalizeAcknowledgement(value) {
  if (!value || typeof value !== "object") throw new Error("Kaipay acknowledgement is missing");
  const status = Number(value.status);
  const body = typeof value.body === "string" ? value.body : "";
  const contentType = typeof value.contentType === "string" ? value.contentType.trim() : "";
  const permittedStatus = (status >= 200 && status <= 299) || (status >= 400 && status <= 599);
  if (!Number.isInteger(status) || !permittedStatus || !body || Buffer.byteLength(body, "utf8") > 4096 || !contentType || contentType.length > 128) {
    throw new Error("Kaipay acknowledgement is invalid");
  }
  return Object.freeze({ status, body, contentType });
}

class KaipayPaymentProvider {
  constructor({ config, kaipayClient, notificationProtocol, eventStore, orderStore, logger = console } = {}) {
    this.config = assertKaipayRuntimeConfig(config);
    this.client = requireClient(kaipayClient);
    this.notificationProtocol = requireNotificationProtocol(notificationProtocol);
    this.eventStore = requirePaymentEventStore(eventStore, { secureNotifications: true });
    this.orderStore = requireOrderStore(orderStore);
    this.logger = logger;
  }

  async createCheckout({ platformOrderId, idempotencyKey }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    const request = createCheckoutRequest({
      order,
      returnUrl: createServerReturnUrl(this.config.returnBaseUrl, order.id),
      notifyUrl: createServerNotificationUrl(this.config.notifyBaseUrl, order.id)
    });
    const response = await this.client.createCheckout({
      ...request,
      idempotencyKey: requireId(idempotencyKey, "Checkout idempotency key")
    });
    const providerOrderId = requireId(response && response.providerOrderId, "Kaipay provider order ID");
    const checkoutUrl = requireId(response && response.checkoutUrl, "Kaipay checkout URL");
    if (this.config.mode === "production") requireHttpsUrl(checkoutUrl, "Kaipay checkout URL");
    await this.eventStore.appendIdempotent({
      idempotencyKey: `checkout:${idempotencyKey}`,
      type: "checkout_created",
      platformOrderId: request.platformOrderId,
      providerOrderId,
      paymentMethod: request.paymentMethod,
      amountFen: request.amountFen,
      provider: "KAIPAY",
      adapterVersion: this.config.adapterVersion
    });
    this.logger.info?.("petpack.kaipay.checkout_created", {
      platformOrderId: request.platformOrderId,
      paymentMethod: request.paymentMethod,
      adapterVersion: this.config.adapterVersion
    });
    return {
      provider: "KAIPAY",
      providerOrderId,
      checkoutUrl,
      paymentMethod: request.paymentMethod,
      state: PAYMENT_STATES.PENDING_PAYMENT
    };
  }

  async handleNotification({ platformOrderId, rawNotification }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    const rawBytes = requireRawNotification(rawNotification);
    let notification = null;
    let verificationError = null;
    try {
      notification = await this.notificationProtocol.verify(rawBytes, {
        expectedMerchantId: this.config.merchantId,
        expectedPlatformOrderId: order.id,
        adapterVersion: this.config.adapterVersion
      });
    } catch (error) {
      verificationError = error;
    }
    let canonicalStatus = "FAILED";
    try {
      if (notification && notification.valid === true) canonicalStatus = requireCanonicalStatus(notification.status);
    } catch (error) {
      verificationError = verificationError || error;
    }
    const verifiedNotification = {
      valid: Boolean(
        !verificationError &&
        notification && notification.valid === true &&
        notification.merchantId === this.config.merchantId &&
        notification.platformOrderId === order.id &&
        typeof notification.providerOrderId === "string" && notification.providerOrderId.trim()
      ),
      providerOrderId: notification && notification.providerOrderId,
      status: canonicalStatus
    };
    const notificationDigest = digestNotification(rawBytes);
    await this.eventStore.appendIdempotent({
      idempotencyKey: `notification-received:${order.id}:${notificationDigest}`,
      type: "payment_notification_received",
      platformOrderId: order.id,
      providerOrderId: verifiedNotification.providerOrderId || null,
      rawNotificationDigest: notificationDigest,
      signatureValid: verifiedNotification.valid,
      verificationError: verificationError ? "notification_verification_failed" : null,
      provider: "KAIPAY",
      providerStatus: verifiedNotification.status,
      adapterVersion: this.config.adapterVersion
    });
    await this.eventStore.storeEncryptedNotification({
      idempotencyKey: `notification-raw:${order.id}:${notificationDigest}`,
      platformOrderId: order.id,
      providerOrderId: verifiedNotification.providerOrderId || null,
      rawNotification: rawBytes,
      provider: "KAIPAY",
      adapterVersion: this.config.adapterVersion
    });
    let queriedOrder = null;
    if (verifiedNotification.valid) {
      try {
        const queried = await this.client.queryOrder({
          platformOrderId: order.id,
          providerOrderId: requireId(verifiedNotification.providerOrderId, "Kaipay provider order ID")
        });
        queriedOrder = {
          platformOrderId: requireId(queried && queried.platformOrderId, "Queried platform order ID"),
          providerOrderId: requireId(queried && queried.providerOrderId, "Queried Kaipay order ID"),
          amountFen: assertAmountFen(queried && queried.amountFen),
          currency: requireId(queried && queried.currency, "Queried currency"),
          paymentMethod: assertPaymentMethod(queried && queried.paymentMethod),
          status: requireCanonicalStatus(queried && queried.status)
        };
      } catch (_error) {
        this.logger.warn?.("petpack.kaipay.provider_query_failed", { platformOrderId: order.id });
      }
    }
    const reconciliation = reconcileProviderPayment({ order, verifiedNotification, queriedOrder });
    await this.eventStore.appendIdempotent({
      idempotencyKey: `provider-audit:${reconciliation.paymentEventKey}`,
      type: "payment_notification_reconciled",
      platformOrderId: order.id,
      providerOrderId: reconciliation.providerOrderId || verifiedNotification.providerOrderId || null,
      signatureValid: verifiedNotification.valid,
      state: reconciliation.state,
      reason: reconciliation.reason,
      provider: "KAIPAY",
      providerStatus: queriedOrder?.status || verifiedNotification.status,
      adapterVersion: this.config.adapterVersion
    });
    const acknowledgement = normalizeAcknowledgement(await this.notificationProtocol.acknowledge({
      verified: verifiedNotification.valid,
      state: reconciliation.state,
      reason: reconciliation.reason
    }));
    return { ...reconciliation, acknowledgement };
  }

  async refund({ platformOrderId, refundId, amountFen, reason, idempotencyKey }) {
    const order = await this.orderStore.getPaymentOrder(requireId(platformOrderId, "Platform order ID"));
    const request = {
      platformOrderId: requireId(order && order.id, "Platform order ID"),
      providerOrderId: requireId(order && order.providerOrderId, "Kaipay provider order ID"),
      refundId: requireId(refundId, "Refund ID"),
      amountFen: assertAmountFen(amountFen),
      reason: requireId(reason, "Refund reason"),
      idempotencyKey: requireId(idempotencyKey, "Refund idempotency key")
    };
    if (request.amountFen > Number(order.amountFen)) throw new Error("Refund amount cannot exceed the paid order amount");
    const response = await this.client.refund(request);
    await this.eventStore.appendIdempotent({
      idempotencyKey: `refund:${request.idempotencyKey}`,
      type: "refund_requested",
      platformOrderId: request.platformOrderId,
      providerOrderId: request.providerOrderId,
      refundId: request.refundId,
      amountFen: request.amountFen,
      provider: "KAIPAY",
      adapterVersion: this.config.adapterVersion
    });
    return { ...response, state: PAYMENT_STATES.REFUND_PENDING };
  }
}

module.exports = {
  ADAPTER_VERSION_PATTERN,
  KaipayPaymentProvider,
  PAYMENT_METHODS,
  assertKaipayRuntimeConfig,
  createCheckoutRequest,
  createServerNotificationUrl,
  createServerReturnUrl,
  digestNotification,
  loadKaipayConfig,
  normalizeAcknowledgement,
  requireRawNotification,
  requireCanonicalStatus,
  validateCredentialsJson
};
