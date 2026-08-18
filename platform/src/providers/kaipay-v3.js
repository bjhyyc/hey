const crypto = require("node:crypto");

const KAIPAY_V3_ADAPTER_VERSION = "kaipay-pay-api-v3-hmac-sha256/1";
const KAIPAY_OFFICIAL_API_ORIGIN = "https://api.kaipay.cn";
const KAIPAY_CHANNELS = Object.freeze(["ALIPAY", "WXPAY"]);
const KAIPAY_CHANNEL_CONFIG = Object.freeze({
  ALIPAY: Object.freeze({
    provider: "alipay",
    payMethod: "alipay",
    allowedScenes: Object.freeze(["web", "native"]),
    defaultScene: "web"
  }),
  WXPAY: Object.freeze({
    provider: "wechat",
    payMethod: "wechat",
    allowedScenes: Object.freeze(["native"]),
    defaultScene: "native"
  })
});
const KAIPAY_PROVIDER_ROUTES = Object.freeze({
  alipay: Object.freeze({
    alipay: Object.freeze(["web", "native"])
  }),
  wechat: Object.freeze({
    wechat: Object.freeze(["native"])
  }),
  fuyou: Object.freeze({
    alipay: Object.freeze(["native"]),
    wechat: Object.freeze(["native"])
  })
});
const MAX_RESPONSE_BYTES = 1024 * 1024;

function requiredString(value, label, { maxLength = 4096, preserve = false } = {}) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\u0000")) {
    throw new Error(`${label} is invalid`);
  }
  return preserve ? value : value.trim();
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertExactKeys(value, allowed, label) {
  const keys = Object.keys(requirePlainObject(value, label));
  if (keys.some((key) => !allowed.includes(key))) throw new Error(`${label} contains an unsupported field`);
  return value;
}

function normalizeApiBaseUrl(value, { production = false } = {}) {
  let parsed;
  try {
    parsed = new URL(requiredString(value, "Kaipay API base URL", { maxLength: 2048 }));
  } catch (_error) {
    throw new Error("Kaipay API base URL must be an HTTPS origin");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.search || parsed.pathname !== "/") {
    throw new Error("Kaipay API base URL must be an HTTPS origin");
  }
  if (production && parsed.origin !== KAIPAY_OFFICIAL_API_ORIGIN) {
    throw new Error("Production Kaipay API base URL must use the official domestic gateway");
  }
  return `${parsed.origin}/`;
}

function normalizePaymentChannel(value) {
  const channel = String(value || "").trim().toUpperCase();
  if (!KAIPAY_CHANNELS.includes(channel)) throw new Error("Kaipay payment channel must be ALIPAY or WXPAY");
  return channel;
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!Object.hasOwn(KAIPAY_PROVIDER_ROUTES, provider)) {
    throw new Error("Kaipay provider is unsupported by this website");
  }
  return provider;
}

function normalizePayMethod(value) {
  const payMethod = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(payMethod)) throw new Error("Kaipay pay method is invalid");
  return payMethod;
}

function normalizeScene(channelValue, sceneValue, route = {}) {
  const channel = normalizePaymentChannel(channelValue);
  const config = KAIPAY_CHANNEL_CONFIG[channel];
  const provider = normalizeProvider(route.provider || config.provider);
  const payMethod = normalizePayMethod(route.payMethod || config.payMethod);
  const scene = String(sceneValue || config.defaultScene).trim().toLowerCase();
  const allowedScenes = KAIPAY_PROVIDER_ROUTES[provider]?.[payMethod] || [];
  if (payMethod !== config.payMethod || !allowedScenes.includes(scene)) {
    throw new Error(`Kaipay ${channel} provider/payMethod/scene route is unsupported by this website`);
  }
  return scene;
}

function normalizeChannelRoute(channelValue, route = {}) {
  const channel = normalizePaymentChannel(channelValue);
  const defaults = KAIPAY_CHANNEL_CONFIG[channel];
  const provider = normalizeProvider(route.provider || defaults.provider);
  const payMethod = normalizePayMethod(route.payMethod || defaults.payMethod);
  const scene = normalizeScene(channel, route.scene || defaults.defaultScene, { provider, payMethod });
  return Object.freeze({ paymentChannel: channel, provider, payMethod, scene });
}

