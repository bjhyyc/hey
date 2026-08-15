const { createCloudBasePhoneAuth } = require("../auth/create-cloudbase-phone-auth");
const { createPetPackStudioHttpApi } = require("../http/petpack-studio-http-api");
const { createNodeHttpServer } = require("../http/node-http-server");
const { createPostgresDatabase } = require("../persistence/postgres-database");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

function boundedPort(value) {
  const parsed = value === undefined || value === "" ? 8787 : Number(value);
  if (!Number.isSafeInteger(parsed) || (parsed !== 0 && parsed < 1_024) || parsed > 65_535) {
    throw new Error("Production PetPack API port must be 0 for a test or between 1024 and 65535");
  }
  return parsed;
}

async function createProductionAuthApiRuntime({ environment = process.env, PoolClass, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  if (hydrated.PETPACK_PLATFORM_MODE !== "production") {
    throw new Error("The production auth runtime requires PETPACK_PLATFORM_MODE=production");
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
      logger
    });
    const httpServer = createNodeHttpServer({
      api,
      host: "0.0.0.0",
      port: boundedPort(hydrated.PETPACK_API_PORT),
      allowNonLoopback: true,
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
