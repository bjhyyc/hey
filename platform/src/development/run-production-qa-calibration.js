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

  const masters = Object.fromEntries(["front", "side", "sleep"].map((kind) => [
    kind,
    requiredFile(path.join(batchRoot, "masters", `${kind}.png`), `${kind} master`)
  ]));
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
  const referenceMetrics = await measureMasterReference(masters.front);
  const masterHashes = Object.fromEntries(["front", "sleep"].map((kind) => [kind, sha256File(masters[kind])]));
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
    const sourcePath = requiredFile(path.join(batchRoot, "videos", `${actionId}.webm`), `${actionId} source`);
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
        referenceMetrics,
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
  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(outputRoot, "report.json");
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nsummary: masters ${report.summary.mastersPassed}/3, actions ${report.summary.actionsPassed}/7`);
  console.log(`report: ${path.relative(PROJECT_ROOT, reportPath)}`);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
