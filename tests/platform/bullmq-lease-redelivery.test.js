import { afterEach, describe, expect, it, vi } from "vitest";

import queueModule from "../../platform/src/queue/bullmq-workflow-queue.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";
import productionWorkerModule from "../../platform/src/workers/production-job-worker.js";
import imageWorkerModule from "../../platform/src/workers/image-master-worker.js";
import petpackWorkerModule from "../../platform/src/workers/petpack-pipeline-worker.js";

const { BullMqWorkflowWorker } = queueModule;
const { JOB_NAMES } = workflowModule;
const { ProductionJobWorker, RetryableProductionJobError } = productionWorkerModule;
const { ImageMasterWorker, MASTER_IMAGE_PROCESSOR_CONTRACT_VERSION } = imageWorkerModule;
const { PetpackPipelineWorker, RetryablePetpackJobError } = petpackWorkerModule;

const QUEUE_CONFIG = Object.freeze({
  queueName: "petpack-test",
  prefix: "petpack-test",
  host: "redis.invalid",
  port: 6379,
  username: "test-user",
  password: "test-password",
  database: 0,
  ca: "test-ca",
  concurrency: 1
});

class FakeBullWorker {
  constructor(_name, processor, options) {
    this.processor = processor;
    this.options = options;
  }

  on() {}
  async run() {}
  async waitUntilReady() {}
  async close() {}
}

class FakeDelayedError extends Error {
  constructor() {
    super("bullmq:movedToDelayed");
    this.name = "DelayedError";
  }
}

function queueJob(name, id) {
  return {
    id,
    name,
    data: { runId: "run-1", ...(name.includes("video") ? { actionId: "idle" } : {}) },
    opts: { jobId: id, attempts: 3 },
    attemptsMade: 1,
    moveToDelayed: vi.fn(async () => {})
  };
}

function methodStubs(names) {
  return Object.fromEntries(names.map((name) => [name, vi.fn()]));
}

function createProductionWorker(repository) {
  return new ProductionJobWorker({
    repository,
    modelArkClient: {
      createVideoTask: vi.fn(),
      getVideoTask: vi.fn()
    },
    objectStore: {
      createDownloadGrant: vi.fn(),
      archiveProviderOutput: vi.fn()
    },
    mediaWorker: { processAction: vi.fn() },
    mediaWorkspace: { withActionWorkspace: vi.fn() },
    workflow: { videoActionQaPassed: vi.fn() },
    leaseSeconds: 120,
    processingLeaseSeconds: 900,
    productionMode: false,
    logger: { info() {}, warn() {}, error() {} }
  });
}

function createProductionRepository() {
  return methodStubs([
    "claimVideoSubmission", "prepareVideoSubmission", "completeVideoSubmission",
    "releaseVideoClaimForRetry", "markVideoSubmissionRejected", "markVideoSubmissionUnknown",
    "claimVideoPoll", "completeVideoPollPending", "markVideoProviderOutputSucceeded",
    "completeVideoPollSuccess", "releaseVideoPollForRetry", "markVideoPollFailed",
    "markVideoPollUnknown", "claimVideoProcessing", "bindVideoProcessingPolicy",
    "renewVideoProcessingLease", "saveVideoProcessingResult", "failVideoProcessingQa",
    "completeVideoProcessingExecution", "releaseVideoProcessingForRetry"
  ]);
}

function createImageWorker(repository) {
  const processor = {
    version: "master-processor-test-v1",
    contractVersion: MASTER_IMAGE_PROCESSOR_CONTRACT_VERSION,
    normalizeAndInspect: vi.fn()
  };
  return new ImageMasterWorker({
    repository,
    modelArkClient: {
      createFrontMaster: vi.fn(),
      createSideMaster: vi.fn(),
      createSleepingMaster: vi.fn()
    },
    objectStore: {
      createDownloadGrant: vi.fn(),
      archiveProviderOutput: vi.fn()
    },
    masterWorkspace: { withMasterWorkspace: vi.fn() },
    masterImageProcessor: processor,
    workflow: {
      characterMasterGenerated: vi.fn(),
      characterMasterQaFailed: vi.fn(),
      sleepMasterQaPassed: vi.fn(),
      sleepMasterQaFailed: vi.fn()
    },
    modelRegistry: {
      version: "registry-test-v1",
      modelArk: {
        region: "cn-test",
        image: { endpointId: "seedream-test" }
      }
    },
    leaseSeconds: 900,
    productionMode: false,
    logger: { info() {}, warn() {}, error() {} }
  });
}

function createImageRepository() {
  return methodStubs([
    "claimMasterGeneration", "prepareMasterSubmission", "markMasterProviderAccepted",
    "markMasterProviderOutputSucceeded", "markMasterSubmissionRejected",
    "markMasterSubmissionUnknown", "saveMasterProviderOutput", "bindMasterProcessingPolicy",
    "renewMasterLease", "saveMasterResult", "releaseMasterClaimForRetry",
    "claimMasterFinalization", "completeMasterFinalization", "releaseMasterFinalizationForRetry"
  ]);
}

