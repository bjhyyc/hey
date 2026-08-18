#!/usr/bin/env node
"use strict";

// Free local calibration pass: replays already-generated real ModelArk media
// (masters + seven action videos from a previous controlled-real batch)
// through the PRODUCTION-ASSURED components and production QA gates, without
// any provider call or cost. Its report shows exactly which gates would pass
// or fail on real media so the calibration can be reviewed before the next
// paid batch. Development tooling: it imports the production component
// factories directly and never touches the Worker allowlist path.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const ffmpegPath = require(path.join(PROJECT_ROOT, "node_modules", "ffmpeg-static"));
const ffprobePath = require(path.join(PROJECT_ROOT, "node_modules", "ffprobe-static")).path;

const { createTrustedFileProbe } = require("../media/ffprobe-media-probe");
const { createVideoNormalizationPlan } = require("../media/ffmpeg-plan");
const { runProcess } = require("../media/media-worker");
const {
  PRODUCTION_QA_POLICY,
  createProductionMasterImageProcessor,
  createProductionMattingService
} = require("../runtime/production-worker-components");
const { validateMasterImage } = require("../qa/master-image-quality-gate");
const { validateVideoAction } = require("../qa/action-quality-gate");
const { createTrustedActionEndpointInspector } = require("../qa/trusted-action-endpoint-inspector");
const { measureSubjectFrame, estimateCanonicalGeometry } = require("../qa/subject-appearance-metrics");
const { PRODUCTION_CALIBRATION } = require("../runtime/production-worker-components");
const { parsePetPackPromptFileFromPath } = require("../prompts/prompt-file");
const { runCapture } = require("../qa/trusted-action-endpoint-inspector");

