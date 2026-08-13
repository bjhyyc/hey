import { describe, expect, it } from "vitest";
import {
  FIELD_INPUT_TYPES,
  TRIGGER_PARAMETER_FIELDS,
  buildRuleConditionFromForm,
  buildRuleFromForm,
  deleteConfigRule,
  getPanelOverviewStats,
  getFieldsForCondition,
  updateConfigDisplay,
  updateConfigInteractions,
  removeConfigAssetReferences,
  updateConfigRule,
  updateConfigSystem,
  validateRuleForm
} from "../../src/renderer/panel/panel-state";
import schema from "../../src/shared/schema";

describe("panel state helpers", () => {
  it("updates display settings without dropping existing config fields", () => {
    const config = {
      currentPackageId: "default-pet",
      display: { x: 10, y: 20, scale: 1, opacity: 1, alwaysOnTop: true },
      system: { language: "zh-CN" },
      metadata: { author: "tao" },
      triggerRules: [{ id: "on-click" }]
    };

    const nextConfig = updateConfigDisplay(config, {
      scale: 1.25,
      opacity: 0.8,
      alwaysOnTop: false,
      mousePassthrough: true
    });

    expect(nextConfig).toEqual({
      ...config,
      display: {
        x: 10,
        y: 20,
        scale: 1.25,
        opacity: 0.8,
        alwaysOnTop: false,
        mousePassthrough: true
      }
    });
    expect(nextConfig).not.toBe(config);
    expect(nextConfig.display).not.toBe(config.display);
  });

  it("removes asset references from animations", () => {
    const nextConfig = removeConfigAssetReferences({
      animations: {
        default: { id: "idle", asset: "assets/idle.svg" },
        clips: [
          { id: "click", asset: "assets/click.svg", type: "oneshot" },
          { id: "wave", asset: "assets/wave.webm", type: "oneshot" }
        ]
      }
    }, "assets/idle.svg");

    expect(nextConfig.animations.default).toEqual({ id: "idle" });
    expect(nextConfig.animations.clips[0]).toEqual({ id: "click", asset: "assets/click.svg", type: "oneshot" });
  });

  it("summarizes overview counts from the current panel config", () => {
    const stats = getPanelOverviewStats({
      currentPackageId: "space-cat",
      animations: {
        default: { id: "idle", asset: "assets/idle.webm" },
        clips: [
          { id: "click", asset: "assets/click.webm", type: "oneshot" },
          { id: "wave", asset: "assets/wave.webm", type: "oneshot" }
        ]
      },
      triggerRules: [{ id: "on-click" }],
      display: { scale: 1.25 },
      system: { launchAtLogin: true }
    });

    expect(stats).toEqual({
      packageId: "space-cat",
      animationCount: 3, // default + 2 clips
      ruleCount: 1,
      assetCount: 3,
      displayScalePercent: 125,
      launchAtLogin: true
    });
  });

  it("updates system settings without leaving saved panel config stale", () => {
    const config = {
      currentPackageId: "default-pet",
      system: { language: "zh-CN", launchAtLogin: false },
      display: { scale: 1 }
    };

    const nextConfig = updateConfigSystem(config, { launchAtLogin: true });

    expect(nextConfig).toEqual({
      ...config,
      system: { language: "zh-CN", launchAtLogin: true }
    });
    expect(nextConfig).not.toBe(config);
    expect(nextConfig.system).not.toBe(config.system);
  });

  it("updates interaction messages and bubble settings without dropping defaults", () => {
    const nextConfig = updateConfigInteractions({
      interactions: {
        clickMessages: ["Hello"],
        randomMessages: ["Idle"],
        bubble: { maxWidth: 220, durationMs: 1800, showCloseButton: false }
      }
    }, {
      timedMessages: ["Time"],
      bubble: { maxWidth: 280 }
    });

    expect(nextConfig.interactions).toEqual({
      clickMessages: ["Hello"],
      randomMessages: ["Idle"],
      timedMessages: ["Time"],
      bubble: { maxWidth: 280, durationMs: 1800, showCloseButton: false }
    });
  });

  it("builds trigger rules with condition filters and inline actions", () => {
    const rule = buildRuleFromForm({
      id: "rule-1",
      name: "Fast approach",
      enabled: true,
      relation: "and",
      andWindowMs: "2500",
      cooldownMs: "800",
      priority: "42",
      conditionType: "mouseMove",
      filterField: "speed",
      filterOperator: ">",
      filterValue: "100",
      filterUnit: "px/s",
      actionStrategy: "random",
      actions: [
        { type: "playAnimation", animation: "wave", durationMs: 900 },
        { type: "showMessage", text: "Hello!", durationMs: 1800 }
      ]
    });

    expect(rule).toEqual({
      id: "rule-1",
      name: "Fast approach",
      enabled: true,
      cooldownMs: 800,
      priority: 42,
      conditions: [
        {
          type: "mouseMove",
          required: true,
          filters: [{ field: "speed", operator: ">", value: 100 }]
        }
      ],
      actionStrategy: "random",
      actions: [
        { type: "playAnimation", animation: "wave", durationMs: 900 },
        { type: "showMessage", text: "Hello!", durationMs: 1800 }
      ]
    });

    const nextConfig = updateConfigRule({}, rule);
    expect(nextConfig.triggerRules).toEqual([rule]);
  });

  it("only marks keyframe progress rules continuous when they are driven by mouseMove", () => {
    const hoverRule = buildRuleFromForm({
      id: "hover-progress",
      name: "Hover progress",
      enabled: true,
      cooldownMs: "5000",
      priority: "1",
      conditionType: "hoverDuration",
      filterField: "elapsedMs",
      filterOperator: ">=",
      filterValue: "1000",
      actionStrategy: "sequence",
      actions: [{ type: "setKeyframeProgress", animation: "look", progress: 0.5 }]
    });
    const mouseMoveRule = buildRuleFromForm({
      id: "mouse-progress",
      name: "Mouse progress",
      enabled: true,
      cooldownMs: "5000",
      priority: "1",
      conditionType: "mouseMove",
      filterField: "distanceToPetCenter",
      filterOperator: "<",
      filterValue: "300",
      actionStrategy: "sequence",
      actions: [{ type: "setKeyframeProgress", animation: "look", progress: 0.5 }]
    });

    expect(hoverRule.continuous).toBeUndefined();
    expect(mouseMoveRule.continuous).toBe(true);
  });

  it("normalizes condition filter values according to field type", () => {
    expect(buildRuleConditionFromForm({
      type: "mouseMove",
      field: "isInsidePet",
      operator: ">",
      value: "true"
    })).toEqual({
      type: "mouseMove",
      required: true,
      filters: [{ field: "isInsidePet", operator: "=", value: true }]
    });

    expect(buildRuleConditionFromForm({
      type: "mouseMove",
      field: "speed",
      operator: "in",
      value: "100, 150"
    }).filters[0]).toEqual({ field: "speed", operator: "in", value: [100, 150] });

    expect(buildRuleConditionFromForm({
      type: "mouseMove",
      field: "direction",
      operator: "in",
      value: "left,right"
    }).filters[0]).toEqual({ field: "direction", operator: "in", value: ["left", "right"] });

    expect(buildRuleConditionFromForm({
      type: "click",
      field: "petPosition",
      operator: "=",
      value: "{x:1}"
    }).filters).toEqual([]);
  });

  it("omits stopOnMatch when enabled and stores false when disabled", () => {
    const enabledRule = buildRuleFromForm({
      id: "rule-stop-default",
      name: "Default stop",
      enabled: true,
      stopOnMatch: true,
      actionStrategy: "sequence",
      actions: [{ type: "showMessage", text: "hi" }]
    });
    const disabledRule = buildRuleFromForm({
      id: "rule-continue",
      name: "Continue matching",
      enabled: true,
      stopOnMatch: false,
      actionStrategy: "sequence",
      actions: [{ type: "showMessage", text: "hi" }]
    });

    expect(enabledRule.stopOnMatch).toBeUndefined();
    expect(disabledRule.stopOnMatch).toBe(false);
  });

  it("builds a sustained-state rule with exit actions when sustain/exit timing is set", () => {
    const rule = buildRuleFromForm({
      id: "rule-near",
      name: "Near pet",
      enabled: true,
      relation: "single",
      andWindowMs: "3000",
      cooldownMs: "0",
      priority: "1",
      conditionType: "mouseMove",
      filterField: "distanceToPetCenter",
      filterOperator: "<",
      filterValue: "300",
      actionStrategy: "sequence",
      actions: [{ type: "playAnimation", animation: "greet", durationMs: 900 }],
      conditionSustainMs: "3000",
      exitRelation: "single",
      exitAndWindowMs: "3000",
      exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 3000 }],
      exitActions: [{ type: "playAnimation", animation: "idle", durationMs: 900 }]
    });

    expect(rule.conditions[0]).toEqual({
      type: "mouseMove",
      required: true,
      filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }],
      sustainMs: 3000
    });
    expect(rule.state).toEqual({
      exitConditions: [{ type: "mouseMove", required: true, filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 3000 }],
      exitActions: [{ type: "playAnimation", animation: "idle", durationMs: 900 }]
    });
  });

  it("omits the state block when no sustain/exit timing or exit actions are configured", () => {
    const rule = buildRuleFromForm({
      id: "rule-plain",
      name: "Plain",
      enabled: true,
      relation: "single",
      actionStrategy: "sequence",
      actions: [{ type: "playAnimation", animation: "wave", durationMs: 900 }],
      exitActions: []
    });

    expect(rule.state).toBeUndefined();
  });

  it("omits exit state for non-mouseMove trigger rules even if exit fields are present", () => {
    const rule = buildRuleFromForm({
      id: "rule-click-exit",
      name: "Click exit ignored",
      enabled: true,
      relation: "single",
      conditions: [{ type: "click", filters: [] }],
      actionStrategy: "sequence",
      actions: [{ type: "playAnimation", animation: "wave", durationMs: 900 }],
      exitRelation: "single",
      exitConditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: ">=", value: 300 }], sustainMs: 3000 }],
      exitActions: [{ type: "playAnimation", animation: "idle", durationMs: 900 }]
    });

    expect(rule.state).toBeUndefined();
  });

  it("deletes trigger rules by id", () => {
    const nextConfig = deleteConfigRule({
      triggerRules: [{ id: "keep" }, { id: "delete-me" }]
    }, "delete-me");

    expect(nextConfig.triggerRules).toEqual([{ id: "keep" }]);
  });

  it("builds trigger rules with multiple conditions and per-condition filters", () => {
    const rule = buildRuleFromForm({
      id: "rule-2",
      name: "Enter then fast click",
      enabled: true,
      relation: "and",
      andWindowMs: "3500",
      cooldownMs: "900",
      priority: "7",
      conditions: [
        {
          type: "mouseMove",
          filters: [{ field: "isInsidePet", operator: "=", value: "true" }]
        },
        {
          type: "click",
          filters: [{ field: "distanceToPetCenter", operator: "<=", value: "24" }]
        }
      ],
      actionStrategy: "sequence",
      actions: [
        { type: "playAnimation", animation: "wave", durationMs: 900 }
      ]
    });

    expect(rule).toEqual({
      id: "rule-2",
      name: "Enter then fast click",
      enabled: true,
      cooldownMs: 900,
      priority: 7,
      conditions: [
        {
          type: "mouseMove",
          required: true,
          filters: [{ field: "isInsidePet", operator: "=", value: true }]
        },
        {
          type: "click",
          required: true,
          filters: [{ field: "distanceToPetCenter", operator: "<=", value: 24 }]
        }
      ],
      actionStrategy: "sequence",
      actions: [
        { type: "playAnimation", animation: "wave", durationMs: 900 }
      ]
    });
  });

  it("builds rule conditions without filters when no filter field is selected", () => {
    expect(buildRuleConditionFromForm({
      type: "click",
      field: "",
      operator: "=",
      value: "",
      unit: ""
    })).toEqual({
      type: "click",
      required: true,
      filters: []
    });
  });

  it("builds random timer interval settings as dedicated condition fields", () => {
    expect(buildRuleConditionFromForm({
      type: "randomTimer",
      minMs: "3000",
      maxMs: "9000"
    })).toEqual({
      type: "randomTimer",
      required: true,
      filters: [],
      minMs: 3000,
      maxMs: 9000
    });
  });

  it("builds timer interval settings as dedicated condition fields", () => {
    expect(buildRuleConditionFromForm({
      type: "timer",
      intervalMs: "7000"
    })).toEqual({
      type: "timer",
      required: true,
      filters: [],
      intervalMs: 7000
    });
  });

  it("describes expected input controls for trigger fields", () => {
    expect(FIELD_INPUT_TYPES).toMatchObject({
      isInsidePet: "boolean",
      isMovingTowardPet: "boolean",
      distanceToPetCenter: "number",
      distanceToPetBounds: "number",
      speed: "number",
      direction: "select",
      durationMs: "number",
      dragDistance: "number",
      dragDurationMs: "number"
    });
  });

  it("keeps the panel trigger browser aligned with the shared schema", () => {
    expect(TRIGGER_PARAMETER_FIELDS).toEqual(schema.TRIGGER_PARAMETER_FIELDS);
  });

  it("does not expose internal event source as a rule filter field", () => {
    Object.values(TRIGGER_PARAMETER_FIELDS).forEach((fields) => {
      expect(fields).not.toContain("eventSource");
    });
  });

  it("only exposes scalar fields that can actually filter the selected condition", () => {
    Object.values(TRIGGER_PARAMETER_FIELDS).forEach((fields) => {
      fields.forEach((field) => {
        expect(FIELD_INPUT_TYPES[field]).not.toBe("object");
      });
    });

    ["click", "doubleClick", "rightClick", "mouseEnter", "mouseLeave", "dragStart"].forEach((type) => {
      expect(getFieldsForCondition(type)).not.toContain("isInsidePet");
      expect(getFieldsForCondition(type)).not.toContain("distanceToPetBounds");
    });

    expect(getFieldsForCondition("dragStart")).not.toEqual(expect.arrayContaining([
      "dragDeltaX",
      "dragDeltaY",
      "dragDistance",
      "dragDurationMs"
    ]));

    expect(getFieldsForCondition("mouseMove")).toEqual(expect.arrayContaining([
      "isInsidePet",
      "distanceToPetCenter",
      "distanceToPetBounds",
      "speed",
      "direction"
    ]));
    expect(getFieldsForCondition("mouseStill")).toEqual(expect.arrayContaining([
      "isInsidePet",
      "distanceToPetCenter",
      "distanceToPetBounds",
      "durationMs"
    ]));
    expect(getFieldsForCondition("dragging")).toEqual(expect.arrayContaining([
      "isInsidePet",
      "distanceToPetBounds",
      "dragDistance",
      "dragDurationMs"
    ]));
    expect(getFieldsForCondition("dragEnd")).toEqual(expect.arrayContaining([
      "isInsidePet",
      "distanceToPetBounds",
      "dragDistance",
      "dragDurationMs"
    ]));
  });

  it("limits filter fields to the selected condition type", () => {
    expect(getFieldsForCondition("click")).toContain("distanceToPetCenter");
    expect(getFieldsForCondition("click")).not.toContain("isInsidePet");
    expect(getFieldsForCondition("click")).not.toContain("speed");
    expect(getFieldsForCondition("mouseMove")).toContain("speed");
    expect(getFieldsForCondition("mouseStill")).toContain("durationMs");
    expect(getFieldsForCondition("hoverDuration")).toEqual(["elapsedMs"]);
    // Timer scheduling values are dedicated condition settings, not filterable fields.
    expect(getFieldsForCondition("timer")).not.toContain("intervalMs");
    expect(getFieldsForCondition("randomTimer")).toEqual(expect.not.arrayContaining(["minMs", "maxMs"]));
    expect(getFieldsForCondition("timer")).toEqual(["currentHour", "dayOfWeek"]);
    expect(getFieldsForCondition("randomTimer")).toEqual(["currentHour", "dayOfWeek"]);
    expect(getFieldsForCondition("appLaunch")).toEqual([]);
    expect(getFieldsForCondition("packageLoaded")).toEqual([]);
    expect(getFieldsForCondition("unknown")).toEqual([]);
  });

  it("rejects rules with invalid condition fields or missing actions", () => {
    expect(validateRuleForm({
      conditionType: "click",
      filterField: "speed",
      actions: [{ type: "playAnimation", animation: "wave" }]
    })).toEqual(["Field speed is not supported by click."]);

    expect(validateRuleForm({
      conditionType: "click",
      filterField: "distanceToPetCenter",
      actions: []
    })).toEqual(["At least one action is required."]);
  });
});

