const { createStudioWorkerRuntime } = require("./create-studio-worker");
const { createRuntimeHeartbeatFromEnvironment } = require("./runtime-heartbeat");

async function main({ environment = process.env, logger = console } = {}) {
  const runtime = await createStudioWorkerRuntime({ environment, logger });
  let heartbeat = null;
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info?.("petpack.studio_worker.stopping", { signal });
    const failures = [];
    if (heartbeat) {
      try { await heartbeat.stop(); } catch (error) { failures.push(error); }
    }
    try { await runtime.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw failures[0];
  };
  process.once("SIGTERM", () => close("SIGTERM").catch((error) => {
    logger.error?.("petpack.studio_worker.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  process.once("SIGINT", () => close("SIGINT").catch((error) => {
    logger.error?.("petpack.studio_worker.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  try {
    heartbeat = createRuntimeHeartbeatFromEnvironment({
      environment,
      role: "studio-worker",
      probe: () => runtime.assertReady(),
      logger
    });
    const status = await runtime.start();
    if (heartbeat) await heartbeat.start();
    return { runtime, status, heartbeat };
  } catch (error) {
    await close("START_FAILURE").catch(() => undefined);
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.studio_worker.start_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  });
}

module.exports = { main };
