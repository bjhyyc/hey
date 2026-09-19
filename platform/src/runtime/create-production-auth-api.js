const { createCloudBasePhoneAuth } = require("../auth/create-cloudbase-phone-auth");
const { createPetPackStudioHttpApi } = require("../http/petpack-studio-http-api");
const { createNodeHttpServer } = require("../http/node-http-server");
const { createRequestRateLimiter } = require("../http/request-rate-limiter");
const { createPostgresDatabase } = require("../persistence/postgres-database");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

function boundedPort(value) {
  const parsed = value === undefined || value === "" ? 8787 : Number(value);
  if (!Number.isSafeInteger(parsed) || (parsed !== 0 && parsed < 1_024) || parsed > 65_535) {
    throw new Error("Production PetPack API port must be 0 for a test or between 1024 and 65535");
  }
  return parsed;
}

function optionalRate(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Rate limit settings must be integers");
  return parsed;
}

async function createProductionAuthApiRuntime({ environment = process.env, PoolClass, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  if (hydrated.PETPACK_PLATFORM_MODE !== "production") {
    throw new Error("The production auth runtime requires PETPACK_PLATFORM_MODE=production");
  }
  // This service handles the login exchange - the one route every attacker
  // starts from, and one whose every call costs an outbound request to
  // CloudBase. It used to run with neither the gateway bearer nor a rate
  // limiter, so anyone on the internet could drive it as fast as they liked.
  // The bearer is required, as it is for the studio API: the only legitimate
  // caller is our own gateway, which always presents it.
  const internalBearerToken = typeof hydrated.PETPACK_STUDIO_INTERNAL_TOKEN === "string"
    ? hydrated.PETPACK_STUDIO_INTERNAL_TOKEN
    : "";
  if (internalBearerToken.length < 32 || internalBearerToken.length > 4096 || /[\r\n\u0000]/.test(internalBearerToken)) {
    throw new Error("The production auth runtime requires PETPACK_STUDIO_INTERNAL_TOKEN of 32 to 4096 characters");
  }
  const database = createPostgresDatabase({ environment: hydrated, PoolClass, logger });
  try {
    await database.assertReady();
    const auth = createCloudBasePhoneAuth({ database, environment: hydrated, fetchImpl, logger });
    const api = createPetPackStudioHttpApi({
      authService: auth.authService,
      phoneAuthExchangeEnabled: hydrated.PETPACK_PHONE_AUTH_ENABLED === "true",
      resolveActor: auth.resolveActor,
      sessionCookieName: auth.cookieName,
      secureSessionCookie: true,
      internalBearerToken,
      logger
    });
    const httpServer = createNodeHttpServer({
      api,
      host: "0.0.0.0",
      port: boundedPort(hydrated.PETPACK_API_PORT),
      allowNonLoopback: true,
      rateLimiter: createRequestRateLimiter({
        enabled: hydrated.PETPACK_HTTP_RATE_LIMIT_ENABLED !== "false",
        requestsPerMinute: optionalRate(hydrated.PETPACK_HTTP_RATE_LIMIT_RPM),
        sensitiveRequestsPerMinute: optionalRate(hydrated.PETPACK_HTTP_RATE_LIMIT_SENSITIVE_RPM),
        logger
      }),
      internalBearerToken,
      healthCheck: async () => {
        await database.assertReady();
        return { ready: true };
      },
      logger
    });
    let started = false;
    return {
      async start() {
        const address = await httpServer.start();
        started = true;
        logger.info?.("petpack.production_auth_api.started", { host: address.host, port: address.port });
        return address;
      },
      async close() {
        if (started) await httpServer.close();
        await database.close();
        started = false;
      },
      database
    };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

module.exports = { createProductionAuthApiRuntime };
