import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import assetStoreModule from "../../src/main/services/asset-store";

const {
  copyAssetToPackage,
  deleteAssetFromPackage,
  replaceAssetInPackage,
  getGifDurationMs,
  validateAsset,
  _internals
} = assetStoreModule;

function createTestGifWithDelays(delays) {
  const header = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00,
    0x80, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0xff, 0xff, 0xff
  ];
  const frames = delays.flatMap((delay) => [
    0x21, 0xf9, 0x04, 0x00, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00
  ]);
  return Buffer.from([...header, ...frames, 0x3b]);
}

describe("asset-store", () => {
  let tempDir;
  let packageDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-assets-"));
    packageDir = path.join(tempDir, "packages", "demo");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("validates a supported readable file", () => {
    const sourcePath = path.join(tempDir, "idle.PNG");
    fs.writeFileSync(sourcePath, "png data", "utf8");

    expect(validateAsset(sourcePath)).toEqual({
      ok: true,
      ext: ".png",
      size: 8
    });
  });

  it("rejects unsupported extensions", () => {
    const sourcePath = path.join(tempDir, "notes.txt");
    fs.writeFileSync(sourcePath, "not an asset", "utf8");

    expect(validateAsset(sourcePath)).toEqual({
      ok: false,
      error: "Unsupported asset extension: .txt"
    });
  });

  it("rejects symbolic links even when the link has a supported extension", () => {
    const targetPath = path.join(tempDir, "notes.txt");
    const symlinkPath = path.join(tempDir, "looks-like-asset.svg");
    fs.writeFileSync(targetPath, "not an asset", "utf8");
    try {
      fs.symlinkSync(targetPath, symlinkPath);
    } catch (error) {
      if (process.platform === "win32" && error && error.code === "EPERM") {
        const junctionTarget = path.join(tempDir, "junction-target");
        fs.mkdirSync(junctionTarget);
        fs.symlinkSync(junctionTarget, symlinkPath, "junction");
      } else {
        throw error;
      }
    }

    expect(validateAsset(symlinkPath)).toEqual({
      ok: false,
      error: "Asset path cannot be a symbolic link"
    });
  });

  it("allows files over 50 MB", () => {
    const sourcePath = path.join(tempDir, "large.webm");
    const file = fs.openSync(sourcePath, "w");
    const size = (50 * 1024 * 1024) + 1;
    fs.ftruncateSync(file, size);
    fs.closeSync(file);

    expect(validateAsset(sourcePath)).toEqual({
      ok: true,
      ext: ".webm",
      size
    });
  });

  it("reads total duration from GIF frame delays", () => {
    expect(getGifDurationMs(createTestGifWithDelays([5, 10, 25]))).toBe(400);
  });

  it("copies assets into the package assets directory with collision-safe names", () => {
    const firstSource = path.join(tempDir, "idle.svg");
    const secondSource = path.join(tempDir, "nested", "idle.svg");
    fs.mkdirSync(path.dirname(secondSource), { recursive: true });
    fs.writeFileSync(firstSource, "<svg>first</svg>", "utf8");
    fs.writeFileSync(secondSource, "<svg>second</svg>", "utf8");

    const firstResult = copyAssetToPackage({ sourcePath: firstSource, packageDir });
    const secondResult = copyAssetToPackage({ sourcePath: secondSource, packageDir });

    expect(firstResult).toEqual({ ok: true, asset: "assets/idle.svg" });
    expect(secondResult).toEqual({ ok: true, asset: "assets/idle-1.svg" });
    expect(fs.readFileSync(path.join(packageDir, "assets", "idle.svg"), "utf8")).toBe("<svg>first</svg>");
    expect(fs.readFileSync(path.join(packageDir, "assets", "idle-1.svg"), "utf8")).toBe("<svg>second</svg>");
  });

  it("copies assets with a user-provided import name while preserving the extension", () => {
    const sourcePath = path.join(tempDir, "original idle.svg");
    fs.writeFileSync(sourcePath, "<svg>named</svg>", "utf8");

    const result = copyAssetToPackage({
      sourcePath,
      packageDir,
      importName: "happy idle"
    });

    expect(result).toEqual({
      ok: true,
      asset: "assets/happy_idle.svg",
      displayName: "happy_idle.svg"
    });
    expect(fs.readFileSync(path.join(packageDir, "assets", "happy_idle.svg"), "utf8")).toBe("<svg>named</svg>");
  });

  it("rejects duplicate user-provided import names instead of auto-renaming", () => {
    const sourcePath = path.join(tempDir, "original idle.svg");
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "assets", "happy_idle.svg"), "<svg>old</svg>", "utf8");
    fs.writeFileSync(sourcePath, "<svg>new</svg>", "utf8");

    const result = copyAssetToPackage({
      sourcePath,
      packageDir,
      importName: "happy idle"
    });

    expect(result).toEqual({
      ok: false,
      error: "Asset name already exists: happy_idle.svg"
    });
    expect(fs.readFileSync(path.join(packageDir, "assets", "happy_idle.svg"), "utf8")).toBe("<svg>old</svg>");
  });

  it("preserves Chinese characters in user-provided import names", () => {
    const sourcePath = path.join(tempDir, "idle.svg");
    fs.writeFileSync(sourcePath, "<svg>中文</svg>", "utf8");

    const result = copyAssetToPackage({
      sourcePath,
      packageDir,
      importName: "开心 动画"
    });

    expect(result).toEqual({
      ok: true,
      asset: "assets/开心_动画.svg",
      displayName: "开心_动画.svg"
    });
    expect(fs.existsSync(path.join(packageDir, "assets", "开心_动画.svg"))).toBe(true);
  });

  it("converts MOV imports to WebM when a transcoder is available", () => {
    const sourcePath = path.join(tempDir, "alpha.mov");
    fs.writeFileSync(sourcePath, "mov", "utf8");

    const result = copyAssetToPackage({
      sourcePath,
      packageDir,
      movTranscoder: (_source, target) => fs.writeFileSync(target, "webm", "utf8")
    });

    expect(result).toEqual({
      ok: true,
      asset: "assets/alpha.webm",
      convertedFrom: ".mov"
    });
    expect(fs.existsSync(path.join(packageDir, "assets", "alpha.mov"))).toBe(false);
    expect(fs.readFileSync(path.join(packageDir, "assets", "alpha.webm"), "utf8")).toBe("webm");
  });

  it("uses alpha-safe all-keyframe VP9 output args for MOV conversion", () => {
    const args = _internals.getMovTranscodeArgs("alpha.mov", "alpha.webm");

    expect(args).toContain("libvpx-vp9");
    expect(args).toContain("yuva420p");
    expect(args).toEqual(expect.arrayContaining([
      "-auto-alt-ref", "0",
      "-metadata:s:v:0", "alpha_mode=1",
      "-g", "1",
      "-keyint_min", "1",
      "-lag-in-frames", "0",
      "-row-mt", "1"
    ]));
  });

  it("forces libvpx-vp9 input decoding only for VP9 MOV sources", () => {
    const vp9Args = _internals.getMovTranscodeArgs("alpha.mov", "alpha.webm", { inputCodec: "vp9" });
    const h264Args = _internals.getMovTranscodeArgs("clip.mov", "clip.webm", { inputCodec: "h264" });
    const vp9InputIndex = vp9Args.indexOf("-i");
    const h264InputIndex = h264Args.indexOf("-i");

    expect(vp9Args.slice(vp9InputIndex - 2, vp9InputIndex + 2)).toEqual(["-c:v", "libvpx-vp9", "-i", "alpha.mov"]);
    expect(h264Args.slice(h264InputIndex - 2, h264InputIndex + 2)).not.toEqual(["-c:v", "libvpx-vp9", "-i", "clip.mov"]);
    expect(h264Args.slice(h264InputIndex, h264InputIndex + 2)).toEqual(["-i", "clip.mov"]);
  });

  it("bakes green screen with a colorkey filter into alpha-safe all-keyframe VP9 output", () => {
    const args = _internals.getColorkeyTranscodeArgs("looking.mp4", "looking.webm", {
      color: "#019d5f",
      tolerance: 0.22,
      softness: 0.08
    });

    // filter present with normalized hex + similarity/blend + alpha format
    const vfIndex = args.indexOf("-vf");
    expect(vfIndex).toBeGreaterThan(-1);
    expect(args[vfIndex + 1]).toBe("colorkey=0x019d5f:0.22:0.08,format=yuva420p");

    expect(args).toContain("-an");
    expect(args).toContain("libvpx-vp9");
    expect(args).toContain("yuva420p");
    expect(args).toEqual(expect.arrayContaining([
      "-auto-alt-ref", "0",
      "-metadata:s:v:0", "alpha_mode=1",
      "-g", "1",
      "-keyint_min", "1"
    ]));
  });

  it("normalizes/ clamps colorkey params and defaults an invalid color", () => {
    const args = _internals.getColorkeyTranscodeArgs("looking.mp4", "looking.webm", {
      color: "not-a-color",
      tolerance: 5,
      softness: -1
    });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toBe("colorkey=0x00ff00:1:0,format=yuva420p");
  });

  it("emits progress flags only when requested for colorkey baking", () => {
    const withProgress = _internals.getColorkeyTranscodeArgs("a.mp4", "a.webm", { color: "#00ff00", progress: true });
    const withoutProgress = _internals.getColorkeyTranscodeArgs("a.mp4", "a.webm", { color: "#00ff00" });
    expect(withProgress).toEqual(expect.arrayContaining(["-progress", "pipe:1"]));
    expect(withoutProgress).toEqual(expect.arrayContaining(["-loglevel", "error"]));
    expect(withoutProgress).not.toContain("-progress");
  });

  it("parses the input video codec from ffmpeg probe output", () => {
    const probeOutput = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'alpha.mov':",
      "  Stream #0:0(eng): Video: vp9 (Profile 0), yuva420p, 720x720"
    ].join("\n");

    expect(_internals.parseVideoCodecName(probeOutput)).toBe("vp9");
    expect(_internals.parseVideoCodecName("no video stream")).toBe("");
    expect(_internals.getVideoCodecName("alpha.mov", process.execPath)).toBe("");
  });

  it("deletes safe package assets and rejects unsafe paths", () => {
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "assets", "idle.svg"), "<svg></svg>", "utf8");

    expect(deleteAssetFromPackage({ packageDir, assetPath: "../escape.svg" })).toEqual({
      ok: false,
      error: "Asset path is unsafe"
    });
    expect(deleteAssetFromPackage({ packageDir, assetPath: "assets/idle.svg" })).toEqual({
      ok: true,
      asset: "assets/idle.svg"
    });
    expect(fs.existsSync(path.join(packageDir, "assets", "idle.svg"))).toBe(false);
  });

  it("replaces an existing package asset when extensions match", () => {
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    const sourcePath = path.join(tempDir, "new-idle.svg");
    const targetPath = path.join(packageDir, "assets", "idle.svg");
    fs.writeFileSync(sourcePath, "<svg>new</svg>", "utf8");
    fs.writeFileSync(targetPath, "<svg>old</svg>", "utf8");

    expect(replaceAssetInPackage({
      packageDir,
      sourcePath,
      targetAssetPath: "assets/idle.svg"
    })).toEqual({ ok: true, asset: "assets/idle.svg" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("<svg>new</svg>");
  });

  it("replaces converted WebM assets from MOV sources when a transcoder is available", () => {
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    const sourcePath = path.join(tempDir, "alpha.mov");
    const targetPath = path.join(packageDir, "assets", "alpha.webm");
    fs.writeFileSync(sourcePath, "mov", "utf8");
    fs.writeFileSync(targetPath, "old webm", "utf8");

    expect(replaceAssetInPackage({
      packageDir,
      sourcePath,
      targetAssetPath: "assets/alpha.webm",
      movTranscoder: (_source, target) => fs.writeFileSync(target, "new webm", "utf8")
    })).toEqual({ ok: true, asset: "assets/alpha.webm", convertedFrom: ".mov" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("new webm");
  });

  it("rejects replacement when source and target extensions differ", () => {
    fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
    const sourcePath = path.join(tempDir, "new-idle.png");
    const targetPath = path.join(packageDir, "assets", "idle.svg");
    fs.writeFileSync(sourcePath, "png", "utf8");
    fs.writeFileSync(targetPath, "<svg>old</svg>", "utf8");

    expect(replaceAssetInPackage({
      packageDir,
      sourcePath,
      targetAssetPath: "assets/idle.svg"
    })).toEqual({ ok: false, error: "Replacement file extension must match the selected asset" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("<svg>old</svg>");
  });

  it("rejects replacement for unsafe or missing target assets", () => {
    const sourcePath = path.join(tempDir, "new-idle.svg");
    fs.writeFileSync(sourcePath, "<svg>new</svg>", "utf8");

    expect(replaceAssetInPackage({
      packageDir,
      sourcePath,
      targetAssetPath: "../idle.svg"
    })).toEqual({ ok: false, error: "Asset path is unsafe" });

    expect(replaceAssetInPackage({
      packageDir,
      sourcePath,
      targetAssetPath: "assets/missing.svg"
    })).toEqual({ ok: false, error: "Target asset file does not exist" });
  });
});