function routeForChannel(config, channelValue) {
  const channel = normalizePaymentChannel(channelValue);
  const isAlipay = channel === "ALIPAY";
  return normalizeChannelRoute(channel, {
    provider: isAlipay ? config?.alipayProvider : config?.wechatProvider,
    payMethod: isAlipay ? config?.alipayPayMethod : config?.wechatPayMethod,
    scene: isAlipay ? config?.alipayScene : config?.wechatScene
  });
}

function providerForChannel(channelValue, config) {
  return routeForChannel(config, channelValue).provider;
}

function credentialVersionFor({ apiKey, apiSecret }) {
  return `kpv3-${crypto.createHash("sha256").update(apiKey).update("\u0000").update(apiSecret).digest("hex")}`;
}

function normalizeCredential(value, label) {
  assertExactKeys(value, ["apiKey", "apiSecret"], label);
  const apiKey = requiredString(value.apiKey, `${label} API Key`, { maxLength: 256 });
  const apiSecret = requiredString(value.apiSecret, `${label} API Secret`, { maxLength: 2048, preserve: true });
  if (!/^[A-Za-z0-9._-]{8,256}$/.test(apiKey) || apiSecret.length < 16 || /[\u0000-\u001f\u007f]/.test(apiSecret)) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze({ apiKey, apiSecret, credentialVersion: credentialVersionFor({ apiKey, apiSecret }) });
}

function parseV3Credentials(credentialsJson) {
  const text = requiredString(credentialsJson, "Kaipay credentials JSON", { maxLength: 128 * 1024, preserve: true });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    throw new Error("KAIPAY_CREDENTIALS_JSON is invalid");
  }
  assertExactKeys(parsed, ["active", "previous"], "KAIPAY_CREDENTIALS_JSON");
  const active = normalizeCredential(parsed.active, "Kaipay active credential");
  const previousValues = parsed.previous === undefined ? [] : parsed.previous;
  if (!Array.isArray(previousValues) || previousValues.length > 8) {
    throw new Error("KAIPAY_CREDENTIALS_JSON previous credentials are invalid");
  }
  const previous = previousValues.map((entry, index) => normalizeCredential(entry, `Kaipay previous credential ${index + 1}`));
  const all = [active, ...previous];
  if (new Set(all.map((entry) => entry.credentialVersion)).size !== all.length) {
    throw new Error("KAIPAY_CREDENTIALS_JSON contains a duplicate credential");
  }
  return Object.freeze({ active, previous: Object.freeze(previous), all: Object.freeze(all) });
}

function getCredential(credentials, credentialVersion) {
  const version = requiredString(credentialVersion, "Kaipay credential version", { maxLength: 128 });
  const credential = credentials.all.find((entry) => entry.credentialVersion === version);
  if (!credential) throw new Error("The Kaipay credential used by this order is unavailable");
  return credential;
}

function boundedTimeout(value) {
  const parsed = value === undefined || value === "" ? 15_000 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new Error("Kaipay request timeout must be between 1000 and 60000 milliseconds");
  }
  return parsed;
}

function moneyFromFen(amountFen) {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0 || amountFen > 10_000_000_000) {
    throw new Error("Kaipay amountFen is invalid");
  }
  return Number((amountFen / 100).toFixed(2));
}

