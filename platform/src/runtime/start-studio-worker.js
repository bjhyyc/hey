const { createStudioWorkerRuntime } = require("./create-studio-worker");

async function main({ environment = process.env, logger = console } = {}) {
  const runtime = await createStudioWorkerRuntime({ environment, logger });
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info?.("petpack.studio_worker.stopping", { signal });
    await runtime.close();
  };
  process.once("SIGTERM", () => close("SIGTERM").catch((error) => {
    logger.error?.("petpack.studio_worker.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  process.once("SIGINT", () => close("SIGINT").catch((error) => {
    logger.error?.("petpack.studio_worker.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  const status = await runtime.start();
  return { runtime, status };
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.studio_worker.start_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  });
}

module.exports = { main };
