import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleChange,
  handleClickAction,
  handleInput,
  handleInlineActionDragOver,
  handleInlineActionDragStart,
  handleInlineActionDrop
} from "../../src/renderer/panel/handlers/event-handlers";

describe("panel event handlers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.document;
  });

  it("persists completion when first-run onboarding is skipped", async () => {
    const state = {
      savingKey: "",
      onboardingJustCompleted: false,
      config: { system: { onboardingVersion: 0, language: "en" } }
    };
    const render = vi.fn();
    const saveConfig = vi.fn(async (nextConfig) => {
      state.config = nextConfig;
      return nextConfig;
    });

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "skip-onboarding" }
        } : null)
      }
    }, state, {}, saveConfig, render);

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ system: expect.objectContaining({ onboardingVersion: 1 }) }),
      "onboarding",
      { silent: true }
    );
    expect(state.config.system.language).toBe("en");
    expect(state.onboardingJustCompleted).toBe(false);
  });

  it("downloads, imports, switches, and completes onboarding with one action", async () => {
    const state = {
      savingKey: "",
      onboardingJustCompleted: false,
      config: {
        currentPackageId: "default-pet",
        system: { onboardingVersion: 0 }
      }
    };
    const api = {
      petpack: {
        installSample: vi.fn(async () => ({ ok: true, packageId: "taotao" }))
      },
      packages: {
        switch: vi.fn(async () => ({
          currentPackageId: "taotao",
          system: { onboardingVersion: 0 }
        }))
      }
    };
    const render = vi.fn();
    const refreshPackagesAndAssets = vi.fn(async () => {});
    const saveConfig = vi.fn(async (nextConfig) => {
      state.config = nextConfig;
      return nextConfig;
    });

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "install-sample-petpack" }
        } : null)
      }
    }, state, api, saveConfig, render, refreshPackagesAndAssets);

    expect(api.petpack.installSample).toHaveBeenCalledOnce();
    expect(api.packages.switch).toHaveBeenCalledWith("taotao");
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        currentPackageId: "taotao",
        system: expect.objectContaining({ onboardingVersion: 1 })
      }),
      "onboarding",
      { silent: true }
    );
    expect(state.onboardingJustCompleted).toBe(true);
  });

  it("checks for updates and stores an available update state", async () => {
    const state = {
      savingKey: "",
      aboutInfo: { version: "0.1.0" },
      updateCheck: { status: "idle" },
      config: { system: { language: "en" } }
    };
    const api = {
      system: {
        about: {
          checkForUpdates: vi.fn(async () => ({
            ok: true,
            currentVersion: "0.1.0",
            latestVersion: "0.2.0",
            updateAvailable: true,
            releaseName: "v0.2.0"
          }))
        }
      }
    };
    const render = vi.fn();

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "check-for-updates" }
        } : null)
      }
    }, state, api, vi.fn(), render);

    expect(api.system.about.checkForUpdates).toHaveBeenCalledOnce();
    expect(state.updateCheck).toEqual({
      status: "available",
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      releaseName: "v0.2.0"
    });
    expect(state.savingKey).toBe("");
    expect(render).toHaveBeenCalled();
  });

  it("opens only named official links through the preload API", async () => {
    const state = { savingKey: "", config: {} };
    const api = {
      system: {
        about: {
          openLink: vi.fn(async () => ({ ok: true, target: "github" }))
        }
      }
    };

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "open-official-link", target: "github" }
        } : null)
      }
    }, state, api, vi.fn(), vi.fn());

    expect(api.system.about.openLink).toHaveBeenCalledWith("github");
  });

  it("stores keyframe green-screen intent only in the animation draft", async () => {
    const form = {
      elements: {
        id: { value: "look" },
        name: { value: "Look" },
        asset: { value: "assets/look.mp4" },
        type: { value: "keyframe" },
        greenScreenBakeEnabled: { checked: true },
        greenScreenColor: { value: "#11ff22" },
        greenScreenTolerance: { value: "40" },
        greenScreenSoftness: { value: "12" }
      }
    };
    const target = {
      name: "greenScreenBakeEnabled",
      checked: true,
      closest: vi.fn((selector) => selector === "form" ? form : null)
    };
    const state = {
      selectedClipId: "look",
      config: {
        animations: {
          default: { id: "idle", asset: "assets/idle.svg" },
          clips: [{ id: "look", name: "Look", asset: "assets/look.mp4", type: "keyframe" }]
        }
      }
    };
    const render = vi.fn();

    await handleChange({ target }, state, {}, render, vi.fn(), vi.fn());

    expect(state.animationDraft).toEqual({
      selectedClipId: "look",
      clip: expect.objectContaining({
        id: "look",
        type: "keyframe",
        greenScreenBakeEnabled: true,
        greenScreen: {
          enabled: true,
          color: "#11ff22",
          tolerance: 0.4,
          softness: 0.12
        }
      })
    });
    expect(state.config.animations.clips[0].greenScreenBakeEnabled).toBeUndefined();
    expect(render).toHaveBeenCalledOnce();
  });

  it("applies display scale while the slider moves without saving", async () => {
    const scaleValue = { textContent: "" };
    globalThis.document = {
      querySelector: vi.fn((selector) => selector === "#scale-value" ? scaleValue : null)
    };
    const state = {
      config: {
        display: { scale: 1, opacity: 0.8, alwaysOnTop: true }
      }
    };
    const api = {
      pet: {
        applyDisplay: vi.fn(async () => {})
      }
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    handleInput({ target: { id: "display-scale", value: "125" } }, state, vi.fn(), api, saveConfig);

    expect(scaleValue.textContent).toBe("125%");
    expect(state.config.display).toMatchObject({ scale: 1.25, opacity: 0.8, alwaysOnTop: true });
    expect(api.pet.applyDisplay).toHaveBeenCalledWith(state.config.display);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("applies display opacity while the slider moves without saving", async () => {
    const opacityValue = { textContent: "" };
    globalThis.document = {
      querySelector: vi.fn((selector) => selector === "#opacity-value" ? opacityValue : null)
    };
    const state = {
      config: {
        display: { scale: 1, opacity: 0.8, alwaysOnTop: true }
      }
    };
    const api = {
      pet: {
        applyDisplay: vi.fn(async () => {})
      }
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    handleInput({ target: { id: "display-opacity", value: "65" } }, state, vi.fn(), api, saveConfig);

    expect(opacityValue.textContent).toBe("65%");
    expect(state.config.display).toMatchObject({ scale: 1, opacity: 0.65, alwaysOnTop: true });
    expect(api.pet.applyDisplay).toHaveBeenCalledWith(state.config.display);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("saves display scale when the slider change is committed", async () => {
    const state = {
      config: {
        display: { scale: 1, opacity: 0.8, alwaysOnTop: true }
      }
    };
    const api = {
      pet: {
        applyDisplay: vi.fn(async () => {})
      }
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await handleChange({ target: { id: "display-scale", value: "125" } }, state, api, vi.fn(), saveConfig);

    expect(saveConfig).toHaveBeenCalledWith(state.config, "display");
    expect(state.config.display.scale).toBe(1.25);
  });

  it("saves display opacity when the slider change is committed", async () => {
    const state = {
      config: {
        display: { scale: 1, opacity: 0.8, alwaysOnTop: true }
      }
    };
    const api = {
      pet: {
        applyDisplay: vi.fn(async () => {})
      }
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await handleChange({ target: { id: "display-opacity", value: "65" } }, state, api, vi.fn(), saveConfig);

    expect(saveConfig).toHaveBeenCalledWith(state.config, "display");
    expect(state.config.display.opacity).toBe(0.65);
  });

  it("applies and saves display toggles immediately", async () => {
    const state = {
      config: {
        display: { scale: 1, opacity: 0.8, alwaysOnTop: true, mousePassthrough: false }
      }
    };
    const api = {
      pet: {
        applyDisplay: vi.fn(async () => {}),
        setAlwaysOnTop: vi.fn(async () => {}),
        setMousePassthrough: vi.fn(async () => {})
      }
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await handleChange({ target: { name: "alwaysOnTop", checked: false } }, state, api, vi.fn(), saveConfig);
    await handleChange({ target: { name: "mousePassthrough", checked: true } }, state, api, vi.fn(), saveConfig);

    expect(api.pet.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(api.pet.setMousePassthrough).toHaveBeenCalledWith(true);
    expect(state.config.display).toMatchObject({ alwaysOnTop: false, mousePassthrough: true });
    expect(saveConfig).toHaveBeenCalledTimes(2);
  });

  it("refreshes animation preview when green screen controls change", async () => {
    const form = {
      elements: {
        id: { value: "green" },
        name: { value: "Green" },
        asset: { value: "assets/green.mp4" },
        type: { value: "loop" },
        greenScreenEnabled: { checked: true },
        greenScreenColor: { value: "#11ff22" },
        greenScreenTolerance: { value: "40" },
        greenScreenSoftness: { value: "12" }
      }
    };
    const target = {
      name: "greenScreenEnabled",
      checked: true,
      closest: vi.fn((selector) => selector === "form" ? form : null)
    };
    const state = {
      selectedClipId: "green",
      config: {
        animations: {
          default: { id: "idle", asset: "assets/idle.svg" },
          clips: [
            {
              id: "green",
              name: "Green",
              asset: "assets/green.mp4",
              type: "loop",
              greenScreen: { enabled: false, color: "#00ff00", tolerance: 0.35, softness: 0.08 }
            }
          ]
        }
      }
    };
    const render = vi.fn();
    const saveConfig = vi.fn();
    const refreshAnimationPreview = vi.fn();

    await handleChange({ target }, state, {}, render, saveConfig, refreshAnimationPreview);

    expect(state.animationDraft.clip.greenScreen).toEqual({
      enabled: true,
      color: "#11ff22",
      tolerance: 0.4,
      softness: 0.12
    });
    expect(refreshAnimationPreview).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("reorders inline action rows via drag and drop", () => {
    const createClassList = () => {
      const values = new Set();
      return {
        add: (value) => values.add(value),
        remove: (value) => values.delete(value),
        contains: (value) => values.has(value)
      };
    };

    let rows = [];
    const container = {
      dataset: { scope: "actions" },
      querySelectorAll: vi.fn(() => rows),
      querySelector: vi.fn((selector) => (
        selector === ".inline-action-row.dragging"
          ? rows.find((row) => row.classList.contains("dragging")) || null
          : null
      )),
      insertBefore: vi.fn((row, beforeRow) => {
        rows = rows.filter((item) => item !== row);
        rows.splice(rows.indexOf(beforeRow), 0, row);
      }),
      appendChild: vi.fn((row) => {
        rows = rows.filter((item) => item !== row);
        rows.push(row);
      })
    };

    const createRow = (id, index, top) => {
      const number = { textContent: `${index + 1}.` };
      let row;
      row = {
        id,
        dataset: { scope: "actions", index: String(index) },
        classList: createClassList(),
        querySelector: vi.fn((selector) => selector === ".action-number" ? number : null),
        closest: vi.fn((selector) => selector === "[data-inline-action]" ? row : null),
        getBoundingClientRect: vi.fn(() => ({ top, height: 20 })),
        number
      };
      return row;
    };

    const rowA = createRow("a", 0, 0);
    const rowB = createRow("b", 1, 30);
    const rowC = createRow("c", 2, 60);
    rows = [rowA, rowB, rowC];

    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn()
    };

    expect(handleInlineActionDragStart({
      target: { closest: vi.fn((selector) => selector === "[data-inline-action]" ? rowA : null) },
      dataTransfer
    })).toBe(true);
    expect(rowA.classList.contains("dragging")).toBe(true);

    expect(handleInlineActionDragOver({
      target: { closest: vi.fn((selector) => selector === ".inline-actions-list" ? container : null) },
      clientY: 100,
      dataTransfer,
      preventDefault: vi.fn()
    })).toBe(true);

    expect(rows.map((row) => row.id)).toEqual(["b", "c", "a"]);

    expect(handleInlineActionDrop({
      target: { closest: vi.fn((selector) => selector === ".inline-actions-list" ? container : null) },
      preventDefault: vi.fn()
    })).toBe(true);

    expect(rowA.classList.contains("dragging")).toBe(false);
    expect(rows.map((row) => row.dataset.index)).toEqual(["0", "1", "2"]);
    expect(rows.map((row) => row.number.textContent)).toEqual(["1.", "2.", "3."]);
  });

  it("does not start reordering from inline action form controls", () => {
    const select = {};
    const row = {
      dataset: { scope: "actions", index: "0" },
      classList: { add: vi.fn() }
    };
    const target = {
      closest: vi.fn((selector) => {
        if (selector === "[data-inline-action]") return row;
        if (selector === "input, select, textarea, button, option") return select;
        return null;
      })
    };
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn()
    };

    expect(handleInlineActionDragStart({ target, dataTransfer })).toBe(false);
    expect(row.classList.add).not.toHaveBeenCalled();
    expect(dataTransfer.setData).not.toHaveBeenCalled();
  });

  it("tracks selected rules for multi-export", async () => {
    const state = {
      selectedRuleExportIds: [],
      config: {
        triggerRules: [
          { id: "rule-a", conditions: [{ type: "click" }], actions: [] },
          { id: "rule-b", conditions: [{ type: "timer" }], actions: [] }
        ]
      }
    };
    const render = vi.fn();

    const toggleButton = {
      dataset: { action: "toggle-rule-export-selection", id: "rule-a" },
      checked: true,
      querySelector: () => null
    };
    await handleClickAction({
      target: {
        closest: vi.fn((selector) => {
          if (selector === "[data-action]") return toggleButton;
          return null;
        })
      }
    }, state, {}, vi.fn(), render);

    expect(state.selectedRuleExportIds).toEqual(["rule-a"]);
    expect(render).toHaveBeenCalledTimes(1);

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "toggle-all-rule-exports" }
        } : null)
      }
    }, state, {}, vi.fn(), render);

    expect(state.selectedRuleExportIds).toEqual(["rule-a", "rule-b"]);

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "toggle-all-rule-exports" }
        } : null)
      }
    }, state, {}, vi.fn(), render);

    expect(state.selectedRuleExportIds).toEqual([]);
  });

  it("selects a package asset without rerendering the full assets page", async () => {
    const oldRow = { setAttribute: vi.fn() };
    const newRow = { setAttribute: vi.fn() };
    const detail = { outerHTML: "" };
    globalThis.document = {
      querySelector: vi.fn((selector) => {
        if (selector === '[data-action="select-package-asset"][aria-selected="true"]') return oldRow;
        if (selector === '[data-action="select-package-asset"][data-asset="assets/click.svg"]') return newRow;
        if (selector === ".asset-detail[data-drop-target=\"replace-package-asset\"]") return detail;
        return null;
      })
    };
    const state = {
      selectedPackageAsset: "assets/idle.svg",
      packageAssets: [
        { asset: "assets/idle.svg", url: "file:///idle.svg", name: "idle.svg", ext: ".svg" },
        { asset: "assets/click.svg", url: "file:///click.svg", name: "click.svg", ext: ".svg" }
      ],
      config: {
        animations: { default: { id: "idle", asset: "assets/idle.svg" }, clips: [] },
        triggerRules: []
      }
    };
    const render = vi.fn();

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "select-package-asset", asset: "assets/click.svg" }
        } : null)
      }
    }, state, {}, vi.fn(), render);

    expect(state.selectedPackageAsset).toBe("assets/click.svg");
    expect(oldRow.setAttribute).toHaveBeenCalledWith("aria-selected", "false");
    expect(newRow.setAttribute).toHaveBeenCalledWith("aria-selected", "true");
    expect(detail.outerHTML).toContain('data-asset="assets/click.svg"');
    expect(render).not.toHaveBeenCalled();
  });

  it("opens and closes the animation editor from animation list actions", async () => {
    const state = {
      selectedClipId: undefined,
      animationDraft: { selectedClipId: "old", clip: { name: "Old" } }
    };
    const render = vi.fn();

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "select-animation", clipId: "wave" }
        } : null)
      }
    }, state, {}, vi.fn(), render);

    expect(state.selectedClipId).toBe("wave");
    expect(state.animationEditorOpen).toBe(true);
    expect(state.animationDraft).toBeNull();

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "close-animation-editor" }
        } : null)
      }
    }, state, {}, vi.fn(), render);

    expect(state.animationEditorOpen).toBe(false);
    expect(state.animationDraft).toBeNull();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("exports only selected rules", async () => {
    const ruleA = { id: "rule-a", conditions: [{ type: "click" }], actions: [] };
    const ruleB = { id: "rule-b", conditions: [{ type: "timer" }], actions: [] };
    const state = {
      selectedRuleExportIds: ["rule-b"],
      config: {
        currentPackageId: "default-pet",
        triggerRules: [ruleA, ruleB]
      }
    };
    const api = {
      rules: {
        export: vi.fn(async () => ({ ok: true, targetPath: "/tmp/rules.json", count: 1 }))
      }
    };

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "export-selected-rules" }
        } : null)
      }
    }, state, api, vi.fn(), vi.fn());

    expect(api.rules.export).toHaveBeenCalledWith({
      target: "file",
      packageId: "default-pet",
      rules: [ruleB]
    });
  });

  it("copies selected rules to the clipboard", async () => {
    const ruleA = { id: "rule-a", conditions: [{ type: "click" }], actions: [] };
    const ruleB = { id: "rule-b", conditions: [{ type: "timer" }], actions: [] };
    const state = {
      selectedRuleExportIds: ["rule-a", "rule-b"],
      config: {
        currentPackageId: "default-pet",
        triggerRules: [ruleA, ruleB]
      }
    };
    const api = {
      rules: {
        export: vi.fn(async () => ({ ok: true, target: "clipboard", count: 2 }))
      }
    };

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "export-selected-rules-clipboard" }
        } : null)
      }
    }, state, api, vi.fn(), vi.fn());

    expect(api.rules.export).toHaveBeenCalledWith({
      target: "clipboard",
      packageId: "default-pet",
      rules: [ruleA, ruleB]
    });
  });

  it("imports rules by appending them and renaming conflicting ids", async () => {
    const state = {
      selectedRuleExportIds: [],
      config: {
        currentPackageId: "default-pet",
        animations: {
          default: { id: "idle", asset: "assets/idle.svg" },
          clips: []
        },
        triggerRules: [
          { id: "rule-a", name: "Existing", conditions: [{ type: "click" }], actions: [] }
        ]
      }
    };
    const api = {
      rules: {
        import: vi.fn(async () => ({
          ok: true,
          rules: [
            { id: "rule-a", name: "Imported A", conditions: [{ type: "click" }], actions: [{ type: "playAnimation", animation: "idle" }] },
            { id: "rule-b", name: "Imported B", conditions: [{ type: "timer" }], actions: [] }
          ]
        }))
      }
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "import-rules-file" }
        } : null)
      }
    }, state, api, saveConfig, vi.fn());

    expect(api.rules.import).toHaveBeenCalledWith({ source: "file" });
    expect(saveConfig).toHaveBeenCalledTimes(1);
    const savedRules = saveConfig.mock.calls[0][0].triggerRules;
    expect(savedRules).toHaveLength(3);
    expect(savedRules[0].id).toBe("rule-a");
    expect(savedRules[1].id).not.toBe("rule-a");
    expect(savedRules[1].name).toBe("Imported A");
    expect(savedRules[2].id).toBe("rule-b");
  });

  it("imports rules that reference unavailable animations", async () => {
    const state = {
      config: {
        animations: {
          default: { id: "idle", asset: "assets/idle.svg" },
          clips: []
        },
        triggerRules: []
      }
    };
    const api = {
      rules: {
        import: vi.fn(async () => ({
          ok: true,
          rules: [
            { id: "rule-bad", conditions: [{ type: "click" }], actions: [{ type: "playAnimation", animation: "missing" }] }
          ]
        }))
      }
    };
    const saveConfig = vi.fn(async (nextConfig) => nextConfig);

    await handleClickAction({
      target: {
        closest: vi.fn((selector) => selector === "[data-action]" ? {
          dataset: { action: "import-rules-clipboard" }
        } : null)
      }
    }, state, api, saveConfig, vi.fn());

    expect(api.rules.import).toHaveBeenCalledWith({ source: "clipboard" });
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig.mock.calls[0][0].triggerRules).toEqual([
      { id: "rule-bad", conditions: [{ type: "click" }], actions: [{ type: "playAnimation", animation: "missing" }] }
    ]);
  });
});