function fenFromAmount(value, label = "Kaipay amount") {
  const normalized = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(normalized)) throw new Error(`${label} is invalid`);
  const [yuan, decimal = ""] = normalized.split(".");
  const fen = Number(yuan) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(fen) || fen <= 0) throw new Error(`${label} is invalid`);
  return fen;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256Hex(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function normalizeSignedPath(value) {
  const path = requiredString(value, "Kaipay signed path", { maxLength: 4096, preserve: true });
  if (!path.startsWith("/pay/api/v3/") || path.includes("#") || /[\r\n]/.test(path)) {
    throw new Error("Kaipay signed path is invalid");
  }
  return path;
}

function createRequestSignature({ method, pathWithQuery, timestamp, nonce, bodyBytes, apiSecret }) {
  const safeMethod = String(method || "").trim().toUpperCase();
  if (!["GET", "POST"].includes(safeMethod)) throw new Error("Kaipay request method is invalid");
  const safePath = normalizeSignedPath(pathWithQuery);
  const safeTimestamp = String(timestamp || "");
  const safeNonce = requiredString(nonce, "Kaipay request nonce", { maxLength: 128 });
  if (!/^[0-9]{10}$/.test(safeTimestamp) || safeNonce.length < 8 || /[\r\n]/.test(safeNonce)) {
    throw new Error("Kaipay request signature inputs are invalid");
  }
  const body = Buffer.isBuffer(bodyBytes) ? bodyBytes : Buffer.from(bodyBytes || "", "utf8");
  const bodySha256 = sha256Hex(body);
  const canonicalText = [safeMethod, safePath, safeTimestamp, safeNonce, bodySha256].join("\n");
  return Object.freeze({ bodySha256, signature: hmacSha256Hex(apiSecret, canonicalText), canonicalText });
}

function normalizeResponseStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "succeeded") return "PAID";
  if (status === "requires_action") return "PENDING";
  if (["canceled", "expired"].includes(status)) return "EXPIRED";
  if (status === "failed") return "FAILED";
  if (status === "refunded") return "REFUNDED";
  throw new Error("Kaipay returned an unknown V3 order status");
}

function hasFuyouPaidEvidenceWithoutActualAmount(data, expectedProvider) {
  if (expectedProvider !== "fuyou" || (data?.actualAmount !== undefined && data.actualAmount !== null)) return false;
  if (String(data.rawStatus || "").trim().toLowerCase() !== "paid") return false;
  const providerStatus = new Map(String(data.providerStatus || "").split(",").map((entry) => {
    const separator = entry.indexOf("=");
    return separator > 0
      ? [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]
      : [entry.trim(), ""];
  }));
  if (providerStatus.get("result_code") !== "000000" || providerStatus.get("trans_stat") !== "SUCCESS") return false;
  if (!requiredString(data.providerOrderNo, "Queried Fuyou order ID", { maxLength: 100 })) return false;
  const paidAt = Date.parse(requiredString(data.paidAt, "Queried Fuyou paid time", { maxLength: 64 }));
  return Number.isFinite(paidAt);
}

function requireHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(requiredString(value, label, { maxLength: 8192 }));
  } catch (_error) {
    throw new Error(`${label} is invalid`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error(`${label} is invalid`);
  return parsed.toString();
}

function normalizeNextAction(value, { topLevel = {}, expectedType } = {}) {
  const action = requirePlainObject(value, "Kaipay nextAction");
  const type = requiredString(action.type, "Kaipay nextAction type", { maxLength: 32 }).toLowerCase();
  if (expectedType && ![expectedType, "retry", "none"].includes(type)) {
    throw new Error("Kaipay nextAction does not match the requested payment scene");
  }
  if (type === "redirect") {
    return Object.freeze({ type, url: requireHttpsUrl(action.url, "Kaipay redirect URL") });
  }
  if (type === "qr_code") {
    const qrCode = typeof action.qrCode === "string" && action.qrCode.length <= 8192 && action.qrCode.trim()
      ? action.qrCode
      : "";
    const imageCandidate = action.qrCodeImageUrl || topLevel.qrCodeImageUrl;
    let qrCodeImageUrl = "";
    if (imageCandidate) {
      try {
        qrCodeImageUrl = requireHttpsUrl(imageCandidate, "Kaipay QR image URL");
      } catch (error) {
        if (!qrCode) throw error;
      }
    }
    if (!qrCode && !qrCodeImageUrl) throw new Error("Kaipay QR action is incomplete");
    return Object.freeze({ type, ...(qrCode ? { qrCode } : {}), ...(qrCodeImageUrl ? { qrCodeImageUrl } : {}) });
  }
  if (["retry", "poll"].includes(type)) {
    const seconds = Number(action.retryAfterSeconds);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("Kaipay retry interval is invalid");
    const message = typeof action.message === "string" && action.message.trim()
      ? action.message.trim().slice(0, 256)
      : undefined;
    return Object.freeze({ type, retryAfterSeconds: seconds, ...(message ? { message } : {}) });
  }
  if (type === "none") return Object.freeze({ type });
  throw new Error("Kaipay returned an unsupported nextAction for this website");
}

function requireV3Data(value, label) {
  const data = requirePlainObject(value, label);
  if (data.apiVersion !== "v3") throw new Error(`${label} API version is invalid`);
  return data;
}

async function readBoundedJsonResponse(response, operation) {
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error(`Kaipay ${operation} response is too large`);
  const text = await response.text();
  if (Buffer.byteLength(text || "", "utf8") > MAX_RESPONSE_BYTES) throw new Error(`Kaipay ${operation} response is too large`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    const error = new Error(`Kaipay ${operation} response was invalid`);
    error.code = "kaipay_response_invalid";
    throw error;
  }
  requirePlainObject(parsed, `Kaipay ${operation} response`);
  if (!response.ok) {
    const error = new Error(`Kaipay ${operation} transport response was rejected`);
    error.code = "kaipay_response_error";
    throw error;
  }
  if (Number(parsed.code) !== 0) {
    const error = new Error(`Kaipay ${operation} was not accepted`);
    error.code = "kaipay_business_error";
    error.providerCode = Number.isSafeInteger(Number(parsed.code)) ? Number(parsed.code) : null;
    throw error;
  }
  return requireV3Data(parsed.data, `Kaipay ${operation} data`);
}

class KaipayV3Client {
  constructor({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), nonceFactory = () => crypto.randomBytes(16).toString("hex") } = {}) {
    if (!config || typeof config !== "object") throw new Error("Kaipay V3 configuration is required");
    this.mode = config.mode || "development";
    this.apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl, { production: this.mode === "production" });
    this.credentials = parseV3Credentials(config.credentialsJson);
    this.selectedMerchantCode = typeof config.selectedMerchantCode === "string" ? config.selectedMerchantCode.trim() : "";
    if (this.selectedMerchantCode && !/^[A-Za-z0-9._-]{1,128}$/.test(this.selectedMerchantCode)) {
      throw new Error("KAIPAY_SELECTED_MERCHANT_CODE is invalid");
    }
    this.channelRoutes = Object.freeze({
      ALIPAY: routeForChannel(config, "ALIPAY"),
      WXPAY: routeForChannel(config, "WXPAY")
    });
    this.channelScenes = Object.freeze({
      ALIPAY: this.channelRoutes.ALIPAY.scene,
      WXPAY: this.channelRoutes.WXPAY.scene
    });
    this.timeoutMs = boundedTimeout(config.requestTimeoutMs);
    if (typeof fetchImpl !== "function" || typeof now !== "function" || typeof nonceFactory !== "function") {
      throw new Error("Kaipay V3 runtime dependencies are invalid");
    }
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.nonceFactory = nonceFactory;
  }

  async _request({ method, pathWithQuery, body, credentialVersion, operation }) {
    const credential = credentialVersion
      ? getCredential(this.credentials, credentialVersion)
      : this.credentials.active;
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const bodyBytes = Buffer.from(bodyText, "utf8");
    const timestamp = String(Math.floor(Number(this.now()) / 1000));
    const nonce = requiredString(this.nonceFactory(), "Kaipay request nonce", { maxLength: 128 });
    const signed = createRequestSignature({ method, pathWithQuery, timestamp, nonce, bodyBytes, apiSecret: credential.apiSecret });
    const target = new URL(normalizeSignedPath(pathWithQuery), this.apiBaseUrl);
    const headers = {
      accept: "application/json",
      "X-API-Key": credential.apiKey,
      "X-KPay-Timestamp": timestamp,
      "X-KPay-Nonce": nonce,
      "X-KPay-Body-SHA256": signed.bodySha256,
      "X-KPay-Signature-Method": "HMAC-SHA256",
      "X-KPay-Signature": signed.signature
    };
    if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let responseReceived = false;
    try {
      response = await this.fetchImpl(target.toString(), {
        method,
        headers,
        ...(body !== undefined ? { body: bodyText } : {}),
        redirect: "manual",
        signal: controller.signal
      });
      responseReceived = true;
      return await readBoundedJsonResponse(response, operation);
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        const timeoutError = new Error(`Kaipay ${operation} timed out`);
        timeoutError.code = "kaipay_timeout";
        throw timeoutError;
      }
      // Once an HTTP response exists, response-size, JSON, identity and
      // business-contract failures are authoritative adapter failures rather
      // than network failures. Preserve their safe messages and categories.
      if (responseReceived) throw error;
      if (error?.code) throw error;
      const transportError = new Error(`Kaipay ${operation} transport failed`);
      transportError.code = "kaipay_transport_error";
      throw transportError;
    } finally {
      clearTimeout(timer);
    }
  }

  async getCapabilities({ credentialVersion } = {}) {
    return this._request({
      method: "GET",
      pathWithQuery: "/pay/api/v3/capabilities",
      credentialVersion,
      operation: "capabilities query"
    });
  }

  async createCheckout(request) {
    const platformOrderId = requiredString(request?.platformOrderId, "Platform order ID", { maxLength: 100 });
    const paymentChannel = normalizePaymentChannel(request?.paymentChannel);
    const configuredRoute = this.channelRoutes[paymentChannel];
    const route = normalizeChannelRoute(paymentChannel, {
      provider: request?.providerCode || configuredRoute.provider,
      payMethod: request?.payMethod || configuredRoute.payMethod,
      scene: request?.scene || configuredRoute.scene
    });
    const { provider, payMethod, scene } = route;
    const credentialVersion = request?.credentialVersion
      ? getCredential(this.credentials, request.credentialVersion).credentialVersion
      : this.credentials.active.credentialVersion;
    const payload = {
      merchantOrderNo: platformOrderId,
      amount: moneyFromFen(request?.amountFen),
      provider,
      scene,
      ...(provider === "fuyou" ? { payMethod } : {}),
      productName: requiredString(request?.subject, "Kaipay product name", { maxLength: 256 }),
      productDesc: requiredString(request?.description || request?.subject, "Kaipay product description", { maxLength: 512 }),
      notifyUrl: requireHttpsUrl(request?.notifyUrl, "Kaipay notification URL"),
      ...(scene === "web" ? { returnUrl: requireHttpsUrl(request?.returnUrl, "Kaipay return URL") } : {}),
      ...(this.selectedMerchantCode ? { selectedMerchantCode: this.selectedMerchantCode } : {}),
      payer: {}
    };
    const data = await this._request({
      method: "POST",
      pathWithQuery: "/pay/api/v3/order/create",
      body: payload,
      credentialVersion,
      operation: "checkout"
    });
    const providerOrderId = requiredString(data.orderNo, "Kaipay provider order ID", { maxLength: 100 });
    if (requiredString(data.merchantOrderNo, "Kaipay merchant order ID", { maxLength: 100 }) !== platformOrderId ||
        fenFromAmount(data.amount, "Kaipay checkout amount") !== request.amountFen || data.currency !== "CNY" ||
        data.provider !== provider ||
        (data.payMethod !== undefined && data.payMethod !== null && data.payMethod !== payMethod) ||
        data.scene !== scene) {
      throw new Error("Kaipay checkout identity does not match the request");
    }
    const status = normalizeResponseStatus(data.status);
    const expectedType = scene === "web" ? "redirect" : "qr_code";
    const nextAction = normalizeNextAction(data.nextAction, { topLevel: data, expectedType: status === "PENDING" ? expectedType : undefined });
    return Object.freeze({
      providerOrderId,
      paymentChannel,
      providerCode: provider,
      payMethod,
      scene,
      credentialVersion,
      status,
      nextAction
    });
  }

  async queryOrder({ platformOrderId, providerOrderId, credentialVersion, paymentChannel, providerCode, payMethod, scene }) {
    const expectedPlatformOrderId = requiredString(platformOrderId, "Platform order ID", { maxLength: 100 });
    const expectedProviderOrderId = requiredString(providerOrderId, "Kaipay provider order ID", { maxLength: 100 });
    const expectedChannel = normalizePaymentChannel(paymentChannel);
    const configuredRoute = this.channelRoutes[expectedChannel];
    const expectedRoute = normalizeChannelRoute(expectedChannel, {
      provider: providerCode || configuredRoute.provider,
      payMethod: payMethod || configuredRoute.payMethod,
      scene: scene || configuredRoute.scene
    });
    const expectedProvider = expectedRoute.provider;
    const expectedPayMethod = expectedRoute.payMethod;
    const expectedScene = expectedRoute.scene;
    const pathWithQuery = `/pay/api/v3/order/query?orderNo=${encodeURIComponent(expectedProviderOrderId)}`;
    const data = await this._request({ method: "GET", pathWithQuery, credentialVersion, operation: "order query" });
    const status = normalizeResponseStatus(data.status);
    if (requiredString(data.orderNo, "Queried Kaipay order ID", { maxLength: 100 }) !== expectedProviderOrderId ||
        requiredString(data.merchantOrderNo, "Queried platform order ID", { maxLength: 100 }) !== expectedPlatformOrderId ||
        fenFromAmount(data.amount, "Queried Kaipay amount") <= 0 || data.currency !== "CNY" ||
        data.provider !== expectedProvider ||
        (data.payMethod !== undefined && data.payMethod !== null && data.payMethod !== expectedPayMethod) ||
        data.scene !== expectedScene) {
      throw new Error("Kaipay order query identity does not match the request");
    }
    const amountFen = fenFromAmount(data.amount, "Queried Kaipay amount");
    if (status === "PAID") {
      const actualAmountMissing = data.actualAmount === undefined || data.actualAmount === null;
      if (actualAmountMissing) {
        if (!hasFuyouPaidEvidenceWithoutActualAmount(data, expectedProvider)) {
          throw new Error("Kaipay order query actual amount does not match the order");
        }
      } else if (fenFromAmount(data.actualAmount, "Queried Kaipay actual amount") !== amountFen) {
        throw new Error("Kaipay order query actual amount does not match the order");
      }
    }
    return Object.freeze({
      platformOrderId: expectedPlatformOrderId,
      providerOrderId: expectedProviderOrderId,
      amountFen,
      currency: "CNY",
      paymentMethod: "KAIPAY",
      paymentChannel: expectedChannel,
      providerCode: expectedProvider,
      payMethod: expectedPayMethod,
      scene: expectedScene,
      credentialVersion,
      status,
      nextAction: normalizeNextAction(data.nextAction, {
        topLevel: data,
        expectedType: status === "PENDING" ? (expectedScene === "web" ? "redirect" : "qr_code") : undefined
      })
    });
  }

  async closeOrder({ providerOrderId, credentialVersion, reason = "" } = {}) {
    const orderNo = requiredString(providerOrderId, "Kaipay provider order ID", { maxLength: 100 });
    const normalizedReason = typeof reason === "string" ? reason.trim() : "";
    if (normalizedReason.length > 200 || /[\r\n\u0000]/.test(normalizedReason)) throw new Error("Kaipay close reason is invalid");
    const data = await this._request({
      method: "POST",
      pathWithQuery: "/pay/api/v3/order/close",
      body: { orderNo, ...(normalizedReason ? { reason: normalizedReason } : {}) },
      credentialVersion,
      operation: "order close"
    });
    if (data.orderNo !== orderNo || data.status !== "canceled" || data.nextAction?.type !== "none") {
      throw new Error("Kaipay close response is invalid");
    }
    return Object.freeze({ providerOrderId: orderNo, status: "EXPIRED", idempotentReplay: data.idempotentReplay === true });
  }

  async refund(request) {
    const providerOrderId = requiredString(request?.providerOrderId, "Kaipay provider order ID", { maxLength: 100 });
    const refundRequestNo = requiredString(request?.refundId, "Kaipay refund request number", { maxLength: 50 });
    const reason = requiredString(request?.reason, "Kaipay refund reason", { maxLength: 200 });
    const data = await this._request({
      method: "POST",
      pathWithQuery: "/pay/api/v3/order/refund",
      body: { orderNo: providerOrderId, refundAmount: moneyFromFen(request?.amountFen), refundRequestNo, reason },
      credentialVersion: request?.credentialVersion,
      operation: "refund"
    });
    const result = requirePlainObject(data.result, "Kaipay refund result");
    const action = requiredString(result.action, "Kaipay refund action", { maxLength: 32 }).toLowerCase();
    const status = requiredString(result.status, "Kaipay refund status", { maxLength: 32 }).toLowerCase();
    if (data.refundRequestNo !== refundRequestNo || result.requestNo !== refundRequestNo ||
        !["requested", "processing", "refunded", "rejected", "cancelled"].includes(action) ||
        !["pending", "processing", "approved", "rejected", "cancelled"].includes(status)) {
      throw new Error("Kaipay refund response is invalid");
    }
    return Object.freeze({
      providerOrderId,
      refundId: refundRequestNo,
      action,
      providerStatus: status,
      requiresApproval: result.requiresApproval === true,
      idempotentReplay: data.idempotentReplay === true,
      completed: action === "refunded" && status === "approved"
    });
  }
}

