const { createOutboxDispatcherRuntime } = require("../runtime/create-outbox-dispatcher");
const {
  buildZeroCostEnvironment,
  installGracefulShutdown,
  notifyReady,
  safeStartupFailure
} = require("./zero-cost-runtime-support");

async function main({ environment = process.env, logger = console } = {}) {
  const safeEnvironment = buildZeroCostEnvironment(environment, { role: "outbox" });
  const runtime = await createOutboxDispatcherRuntime({ environment: safeEnvironment, logger });
  const close = installGracefulShutdown({ label: "outbox", logger, close: () => runtime.close() });
  const status = await runtime.start();
  notifyReady({ role: "outbox", status });
  return { runtime, status, close };
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.zero_cost.outbox.start_failed", safeStartupFailure(error));
    process.exitCode = 1;
  });
}

module.exports = { main };
