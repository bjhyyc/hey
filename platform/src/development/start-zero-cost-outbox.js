const { createOutboxDispatcherRuntime } = require("../runtime/create-outbox-dispatcher");
const { JOB_NAMES } = require("../workflow/production-workflow");
const {
  buildZeroCostEnvironment,
  installGracefulShutdown,
  notifyReady,
  safeStartupFailure
} = require("./zero-cost-runtime-support");

const HARD_KILL_TARGET_JOB = JOB_NAMES.GENERATE_FRONT;
const POST_ENQUEUE_TARGET_ENV = "PETPACK_REHEARSAL_OUTBOX_POST_ENQUEUE_TARGET_JOB";
const POST_ENQUEUE_TARGET_JOBS = Object.freeze([
  HARD_KILL_TARGET_JOB,
  JOB_NAMES.FINALIZE_SLEEP
]);
const POST_ENQUEUE_TARGET_JOB_SET = new Set(POST_ENQUEUE_TARGET_JOBS);

function resolvePostEnqueueTargetJob(environment = process.env) {
  const configured = environment[POST_ENQUEUE_TARGET_ENV];
  if (configured === undefined || configured === null || configured === "") return HARD_KILL_TARGET_JOB;
  if (typeof configured !== "string" || configured !== configured.trim() ||
      !POST_ENQUEUE_TARGET_JOB_SET.has(configured)) {
    throw new Error("Zero-cost post-enqueue target job is not allowlisted");
  }
  return configured;
}

function createClaimPause(environment = process.env) {
  if (environment.PETPACK_REHEARSAL_OUTBOX_HARD_KILL !== "true") return null;
  let triggered = false;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  process.once("SIGTERM", release);
  process.once("SIGINT", release);
  return async (messages) => {
    const target = messages.find((message) => message.jobName === HARD_KILL_TARGET_JOB);
    if (triggered || !target) return;
    triggered = true;
    if (typeof process.send === "function") {
      process.send({
        type: "checkpoint",
        role: "outbox",
        checkpoint: "claimed_before_enqueue",
        jobName: HARD_KILL_TARGET_JOB,
        outboxId: target.id,
        dedupeKey: target.dedupeKey,
        claimedCount: messages.length
      });
    }
    await released;
  };
}

function createPostEnqueuePause(environment = process.env) {
  if (environment.PETPACK_REHEARSAL_OUTBOX_POST_ENQUEUE_HARD_KILL !== "true") {
    if (environment[POST_ENQUEUE_TARGET_ENV] !== undefined && environment[POST_ENQUEUE_TARGET_ENV] !== "") {
      throw new Error("Zero-cost post-enqueue target requires its explicit development hook");
    }
    return null;
  }
  if (environment.NODE_ENV === "production" || environment.PETPACK_PLATFORM_MODE === "production") {
    throw new Error("Zero-cost post-enqueue hook is forbidden in production");
  }
  const targetJob = resolvePostEnqueueTargetJob(environment);
  let triggered = false;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  process.once("SIGTERM", release);
  process.once("SIGINT", release);
  return async (message) => {
    if (triggered || message.jobName !== targetJob) return;
    triggered = true;
    if (typeof process.send === "function") {
      process.send({
        type: "checkpoint",
        role: "outbox",
        checkpoint: "enqueued_before_mark_sent",
        jobName: targetJob,
        outboxId: message.id,
        dedupeKey: message.dedupeKey
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
    afterClaim: createClaimPause(safeEnvironment) || undefined,
    afterEnqueue: createPostEnqueuePause(safeEnvironment) || undefined
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

module.exports = {
  HARD_KILL_TARGET_JOB,
  POST_ENQUEUE_TARGET_ENV,
  POST_ENQUEUE_TARGET_JOBS,
  createClaimPause,
  createPostEnqueuePause,
  main,
  resolvePostEnqueueTargetJob
};
