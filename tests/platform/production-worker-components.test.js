import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { beforeAll, describe, expect, it } from "vitest";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const require = createRequire(import.meta.url);
const {
  CALIBRATION_DIGEST,
  MASTER_PROCESSOR_VERSION,
  PRODUCTION_QA_POLICY,
  QA_POLICY_VERSION,
  countActiveMotionSegments,
  createProductionMasterImageProcessor,
  createProductionMattingService,
  createProductionQaPolicyProvider,
  createWorkerComponents
} = require("../../platform/src/runtime/production-worker-components");
const {
  checksumProductionWorkerComponentManifest
} = require("../../platform/src/runtime/production-worker-component-manifest");
const { validateWorkerComponents } = require("../../platform/src/runtime/create-studio-worker");
const { createTrustedFileProbe } = require("../../platform/src/media/ffprobe-media-probe");
const { runProcess } = require("../../platform/src/media/media-worker");
const { createVideoNormalizationPlan } = require("../../platform/src/media/ffmpeg-plan");
const { checksumPinnedUpstreamTree, isProductionAssuredValidator } = require("../../platform/src/petpack/delivery-validator");
const { validateMasterImage } = require("../../platform/src/qa/master-image-quality-gate");
const {
  resolveActionMotionPolicy,
  validateVideoAction
} = require("../../platform/src/qa/action-quality-gate");
const {
  ACTION_ENDPOINTS: INSPECTOR_ACTION_ENDPOINTS,
  createTrustedActionEndpointInspector
} = require("../../platform/src/qa/trusted-action-endpoint-inspector");
const { REQUIRED_ACTION_IDS, ACTION_ENDPOINTS } = require("../../platform/src/domain/action-catalog");

const ffprobePath = ffprobeStatic.path;
const fixtureRoot = path.resolve(".tmp/tests/production-worker-components");
const GREEN = [0, 230, 118];

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function paintBlob(bytes, width, { centerX, bottom, blobWidth, blobHeight, internalGreenHole = false }) {
  const bodyColor = [150, 100, 60];
  const headColor = [110, 74, 46];
  const chestColor = [235, 230, 220];
  const bodyCenterY = bottom - blobHeight * 0.38;
  const bodyRadiusX = blobWidth / 2;
  const bodyRadiusY = blobHeight * 0.38;
  const headRadius = blobHeight * 0.21;
  const headCenterY = bottom - blobHeight + headRadius;
  const set = (x, y, color) => {
    const offset = (Math.round(y) * width + Math.round(x)) * 4;
    bytes[offset] = color[0];
    bytes[offset + 1] = color[1];
    bytes[offset + 2] = color[2];
    bytes[offset + 3] = 255;
  };
  const top = Math.round(bottom - blobHeight);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = Math.round(centerX - bodyRadiusX); x <= Math.round(centerX + bodyRadiusX); x += 1) {
      const bodyDistance = ((x - centerX) / bodyRadiusX) ** 2 + ((y - bodyCenterY) / bodyRadiusY) ** 2;
      const headDistance = ((x - centerX) / headRadius) ** 2 + ((y - headCenterY) / headRadius) ** 2;
      if (bodyDistance <= 1) {
        const chestDistance = ((x - centerX) / (bodyRadiusX * 0.35)) ** 2 + ((y - (bodyCenterY + bodyRadiusY * 0.35)) / (bodyRadiusY * 0.4)) ** 2;
        set(x, y, chestDistance <= 1 ? chestColor : bodyColor);
      } else if (headDistance <= 1) {
        set(x, y, headColor);
      }
    }
  }
  // A connecting neck keeps the subject one component.
  for (let y = Math.round(headCenterY); y <= Math.round(bodyCenterY); y += 1) {
    for (let x = Math.round(centerX - headRadius * 0.6); x <= Math.round(centerX + headRadius * 0.6); x += 1) {
      set(x, y, bodyColor);
    }
  }
  if (internalGreenHole) {
    const holeCenterY = bodyCenterY + bodyRadiusY * 0.15;
    for (let y = Math.round(holeCenterY - bodyRadiusY * 0.18); y <= Math.round(holeCenterY + bodyRadiusY * 0.18); y += 1) {
      for (let x = Math.round(centerX - bodyRadiusX * 0.14); x <= Math.round(centerX + bodyRadiusX * 0.14); x += 1) {
        const distance = ((x - centerX) / (bodyRadiusX * 0.14)) ** 2 +
          ((y - holeCenterY) / (bodyRadiusY * 0.18)) ** 2;
        if (distance <= 1) set(x, y, GREEN);
      }
    }
  }
}

