const { createOutboxDispatcherRuntime } = require("../runtime/create-outbox-dispatcher");
const {
  buildZeroCostEnvironment,
  installGracefulShutdown,
  notifyReady,
  safeStartupFailure
} = require("./zero-cost-runtime-support");

const HARD_KILL_TARGET_JOB = "petpack.generate-front-master";

function createClaimPause(environment = process.env) {
  if (environment.PETPACK_REHEARSAL_OUTBOX_HARD_KILL !== "true") return null;
  let triggered = false;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  process.once("SIGTERM", release);
  process.once("SIGINT", release);
  return async (messages) => {
    if (triggered || !messages.some((message) => message.jobName === HARD_KILL_TARGET_JOB)) return;
    triggered = true;
    if (typeof process.send === "function") {
      process.send({
        type: "checkpoint",
        role: "outbox",
        checkpoint: "claimed_before_enqueue",
        jobName: HARD_KILL_TARGET_JOB,
        claimedCount: messages.length
      });
    }
    await released;
  };
}

async function main({ environment = process.env, logger = console } = {}) {
  const safeEnvironment = buildZeroCostEnvironment(environment, { role: "outbox" });
  const runtime = await createOutboxDispatcherRuntime({
    environment: safeEnvironment,
    logger,
    afterClaim: createClaimPause(safeEnvironment) || undefined
  });
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

module.exports = { HARD_KILL_TARGET_JOB, createClaimPause, main };
