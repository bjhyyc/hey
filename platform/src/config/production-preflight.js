const { loadModelRegistry } = require("./model-registry");
const { loadKaipayConfig } = require("../providers/kaipay-payment-provider");
const { loadTencentCloudBaseAuthConfig } = require("../providers/tencent-cloudbase-identity-verifier");

const REQUIRED_PROBES = Object.freeze([
  "postgres",
  "queue",
  "objectStore",
  "cloudBaseAuth",
  "modelArkEntitlement",
  "kaipayMerchant",
  "legacyPaymentDrain",
  "sourcePhotoInspector",
  "masterImageProcessor",
  "mediaProcessor",
  "petpackValidator"
]);

const SECRET_SETTINGS = Object.freeze([
  "PETPACK_POSTGRES_URL",
  "PETPACK_REDIS_URL",
  "PETPACK_OBJECT_STORE_ACCESS_KEY_ID",
  "PETPACK_OBJECT_STORE_SECRET_ACCESS_KEY",
  "MODELARK_API_KEY",
  "MODELARK_VIDEO_CALLBACK_SECRET",
  "KAIPAY_CREDENTIALS_JSON",
  "PETPACK_PAYMENT_NOTIFICATION_ENCRYPTION_KEY",
  "PETPACK_SESSION_SIGNING_KEY",
  "PETPACK_STUDIO_INTERNAL_TOKEN"
]);

const VERSION_SETTINGS = Object.freeze([
  "PETPACK_AUTH_POLICY_VERSION",
  "PETPACK_ADMIN_BOOTSTRAP_VERSION",
  "PETPACK_SOURCE_PHOTO_POLICY_VERSION",
  "PETPACK_STORAGE_LIFECYCLE_POLICY_VERSION",
  "PETPACK_MEDIA_QA_POLICY_VERSION",
  "PETPACK_MASTER_QA_POLICY_VERSION",
  "PETPACK_MEDIA_PROCESSOR_VERSION",
  "PETPACK_MASTER_IMAGE_PROCESSOR_VERSION",
  "PETPACK_VALIDATOR_BUNDLE_VERSION"
]);

function setting(environment, name) {
  const value = environment && environment[name];
  return typeof value === "string" ? value.trim() : "";
}

function exactHttpsUrl(value, { originOnly = false } = {}) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return false;
    if (originOnly && (parsed.pathname !== "/" || parsed.search)) return false;
    return true;
  } catch (_error) {
    return false;
  }
}

function securePostgresUrl(value) {
  try {
    const parsed = new URL(value);
    return ["postgres:", "postgresql:"].includes(parsed.protocol) &&
      ["require", "verify-ca", "verify-full"].includes(parsed.searchParams.get("sslmode"));
  } catch (_error) {
    return false;
  }
}

function secureRedisUrl(value) {
  try {
    return new URL(value).protocol === "rediss:";
  } catch (_error) {
    return false;
  }
}

