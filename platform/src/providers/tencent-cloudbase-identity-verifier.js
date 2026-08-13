const DEFAULT_CLOUDBASE_AUTH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CLOUDBASE_ENV_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const PROVIDER_SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,255}$/;
const MAINLAND_PHONE_PATTERN = /^\+86 1[3-9][0-9]{9}$/;
const SAFE_DIAGNOSTIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("CloudBase auth timeout is invalid");
  }
  return parsed;
}

function exactHttpsOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw new Error(`${label} is invalid`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an exact HTTPS origin`);
  }
  return parsed.origin;
}

function loadTencentCloudBaseAuthConfig(environment = process.env) {
  const environmentId = requiredString(environment.CLOUDBASE_ENV_ID, "CloudBase environment ID");
  if (!CLOUDBASE_ENV_ID_PATTERN.test(environmentId)) throw new Error("CloudBase environment ID is invalid");
  const region = requiredString(environment.CLOUDBASE_REGION, "CloudBase region");
  if (region !== "ap-shanghai") throw new Error("CloudBase SMS login requires ap-shanghai");
  const defaultOrigin = `https://${environmentId}.api.tcloudbasegateway.com`;
  const baseUrl = exactHttpsOrigin(environment.CLOUDBASE_AUTH_BASE_URL || defaultOrigin, "CloudBase auth base URL");
  const expectedHostname = `${environmentId}.api.tcloudbasegateway.com`;
  if (new URL(baseUrl).hostname !== expectedHostname) {
    throw new Error("CloudBase auth base URL does not match the configured environment");
  }
  return {
    environmentId,
    region,
    baseUrl,
    timeoutMs: boundedInteger(environment.CLOUDBASE_AUTH_TIMEOUT_MS, DEFAULT_CLOUDBASE_AUTH_TIMEOUT_MS, 1_000, 20_000)
  };
}

function requireAccessToken(value) {
  if (typeof value !== "string" || value.length < 24 || value.length > 16_384 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error("CloudBase access token is invalid");
  }
  return value;
}

function normalizeMainlandPhone(value) {
  if (typeof value !== "string") throw new Error("CloudBase identity is not phone verified");
  const normalized = value.trim().replace(/^\+86\s?/, "+86 ");
  if (!MAINLAND_PHONE_PATTERN.test(normalized)) throw new Error("CloudBase identity is not phone verified");
  return normalized;
}

function parseProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CloudBase profile response is invalid");
  const subject = typeof value.sub === "string" ? value.sub.trim() : "";
  if (!PROVIDER_SUBJECT_PATTERN.test(subject)) throw new Error("CloudBase profile subject is invalid");
  if (Object.prototype.hasOwnProperty.call(value, "status") && value.status !== "ACTIVE") {
    throw new Error("CloudBase identity is not active");
  }
  normalizeMainlandPhone(value.phone_number);
  return Object.freeze({ provider: "TENCENT_CLOUDBASE", subject, phoneVerified: true });
}

function safeDiagnosticString(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return SAFE_DIAGNOSTIC_PATTERN.test(normalized) ? normalized : undefined;
}

function responseDiagnostic(response) {
  const contentType = safeDiagnosticString((response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase());
  const requestId = safeDiagnosticString(
    response.headers.get("x-request-id") || response.headers.get("x-tcb-request-id") || ""
  );
  return {
    httpStatus: response.status,
    ...(contentType ? { contentType } : {}),
    ...(requestId ? { requestId } : {})
  };
}

function providerErrorDiagnostic(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const providerCode = safeDiagnosticString(payload.error_code || payload.code || payload.error);
  return providerCode ? { providerCode } : {};
}

class TencentCloudBaseIdentityVerifier {
  constructor({ environmentId, baseUrl, timeoutMs = DEFAULT_CLOUDBASE_AUTH_TIMEOUT_MS, fetchImpl = globalThis.fetch, logger = console } = {}) {
    this.environmentId = requiredString(environmentId, "CloudBase environment ID");
    if (!CLOUDBASE_ENV_ID_PATTERN.test(this.environmentId)) throw new Error("CloudBase environment ID is invalid");
    this.baseUrl = exactHttpsOrigin(baseUrl, "CloudBase auth base URL");
    if (new URL(this.baseUrl).hostname !== `${this.environmentId}.api.tcloudbasegateway.com`) {
      throw new Error("CloudBase auth base URL does not match the configured environment");
    }
    this.timeoutMs = boundedInteger(timeoutMs, DEFAULT_CLOUDBASE_AUTH_TIMEOUT_MS, 1_000, 20_000);
    if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
    this.fetchImpl = fetchImpl;
    this.logger = logger;
  }

  async verifyAccessToken(accessToken) {
    const token = requireAccessToken(accessToken);
    const url = new URL("/auth/v1/user/me", this.baseUrl);
    url.searchParams.set("client_id", this.environmentId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let diagnostic = { stage: "request" };
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal
      });
      diagnostic = { stage: "response", ...responseDiagnostic(response) };
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("CloudBase profile response is too large");
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        throw new Error("CloudBase profile response is invalid");
      }
      diagnostic = { ...diagnostic, ...providerErrorDiagnostic(payload) };
      if (!response.ok || !(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
        throw new Error("CloudBase access token was rejected");
      }
      diagnostic = {
        ...diagnostic,
        stage: "profile",
        hasSubject: typeof payload?.sub === "string",
        hasStatus: typeof payload?.status === "string",
        hasPhoneNumber: typeof payload?.phone_number === "string"
      };
      return parseProfile(payload);
    } catch (error) {
      this.logger.warn?.("petpack.auth.cloudbase_verification_failed", {
        ...diagnostic,
        errorName: error && error.name ? error.name : "Error"
      });
      if (error && error.name === "AbortError") throw new Error("CloudBase identity verification timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = {
  CLOUDBASE_ENV_ID_PATTERN,
  DEFAULT_CLOUDBASE_AUTH_TIMEOUT_MS,
  TencentCloudBaseIdentityVerifier,
  loadTencentCloudBaseAuthConfig,
  normalizeMainlandPhone,
  parseProfile,
  providerErrorDiagnostic,
  requireAccessToken
};
