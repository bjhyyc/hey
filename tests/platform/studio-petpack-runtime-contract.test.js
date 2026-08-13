import { describe, expect, it } from "vitest";
import petpackBuilder from "../../platform/src/petpack/build.js";
import { buildRuntimeModel, createRuleRuntime } from "../../src/renderer/pet/pet-runtime.js";

const { createStudioPetpackManifest } = petpackBuilder;

const ACTION_IDS = [
  "idle",
  "sneeze",
  "roll",
  "sleep-transition",
  "sleep-loop",
  "stretch",
  "hover-attention"
];

const CLIP_IDS = {
  idle: "70000000-0000-4000-8000-000000000001",
  sneeze: "70000000-0000-4000-8000-000000000002",
  roll: "70000000-0000-4000-8000-000000000003",
  sleepTransition: "70000000-0000-4000-8000-000000000004",
  sleepLoop: "70000000-0000-4000-8000-000000000005",
  stretch: "70000000-0000-4000-8000-000000000006",
  hoverAttention: "70000000-0000-4000-8000-000000000007"
};

function createAsset(actionId, index) {
  return {
    actionId,
    durationMs: 4000 + index * 100
  };
}

describe("Studio PetPack to Desktop Pet runtime contract", () => {
  it("turns the real builder manifest into the six required client interactions", () => {
    const manifest = createStudioPetpackManifest({
      packageId: "hey-pet-contract-test",
      name: "Hey Pet",
      version: "1.0.0",
      actionClipIds: CLIP_IDS,
      assets: ACTION_IDS.map(createAsset)
    });
    const model = buildRuntimeModel({
      config: { triggerRules: [] },
      activePackage: {
        manifest,
        assetsByPath: Object.fromEntries([
          manifest.animations.default,
          ...manifest.animations.clips
        ].map((clip) => [clip.asset, `file:///pet/${clip.asset}`]))
      }
    });
    const runtime = createRuleRuntime({ rules: model.rules });

    expect(manifest.triggerRules).toEqual([]);
    expect(model.rules).toHaveLength(6);
    expect(runtime.evaluateEvent({ type: "appLaunch", timestamp: 1 }))
      .toEqual([{ type: "playAnimation", animation: CLIP_IDS.stretch }]);
    expect(runtime.evaluateEvent({ type: "click", timestamp: 2 }))
      .toEqual([{ type: "playAnimation", animation: CLIP_IDS.sneeze }]);
    expect(runtime.evaluateEvent({ type: "doubleClick", timestamp: 3 }))
      .toEqual([{ type: "playAnimation", animation: CLIP_IDS.roll }]);
    expect(runtime.evaluateEvent({ type: "rightClick", timestamp: 4 }))
      .toEqual([{ type: "playAnimation", animation: CLIP_IDS.stretch }]);
    expect(runtime.evaluateEvent({ type: "hoverDuration", timestamp: 2000, elapsedMs: 2000 }))
      .toEqual([{ type: "playAnimation", animation: CLIP_IDS.hoverAttention }]);
    expect(runtime.evaluateEvent({ type: "idleDuration", timestamp: 22000, elapsedMs: 22000 }))
      .toEqual([
        { type: "playAnimation", animation: CLIP_IDS.sleepTransition },
        { type: "playAnimation", animation: CLIP_IDS.sleepLoop }
      ]);
  });
});
