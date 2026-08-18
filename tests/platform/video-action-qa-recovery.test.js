import { describe, expect, it, vi } from "vitest";

import stateMachineModule from "../../platform/src/domain/production-state-machine.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";

const { PRODUCTION_STATES } = stateMachineModule;
const { ProductionWorkflow } = workflowModule;

const modelRegistry = Object.freeze({
  version: "seedream-seedance-480p-v1",
  modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
});

function createWorkflow() {
  const committed = [];
  const runStore = {
    commitTransition: vi.fn(async (transition) => {
      committed.push(transition);
      return { ...transition.run, version: (transition.previousRun?.version ?? 0) + 1 };
    })
  };
  const workflow = new ProductionWorkflow({
    runStore,
    queue: { add: vi.fn() },
    promptStore: { listPublishedMetadata: vi.fn(async () => []) },
    modelRegistry,
    logger: { info() {}, warn() {}, error() {} }
  });
  return { workflow, committed };
}

const generatingRun = Object.freeze({
  id: "run-1",
  projectId: "project-1",
  orderId: "order-1",
  state: PRODUCTION_STATES.VIDEO_GENERATING,
  version: 4
});

// A rejected action used to leave the run in video_generating with no failure
// code and no regeneration: the customer's progress page showed generation
// forever, which reads worse than an honest failure.
describe("video action QA failure", () => {
  it("fails the run with an action-specific failure code once retries are spent", async () => {
    const { workflow, committed } = createWorkflow();

    await workflow.videoActionQaFailed({ run: generatingRun, actionId: "roll" });

    expect(committed).toHaveLength(1);
    expect(committed[0].run.state).toBe(PRODUCTION_STATES.FAILED);
    expect(committed[0].run.failureCode).toBe("action_qa_failed");
  });

  it("queues no further work for a failed run", async () => {
    const { workflow, committed } = createWorkflow();

    await workflow.videoActionQaFailed({ run: generatingRun, actionId: "roll" });

    expect(committed[0].jobs ?? []).toHaveLength(0);
  });

  it("refuses to fail an action outside video generation", async () => {
    const { workflow } = createWorkflow();

    await expect(workflow.videoActionQaFailed({
      run: { ...generatingRun, state: PRODUCTION_STATES.PACKAGING },
      actionId: "roll"
    })).rejects.toThrow(/only while a run is generating video/);
  });

  it("refuses an action outside the canonical seven", async () => {
    const { workflow } = createWorkflow();

    await expect(workflow.videoActionQaFailed({
      run: generatingRun,
      actionId: "backflip"
    })).rejects.toThrow(/Unsupported PetPack Studio action/);
  });

  it("rejects a negative regeneration budget at construction", () => {
    expect(() => new ProductionWorkflow({
      runStore: { commitTransition: vi.fn() },
      queue: { add: vi.fn() },
      promptStore: { listPublishedMetadata: vi.fn() },
      modelRegistry,
      maxVideoActionQaRetries: -1
    })).toThrow(/maxVideoActionQaRetries/);
  });
});
