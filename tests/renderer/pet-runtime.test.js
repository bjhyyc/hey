import { describe, expect, it, vi } from "vitest";
import {
  buildRuntimeModel,
  createStudioBehaviorRules,
  createRuleRuntime
} from "../../src/renderer/pet/pet-runtime";
import defaultsModule from "../../src/shared/defaults";

const { DEFAULT_CONFIG } = defaultsModule;

describe("pet runtime model", () => {
  it("derives the six trusted interaction rules from a Studio behavior manifest", () => {
    const clipIds = {
      idle: "70000000-0000-4000-8000-000000000001",
      sneeze: "70000000-0000-4000-8000-000000000002",
      roll: "70000000-0000-4000-8000-000000000003",
      sleepTransition: "70000000-0000-4000-8000-000000000004",
      sleepLoop: "70000000-0000-4000-8000-000000000005",
      stretch: "70000000-0000-4000-8000-000000000006",
      hoverAttention: "70000000-0000-4000-8000-000000000007"
    };
    const manifest = {
      animations: {
        default: { id: clipIds.idle, asset: "assets/idle.webm" },
        clips: Object.entries(clipIds).slice(1).map(([name, id]) => ({ id, name, asset: `assets/${name}.webm` }))
      },
      triggerRules: [],
      studioBehavior: {
        profile: "petpack-studio/v1",
        actionClipIds: clipIds,
        timing: { idleTimeoutMs: 22000, hoverDelayMs: 2000, hoverCooldownMs: 20000 }
      }
    };

    const rules = createStudioBehaviorRules(manifest);
    expect(rules).toHaveLength(6);
    expect(rules.find((rule) => rule.id === "studio-idle-sleep")).toMatchObject({
      conditions: [{ filters: [{ field: "elapsedMs", operator: ">=", value: 22000, unit: "ms" }] }],
      actions: [
        { type: "playAnimation", animation: clipIds.sleepTransition },
        { type: "playAnimation", animation: clipIds.sleepLoop }
      ]
    });
    expect(rules.find((rule) => rule.id === "studio-hover-attention")).toMatchObject({
      cooldownScope: "eventType",
      cooldownMs: 20000
    });

    const model = buildRuntimeModel({
      config: { triggerRules: [] },
      activePackage: { manifest, assetsByPath: {} }
    });
    const runtime = createRuleRuntime({ rules: model.rules });
    expect(runtime.evaluateEvent({ type: "click", timestamp: 1000 }))
      .toEqual([{ type: "playAnimation", animation: clipIds.sneeze }]);
    expect(runtime.evaluateEvent({ type: "idleDuration", timestamp: 22000, elapsedMs: 22000 }))
      .toEqual([
        { type: "playAnimation", animation: clipIds.sleepTransition },
        { type: "playAnimation", animation: clipIds.sleepLoop }
      ]);
  });

  it("does not derive Studio rules from an unknown or incomplete profile", () => {
    expect(createStudioBehaviorRules({ studioBehavior: { profile: "unknown", actionClipIds: {} } })).toEqual([]);
    expect(createStudioBehaviorRules({
      studioBehavior: { profile: "petpack-studio/v1", actionClipIds: { idle: "idle" } }
    })).toEqual([]);
  });

  it("uses package animation assets when manifest asset URLs are present", () => {
    const model = buildRuntimeModel({
      config: {},
      activePackage: {
        manifest: {
          animations: {
            default: { id: "idle", asset: "assets/idle.svg" },
            clips: [{ id: "click", asset: "assets/click.svg", type: "oneshot" }]
          }
        },
        assetsByPath: {
          "assets/idle.svg": "file:///pet/assets/idle.svg",
          "assets/click.svg": "file:///pet/assets/click.svg"
        }
      }
    });

    expect(model.animationConfig.default.asset).toBe("file:///pet/assets/idle.svg");
  });

  it("uses saved config animation bindings before package manifest animation assets", () => {
    const model = buildRuntimeModel({
      config: {
        animations: {
          default: { id: "idle", asset: "assets/custom-idle.svg" },
          clips: [{ id: "wave", asset: "assets/custom-wave.svg", type: "loop" }]
        }
      },
      activePackage: {
        manifest: {
          animations: {
            default: {
              id: "idle",
              asset: "assets/package-idle.svg",
              greenScreen: { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 }
            },
            clips: [
              {
                id: "wave",
                asset: "assets/package-wave.svg",
                type: "oneshot",
                greenScreen: { enabled: true, color: "#11ff22", tolerance: 0.4, softness: 0.12 }
              },
              { id: "look", asset: "assets/look.mp4", type: "keyframe" }
            ]
          }
        },
        assetsByPath: {
          "assets/custom-idle.svg": "file:///pet/assets/custom-idle.svg",
          "assets/package-idle.svg": "file:///pet/assets/package-idle.svg",
          "assets/custom-wave.svg": "file:///pet/assets/custom-wave.svg",
          "assets/package-wave.svg": "file:///pet/assets/package-wave.svg",
          "assets/look.mp4": "file:///pet/assets/look.mp4"
        }
      }
    });

    expect(model.animationConfig.default.greenScreen).toEqual({
      enabled: true,
      color: "#00ff00",
      tolerance: 0.35,
      softness: 0.08
    });
    expect(model.animationConfig.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "wave",
        asset: "file:///pet/assets/custom-wave.svg",
        type: "loop",
        greenScreen: { enabled: true, color: "#11ff22", tolerance: 0.4, softness: 0.12 }
      }),
      expect.objectContaining({
        id: "look",
        asset: "file:///pet/assets/look.mp4",
        type: "keyframe"
      })
    ]));
  });

  it("evaluates saved click rules and executes the selected actions", () => {
    const runtime = createRuleRuntime({
      rules: [
        {
          id: "click-wave",
          relation: "single",
          conditions: [{ type: "click", filters: [{ field: "isInsidePet", operator: "=", value: true }] }],
          actions: [{ type: "showMessage", text: "hello", durationMs: 1800 }]
        }
      ],
      now: () => 1000
    });

    const actions = runtime.evaluateEvent({ type: "click", timestamp: 1000, isInsidePet: true });

    expect(actions).toEqual([{ type: "showMessage", text: "hello", durationMs: 1800 }]);
    expect(runtime.getLastTriggeredAtByRuleId()).toEqual({ "click-wave": 1000 });
  });

  it("evaluates pomodoro completion rules", () => {
    const runtime = createRuleRuntime({
      rules: [
        {
          id: "focus-done",
          relation: "single",
          conditions: [{ type: "pomodoroComplete", filters: [{ field: "label", operator: "=", value: "Focus" }] }],
          actions: [{ type: "showMessage", text: "Focus done", durationMs: 1800 }]
        }
      ],
      now: () => 1000
    });

    const actions = runtime.evaluateEvent({
      type: "pomodoroComplete",
      timestamp: 1000,
      durationMs: 1500000,
      elapsedMs: 1500000,
      label: "Focus"
    });

    expect(actions).toEqual([{ type: "showMessage", text: "Focus done", durationMs: 1800 }]);
  });

  it("opens the panel through the default right-click trigger rule", () => {
    const rightClickRule = DEFAULT_CONFIG.triggerRules.find((rule) => rule.id === "default-right-click-panel");
    const runtime = createRuleRuntime({
      rules: DEFAULT_CONFIG.triggerRules,
      now: () => 1000
    });

    expect(rightClickRule).toMatchObject({
      enabled: true,
      conditions: [{ type: "rightClick", filters: [] }],
      actions: [{ type: "openPanel" }]
    });
    expect(runtime.evaluateEvent({ type: "rightClick", timestamp: 1000 })).toEqual([
      { type: "openPanel" }
    ]);
    expect(runtime.evaluateEvent({ type: "rightClick", timestamp: 1200 })).toEqual([]);
  });

  it("evaluates trigger filters and AND windows through the shared rule engine", () => {
    const runtime = createRuleRuntime({
      rules: [
        {
          id: "filtered-click",
          conditions: [{ type: "click", filters: [{ field: "isInsidePet", operator: "=", value: true }] }],
          cooldownMs: 500,
          priority: 1,
          actions: [{ type: "showMessage", text: "hello", durationMs: 1800 }]
        },
        {
          id: "enter-then-click",
          relation: "and",
          conditionWindowMs: 3000,
          priority: 5,
          conditions: [{ type: "mouseEnter" }, { type: "click" }],
          actions: [{ type: "showMessage", text: "combo", durationMs: 1800 }]
        }
      ],
      now: () => 1000
    });

    expect(runtime.evaluateEvent({ type: "click", timestamp: 1000, isInsidePet: true })).toEqual([
      { type: "showMessage", text: "hello", durationMs: 1800 }
    ]);
    expect(runtime.evaluateEvent({ type: "mouseEnter", timestamp: 5000 })).toEqual([]);
    expect(runtime.evaluateEvent({ type: "click", timestamp: 7000, isInsidePet: true })).toEqual([
      { type: "showMessage", text: "combo", durationMs: 1800 }
    ]);
    expect(runtime.getLastTriggeredAtByRuleId()).toEqual({
      "filtered-click": 1000,
      "enter-then-click": 7000
    });
  });
});

