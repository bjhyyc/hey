import { describe, expect, it } from "vitest";

import { createRuleRuntime } from "../../src/renderer/pet/pet-runtime.js";

// Cooldowns describe the pet's recent behaviour, not the lifetime of a runtime
// object. Loading or updating a package rebuilds the rule runtime, and the
// timestamps used to die with the old closure, re-arming every cooldown: the
// hover action carries a twenty-second cooldown yet could fire again seconds
// after a rebuild. The delivery verifier caught it as a repeated hover action.
describe("rule cooldowns across a runtime rebuild", () => {
  const rule = {
    id: "studio-hover-attention",
    name: "Hover attention",
    conditions: [{ type: "hoverDuration", elapsedMs: 2000 }],
    actions: [{ type: "playAnimation", animationIds: ["hover"] }],
    cooldownMs: 20000,
    cooldownScope: "eventType",
    priority: 200
  };

  function hover(runtime, timestamp) {
    return runtime.evaluateEvent({
      type: "hoverDuration",
      timestamp,
      elapsedMs: 2000,
      eventSource: "timer"
    });
  }

  it("keeps a fired cooldown when the runtime is rebuilt", () => {
    const first = createRuleRuntime({ rules: [rule], now: () => 1_000 });
    hover(first, 1_000);
    const carried = first.getLastTriggeredAtByRuleId();
    expect(carried["studio-hover-attention"]).toBe(1_000);

    const rebuilt = createRuleRuntime({
      rules: [rule],
      now: () => 6_000,
      lastTriggeredAtByRuleId: carried
    });
    expect(rebuilt.getLastTriggeredAtByRuleId()["studio-hover-attention"]).toBe(1_000);
  });

  it("starts clean when nothing is carried in", () => {
    const runtime = createRuleRuntime({ rules: [rule], now: () => 1_000 });
    expect(runtime.getLastTriggeredAtByRuleId()).toEqual({});
  });

  it("copies the carried timestamps instead of sharing the caller's object", () => {
    const carried = { "studio-hover-attention": 1_000 };
    const runtime = createRuleRuntime({ rules: [rule], lastTriggeredAtByRuleId: carried });
    carried["studio-hover-attention"] = 99_000;
    expect(runtime.getLastTriggeredAtByRuleId()["studio-hover-attention"]).toBe(1_000);
  });
});
