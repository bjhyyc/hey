const { createStudioWorkerRuntime } = require("../runtime/create-studio-worker");
const { createLocalPrivateObjectDriver } = require("../storage/local-private-object-driver");
const {
  buildZeroCostEnvironment,
  createLoopbackOnlyFetch,
  installGracefulShutdown,
  notifyReady,
  safeStartupFailure
} = require("./zero-cost-runtime-support");

async function main({ environment = process.env, logger = console } = {}) {
  const safeEnvironment = buildZeroCostEnvironment(environment, { role: "worker" });
  const driver = await createLocalPrivateObjectDriver({ environment: safeEnvironment, logger });
  let runtime;
  try {
    runtime = await createStudioWorkerRuntime({
      environment: safeEnvironment,
      objectDriver: driver,
      fetchImpl: createLoopbackOnlyFetch(),
      logger
    });
    const close = installGracefulShutdown({
      label: "worker",
      logger,
      close: async () => {
        await runtime.close();
        await driver.close();
      }
    });
    const status = await runtime.start();
    notifyReady({ role: "worker", status });
    return { runtime, driver, status, close };
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    await driver.close().catch(() => undefined);
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.zero_cost.worker.start_failed", safeStartupFailure(error));
    process.exitCode = 1;
  });
}

module.exports = { main };
