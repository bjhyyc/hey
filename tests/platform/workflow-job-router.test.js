import { describe, expect, it, vi } from "vitest";

import workflowModule from "../../platform/src/workflow/production-workflow.js";
import routerModule from "../../platform/src/workers/workflow-job-router.js";

const { JOB_NAMES } = workflowModule;
const {
  IMAGE_MASTER_JOB_NAMES,
  PETPACK_PIPELINE_JOB_NAMES,
  PRODUCTION_JOB_NAMES,
  ROUTED_JOB_NAMES,
  WorkflowJobRouter,
  parseAwaitPhotosJob
} = routerModule;

function handler(label) {
  return {
    process: vi.fn(async (job) => ({ label, name: job.name }))
  };
}

function job(name, { runId = "run-router-1", jobId = "queue-job-router-1", attempts = 3 } = {}) {
  return {
    id: jobId,
    name,
    data: { runId },
    options: { jobId, attempts },
    opts: { jobId, attempts },
    dedupeKey: jobId
  };
}

function createRouter() {
  const imageMasterWorker = handler("image");
  const productionJobWorker = handler("video");
  const petpackPipelineWorker = handler("package");
  return {
    imageMasterWorker,
    productionJobWorker,
    petpackPipelineWorker,
    router: new WorkflowJobRouter({
      imageMasterWorker,
      productionJobWorker,
      petpackPipelineWorker
    })
  };
}

describe("single-queue workflow job router", () => {
  it("covers every declared workflow job exactly once", () => {
    expect([...ROUTED_JOB_NAMES].sort()).toEqual(Object.values(JOB_NAMES).sort());
    expect([
      ...IMAGE_MASTER_JOB_NAMES,
      ...PRODUCTION_JOB_NAMES,
      ...PETPACK_PIPELINE_JOB_NAMES,
      JOB_NAMES.AWAIT_PHOTOS
    ]).toHaveLength(Object.values(JOB_NAMES).length);
  });

  it.each([
    ...[...IMAGE_MASTER_JOB_NAMES].map((name) => [name, "imageMasterWorker", "image"]),
    ...[...PRODUCTION_JOB_NAMES].map((name) => [name, "productionJobWorker", "video"]),
    ...[...PETPACK_PIPELINE_JOB_NAMES].map((name) => [name, "petpackPipelineWorker", "package"])
  ])("routes %s to only its assigned handler", async (name, expectedHandler, expectedLabel) => {
    const fixture = createRouter();
    await expect(fixture.router.process(job(name))).resolves.toEqual({ label: expectedLabel, name });

    for (const handlerName of ["imageMasterWorker", "productionJobWorker", "petpackPipelineWorker"]) {
      expect(fixture[handlerName].process).toHaveBeenCalledTimes(handlerName === expectedHandler ? 1 : 0);
    }
  });

  it("acknowledges AWAIT_PHOTOS repeatedly without invoking an executable handler", async () => {
    const fixture = createRouter();
    const marker = job(JOB_NAMES.AWAIT_PHOTOS, { attempts: 1 });

    await expect(fixture.router.process(marker)).resolves.toEqual({
      status: "awaiting_photos",
      runId: "run-router-1"
    });
    await expect(fixture.router.process(marker)).resolves.toEqual({
      status: "awaiting_photos",
      runId: "run-router-1"
    });
    expect(fixture.imageMasterWorker.process).not.toHaveBeenCalled();
    expect(fixture.productionJobWorker.process).not.toHaveBeenCalled();
    expect(fixture.petpackPipelineWorker.process).not.toHaveBeenCalled();
  });

  it("validates the AWAIT_PHOTOS marker before acknowledging it", () => {
    expect(() => parseAwaitPhotosJob({
      ...job(JOB_NAMES.AWAIT_PHOTOS, { attempts: 1 }),
      data: { runId: "run-router-1", sourceUrl: "https://example.invalid/private" }
    })).toThrow(/only runId/i);
    expect(() => parseAwaitPhotosJob({
      ...job(JOB_NAMES.AWAIT_PHOTOS, { attempts: 1 }),
      options: { jobId: "different-job-id", attempts: 1 }
    })).toThrow(/does not match/i);
  });

  it("fails closed for unknown names without trying any handler", async () => {
    const fixture = createRouter();
    await expect(fixture.router.process(job("petpack.future-unknown"))).rejects.toThrow(/unsupported job name/i);
    expect(fixture.imageMasterWorker.process).not.toHaveBeenCalled();
    expect(fixture.productionJobWorker.process).not.toHaveBeenCalled();
    expect(fixture.petpackPipelineWorker.process).not.toHaveBeenCalled();
  });

  it("requires all three handlers at construction time", () => {
    expect(() => new WorkflowJobRouter({
      imageMasterWorker: handler("image"),
      productionJobWorker: handler("video")
    })).toThrow(/PetPack pipeline worker must implement process/i);
  });
});
