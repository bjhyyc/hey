const { createStudioApiRuntime } = require("../runtime/create-studio-api");
const { createLocalPrivateObjectDriver } = require("../storage/local-private-object-driver");
const {
  buildZeroCostEnvironment,
  createLoopbackOnlyFetch,
  installGracefulShutdown,
  notifyReady,
  safeStartupFailure
} = require("./zero-cost-runtime-support");

async function main({ environment = process.env, logger = console } = {}) {
  const safeEnvironment = buildZeroCostEnvironment(environment, { role: "api" });
  const driver = await createLocalPrivateObjectDriver({ environment: safeEnvironment, logger });
  let runtime;
  try {
    runtime = await createStudioApiRuntime({
      environment: safeEnvironment,
      objectDriver: driver,
      fetchImpl: createLoopbackOnlyFetch(),
      logger
    });
    const close = installGracefulShutdown({
      label: "api",
      logger,
      close: async () => {
        await runtime.close();
        await driver.close();
      }
    });
    const address = await runtime.start();
    notifyReady({ role: "api", address });
    return { runtime, driver, address, close };
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    await driver.close().catch(() => undefined);
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.zero_cost.api.start_failed", safeStartupFailure(error));
    process.exitCode = 1;
  });
}

module.exports = { main };
