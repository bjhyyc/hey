import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { detectRuleConflicts } from "../../src/shared/rule-conflict-detector";

const require = createRequire(import.meta.url);
const { DEFAULT_CONFIG } = require("../../src/shared/defaults");

describe("detectRuleConflicts", () => {
  it("reports same-event rules without filters as trigger overlaps", () => {
    const conflicts = detectRuleConflicts([
      { id: "first", name: "First click", conditions: [{ type: "click", filters: [] }] },
      { id: "second", name: "Second click", conditions: [{ type: "click", filters: [] }] }
    ]);

    expect(conflicts).toEqual([
      expect.objectContaining({
        type: "triggerOverlap",
        ruleIds: ["first", "second"],
        messageKey: "rules.conflicts.triggerOverlap"
      })
    ]);
  });

  it("reports higher-priority stop-on-match rules that may shadow lower-priority rules", () => {
    const conflicts = detectRuleConflicts([
      { id: "low", name: "Low click", priority: 1, conditions: [{ type: "click", filters: [] }] },
      { id: "high", name: "High click", priority: 10, conditions: [{ type: "click", filters: [] }] }
    ]);

    expect(conflicts).toEqual([
      expect.objectContaining({
        type: "priorityShadow",
        ruleIds: ["high", "low"],
        params: expect.objectContaining({
          highRule: "High click",
          lowRule: "Low click"
        })
      })
    ]);
  });

  it("does not report rules with different event types", () => {
    const conflicts = detectRuleConflicts([
      { id: "click", name: "Click", conditions: [{ type: "click", filters: [] }] },
      { id: "enter", name: "Enter", conditions: [{ type: "mouseEnter", filters: [] }] }
    ]);

    expect(conflicts).toEqual([]);
  });

  it("reports mouse enter and hover duration rules as overlapping hover interactions", () => {
    const conflicts = detectRuleConflicts([
      { id: "enter", name: "Mouse enter", conditions: [{ type: "mouseEnter", filters: [] }] },
      { id: "hover", name: "Hover", conditions: [{ type: "hoverDuration", filters: [{ field: "elapsedMs", operator: ">=", value: 1000 }] }] }
    ]);

    expect(conflicts).toContainEqual(expect.objectContaining({
      type: "triggerOverlap",
      ruleIds: ["enter", "hover"],
      messageKey: "rules.conflicts.triggerOverlap"
    }));
  });

  it("ignores disabled rules", () => {
    const conflicts = detectRuleConflicts([
      { id: "enabled", name: "Enabled", conditions: [{ type: "click", filters: [] }] },
      { id: "disabled", name: "Disabled", enabled: false, conditions: [{ type: "click", filters: [] }] }
    ]);

    expect(conflicts).toEqual([]);
  });

  it("reports conflicting hide and show actions for overlapping rules", () => {
    const conflicts = detectRuleConflicts([
      {
        id: "hide",
        name: "Hide",
        conditions: [{ type: "click", filters: [] }],
        actions: [{ type: "hidePet" }]
      },
      {
        id: "show",
        name: "Show",
        conditions: [{ type: "click", filters: [] }],
        actions: [{ type: "showPet" }]
      }
    ]);

    expect(conflicts).toContainEqual(expect.objectContaining({
      type: "actionConflict",
      ruleIds: ["hide", "show"],
      messageKey: "rules.conflicts.actionPairConflict",
      params: expect.objectContaining({
        leftActionType: "hidePet",
        rightActionType: "showPet"
      })
    }));
  });

  it("reports overlapping rules that both queue an animation", () => {
    const conflicts = detectRuleConflicts([
      {
        id: "one",
        name: "One",
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }] }],
        actions: [{ type: "playAnimation", animation: "idle" }]
      },
      {
        id: "two",
        name: "Two",
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 200 }] }],
        actions: [{ type: "playAnimation", animation: "wave" }]
      }
    ]);

    expect(conflicts).toContainEqual(expect.objectContaining({
      type: "animationQueue",
      ruleIds: ["one", "two"],
      messageKey: "rules.conflicts.animationQueue",
      params: expect.objectContaining({ actionType: "playAnimation" })
    }));

    // playAnimation no longer counts as an overriding actionConflict
    expect(conflicts.filter((c) => c.type === "actionConflict")).toEqual([]);
  });

  describe("interrupt animation conflicts", () => {
    const overlappingRules = (leftAnim, rightAnim) => ([
      {
        id: "one",
        name: "One",
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }] }],
        actions: [{ type: "playAnimation", animation: leftAnim }]
      },
      {
        id: "two",
        name: "Two",
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 200 }] }],
        actions: [{ type: "playAnimation", animation: rightAnim }]
      }
    ]);

    it("reports an overwrite conflict when both animations interrupt", () => {
      const conflicts = detectRuleConflicts(overlappingRules("cutA", "cutB"), {
        clips: [
          { id: "cutA", interrupt: true },
          { id: "cutB", interrupt: true }
        ]
      });

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "actionConflict",
        messageKey: "rules.conflicts.interruptOverwrite",
        params: expect.objectContaining({ actionType: "playAnimation" })
      }));
      expect(conflicts.filter((c) => c.type === "animationQueue")).toEqual([]);
    });

    it("reports an interrupt conflict when only one animation interrupts", () => {
      const conflicts = detectRuleConflicts(overlappingRules("cut", "normal"), {
        clips: [
          { id: "cut", interrupt: true },
          { id: "normal" }
        ]
      });

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "animationInterrupt",
        messageKey: "rules.conflicts.animationInterrupt",
        params: expect.objectContaining({ actionType: "playAnimation" })
      }));
      expect(conflicts.filter((c) => c.type === "animationQueue")).toEqual([]);
    });

    it("falls back to queue behavior when no clips are provided", () => {
      const conflicts = detectRuleConflicts(overlappingRules("cutA", "cutB"));

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "animationQueue",
        messageKey: "rules.conflicts.animationQueue"
      }));
    });
  });

  describe("action conflict false positive fix", () => {
    it("does not report action conflict when only one rule has duplicate actions", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "multi",
          name: "Multi-step",
          conditions: [{ type: "click", filters: [] }],
          actions: [
            { type: "playAnimation", animation: "wave" },
            { type: "playAnimation", animation: "idle" }
          ]
        },
        {
          id: "other",
          name: "Other",
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "showMessage", text: "hello" }]
        }
      ]);

      const actionConflicts = conflicts.filter((c) => c.type === "actionConflict");
      expect(actionConflicts).toEqual([]);
    });

    it("reports action conflict when both rules have the same action type", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "a",
          name: "A",
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "changeScale", scale: 1.5 }]
        },
        {
          id: "b",
          name: "B",
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "changeScale", scale: 2.0 }]
        }
      ]);

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "actionConflict",
        params: expect.objectContaining({ actionType: "changeScale" })
      }));
    });
  });

  describe("action pair conflict direction", () => {
    it("detects action pair conflict regardless of which rule has which action", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "a",
          name: "A",
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "showPet" }]
        },
        {
          id: "b",
          name: "B",
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "hidePet" }]
        }
      ]);

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "actionConflict",
        messageKey: "rules.conflicts.actionPairConflict"
      }));
    });
  });

  describe("filterSetCovers empty filter fix", () => {
    it("detects overlap when one rule has filters and the other has none", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "filtered",
          name: "Filtered click",
          conditions: [{ type: "click", filters: [{ field: "distanceToPetCenter", operator: "<", value: 100 }] }]
        },
        {
          id: "unfiltered",
          name: "Any click",
          conditions: [{ type: "click", filters: [] }]
        }
      ]);

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "triggerOverlap",
        ruleIds: ["filtered", "unfiltered"]
      }));
    });

    it("detects overlap when the rule with filters comes second", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "any",
          name: "Any mouseMove",
          conditions: [{ type: "mouseMove", filters: [] }]
        },
        {
          id: "close",
          name: "Close mouseMove",
          conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 200 }] }]
        }
      ]);

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "triggerOverlap",
        ruleIds: ["any", "close"]
      }));
    });
  });

  describe("numeric range coverage", () => {
    it("detects overlap when one range covers the other", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "wide",
          name: "Wide range",
          conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 500 }] }]
        },
        {
          id: "narrow",
          name: "Narrow range",
          conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 200 }] }]
        }
      ]);

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "triggerOverlap",
        ruleIds: ["narrow", "wide"]
      }));
    });

    it("detects overlap with between operator covering an equality", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "range",
          name: "Range",
          conditions: [{ type: "hoverDuration", filters: [{ field: "elapsedMs", operator: "between", value: [1000, 5000] }] }]
        },
        {
          id: "exact",
          name: "Exact",
          conditions: [{ type: "hoverDuration", filters: [{ field: "elapsedMs", operator: "=", value: 3000 }] }]
        }
      ]);

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "triggerOverlap",
        ruleIds: ["exact", "range"]
      }));
    });

    it("does not detect overlap for non-overlapping ranges", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "low",
          name: "Low",
          conditions: [{ type: "hoverDuration", filters: [{ field: "elapsedMs", operator: "<", value: 1000 }] }]
        },
        {
          id: "high",
          name: "High",
          conditions: [{ type: "hoverDuration", filters: [{ field: "elapsedMs", operator: ">", value: 5000 }] }]
        }
      ]);

      expect(conflicts).toEqual([]);
    });
  });

  describe("in operator covering equality", () => {
    it("detects overlap when in-set contains the equality value", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "set",
          name: "Set",
          conditions: [{ type: "timer", filters: [{ field: "dayOfWeek", operator: "in", value: [1, 2, 3, 4, 5] }] }]
        },
        {
          id: "single",
          name: "Single",
          conditions: [{ type: "timer", filters: [{ field: "dayOfWeek", operator: "=", value: 3 }] }]
        }
      ]);

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "triggerOverlap",
        ruleIds: ["set", "single"]
      }));
    });
  });

  describe("latest condition format", () => {
    it("does not detect conflicts for legacy trigger fields", () => {
      const conflicts = detectRuleConflicts([
        { id: "legacy", name: "Legacy", trigger: "click", filters: [] },
        { id: "modern", name: "Modern", conditions: [{ type: "click", filters: [] }] }
      ]);

      expect(conflicts).toEqual([]);
    });

    it("does not detect conflicts between legacy-format rules", () => {
      const conflicts = detectRuleConflicts([
        { id: "a", name: "A", trigger: "mouseEnter", filters: [] },
        { id: "b", name: "B", trigger: "mouseEnter", filters: [] }
      ]);

      expect(conflicts).toEqual([]);
    });
  });

  describe("sustainMs exclusion", () => {
    it("ignores rules with sustained mouseMove conditions", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "sustained",
          name: "Sustained",
          conditions: [{ type: "mouseMove", sustainMs: 500, filters: [] }]
        },
        {
          id: "normal",
          name: "Normal",
          conditions: [{ type: "mouseMove", filters: [] }]
        }
      ]);

      expect(conflicts).toEqual([]);
    });

    it("still detects conflicts for mouseMove rules without sustainMs", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "a",
          name: "A",
          conditions: [{ type: "mouseMove", filters: [] }]
        },
        {
          id: "b",
          name: "B",
          conditions: [{ type: "mouseMove", filters: [] }]
        }
      ]);

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "triggerOverlap",
        ruleIds: ["a", "b"]
      }));
    });

    it("ignores rules where sustainMs is zero (treated as no sustain)", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "zero",
          name: "Zero sustain",
          conditions: [{ type: "mouseMove", sustainMs: 0, filters: [] }]
        },
        {
          id: "normal",
          name: "Normal",
          conditions: [{ type: "mouseMove", filters: [] }]
        }
      ]);

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "triggerOverlap",
        ruleIds: ["normal", "zero"]
      }));
    });
  });

  describe("click and doubleClick independence", () => {
    it("does not report click and doubleClick rules as potentially conflicting", () => {
      const conflicts = detectRuleConflicts([
        { id: "click", name: "Click", conditions: [{ type: "click", filters: [] }] },
        { id: "dblclick", name: "Double click", conditions: [{ type: "doubleClick", filters: [] }] }
      ]);

      expect(conflicts).toEqual([]);
    });

    it("does not report priority shadowing between click and doubleClick rules", () => {
      const conflicts = detectRuleConflicts([
        { id: "greet", name: "点击打招呼", priority: 10, conditions: [{ type: "click", filters: [] }] },
        { id: "move", name: "移动测试", priority: 1, conditions: [{ type: "doubleClick", filters: [] }] }
      ]);

      expect(conflicts).toEqual([]);
    });
  });

  describe("nearby interaction action conflicts", () => {
    it("reports default rules that both queue the same animation nearby", () => {
      const conflicts = detectRuleConflicts(DEFAULT_CONFIG.triggerRules);

      expect(conflicts).toContainEqual(expect.objectContaining({
        type: "temporalAnimationQueue",
        ruleIds: ["default-click-greeting", "default-hover"],
        messageKey: "rules.conflicts.temporalAnimationQueue",
        params: expect.objectContaining({ actionType: "playAnimation" })
      }));
    });

    it("does not report nearby action conflicts for unrelated timer rules", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "timer",
          name: "Timer",
          conditions: [{ type: "timer", filters: [] }],
          actions: [{ type: "playAnimation", animation: "wave" }]
        },
        {
          id: "random",
          name: "Random",
          conditions: [{ type: "randomTimer", filters: [] }],
          actions: [{ type: "playAnimation", animation: "idle" }]
        }
      ]);

      expect(conflicts).toEqual([]);
    });

    it("does not report click and drag rules as nearby action conflicts", () => {
      const conflicts = detectRuleConflicts([
        {
          id: "click",
          name: "Click",
          conditions: [{ type: "click", filters: [] }],
          actions: [{ type: "playAnimation", animation: "wave" }]
        },
        {
          id: "drag",
          name: "Drag",
          conditions: [{ type: "dragStart", filters: [] }],
          actions: [{ type: "playAnimation", animation: "drag" }]
        }
      ]);

      expect(conflicts).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("handles empty rules array", () => {
      expect(detectRuleConflicts([])).toEqual([]);
    });

    it("handles undefined input", () => {
      expect(detectRuleConflicts()).toEqual([]);
    });

    it("handles non-array input", () => {
      expect(detectRuleConflicts("not an array")).toEqual([]);
    });

    it("handles rules without id or name", () => {
      const conflicts = detectRuleConflicts([
        { conditions: [{ type: "click", filters: [] }] },
        { conditions: [{ type: "click", filters: [] }] }
      ]);

      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0].ruleNames).toEqual(["Untitled rule", "Untitled rule"]);
    });

    it("assigns stable fallback ids to rules without ids", () => {
      const conflicts = detectRuleConflicts([
        { conditions: [{ type: "click", filters: [] }] },
        { conditions: [{ type: "click", filters: [] }] }
      ]);

      expect(conflicts[0].ruleIds).toEqual(["rule-0", "rule-1"]);
    });

    it("generates deterministic conflict ids", () => {
      const conflicts1 = detectRuleConflicts([
        { id: "b", name: "B", conditions: [{ type: "click", filters: [] }] },
        { id: "a", name: "A", conditions: [{ type: "click", filters: [] }] }
      ]);
      const conflicts2 = detectRuleConflicts([
        { id: "a", name: "A", conditions: [{ type: "click", filters: [] }] },
        { id: "b", name: "B", conditions: [{ type: "click", filters: [] }] }
      ]);

      expect(conflicts1[0].id).toBe(conflicts2[0].id);
    });
  });
});
