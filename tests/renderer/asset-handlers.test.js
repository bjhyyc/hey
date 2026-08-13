import { describe, expect, it, vi } from "vitest";
import { deleteReferencedAsset, handleBakeGreenScreen } from "../../src/renderer/panel/handlers/asset-handlers";

describe("asset handlers", () => {
  it("deletes package assets from the current package instead of stale import state", async () => {
    const api = {
      assets: {
        delete: vi.fn(async () => ({ ok: true, asset: "assets/wave.webm" }))
      },
      config: {
        save: vi.fn(async (config) => config),
        load: vi.fn(async () => ({
          currentPackageId: "current-pet",
          animations: { default: { id: "idle", asset: "" }, clips: [] },
          triggerRules: []
        }))
      }
    };
    const state = {
      selectedAssetPackageId: "old-import-pet",
      config: {
        currentPackageId: "current-pet",
        animations: {
          default: { id: "idle", asset: "assets/idle.svg" },
          clips: [{ id: "wave", asset: "assets/wave.webm" }]
        },
        triggerRules: []
      },
      savingKey: ""
    };

    await deleteReferencedAsset("assets/wave.webm", api, state, vi.fn());

    expect(api.assets.delete).toHaveBeenCalledWith("assets/wave.webm", "current-pet");
  });

  it("bakes an unsaved keyframe draft and updates the draft without persisting editor-only state", async () => {
    const api = {
      assets: {
        bakeGreenScreen: vi.fn(async () => ({
          ok: true,
          asset: "assets/look-transparent.webm"
        }))
      },
      config: {
        save: vi.fn(),
        load: vi.fn()
      }
    };
    const state = {
      config: {
        currentPackageId: "current-pet",
        animations: {
          default: { id: "idle", asset: "assets/idle.svg" },
          clips: []
        }
      },
      animationDraft: {
        selectedClipId: "",
        clip: {
          id: "",
          name: "Look",
          asset: "assets/look.mp4",
          type: "keyframe",
          greenScreenBakeEnabled: true,
          greenScreen: { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 },
          keyframes: [{ input: 0, output: 0 }]
        }
      },
      packageAssets: []
    };
    const form = {
      elements: {
        greenScreenColor: { value: "#11ff22" },
        greenScreenTolerance: { value: "40" },
        greenScreenSoftness: { value: "12" }
      }
    };
    const render = vi.fn();
    const refreshPackagesAndAssets = vi.fn(async () => {
      state.packageAssets = [{
        asset: "assets/look-transparent.webm",
        url: "file:///pets/look-transparent.webm"
      }];
    });

    await handleBakeGreenScreen("", form, api, state, render, refreshPackagesAndAssets);

    expect(api.assets.bakeGreenScreen).toHaveBeenCalledWith(
      "current-pet",
      "assets/look.mp4",
      { color: "#11ff22", tolerance: 0.4, softness: 0.12 },
      expect.stringMatching(/^asset-bake-/)
    );
    expect(api.config.save).not.toHaveBeenCalled();
    expect(state.animationDraft.clip).toEqual(expect.objectContaining({
      asset: "assets/look-transparent.webm",
      type: "keyframe",
      greenScreenBakeEnabled: false
    }));
    expect(state.animationDraft.clip.greenScreen).toBeUndefined();
    expect(state.keyframeEditorAssetUrl).toBe("file:///pets/look-transparent.webm");
    expect(state.savingKey).toBe("");
    expect(state.assetProgress).toBeNull();
    expect(refreshPackagesAndAssets).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledTimes(2);
  });
});
