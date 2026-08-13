import { describe, expect, it } from "vitest";
import ruleEngine from "../../src/shared/rule-engine";

const { evaluateRules, eventMatchesRule } = ruleEngine;

describe("evaluateRules", () => {
  const now = 10_000;

  it("matches a single condition with multiple filters", () => {
    const rules = [
      {
        id: "near-fast",
        enabled: true,
        relation: "single",
        priority: 4,
        conditions: [
          {
            type: "mouseMove",
            filters: [
              { field: "distanceToPetBounds", operator: "<=", value: 40 },
              { field: "speed", operator: ">", value: 100 },
              { field: "direction", operator: "=", value: "right" }
            ]
          }
        ]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseMove", timestamp: now, distanceToPetBounds: 24, speed: 160, direction: "right" }
      ],
      now,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([rules[0]]);
  });

  it("matches object conditions with filters", () => {
    const rules = [
      {
        id: "filtered-near",
        enabled: true,
        conditions: [
          {
            type: "mouseMove",
            filters: [
              { field: "distanceToPetBounds", operator: "<=", value: 30 },
              { field: "direction", operator: "in", value: ["left", "right"] }
            ]
          }
        ]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseMove", timestamp: now, distanceToPetBounds: 24, direction: "right" }
      ],
      now,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([rules[0]]);
  });

  it("does not match string conditions", () => {
    const rules = [
      {
        id: "legacy-string-click",
        enabled: true,
        conditions: ["click"]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [{ type: "click", timestamp: now }],
      now,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([]);
  });

  it("does not match legacy trigger and filters fields", () => {
    const rules = [
      {
        id: "legacy-trigger-click",
        enabled: true,
        trigger: "click",
        filters: []
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [{ type: "click", timestamp: now }],
      now,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([]);
  });

  it("matches mouseStill by duration", () => {
    const rules = [
      {
        id: "still-for-three-seconds",
        enabled: true,
        relation: "single",
        conditions: [{ type: "mouseStill", filters: [{ field: "durationMs", operator: ">=", value: 3000 }] }]
      }
    ];

    expect(evaluateRules({
      rules,
      eventHistory: [{ type: "mouseStill", timestamp: now, eventSource: "globalMouse", durationMs: 3200 }],
      now,
      lastTriggeredAtByRuleId: {}
    })).toEqual([rules[0]]);

    expect(evaluateRules({
      rules,
      eventHistory: [{ type: "mouseStill", timestamp: now, eventSource: "globalMouse", durationMs: 1000 }],
      now,
      lastTriggeredAtByRuleId: {}
    })).toEqual([]);
  });

  it("matches single rules against the latest valid event only", () => {
    const rules = [
      { id: "click-rule", relation: "single", conditions: [{ type: "click" }] }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [
        { type: "click", timestamp: 1000 },
        { type: "mouseMove", timestamp: 2000 }
      ],
      now: 2000,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([]);
  });

  it("respects the condition window from conditionWindowMs", () => {
    const rules = [
      {
        id: "enter-then-click",
        relation: "and",
        conditionWindowMs: 3000,
        conditions: [{ type: "mouseEnter" }, { type: "click" }]
      }
    ];

    expect(evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseEnter", timestamp: now - 4000 },
        { type: "click", timestamp: now - 500 }
      ],
      now,
      lastTriggeredAtByRuleId: {}
    })).toEqual([]);

    expect(evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseEnter", timestamp: now - 2500 },
        { type: "click", timestamp: now - 500 }
      ],
      now,
      lastTriggeredAtByRuleId: {}
    })).toEqual([rules[0]]);
  });

  it("uses a 1000ms default condition window", () => {
    const rules = [
      {
        id: "enter-then-click",
        conditions: [{ type: "mouseEnter" }, { type: "click" }]
      }
    ];

    expect(evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseEnter", timestamp: now - 1500 },
        { type: "click", timestamp: now }
      ],
      now,
      lastTriggeredAtByRuleId: {}
    })).toEqual([]);

    expect(evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseEnter", timestamp: now - 800 },
        { type: "click", timestamp: now }
      ],
      now,
      lastTriggeredAtByRuleId: {}
    })).toEqual([rules[0]]);
  });

  it("applies the triggering rule cooldown to all rules", () => {
    const rules = [
      { id: "low", relation: "single", priority: 1, conditions: [{ type: "click" }] },
      { id: "cooling", relation: "single", priority: 99, cooldownMs: 5000, conditions: [{ type: "click" }] },
      { id: "high", relation: "single", priority: 10, conditions: [{ type: "click" }] }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [{ type: "click", timestamp: now }],
      now,
      lastTriggeredAtByRuleId: {
        cooling: now - 1000
      }
    });

    expect(result).toEqual([]);
  });

  it("sorts matching rules by descending priority when no global cooldown is active", () => {
    const rules = [
      { id: "low", relation: "single", priority: 1, conditions: [{ type: "click" }] },
      { id: "high", relation: "single", priority: 10, conditions: [{ type: "click" }] }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [{ type: "click", timestamp: now }],
      now,
      lastTriggeredAtByRuleId: {}
    });

    expect(result.map((rule) => rule.id)).toEqual(["high", "low"]);
  });

  it("uses cooldown rules outside the current match candidates as global cooldown sources", () => {
    const result = evaluateRules({
      rules: [
        { id: "click", relation: "single", priority: 1, conditions: [{ type: "click" }] }
      ],
      cooldownRules: [
        { id: "timer", relation: "single", cooldownMs: 5000, conditions: [{ type: "timer" }] }
      ],
      eventHistory: [{ type: "click", timestamp: now }],
      now,
      lastTriggeredAtByRuleId: {
        timer: now - 1000
      }
    });

    expect(result).toEqual([]);
  });

  it("allows continuous rules to evaluate through cooldown", () => {
    const rules = [
      {
        id: "scrub",
        relation: "single",
        continuous: true,
        cooldownMs: 5000,
        conditions: [{ type: "mouseMove" }]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [{ type: "mouseMove", timestamp: now }],
      now,
      lastTriggeredAtByRuleId: {
        scrub: now - 100
      }
    });

    expect(result).toEqual([rules[0]]);
  });

  it("still applies cooldown to continuous non-mouseMove rules", () => {
    const rules = [
      {
        id: "hover",
        relation: "single",
        continuous: true,
        cooldownMs: 5000,
        conditions: [{ type: "hoverDuration", filters: [{ field: "elapsedMs", operator: ">=", value: 1000 }] }]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [{ type: "hoverDuration", timestamp: now, elapsedMs: 2000 }],
      now,
      lastTriggeredAtByRuleId: {
        hover: now - 100
      }
    });

    expect(result).toEqual([]);
  });

  it("supports optional any-one conditions", () => {
    const rules = [
      {
        id: "click-or-enter",
        conditions: [
          { type: "doubleClick", required: false },
          { type: "mouseEnter", required: false }
        ]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [{ type: "mouseEnter", timestamp: now }],
      now,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([rules[0]]);
  });

  it("matches optional-only rules against the latest valid event only", () => {
    const rules = [
      {
        id: "click-or-enter",
        conditions: [
          { type: "click", required: false },
          { type: "mouseEnter", required: false }
        ]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [
        { type: "click", timestamp: 1000 },
        { type: "mouseMove", timestamp: 2000 }
      ],
      now: 2000,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([]);
  });

  it("requires all required conditions to match within the window without ordering", () => {
    const rules = [
      {
        id: "enter-then-click",
        conditions: [{ type: "mouseEnter" }, { type: "click" }]
      }
    ];

    expect(evaluateRules({
      rules,
      eventHistory: [
        { type: "click", timestamp: 11200 },
        { type: "mouseEnter", timestamp: 12000 }
      ],
      now: 12000,
      lastTriggeredAtByRuleId: {}
    })).toEqual([rules[0]]);

    expect(evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseEnter", timestamp: 11200 },
        { type: "click", timestamp: 12000 }
      ],
      now: 12000,
      lastTriggeredAtByRuleId: {}
    })).toEqual([rules[0]]);
  });

  it("requires all required conditions and at least one optional condition when optional conditions exist", () => {
    const rules = [
      {
        id: "enter-and-click-or-double",
        conditions: [
          { type: "mouseEnter", required: true },
          { type: "click", required: false },
          { type: "doubleClick", required: false }
        ]
      }
    ];

    expect(evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseEnter", timestamp: 11200 },
        { type: "click", timestamp: 12000 }
      ],
      now: 12000,
      lastTriggeredAtByRuleId: {}
    })).toEqual([rules[0]]);

    expect(evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseEnter", timestamp: 10000 },
        { type: "mouseMove", timestamp: 12000 }
      ],
      now: 12000,
      lastTriggeredAtByRuleId: {}
    })).toEqual([]);
  });

  it("requires the final AND condition to match the latest valid event", () => {
    const rules = [
      {
        id: "enter-then-click",
        relation: "and",
        conditionWindowMs: 3000,
        conditions: [{ type: "mouseEnter" }, { type: "click" }]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseEnter", timestamp: 10000 },
        { type: "click", timestamp: 11000 },
        { type: "mouseMove", timestamp: 12000 }
      ],
      now: 12000,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([]);
  });

  it("anchors the AND window to the latest event timestamp when evaluation is delayed", () => {
    const rules = [
      {
        id: "enter-then-click",
        relation: "and",
        conditionWindowMs: 3000,
        conditions: [{ type: "mouseEnter" }, { type: "click" }]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [
        { type: "mouseEnter", timestamp: 10000 },
        { type: "click", timestamp: 12000 }
      ],
      now: 16000,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([rules[0]]);
  });

  it("supports all filter operators", () => {
    const event = {
      type: "mouseMove",
      timestamp: now,
      distanceToPetBounds: 25,
      speed: 120,
      direction: "left",
      isInsidePet: false,
      deltaX: -30
    };
    const rules = [
      {
        id: "operators",
        relation: "single",
        conditions: [
          {
            type: "mouseMove",
            filters: [
              { field: "distanceToPetBounds", operator: "=", value: 25 },
              { field: "direction", operator: "!=", value: "right" },
              { field: "speed", operator: ">", value: 100 },
              { field: "speed", operator: ">=", value: 120 },
              { field: "distanceToPetBounds", operator: "<", value: 40 },
              { field: "distanceToPetBounds", operator: "<=", value: 25 },
              { field: "distanceToPetBounds", operator: "between", value: [20, 30] },
              { field: "direction", operator: "in", value: ["left", "up"] },
              { field: "isInsidePet", operator: "notIn", value: [true] }
            ]
          }
        ]
      },
      {
        id: "failing-not-in",
        relation: "single",
        conditions: [
          {
            type: "mouseMove",
            filters: [{ field: "deltaX", operator: "notIn", value: [-30, -20] }]
          }
        ]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [event],
      now,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([rules[0]]);
  });

  it("ignores disabled rules", () => {
    const rules = [
      { id: "disabled", enabled: false, relation: "single", conditions: [{ type: "click" }] },
      { id: "enabled", relation: "single", conditions: [{ type: "click" }] }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [{ type: "click", timestamp: now }],
      now,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([rules[1]]);
  });

  it("ignores malformed history entries", () => {
    const rules = [
      { id: "click-rule", relation: "single", conditions: [{ type: "click" }] }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [null, undefined, "bad", { type: "click", timestamp: now }],
      now,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([rules[0]]);
  });

  it("does not match negative filters when fields are missing", () => {
    const rules = [
      {
        id: "missing-not-equal",
        relation: "single",
        conditions: [
          {
            type: "mouseMove",
            filters: [{ field: "isInsidePet", operator: "!=", value: true }]
          }
        ]
      },
      {
        id: "missing-not-in",
        relation: "single",
        conditions: [
          {
            type: "mouseMove",
            filters: [{ field: "direction", operator: "notIn", value: ["right"] }]
          }
        ]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [{ type: "mouseMove", timestamp: now }],
      now,
      lastTriggeredAtByRuleId: {}
    });

    expect(result).toEqual([]);
  });

  it("excludes sustained-state rules from one-shot matching", () => {
    const rules = [
      {
        id: "sustained-near",
        enabled: true,
        relation: "single",
        conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }], sustainMs: 3000 }],
        actions: [{ type: "playAnimation", animation: "greet" }]
      }
    ];

    const result = evaluateRules({
      rules,
      eventHistory: [{ type: "mouseMove", timestamp: now, distanceToPetCenter: 100 }],
      now,
      lastTriggeredAtByRuleId: {}
    });

    // Sustained rules never match through the plain one-shot path; the runtime
    // drives them via eventMatchesRule + its own state machine.
    expect(result).toEqual([]);
  });
});

describe("eventMatchesRule", () => {
  const now = 10_000;

  it("returns true when the current event satisfies a single-condition rule", () => {
    const rule = {
      relation: "single",
      conditions: [{ type: "mouseMove", filters: [{ field: "distanceToPetCenter", operator: "<", value: 300 }] }]
    };
    expect(eventMatchesRule(rule, { type: "mouseMove", timestamp: now, distanceToPetCenter: 100 }, [], now)).toBe(true);
    expect(eventMatchesRule(rule, { type: "mouseMove", timestamp: now, distanceToPetCenter: 500 }, [], now)).toBe(false);
  });

  it("returns false when the event type does not match the condition", () => {
    const rule = { relation: "single", conditions: [{ type: "click", filters: [] }] };
    expect(eventMatchesRule(rule, { type: "mouseMove", timestamp: now }, [], now)).toBe(false);
  });

  it("matches a randomTimer rule whose min/max settings are dedicated fields, not filters", () => {
    // Regression: scheduling settings stored as filters made the rule never match,
    // because the timer event carries no minMs/maxMs fields for the filter to compare.
    const rule = {
      relation: "single",
      conditions: [{ type: "randomTimer", required: true, filters: [], minMs: 3000, maxMs: 9000 }]
    };
    const event = { type: "randomTimer", timestamp: now, eventSource: "timer", currentHour: 5, dayOfWeek: 3 };
    expect(eventMatchesRule(rule, event, [], now)).toBe(true);
  });

  it("matches a timer rule whose interval setting is a dedicated field, not a filter", () => {
    const rule = {
      relation: "single",
      conditions: [{ type: "timer", required: true, filters: [], intervalMs: 5000 }]
    };
    const event = { type: "timer", timestamp: now, eventSource: "timer", currentHour: 5, dayOfWeek: 3 };
    expect(eventMatchesRule(rule, event, [], now)).toBe(true);
  });
});
