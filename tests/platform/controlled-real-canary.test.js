import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ffmpegPath from "ffmpeg-static";

import actionCatalog from "../../platform/src/domain/action-catalog.js";
import canaryModule from "../../platform/src/development/controlled-real-canary.js";

const { REQUIRED_ACTION_IDS } = actionCatalog;
const {
  CLASSIFICATION,
  CONTROLLED_PROCESS_TEMP_ROOT,
  CONTROLLED_REAL_CANARY_ROOT,
  MASTER_KINDS,
  runControlledRealCanary
} = canaryModule;

const suiteToken = `${process.pid}-${crypto.randomUUID()}`;
const fixtureDirectory = path.join(CONTROLLED_REAL_CANARY_ROOT, `_fixtures-${suiteToken}`);
const successRunId = `synthetic-success-${suiteToken}`;
const rejectedRunId = `synthetic-rejected-${suiteToken}`;
const productionRunId = `synthetic-production-${suiteToken}`;
const successRunDirectory = path.join(CONTROLLED_REAL_CANARY_ROOT, successRunId);
const rejectedRunDirectory = path.join(CONTROLLED_REAL_CANARY_ROOT, rejectedRunId);
const productionRunDirectory = path.join(CONTROLLED_REAL_CANARY_ROOT, productionRunId);
const createdDirectories = [fixtureDirectory, successRunDirectory, rejectedRunDirectory, productionRunDirectory];

process.env.TEMP = CONTROLLED_PROCESS_TEMP_ROOT;
process.env.TMP = CONTROLLED_PROCESS_TEMP_ROOT;
process.env.TMPDIR = CONTROLLED_PROCESS_TEMP_ROOT;

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      cwd: fixtureDirectory,
      env: {
        ...process.env,
        TEMP: CONTROLLED_PROCESS_TEMP_ROOT,
        TMP: CONTROLLED_PROCESS_TEMP_ROOT,
        TMPDIR: CONTROLLED_PROCESS_TEMP_ROOT
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Synthetic ffmpeg fixture failed (${code}): ${stderr.slice(0, 2000)}`));
    });
  });
}

function assertExactCanaryChild(targetPath) {
  const root = path.resolve(CONTROLLED_REAL_CANARY_ROOT);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Test cleanup target escaped controlled-real root: ${target}`);
  }
  return target;
}

async function writeSidecar(fileName, masters, videos, { rejectActionId } = {}) {
  const sidecarPath = path.join(fixtureDirectory, fileName);
  const createEntry = (sourcePath, accepted = true) => ({
    human: true,
    accepted,
    reviewerNote: accepted
      ? "Synthetic fixture reviewed for controlled-real integration testing only."
      : "Synthetic rejection proves packaging remains fail-closed.",
    sourceSha256: sha256(sourcePath)
  });
  await fsp.writeFile(sidecarPath, `${JSON.stringify({
    schemaVersion: 1,
    reviewedAt: "2026-08-16T00:00:00.000Z",
    masters: Object.fromEntries(MASTER_KINDS.map((kind) => {
      const value = masters[kind];
      const sourcePath = typeof value === "string" ? value : (value.path || value.artifactPath);
      return [kind, createEntry(sourcePath)];
    })),
    videos: Object.fromEntries(REQUIRED_ACTION_IDS.map((actionId) => [
      actionId,
      createEntry(videos[actionId].path, actionId !== rejectActionId)
    ]))
  }, null, 2)}\n`, "utf8");
  return sidecarPath;
}

function makeRequest({ runId, manualQaPath, masters, videos }) {
  return {
    schemaVersion: 1,
    runId,
    packageName: "Synthetic Controlled Real Canary",
    masters,
    videos,
    manualQaPath,
    chroma: { color: "#00FF00", similarity: 0.12, blend: 0.02 }
  };
}

