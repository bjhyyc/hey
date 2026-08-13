const { PhoneAuthService, createSessionActorResolver } = require("./phone-auth-service");
const { PostgresAuthRepository } = require("../persistence/postgres-auth-repository");
const {
  TencentCloudBaseIdentityVerifier,
  loadTencentCloudBaseAuthConfig
} = require("../providers/tencent-cloudbase-identity-verifier");

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function sessionTtl(environment) {
  const value = Number(environment.PETPACK_SESSION_TTL_SECONDS);
  if (!Number.isSafeInteger(value) || value < 900 || value > 90 * 24 * 60 * 60) {
    throw new Error("Session TTL must be between 15 minutes and 90 days");
  }
  return value;
}

function createCloudBasePhoneAuth({ database, environment = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const providerConfig = loadTencentCloudBaseAuthConfig(environment);
  const cookieName = requiredString(environment.PETPACK_STUDIO_SESSION_COOKIE_NAME, "Session cookie name");
  const repository = new PostgresAuthRepository({ database, logger });
  const identityVerifier = new TencentCloudBaseIdentityVerifier({
    environmentId: providerConfig.environmentId,
    baseUrl: providerConfig.baseUrl,
    timeoutMs: providerConfig.timeoutMs,
    fetchImpl,
    logger
  });
  const authService = new PhoneAuthService({
    identityVerifier,
    repository,
    sessionSigningKey: environment.PETPACK_SESSION_SIGNING_KEY,
    authPolicyVersion: environment.PETPACK_AUTH_POLICY_VERSION,
    sessionTtlSeconds: sessionTtl(environment),
    logger
  });
  const secureSessionCookie = environment.PETPACK_SESSION_COOKIE_SECURE === "true";
  if (environment.PETPACK_PLATFORM_MODE === "production" && !secureSessionCookie) {
    throw new Error("Production phone auth requires secure session cookies");
  }
  return {
    authService,
    cookieName,
    secureSessionCookie,
    resolveActor: createSessionActorResolver({ authService, cookieName })
  };
}

module.exports = { createCloudBasePhoneAuth };
