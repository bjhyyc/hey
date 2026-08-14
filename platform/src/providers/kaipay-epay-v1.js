const crypto = require("node:crypto");

const KAIPAY_EPAY_V1_ADAPTER_VERSION = "kaipay-epay-v1-md5/1";
const KAIPAY_OFFICIAL_API_ORIGIN = "https://api.kaipay.cn";
const KAIPAY_CHANNELS = Object.freeze(["ALIPAY", "WXPAY"]);
const EPAY_TYPES = Object.freeze({ ALIPAY: "alipay", WXPAY: "wxpay" });
const MAX_RESPONSE_BYTES = 1024 * 1024;

function requiredString(value, label, { maxLength = 4096 } = {}) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\u0000")) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function normalizePaymentChannel(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!KAIPAY_CHANNELS.includes(normalized)) {
    throw new Error("Kaipay payment channel must be ALIPAY or WXPAY");
  }
  return normalized;
}

function paymentChannelFromEpayType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "alipay") return "ALIPAY";
  if (normalized === "wxpay") return "WXPAY";
  throw new Error("Kaipay returned an unsupported payment type");
}

function normalizeMerchantId(value) {
  const normalized = requiredString(value, "Kaipay merchant ID", { maxLength: 32 });
  if (!/^[1-9][0-9]{0,18}$/.test(normalized)) throw new Error("Kaipay merchant ID must be a positive decimal integer");
  return normalized;
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

function parseEpayCredentials(credentialsJson) {
  const text = requiredString(credentialsJson, "Kaipay credentials JSON", { maxLength: 64 * 1024 });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    throw new Error("KAIPAY_CREDENTIALS_JSON is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KAIPAY_CREDENTIALS_JSON is invalid");
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "epayKey") {
    throw new Error("KAIPAY_CREDENTIALS_JSON must contain only epayKey");
  }
  const epayKey = requiredString(parsed.epayKey, "Kaipay EPay key", { maxLength: 512 });
  if (epayKey.length < 8 || /[\u0000-\u001f\u007f]/.test(epayKey)) {
    throw new Error("Kaipay EPay key is invalid");
  }
  return Object.freeze({ epayKey });
}

function normalizeSignableParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("EPay signature parameters are invalid");
  const entries = [];
  for (const [key, rawValue] of Object.entries(params)) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) throw new Error("EPay signature parameter name is invalid");
    if (key === "sign" || key === "sign_type" || rawValue === "" || rawValue === null || rawValue === undefined) continue;
    if (!["string", "number", "boolean"].includes(typeof rawValue)) throw new Error("EPay signature parameter value is invalid");
    const value = String(rawValue);
    if (value.length > 4096 || value.includes("\u0000")) throw new Error("EPay signature parameter value is invalid");
    entries.push([key, value]);
  }
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return entries;
}

function createEpaySigningMaterial(params, epayKey) {
  const secret = requiredString(epayKey, "Kaipay EPay key", { maxLength: 512 });
  return `${normalizeSignableParams(params).map(([key, value]) => `${key}=${value}`).join("&")}${secret}`;
}

function signEpayParams(params, epayKey) {
  return crypto.createHash("md5").update(createEpaySigningMaterial(params, epayKey), "utf8").digest("hex");
}

function verifyEpaySignature(params, epayKey) {
  const supplied = typeof params?.sign === "string" ? params.sign.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{32}$/.test(supplied)) return false;
  const expected = signEpayParams(params, epayKey);
  return crypto.timingSafeEqual(Buffer.from(supplied, "ascii"), Buffer.from(expected, "ascii"));
}

function parseUniqueQuery(rawNotification) {
  const raw = Buffer.isBuffer(rawNotification) ? rawNotification.toString("utf8") : rawNotification;
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES || raw.includes("#")) {
    throw new Error("Kaipay notification query is invalid");
  }
  const query = raw.startsWith("?") ? raw.slice(1) : raw;
  if (!query || /%(?![0-9A-Fa-f]{2})/.test(query)) throw new Error("Kaipay notification query is invalid");
  const search = new URLSearchParams(query);
  const result = Object.create(null);
  let count = 0;
  for (const [key, value] of search.entries()) {
    count += 1;
    if (count > 32 || Object.prototype.hasOwnProperty.call(result, key) || !/^[A-Za-z0-9_]{1,64}$/.test(key) || value.length > 4096) {
      throw new Error("Kaipay notification query is invalid");
    }
    result[key] = value;
  }
  return result;
}

