const { createOutboxDispatcherRuntime } = require("./create-outbox-dispatcher");
const { createRuntimeHeartbeatFromEnvironment } = require("./runtime-heartbeat");

async function main({ environment = process.env, logger = console } = {}) {
  const runtime = await createOutboxDispatcherRuntime({ environment, logger });
  let heartbeat = null;
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info?.("petpack.outbox.stopping", { signal });
    const failures = [];
    if (heartbeat) {
      try { await heartbeat.stop(); } catch (error) { failures.push(error); }
    }
    try { await runtime.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw failures[0];
  };
  process.once("SIGTERM", () => close("SIGTERM").catch((error) => {
    logger.error?.("petpack.outbox.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  process.once("SIGINT", () => close("SIGINT").catch((error) => {
    logger.error?.("petpack.outbox.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  try {
    heartbeat = createRuntimeHeartbeatFromEnvironment({
      environment,
      role: "outbox-dispatcher",
      probe: () => runtime.assertReady(),
      logger
    });
    const status = await runtime.start();
    if (heartbeat) await heartbeat.start();
    logger.info?.("petpack.outbox.started", status);
    return runtime;
  } catch (error) {
    await close("START_FAILURE").catch(() => undefined);
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.outbox.start_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  });
}

module.exports = { main };