describe("stateful (sustained) rules", () => {
  function nearRule({ sustainMs = 3000, exitAfterMs, exitActions, exitConditions } = {}) {
    const rule = {
      id: "near-greet",
      enabled: true,
      relation: "single",
      conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }], sustainMs }],
      actions: [{ type: "playAnimation", animation: "greet" }]
    };
    const state = {};
    if (exitAfterMs !== undefined) state.exitAfterMs = exitAfterMs;
    if (exitActions) state.exitActions = exitActions;
    if (exitConditions) state.exitConditions = exitConditions;
    if (Object.keys(state).length > 0) rule.state = state;
    return rule;
  }

  function move(distance, timestamp) {
    return { type: "mouseMove", timestamp, distanceToPetCenter: distance };
  }

  function sustainMove(runtime, distance, start, end, options = {}) {
    const stepMs = options.stepMs || 300;
    const eventExtras = options.eventExtras || {};
    let actions = [];
    let timestamp = start;
    while (timestamp < end) {
      actions = runtime.evaluateEvent({ ...move(distance, timestamp), ...eventExtras });
      timestamp += stepMs;
    }
    return runtime.evaluateEvent({ ...move(distance, end), ...eventExtras });
  }

  it("does not trigger until the enter condition has held for sustainMs", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({ rules: [nearRule({ sustainMs: 3000 })], now: () => clock });

    // Condition true, but still under threshold.
    expect(sustainMove(runtime, 100, 1000, 3000)).toEqual([]);
    clock = 3999;
    expect(sustainMove(runtime, 100, 3100, 3999)).toEqual([]);

    // At 3s sustained, it fires.
    clock = 4000;
    expect(runtime.evaluateEvent(move(100, 4000))).toEqual([
      { type: "playAnimation", animation: "greet" }
    ]);
  });

  it("resets the sustain timer when the condition briefly fails", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({ rules: [nearRule({ sustainMs: 3000 })], now: () => clock });

    // Hold for 2s (under threshold), then break the condition.
    sustainMove(runtime, 100, 1000, 3000);
    // Cursor moves away — condition fails, sustain timer resets.
    clock = 3200;
    expect(runtime.evaluateEvent(move(500, 3200))).toEqual([]);

    // Now hold again. Still under threshold before 3s has elapsed.
    clock = 7199;
    expect(sustainMove(runtime, 100, 4200, 7199)).toEqual([]);
    // After 3s of continuous holding, it fires.
    clock = 7200;
    expect(runtime.evaluateEvent(move(100, 7200))).toEqual([
      { type: "playAnimation", animation: "greet" }
    ]);
  });

  it("resets mouseMove sustain timing when matching movement events are too far apart", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({ rules: [nearRule({ sustainMs: 3000 })], now: () => clock });

    sustainMove(runtime, 100, 1000, 2000);

    // The cursor has been still too long; the next movement starts a fresh
    // sustained-movement window instead of counting the still time.
    clock = 5000;
    expect(runtime.evaluateEvent(move(100, 5000))).toEqual([]);
    expect(runtime.getRuleState()["near-greet"].conditionTrueSince).toBe(5000);

    clock = 7999;
    expect(sustainMove(runtime, 100, 5300, 7999)).toEqual([]);
    clock = 8000;
    expect(runtime.evaluateEvent(move(100, 8000))).toEqual([
      { type: "playAnimation", animation: "greet" }
    ]);
  });

  it("resets mouseMove sustain timing when matching movement events are more than 300ms apart", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({ rules: [nearRule({ sustainMs: 500 })], now: () => clock });

    runtime.evaluateEvent(move(100, 1000));
    clock = 1300;
    expect(runtime.evaluateEvent(move(100, 1300))).toEqual([]);
    expect(runtime.getRuleState()["near-greet"].conditionTrueSince).toBe(1000);

    clock = 1601;
    expect(runtime.evaluateEvent(move(100, 1601))).toEqual([]);
    expect(runtime.getRuleState()["near-greet"].conditionTrueSince).toBe(1601);

    clock = 1901;
    expect(runtime.evaluateEvent(move(100, 1901))).toEqual([]);
    clock = 2101;
    expect(runtime.evaluateEvent(move(100, 2101))).toEqual([
      { type: "playAnimation", animation: "greet" }
    ]);
  });

  it("resets pending mouseMove sustain timing when dragging starts", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({ rules: [nearRule({ sustainMs: 3000 })], now: () => clock });

    runtime.evaluateEvent(move(100, 1000));
    clock = 2500;
    runtime.evaluateEvent({ type: "dragStart", timestamp: 2500, eventSource: "petRenderer" });
    expect(runtime.getRuleState()["near-greet"].conditionTrueSince).toBe(null);

    clock = 4000;
    expect(runtime.evaluateEvent(move(100, 4000))).toEqual([]);
    expect(runtime.getRuleState()["near-greet"].conditionTrueSince).toBe(4000);

    clock = 6999;
    expect(sustainMove(runtime, 100, 4300, 6999)).toEqual([]);
    clock = 7000;
    expect(runtime.evaluateEvent(move(100, 7000))).toEqual([
      { type: "playAnimation", animation: "greet" }
    ]);
  });

  it("lets callers reset pending mouseMove sustain timing after discrete interactions", () => {
    vi.useFakeTimers();
    let clock = 1000;
    const onTimerActions = vi.fn();
    const runtime = createRuleRuntime({
      rules: [nearRule({ sustainMs: 3000 })],
      now: () => clock,
      onTimerActions
    });

    try {
      runtime.evaluateEvent(move(100, 1000));
      clock = 2500;
      runtime.resetPendingMouseMoveEnters({ type: "click", timestamp: 2500, eventSource: "petRenderer" });
      expect(runtime.getRuleState()["near-greet"].conditionTrueSince).toBe(null);

      clock = 4000;
      vi.advanceTimersByTime(3000);
      expect(onTimerActions).not.toHaveBeenCalled();
    } finally {
      runtime.destroy();
      vi.useRealTimers();
    }
  });

  it("ignores legacy state.exitAfterMs without explicit exit conditions", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [nearRule({
        sustainMs: 1000,
        exitAfterMs: 3000,
        exitActions: [{ type: "playAnimation", animation: "idle" }]
      })],
      now: () => clock
    });

    // Enter: hold 1s.
    clock = 2000;
    expect(sustainMove(runtime, 100, 1000, 2000)).toEqual([
      { type: "playAnimation", animation: "greet" }
    ]);
    const stateAfterEnter = runtime.getRuleState()["near-greet"];
    expect(stateAfterEnter.active).toBe(true);

    // Move away. Legacy exitAfterMs is ignored because no explicit exit conditions are configured.
    clock = 2100;
    runtime.evaluateEvent(move(500, 2100));
    clock = 4000;
    expect(runtime.evaluateEvent(move(500, 4000))).toEqual([]);

    clock = 5100;
    expect(runtime.evaluateEvent(move(500, 5100))).toEqual([]);
    expect(runtime.getRuleState()["near-greet"].active).toBe(true);
  });

  it("runs exitActions after explicit exit conditions match for their sustainMs", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [nearRule({
        sustainMs: 1000,
        exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 3000 }],
        exitActions: [{ type: "playAnimation", animation: "idle" }]
      })],
      now: () => clock
    });

    sustainMove(runtime, 100, 1000, 2000);
    expect(runtime.getRuleState()["near-greet"].active).toBe(true);

    clock = 2500;
    runtime.evaluateEvent(move(500, 2500));
    clock = 5400;
    expect(runtime.evaluateEvent(move(500, 5400))).toEqual([]);
    clock = 5500;
    expect(runtime.evaluateEvent(move(500, 5500))).toEqual([
      { type: "playAnimation", animation: "idle" }
    ]);
  });

  it("supports OR exit conditions", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [nearRule({
        sustainMs: 1000,
        exitConditions: [
          { type: "mouseMove", required: false, filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 1000 },
          { type: "click", required: false, filters: [{ field: "isInsidePet", operator: "=", value: true }] }
        ],
        exitActions: [{ type: "playAnimation", animation: "idle" }]
      })],
      now: () => clock
    });

    sustainMove(runtime, 100, 1000, 2000);

    clock = 2500;
    expect(runtime.evaluateEvent({ type: "click", timestamp: 2500, isInsidePet: true })).toEqual([
      { type: "playAnimation", animation: "idle" }
    ]);
  });

  it("supports required exit conditions within the default condition window", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [nearRule({
        sustainMs: 1000,
        exitConditions: [
          { type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 1000 },
          { type: "click", filters: [{ field: "isInsidePet", operator: "=", value: true }] }
        ],
        exitActions: [{ type: "playAnimation", animation: "idle" }]
      })],
      now: () => clock
    });

    sustainMove(runtime, 100, 1000, 2000);

    clock = 2500;
    runtime.evaluateEvent(move(500, 2500));
    clock = 2600;
    runtime.evaluateEvent({ type: "click", timestamp: 2600, isInsidePet: true });
    clock = 3000;
    runtime.evaluateEvent(move(500, 3000));
    clock = 3600;
    expect(runtime.evaluateEvent({ type: "click", timestamp: 3600, isInsidePet: true })).toEqual([
      { type: "playAnimation", animation: "idle" }
    ]);
  });

  it("resets explicit exit timing when exit conditions stop matching", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [nearRule({
        sustainMs: 1000,
        exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 3000 }],
        exitActions: [{ type: "playAnimation", animation: "idle" }]
      })],
      now: () => clock
    });

    sustainMove(runtime, 100, 1000, 2000);

    // Start exit timing, then return before it reaches 3s.
    clock = 2500;
    runtime.evaluateEvent(move(500, 2500));
    clock = 4000;
    runtime.evaluateEvent(move(100, 4000));

    // Exit timing restarts from 4500, so 7000 is still under threshold.
    clock = 4500;
    runtime.evaluateEvent(move(500, 4500));
    clock = 7000;
    expect(runtime.evaluateEvent(move(500, 7000))).toEqual([]);
    clock = 7500;
    expect(runtime.evaluateEvent(move(500, 7500))).toEqual([
      { type: "playAnimation", animation: "idle" }
    ]);
  });

  it("defaults to stopAnimation when exitActions is not configured", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [nearRule({
        sustainMs: 1000,
        exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 1000 }]
      })],
      now: () => clock
    });

    sustainMove(runtime, 100, 1000, 2000);

    // Break condition and wait past the exit condition sustainMs.
    clock = 2100;
    runtime.evaluateEvent(move(500, 2100));
    clock = 3200;
    expect(runtime.evaluateEvent(move(500, 3200))).toEqual([{ type: "stopAnimation" }]);
  });

  it("suppresses competing non-stateful rules while a stateful rule is active", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [
        nearRule({ sustainMs: 1000 }),
        {
          id: "click-wave",
          enabled: true,
          relation: "single",
          priority: 10,
          conditions: [{ type: "click", filters: [{ field: "isInsidePet", operator: "=", value: true }] }],
          actions: [{ type: "playAnimation", animation: "wave" }]
        }
      ],
      now: () => clock
    });

    // Activate the stateful rule.
    sustainMove(runtime, 100, 1000, 2000);
    expect(runtime.getRuleState()["near-greet"].active).toBe(true);

    // While active, a click (even higher priority) is suppressed.
    clock = 2500;
    expect(runtime.evaluateEvent({ type: "click", timestamp: 2500, isInsidePet: true })).toEqual([]);
  });

  it("does not enter a sustained mouseMove rule from unrelated timer events", () => {
    vi.useFakeTimers();
    let clock = 1000;
    const onTimerActions = vi.fn();
    const runtime = createRuleRuntime({
      rules: [{
        id: "sustained-scrub",
        enabled: true,
        relation: "single",
        continuous: true,
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }], sustainMs: 3000 }],
        actions: [{ type: "setKeyframeProgress", animation: "look", progressFrom: "angleToPetProgress" }],
        state: {
          exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">", value: 400 }], sustainMs: 5000 }],
          exitActions: [{ type: "playAnimation", animation: "idle" }]
        }
      }],
      now: () => clock,
      onTimerActions
    });

    try {
      runtime.evaluateEvent({
        ...move(100, 1000),
        eventSource: "globalMouse",
        angleToPetProgress: 0.25
      });
      clock = 2000;
      runtime.evaluateEvent({ type: "idleDuration", eventSource: "timer", timestamp: 2000, elapsedMs: 1000 });
      expect(runtime.getRuleState()["sustained-scrub"].conditionTrueSince).toBe(1000);

      clock = 4000;
      vi.advanceTimersByTime(3000);
      expect(onTimerActions).not.toHaveBeenCalled();
      expect(runtime.getRuleState()["sustained-scrub"].active).toBe(false);
    } finally {
      runtime.destroy();
      vi.useRealTimers();
    }
  });

  it("targets timer events to a single timer rule", () => {
    const runtime = createRuleRuntime({
      rules: [
        {
          id: "random-a",
          conditions: [{ type: "randomTimer", minMs: 1000, maxMs: 2000 }],
          actions: [{ type: "showMessage", text: "A" }],
          stopOnMatch: false
        },
        {
          id: "random-b",
          conditions: [{ type: "randomTimer", minMs: 9000, maxMs: 12000 }],
          actions: [{ type: "showMessage", text: "B" }],
          stopOnMatch: false
        }
      ]
    });

    expect(runtime.evaluateEvent({
      type: "randomTimer",
      timerRuleId: "random-a",
      timestamp: 1000,
      eventSource: "timer"
    })).toEqual([{ type: "showMessage", text: "A" }]);
  });

  it("does not reset active mouseMove exit timing on unrelated timer events", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [nearRule({
        sustainMs: 1000,
        exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 3000 }],
        exitActions: [{ type: "playAnimation", animation: "idle" }]
      })],
      now: () => clock
    });

    sustainMove(runtime, 100, 1000, 2000);
    clock = 2500;
    runtime.evaluateEvent(move(500, 2500));
    clock = 3000;
    runtime.evaluateEvent({ type: "idleDuration", eventSource: "timer", timestamp: 3000, elapsedMs: 1000 });
    expect(runtime.getRuleState()["near-greet"].exitTrueSince).toBe(2500);

    clock = 5500;
    expect(runtime.evaluateEvent(move(500, 5500))).toEqual([
      { type: "playAnimation", animation: "idle" }
    ]);
  });

  it("ignores pet-renderer mouseMove for keyframe state rules so global mouse can trigger them", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [{
        id: "global-keyframe",
        enabled: true,
        relation: "single",
        continuous: true,
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }] }],
        actions: [{ type: "setKeyframeProgress", animation: "look", progressFrom: "angleToPetProgress" }],
        state: {
          exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">", value: 400 }], sustainMs: 1000 }],
          exitActions: [{ type: "playAnimation", animation: "idle" }]
        }
      }],
      now: () => clock
    });

    // Local renderer mousemove has no angleToPetProgress and must not enter the
    // keyframe state, otherwise the later global mouse event would be ignored or
    // its action would be blocked by the action executor.
    expect(runtime.evaluateEvent({ ...move(100, 1000), eventSource: "petRenderer" })).toEqual([]);
    expect(runtime.getRuleState()["global-keyframe"]).toBeUndefined();

    clock = 1100;
    expect(runtime.evaluateEvent({
      ...move(100, 1100),
      eventSource: "globalMouse",
      angleToPetProgress: 0.25
    })).toEqual([
      { type: "setKeyframeProgress", animation: "look", progressFrom: "angleToPetProgress" }
    ]);
    expect(runtime.getRuleState()["global-keyframe"].active).toBe(true);
  });

  it("does not enter sustained mouseMove state from the timer when the cursor stops moving", () => {
    vi.useFakeTimers();
    let clock = 1000;
    const onTimerActions = vi.fn();
    const runtime = createRuleRuntime({
      rules: [{
        id: "sustained-scrub",
        enabled: true,
        relation: "single",
        continuous: true,
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }], sustainMs: 3000 }],
        actions: [{ type: "setKeyframeProgress", animation: "look", progressFrom: "angleToPetProgress" }],
        state: {
          exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">", value: 400 }], sustainMs: 5000 }],
          exitActions: [{ type: "playAnimation", animation: "idle" }]
        }
      }],
      now: () => clock,
      onTimerActions
    });

    try {
      expect(runtime.evaluateEvent({
        ...move(100, 1000),
        eventSource: "globalMouse",
        angleToPetProgress: 0.25
      })).toEqual([]);

      clock = 4000;
      vi.advanceTimersByTime(3000);

      expect(onTimerActions).not.toHaveBeenCalled();
      expect(runtime.getRuleState()["sustained-scrub"].active).toBe(false);
    } finally {
      runtime.destroy();
      vi.useRealTimers();
    }
  });

  it("re-emits continuous keyframe actions on every matching mouseMove while active", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [{
        id: "instant-near",
        enabled: true,
        relation: "single",
        continuous: true,
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }] }],
        actions: [{ type: "setKeyframeProgress", animation: "look" }],
        state: {
          exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">", value: 400 }], sustainMs: 5000 }],
          exitActions: [{ type: "playAnimation", animation: "idle" }]
        }
      }],
      now: () => clock
    });

    // First matching event enters the state and emits the action once.
    expect(runtime.evaluateEvent({ ...move(100, 1000), eventSource: "globalMouse" })).toEqual([
      { type: "setKeyframeProgress", animation: "look" }
    ]);
    // Subsequent matching events re-emit the action so the keyframe clip
    // follows the cursor instead of freezing on the first frame.
    clock = 1500;
    expect(runtime.evaluateEvent({ ...move(120, 1500), eventSource: "globalMouse" })).toEqual([
      { type: "setKeyframeProgress", animation: "look" }
    ]);
    clock = 2000;
    expect(runtime.evaluateEvent({ ...move(80, 2000), eventSource: "globalMouse" })).toEqual([
      { type: "setKeyframeProgress", animation: "look" }
    ]);
  });

  it("keeps re-emitting continuous actions while active in the enter-exit hysteresis band", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [{
        id: "hysteresis-scrub",
        enabled: true,
        relation: "single",
        continuous: true,
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }] }],
        actions: [{ type: "setKeyframeProgress", animation: "look", progressFrom: "angleToPetProgress" }],
        state: {
          exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">", value: 400 }], sustainMs: 5000 }],
          exitActions: [{ type: "playAnimation", animation: "idle" }]
        }
      }],
      now: () => clock
    });

    expect(runtime.evaluateEvent({
      ...move(100, 1000),
      eventSource: "globalMouse",
      angleToPetProgress: 0.2
    })).toEqual([
      { type: "setKeyframeProgress", animation: "look", progressFrom: "angleToPetProgress" }
    ]);

    clock = 1500;
    expect(runtime.evaluateEvent({
      ...move(350, 1500),
      eventSource: "globalMouse",
      angleToPetProgress: 0.7
    })).toEqual([
      { type: "setKeyframeProgress", animation: "look", progressFrom: "angleToPetProgress" }
    ]);
    expect(runtime.getRuleState()["hysteresis-scrub"].active).toBe(true);
  });

  it("does not re-emit actions for sustained (non-continuous) stateful rules after enter", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [{
        id: "sustained-near",
        enabled: true,
        relation: "single",
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }], sustainMs: 1000 }],
        actions: [{ type: "playAnimation", animation: "greet" }],
        state: {
          exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 1000 }],
          exitActions: [{ type: "playAnimation", animation: "idle" }]
        }
      }],
      now: () => clock
    });

    clock = 2000;
    expect(sustainMove(runtime, 100, 1000, 2000)).toEqual([
      { type: "playAnimation", animation: "greet" }
    ]);
    // Still matching while active — sustained rules fire only once on enter.
    clock = 3000;
    expect(runtime.evaluateEvent(move(100, 3000))).toEqual([]);
  });

  it("runs exitActions for mouseMove rules that have exit state but no enter sustainMs", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [{
        id: "instant-near",
        enabled: true,
        relation: "single",
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }] }],
        actions: [{ type: "setKeyframeProgress", animation: "look" }],
        state: {
          exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">", value: 400 }], sustainMs: 5000 }],
          exitActions: [{ type: "playAnimation", animation: "idle" }]
        }
      }],
      now: () => clock
    });

    expect(runtime.evaluateEvent({ ...move(100, 1000), eventSource: "globalMouse" })).toEqual([
      { type: "setKeyframeProgress", animation: "look" }
    ]);
    expect(runtime.getRuleState()["instant-near"].active).toBe(true);

    clock = 2000;
    expect(runtime.evaluateEvent({ ...move(500, 2000), eventSource: "globalMouse" })).toEqual([]);
    clock = 6999;
    expect(runtime.evaluateEvent({ ...move(500, 6999), eventSource: "globalMouse" })).toEqual([]);
    clock = 7000;
    expect(runtime.evaluateEvent({ ...move(500, 7000), eventSource: "globalMouse" })).toEqual([
      { type: "playAnimation", animation: "idle" }
    ]);
    expect(runtime.getRuleState()["instant-near"].active).toBe(false);
  });

  it("runs exitActions when an active mouseMove rule matches a mouseStill exit condition", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [{
        id: "near-until-still",
        enabled: true,
        relation: "single",
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }] }],
        actions: [{ type: "playAnimation", animation: "look" }],
        state: {
          exitConditions: [{ type: "mouseStill", filters: [{ field: "durationMs", operator: ">=", value: 3000 }] }],
          exitActions: [{ type: "playAnimation", animation: "idle" }]
        }
      }],
      now: () => clock
    });

    expect(runtime.evaluateEvent({ ...move(100, 1000), eventSource: "globalMouse" })).toEqual([
      { type: "playAnimation", animation: "look" }
    ]);
    expect(runtime.getRuleState()["near-until-still"].active).toBe(true);

    clock = 4000;
    expect(runtime.evaluateEvent({
      ...move(100, 1000),
      type: "mouseStill",
      timestamp: 4000,
      eventSource: "globalMouse",
      durationMs: 3000
    })).toEqual([
      { type: "playAnimation", animation: "idle" }
    ]);
    expect(runtime.getRuleState()["near-until-still"].active).toBe(false);
  });

  it("dispatches timer-driven exit actions through the runtime callback", () => {
    vi.useFakeTimers();
    let clock = 1000;
    const onTimerActions = vi.fn();
    const runtime = createRuleRuntime({
      rules: [nearRule({
        sustainMs: 1000,
        exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 1000 }],
        exitActions: [{ type: "playAnimation", animation: "idle" }]
      })],
      now: () => clock,
      onTimerActions
    });

    try {
      clock = 2000;
      sustainMove(runtime, 100, 1000, 2000);
      clock = 2100;
      runtime.evaluateEvent(move(500, 2100));
      clock = 3100;
      vi.advanceTimersByTime(1000);

      expect(onTimerActions).toHaveBeenCalledWith(
        [{ type: "playAnimation", animation: "idle" }],
        expect.objectContaining({ type: "mouseMove", ruleId: "near-greet", stateTransition: "exit", timestamp: 3100 })
      );
      expect(runtime.evaluateEvent(move(500, 3200))).toEqual([]);
    } finally {
      runtime.destroy();
      vi.useRealTimers();
    }
  });

  it("leaves non-stateful rules unaffected when no state field is present", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [
        {
          id: "plain-click",
          enabled: true,
          relation: "single",
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "showMessage", text: "hi" }]
        }
      ],
      now: () => clock
    });

    expect(runtime.evaluateEvent({ type: "click", timestamp: 1000, isInsidePet: true })).toEqual([
      { type: "showMessage", text: "hi" }
    ]);
  });

  it("stops after the highest-priority matched rule by default", () => {
    const runtime = createRuleRuntime({
      rules: [
        {
          id: "low-click",
          enabled: true,
          priority: 1,
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "showMessage", text: "low" }]
        },
        {
          id: "high-click",
          enabled: true,
          priority: 10,
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "showMessage", text: "high" }]
        }
      ],
      now: () => 1000
    });

    expect(runtime.evaluateEvent({ type: "click", timestamp: 1000, isInsidePet: true })).toEqual([
      { type: "showMessage", text: "high" }
    ]);
    expect(runtime.getLastTriggeredAtByRuleId()).toEqual({ "high-click": 1000 });
  });

  it("continues to lower-priority matched rules when stopOnMatch is false", () => {
    const runtime = createRuleRuntime({
      rules: [
        {
          id: "low-click",
          enabled: true,
          priority: 1,
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "showMessage", text: "low" }]
        },
        {
          id: "high-click",
          enabled: true,
          priority: 10,
          stopOnMatch: false,
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "showMessage", text: "high" }]
        }
      ],
      now: () => 1000
    });

    expect(runtime.evaluateEvent({ type: "click", timestamp: 1000, isInsidePet: true })).toEqual([
      { type: "showMessage", text: "high" },
      { type: "showMessage", text: "low" }
    ]);
    expect(runtime.getLastTriggeredAtByRuleId()).toEqual({
      "high-click": 1000,
      "low-click": 1000
    });
  });

  it("applies the triggering rule cooldown to lower-priority rules", () => {
    let clock = 1000;
    const runtime = createRuleRuntime({
      rules: [
        {
          id: "cooling-high",
          enabled: true,
          priority: 10,
          stopOnMatch: false,
          cooldownMs: 5000,
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "showMessage", text: "high" }]
        },
        {
          id: "low-click",
          enabled: true,
          priority: 1,
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "showMessage", text: "low" }]
        }
      ],
      now: () => clock
    });

    runtime.evaluateEvent({ type: "click", timestamp: 1000, isInsidePet: true });
    clock = 2000;

    expect(runtime.evaluateEvent({ type: "click", timestamp: 2000, isInsidePet: true })).toEqual([]);
    expect(runtime.getLastTriggeredAtByRuleId()).toEqual({
      "cooling-high": 1000,
      "low-click": 1000
    });
  });

  it("does not let hover cooldown delay the 22-second idle rule", () => {
    const runtime = createRuleRuntime({
      rules: [
        {
          id: "hover",
          enabled: true,
          cooldownMs: 30000,
          cooldownScope: "eventType",
          conditions: [{ type: "hoverDuration", filters: [{ field: "elapsedMs", operator: ">=", value: 2000 }] }],
          actions: [{ type: "playAnimation", animation: "hover" }]
        },
        {
          id: "sleep",
          enabled: true,
          conditions: [{ type: "idleDuration", filters: [{ field: "elapsedMs", operator: ">=", value: 22000 }] }],
          actions: [{ type: "playAnimation", animation: "sleep-transition" }]
        }
      ]
    });

    expect(runtime.evaluateEvent({ type: "hoverDuration", timestamp: 2000, elapsedMs: 2000 })).toHaveLength(1);
    expect(runtime.evaluateEvent({ type: "idleDuration", timestamp: 22000, elapsedMs: 22000 })).toEqual([
      { type: "playAnimation", animation: "sleep-transition" }
    ]);
  });

  it.each(["click", "doubleClick", "rightClick"])(
    "lets direct %s interaction bypass an unrelated hover cooldown",
    (eventType) => {
      const runtime = createRuleRuntime({
        rules: [
          {
            id: "hover",
            enabled: true,
            cooldownMs: 30000,
            cooldownScope: "eventType",
            conditions: [{ type: "hoverDuration", filters: [{ field: "elapsedMs", operator: ">=", value: 2000 }] }],
            actions: [{ type: "playAnimation", animation: "hover" }]
          },
          {
            id: `direct-${eventType}`,
            enabled: true,
            conditions: [{ type: eventType, filters: [] }],
            actions: [{ type: "playAnimation", animation: eventType }]
          }
        ]
      });

      runtime.evaluateEvent({ type: "hoverDuration", timestamp: 2000, elapsedMs: 2000 });
      expect(runtime.evaluateEvent({ type: eventType, timestamp: 3000 })).toEqual([
        { type: "playAnimation", animation: eventType }
      ]);
    }
  );

  it("applies cooldown to repeated hoverDuration timer events", () => {
    const runtime = createRuleRuntime({
      rules: [
        {
          id: "hover-message",
          enabled: true,
          cooldownMs: 5000,
          conditions: [{ type: "hoverDuration", filters: [{ field: "elapsedMs", operator: ">=", value: 1000 }] }],
          actions: [{ type: "showMessage", text: "hovering" }]
        }
      ],
      now: () => 1000
    });

    expect(runtime.evaluateEvent({ type: "hoverDuration", timestamp: 1000, eventSource: "timer", elapsedMs: 1000 })).toEqual([
      { type: "showMessage", text: "hovering" }
    ]);
    expect(runtime.evaluateEvent({ type: "hoverDuration", timestamp: 1500, eventSource: "timer", elapsedMs: 1500 })).toEqual([]);
    expect(runtime.evaluateEvent({ type: "hoverDuration", timestamp: 5999, eventSource: "timer", elapsedMs: 5999 })).toEqual([]);
    expect(runtime.evaluateEvent({ type: "hoverDuration", timestamp: 6000, eventSource: "timer", elapsedMs: 6000 })).toEqual([
      { type: "showMessage", text: "hovering" }
    ]);
  });
});
