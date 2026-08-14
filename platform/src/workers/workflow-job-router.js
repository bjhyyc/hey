const { JOB_NAMES } = require("../workflow/production-workflow");

const IMAGE_MASTER_JOB_NAMES = new Set([
  JOB_NAMES.GENERATE_FRONT,
  JOB_NAMES.FINALIZE_FRONT,
  JOB_NAMES.GENERATE_SIDE,
  JOB_NAMES.FINALIZE_SIDE,
  JOB_NAMES.GENERATE_SLEEP,
  JOB_NAMES.FINALIZE_SLEEP
]);

const PRODUCTION_JOB_NAMES = new Set([
  JOB_NAMES.GENERATE_VIDEO,
  JOB_NAMES.POLL_VIDEO,
  JOB_NAMES.PROCESS_VIDEO_ACTION,
  JOB_NAMES.FINALIZE_VIDEO_ACTION
]);

const PETPACK_PIPELINE_JOB_NAMES = new Set([
  JOB_NAMES.PROCESS_MEDIA,
  JOB_NAMES.BUILD_PACKAGE,
  JOB_NAMES.VALIDATE_PACKAGE,
  JOB_NAMES.DELIVERY_READY
]);

const ROUTED_JOB_NAMES = new Set([
  JOB_NAMES.AWAIT_PHOTOS,
  ...IMAGE_MASTER_JOB_NAMES,
  ...PRODUCTION_JOB_NAMES,
  ...PETPACK_PIPELINE_JOB_NAMES
]);

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireHandler(value, label) {
  if (!value || typeof value.process !== "function") {
    throw new Error(`${label} must implement process`);
  }
  return value;
}

function parseAwaitPhotosJob(job) {
  if (!job || typeof job !== "object" || job.name !== JOB_NAMES.AWAIT_PHOTOS) {
    throw new Error(`Workflow job router expected ${JOB_NAMES.AWAIT_PHOTOS}`);
  }
  const data = job.data;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some((key) => key !== "runId")) {
    throw new Error("Await-photos job data may contain only runId");
  }
  const configuredJobId = job.options?.jobId || job.opts?.jobId;
  const jobId = requiredString(
    String(job.id || configuredJobId || job.dedupeKey || ""),
    "Await-photos queue job ID"
  );
  if (configuredJobId && String(configuredJobId) !== jobId) {
    throw new Error("Await-photos queue job ID does not match its configured dedupe ID");
  }
  const maxAttempts = Number(job.options?.attempts ?? job.opts?.attempts);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("Await-photos job requires a bounded positive attempt count");
  }
  return Object.freeze({
    jobId,
    runId: requiredString(data.runId, "Await-photos run ID", 128),
    maxAttempts
  });
}

/**
 * Routes every job from the single production queue to exactly one handler.
 * AWAIT_PHOTOS is a durable workflow marker, not executable work, so consuming
 * it is an intentionally side-effect-free and repeatable acknowledgement.
 */
class WorkflowJobRouter {
  constructor({ imageMasterWorker, productionJobWorker, petpackPipelineWorker } = {}) {
    this.imageMasterWorker = requireHandler(imageMasterWorker, "Image master worker");
    this.productionJobWorker = requireHandler(productionJobWorker, "Production job worker");
    this.petpackPipelineWorker = requireHandler(petpackPipelineWorker, "PetPack pipeline worker");
  }

  async process(job) {
    const name = requiredString(job?.name, "Workflow job name", 128);
    if (name === JOB_NAMES.AWAIT_PHOTOS) {
      const input = parseAwaitPhotosJob(job);
      return Object.freeze({ status: "awaiting_photos", runId: input.runId });
    }
    if (IMAGE_MASTER_JOB_NAMES.has(name)) return this.imageMasterWorker.process(job);
    if (PRODUCTION_JOB_NAMES.has(name)) return this.productionJobWorker.process(job);
    if (PETPACK_PIPELINE_JOB_NAMES.has(name)) return this.petpackPipelineWorker.process(job);
    throw new Error("Workflow job router received an unsupported job name");
  }
}

module.exports = {
  IMAGE_MASTER_JOB_NAMES,
  PETPACK_PIPELINE_JOB_NAMES,
  PRODUCTION_JOB_NAMES,
  ROUTED_JOB_NAMES,
  WorkflowJobRouter,
  parseAwaitPhotosJob
};
