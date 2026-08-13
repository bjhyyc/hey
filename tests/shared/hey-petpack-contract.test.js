import { beforeEach, describe, expect, it, vi } from "vitest";
import heyContract from "../../src/shared/hey-petpack-contract.js";
import manifestValidator from "../../src/shared/manifest-validator.js";
import { scheduleActionSequence } from "../../src/shared/action-sequence.js";
import { AnimationController } from "../../src/renderer/pet/animation-controller.js";
import { buildRuntimeModel, createRuleRuntime } from "../../src/renderer/pet/pet-runtime.js";

const {
  ACTION_ORDER,
  CONTRACT_VERSION,
  createHeyPetpackManifest,
  getNominalDurationsMs
} = heyContract;
const { validateManifest } = manifestValidator;

function createManifest(overrides = {}) {
  return createHeyPetpackManifest({
    packageId: "hey-pet-order-001",
    durationsMs: getNominalDurationsMs(),
    ...overrides
  });
}

function getAvailableFiles(manifest) {
  return new Set([
    manifest.preview,
    manifest.animations.default.asset,
    ...manifest.animations.clips.map((clip) => clip.asset)
  ]);
}

function findRule(manifest, id) {
  return manifest.triggerRules.find((rule) => rule.id === id);
}

describe("Hey PetPack behavior contract", () => {
  it("builds a valid package with exactly seven animations and six product rules", () => {
    const manifest = createManifest();
    const result = validateManifest(manifest, getAvailableFiles(manifest));

    expect(result).toEqual({ ok: true, errors: [] });
    expect(manifest.contractVersion).toBe(CONTRACT_VERSION);
    expect(ACTION_ORDER).toEqual([
      "idle",
      "sneeze",
      "roll",
      "sleep-transition",
      "sleep-loop",
      "stretch",
      "hover-attention"
    ]);
    expect([manifest.animations.default, ...manifest.animations.clips]).toHaveLength(7);
    expect(manifest.triggerRules).toHaveLength(6);
  });

  it("contains no random movement, props, drops, messages, timers or panel actions", () => {
    const manifest = createManifest();
    const actionTypes = manifest.triggerRules.flatMap((rule) => rule.actions.map((action) => action.type));
    const conditionTypes = manifest.triggerRules.flatMap((rule) => rule.conditions.map((condition) => condition.type));

    expect(new Set(actionTypes)).toEqual(new Set(["playAnimation"]));
    expect(conditionTypes).toEqual([
      "appLaunch",
      "click",
      "doubleClick",
      "rightClick",
      "idleDuration",
      "hoverDuration"
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/movePet|randomTimer|timer|showMessage|openPanel|prop|drop/i);
  });

  it("binds the six interactions to the required seven action semantics", () => {
    const manifest = createManifest();
    const clipIdByAsset = Object.fromEntries(
      [manifest.animations.default, ...manifest.animations.clips].map((clip) => [clip.asset, clip.id])
    );

    expect(findRule(manifest, "startup-stretch").actions).toEqual([
      { type: "playAnimation", animation: clipIdByAsset["assets/stretch.webm"] }
    ]);
    expect(findRule(manifest, "click-sneeze").actions[0].animation).toBe(clipIdByAsset["assets/sneeze.webm"]);
    expect(findRule(manifest, "double-click-roll").actions[0].animation).toBe(clipIdByAsset["assets/roll.webm"]);
    expect(findRule(manifest, "right-click-wake").actions[0].animation).toBe(clipIdByAsset["assets/stretch.webm"]);
    expect(findRule(manifest, "idle-sleep").actions).toEqual([
      { type: "playAnimation", animation: clipIdByAsset["assets/sleep-transition.webm"] },
      { type: "playAnimation", animation: clipIdByAsset["assets/sleep-loop.webm"] }
    ]);
    expect(findRule(manifest, "hover-attention").actions[0].animation).toBe(clipIdByAsset["assets/hover-attention.webm"]);
  });

  it("freezes 22-second idle, 2-second hover and an event-scoped hover cooldown", () => {
    const manifest = createManifest();
    const idle = findRule(manifest, "idle-sleep");
    const hover = findRule(manifest, "hover-attention");

    expect(idle.conditions[0].filters).toEqual([
      { field: "elapsedMs", operator: ">=", value: 22000, unit: "ms" }
    ]);
    expect(hover.conditions[0].filters).toEqual([
      { field: "elapsedMs", operator: ">=", value: 2000, unit: "ms" }
    ]);
    expect(hover).toMatchObject({ cooldownMs: 20000, cooldownScope: "eventType" });
  });

  it("runs the generated manifest through the real runtime without hover blocking click or sleep", () => {
    const manifest = createManifest();
    const assetsByPath = Object.fromEntries(
      [manifest.animations.default, ...manifest.animations.clips].map((clip) => [clip.asset, `file:///pet/${clip.asset}`])
    );
    assetsByPath[manifest.preview] = "file:///pet/preview.png";
    const model = buildRuntimeModel({
      config: { triggerRules: [] },
      activePackage: { manifest, assetsByPath }
    });
    const runtime = createRuleRuntime({ rules: model.rules });
    const rule = (id) => findRule(manifest, id);

    expect(runtime.evaluateEvent({ type: "hoverDuration", timestamp: 2000, elapsedMs: 2000 }))
      .toEqual(rule("hover-attention").actions);
    expect(runtime.evaluateEvent({ type: "click", timestamp: 3000 }))
      .toEqual(rule("click-sneeze").actions);
    expect(runtime.evaluateEvent({ type: "idleDuration", timestamp: 22000, elapsedMs: 22000 }))
      .toEqual(rule("idle-sleep").actions);
  });

  it("requires measured integer durations for all seven post-processed videos", () => {
    const measured = getNominalDurationsMs();
    measured.sneeze = 3975;
    const manifest = createManifest({ durationsMs: measured });
    const sneeze = manifest.animations.clips.find((clip) => clip.asset === "assets/sneeze.webm");

    expect(sneeze.durationMs).toBe(3975);
    expect(() => createManifest({ durationsMs: { ...measured, sneeze: undefined } }))
      .toThrow("durationsMs.sneeze");
    expect(() => createManifest({ durationsMs: { ...measured, unexpected: 1000 } }))
      .toThrow("unexpected actions");
    expect(() => createManifest({ packageId: "../escape" })).toThrow("safe single path segment");
  });

  it("deep-freezes the shared behavior so one order cannot mutate later orders", () => {
    expect(Object.isFrozen(heyContract.BEHAVIOR)).toBe(true);
    expect(Object.isFrozen(heyContract.BEHAVIOR.rules)).toBe(true);
    expect(() => {
      heyContract.BEHAVIOR.rules[0].actions[0] = "roll";
    }).toThrow();

    expect(findRule(createManifest(), "startup-stretch").actions[0].animation)
      .toBe("70000000-0000-4000-8000-000000000006");
  });

  it("queues sleep-loop behind sleep-transition without a synthetic delay", () => {
    vi.useFakeTimers();
    const manifest = createManifest();
    const renderer = { renderClip: vi.fn(), onClipStart: vi.fn() };
    const controller = new AnimationController(manifest.animations, renderer);
    const sleepRule = findRule(manifest, "idle-sleep");
    const transition = manifest.animations.clips.find((clip) => clip.asset === "assets/sleep-transition.webm");
    const sleepLoop = manifest.animations.clips.find((clip) => clip.asset === "assets/sleep-loop.webm");

    scheduleActionSequence(sleepRule.actions, {
      runAction: (action) => controller.playAnimation(action.animation)
    });

    expect(sleepRule.actions.some((action) => action.type === "delay")).toBe(false);
    expect(controller.getCurrentClip().id).toBe(transition.id);
    expect(controller.pending).toMatchObject({ clipId: sleepLoop.id });

    vi.advanceTimersByTime(transition.durationMs);
    expect(controller.getCurrentClip().id).toBe(sleepLoop.id);
    expect(controller.getCurrentState()).toBe("playing-loop");
    vi.useRealTimers();
  });

  it.each([
    ["click-sneeze", "assets/sneeze.webm"],
    ["double-click-roll", "assets/roll.webm"],
    ["right-click-wake", "assets/stretch.webm"]
  ])("lets %s interrupt sleep immediately and return to idle", (ruleId, expectedAsset) => {
    vi.useFakeTimers();
    const manifest = createManifest();
    const renderer = { renderClip: vi.fn(), onClipStart: vi.fn() };
    const controller = new AnimationController(manifest.animations, renderer);
    const sleepLoop = manifest.animations.clips.find((clip) => clip.asset === "assets/sleep-loop.webm");
    const expectedClip = manifest.animations.clips.find((clip) => clip.asset === expectedAsset);

    controller.playAnimation(sleepLoop.id);
    expect(controller.getCurrentState()).toBe("playing-loop");
    controller.playAnimation(findRule(manifest, ruleId).actions[0].animation);

    expect(controller.getCurrentClip().id).toBe(expectedClip.id);
    vi.advanceTimersByTime(expectedClip.durationMs);
    expect(controller.getCurrentState()).toBe("default");
    expect(controller.getCurrentClip().id).toBe(manifest.animations.default.id);
    vi.useRealTimers();
  });
});