function moneyFromFen(amountFen) {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) throw new Error("Kaipay amountFen must be a positive safe integer");
  return `${Math.floor(amountFen / 100)}.${String(amountFen % 100).padStart(2, "0")}`;
}

function fenFromMoney(value, label = "Kaipay money") {
  const normalized = requiredString(String(value ?? ""), label, { maxLength: 32 });
  if (!/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(normalized)) throw new Error(`${label} is invalid`);
  const [yuan, cents] = normalized.split(".");
  const amount = Number(yuan) * 100 + Number(cents);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`${label} is invalid`);
  return amount;
}

function requireJsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedTimeout(value) {
  const parsed = value === undefined || value === "" ? 15_000 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new Error("Kaipay request timeout must be between 1000 and 60000 milliseconds");
  }
  return parsed;
}

async function fetchJson({ fetchImpl, url, options, timeoutMs, operation }) {
  if (typeof fetchImpl !== "function") throw new Error("Kaipay HTTP transport is unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text;
  try {
    response = await fetchImpl(url, { ...options, signal: controller.signal });
    const declared = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Kaipay response is too large");
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      const timeoutError = new Error(`Kaipay ${operation} timed out`);
      timeoutError.code = "kaipay_timeout";
      throw timeoutError;
    }
    const transportError = new Error(`Kaipay ${operation} transport failed`);
    transportError.code = "kaipay_transport_error";
    throw transportError;
  } finally {
    clearTimeout(timer);
  }
  if (!response || !response.ok || Buffer.byteLength(text || "", "utf8") > MAX_RESPONSE_BYTES) {
    const responseError = new Error(`Kaipay ${operation} response was rejected`);
    responseError.code = "kaipay_response_error";
    throw responseError;
  }
  try {
    return requireJsonObject(JSON.parse(text), `Kaipay ${operation} response`);
  } catch (_error) {
    const parseError = new Error(`Kaipay ${operation} response was invalid`);
    parseError.code = "kaipay_response_invalid";
    throw parseError;
  }
}