function headerValue(headers, name) {
  if (!headers) return "";
  const value = typeof headers.get === "function"
    ? headers.get(name)
    : Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (typeof value !== "string" || !value || /[,\r\n]/.test(value)) throw new Error(`Kaipay webhook ${name} header is invalid`);
  return value;
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

class KaipayV3NotificationProtocol {
  constructor({ config, now = () => Date.now() } = {}) {
    if (!config || typeof config !== "object") throw new Error("Kaipay V3 configuration is required");
    this.credentials = parseV3Credentials(config.credentialsJson);
    if (typeof now !== "function") throw new Error("Kaipay webhook clock is invalid");
    this.now = now;
  }

  async verify(rawNotification, context = {}) {
    const rawBytes = Buffer.isBuffer(rawNotification) ? rawNotification : Buffer.from(rawNotification || "", "utf8");
    if (!rawBytes.length || rawBytes.length > MAX_RESPONSE_BYTES) throw new Error("Kaipay webhook body is invalid");
    const credential = getCredential(this.credentials, context.expectedCredentialVersion);
    const apiVersion = headerValue(context.headers, "X-KPay-API-Version");
    const event = headerValue(context.headers, "X-KPay-Event");
    const timestamp = headerValue(context.headers, "X-KPay-Timestamp");
    const nonce = headerValue(context.headers, "X-KPay-Nonce");
    const signatureMethod = headerValue(context.headers, "X-KPay-Signature-Method");
    const suppliedBodySha = headerValue(context.headers, "X-KPay-Body-SHA256").toLowerCase();
    const suppliedSignature = headerValue(context.headers, "X-KPay-Signature").toLowerCase();
    if (apiVersion !== "v3" || event !== "payment.order.paid" || signatureMethod !== "HMAC-SHA256" ||
        !/^[0-9]{10}$/.test(timestamp) || nonce.length < 8 || nonce.length > 128 || /[\r\n]/.test(nonce)) {
      throw new Error("Kaipay webhook signature metadata is invalid");
    }
    const nowSeconds = Math.floor(Number(this.now()) / 1000);
    if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - Number(timestamp)) > 300) {
      throw new Error("Kaipay webhook timestamp is outside the accepted window");
    }
    const calculatedBodySha = sha256Hex(rawBytes);
    const calculatedSignature = hmacSha256Hex(credential.apiSecret, [timestamp, nonce, event, calculatedBodySha].join("\n"));
    if (!timingSafeHexEqual(calculatedBodySha, suppliedBodySha) || !timingSafeHexEqual(calculatedSignature, suppliedSignature)) {
      throw new Error("Kaipay webhook signature is invalid");
    }
    let body;
    try {
      body = JSON.parse(rawBytes.toString("utf8"));
    } catch (_error) {
      throw new Error("Kaipay webhook JSON is invalid");
    }
    requirePlainObject(body, "Kaipay webhook JSON");
    const platformOrderId = requiredString(body.merchantOrderNo, "Kaipay webhook merchant order ID", { maxLength: 100 });
    const providerOrderId = requiredString(body.orderNo, "Kaipay webhook provider order ID", { maxLength: 100 });
    const providerCode = requiredString(body.provider, "Kaipay webhook provider", { maxLength: 32 }).toLowerCase();
    const payMethod = body.payMethod === undefined
      ? null
      : requiredString(body.payMethod, "Kaipay webhook pay method", { maxLength: 32 }).toLowerCase();
    const scene = body.scene === undefined
      ? null
      : requiredString(body.scene, "Kaipay webhook scene", { maxLength: 32 }).toLowerCase();
    const eventId = requiredString(body.eventId, "Kaipay webhook event ID", { maxLength: 256 });
    const amountFen = fenFromAmount(body.amount, "Kaipay webhook amount");
    const actualAmountFen = fenFromAmount(body.actualAmount, "Kaipay webhook actual amount");
    if (body.apiVersion !== "v3" || body.eventType !== event || body.status !== "paid" || body.currency !== "CNY" ||
        platformOrderId !== context.expectedPlatformOrderId ||
        (context.expectedProviderOrderId && providerOrderId !== context.expectedProviderOrderId) ||
        providerCode !== context.expectedProviderCode ||
        (payMethod !== null && payMethod !== context.expectedPayMethod) ||
        (scene !== null && scene !== context.expectedScene) ||
        (context.expectedAmountFen && (amountFen !== context.expectedAmountFen || actualAmountFen !== context.expectedAmountFen))) {
      throw new Error("Kaipay webhook identity does not match the order");
    }
    return Object.freeze({
      valid: true,
      platformOrderId,
      providerOrderId,
      providerCode,
      payMethod: context.expectedPayMethod || payMethod,
      scene: context.expectedScene || scene,
      eventId,
      amountFen,
      actualAmountFen,
      credentialVersion: credential.credentialVersion,
      status: "PAID"
    });
  }

  async acknowledge({ verified, state, reason } = {}) {
    if (verified === true && state === "paid") {
      return Object.freeze({ status: 204, contentType: "", body: "" });
    }
    if (verified === true && reason === "provider_query_missing") {
      return Object.freeze({ status: 503, contentType: "text/plain; charset=utf-8", body: "retry" });
    }
    return Object.freeze({ status: 400, contentType: "text/plain; charset=utf-8", body: "invalid" });
  }
}