describe("development-only controlled-real postprocess and PetPack runner", () => {
  let masters;
  let videos;
  let acceptedRequest;
  let rejectedRequest;

  beforeAll(async () => {
    await fsp.mkdir(CONTROLLED_PROCESS_TEMP_ROOT, { recursive: true });
    await fsp.mkdir(fixtureDirectory, { recursive: true });

    const masterSeed = path.join(fixtureDirectory, "master-seed.png");
    await runFfmpeg([
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x00FF00:s=640x360:r=1:d=1",
      "-vf", "drawbox=x=220:y=70:w=200:h=240:color=0xFF6600:t=fill",
      "-frames:v", "1", "-c:v", "png", "-threads", "1", masterSeed
    ]);
    const sideMaster = path.join(fixtureDirectory, "side-master.jpg");
    const sleepMaster = path.join(fixtureDirectory, "sleep-master.webp");
    await runFfmpeg([
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", masterSeed,
      "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", sideMaster
    ]);
    await runFfmpeg([
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", masterSeed,
      "-frames:v", "1", "-c:v", "libwebp", "-lossless", "1", sleepMaster
    ]);
    masters = {
      front: { artifactPath: masterSeed },
      side: { path: sideMaster },
      sleep: sleepMaster
    };

    const videoSeed = path.join(fixtureDirectory, "video-seed.mkv");
    await runFfmpeg([
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x00FF00:s=320x180:r=12:d=1",
      "-vf", "drawbox=x=110:y=35:w=100:h=110:color=0x3366FF:t=fill",
      "-an", "-c:v", "ffv1", "-pix_fmt", "bgr0", videoSeed
    ]);
    videos = {};
    for (const actionId of REQUIRED_ACTION_IDS) {
      const target = path.join(fixtureDirectory, `${actionId}-raw.mkv`);
      await fsp.copyFile(videoSeed, target, fs.constants.COPYFILE_EXCL);
      videos[actionId] = { path: target, expectedDuration: 1 };
    }

    const acceptedSidecar = await writeSidecar("manual-qa-accepted.json", masters, videos);
    const rejectedSidecar = await writeSidecar("manual-qa-rejected.json", masters, videos, {
      rejectActionId: "idle"
    });
    acceptedRequest = makeRequest({ runId: successRunId, manualQaPath: acceptedSidecar, masters, videos });
    rejectedRequest = makeRequest({ runId: rejectedRunId, manualQaPath: rejectedSidecar, masters, videos });
  }, 60_000);

  afterAll(async () => {
    for (const directory of createdDirectories) {
      await fsp.rm(assertExactCanaryChild(directory), { recursive: true, force: true });
    }
  });

  it("uses real probes, normalizes 3 masters and 7 videos, then builds, verifies, and imports in isolation", async () => {
    const result = await runControlledRealCanary({
      request: acceptedRequest,
      environment: { ...process.env, PETPACK_PLATFORM_MODE: "test" },
      logger: { info() {}, warn() {} }
    });

    expect(result.report, JSON.stringify(result.report.errors)).toMatchObject({
      classification: CLASSIFICATION,
      productionAssured: false,
      releaseEligible: false,
      ok: true,
      status: "completed",
      processTempDirectory: CONTROLLED_PROCESS_TEMP_ROOT,
      machineQa: { allPassed: true },
      manualQa: { allAccepted: true },
      clientImport: { ok: true, fileCount: 8 }
    });
    expect(path.dirname(result.reportPath)).toBe(successRunDirectory);
    expect(path.dirname(result.packagePath)).toBe(successRunDirectory);
    expect(fs.existsSync(result.reportPath)).toBe(true);
    expect(fs.existsSync(result.packagePath)).toBe(true);
    expect(result.report.package.fileNames).toHaveLength(8);

    for (const kind of MASTER_KINDS) {
      const master = result.report.machineQa.masters[kind];
      expect(master.ok).toBe(true);
      expect(master.geometry).toMatchObject({ mode: "contain", cropped: false });
      expect(master.output.probe).toMatchObject({ width: 854, height: 480, codec: "png", audioStreams: 0 });
      expect(master.output.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(master.source.probe.mimeType).toMatch(/^image\/(png|jpeg|webp)$/);
      expect(master.background.frames[0].metrics.outerGreenRatio).toBeGreaterThanOrEqual(0.97);
    }

    for (const actionId of REQUIRED_ACTION_IDS) {
      const video = result.report.machineQa.videos[actionId];
      expect(video.ok).toBe(true);
      expect(video.output.probe).toMatchObject({
        width: 854,
        height: 480,
        codec: "vp9",
        fps: 24,
        duration: 1,
        frameCount: 24,
        audioStreams: 0,
        alphaMode: "1"
      });
      expect(video.output.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(video.transparency.frames).toHaveLength(3);
      expect(video.transparency.frames.every((frame) => frame.ok)).toBe(true);
      expect(video.transparency.frames.every((frame) =>
        frame.metrics.outerTransparentRatio >= 0.97 &&
        frame.metrics.foregroundGreenSpillRatio <= 0.02
      )).toBe(true);
      expect(result.report.manualQa.videos[actionId]).toMatchObject({ human: true, accepted: true });
    }

    expect(result.report.alphaPostprocess).toMatchObject({
      keyColor: "#00FF00",
      similarity: 0.2,
      blend: 0.04,
      greenCorrection: 0.5,
      alphaInsetPixels: 1,
      codec: "vp9",
      pixelFormat: "yuva420p"
    });
    expect(result.report.package.manifestValidation.ok).toBe(true);

    const installedManifest = JSON.parse(await fsp.readFile(
      path.join(result.report.clientImport.isolatedUserDataDirectory, "packages", result.report.package.packageId, "manifest.json"),
      "utf8"
    ));
    expect(installedManifest.animations.default).not.toHaveProperty("greenScreen");
    expect(installedManifest.animations.clips.every((clip) => clip.greenScreen === undefined)).toBe(true);

    const persisted = JSON.parse(await fsp.readFile(result.reportPath, "utf8"));
    expect(persisted.manualQa.source).toBe("human-sidecar");
    expect(persisted.machineQa.allPassed).toBe(true);
    expect(persisted.clientImport.isolatedUserDataDirectory).toContain(successRunDirectory);
  }, 120_000);

  it("writes only a rejection report and never packages when one human item is not accepted", async () => {
    const result = await runControlledRealCanary({
      request: rejectedRequest,
      environment: { ...process.env, PETPACK_PLATFORM_MODE: "test" },
      logger: { info() {}, warn() {} }
    });

    expect(result.packagePath).toBeUndefined();
    expect(result.report).toMatchObject({
      ok: false,
      status: "manual_qa_rejected",
      productionAssured: false,
      releaseEligible: false,
      machineQa: { masters: {}, videos: {}, allPassed: false },
      package: null,
      clientImport: null
    });
    expect(result.report.manualQa.rejected).toContain("video:idle");
    expect(fs.readdirSync(rejectedRunDirectory)).toEqual(["report.json"]);
  });

  it("rejects production mode before creating any output directory", async () => {
    const request = { ...acceptedRequest, runId: productionRunId };
    await expect(runControlledRealCanary({
      request,
      environment: { ...process.env, PETPACK_PLATFORM_MODE: "production" },
      logger: { info() {}, warn() {} }
    })).rejects.toMatchObject({ code: "canary_production_forbidden" });
    expect(fs.existsSync(productionRunDirectory)).toBe(false);
  });
});