function boundedInteger(value, minimum, maximum) {
  if (!/^[1-9][0-9]*$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

function addCheck(checks, missing, id, ok, code, settings = []) {
  const absent = settings.filter((name) => !name.value).map((name) => name.name);
  absent.forEach((name) => missing.add(name));
  checks.push({ id, status: ok ? "pass" : "fail", code: ok ? "ready" : code });
}

/**
 * Validates the production configuration surface without returning values.
 * Secrets, URLs, merchant identifiers, and model endpoint IDs never appear in
 * the report; operators receive only check IDs and missing variable names.
 */
function validateProductionEnvironment(environment = process.env) {
  const checks = [];
  const missing = new Set();

  addCheck(checks, missing, "runtime.production_mode",
    setting(environment, "PETPACK_PLATFORM_MODE") === "production",
    "production_mode_required",
    [{ name: "PETPACK_PLATFORM_MODE", value: setting(environment, "PETPACK_PLATFORM_MODE") }]);

  let modelRegistryReady = true;
  try {
    loadModelRegistry(environment);
  } catch (_error) {
    modelRegistryReady = false;
  }
  const modelSettings = [
    "MODEL_REGISTRY_VERSION", "MODELARK_REGION", "MODELARK_API_KEY",
    "MODELARK_SEEDREAM_ENDPOINT_ID", "MODELARK_SEEDANCE_ENDPOINT_ID",
    "MODELARK_VIDEO_CALLBACK_BASE_URL", "MODELARK_VIDEO_CALLBACK_SECRET"
  ].map((name) => ({ name, value: setting(environment, name) }));
  addCheck(checks, missing, "provider.modelark_registry", modelRegistryReady, "model_registry_invalid", modelSettings);
  addCheck(checks, missing, "provider.modelark_https",
    exactHttpsUrl(setting(environment, "MODELARK_BASE_URL") || "https://ark.cn-beijing.volces.com/api/v3"),
    "modelark_https_required");
  addCheck(checks, missing, "provider.modelark_callback_https",
    exactHttpsUrl(setting(environment, "MODELARK_VIDEO_CALLBACK_BASE_URL")),
    "modelark_callback_https_required");
  addCheck(checks, missing, "provider.video_resolution",
    setting(environment, "MODELARK_VIDEO_RESOLUTION") === "480p",
    "video_resolution_must_be_480p",
    [{ name: "MODELARK_VIDEO_RESOLUTION", value: setting(environment, "MODELARK_VIDEO_RESOLUTION") }]);

  let kaipayReady = true;
  try {
    loadKaipayConfig(environment);
  } catch (_error) {
    kaipayReady = false;
  }
  const kaipaySettings = [
    "KAIPAY_CREDENTIALS_JSON", "KAIPAY_ADAPTER_VERSION",
    "KAIPAY_API_BASE_URL", "KAIPAY_NOTIFY_BASE_URL", "KAIPAY_RETURN_BASE_URL",
    "KAIPAY_DEFAULT_CHANNEL", "KAIPAY_ALIPAY_SCENE", "KAIPAY_WECHAT_SCENE",
    "KAIPAY_REQUEST_TIMEOUT_MS"
  ].map((name) => ({ name, value: setting(environment, name) }));
  addCheck(checks, missing, "payment.kaipay_config", kaipayReady, "kaipay_config_invalid", kaipaySettings);
  addCheck(checks, missing, "payment.kaipay_https",
    ["KAIPAY_API_BASE_URL", "KAIPAY_NOTIFY_BASE_URL", "KAIPAY_RETURN_BASE_URL"]
      .every((name) => exactHttpsUrl(setting(environment, name))),
    "kaipay_https_required");
  addCheck(checks, missing, "payment.simulation_disabled",
    setting(environment, "KAIPAY_ALLOW_SIMULATED_PAYMENTS") !== "true",
    "simulated_payments_forbidden");
  const legacyAlipaySettings = [
    "ALIPAY_APP_ID", "ALIPAY_SELLER_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY",
    "ALIPAY_NOTIFY_BASE_URL", "ALIPAY_RETURN_BASE_URL", "ALIPAY_GATEWAY_URL",
    "ALIPAY_ALLOW_SIMULATED_PAYMENTS"
  ];
  addCheck(checks, missing, "payment.legacy_alipay_disabled",
    legacyAlipaySettings.every((name) => !setting(environment, name)),
    "legacy_alipay_configuration_forbidden");

  let cloudBaseReady = true;
  try {
    loadTencentCloudBaseAuthConfig(environment);
  } catch (_error) {
    cloudBaseReady = false;
  }
  const cloudBaseSettings = [
    "CLOUDBASE_ENV_ID", "CLOUDBASE_REGION", "CLOUDBASE_AUTH_BASE_URL",
    "NEXT_PUBLIC_CLOUDBASE_ENV_ID", "NEXT_PUBLIC_CLOUDBASE_REGION",
    "NEXT_PUBLIC_PETPACK_PHONE_AUTH_ENABLED"
  ].map((name) => ({ name, value: setting(environment, name) }));
  addCheck(checks, missing, "identity.cloudbase_phone",
    cloudBaseReady &&
      setting(environment, "CLOUDBASE_ENV_ID") === setting(environment, "NEXT_PUBLIC_CLOUDBASE_ENV_ID") &&
      setting(environment, "CLOUDBASE_REGION") === "ap-shanghai" &&
      setting(environment, "NEXT_PUBLIC_CLOUDBASE_REGION") === "ap-shanghai" &&
      setting(environment, "NEXT_PUBLIC_PETPACK_PHONE_AUTH_ENABLED") === "true",
    "cloudbase_phone_auth_invalid",
    cloudBaseSettings);
  addCheck(checks, missing, "identity.session_policy",
    setting(environment, "PETPACK_SESSION_COOKIE_SECURE") === "true" &&
      boundedInteger(setting(environment, "PETPACK_SESSION_TTL_SECONDS"), 900, 90 * 24 * 60 * 60),
    "session_policy_invalid",
    ["PETPACK_SESSION_COOKIE_SECURE", "PETPACK_SESSION_TTL_SECONDS"]
      .map((name) => ({ name, value: setting(environment, name) })));

  const webSettings = [
    "PETPACK_STUDIO_API_ORIGIN", "PETPACK_STUDIO_WEB_ORIGIN",
    "PETPACK_STUDIO_SESSION_COOKIE_NAME", "PETPACK_STUDIO_PLAN_CODE",
    "PETPACK_STUDIO_INTERNAL_TOKEN"
  ].map((name) => ({ name, value: setting(environment, name) }));
  addCheck(checks, missing, "web.secure_gateway",
    exactHttpsUrl(setting(environment, "PETPACK_STUDIO_API_ORIGIN"), { originOnly: true }) &&
      exactHttpsUrl(setting(environment, "PETPACK_STUDIO_WEB_ORIGIN"), { originOnly: true }) &&
      /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(setting(environment, "PETPACK_STUDIO_SESSION_COOKIE_NAME")) &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(setting(environment, "PETPACK_STUDIO_PLAN_CODE")) &&
      setting(environment, "PETPACK_STUDIO_INTERNAL_TOKEN").length >= 32,
    "web_gateway_invalid",
    webSettings);

  const postgresUrl = setting(environment, "PETPACK_POSTGRES_URL");
  addCheck(checks, missing, "infrastructure.postgres_tls", securePostgresUrl(postgresUrl), "postgres_tls_required",
    [{ name: "PETPACK_POSTGRES_URL", value: postgresUrl }]);
  const redisUrl = setting(environment, "PETPACK_REDIS_URL");
  addCheck(checks, missing, "infrastructure.redis_tls", secureRedisUrl(redisUrl), "redis_tls_required",
    [{ name: "PETPACK_REDIS_URL", value: redisUrl }]);
  const objectStoreSettings = [
    "PETPACK_OBJECT_STORE_ENDPOINT", "PETPACK_OBJECT_STORE_BUCKET", "PETPACK_OBJECT_STORE_REGION",
    "PETPACK_OBJECT_STORE_ACCESS_KEY_ID", "PETPACK_OBJECT_STORE_SECRET_ACCESS_KEY"
  ].map((name) => ({ name, value: setting(environment, name) }));
  addCheck(checks, missing, "infrastructure.private_object_store",
    exactHttpsUrl(setting(environment, "PETPACK_OBJECT_STORE_ENDPOINT")) && objectStoreSettings.every(({ value }) => Boolean(value)),
    "private_object_store_invalid",
    objectStoreSettings);

  const weakSecrets = SECRET_SETTINGS.filter((name) => setting(environment, name).length < 16);
  weakSecrets.forEach((name) => { if (!setting(environment, name)) missing.add(name); });
  checks.push({ id: "security.server_secrets", status: weakSecrets.length ? "fail" : "pass", code: weakSecrets.length ? "server_secret_missing_or_weak" : "ready" });

  const invalidVersions = VERSION_SETTINGS.filter((name) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(setting(environment, name)));
  invalidVersions.forEach((name) => { if (!setting(environment, name)) missing.add(name); });
  checks.push({ id: "policy.versioned_production_decisions", status: invalidVersions.length ? "fail" : "pass", code: invalidVersions.length ? "policy_version_missing_or_invalid" : "ready" });

  addCheck(checks, missing, "policy.delivery_retention",
    boundedInteger(setting(environment, "PETPACK_DELIVERY_RETENTION_DAYS"), 1, 3650),
    "delivery_retention_invalid",
    [{ name: "PETPACK_DELIVERY_RETENTION_DAYS", value: setting(environment, "PETPACK_DELIVERY_RETENTION_DAYS") }]);

  const capacitySettings = [
    ["MODELARK_IMAGE_MAX_CONCURRENT", 1, 1000],
    ["MODELARK_VIDEO_MAX_CONCURRENT", 1, 1000],
    ["PETPACK_MEDIA_WORKER_CONCURRENCY", 1, 1024],
    ["PETPACK_HEAVY_WORKER_CONCURRENCY", 1, 16],
    ["PETPACK_VALIDATOR_CONCURRENCY", 1, 1024],
    ["PETPACK_OUTBOX_DISPATCH_CONCURRENCY", 1, 1024]
  ];
  addCheck(checks, missing, "capacity.explicit_concurrency",
    capacitySettings.every(([name, minimum, maximum]) => boundedInteger(setting(environment, name), minimum, maximum)),
    "capacity_setting_invalid",
    capacitySettings.map(([name]) => ({ name, value: setting(environment, name) })));

  return {
    ok: checks.every((check) => check.status === "pass"),
    checks,
    missing: [...missing].sort()
  };
}

async function runProductionPreflight({ environment = process.env, probes = {} } = {}) {
  const configuration = validateProductionEnvironment(environment);
  const probeChecks = [];
  for (const name of REQUIRED_PROBES) {
    const probe = probes[name];
    if (typeof probe !== "function") {
      probeChecks.push({ id: `probe.${name}`, status: "fail", code: "probe_not_configured" });
      continue;
    }
    try {
      const result = await probe();
      probeChecks.push({
        id: `probe.${name}`,
        status: result && result.ok === true ? "pass" : "fail",
        code: result && result.ok === true ? "ready" : "probe_failed"
      });
    } catch (_error) {
      probeChecks.push({ id: `probe.${name}`, status: "fail", code: "probe_failed" });
    }
  }
  return {
    ok: configuration.ok && probeChecks.every((check) => check.status === "pass"),
    configuration,
    probes: probeChecks
  };
}

module.exports = {
  REQUIRED_PROBES,
  SECRET_SETTINGS,
  VERSION_SETTINGS,
  runProductionPreflight,
  validateProductionEnvironment
};
