import { describe, expect, it } from "vitest";
import { getAssetReferences, renderAssets, renderPackageAssetDetail } from "../../src/renderer/panel/tabs/assets";

describe("assets tab", () => {
  const IDLE_ID = "50000000-0000-4000-8000-000000000001";
  const CLICK_ID = "50000000-0000-4000-8000-000000000002";
  const config = {
    currentPackageId: "default-pet",
    animations: {
      default: { id: IDLE_ID, name: "Idle", asset: "assets/idle.svg" },
      clips: [
        { id: CLICK_ID, name: "Click", asset: "assets/click.svg", type: "oneshot" },
        { id: "50000000-0000-4000-8000-000000000003", name: "Drag", asset: "assets/drag.svg", type: "loop" },
        { id: "50000000-0000-4000-8000-000000000004", name: "Unused", asset: "assets/unused.svg", type: "oneshot" }
      ]
    },
    triggerRules: [
      {
        id: "click-rule",
        name: "Click reaction",
        actions: [{ type: "playAnimation", animation: CLICK_ID }]
      }
    ]
  };

  it("renders package list, current marker, import name, and package assets with previews", () => {
    const html = renderAssets({
      packageList: [
        { packageId: "default-pet", isCurrent: true },
        { packageId: "space-cat", isCurrent: false }
      ],
      packageAssets: [
        { asset: "assets/idle.svg", url: "file:///default/assets/idle.svg", name: "idle.svg", ext: ".svg" },
        { asset: "assets/click.svg", url: "file:///default/assets/click.svg", name: "click.svg", ext: ".svg" },
        { asset: "assets/wave.mov", url: "file:///default/assets/wave.mov", name: "wave.mov", ext: ".mov" }
      ],
      selectedPackageAsset: "assets/click.svg",
      packageEditMode: true,
      assetEditMode: true
    }, config);

    expect(html).toContain("default-pet");
    expect(html).toContain("data-action=\"switch-package\"");
    expect(html).toContain("data-action=\"export-package\"");
    expect(html).toContain("data-action=\"import-petpack\"");
    expect(html).toContain("data-action=\"start-new-package\"");
    expect(html).toContain("data-action=\"toggle-package-edit\"");
    expect(html).toContain('data-action="delete-package"');
    expect(html).not.toContain('data-package-id="default-pet">Delete</button>');
    expect(html).toContain("Current");
    expect(html).toContain('id="asset-import-name"');
    expect(html).not.toContain('id="asset-package-id"');
    expect(html).toContain('src="file:///default/assets/idle.svg"');
    expect(html).toContain('src="file:///default/assets/wave.mov"');
    expect(html).toContain("<video");
    expect(html).toContain("autoplay");
    expect(html).toContain('preload="auto"');
    expect(html).toContain('data-action="select-package-asset"');
    expect(html).toContain('class="item-row package-asset-row clickable-row"');
    expect(html).not.toContain('class="asset-row-main" type="button" data-action="select-package-asset"');
    expect(html).toContain('data-action="delete-package-asset"');
    expect(html).toContain("Click reaction");
  });

  it("derives direct animation and indirect rule references for package assets", () => {
    expect(getAssetReferences("assets/click.svg", config)).toEqual([
      "Animation: Click",
      "Rule: Click reaction -> Click"
    ]);
    expect(getAssetReferences("assets/idle.svg", config)).toEqual([
      "Animation: Idle (default)"
    ]);
  });

  it("renders a selected package asset detail fragment", () => {
    const html = renderPackageAssetDetail({
      asset: "assets/click.svg",
      url: "file:///default/assets/click.svg",
      name: "click.svg",
      ext: ".svg"
    }, config);

    expect(html).toContain('data-drop-target="replace-package-asset"');
    expect(html).toContain('data-asset="assets/click.svg"');
    expect(html).toContain('src="file:///default/assets/click.svg"');
    expect(html).toContain("Click reaction");
  });

  it("shows MOV conversion notice and import progress", () => {
    const html = renderAssets({
      selectedAssetPath: "/tmp/transparent.mov",
      assetProgress: {
        stage: "converting",
        percent: 42
      },
      packageAssets: []
    }, config);

    expect(html).toContain("MOV cannot be previewed directly");
    expect(html).toContain("Converting MOV to WebM");
    expect(html).toContain('value="42"');
    expect(html).toContain('data-drop-target="import-asset"');
  });
});