function createPetpackWorker(repository) {
  const validator = {
    describe() {
      return {
        validatorVersion: "validator-test-v1",
        policyVersion: "policy-test-v1",
        validatorIdentity: "validator-test"
      };
    },
    validate: vi.fn()
  };
  return new PetpackPipelineWorker({
    repository,
    workspace: {
      withBuildWorkspace: vi.fn(),
      withValidationWorkspace: vi.fn()
    },
    deliveryValidator: validator,
    probeAsset: vi.fn(),
    leaseSeconds: 180,
    productionMode: false,
    logger: { info() {}, warn() {}, error() {} }
  });
}

function createPetpackRepository() {
  return methodStubs([
    "claimMediaSnapshot", "completeMediaSnapshot", "claimPackageBuild",
    "renewRunJobLease", "completePackageBuild", "getPackageValidationDescriptor",
    "claimPackageValidation", "completePackageValidation", "failPackageValidation",
    "releaseRunJobForRetry", "claimDeliveryReady", "completeDeliveryReady"
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BullMQ lease-aware redelivery", () => {
  it("moves a busy job to delayed with its original lock token and no attempt mutation", async () => {
    const busy = Object.assign(new Error("database lease is active"), {
      code: "video_submission_busy",
      retryAfterMs: 120_250
    });
    const handler = { process: vi.fn(async () => { throw busy; }) };
    const runtime = new BullMqWorkflowWorker({
      config: QUEUE_CONFIG,
      handler,
      WorkerClass: FakeBullWorker,
      DelayedErrorClass: FakeDelayedError,
      logger: { info() { throw new Error("logger unavailable"); }, warn() {}, error() {} }
    });
    const job = queueJob(JOB_NAMES.GENERATE_VIDEO, "video-job-1");
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await expect(runtime.worker.processor(job, "bull-lock-token"))
      .rejects.toMatchObject({ name: "DelayedError" });

    expect(job.moveToDelayed).toHaveBeenCalledOnce();
    expect(job.moveToDelayed).toHaveBeenCalledWith(1_120_250, "bull-lock-token");
    expect(job.attemptsMade).toBe(1);
    expect(handler.process).toHaveBeenCalledWith(expect.objectContaining({
      id: "video-job-1",
      options: expect.objectContaining({ attempts: 3, jobId: "video-job-1" })
    }));
  });

  it("keeps ordinary failures on BullMQ's bounded attempts path", async () => {
    const failure = new RetryableProductionJobError("provider_request_failed");
    expect(failure.retryAfterMs).toBeNull();
    expect(new RetryablePetpackJobError("petpack_build_failed").retryAfterMs).toBeNull();
    const runtime = new BullMqWorkflowWorker({
      config: QUEUE_CONFIG,
      handler: { process: vi.fn(async () => { throw failure; }) },
      WorkerClass: FakeBullWorker,
      DelayedErrorClass: FakeDelayedError,
      logger: { info() {}, warn() {}, error() {} }
    });
    const job = queueJob(JOB_NAMES.GENERATE_VIDEO, "video-job-2");

    await expect(runtime.worker.processor(job, "bull-lock-token")).rejects.toBe(failure);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});

describe("worker busy-lease semantics", () => {
  it("defers video submission, provider polling, and source-media processing past their DB leases", async () => {
    const repository = createProductionRepository();
    const worker = createProductionWorker(repository);
    repository.claimVideoSubmission.mockResolvedValue({ outcome: "busy" });
    repository.claimVideoPoll.mockResolvedValue({ outcome: "busy", retryAfterMs: 5432 });
    repository.claimVideoProcessing.mockResolvedValue({ outcome: "busy" });

    await expect(worker.process(queueJob(JOB_NAMES.GENERATE_VIDEO, "submit-job")))
      .rejects.toMatchObject({ code: "video_submission_busy", retryAfterMs: 121_000 });
    await expect(worker.process(queueJob(JOB_NAMES.POLL_VIDEO, "poll-job")))
      .rejects.toMatchObject({ code: "video_poll_busy", retryAfterMs: 6432 });
    await expect(worker.process(queueJob(JOB_NAMES.PROCESS_VIDEO_ACTION, "process-job")))
      .rejects.toMatchObject({ code: "action_media_processing_busy", retryAfterMs: 901_000 });
  });

  it("defers master generation and finalization without consuming their normal attempts", async () => {
    const repository = createImageRepository();
    const worker = createImageWorker(repository);
    repository.claimMasterGeneration.mockResolvedValue({ outcome: "busy", kind: "front" });
    repository.claimMasterFinalization.mockResolvedValue({ outcome: "busy", kind: "front" });

    await expect(worker.process(queueJob(JOB_NAMES.GENERATE_FRONT, "front-generate-job")))
      .rejects.toMatchObject({ code: "master_image_busy", retryAfterMs: 901_000 });
    await expect(worker.process(queueJob(JOB_NAMES.FINALIZE_FRONT, "front-finalize-job")))
      .rejects.toMatchObject({ code: "master_finalization_busy", retryAfterMs: 301_000 });
  });

  it("gives PetPack busy claims a lease-based fallback when exact remaining time is absent", async () => {
    const repository = createPetpackRepository();
    const worker = createPetpackWorker(repository);
    repository.claimMediaSnapshot.mockResolvedValue({ outcome: "busy" });

    await expect(worker.process(queueJob(JOB_NAMES.PROCESS_MEDIA, "media-gate-job")))
      .rejects.toMatchObject({ code: "petpack_execution_busy", retryAfterMs: 181_000 });
  });
});
