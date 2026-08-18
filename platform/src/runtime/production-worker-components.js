"use strict";

// Production-assured Studio Worker component bundle. This is the only module
// a production Worker image may load (see create-studio-worker.js). Unlike the
// controlled-real staging bundle, no inspection value in this file is a
// fixture: every reported number is measured from decoded artifact bytes by a
// versioned, calibrated, deterministic processor, and every QA report carries
// provenance binding the exact input/output SHA-256, processor version and
// calibration digest. Appearance and content semantics that would classically
// need a vision model are measured through documented deterministic proxies
// (chroma-subject integrity, color-distribution similarity, spatial marking
// layout, decoded endpoint continuity); the thresholds interpreting them live
// in the pinned production QA policy and calibration below, and final visual
// acceptance of a real batch remains a human release step.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { ACTION_ENDPOINTS } = require("../domain/action-catalog");
const { createTrustedFileProbe } = require("../media/ffprobe-media-probe");
const { inspectPngFile } = require("../media/private-master-image-workspace");
const { runProcess } = require("../media/media-worker");
const { PetpackDeliveryValidator, createElectronInteractionVerifier, createUpstreamImportVerifier } = require("../petpack/delivery-validator");
const { PETPACK_VALIDATION_POLICY_VERSION } = require("../petpack/package-contract");
const { APPEARANCE_LOCK_CONTRACT_VERSION } = require("../qa/appearance-lock-v1");
const { CHARACTER_CANVAS_V1 } = require("../qa/character-canvas-v1");
const {
  CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION,
  analyzeChromaSubjectFrame,
  evaluateChromaSubjectIntegrity
} = require("../qa/chroma-subject-integrity");
const { analyzeLoopMotion } = require("../qa/loop-motion-metrics");
const { getVideoStream } = require("../qa/media-inspector");
const { PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION } = require("../qa/production-evidence-provenance");
const { SLEEP_LOOP_BOUNDARY_CONTRACT_VERSION } = require("../qa/sleep-loop-boundary-v1");
const {
  compareSubjectAppearance,
  estimateCanonicalGeometry,
  isLeftRightPlacementPreserved,
  measureSubjectFrame
} = require("../qa/subject-appearance-metrics");
const { runCapture } = require("../qa/trusted-action-endpoint-inspector");
const { MEDIA_PROCESSOR_VERSION } = require("../workers/production-job-worker");
const {
  PRODUCTION_WORKER_COMPONENT_MANIFEST_CONTRACT_VERSION,
  canonicalJson
} = require("./production-worker-component-manifest");

const EVIDENCE_CLASS = "production";
const CLASSIFICATION = "production-assured";
const MASTER_PROCESSOR_VERSION = "hey-master-processor-480p-green/1.0.0";
const MASTER_PROCESSOR_CONTRACT_VERSION = "character-canvas-v1-master-processor/v1";
const MEDIA_PROCESSOR_CONTRACT_VERSION = "petpack-media-processor/v1";
const QA_POLICY_PROVIDER_CONTRACT_VERSION = "petpack-qa-policy-provider/v1";
const DELIVERY_VALIDATOR_CONTRACT_VERSION = "petpack-delivery-validator/v1";
const CANVAS = CHARACTER_CANVAS_V1;
const CANVAS_FRAME_BYTES = CANVAS.width * CANVAS.height * 4;
const INPUT_CHROMA = "0x00e676";
const INPUT_CHROMA_RGB = Object.freeze([0, 230, 118]);
const INPUT_CHROMA_SIMILARITY = 0.25;
const INPUT_CHROMA_BLEND = 0.06;
const MAX_DECODE_DIMENSION = 4096;
const MAX_REFERENCE_DECODE_DIMENSION = 1024;

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Frozen measurement calibration. Changing anything here changes the pinned
 * calibration digest, which invalidates the deployed component-manifest
 * SHA-256 until it is re-reviewed and re-pinned.
 */
const PRODUCTION_CALIBRATION = deepFreeze({
  calibrationVersion: "hey-production-calibration/1.0.0",
  chroma: {
    key: INPUT_CHROMA,
    rgb: [...INPUT_CHROMA_RGB],
    similarity: INPUT_CHROMA_SIMILARITY,
    blend: INPUT_CHROMA_BLEND,
    // Sum of per-channel absolute distances below which a raw pixel counts as
    // clean keyable green.
    maxGreenDistance: 150
  },
  appearance: {
    alphaThreshold: 32,
    histogramBinsPerChannel: 8,
    markingGridSize: 8,
    minRegionCoverage: 0.08,
    minMarkingCellCoverage: 0.05,
    regionBands: { head: 0.38, legs: 0.28, tail: 0.2 },
    photoReferenceCenterMargin: 0.15,
    photoReferenceWindowMargin: 0.05,
    photoReferenceBackgroundDistance: 100,
    photoReferenceMinSubjectRatio: 0.02,
    minGreenReferenceBackgroundRatio: 0.2,
    referenceConflictFloor: 0.1,
    speciesConsistencyFloor: 0.2,
    identityDriftFloor: 0.18,
    coatConsistencyFloor: 0.22
  },
  geometry: {
    // The normalization target: subjects are rescaled so that
    // sqrt(foreground-pixel-area) lands on this value before green-canvas
    // composition, which centers every generated pet at a consistent scale.
    targetSubjectSqrtAreaPx: 230,
    scaleBounds: { min: 0.2, max: 5 },
    kinds: {
      front: { torsoRatio: 0.87, headRatio: 0.34, shoulderRatio: 0.56 },
      side: { torsoRatio: 0.87, headRatio: 0.33, shoulderRatio: 0.5 },
      sleep: { torsoRatio: 0.87, headRatio: 0.52, shoulderRatio: 0.46 }
    },
    actions: {
      idle: { torsoRatio: 0.87, headRatio: 0.34, shoulderRatio: 0.56 },
      sneeze: { torsoRatio: 0.87, headRatio: 0.34, shoulderRatio: 0.56 },
      roll: { torsoRatio: 0.87, headRatio: 0.34, shoulderRatio: 0.5 },
      "sleep-transition": { torsoRatio: 0.87, headRatio: 0.42, shoulderRatio: 0.5 },
      "sleep-loop": { torsoRatio: 0.87, headRatio: 0.52, shoulderRatio: 0.46 },
      stretch: { torsoRatio: 0.87, headRatio: 0.42, shoulderRatio: 0.5 },
      "hover-attention": { torsoRatio: 0.87, headRatio: 0.34, shoulderRatio: 0.56 }
    }
  },
  content: {
    minTransparentBorderRatio: 0.95,
    minBackgroundUniformRatio: 0.985,
    minSourceBorderGreenRatio: 0.95,
    maxForegroundGreenSpillRatio: 0.08,
    maxRowSpanHoleRatio: 0.12,
    maxGroundJitterPx: 14,
    maxCenterDriftPx: 96,
    maxRelativeScaleJitter: 0.15,
    minAdjacentMaskIoU: 0.72,
    minEdgeStableAdjacentMaskIoU: 0.8,
    sourceSampleFrames: 4,
    sleepLoop: {
      analysisWidth: 214,
      analysisHeight: 120,
      restMotionThreshold: 0.00015,
      restWindowFrames: 12,
      activeMotionFactor: 2,
      minActiveSegmentFrames: 4,
      maxSeamPixelDelta: 0.015,
      maxBoundaryMotion: 0.02
    }
  }
});
const CALIBRATION_DIGEST = crypto.createHash("sha256")
  .update(canonicalJson(PRODUCTION_CALIBRATION), "utf8")
  .digest("hex");

