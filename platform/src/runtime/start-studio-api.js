const { createStudioApiRuntime } = require("./create-studio-api");

async function main({ environment = process.env, logger = console } = {}) {
  const runtime = await createStudioApiRuntime({ environment, logger });
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info?.("petpack.studio_api.stopping", { signal });
    await runtime.close();
  };
  process.once("SIGTERM", () => close("SIGTERM").catch((error) => {
    logger.error?.("petpack.studio_api.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  process.once("SIGINT", () => close("SIGINT").catch((error) => {
    logger.error?.("petpack.studio_api.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  const address = await runtime.start();
  return { runtime, address };
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.studio_api.start_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  });
}

module.exports = { main };