function createKaipayV3Adapters({ config, fetchImpl = globalThis.fetch, now, nonceFactory } = {}) {
  if (config?.adapterVersion !== KAIPAY_V3_ADAPTER_VERSION) {
    throw new Error(`KAIPAY_ADAPTER_VERSION must be ${KAIPAY_V3_ADAPTER_VERSION}`);
  }
  return Object.freeze({
    kaipayClient: new KaipayV3Client({ config, fetchImpl, now, nonceFactory }),
    notificationProtocol: new KaipayV3NotificationProtocol({ config, now })
  });
}

module.exports = {
  KAIPAY_CHANNELS,
  KAIPAY_CHANNEL_CONFIG,
  KAIPAY_OFFICIAL_API_ORIGIN,
  KAIPAY_V3_ADAPTER_VERSION,
  KaipayV3Client,
  KaipayV3NotificationProtocol,
  createKaipayV3Adapters,
  createRequestSignature,
  credentialVersionFor,
  fenFromAmount,
  getCredential,
  hmacSha256Hex,
  moneyFromFen,
  normalizeApiBaseUrl,
  normalizeChannelRoute,
  normalizeNextAction,
  normalizePayMethod,
  normalizePaymentChannel,
  normalizeProvider,
  normalizeResponseStatus,
  normalizeScene,
  parseV3Credentials,
  providerForChannel,
  routeForChannel,
  sha256Hex
};