import { normalizeKeyframes, updateConfigAnimationKeyframes } from "../../src/renderer/panel/panel-state";

describe("keyframe helpers", () => {
  it("normalizes keyframe input/output mappings and falls back to defaults", () => {
    expect(normalizeKeyframes([])).toEqual([
      { input: 0, output: 0 },
      { input: 0.25, output: 0.25 },
      { input: 0.5, output: 0.5 },
      { input: 0.75, output: 0.75 }
    ]);
    expect(normalizeKeyframes([0.8, -1, 2, "0.2", "bad"])).toEqual([
      { input: 0, output: 0.8 },
      { input: 0.2, output: 0 },
      { input: 0.4, output: 1 },
      { input: 0.6, output: 0.2 }
    ]);
    expect(normalizeKeyframes([{ input: 0.5, output: 0.1 }, { input: 0, output: 0.9 }])).toEqual([
      { input: 0, output: 0.9 },
      { input: 0.5, output: 0.1 }
    ]);
  });

  it("updates animation keyframes by clip id", () => {
    const nextConfig = updateConfigAnimationKeyframes({
      animations: {
        default: { id: "idle", asset: "assets/idle.svg" },
        clips: [
          { id: "look", type: "keyframe", asset: "assets/look.mp4" }
        ]
      }
    }, "look", [{ input: 0, output: 0.5 }, { input: 0.75, output: 0.1 }]);

    expect(nextConfig.animations.clips[0].keyframes).toEqual([
      { input: 0, output: 0.5 },
      { input: 0.75, output: 0.1 }
    ]);
  });
});
