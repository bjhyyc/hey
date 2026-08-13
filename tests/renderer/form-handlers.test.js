import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAnimationFromForm, saveRuleFromForm } from "../../src/renderer/panel/handlers/form-handlers";

function createField(value, checked = false) {
  return { value, checked };
}

function createRow(fields) {
  return {
    querySelector: vi.fn((selector) => fields[selector] || null)
  };
}

describe("panel form handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.FormData;
  });

  function installMockFormData() {
    globalThis.FormData = class MockFormData {
      constructor(form) {
        this.values = form.values || {};
      }

      get(name) {
        return this.values[name] ?? "";
      }
    };
  }

  it("saves blank rule actions without duration", async () => {
    const conditionRow = createRow({
      '[name="conditionType"]': createField("click"),
      '[name="filterField"]': createField(""),
      '[name="filterOperator"]': createField("="),
      '[name="filterValue"]': createField(""),
      '[name="filterUnit"]': createField(""),
      '[name="conditionRequired"]': createField("", true)
    });
    const actionRow = createRow({
      '[name="actionType"]': createField("blank"),
      '[name="durationMs"]': createField("1500")
    });
    const form = {
      elements: {
        id: createField("rule-wait"),
        name: createField("Wait before waving"),
        cooldownMs: createField("0"),
        priority: createField("1"),
        stopOnMatch: createField("", true),
        actionStrategy: createField("sequence")
      },
      querySelectorAll: vi.fn((selector) => {
        if (selector === '[data-rule-condition][data-scope="conditions"]') return [conditionRow];
        if (selector === '[data-rule-condition][data-scope="exitConditions"]') return [];
        if (selector === '[data-inline-action][data-scope="actions"]') return [actionRow];
        if (selector === '[data-inline-action][data-scope="exitActions"]') return [];
        return [];
      })
    };
    const config = {
      animations: { default: { id: "idle", asset: "" }, clips: [] },
      triggerRules: []
    };
    const state = { selectedRuleId: "", ruleEditorOpen: true };
    const render = vi.fn();
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await saveRuleFromForm(form, config, saveConfig, state, render);

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      triggerRules: [expect.objectContaining({
        id: "rule-wait",
        actions: [{ type: "blank" }]
      })]
    }), "rule");
    expect(state.selectedRuleId).toBe("rule-wait");
    expect(state.ruleEditorOpen).toBe(false);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("saves delay rule actions with editable duration", async () => {
    const conditionRow = createRow({
      '[name="conditionType"]': createField("click"),
      '[name="filterField"]': createField(""),
      '[name="filterOperator"]': createField("="),
      '[name="filterValue"]': createField(""),
      '[name="filterUnit"]': createField(""),
      '[name="conditionRequired"]': createField("", true)
    });
    const actionRow = createRow({
      '[name="actionType"]': createField("delay"),
      '[name="durationMs"]': createField("1500")
    });
    const form = {
      elements: {
        id: createField("rule-delay"),
        name: createField("Delay before waving"),
        cooldownMs: createField("0"),
        priority: createField("1"),
        stopOnMatch: createField("", true),
        actionStrategy: createField("sequence")
      },
      querySelectorAll: vi.fn((selector) => {
        if (selector === '[data-rule-condition][data-scope="conditions"]') return [conditionRow];
        if (selector === '[data-rule-condition][data-scope="exitConditions"]') return [];
        if (selector === '[data-inline-action][data-scope="actions"]') return [actionRow];
        if (selector === '[data-inline-action][data-scope="exitActions"]') return [];
        return [];
      })
    };
    const config = {
      animations: { default: { id: "idle", asset: "" }, clips: [] },
      triggerRules: []
    };
    const state = { selectedRuleId: "", ruleEditorOpen: true };
    const render = vi.fn();
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await saveRuleFromForm(form, config, saveConfig, state, render);

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      triggerRules: [expect.objectContaining({
        id: "rule-delay",
        actions: [{ type: "delay", durationMs: 1500 }]
      })]
    }), "rule");
    expect(state.selectedRuleId).toBe("rule-delay");
    expect(state.ruleEditorOpen).toBe(false);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("saves playAnimation rule actions without copying oneshot duration", async () => {
    const conditionRow = createRow({
      '[name="conditionType"]': createField("click"),
      '[name="filterField"]': createField(""),
      '[name="filterOperator"]': createField("="),
      '[name="filterValue"]': createField(""),
      '[name="filterUnit"]': createField(""),
      '[name="conditionRequired"]': createField("", true)
    });
    const actionRow = createRow({
      '[name="actionType"]': createField("playAnimation"),
      '[name="animation"]': createField("wave"),
      '[name="durationMs"]': createField("900")
    });
    const form = {
      elements: {
        id: createField("rule-wave"),
        name: createField("Wave"),
        cooldownMs: createField("0"),
        priority: createField("1"),
        stopOnMatch: createField("", true),
        actionStrategy: createField("sequence")
      },
      querySelectorAll: vi.fn((selector) => {
        if (selector === '[data-rule-condition][data-scope="conditions"]') return [conditionRow];
        if (selector === '[data-rule-condition][data-scope="exitConditions"]') return [];
        if (selector === '[data-inline-action][data-scope="actions"]') return [actionRow];
        if (selector === '[data-inline-action][data-scope="exitActions"]') return [];
        return [];
      })
    };
    const config = {
      animations: {
        default: { id: "idle", asset: "assets/idle.webm" },
        clips: [{ id: "wave", asset: "assets/wave.webm", type: "oneshot", durationMs: 900 }]
      },
      triggerRules: []
    };
    const state = { selectedRuleId: "", ruleEditorOpen: true };
    const render = vi.fn();
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await saveRuleFromForm(form, config, saveConfig, state, render);

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      triggerRules: [expect.objectContaining({
        id: "rule-wave",
        actions: [{ type: "playAnimation", animation: "wave" }]
      })]
    }), "rule");
  });

  it("saves random timer interval settings from condition rows", async () => {
    const conditionRow = createRow({
      '[name="conditionType"]': createField("randomTimer"),
      '[name="filterField"]': createField(""),
      '[name="filterOperator"]': createField("="),
      '[name="filterValue"]': createField(""),
      '[name="filterUnit"]': createField(""),
      '[name="conditionRequired"]': createField("", true),
      '[name="randomTimerMinMs"]': createField("3000"),
      '[name="randomTimerMaxMs"]': createField("9000")
    });
    const actionRow = createRow({
      '[name="actionType"]': createField("showMessage"),
      '[name="message"]': createField("Random hello"),
      '[name="durationMs"]': createField("1200")
    });
    const form = {
      elements: {
        id: createField("rule-random"),
        name: createField("Random hello"),
        cooldownMs: createField("0"),
        priority: createField("1"),
        stopOnMatch: createField("", true),
        actionStrategy: createField("sequence")
      },
      querySelectorAll: vi.fn((selector) => {
        if (selector === '[data-rule-condition][data-scope="conditions"]') return [conditionRow];
        if (selector === '[data-rule-condition][data-scope="exitConditions"]') return [];
        if (selector === '[data-inline-action][data-scope="actions"]') return [actionRow];
        if (selector === '[data-inline-action][data-scope="exitActions"]') return [];
        return [];
      })
    };
    const config = {
      animations: { default: { id: "idle", asset: "" }, clips: [] },
      triggerRules: []
    };
    const state = { selectedRuleId: "", ruleEditorOpen: true };
    const render = vi.fn();
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await saveRuleFromForm(form, config, saveConfig, state, render);

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      triggerRules: [expect.objectContaining({
        conditions: [expect.objectContaining({
          type: "randomTimer",
          filters: [],
          minMs: 3000,
          maxMs: 9000
        })]
      })]
    }), "rule");
  });

  it("saves timer interval settings from condition rows", async () => {
    const conditionRow = createRow({
      '[name="conditionType"]': createField("timer"),
      '[name="filterField"]': createField(""),
      '[name="filterOperator"]': createField("="),
      '[name="filterValue"]': createField(""),
      '[name="filterUnit"]': createField(""),
      '[name="conditionRequired"]': createField("", true),
      '[name="timerIntervalMs"]': createField("7000")
    });
    const actionRow = createRow({
      '[name="actionType"]': createField("showMessage"),
      '[name="message"]': createField("Timed hello"),
      '[name="durationMs"]': createField("1200")
    });
    const form = {
      elements: {
        id: createField("rule-timer"),
        name: createField("Timed hello"),
        cooldownMs: createField("0"),
        priority: createField("1"),
        stopOnMatch: createField("", true),
        actionStrategy: createField("sequence")
      },
      querySelectorAll: vi.fn((selector) => {
        if (selector === '[data-rule-condition][data-scope="conditions"]') return [conditionRow];
        if (selector === '[data-rule-condition][data-scope="exitConditions"]') return [];
        if (selector === '[data-inline-action][data-scope="actions"]') return [actionRow];
        if (selector === '[data-inline-action][data-scope="exitActions"]') return [];
        return [];
      })
    };
    const config = {
      animations: { default: { id: "idle", asset: "" }, clips: [] },
      triggerRules: []
    };
    const state = { selectedRuleId: "", ruleEditorOpen: true };
    const render = vi.fn();
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await saveRuleFromForm(form, config, saveConfig, state, render);

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      triggerRules: [expect.objectContaining({
        conditions: [expect.objectContaining({
          type: "timer",
          filters: [],
          intervalMs: 7000
        })]
      })]
    }), "rule");
  });

  it("saves pomodoro timer rule actions", async () => {
    const conditionRow = createRow({
      '[name="conditionType"]': createField("click"),
      '[name="filterField"]': createField(""),
      '[name="filterOperator"]': createField("="),
      '[name="filterValue"]': createField(""),
      '[name="filterUnit"]': createField(""),
      '[name="conditionRequired"]': createField("", true)
    });
    const actionRow = createRow({
      '[name="actionType"]': createField("pomodoroTimer"),
      '[name="pomodoroCommand"]': createField("start"),
      '[name="durationMs"]': createField("1500000"),
      '[name="label"]': createField("Focus")
    });
    const form = {
      elements: {
        id: createField("rule-pomodoro"),
        name: createField("Start focus"),
        cooldownMs: createField("0"),
        priority: createField("1"),
        stopOnMatch: createField("", true),
        actionStrategy: createField("sequence")
      },
      querySelectorAll: vi.fn((selector) => {
        if (selector === '[data-rule-condition][data-scope="conditions"]') return [conditionRow];
        if (selector === '[data-rule-condition][data-scope="exitConditions"]') return [];
        if (selector === '[data-inline-action][data-scope="actions"]') return [actionRow];
        if (selector === '[data-inline-action][data-scope="exitActions"]') return [];
        return [];
      })
    };
    const config = {
      animations: { default: { id: "idle", asset: "" }, clips: [] },
      triggerRules: []
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await saveRuleFromForm(form, config, saveConfig, { selectedRuleId: "", ruleEditorOpen: true }, vi.fn());

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      triggerRules: [expect.objectContaining({
        id: "rule-pomodoro",
        actions: [{ type: "pomodoroTimer", command: "start", durationMs: 1500000, label: "Focus" }]
      })]
    }), "rule");
  });

  it("saves green screen settings for video animations", async () => {
    installMockFormData();

    const config = {
      animations: {
        default: { id: "idle", name: "Idle", asset: "assets/idle.svg" },
        clips: []
      }
    };
    const form = {
      values: {
        id: "green",
        name: "Green",
        asset: "assets/green.mp4",
        type: "loop",
        isDefault: "false",
        greenScreenEnabled: "on",
        greenScreenColor: "#11ff22",
        greenScreenTolerance: "40",
        greenScreenSoftness: "12"
      }
    };
    const state = { selectedClipId: "green", animationEditorOpen: true };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);
    const render = vi.fn();

    await saveAnimationFromForm(form, config, saveConfig, state, render);

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      animations: expect.objectContaining({
        clips: [expect.objectContaining({
          id: "green",
          greenScreen: {
            enabled: true,
            color: "#11ff22",
            tolerance: 0.4,
            softness: 0.12
          }
        })]
      })
    }), "animation");
    expect(state.animationEditorOpen).toBe(false);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("saves oneshot movement easing settings under movement.easing", async () => {
    installMockFormData();

    const config = {
      animations: {
        default: { id: "idle", name: "Idle", asset: "assets/idle.svg" },
        clips: []
      }
    };
    const form = {
      values: {
        id: "walk",
        name: "Walk",
        asset: "assets/walk.svg",
        type: "oneshot",
        durationMs: "900",
        isDefault: "false",
        movementDirection: "right",
        movementSpeed: "140",
        easingPreset: "easeInOut",
        easingStrength: "1.5",
        easeInMs: "180",
        easeOutMs: "240",
        startDelayMs: "120",
        endDelayMs: "80"
      }
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await saveAnimationFromForm(form, config, saveConfig, { selectedClipId: "walk" }, vi.fn());

    const savedClip = saveConfig.mock.calls[0][0].animations.clips[0];
    expect(savedClip.movement).toEqual({
      direction: "right",
      speed: 140,
      easing: {
        preset: "easeInOut",
        strength: 1.5,
        easeInMs: 180,
        easeOutMs: 240,
        startDelayMs: 120,
        endDelayMs: 80
      }
    });
  });

  it("removes green screen settings when a clip is saved with a non-video asset", async () => {
    installMockFormData();

    const config = {
      animations: {
        default: { id: "idle", name: "Idle", asset: "assets/idle.svg" },
        clips: [
          {
            id: "green",
            name: "Green",
            asset: "assets/green.mp4",
            type: "loop",
            greenScreen: { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 }
          }
        ]
      }
    };
    const form = {
      values: {
        id: "green",
        name: "Still",
        asset: "assets/still.svg",
        type: "loop",
        isDefault: "false",
        greenScreenEnabled: "on",
        greenScreenColor: "#00ff00",
        greenScreenTolerance: "35",
        greenScreenSoftness: "8"
      }
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await saveAnimationFromForm(form, config, saveConfig, { selectedClipId: "green" }, vi.fn());

    const savedConfig = saveConfig.mock.calls[0][0];
    expect(savedConfig.animations.clips[0]).toEqual(expect.objectContaining({
      id: "green",
      asset: "assets/still.svg"
    }));
    expect(savedConfig.animations.clips[0].greenScreen).toBeUndefined();
  });

  it("blocks a legacy green-screen keyframe from silently losing its config on save", async () => {
    installMockFormData();

    const config = {
      animations: {
        default: { id: "idle", name: "Idle", asset: "assets/idle.svg" },
        clips: [{
          id: "look",
          name: "Look",
          asset: "assets/look.mp4",
          type: "keyframe",
          greenScreen: { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 }
        }]
      }
    };
    const form = {
      values: {
        id: "look",
        name: "Look",
        asset: "assets/look.mp4",
        type: "keyframe",
        isDefault: "false",
        greenScreenBakeEnabled: "on"
      }
    };
    const state = {
      selectedClipId: "look",
      animationEditorOpen: true
    };
    const saveConfig = vi.fn();
    const render = vi.fn();

    await saveAnimationFromForm(form, config, saveConfig, state, render);

    expect(saveConfig).not.toHaveBeenCalled();
    expect(state.animationEditorOpen).toBe(true);
    expect(config.animations.clips[0].greenScreen).toEqual(expect.objectContaining({ enabled: true }));
    expect(render).not.toHaveBeenCalled();
  });

  it("does not persist the editor-only keyframe bake intent after baking", async () => {
    installMockFormData();

    const config = {
      animations: {
        default: { id: "idle", name: "Idle", asset: "assets/idle.svg" },
        clips: []
      }
    };
    const form = {
      values: {
        id: "look",
        name: "Look",
        asset: "assets/look-transparent.webm",
        type: "keyframe",
        isDefault: "false"
      }
    };
    const state = {
      selectedClipId: "",
      animationDraft: {
        selectedClipId: "",
        clip: {
          keyframes: [{ input: 0, output: 0 }],
          greenScreenBakeEnabled: false
        }
      }
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await saveAnimationFromForm(form, config, saveConfig, state, vi.fn());

    const savedClip = saveConfig.mock.calls[0][0].animations.clips[0];
    expect(savedClip.asset).toBe("assets/look-transparent.webm");
    expect(savedClip.greenScreenBakeEnabled).toBeUndefined();
    expect(savedClip.greenScreen).toBeUndefined();
  });
});