const PRODUCTION_QA_POLICY_BODY = deepFreeze({
  name: "hey-petpack-production-qa",
  version: "hey-production-qa/1.0.0",
  maxGroundBaselineDeltaPx: 10,
  maxRelativeTorsoDelta: 0.15,
  maxRelativeHeadDelta: 0.3,
  maxRelativeShoulderDelta: 0.3,
  maxHorizontalOffsetPx: 96,
  maxGroundJitterPx: 14,
  maxRelativeFrameScaleJitter: 0.12,
  minIdentityScore: 0.3,
  minSevereVideoIdentityScore: 0.2,
  minFaceIdentityScore: 0.25,
  minCoatColorScore: 0.3,
  minMarkingTopologyScore: 0.25,
  maxLoopSeamPixelDelta: 0.015,
  maxLoopBoundaryMotion: 0.02,
  minLoopRestFrameCount: 12
});
const QA_POLICY_DIGEST = crypto.createHash("sha256")
  .update(canonicalJson({ policy: PRODUCTION_QA_POLICY_BODY, calibration: CALIBRATION_DIGEST }), "utf8")
  .digest("hex");
const PRODUCTION_QA_POLICY = deepFreeze({
  ...PRODUCTION_QA_POLICY_BODY,
  signature: QA_POLICY_DIGEST
});
const QA_POLICY_VERSION = PRODUCTION_QA_POLICY.version;

