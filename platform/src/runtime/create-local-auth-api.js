const { createCloudBasePhoneAuth } = require("../auth/create-cloudbase-phone-auth");
const { createPetPackStudioHttpApi } = require("../http/petpack-studio-http-api");
const { createNodeHttpServer } = require("../http/node-http-server");
const { createPostgresDatabase } = require("../persistence/postgres-database");

function boundedPort(value) {
  const parsed = value === undefined || value === "" ? 8787 : Number(value);
  if (!Number.isSafeInteger(parsed) || (parsed !== 0 && parsed < 1_024) || parsed > 65_535) {
    throw new Error("Local PetPack API port must be 0 for an ephemeral test or between 1024 and 65535");
  }
  return parsed;
}

async function createLocalAuthApiRuntime({ environment = process.env, PoolClass, fetchImpl = globalThis.fetch, logger = console } = {}) {
  if (environment.PETPACK_PLATFORM_MODE === "production") {
    throw new Error("The auth-only local runtime cannot run in production mode");
  }
  const database = createPostgresDatabase({ environment, PoolClass, logger });
  try {
    await database.assertReady();
    const auth = createCloudBasePhoneAuth({ database, environment, fetchImpl, logger });
    const api = createPetPackStudioHttpApi({
      authService: auth.authService,
      resolveActor: auth.resolveActor,
      sessionCookieName: auth.cookieName,
      secureSessionCookie: auth.secureSessionCookie,
      logger
    });
    const httpServer = createNodeHttpServer({
      api,
      host: "127.0.0.1",
      port: boundedPort(environment.PETPACK_LOCAL_API_PORT),
      healthCheck: () => database.assertReady(),
      logger
    });
    let started = false;
    return {
      async start() {
        const address = await httpServer.start();
        started = true;
        logger.info?.("petpack.local_auth_api.started", { host: address.host, port: address.port });
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

module.exports = { createLocalAuthApiRuntime };
