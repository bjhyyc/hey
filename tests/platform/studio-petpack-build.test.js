import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import petpackBuilder from "../../platform/src/petpack/build.js";

const {
  GREEN_SCREEN_CONFIG,
  buildPetpack,
  createStudioPetpackManifest
} = petpackBuilder;

const ACTION_IDS = [
  "idle",
  "sneeze",
  "roll",
  "sleep-transition",
  "sleep-loop",
  "stretch",
  "hover-attention"
];

const CLIP_IDS = {
  idle: "90000000-0000-4000-8000-000000000001",
  sneeze: "90000000-0000-4000-8000-000000000002",
  roll: "90000000-0000-4000-8000-000000000003",
  sleepTransition: "90000000-0000-4000-8000-000000000004",
  sleepLoop: "90000000-0000-4000-8000-000000000005",
  stretch: "90000000-0000-4000-8000-000000000006",
  hoverAttention: "90000000-0000-4000-8000-000000000007"
};

const CLIP_ID_BY_ACTION = Object.fromEntries(ACTION_IDS.map((actionId, index) => [
  actionId,
  Object.values(CLIP_IDS)[index]
]));

function createManifestAssets(matteModes = {}) {
  return ACTION_IDS.map((actionId, index) => ({
    actionId,
    durationMs: 4000 + index * 100,
    ...(Object.prototype.hasOwnProperty.call(matteModes, actionId)
      ? { matteMode: matteModes[actionId] }
      : {})
  }));
}

function createBuildAssets(matteModes = {}) {
  return ACTION_IDS.map((actionId, index) => {
    const buffer = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from(actionId)
    ]);
    const duration = 4 + index;
    return {
      actionId,
      buffer,
      localPath: `fixture/${actionId}.webm`,
      matteMode: matteModes[actionId] || "green-screen",
      container: "webm",
      codec: "vp9",
      expectedSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      qa: {
        media: {
          ok: true,
          summary: {
            codec: "vp9",
            width: 854,
            height: 480,
            fps: 24,
            duration,
            audioStreams: 0
          }
        },
        canvas: { ok: true },
        endpoints: { ok: true },
        content: { ok: true },
        continuity: { ok: true }
      }
    };
  });
}

function createProbe(assets, alphaTags = {}) {
  const byAction = new Map(assets.map((asset) => [asset.actionId, asset]));
  return vi.fn(async ({ actionId, buffer }) => {
    const asset = byAction.get(actionId);
    const duration = asset.qa.media.summary.duration;
    return {
      checksumSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      probe: {
        streams: [{
          codec_type: "video",
          codec_name: "vp9",
          width: 854,
          height: 480,
          avg_frame_rate: "24/1",
          duration: String(duration),
          nb_frames: String(duration * 24),
          ...(alphaTags[actionId] ? { tags: alphaTags[actionId] } : {})
        }],
        format: { format_name: "matroska,webm", duration: String(duration) }
      }
    };
  });
}

function createManifest(assets) {
  return createStudioPetpackManifest({
    packageId: "mixed-matte-pet",
    name: "Mixed Matte Pet",
    version: "1.0.0",
    actionClipIds: CLIP_IDS,
    assets
  });
}

describe("Studio PetPack matte build contract", () => {
  it("keeps legacy manifest-helper inputs on the green-screen playback contract", () => {
    const manifest = createManifest(createManifestAssets());

    expect(manifest.animations.default.greenScreen).toEqual(GREEN_SCREEN_CONFIG);
    for (const clip of manifest.animations.clips) {
      expect(clip.greenScreen).toEqual(GREEN_SCREEN_CONFIG);
    }
  });

  it("writes green-screen config only for green-screen actions in a mixed package", () => {
    const manifest = createManifest(createManifestAssets({
      idle: "alpha",
      roll: "alpha",
      sneeze: "green-screen",
      "sleep-transition": "green-screen",
      "sleep-loop": "green-screen",
      stretch: "green-screen",
      "hover-attention": "green-screen"
    }));

    expect(manifest.animations.default).not.toHaveProperty("greenScreen");
    expect(manifest.animations.clips.find((clip) => clip.name === "roll"))
      .not.toHaveProperty("greenScreen");
    for (const clip of manifest.animations.clips.filter((clip) => clip.name !== "roll")) {
      expect(clip.greenScreen).toEqual(GREEN_SCREEN_CONFIG);
    }
  });

  it("builds a mixed package when alpha probes report either supported alpha tag spelling", async () => {
    const assets = createBuildAssets({ idle: "alpha", roll: "alpha" });
    const probeAsset = createProbe(assets, {
      idle: { ALPHA_MODE: "1" },
      roll: { alpha_mode: "1" }
    });

    const result = await buildPetpack({
      packageId: "mixed-matte-pet",
      name: "Mixed Matte Pet",
      assets,
      idFactory: (actionId) => CLIP_ID_BY_ACTION[actionId],
      probeAsset
    });

    expect(probeAsset).toHaveBeenCalledTimes(ACTION_IDS.length);
    expect(result.manifest.animations.default).not.toHaveProperty("greenScreen");
    expect(result.manifest.animations.clips.find((clip) => clip.name === "roll"))
      .not.toHaveProperty("greenScreen");
    expect(result.manifest.animations.clips.find((clip) => clip.name === "sneeze").greenScreen)
      .toEqual(GREEN_SCREEN_CONFIG);
    expect(result.archive.manifest).toEqual(result.manifest);
  });

  it.each([
    ["missing", undefined],
    ["not enabled", { alpha_mode: "0" }]
  ])("rejects alpha media whose trusted probe alpha tag is %s", async (_label, tags) => {
    const assets = createBuildAssets({ idle: "alpha" });
    const probeAsset = createProbe(assets, tags ? { idle: tags } : {});

    await expect(buildPetpack({
      packageId: "invalid-alpha-pet",
      name: "Invalid Alpha Pet",
      assets,
      idFactory: (actionId) => CLIP_ID_BY_ACTION[actionId],
      probeAsset
    })).rejects.toThrow("idle trusted media probe must report alpha_mode=1 for alpha media");
  });
});
