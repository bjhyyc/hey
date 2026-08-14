const { createOutboxDispatcherRuntime } = require("./create-outbox-dispatcher");

async function main({ environment = process.env, logger = console } = {}) {
  const runtime = await createOutboxDispatcherRuntime({ environment, logger });
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info?.("petpack.outbox.stopping", { signal });
    await runtime.close();
  };
  process.once("SIGTERM", () => close("SIGTERM").catch((error) => {
    logger.error?.("petpack.outbox.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  process.once("SIGINT", () => close("SIGINT").catch((error) => {
    logger.error?.("petpack.outbox.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  const status = await runtime.start();
  logger.info?.("petpack.outbox.started", status);
  return runtime;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.outbox.start_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  });
}

module.exports = { main };
