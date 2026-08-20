import { describe, expect, it, vi } from "vitest";

import stateMachineModule from "../../platform/src/domain/production-state-machine.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";

// A customer spent one regeneration on a front master; the new version failed
// the cutout gate three times and the whole paid order was marked failed - even
// though the first master had passed and was sitting there, confirmable. A
// regeneration the customer asked for must never cost them the order.

const { PRODUCTION_STATES } = stateMachineModule;
const { ProductionWorkflow } = workflowModule;

const modelRegistry = Object.freeze({
  version: "seedream-seedance-480p-v1",
  modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
});

function createWorkflow({ approved = 0 } = {}) {
  const committed = [];
  const runStore = {
    commitTransition: vi.fn(async (transition) => {
      committed.push(transition);
      return { ...transition.run, version: (transition.previousRun?.version ?? 0) + 1 };
    }),
    countApprovedCharacterCandidates: vi.fn(async () => approved)
  };
  const workflow = new ProductionWorkflow({
    runStore,
    queue: { add: vi.fn() },
    promptStore: { listPublishedMetadata: vi.fn(async () => []) },
    modelRegistry,
    logger: { info() {}, warn() {}, error() {} }
  });
  return { workflow, committed, runStore };
}

// Two internal retries are already spent, so the next failure is the last one.
const exhaustedRun = Object.freeze({
  id: "run-1",
  projectId: "project-1",
  orderId: "order-1",
  state: PRODUCTION_STATES.AWAKE_GENERATING,
  modelRegistryVersion: "seedream-seedance-480p-v1",
  version: 9,
  frontGenerationAttempts: 4,
  frontUserRegenerationsUsed: 1,
  frontQaRetries: 2,
  sideGenerationAttempts: 1
});

describe("failed character regeneration", () => {
  it("returns the order to confirmation when an approved master is on record", async () => {
    const { workflow, committed, runStore } = createWorkflow({ approved: 1 });

    await workflow.characterMasterQaFailed({ run: exhaustedRun, view: "front" });

    expect(runStore.countApprovedCharacterCandidates).toHaveBeenCalledWith({ runId: "run-1", view: "front" });
    expect(committed).toHaveLength(1);
    expect(committed[0].run.state).toBe(PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION);
    expect(committed[0].run.failureCode).toBeUndefined();
    expect(committed[0].jobs ?? []).toHaveLength(0);
  });

  it("hands back the regeneration that produced nothing usable", async () => {
    const { workflow, committed } = createWorkflow({ approved: 2 });

    await workflow.characterMasterQaFailed({ run: exhaustedRun, view: "front" });

    expect(committed[0].run.frontUserRegenerationsUsed).toBe(0);
    expect(committed[0].run.frontQaRetries).toBe(0);
    // The failed attempts stay on record; only the allowance is restored.
    expect(committed[0].run.frontGenerationAttempts).toBe(4);
  });

  it("still fails a view that never produced an approvable master", async () => {
    const { workflow, committed } = createWorkflow({ approved: 0 });

    await workflow.characterMasterQaFailed({
      run: { ...exhaustedRun, frontUserRegenerationsUsed: 0 },
      view: "front"
    });

    expect(committed[0].run.state).toBe(PRODUCTION_STATES.FAILED);
    expect(committed[0].run.failureCode).toBe("front_master_qa_failed");
  });

  it("retries internally before giving up at all", async () => {
    const { workflow, committed } = createWorkflow({ approved: 1 });

    await workflow.characterMasterQaFailed({ run: { ...exhaustedRun, frontQaRetries: 0 }, view: "front" });

    expect(committed[0].run.state).toBe(PRODUCTION_STATES.AWAKE_GENERATING);
    expect(committed[0].run.frontQaRetries).toBe(1);
    expect(committed[0].jobs).toHaveLength(1);
  });
});