function requireHttpsCheckoutUrl(value) {
  let parsed;
  try {
    parsed = new URL(requiredString(value, "Kaipay checkout URL", { maxLength: 4096 }));
  } catch (_error) {
    throw new Error("Kaipay checkout URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("Kaipay checkout URL is invalid");
  return parsed.toString();
}

function mapTradeStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  if (status === "TRADE_SUCCESS") return "PAID";
  if (status === "WAIT_BUYER_PAY") return "PENDING";
  throw new Error("Kaipay returned an unknown trade status");
}

class KaipayEpayV1Client {
  constructor({ config, fetchImpl = globalThis.fetch } = {}) {
    if (!config || typeof config !== "object") throw new Error("Kaipay EPay configuration is required");
    this.mode = config.mode || "development";
    this.merchantId = normalizeMerchantId(config.merchantId);
    this.apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl, { production: this.mode === "production" });
    this.credentials = parseEpayCredentials(config.credentialsJson);
    this.defaultChannel = normalizePaymentChannel(config.defaultChannel || "ALIPAY");
    this.timeoutMs = boundedTimeout(config.requestTimeoutMs);
    this.fetchImpl = fetchImpl;
  }

  async createCheckout(request) {
    const platformOrderId = requiredString(request?.platformOrderId, "Platform order ID", { maxLength: 128 });
    const paymentChannel = normalizePaymentChannel(request?.paymentChannel || this.defaultChannel);
    const params = {
      pid: this.merchantId,
      type: EPAY_TYPES[paymentChannel],
      out_trade_no: platformOrderId,
      notify_url: requiredString(request?.notifyUrl, "Kaipay notification URL", { maxLength: 2048 }),
      return_url: requiredString(request?.returnUrl, "Kaipay return URL", { maxLength: 2048 }),
      name: requiredString(request?.subject, "Kaipay order subject", { maxLength: 256 }),
      money: moneyFromFen(request?.amountFen),
      device: "pc",
      sign_type: "MD5"
    };
    params.sign = signEpayParams(params, this.credentials.epayKey);
    const response = await fetchJson({
      fetchImpl: this.fetchImpl,
      url: new URL("epay/mapi", this.apiBaseUrl).toString(),
      options: {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/json" },
        body: new URLSearchParams(params).toString()
      },
      timeoutMs: this.timeoutMs,
      operation: "checkout"
    });
    if (Number(response.code) !== 1) throw new Error("Kaipay checkout was not accepted");
    const providerOrderId = requiredString(response.trade_no, "Kaipay provider order ID", { maxLength: 128 });
    const checkoutUrl = requireHttpsCheckoutUrl(response.payurl);
    if (response.money !== undefined && fenFromMoney(response.money, "Kaipay checkout money") !== request.amountFen) {
      throw new Error("Kaipay checkout amount does not match the request");
    }
    return Object.freeze({ providerOrderId, checkoutUrl, paymentChannel });
  }

  async queryOrder({ platformOrderId, providerOrderId }) {
    const expectedPlatformOrderId = requiredString(platformOrderId, "Platform order ID", { maxLength: 128 });
    const expectedProviderOrderId = requiredString(providerOrderId, "Kaipay provider order ID", { maxLength: 128 });
    const target = new URL("epay/api", this.apiBaseUrl);
    target.searchParams.set("act", "order");
    target.searchParams.set("pid", this.merchantId);
    target.searchParams.set("key", this.credentials.epayKey);
    target.searchParams.set("out_trade_no", expectedPlatformOrderId);
    const response = await fetchJson({
      fetchImpl: this.fetchImpl,
      url: target.toString(),
      options: { method: "GET", headers: { accept: "application/json" } },
      timeoutMs: this.timeoutMs,
      operation: "order query"
    });
    if (Number(response.code) !== 1) throw new Error("Kaipay order query was not accepted");
    const responseMerchantId = normalizeMerchantId(String(response.pid));
    const responsePlatformOrderId = requiredString(response.out_trade_no, "Queried platform order ID", { maxLength: 128 });
    const responseProviderOrderId = requiredString(response.trade_no, "Queried Kaipay order ID", { maxLength: 128 });
    if (responseMerchantId !== this.merchantId || responsePlatformOrderId !== expectedPlatformOrderId || responseProviderOrderId !== expectedProviderOrderId) {
      throw new Error("Kaipay order query identity does not match the request");
    }
    paymentChannelFromEpayType(response.type);
    return Object.freeze({
      platformOrderId: responsePlatformOrderId,
      providerOrderId: responseProviderOrderId,
      amountFen: fenFromMoney(response.money, "Queried Kaipay money"),
      currency: "CNY",
      paymentMethod: "KAIPAY",
      status: mapTradeStatus(response.trade_status)
    });
  }

  async queryMerchant() {
    const target = new URL("epay/api", this.apiBaseUrl);
    target.searchParams.set("act", "query");
    target.searchParams.set("pid", this.merchantId);
    target.searchParams.set("key", this.credentials.epayKey);
    const response = await fetchJson({
      fetchImpl: this.fetchImpl,
      url: target.toString(),
      options: { method: "GET", headers: { accept: "application/json" } },
      timeoutMs: this.timeoutMs,
      operation: "merchant query"
    });
    if (Number(response.code) !== 1) throw new Error("Kaipay merchant query was not accepted");
    if (normalizeMerchantId(String(response.pid)) !== this.merchantId) {
      throw new Error("Kaipay merchant query identity does not match the configuration");
    }
    requiredString(response.username, "Kaipay merchant username", { maxLength: 256 });
    if (!/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(String(response.money ?? ""))) {
      throw new Error("Kaipay merchant balance was invalid");
    }
    if (Number(response.status) !== 1) throw new Error("Kaipay merchant account is not active");
    return Object.freeze({ ok: true, accountActive: true });
  }

  async refund() {
    const error = new Error("Kaipay EPay V1 refund is not documented and automatic refunds are disabled");
    error.code = "kaipay_refund_protocol_unavailable";
    throw error;
  }
}