function writePng(filePath, width, height, backgroundColor, blob) {
  const bytes = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    bytes[index * 4] = backgroundColor[0];
    bytes[index * 4 + 1] = backgroundColor[1];
    bytes[index * 4 + 2] = backgroundColor[2];
    bytes[index * 4 + 3] = 255;
  }
  if (blob) paintBlob(bytes, width, blob);
  const rawPath = `${filePath}.raw`;
  fs.writeFileSync(rawPath, bytes);
  execFileSync(ffmpegPath, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-i", rawPath,
    "-frames:v", "1", filePath
  ]);
  fs.rmSync(rawPath, { force: true });
  return filePath;
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

beforeAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
});

describe("production worker components", () => {
  it("counts complete motion segments deterministically", () => {
    const options = { restMotionThreshold: 0.001, activeMotionFactor: 2, minActiveSegmentFrames: 3 };
    const rest = 0.0001;
    const active = 0.01;
    expect(countActiveMotionSegments([rest, rest, rest], options)).toBe(0);
    expect(countActiveMotionSegments(
      [rest, rest, active, active, active, active, rest, rest, rest],
      options
    )).toBe(1);
    expect(countActiveMotionSegments(
      [rest, active, active, active, rest, rest, active, active, active, rest],
      options
    )).toBe(2);
    // Isolated codec spikes shorter than a real motion segment do not count.
    expect(countActiveMotionSegments([rest, active, rest, rest, active, rest], options)).toBe(0);
  });

  it("supports trusted endpoint inspection for all seven frozen actions", () => {
    expect(Object.keys(INSPECTOR_ACTION_ENDPOINTS).sort()).toEqual([...REQUIRED_ACTION_IDS].sort());
    for (const actionId of REQUIRED_ACTION_IDS) {
      expect(INSPECTOR_ACTION_ENDPOINTS[actionId]).toEqual({
        firstMasterKind: ACTION_ENDPOINTS[actionId].firstMaster,
        lastMasterKind: ACTION_ENDPOINTS[actionId].lastMaster
      });
    }
  });

  it("serves only the pinned signed production QA policy", async () => {
    const provider = createProductionQaPolicyProvider();
    const policy = await provider.getPolicy({ version: QA_POLICY_VERSION });
    expect(policy).toBe(PRODUCTION_QA_POLICY);
    expect(policy.name).not.toBe("development-only");
    expect(policy.signature).toMatch(/^[a-f0-9]{64}$/);
    await expect(provider.getPolicy({ version: "some-other-policy/9" })).rejects.toThrow(/unavailable/);
    expect(provider.productionMetadata.calibrationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(provider)).toBe(true);
  });

  it("requires a calibrated motion envelope for every production action", () => {
    for (const actionId of REQUIRED_ACTION_IDS) {
      const resolved = resolveActionMotionPolicy(PRODUCTION_QA_POLICY, actionId, { production: true });
      expect(resolved.ok, `${actionId}: ${resolved.errors.join("; ")}`).toBe(true);
      expect(resolved.evidence).toMatchObject({
        minAdjacentMaskIoU: expect.any(Number),
        maxRelativeScaleJitter: expect.any(Number)
      });
    }
    const missing = structuredClone(PRODUCTION_QA_POLICY);
    delete missing.actionMotionEnvelopes["sleep-transition"];
    const rejected = resolveActionMotionPolicy(missing, "sleep-transition", { production: true });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.join(" ")).toMatch(/motion envelope is required/i);
  });

  it("normalizes and inspects a provider master with measured production evidence that passes the master gate", async () => {
    const directory = path.join(fixtureRoot, "master");
    fs.mkdirSync(directory, { recursive: true });
    const inputPath = writePng(path.join(directory, "provider-front.png"), 1536, 864, GREEN, {
      centerX: 900,
      bottom: 700,
      blobWidth: 500,
      blobHeight: 400,
      internalGreenHole: true
    });
    const referencePaths = [0, 1, 2].map((index) => writePng(
      path.join(directory, `photo-${index}.png`),
      640,
      640,
      [120 + index * 8, 124, 140],
      { centerX: 320, bottom: 540, blobWidth: 400, blobHeight: 380 }
    ));
    const outputPath = path.join(directory, "front-master.png");
    const processor = createProductionMasterImageProcessor({
      ffmpegPath,
      probeAsset: createTrustedFileProbe({ ffprobePath })
    });
    const inspection = await processor.normalizeAndInspect({
      kind: "front",
      inputPath,
      outputPath,
      referencePaths,
      scratchDirectory: directory
    });

    expect(inspection.provenance).toMatchObject({
      evidenceClass: "production",
      inputSha256: sha256File(inputPath),
      outputSha256: sha256File(outputPath),
      processorVersion: MASTER_PROCESSOR_VERSION,
      calibrationDigest: CALIBRATION_DIGEST
    });
    expect(inspection.frame.identityScore).toBeGreaterThan(0);
    expect(inspection.frame.torsoHeightPx).toBeCloseTo(200, -1);
    expect(inspection.contentInspection.chromaIntegrityErrors).not.toContain("subject_internal_holes_detected");
    expect(inspection.contentInspection.chromaIntegrity.worstFrame.foregroundRatio).toBeGreaterThan(0.01);

    const qa = validateMasterImage({
      kind: "front",
      frame: inspection.frame,
      contentInspection: inspection.contentInspection,
      appearanceInspection: inspection.appearanceInspection,
      provenance: inspection.provenance,
      sourceReferenceCount: referencePaths.length,
      policy: PRODUCTION_QA_POLICY,
      production: true
    });
    expect(qa.errors, qa.errors.join("; ")).toEqual([]);
    expect(qa.ok).toBe(true);
    expect(qa.referenceMetrics.groundBaselineY).toBeCloseTo(413, -1);
  }, 120_000);

  it("fails the master gate when identity references disagree with the generated subject", async () => {
    const directory = path.join(fixtureRoot, "master-conflict");
    fs.mkdirSync(directory, { recursive: true });
    const inputPath = writePng(path.join(directory, "provider-front.png"), 1536, 864, GREEN, {
      centerX: 760,
      bottom: 640,
      blobWidth: 460,
      blobHeight: 380
    });
    // References show a completely different (blue) animal.
    const bluePath = path.join(directory, "blue-ref.png");
    const blueBytes = Buffer.alloc(640 * 640 * 4);
    for (let index = 0; index < 640 * 640; index += 1) {
      blueBytes[index * 4] = 40;
      blueBytes[index * 4 + 1] = 70;
      blueBytes[index * 4 + 2] = 200;
      blueBytes[index * 4 + 3] = 255;
    }
    fs.writeFileSync(`${bluePath}.raw`, blueBytes);
    execFileSync(ffmpegPath, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "640x640", "-i", `${bluePath}.raw`,
      "-frames:v", "1", bluePath
    ]);
    fs.rmSync(`${bluePath}.raw`, { force: true });
    const referencePaths = [bluePath, bluePath, bluePath];
    const outputPath = path.join(directory, "front-master.png");
    const processor = createProductionMasterImageProcessor({
      ffmpegPath,
      probeAsset: createTrustedFileProbe({ ffprobePath })
    });
    const inspection = await processor.normalizeAndInspect({
      kind: "front",
      inputPath,
      outputPath,
      referencePaths,
      scratchDirectory: directory
    });
    const qa = validateMasterImage({
      kind: "front",
      frame: inspection.frame,
      contentInspection: inspection.contentInspection,
      appearanceInspection: inspection.appearanceInspection,
      provenance: inspection.provenance,
      sourceReferenceCount: referencePaths.length,
      policy: PRODUCTION_QA_POLICY,
      production: true
    });
    expect(qa.ok).toBe(false);
  }, 120_000);

  it("processes a green-screen action into alpha media whose measured evidence passes the production action gate", async () => {
    const directory = path.join(fixtureRoot, "action");
    fs.mkdirSync(directory, { recursive: true });
    const masterPath = writePng(path.join(directory, "front-master.png"), 854, 480, GREEN, {
      centerX: 427,
      bottom: 413,
      blobWidth: 330,
      blobHeight: 264
    });
    const masterSha256 = sha256File(masterPath);
    const sourcePath = path.join(directory, "idle-source.webm");
    execFileSync(ffmpegPath, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-loop", "1", "-i", masterPath,
      "-t", "2", "-r", "24",
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-deadline", "good", "-cpu-used", "5",
      sourcePath
    ]);

    const mattingService = createProductionMattingService({ ffmpegPath });
    const mattePath = path.join(directory, "idle-matte.webm");
    const matte = await mattingService.createMatteAndMetrics({
      inputPath: sourcePath,
      matteOutputPath: mattePath,
      scratchDirectory: directory
    });
    expect(matte.mattePath).toBe(mattePath);

    const outputPath = path.join(directory, "idle-processed.webm");
    const plan = createVideoNormalizationPlan({
      inputPath: sourcePath,
      mattePath,
      outputPath,
      expectedDuration: 2,
      correction: matte.correction
    });
    await runProcess({ ...plan, executable: ffmpegPath });

    const inspection = await mattingService.inspectProcessedAction({
      actionId: "idle",
      outputPath,
      firstMasterPath: masterPath,
      lastMasterPath: masterPath,
      scratchDirectory: directory,
      expectedFirstMasterHash: masterSha256,
      expectedLastMasterHash: masterSha256
    });
    expect(inspection.sampledFrames.length).toBe(48);
    expect(inspection.provenance).toMatchObject({
      evidenceClass: "production",
      inputSha256: sha256File(sourcePath),
      outputSha256: sha256File(outputPath),
      calibrationDigest: CALIBRATION_DIGEST
    });

    const endpointInspector = createTrustedActionEndpointInspector({ ffmpegPath });
    const endpointInspection = await endpointInspector({
      actionId: "idle",
      outputPath,
      firstMasterPath: masterPath,
      lastMasterPath: masterPath,
      expectedFirstMasterHash: masterSha256,
      expectedLastMasterHash: masterSha256,
      frameCount: inspection.sampledFrames.length
    });

    const probeAsset = createTrustedFileProbe({ ffprobePath });
    const probed = await probeAsset({ localPath: outputPath });
    const firstFrame = inspection.sampledFrames[0];
    const referenceMetrics = {
      groundBaselineY: firstFrame.groundBaselineY,
      torsoHeightPx: firstFrame.torsoHeightPx,
      headHeightPx: firstFrame.headHeightPx,
      shoulderWidthPx: firstFrame.shoulderWidthPx,
      centerX: (firstFrame.visibleBounds.left + firstFrame.visibleBounds.right) / 2
    };
    const qa = validateVideoAction({
      actionId: "idle",
      mediaProbe: probed.probe,
      sampledFrames: inspection.sampledFrames,
      firstFrame: inspection.firstFrame,
      lastFrame: inspection.lastFrame,
      endpointInspection,
      expectedFirstMasterHash: masterSha256,
      expectedLastMasterHash: masterSha256,
      referenceMetrics,
      contentInspection: inspection.contentInspection,
      appearanceInspection: inspection.appearanceInspection,
      provenance: inspection.provenance,
      loopBoundaryInspection: inspection.loopBoundaryInspection,
      expectedDuration: 2,
      policy: PRODUCTION_QA_POLICY,
      production: true
    });
    expect(qa.errors, qa.errors.join("; ")).toEqual([]);
    expect(qa.ok).toBe(true);
    expect(qa.provenance.outputSha256).toBe(inspection.provenance.outputSha256);
  }, 240_000);

  it("refuses processed-action evidence when the frozen master hash does not match", async () => {
    const directory = path.join(fixtureRoot, "action-tamper");
    fs.mkdirSync(directory, { recursive: true });
    const masterPath = writePng(path.join(directory, "front-master.png"), 854, 480, GREEN, {
      centerX: 427,
      bottom: 413,
      blobWidth: 320,
      blobHeight: 256
    });
    const sourcePath = path.join(directory, "source.webm");
    execFileSync(ffmpegPath, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-loop", "1", "-i", masterPath,
      "-t", "1", "-r", "24",
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-deadline", "good", "-cpu-used", "5",
      sourcePath
    ]);
    const mattingService = createProductionMattingService({ ffmpegPath });
    await mattingService.createMatteAndMetrics({
      inputPath: sourcePath,
      matteOutputPath: path.join(directory, "matte.webm"),
      scratchDirectory: directory
    });
    await expect(mattingService.inspectProcessedAction({
      actionId: "idle",
      outputPath: sourcePath,
      firstMasterPath: masterPath,
      lastMasterPath: masterPath,
      scratchDirectory: directory,
      expectedFirstMasterHash: "a".repeat(64),
      expectedLastMasterHash: sha256File(masterPath)
    })).rejects.toThrow(/frozen hash/);
  }, 120_000);

  it("assembles a production-assured bundle whose pinned manifest passes runtime validation", async () => {
    const runnerDirectory = path.join(fixtureRoot, "electron-runner");
    fs.mkdirSync(runnerDirectory, { recursive: true });
    const runnerPath = path.join(runnerDirectory, "interaction-runner.js");
    fs.writeFileSync(runnerPath, "// reviewed Electron interaction runner entry\n");
    fs.writeFileSync(path.join(runnerDirectory, "package.json"), JSON.stringify({
      name: "petpack-electron-interaction-runner",
      version: "1.0.0",
      private: true,
      main: "interaction-runner.js"
    }));
    const repoRoot = path.resolve(".");
    const environment = {
      PETPACK_PLATFORM_MODE: "production",
      FFMPEG_PATH: ffmpegPath,
      FFPROBE_PATH: ffprobePath,
      PETPACK_PRODUCTION_UPSTREAM_CLIENT_ROOT: repoRoot,
      PETPACK_PRODUCTION_UPSTREAM_CLIENT_TREE_SHA256: checksumPinnedUpstreamTree(repoRoot),
      PETPACK_PRODUCTION_ELECTRON_PATH: process.execPath,
      PETPACK_PRODUCTION_ELECTRON_SHA256: sha256File(process.execPath),
      PETPACK_PRODUCTION_ELECTRON_RUNNER_PATH: runnerPath,
      PETPACK_PRODUCTION_ELECTRON_RUNNER_SHA256: sha256File(runnerPath)
    };
    const components = await createWorkerComponents({ environment, logger: silentLogger() });
    expect(components.productionAssured).toBe(true);
    expect(components.mediaProcessorVersion).toBe(components.mattingService.productionMetadata.version);
    expect(isProductionAssuredValidator(components.deliveryValidator)).toBe(true);
    expect(components.deliveryValidator.describe().productionAssured).toBe(true);

    const manifestSha256 = checksumProductionWorkerComponentManifest(components.productionComponentManifest);
    const validated = validateWorkerComponents(components, {
      production: true,
      workerComponentsManifestSha256: manifestSha256
    });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(validated.verifiedProductionComponentManifest.sha256).toBe(manifestSha256);
    expect(() => validateWorkerComponents(components, {
      production: true,
      workerComponentsManifestSha256: "b".repeat(64)
    })).toThrow(/pinned SHA-256/);

    await expect(createWorkerComponents({
      environment: { ...environment, PETPACK_PLATFORM_MODE: "development" },
      logger: silentLogger()
    })).rejects.toThrow(/production platform mode/);
    await expect(createWorkerComponents({
      environment: { ...environment, PETPACK_WORKER_EVIDENCE_MODE: "controlled-real-staging" },
      logger: silentLogger()
    })).rejects.toThrow(/non-production evidence mode/);
    components.close();
  }, 180_000);
});