function parseFrameRate(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string" || !value.trim()) return 0;
  const [numerator, denominator = "1"] = value.split("/");
  const parsedNumerator = Number(numerator);
  const parsedDenominator = Number(denominator);
  return Number.isFinite(parsedNumerator) && Number.isFinite(parsedDenominator) && parsedDenominator !== 0
    ? parsedNumerator / parsedDenominator
    : 0;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function requiredFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${filePath}`);
  return filePath;
}

async function measureMasterReference(masterPath) {
  const bytes = await runCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", masterPath,
      "-vf", "format=rgba,chromakey=0x00e676:0.25:0.06,format=rgba",
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
    ],
    maximumBytes: 854 * 480 * 4 + 4096
  });
  const measurement = measureSubjectFrame(bytes, {
    width: 854,
    height: 480,
    options: PRODUCTION_CALIBRATION.appearance
  });
  const canonical = estimateCanonicalGeometry(measurement, PRODUCTION_CALIBRATION.geometry.kinds.front);
  return {
    groundBaselineY: canonical.groundBaselineY,
    torsoHeightPx: canonical.torsoHeightPx,
    headHeightPx: canonical.headHeightPx,
    shoulderWidthPx: canonical.shoulderWidthPx,
    centerX: canonical.centerX
  };
}

async function main() {
  const args = process.argv.slice(2);
  const batchRoot = path.resolve(args[0] || path.join(PROJECT_ROOT, ".tmp", "controlled-real-canary", "border-collie-final-canary-20260816-a"));
  const photosRoot = path.resolve(args[1] || "C:/Users/86135/.codex/attachments/f3bca94d-7a6b-492c-8dee-dc71b7f8f4e3");
  const outputRoot = path.join(PROJECT_ROOT, ".tmp", "production-qa-calibration",
    `calibration-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`);
  await fsp.mkdir(outputRoot, { recursive: true });

  // Two accepted batch layouts:
  // - postprocess layout: masters/<kind>.png + videos/<actionId>.webm
  // - raw canary artifacts: artifacts/NN-<kind>.jpg + artifacts/NN-<actionId>.mp4
  //   The generation canary uploads the RAW masters as Seedance endpoint
  //   frames, so endpoint continuity must compare against a plain aspect-fit
  //   854x480 rendering of those raw masters (replicating the provider's own
  //   downscale), never against the repositioning production normalization.
  const canaryLayout = fs.existsSync(path.join(batchRoot, "artifacts", "01-front.jpg"));
  const CANARY_MASTER_FILES = { front: "01-front.jpg", side: "02-side.jpg", sleep: "03-sleep.jpg" };
  const CANARY_VIDEO_FILES = {
    idle: "04-idle.mp4",
    "sleep-transition": "05-sleep-transition.mp4",
    "sleep-loop": "06-sleep-loop.mp4",
    stretch: "07-stretch.mp4",
    sneeze: "08-sneeze.mp4",
    roll: "09-roll.mp4",
    "hover-attention": "10-hover-attention.mp4"
  };
  let masters;
  let videoPathFor;
  if (canaryLayout) {
    const plainRoot = path.join(outputRoot, "plain-masters");
    await fsp.mkdir(plainRoot, { recursive: true });
    masters = {};
    for (const [kind, fileName] of Object.entries(CANARY_MASTER_FILES)) {
      const rawPath = requiredFile(path.join(batchRoot, "artifacts", fileName), `${kind} raw master`);
      const plainPath = path.join(plainRoot, `${kind}.png`);
      await runProcess({
        executable: ffmpegPath,
        args: [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", rawPath,
          "-vf", "scale=854:480:flags=lanczos",
          "-frames:v", "1", "-compression_level", "9", plainPath
        ]
      });
      masters[kind] = plainPath;
    }
    videoPathFor = (actionId) => requiredFile(
      path.join(batchRoot, "artifacts", CANARY_VIDEO_FILES[actionId]),
      `${actionId} source`
    );
  } else {
    masters = Object.fromEntries(["front", "side", "sleep"].map((kind) => [
      kind,
      requiredFile(path.join(batchRoot, "masters", `${kind}.png`), `${kind} master`)
    ]));
    videoPathFor = (actionId) => requiredFile(
      path.join(batchRoot, "videos", `${actionId}.webm`),
      `${actionId} source`
    );
  }
  const sourcePhotos = ["image-2.jpg", "image-1.jpg", "image-3.jpg"].map((name) =>
    requiredFile(path.join(photosRoot, name), "source photo"));

  const probeAsset = createTrustedFileProbe({ ffprobePath });
  const masterProcessor = createProductionMasterImageProcessor({ ffmpegPath, probeAsset });
  const mattingService = createProductionMattingService({ ffmpegPath });
  const endpointInspector = createTrustedActionEndpointInspector({ ffmpegPath });
  const prompts = parsePetPackPromptFileFromPath(path.join(PROJECT_ROOT, "docs", "prompts", "正式发布候选·三母图七动作·480p-v2.txt"));
  const durations = Object.fromEntries(prompts.videos.map((video) => [video.actionId, video.duration]));

  const report = {
    contractVersion: "production-qa-calibration/v1",
    policyVersion: PRODUCTION_QA_POLICY.version,
    batchRoot: path.relative(PROJECT_ROOT, batchRoot).split(path.sep).join("/"),
    startedAt: new Date().toISOString(),
    masters: {},
    actions: {},
    summary: { mastersPassed: 0, actionsPassed: 0 }
  };

  // Masters: re-normalize the batch masters through the production processor.
  const producedMasters = {};
  for (const kind of ["front", "side", "sleep"]) {
    const scratch = path.join(outputRoot, `master-${kind}`);
    await fsp.mkdir(scratch, { recursive: true });
    const outputPath = path.join(scratch, `${kind}-normalized.png`);
    const referencePaths = kind === "front"
      ? sourcePhotos
      : kind === "side"
        ? [...sourcePhotos, producedMasters.front]
        : [producedMasters.front, producedMasters.side];
    const inspection = await masterProcessor.normalizeAndInspect({
      kind,
      inputPath: masters[kind],
      outputPath,
      referencePaths,
      scratchDirectory: scratch
    });
    const qa = validateMasterImage({
      kind,
      frame: inspection.frame,
      contentInspection: inspection.contentInspection,
      appearanceInspection: inspection.appearanceInspection,
      provenance: inspection.provenance,
      referenceMetrics: kind === "front" ? undefined : report.masters.front.referenceMetrics,
      sourceReferenceCount: referencePaths.length,
      policy: PRODUCTION_QA_POLICY,
      production: true
    });
    producedMasters[kind] = outputPath;
    report.masters[kind] = {
      ok: qa.ok,
      errors: qa.errors,
      referenceMetrics: qa.referenceMetrics,
      scores: {
        identity: inspection.frame.identityScore,
        face: inspection.appearanceInspection.faceIdentityScore,
        coat: inspection.appearanceInspection.coatColorScore,
        marking: inspection.appearanceInspection.markingTopologyScore
      },
      geometry: {
        groundBaselineY: inspection.frame.groundBaselineY,
        torsoHeightPx: inspection.frame.torsoHeightPx,
        headHeightPx: inspection.frame.headHeightPx,
        shoulderWidthPx: inspection.frame.shoulderWidthPx
      },
      chromaErrors: inspection.contentInspection.chromaIntegrityErrors
    };
    if (qa.ok) report.summary.mastersPassed += 1;
    console.log(`[master ${kind}] ok=${qa.ok} identity=${inspection.frame.identityScore.toFixed(3)} coat=${inspection.appearanceInspection.coatColorScore.toFixed(3)} marking=${inspection.appearanceInspection.markingTopologyScore.toFixed(3)} face=${inspection.appearanceInspection.faceIdentityScore.toFixed(3)}${qa.ok ? "" : `\n  errors: ${qa.errors.slice(0, 6).join(" | ")}`}`);
  }

  // Actions: the batch videos were generated against the ORIGINAL batch
  // masters, so endpoint continuity is checked against those exact files.
  // Each action is judged against the geometry of the master it starts from:
  // sleep-anchored actions carry the sleep pose's projection, and comparing
  // them against the front master's geometry only measures the pose gap.
  const referenceMetricsByKind = {
    front: await measureMasterReference(masters.front),
    sleep: await measureMasterReference(masters.sleep)
  };
  const masterHashes = Object.fromEntries(["front", "sleep"].map((kind) => [kind, sha256File(masters[kind])]));
  const passedActions = {};
  const endpointsByAction = {
    idle: ["front", "front"],
    sneeze: ["front", "front"],
    roll: ["front", "front"],
    "sleep-transition": ["front", "sleep"],
    "sleep-loop": ["sleep", "sleep"],
    stretch: ["sleep", "front"],
    "hover-attention": ["front", "front"]
  };

  for (const [actionId, [firstKind, lastKind]] of Object.entries(endpointsByAction)) {
    const scratch = path.join(outputRoot, `action-${actionId}`);
    await fsp.mkdir(scratch, { recursive: true });
    const sourcePath = videoPathFor(actionId);
    const mattePath = path.join(scratch, "matte.webm");
    const processedPath = path.join(scratch, "processed.webm");
    const entry = { ok: false, errors: [] };
    try {
      const matte = await mattingService.createMatteAndMetrics({
        inputPath: sourcePath,
        matteOutputPath: mattePath,
        scratchDirectory: scratch
      });
      const plan = createVideoNormalizationPlan({
        inputPath: sourcePath,
        mattePath,
        outputPath: processedPath,
        expectedDuration: durations[actionId],
        correction: matte.correction
      });
      await runProcess({ ...plan, executable: ffmpegPath });
      const inspection = await mattingService.inspectProcessedAction({
        actionId,
        outputPath: processedPath,
        firstMasterPath: masters[firstKind],
        lastMasterPath: masters[lastKind],
        scratchDirectory: scratch,
        expectedFirstMasterHash: masterHashes[firstKind],
        expectedLastMasterHash: masterHashes[lastKind]
      });
      const probed = await probeAsset({ localPath: processedPath });
      const outputVideo = probed.probe?.streams?.find((stream) => stream.codec_type === "video");
      const declaredFrameCount = Number(outputVideo?.nb_frames);
      const outputDuration = Number(outputVideo?.duration ?? probed.probe?.format?.duration);
      const outputFps = parseFrameRate(outputVideo?.avg_frame_rate || outputVideo?.r_frame_rate);
      const probedFrameCount = Number.isSafeInteger(declaredFrameCount) && declaredFrameCount > 0
        ? declaredFrameCount
        : Math.round(outputDuration * outputFps);
      if (!Number.isSafeInteger(probedFrameCount) || probedFrameCount < 2) {
        throw new Error("Calibrated action probe did not return an exact frame count");
      }
      if (inspection.sampledFrames.length !== probedFrameCount) {
        throw new Error("Calibrated action full-frame inspection does not match the probed frame count");
      }
      const endpointInspection = await endpointInspector({
        actionId,
        outputPath: processedPath,
        firstMasterPath: masters[firstKind],
        lastMasterPath: masters[lastKind],
        expectedFirstMasterHash: masterHashes[firstKind],
        expectedLastMasterHash: masterHashes[lastKind],
        frameCount: probedFrameCount
      });
      const qa = validateVideoAction({
        actionId,
        mediaProbe: probed.probe,
        sampledFrames: inspection.sampledFrames,
        firstFrame: inspection.firstFrame,
        lastFrame: inspection.lastFrame,
        endpointInspection,
        expectedFirstMasterHash: masterHashes[firstKind],
        expectedLastMasterHash: masterHashes[lastKind],
        referenceMetrics: referenceMetricsByKind[firstKind],
        contentInspection: inspection.contentInspection,
        appearanceInspection: inspection.appearanceInspection,
        provenance: inspection.provenance,
        loopBoundaryInspection: inspection.loopBoundaryInspection,
        expectedDuration: durations[actionId],
        policy: PRODUCTION_QA_POLICY,
        production: true
      });
      entry.ok = qa.ok;
      entry.errors = qa.errors;
      if (qa.ok) {
        const processedBuffer = fs.readFileSync(processedPath);
        passedActions[actionId] = {
          qa,
          processedPath,
          buffer: processedBuffer,
          sha256: crypto.createHash("sha256").update(processedBuffer).digest("hex"),
          byteSize: processedBuffer.length
        };
      }
      entry.scores = {
        identityMin: inspection.appearanceInspection.faceIdentityMinScore,
        coatMin: inspection.appearanceInspection.coatColorMinScore,
        markingMin: inspection.appearanceInspection.markingTopologyMinScore
      };
      entry.stability = inspection.contentInspection.stability;
      entry.frames = inspection.sampledFrames.length;
      if (inspection.loopBoundaryInspection) {
        entry.loop = {
          seamPixelDelta: inspection.loopBoundaryInspection.seamPixelDelta,
          terminalMotion: inspection.loopBoundaryInspection.terminalMotion,
          completedBreathCycles: inspection.loopBoundaryInspection.completedBreathCycles,
          firstRestFrameCount: inspection.loopBoundaryInspection.firstRestFrameCount,
          lastRestFrameCount: inspection.loopBoundaryInspection.lastRestFrameCount
        };
      }
    } catch (error) {
      entry.errors = [String(error && error.message || error)];
    }
    report.actions[actionId] = entry;
    if (entry.ok) report.summary.actionsPassed += 1;
    console.log(`[action ${actionId}] ok=${entry.ok} frames=${entry.frames || "?"}${entry.scores ? ` coatMin=${entry.scores.coatMin.toFixed(3)} markingMin=${entry.scores.markingMin.toFixed(3)}` : ""}${entry.ok ? "" : `\n  errors: ${entry.errors.slice(0, 6).join(" | ")}`}`);
  }

  mattingService.close();

  // Packaging + full production delivery validation (pinned clean-tree
  // upstream import plus a REAL Electron interaction run) executes only when
  // every master and action passed the production gates.
  if (report.summary.mastersPassed === 3 && report.summary.actionsPassed === 7) {
    const { buildPetpack } = require("../petpack/build");
    const {
      PetpackDeliveryValidator,
      checksumPinnedUpstreamTree,
      createElectronInteractionVerifier,
      createUpstreamImportVerifier
    } = require("../petpack/delivery-validator");
    const packageId = "hey-border-collie-v2prompt-20260818";
    const packageScratch = path.join(outputRoot, "delivery");
    await fsp.mkdir(packageScratch, { recursive: true });
    const orderedActionIds = ["idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"];
    const built = await buildPetpack({
      packageId,
      name: "Hey Pet 边牧 v2 提示词批次",
      assets: orderedActionIds.map((actionId) => ({
        actionId,
        buffer: passedActions[actionId].buffer,
        localPath: passedActions[actionId].processedPath,
        expectedSha256: passedActions[actionId].sha256,
        container: "webm",
        codec: "vp9",
        matteMode: "alpha",
        qa: passedActions[actionId].qa
      })),
      probeAsset
    });
    const packagePath = path.join(packageScratch, `${packageId}.petpack`);
    await fsp.writeFile(packagePath, built.bytes, { flag: "wx" });

    const upstreamTreeSha256 = checksumPinnedUpstreamTree(PROJECT_ROOT);
    const electronExecutablePath = path.join(PROJECT_ROOT, "node_modules", "electron", "dist", "electron.exe");
    const runnerPath = path.join(PROJECT_ROOT, "platform", "src", "petpack", "run-electron-interaction-verification.js");
    const validator = new PetpackDeliveryValidator({
      probeAsset,
      originalImportVerifier: createUpstreamImportVerifier({
        upstreamRoot: PROJECT_ROOT,
        expectedSourceTreeSha256: upstreamTreeSha256
      }),
      interactionVerifier: createElectronInteractionVerifier({
        electronExecutablePath,
        expectedElectronExecutableSha256: sha256File(electronExecutablePath),
        runnerPath,
        expectedRunnerSha256: sha256File(runnerPath),
        runnerArguments: [`--client-root=${PROJECT_ROOT}`, `--client-tree-sha256=${upstreamTreeSha256}`],
        childEnvironment: {
          SYSTEMROOT: process.env.SystemRoot || "C:\\Windows",
          USERPROFILE: process.env.USERPROFILE || packageScratch,
          TEMP: process.env.TEMP || packageScratch,
          TMP: process.env.TMP || packageScratch,
          APPDATA: process.env.APPDATA || packageScratch,
          LOCALAPPDATA: process.env.LOCALAPPDATA || packageScratch
        },
        timeoutMs: 8 * 60 * 1000
      }),
      productionMode: true,
      logger: console
    });
    const validation = await validator.validate({
      packagePath,
      bytes: built.bytes,
      expectedPackageId: packageId,
      expectedPackageSha256: built.checksumSha256,
      actions: orderedActionIds.map((actionId) => ({
        actionId,
        generationActionId: `calibration-${actionId}`,
        mediaAssetId: `calibration-media-${actionId}`,
        qaReportId: `calibration-qa-${actionId}`,
        promptVersionId: "prompt-480p-v2",
        promptVersionLabel: "正式发布候选·三母图七动作·480p-v2",
        objectKey: `private/local-calibration/${packageId}/${actionId}.webm`,
        sha256: passedActions[actionId].sha256,
        byteSize: passedActions[actionId].byteSize,
        contentType: "video/webm",
        processingPolicyVersion: PRODUCTION_QA_POLICY.version,
        processorVersion: "character-canvas-480p-alpha-vp9-v2",
        qa: passedActions[actionId].qa
      })),
      scratchDirectory: packageScratch
    });
    report.delivery = {
      ok: validation.ok,
      packageId,
      packageSha256: built.checksumSha256,
      packageByteSize: built.bytes.length,
      packagePath: path.relative(PROJECT_ROOT, packagePath).split(path.sep).join("/"),
      validatorDescriptor: validator.describe(),
      originalImport: validation.originalImport,
      interactions: validation.interactions
    };
    console.log(`\n[delivery] ok=${validation.ok} package=${built.checksumSha256.slice(0, 16)}… import=${validation.originalImport.ok} interactions=${validation.interactions.ok}`);
    if (validation.interactions.checks) {
      for (const [check, passed] of Object.entries(validation.interactions.checks)) {
        console.log(`  interaction ${check}: ${passed}`);
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(outputRoot, "report.json");
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nsummary: masters ${report.summary.mastersPassed}/3, actions ${report.summary.actionsPassed}/7${report.delivery ? `, delivery ok=${report.delivery.ok}` : ""}`);
  console.log(`report: ${path.relative(PROJECT_ROOT, reportPath)}`);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