class KaipayEpayV1NotificationProtocol {
  constructor({ config } = {}) {
    if (!config || typeof config !== "object") throw new Error("Kaipay EPay configuration is required");
    this.merchantId = normalizeMerchantId(config.merchantId);
    this.credentials = parseEpayCredentials(config.credentialsJson);
  }

  async verify(rawNotification, { expectedMerchantId, expectedPlatformOrderId } = {}) {
    const params = parseUniqueQuery(rawNotification);
    const allowed = new Set(["pid", "trade_no", "out_trade_no", "type", "name", "money", "trade_status", "sign", "sign_type"]);
    if (Object.keys(params).some((key) => !allowed.has(key))) throw new Error("Kaipay notification contains an unsupported field");
    const required = [...allowed];
    if (required.some((key) => typeof params[key] !== "string" || !params[key])) throw new Error("Kaipay notification is incomplete");
    if (params.sign_type.toUpperCase() !== "MD5" || !verifyEpaySignature(params, this.credentials.epayKey)) {
      throw new Error("Kaipay notification signature is invalid");
    }
    const merchantId = normalizeMerchantId(params.pid);
    const platformOrderId = requiredString(params.out_trade_no, "Kaipay notification order ID", { maxLength: 128 });
    if (merchantId !== this.merchantId || merchantId !== String(expectedMerchantId) || platformOrderId !== expectedPlatformOrderId) {
      throw new Error("Kaipay notification identity does not match the order");
    }
    paymentChannelFromEpayType(params.type);
    fenFromMoney(params.money, "Kaipay notification money");
    if (params.trade_status !== "TRADE_SUCCESS") throw new Error("Kaipay notification status is not successful");
    return Object.freeze({
      valid: true,
      merchantId,
      platformOrderId,
      providerOrderId: requiredString(params.trade_no, "Kaipay notification trade number", { maxLength: 128 }),
      status: "PAID"
    });
  }

  async acknowledge({ verified, state, reason } = {}) {
    if (verified === true && state === "paid") {
      return Object.freeze({ status: 200, contentType: "text/plain; charset=utf-8", body: "success" });
    }
    if (verified === true && reason === "provider_query_missing") {
      return Object.freeze({ status: 503, contentType: "text/plain; charset=utf-8", body: "fail" });
    }
    return Object.freeze({ status: 400, contentType: "text/plain; charset=utf-8", body: "fail" });
  }
}

function createKaipayEpayV1Adapters({ config, fetchImpl = globalThis.fetch } = {}) {
  if (config?.adapterVersion !== KAIPAY_EPAY_V1_ADAPTER_VERSION) {
    throw new Error(`KAIPAY_ADAPTER_VERSION must be ${KAIPAY_EPAY_V1_ADAPTER_VERSION}`);
  }
  return Object.freeze({
    kaipayClient: new KaipayEpayV1Client({ config, fetchImpl }),
    notificationProtocol: new KaipayEpayV1NotificationProtocol({ config })
  });
}

module.exports = {
  EPAY_TYPES,
  KAIPAY_CHANNELS,
  KAIPAY_EPAY_V1_ADAPTER_VERSION,
  KAIPAY_OFFICIAL_API_ORIGIN,
  KaipayEpayV1Client,
  KaipayEpayV1NotificationProtocol,
  createEpaySigningMaterial,
  createKaipayEpayV1Adapters,
  fenFromMoney,
  mapTradeStatus,
  moneyFromFen,
  normalizeApiBaseUrl,
  normalizeMerchantId,
  normalizePaymentChannel,
  paymentChannelFromEpayType,
  parseEpayCredentials,
  parseUniqueQuery,
  signEpayParams,
  verifyEpaySignature
};