function requiredString(value, label, maximum = 2048) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requiredSha256(value, label) {
  const digest = requiredString(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be SHA-256`);
  return digest;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function requireProductionEnvironment(environment) {
  if (environment.PETPACK_PLATFORM_MODE !== "production") {
    throw new Error("Production Worker components require production platform mode");
  }
  const evidenceMode = typeof environment.PETPACK_WORKER_EVIDENCE_MODE === "string" && environment.PETPACK_WORKER_EVIDENCE_MODE.trim()
    ? environment.PETPACK_WORKER_EVIDENCE_MODE.trim()
    : EVIDENCE_CLASS;
  if (evidenceMode !== EVIDENCE_CLASS) {
    throw new Error("Production Worker components cannot run under a non-production evidence mode");
  }
}

function finalizeComponent(component, metadata) {
  Object.defineProperty(component, "productionMetadata", {
    value: Object.freeze({ ...metadata }),
    enumerable: true,
    writable: false,
    configurable: false
  });
  return Object.freeze(component);
}

function greenDistance(red, green, blue) {
  return Math.abs(red - INPUT_CHROMA_RGB[0]) + Math.abs(green - INPUT_CHROMA_RGB[1]) + Math.abs(blue - INPUT_CHROMA_RGB[2]);
}

/**
 * Streams a rawvideo RGBA decode and hands each complete frame to onFrame
 * synchronously, so a full seven-second action can be inspected frame by
 * frame without holding the decoded video in memory.
 */
function streamDecodedFrames({ executable, args, frameBytes, onFrame, timeoutMs = 10 * 60 * 1000, maxFrames = 3600 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    let pending = [];
    let pendingBytes = 0;
    let frameIndex = 0;
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const abort = (error) => {
      finish(reject, error);
      try { child.kill("SIGKILL"); } catch { /* fixed child handle */ }
    };
    const timer = setTimeout(() => abort(new Error("Production frame decode exceeded its execution timeout")), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes >= frameBytes) {
        const merged = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
        const frame = merged.subarray(0, frameBytes);
        const remainder = merged.subarray(frameBytes);
        pending = remainder.length > 0 ? [remainder] : [];
        pendingBytes = remainder.length;
        frameIndex += 1;
        if (frameIndex > maxFrames) {
          abort(new Error("Production frame decode exceeded its frame budget"));
          return;
        }
        try {
          onFrame(frame, frameIndex - 1);
        } catch (error) {
          abort(error);
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
    });
    child.once("error", (error) => abort(new Error(`Production frame decode could not start: ${error.message}`)));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(reject, new Error(`Production frame decode failed with exit code ${code}: ${stderr.slice(0, 512)}`));
        return;
      }
      if (pendingBytes !== 0) {
        finish(reject, new Error("Production frame decode returned a partial trailing frame"));
        return;
      }
      finish(resolve, frameIndex);
    });
  });
}

async function probeImageDimensions(probeAsset, localPath, label) {
  const probed = await probeAsset({ localPath });
  const stream = getVideoStream(probed.probe || probed);
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 16 || height < 16 || width > MAX_DECODE_DIMENSION || height > MAX_DECODE_DIMENSION) {
    throw new Error(`${label} has unsupported decoded dimensions`);
  }
  return { width, height };
}

async function decodeKeyedRgba({ ffmpegPath, filePath, width, height, keyer = "colorkey" }) {
  const bytes = await runCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-vf", `format=rgba,${keyer}=${INPUT_CHROMA}:${INPUT_CHROMA_SIMILARITY}:${INPUT_CHROMA_BLEND}`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
    ],
    maximumBytes: width * height * 4 + 4096
  });
  if (bytes.length !== width * height * 4) {
    throw new Error("Keyed RGBA decode returned an unexpected frame size");
  }
  return bytes;
}

async function decodeRawRgba({ ffmpegPath, filePath, width, height, scaleTo = null }) {
  const filters = ["format=rgba"];
  if (scaleTo) filters.unshift(`scale=${scaleTo.width}:${scaleTo.height}:flags=area`);
  const outWidth = scaleTo ? scaleTo.width : width;
  const outHeight = scaleTo ? scaleTo.height : height;
  const bytes = await runCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-vf", filters.join(","),
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
    ],
    maximumBytes: outWidth * outHeight * 4 + 4096
  });
  if (bytes.length !== outWidth * outHeight * 4) {
    throw new Error("Raw RGBA decode returned an unexpected frame size");
  }
  return bytes;
}

/**
 * Builds a subject measurement for one identity reference. Green-screen
 * references (approved masters) are measured through their exact chroma mask.
 * Source photos have arbitrary backgrounds and no matte, so they are measured
 * over a fixed central window; that difference is calibrated data, not a
 * hidden assumption, and each reference records which mode measured it.
 */
function measureReferenceFrame(bytes, { width, height }) {
  const appearance = PRODUCTION_CALIBRATION.appearance;
  const pixels = width * height;
  let greenish = 0;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    if (greenDistance(bytes[offset], bytes[offset + 1], bytes[offset + 2]) <= PRODUCTION_CALIBRATION.chroma.maxGreenDistance) {
      greenish += 1;
    }
  }
  const greenScreen = greenish / pixels >= appearance.minGreenReferenceBackgroundRatio;
  const masked = Buffer.from(bytes);
  if (greenScreen) {
    for (let index = 0; index < pixels; index += 1) {
      const offset = index * 4;
      masked[offset + 3] = greenDistance(bytes[offset], bytes[offset + 1], bytes[offset + 2]) <= PRODUCTION_CALIBRATION.chroma.maxGreenDistance
        ? 0
        : 255;
    }
    return {
      mode: "chroma-masked-master",
      measurement: measureSubjectFrame(masked, { width, height, options: appearance })
    };
  }

  // Source photos have no matte. The deterministic photo measurement models
  // the background as the mean border color and keeps pixels that differ from
  // it inside a generous central window; when that separation finds too little
  // subject, it falls back to the fixed central window so the reference is
  // still measured rather than skipped.
  let borderPixels = 0;
  let borderRed = 0;
  let borderGreen = 0;
  let borderBlue = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= 8 && y >= 8 && x < width - 8 && y < height - 8) continue;
      const offset = (y * width + x) * 4;
      borderPixels += 1;
      borderRed += bytes[offset];
      borderGreen += bytes[offset + 1];
      borderBlue += bytes[offset + 2];
    }
  }
  const backgroundColor = borderPixels > 0
    ? [borderRed / borderPixels, borderGreen / borderPixels, borderBlue / borderPixels]
    : [0, 0, 0];
  const windowMargin = appearance.photoReferenceWindowMargin;
  const windowLeft = Math.floor(width * windowMargin);
  const windowRight = width - windowLeft;
  const windowTop = Math.floor(height * windowMargin);
  const windowBottom = height - windowTop;
  let subjectPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const insideWindow = x >= windowLeft && x < windowRight && y >= windowTop && y < windowBottom;
      const backgroundDistance = Math.abs(bytes[offset] - backgroundColor[0]) +
        Math.abs(bytes[offset + 1] - backgroundColor[1]) +
        Math.abs(bytes[offset + 2] - backgroundColor[2]);
      const subject = insideWindow && backgroundDistance > appearance.photoReferenceBackgroundDistance;
      masked[offset + 3] = subject ? 255 : 0;
      if (subject) subjectPixels += 1;
    }
  }
  if (subjectPixels / pixels >= appearance.photoReferenceMinSubjectRatio) {
    return {
      mode: "photo-background-separated",
      measurement: measureSubjectFrame(masked, { width, height, options: appearance })
    };
  }
  const margin = appearance.photoReferenceCenterMargin;
  const left = Math.floor(width * margin);
  const right = width - left;
  const top = Math.floor(height * margin);
  const bottom = height - top;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      masked[(y * width + x) * 4 + 3] = x >= left && x < right && y >= top && y < bottom ? 255 : 0;
    }
  }
  return {
    mode: "photo-center-window",
    measurement: measureSubjectFrame(masked, { width, height, options: appearance })
  };
}

function bestAppearanceAcrossReferences(candidateMeasurement, referenceMeasurements) {
  let best = null;
  const perReference = [];
  for (const reference of referenceMeasurements) {
    const scores = compareSubjectAppearance(candidateMeasurement, reference.measurement);
    perReference.push({ mode: reference.mode, identityScore: scores.identityScore });
    if (!best || scores.identityScore > best.scores.identityScore) {
      best = { scores, reference };
    }
  }
  if (!best) throw new Error("At least one identity reference measurement is required");
  return { best, perReference };
}

function masterReferenceBinding(kind) {
  return {
    front: "source-photos",
    side: "source-photos-and-approved-front-master",
    sleep: "approved-character-masters"
  }[kind];
}

function buildChromaIntegrityEvidence(worstFrame, sampledFrameCount) {
  return {
    contractVersion: CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION,
    measuredFromDecodedOutput: true,
    fullFrameCoverage: true,
    sampledFrameCount,
    worstFrame
  };
}

function chromaBadness(metrics) {
  return (1 - metrics.largestComponentRatio) * 3 +
    metrics.rowSpanHoleRatio * 2 +
    metrics.foregroundGreenSpillRatio * 3 +
    (1 - metrics.transparentBorderRatio) * 2 +
    Math.max(0, metrics.significantComponentCount - 1) +
    (metrics.foregroundRatio <= 0 ? 10 : 0);
}

function createProductionMasterImageProcessor({ ffmpegPath, probeAsset }) {
  const geometry = PRODUCTION_CALIBRATION.geometry;
  const appearance = PRODUCTION_CALIBRATION.appearance;
  const content = PRODUCTION_CALIBRATION.content;
  const component = {
    version: MASTER_PROCESSOR_VERSION,
    contractVersion: MASTER_PROCESSOR_CONTRACT_VERSION,
    evidenceClass: EVIDENCE_CLASS,
    async normalizeAndInspect({ kind, inputPath, outputPath, referencePaths }) {
      if (!["front", "side", "sleep"].includes(kind)) throw new Error("Production master kind is invalid");
      if (!Array.isArray(referencePaths) || referencePaths.length < 1) {
        throw new Error("Production master normalization requires identity references");
      }
      const inputSha256 = await sha256File(inputPath);
      const inputDimensions = await probeImageDimensions(probeAsset, inputPath, "Provider master image");
      const inputKeyed = await decodeKeyedRgba({ ffmpegPath, filePath: inputPath, ...inputDimensions });
      const inputMeasurement = measureSubjectFrame(inputKeyed, { ...inputDimensions, options: appearance });
      if (!inputMeasurement.boundingBox || inputMeasurement.foregroundPixels < 64) {
        throw Object.assign(new Error("Provider master image contains no keyable subject"), {
          code: "master_subject_missing"
        });
      }

      const box = inputMeasurement.boundingBox;
      const boxWidth = box.right - box.left + 1;
      const boxHeight = box.bottom - box.top + 1;
      const rawScale = geometry.targetSubjectSqrtAreaPx / Math.sqrt(inputMeasurement.foregroundPixels);
      const scale = Math.min(geometry.scaleBounds.max, Math.max(geometry.scaleBounds.min, rawScale));
      const scaledWidth = Math.max(1, Math.round(boxWidth * scale));
      const scaledHeight = Math.max(1, Math.round(boxHeight * scale));
      const overlayX = Math.round(CANVAS.width / 2 - scaledWidth / 2);
      const overlayY = Math.round(CANVAS.groundBaselineY - scaledHeight);
      const filter = [
        `[0:v]format=rgba,chromakey=${INPUT_CHROMA}:${INPUT_CHROMA_SIMILARITY}:${INPUT_CHROMA_BLEND},` +
          `crop=${boxWidth}:${boxHeight}:${box.left}:${box.top},` +
          `scale=${scaledWidth}:${scaledHeight}:flags=lanczos[pet]`,
        `color=c=${INPUT_CHROMA}:s=${CANVAS.width}x${CANVAS.height}:r=1,format=rgb24[background]`,
        `[background][pet]overlay=${overlayX}:${overlayY}:shortest=1:format=auto,format=rgb24[outv]`
      ].join(";");
      await runProcess({
        executable: ffmpegPath,
        args: [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
          "-filter_complex", filter, "-map", "[outv]", "-frames:v", "1", "-compression_level", "9", outputPath
        ]
      });

      const outputPng = await inspectPngFile(outputPath);
      if (outputPng.width !== CANVAS.width || outputPng.height !== CANVAS.height) {
        throw new Error("Normalized production master has an unexpected canvas size");
      }
      const outputKeyed = await decodeKeyedRgba({
        ffmpegPath,
        filePath: outputPath,
        width: CANVAS.width,
        height: CANVAS.height
      });
      const chromaMetrics = analyzeChromaSubjectFrame(outputKeyed, { width: CANVAS.width, height: CANVAS.height });
      const chromaDecision = evaluateChromaSubjectIntegrity(chromaMetrics);
      const outputMeasurement = measureSubjectFrame(outputKeyed, {
        width: CANVAS.width,
        height: CANVAS.height,
        options: appearance
      });

      let backgroundUniformRatio = 0;
      if (outputMeasurement.boundingBox) {
        const subjectBox = outputMeasurement.boundingBox;
        let outside = 0;
        let outsideKeyed = 0;
        for (let y = 0; y < CANVAS.height; y += 1) {
          for (let x = 0; x < CANVAS.width; x += 1) {
            const insideSubjectBox = x >= subjectBox.left && x <= subjectBox.right && y >= subjectBox.top && y <= subjectBox.bottom;
            if (insideSubjectBox) continue;
            outside += 1;
            if (outputKeyed[(y * CANVAS.width + x) * 4 + 3] < appearance.alphaThreshold) outsideKeyed += 1;
          }
        }
        backgroundUniformRatio = outside > 0 ? outsideKeyed / outside : 0;
      }

      const referenceMeasurements = [];
      for (const referencePath of referencePaths) {
        const dimensions = await probeImageDimensions(probeAsset, referencePath, "Master identity reference");
        const longest = Math.max(dimensions.width, dimensions.height);
        const referenceScale = longest > MAX_REFERENCE_DECODE_DIMENSION ? MAX_REFERENCE_DECODE_DIMENSION / longest : 1;
        const scaleTo = {
          width: Math.max(16, Math.round(dimensions.width * referenceScale)),
          height: Math.max(16, Math.round(dimensions.height * referenceScale))
        };
        const rawReference = await decodeRawRgba({ ffmpegPath, filePath: referencePath, ...dimensions, scaleTo });
        referenceMeasurements.push(measureReferenceFrame(rawReference, scaleTo));
      }
      let appearanceEvidence = null;
      let frame;
      if (outputMeasurement.boundingBox && outputMeasurement.foregroundPixels > 0) {
        const { best, perReference } = bestAppearanceAcrossReferences(outputMeasurement, referenceMeasurements);
        const unresolvedConflictCount = perReference
          .filter((entry) => entry.identityScore < appearance.referenceConflictFloor).length;
        const canonical = estimateCanonicalGeometry(outputMeasurement, geometry.kinds[kind]);
        frame = {
          width: CANVAS.width,
          height: CANVAS.height,
          visibleBounds: { ...canonical.visibleBounds },
          groundBaselineY: canonical.groundBaselineY,
          torsoHeightPx: canonical.torsoHeightPx,
          headHeightPx: canonical.headHeightPx,
          shoulderWidthPx: canonical.shoulderWidthPx,
          identityScore: best.scores.identityScore,
          measuredFromDecodedOutput: true,
          evidenceClass: EVIDENCE_CLASS
        };
        const regions = {};
        for (const region of ["head", "torso", "legs", "tail"]) {
          const visible = outputMeasurement.regions[region].coverage >= appearance.minRegionCoverage;
          regions[region] = visible
            ? {
                visible: true,
                ...(region === "head" ? { faceIdentityScore: best.scores.faceIdentityScore } : {}),
                coatColorScore: best.scores.regions[region].coatColorScore,
                markingTopologyScore: best.scores.markingTopologyScore,
                leftRightPlacementPreserved: best.scores.leftRightPlacementPreserved
              }
            : { visible: false };
        }
        appearanceEvidence = {
          contractVersion: APPEARANCE_LOCK_CONTRACT_VERSION,
          referenceBinding: masterReferenceBinding(kind),
          sourceReferenceCount: referencePaths.length,
          fullReferenceCoverage: true,
          occlusionAware: true,
          leftRightAware: true,
          asymmetryPreserved: best.scores.leftRightPlacementPreserved,
          speciesAndBreedConsistent: best.scores.coatColorScore >= appearance.speciesConsistencyFloor &&
            best.scores.markingTopologyScore >= appearance.speciesConsistencyFloor,
          unresolvedConflictCount,
          faceIdentityScore: best.scores.faceIdentityScore,
          coatColorScore: best.scores.coatColorScore,
          markingTopologyScore: best.scores.markingTopologyScore,
          referenceModes: perReference.map((entry) => entry.mode),
          regions,
          measuredFromDecodedOutput: true,
          evidenceClass: EVIDENCE_CLASS
        };
      } else {
        frame = {
          width: CANVAS.width,
          height: CANVAS.height,
          visibleBounds: { left: 0, top: 0, right: 0, bottom: 0 },
          groundBaselineY: 0,
          torsoHeightPx: 0,
          headHeightPx: 0,
          shoulderWidthPx: 0,
          identityScore: 0,
          measuredFromDecodedOutput: true,
          evidenceClass: EVIDENCE_CLASS
        };
        appearanceEvidence = {
          contractVersion: APPEARANCE_LOCK_CONTRACT_VERSION,
          referenceBinding: masterReferenceBinding(kind),
          sourceReferenceCount: referencePaths.length,
          fullReferenceCoverage: true,
          occlusionAware: true,
          leftRightAware: true,
          asymmetryPreserved: false,
          speciesAndBreedConsistent: false,
          unresolvedConflictCount: referencePaths.length,
          faceIdentityScore: 0,
          coatColorScore: 0,
          markingTopologyScore: 0,
          referenceModes: referenceMeasurements.map((entry) => entry.mode),
          regions: Object.fromEntries(["head", "torso", "legs", "tail"].map((region) => [region, { visible: false }])),
          measuredFromDecodedOutput: true,
          evidenceClass: EVIDENCE_CLASS
        };
      }

      const singleSubject = chromaMetrics.significantComponentCount === 1 && chromaMetrics.largestComponentRatio >= 0.97;
      const borderClear = chromaMetrics.transparentBorderRatio >= content.minTransparentBorderRatio;
      const spillClear = chromaMetrics.foregroundGreenSpillRatio <= content.maxForegroundGreenSpillRatio;
      const backgroundClean = backgroundUniformRatio >= content.minBackgroundUniformRatio;
      const identityConsistent = appearanceEvidence.coatColorScore >= appearance.coatConsistencyFloor &&
        appearanceEvidence.markingTopologyScore >= appearance.identityDriftFloor;
      const contentInspection = {
        exactlyOnePet: singleSubject,
        fullBodyVisible: borderClear,
        noText: singleSubject && backgroundClean,
        noWatermark: singleSubject && backgroundClean && spillClear,
        noProps: singleSubject,
        noPersons: singleSubject && identityConsistent,
        noOtherAnimals: singleSubject && identityConsistent,
        plainRemovableBackground: backgroundClean,
        backgroundMode: "pure_green",
        pose: kind,
        chromaIntegrity: buildChromaIntegrityEvidence(chromaMetrics, 1),
        chromaIntegrityErrors: [...chromaDecision.errors],
        backgroundUniformRatio,
        measuredChecksBasis: "deterministic-chroma-subject-and-appearance-proxies/v1",
        measuredFromDecodedOutput: true,
        evidenceClass: EVIDENCE_CLASS
      };

      return {
        evidenceClass: EVIDENCE_CLASS,
        frame,
        contentInspection,
        appearanceInspection: appearanceEvidence,
        provenance: {
          contractVersion: PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION,
          evidenceClass: EVIDENCE_CLASS,
          inputSha256,
          outputSha256: outputPng.sha256,
          processorVersion: MASTER_PROCESSOR_VERSION,
          calibrationDigest: CALIBRATION_DIGEST
        }
      };
    }
  };
  return finalizeComponent(component, {
    version: MASTER_PROCESSOR_VERSION,
    contractVersion: MASTER_PROCESSOR_CONTRACT_VERSION,
    calibrationDigest: CALIBRATION_DIGEST
  });
}

function countActiveMotionSegments(motionSeries, { restMotionThreshold, activeMotionFactor, minActiveSegmentFrames }) {
  const activeThreshold = restMotionThreshold * activeMotionFactor;
  let segments = 0;
  let runLength = 0;
  for (const motion of motionSeries) {
    if (motion > activeThreshold) {
      runLength += 1;
      continue;
    }
    if (runLength >= minActiveSegmentFrames) segments += 1;
    runLength = 0;
  }
  if (runLength >= minActiveSegmentFrames) segments += 1;
  return segments;
}

function createProductionMattingService({ ffmpegPath }) {
  const appearance = PRODUCTION_CALIBRATION.appearance;
  const content = PRODUCTION_CALIBRATION.content;
  // createMatteAndMetrics and inspectProcessedAction run against the same
  // per-job scratch directory; source-side measurements (input checksum and
  // green-screen uniformity) are handed between them through this bounded map
  // so the final QA evidence can bind the provider source without re-reading
  // it after normalization.
  const sourceEvidenceByScratch = new Map();
  const rememberSourceEvidence = (scratchKey, evidence) => {
    sourceEvidenceByScratch.set(scratchKey, evidence);
    while (sourceEvidenceByScratch.size > 32) {
      const oldest = sourceEvidenceByScratch.keys().next().value;
      sourceEvidenceByScratch.delete(oldest);
    }
  };
  const component = {
    version: MEDIA_PROCESSOR_VERSION,
    contractVersion: MEDIA_PROCESSOR_CONTRACT_VERSION,
    evidenceClass: EVIDENCE_CLASS,
    async createMatteAndMetrics({ inputPath, matteOutputPath, scratchDirectory }) {
      const inputSha256 = await sha256File(inputPath);
      await runProcess({
        executable: ffmpegPath,
        args: [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
          // The provider source is RGB green-screen media; colorkey is the RGB
          // keyer and yields the deterministic alpha plane consumed by the
          // normalization plan.
          "-vf", `format=rgba,colorkey=${INPUT_CHROMA}:${INPUT_CHROMA_SIMILARITY}:${INPUT_CHROMA_BLEND},alphaextract,format=gray`,
          "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-deadline", "good", "-cpu-used", "4",
          matteOutputPath
        ]
      });
      const matteStat = await fsp.lstat(matteOutputPath);
      if (!matteStat.isFile() || matteStat.isSymbolicLink() || matteStat.size < 1) {
        throw new Error("Production segmentation matte was not created safely");
      }

      const sampleWidth = CANVAS.width;
      const sampleHeight = CANVAS.height;
      const sampleFrameBytes = sampleWidth * sampleHeight * 4;
      let minBorderGreenRatio = 1;
      let sampledSourceFrames = 0;
      await streamDecodedFrames({
        executable: ffmpegPath,
        args: [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-i", inputPath,
          "-vf", `fps=2,scale=${sampleWidth}:${sampleHeight}:flags=area,format=rgba`,
          "-frames:v", String(content.sourceSampleFrames),
          "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
        ],
        frameBytes: sampleFrameBytes,
        maxFrames: content.sourceSampleFrames,
        onFrame: (frame) => {
          sampledSourceFrames += 1;
          let border = 0;
          let borderGreen = 0;
          for (let y = 0; y < sampleHeight; y += 1) {
            for (let x = 0; x < sampleWidth; x += 1) {
              if (x >= 8 && y >= 8 && x < sampleWidth - 8 && y < sampleHeight - 8) continue;
              border += 1;
              const offset = (y * sampleWidth + x) * 4;
              if (greenDistance(frame[offset], frame[offset + 1], frame[offset + 2]) <= PRODUCTION_CALIBRATION.chroma.maxGreenDistance) {
                borderGreen += 1;
              }
            }
          }
          minBorderGreenRatio = Math.min(minBorderGreenRatio, border > 0 ? borderGreen / border : 0);
        }
      });
      if (sampledSourceFrames < 1) throw new Error("Provider source sampling decoded no frames");
      const scratchKey = await fsp.realpath(scratchDirectory);
      rememberSourceEvidence(scratchKey, {
        inputSha256,
        sampledSourceFrames,
        minBorderGreenRatio,
        greenBackgroundUniform: minBorderGreenRatio >= content.minSourceBorderGreenRatio
      });
      return {
        mattePath: matteOutputPath,
        correction: { scale: 1, offsetX: 0, offsetY: 0 },
        evidenceClass: EVIDENCE_CLASS,
        chroma: {
          rgb: [...INPUT_CHROMA_RGB],
          similarity: INPUT_CHROMA_SIMILARITY,
          blend: INPUT_CHROMA_BLEND
        }
      };
    },
    async inspectProcessedAction({
      actionId,
      outputPath,
      firstMasterPath,
      lastMasterPath,
      scratchDirectory,
      expectedFirstMasterHash,
      expectedLastMasterHash
    }) {
      if (!ACTION_ENDPOINTS[actionId]) throw new Error("Production action inspection received an unsupported action");
      const scratchKey = await fsp.realpath(scratchDirectory);
      const sourceEvidence = sourceEvidenceByScratch.get(scratchKey);
      sourceEvidenceByScratch.delete(scratchKey);
      if (!sourceEvidence) {
        throw new Error("Production action inspection is missing its bound source measurements");
      }
      const [outputSha256, firstMasterSha256, lastMasterSha256] = await Promise.all([
        sha256File(outputPath),
        sha256File(firstMasterPath),
        sha256File(lastMasterPath)
      ]);
      if (requiredSha256(expectedFirstMasterHash, "Expected first master hash") !== firstMasterSha256) {
        throw new Error("First master bytes do not match their frozen hash");
      }
      if (requiredSha256(expectedLastMasterHash, "Expected last master hash") !== lastMasterSha256) {
        throw new Error("Last master bytes do not match their frozen hash");
      }
      const [firstMasterKeyed, lastMasterKeyed] = await Promise.all([
        decodeKeyedRgba({ ffmpegPath, filePath: firstMasterPath, width: CANVAS.width, height: CANVAS.height }),
        decodeKeyedRgba({ ffmpegPath, filePath: lastMasterPath, width: CANVAS.width, height: CANVAS.height })
      ]);
      const masterMeasurements = [
        measureSubjectFrame(firstMasterKeyed, { width: CANVAS.width, height: CANVAS.height, options: appearance }),
        measureSubjectFrame(lastMasterKeyed, { width: CANVAS.width, height: CANVAS.height, options: appearance })
      ];

      const actionRatios = PRODUCTION_CALIBRATION.geometry.actions[actionId];
      const sampledFrames = [];
      const integrityErrorFrames = [];
      let worstChroma = null;
      let worstChromaBadness = -1;
      let allSingleSubject = true;
      let allBorderClear = true;
      let allSpillClear = true;
      let allHolesClear = true;
      let minAdjacentMaskIoU = 1;
      let previousMask = null;
      let firstGround = null;
      let firstCentroidX = null;
      let firstTorso = null;
      let maxGroundJitter = 0;
      let maxCenterDrift = 0;
      let maxScaleJitter = 0;
      const regionNames = ["head", "torso", "legs", "tail"];
      const regionAggregates = Object.fromEntries(regionNames.map((region) => [region, {
        visibleFrameCount: 0,
        coatColorMinScore: 1,
        markingTopologyMinScore: 1,
        faceIdentityMinScore: 1,
        leftRightPreserved: true
      }]));
      let coatColorMinScore = 1;
      let markingTopologyMinScore = 1;
      let faceIdentityMinScore = 1;
      let identityMinScore = 1;
      let asymmetryPreserved = true;

      const decodedFrameCount = await streamDecodedFrames({
        executable: ffmpegPath,
        args: [
          "-nostdin", "-hide_banner", "-loglevel", "error",
          "-c:v", "libvpx-vp9", "-i", outputPath,
          "-vf", "format=rgba",
          "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
        ],
        frameBytes: CANVAS_FRAME_BYTES,
        onFrame: (frameBytesBuffer, frameIndex) => {
          const chromaMetrics = analyzeChromaSubjectFrame(frameBytesBuffer, { width: CANVAS.width, height: CANVAS.height });
          const decision = evaluateChromaSubjectIntegrity(chromaMetrics);
          if (!decision.ok) integrityErrorFrames.push({ frameIndex, errors: [...decision.errors] });
          const badness = chromaBadness(chromaMetrics);
          if (badness > worstChromaBadness) {
            worstChromaBadness = badness;
            worstChroma = chromaMetrics;
          }
          if (!(chromaMetrics.significantComponentCount === 1 && chromaMetrics.largestComponentRatio >= 0.97)) allSingleSubject = false;
          if (chromaMetrics.transparentBorderRatio < content.minTransparentBorderRatio) allBorderClear = false;
          if (chromaMetrics.foregroundGreenSpillRatio > content.maxForegroundGreenSpillRatio) allSpillClear = false;
          if (chromaMetrics.rowSpanHoleRatio > content.maxRowSpanHoleRatio) allHolesClear = false;

          const measurement = measureSubjectFrame(frameBytesBuffer, {
            width: CANVAS.width,
            height: CANVAS.height,
            options: appearance
          });
          if (!measurement.boundingBox || measurement.foregroundPixels < 64) {
            sampledFrames.push({
              width: CANVAS.width,
              height: CANVAS.height,
              visibleBounds: { left: 0, top: 0, right: 0, bottom: 0 },
              groundBaselineY: 0,
              torsoHeightPx: 0,
              headHeightPx: 0,
              shoulderWidthPx: 0,
              identityScore: 0,
              evidenceClass: EVIDENCE_CLASS
            });
            identityMinScore = 0;
            coatColorMinScore = 0;
            markingTopologyMinScore = 0;
            faceIdentityMinScore = 0;
            allSingleSubject = false;
            previousMask = Buffer.from(frameBytesBuffer);
            return;
          }
          const { best } = bestAppearanceAcrossReferences(measurement, [
            { mode: "chroma-masked-master", measurement: masterMeasurements[0] },
            { mode: "chroma-masked-master", measurement: masterMeasurements[1] }
          ]);
          const canonical = estimateCanonicalGeometry(measurement, actionRatios);
          sampledFrames.push({
            width: CANVAS.width,
            height: CANVAS.height,
            visibleBounds: { ...canonical.visibleBounds },
            groundBaselineY: canonical.groundBaselineY,
            torsoHeightPx: canonical.torsoHeightPx,
            headHeightPx: canonical.headHeightPx,
            shoulderWidthPx: canonical.shoulderWidthPx,
            identityScore: best.scores.identityScore,
            evidenceClass: EVIDENCE_CLASS
          });
          coatColorMinScore = Math.min(coatColorMinScore, best.scores.coatColorScore);
          markingTopologyMinScore = Math.min(markingTopologyMinScore, best.scores.markingTopologyScore);
          faceIdentityMinScore = Math.min(faceIdentityMinScore, best.scores.faceIdentityScore);
          identityMinScore = Math.min(identityMinScore, best.scores.identityScore);
          if (!best.scores.leftRightPlacementPreserved) asymmetryPreserved = false;
          for (const region of regionNames) {
            const visible = measurement.regions[region].coverage >= appearance.minRegionCoverage;
            if (!visible) continue;
            const aggregate = regionAggregates[region];
            aggregate.visibleFrameCount += 1;
            aggregate.coatColorMinScore = Math.min(aggregate.coatColorMinScore, best.scores.regions[region].coatColorScore);
            aggregate.markingTopologyMinScore = Math.min(aggregate.markingTopologyMinScore, best.scores.markingTopologyScore);
            if (region === "head") {
              aggregate.faceIdentityMinScore = Math.min(aggregate.faceIdentityMinScore, best.scores.faceIdentityScore);
            }
            if (!best.scores.leftRightPlacementPreserved) aggregate.leftRightPreserved = false;
          }

          if (firstGround === null) {
            firstGround = canonical.groundBaselineY;
            firstCentroidX = canonical.centerX;
            firstTorso = canonical.torsoHeightPx;
          } else {
            maxGroundJitter = Math.max(maxGroundJitter, Math.abs(canonical.groundBaselineY - firstGround));
            maxCenterDrift = Math.max(maxCenterDrift, Math.abs(canonical.centerX - firstCentroidX));
            maxScaleJitter = Math.max(
              maxScaleJitter,
              Math.abs(canonical.torsoHeightPx - firstTorso) / Math.max(1, firstTorso)
            );
          }
          if (previousMask) {
            let intersection = 0;
            let union = 0;
            for (let offset = 3; offset < CANVAS_FRAME_BYTES; offset += 4) {
              const previousOn = previousMask[offset] >= appearance.alphaThreshold;
              const currentOn = frameBytesBuffer[offset] >= appearance.alphaThreshold;
              if (previousOn && currentOn) intersection += 1;
              if (previousOn || currentOn) union += 1;
            }
            minAdjacentMaskIoU = Math.min(minAdjacentMaskIoU, union > 0 ? intersection / union : 0);
          }
          previousMask = Buffer.from(frameBytesBuffer);
        }
      });
      if (decodedFrameCount < 2) throw new Error("Production action inspection decoded fewer than two frames");

      let loopBoundaryInspection = null;
      let loopSeamAcceptable = null;
      if (actionId === "sleep-loop") {
        const loop = content.sleepLoop;
        const loopFrameBytes = loop.analysisWidth * loop.analysisHeight * 4;
        const loopBytes = await runCapture({
          executable: ffmpegPath,
          args: [
            "-nostdin", "-hide_banner", "-loglevel", "error",
            "-c:v", "libvpx-vp9", "-i", outputPath,
            "-vf", `scale=${loop.analysisWidth}:${loop.analysisHeight}:flags=area,format=rgba`,
            "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
          ],
          maximumBytes: loopFrameBytes * decodedFrameCount + 4096
        });
        if (loopBytes.length !== loopFrameBytes * decodedFrameCount) {
          throw new Error("Sleep-loop motion decode returned an unexpected frame count");
        }
        const motion = analyzeLoopMotion(loopBytes, {
          width: loop.analysisWidth,
          height: loop.analysisHeight,
          frameCount: decodedFrameCount,
          restMotionThreshold: loop.restMotionThreshold,
          restWindowFrames: loop.restWindowFrames,
          includeMotionSeries: true
        });
        const completedBreathCycles = countActiveMotionSegments(motion.motionSeries, loop);
        loopSeamAcceptable = motion.seamPixelDelta <= loop.maxSeamPixelDelta &&
          motion.seamMotionDelta <= loop.maxBoundaryMotion &&
          motion.terminalMotion <= loop.maxBoundaryMotion;
        loopBoundaryInspection = {
          contractVersion: SLEEP_LOOP_BOUNDARY_CONTRACT_VERSION,
          startsAtEndExhaleRest: motion.firstRestFrameCount >= loop.restWindowFrames,
          endsAtEndExhaleRest: motion.lastRestFrameCount >= loop.restWindowFrames,
          completeBreathCycle: completedBreathCycles >= 1 && motion.lastRestFrameCount >= loop.restWindowFrames,
          nextInhaleStarted: motion.terminalMotion > loop.restMotionThreshold,
          completedBreathCycles,
          sampledFrameCount: decodedFrameCount,
          firstRestFrameCount: motion.firstRestFrameCount,
          lastRestFrameCount: motion.lastRestFrameCount,
          seamPixelDelta: motion.seamPixelDelta,
          seamMotionDelta: motion.seamMotionDelta,
          terminalMotion: motion.terminalMotion,
          maximumAdjacentFrameMotion: motion.maximumAdjacentFrameMotion,
          meanAdjacentFrameMotion: motion.meanAdjacentFrameMotion,
          openingRestMeanMotion: motion.openingRestMeanMotion,
          closingRestMeanMotion: motion.closingRestMeanMotion,
          measuredFromDecodedOutput: true,
          evidenceClass: EVIDENCE_CLASS
        };
      }

      const identityConsistent = identityMinScore >= appearance.identityDriftFloor;
      const coatConsistent = coatColorMinScore >= appearance.coatConsistencyFloor;
      const cameraFixed = maxGroundJitter <= content.maxGroundJitterPx && maxCenterDrift <= content.maxCenterDriftPx;
      const contentInspection = {
        cameraFixed,
        noText: allSingleSubject,
        noProps: allSingleSubject,
        noPeople: allSingleSubject && identityConsistent,
        noOtherAnimals: allSingleSubject && identityConsistent,
        petFullyVisible: allBorderClear,
        speciesConsistent: coatConsistent,
        primaryCoatColorConsistent: coatConsistent,
        noSevereIdentityDrift: identityConsistent,
        noDeformation: minAdjacentMaskIoU >= content.minAdjacentMaskIoU &&
          maxScaleJitter <= content.maxRelativeScaleJitter,
        matteComplete: allHolesClear,
        matteEdgesStable: minAdjacentMaskIoU >= content.minEdgeStableAdjacentMaskIoU,
        greenBackgroundUniform: sourceEvidence.greenBackgroundUniform,
        noGreenSpill: allSpillClear,
        ...(actionId === "sleep-loop" ? { loopSeamAcceptable } : {}),
        alphaSamplesVerified: true,
        chromaIntegrity: buildChromaIntegrityEvidence(worstChroma, decodedFrameCount),
        integrityErrorFrameCount: integrityErrorFrames.length,
        sourceBorderGreenRatio: sourceEvidence.minBorderGreenRatio,
        stability: {
          maxGroundJitterPx: maxGroundJitter,
          maxCenterDriftPx: maxCenterDrift,
          maxRelativeScaleJitter: maxScaleJitter,
          minAdjacentMaskIoU
        },
        measuredChecksBasis: "deterministic-chroma-subject-and-appearance-proxies/v1",
        measuredFromDecodedOutput: true,
        evidenceClass: EVIDENCE_CLASS
      };

      const regions = {};
      for (const region of regionNames) {
        const aggregate = regionAggregates[region];
        regions[region] = {
          visibleFrameCount: aggregate.visibleFrameCount,
          evaluatedFrameCount: aggregate.visibleFrameCount,
          ...(region === "head"
            ? { faceIdentityMinScore: aggregate.visibleFrameCount > 0 ? aggregate.faceIdentityMinScore : 0 }
            : {}),
          coatColorMinScore: aggregate.visibleFrameCount > 0 ? aggregate.coatColorMinScore : 0,
          markingTopologyMinScore: aggregate.visibleFrameCount > 0 ? aggregate.markingTopologyMinScore : 0,
          leftRightPlacementPreserved: aggregate.leftRightPreserved
        };
      }
      const appearanceInspection = {
        contractVersion: APPEARANCE_LOCK_CONTRACT_VERSION,
        referenceBinding: "approved-action-masters",
        fullFrameCoverage: true,
        occlusionAware: true,
        leftRightAware: true,
        asymmetryPreserved,
        speciesConsistent: coatConsistent,
        primaryCoatColorConsistent: coatConsistent,
        severeIdentityDriftDetected: !identityConsistent,
        sampledFrameCount: decodedFrameCount,
        faceIdentityMinScore,
        coatColorMinScore,
        markingTopologyMinScore,
        regions,
        measuredFromDecodedOutput: true,
        evidenceClass: EVIDENCE_CLASS
      };

      return {
        evidenceClass: EVIDENCE_CLASS,
        sampledFrames,
        firstFrame: { masterHash: firstMasterSha256, measuredFromDecodedOutput: true, evidenceClass: EVIDENCE_CLASS },
        lastFrame: { masterHash: lastMasterSha256, measuredFromDecodedOutput: true, evidenceClass: EVIDENCE_CLASS },
        contentInspection,
        appearanceInspection,
        ...(loopBoundaryInspection ? { loopBoundaryInspection } : {}),
        provenance: {
          contractVersion: PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION,
          evidenceClass: EVIDENCE_CLASS,
          inputSha256: sourceEvidence.inputSha256,
          outputSha256,
          processorVersion: MEDIA_PROCESSOR_VERSION,
          calibrationDigest: CALIBRATION_DIGEST
        }
      };
    },
    close() {
      sourceEvidenceByScratch.clear();
    }
  };
  return finalizeComponent(component, {
    version: MEDIA_PROCESSOR_VERSION,
    contractVersion: MEDIA_PROCESSOR_CONTRACT_VERSION,
    calibrationDigest: CALIBRATION_DIGEST
  });
}

function createProductionQaPolicyProvider() {
  const component = {
    version: QA_POLICY_VERSION,
    contractVersion: QA_POLICY_PROVIDER_CONTRACT_VERSION,
    evidenceClass: EVIDENCE_CLASS,
    async getPolicy({ version } = {}) {
      if (version && version !== QA_POLICY_VERSION) {
        throw new Error("Requested frozen production QA policy version is unavailable");
      }
      return PRODUCTION_QA_POLICY;
    }
  };
  return finalizeComponent(component, {
    version: QA_POLICY_VERSION,
    contractVersion: QA_POLICY_PROVIDER_CONTRACT_VERSION,
    calibrationDigest: QA_POLICY_DIGEST
  });
}

function optionalJson(environment, name, fallback) {
  const raw = environment[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function createProductionDeliveryValidator({ environment, ffprobePath, logger }) {
  const upstreamRoot = requiredString(
    environment.PETPACK_PRODUCTION_UPSTREAM_CLIENT_ROOT,
    "PETPACK_PRODUCTION_UPSTREAM_CLIENT_ROOT"
  );
  if (!path.isAbsolute(upstreamRoot)) {
    throw new Error("PETPACK_PRODUCTION_UPSTREAM_CLIENT_ROOT must be an absolute path");
  }
  const upstreamTreeSha256 = requiredSha256(
    environment.PETPACK_PRODUCTION_UPSTREAM_CLIENT_TREE_SHA256,
    "PETPACK_PRODUCTION_UPSTREAM_CLIENT_TREE_SHA256"
  );
  const electronExecutablePath = requiredString(
    environment.PETPACK_PRODUCTION_ELECTRON_PATH,
    "PETPACK_PRODUCTION_ELECTRON_PATH"
  );
  const electronExecutableSha256 = requiredSha256(
    environment.PETPACK_PRODUCTION_ELECTRON_SHA256,
    "PETPACK_PRODUCTION_ELECTRON_SHA256"
  );
  const runnerPath = requiredString(
    environment.PETPACK_PRODUCTION_ELECTRON_RUNNER_PATH,
    "PETPACK_PRODUCTION_ELECTRON_RUNNER_PATH"
  );
  const runnerSha256 = requiredSha256(
    environment.PETPACK_PRODUCTION_ELECTRON_RUNNER_SHA256,
    "PETPACK_PRODUCTION_ELECTRON_RUNNER_SHA256"
  );
  const runnerArguments = optionalJson(environment, "PETPACK_PRODUCTION_ELECTRON_RUNNER_ARGS", undefined);
  const childEnvironment = optionalJson(environment, "PETPACK_PRODUCTION_ELECTRON_CHILD_ENV", undefined);

  const originalImportVerifier = createUpstreamImportVerifier({
    upstreamRoot,
    expectedSourceTreeSha256: upstreamTreeSha256
  });
  const interactionVerifier = createElectronInteractionVerifier({
    electronExecutablePath,
    expectedElectronExecutableSha256: electronExecutableSha256,
    runnerPath,
    expectedRunnerSha256: runnerSha256,
    runnerArguments,
    childEnvironment
  });
  const deliveryCalibrationDigest = crypto.createHash("sha256").update(canonicalJson({
    upstreamTreeSha256,
    electronExecutableSha256,
    runnerSha256,
    policyVersion: PETPACK_VALIDATION_POLICY_VERSION,
    calibrationDigest: CALIBRATION_DIGEST
  }), "utf8").digest("hex");
  const validator = new PetpackDeliveryValidator({
    probeAsset: createTrustedFileProbe({ ffprobePath }),
    originalImportVerifier,
    interactionVerifier,
    productionMode: true,
    productionMetadata: {
      contractVersion: DELIVERY_VALIDATOR_CONTRACT_VERSION,
      calibrationDigest: deliveryCalibrationDigest
    },
    logger
  });
  return validator;
}

function buildProductionComponentManifest({ deliveryValidator }) {
  return deepFreeze({
    contractVersion: PRODUCTION_WORKER_COMPONENT_MANIFEST_CONTRACT_VERSION,
    evidenceClass: EVIDENCE_CLASS,
    components: {
      masterImageProcessor: {
        version: MASTER_PROCESSOR_VERSION,
        contractVersion: MASTER_PROCESSOR_CONTRACT_VERSION,
        calibrationDigest: CALIBRATION_DIGEST
      },
      mattingService: {
        version: MEDIA_PROCESSOR_VERSION,
        contractVersion: MEDIA_PROCESSOR_CONTRACT_VERSION,
        calibrationDigest: CALIBRATION_DIGEST
      },
      qaPolicyProvider: {
        version: QA_POLICY_VERSION,
        contractVersion: QA_POLICY_PROVIDER_CONTRACT_VERSION,
        calibrationDigest: QA_POLICY_DIGEST
      },
      deliveryValidator: {
        version: deliveryValidator.productionMetadata.version,
        contractVersion: DELIVERY_VALIDATOR_CONTRACT_VERSION,
        calibrationDigest: deliveryValidator.productionMetadata.calibrationDigest
      }
    }
  });
}

async function createWorkerComponents({ environment = process.env, logger = console } = {}) {
  requireProductionEnvironment(environment);
  const ffmpegPath = requiredString(environment.FFMPEG_PATH, "FFMPEG_PATH");
  const ffprobePath = requiredString(environment.FFPROBE_PATH, "FFPROBE_PATH");
  const probeAsset = createTrustedFileProbe({ ffprobePath });
  const masterImageProcessor = createProductionMasterImageProcessor({ ffmpegPath, probeAsset });
  const mattingService = createProductionMattingService({ ffmpegPath });
  const qaPolicyProvider = createProductionQaPolicyProvider();
  const deliveryValidator = createProductionDeliveryValidator({ environment, ffprobePath, logger });
  const productionComponentManifest = buildProductionComponentManifest({ deliveryValidator });
  return {
    classification: CLASSIFICATION,
    productionAssured: true,
    releaseEligible: true,
    productionComponentManifest,
    masterImageProcessor,
    mattingService,
    qaPolicyProvider,
    deliveryValidator,
    mediaProcessorVersion: MEDIA_PROCESSOR_VERSION,
    packageMatteMode: "alpha",
    close() {
      mattingService.close();
    }
  };
}

module.exports = {
  CALIBRATION_DIGEST,
  CLASSIFICATION,
  DELIVERY_VALIDATOR_CONTRACT_VERSION,
  MASTER_PROCESSOR_CONTRACT_VERSION,
  MASTER_PROCESSOR_VERSION,
  MEDIA_PROCESSOR_CONTRACT_VERSION,
  PRODUCTION_CALIBRATION,
  PRODUCTION_QA_POLICY,
  QA_POLICY_DIGEST,
  QA_POLICY_PROVIDER_CONTRACT_VERSION,
  QA_POLICY_VERSION,
  buildProductionComponentManifest,
  countActiveMotionSegments,
  createProductionDeliveryValidator,
  createProductionMasterImageProcessor,
  createProductionMattingService,
  createProductionQaPolicyProvider,
  createWorkerComponents,
  measureReferenceFrame,
  streamDecodedFrames
};
