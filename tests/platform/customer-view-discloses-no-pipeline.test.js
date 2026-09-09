import { describe, expect, it } from "vitest";

import progressModule from "../../platform/src/api/project-progress.js";
import stateMachineModule from "../../platform/src/domain/production-state-machine.js";

// What the customer's browser receives is public: anyone can open the network
// tab. The progress screens used to narrate the production pipeline into it -
// every internal stage by name, every clip in the pack with its own state, and
// a badge whenever a quality gate rejected a take - which handed the recipe to
// anyone curious enough to look, and told the customer nothing they could act
// on. These tests hold the payload to what the customer needs.

const { USER_PROGRESS_STEPS, createUserProjectView, createUserProjectSummary, getProgressStepState } = progressModule;
const { PRODUCTION_STATES } = stateMachineModule;

// Vocabulary that describes how the pack is made rather than what the customer
// is waiting for. None of it may appear in a customer payload.
// What the pet will do is the product, and the waiting screen names it. What
// stays private is how the pack is built: the clips it is assembled from, which
// of them combine, the processing stages, and the quality-gate redos.
const INTERNAL_VOCABULARY = [
  "awake_generating", "sleep_generating", "awaiting_prompt_gate", "video_generating",
  "media_processing", "packaging", "validating", "qa_passed", "qa_failed",
  "睡姿", "母图", "抠图", "提示词", "首尾帧", "绿幕", "质检", "重做", "PetPack",
  // The clip identifiers that would give away the composition. sneeze, roll and
  // stretch are the abilities themselves and may appear; these three would say
  // that one ability is built from two clips, and that idle is a clip at all.
  "hover-attention", "sleep-transition", "sleep-loop", "actionId"
];

const ACTIONS = [
  { actionId: "idle", state: "qa_passed", retryCount: 0 },
  { actionId: "sneeze", state: "qa_passed", retryCount: 2 },
  { actionId: "roll", state: "processing", retryCount: 1 },
  { actionId: "stretch", state: "queued", retryCount: 0 },
  { actionId: "hover-attention", state: "queued", retryCount: 0 },
  { actionId: "sleep-transition", state: "queued", retryCount: 0 },
  { actionId: "sleep-loop", state: "queued", retryCount: 0 }
];

function viewFor(runState) {
  return createUserProjectView({
    project: { id: "project-1", displayName: "团团", state: "producing" },
    order: { id: "order-1", status: "paid", paymentMethod: "KAIPAY", amountFen: 7800 },
    run: { id: "run-1", state: runState, frontUserRegenerationsUsed: 0, sideUserRegenerationsUsed: 0 },
    characterCandidates: { front: null, side: null },
    delivery: null,
    actions: ACTIONS
  });
}

function assertNoInternalVocabulary(payload) {
  const serialized = JSON.stringify(payload);
  const leaked = INTERNAL_VOCABULARY.filter((term) => serialized.includes(term));
  expect(leaked).toEqual([]);
}

describe("the customer project view keeps the pipeline private", () => {
  it("shows three waiting steps, not the production stages", () => {
    expect(USER_PROGRESS_STEPS.map((step) => step.id)).toEqual(["character-confirmed", "animations", "package"]);
    assertNoInternalVocabulary(USER_PROGRESS_STEPS);
  });

  it("leaks no internal vocabulary at any stage of a run", () => {
    for (const runState of Object.values(PRODUCTION_STATES)) {
      assertNoInternalVocabulary(viewFor(runState));
      assertNoInternalVocabulary(getProgressStepState(runState));
    }
  });

  it("reports progress as the abilities the customer bought, not the clips", () => {
    const view = viewFor(PRODUCTION_STATES.VIDEO_GENERATING);
    expect(view.actions).toBeUndefined();
    const labels = view.actionProgress.items.map((item) => item.label);
    expect(labels).toEqual(["打喷嚏", "打滚", "伸懒腰", "舔脚", "睡觉", "安静待机"]);
    // Six abilities from seven clips: the two sleeping clips are one ability,
    // and nothing in the payload says so.
    expect(view.actionProgress.items).toHaveLength(6);
    // idle and sneeze passed; roll has left the queue; the rest are waiting.
    expect(view.actionProgress.items.find((item) => item.id === "sneeze").state).toBe("done");
    expect(view.actionProgress.items.find((item) => item.id === "roll").state).toBe("working");
    expect(view.actionProgress.items.find((item) => item.id === "sleep").state).toBe("waiting");
    expect(view.actionProgress.percent).toBe(33);
    // A quality-gate redo is invisible: sneeze was retried twice and still just
    // reads as finished.
    expect(JSON.stringify(view.actionProgress)).not.toMatch(/retry|redo|重做/i);
  });

  it("answers the character page's one question without naming a stage", () => {
    expect(viewFor(PRODUCTION_STATES.AWAKE_GENERATING).regeneratingCharacter).toBe(true);
    expect(viewFor(PRODUCTION_STATES.VIDEO_GENERATING).regeneratingCharacter).toBe(false);
    expect(viewFor(PRODUCTION_STATES.VIDEO_GENERATING).productionState).toBeUndefined();
  });

  it("keeps the project list to what the customer should do next", () => {
    const summary = createUserProjectSummary({
      project: { id: "project-1", displayName: "团团", state: "producing", updatedAt: new Date().toISOString() },
      order: { id: "order-1", status: "paid", paymentMethod: "KAIPAY", amountFen: 7800 },
      run: { id: "run-1", state: PRODUCTION_STATES.MEDIA_PROCESSING },
      delivery: null
    });
    expect(summary.productionState).toBeUndefined();
    expect(summary.nextStep).toBe("progress");
    assertNoInternalVocabulary(summary);
  });
});
