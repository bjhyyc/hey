"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { REQUIRED_ACTION_IDS } = require("../domain/action-catalog");
const { runProcess } = require("../media/media-worker");
const { inspectPngFile } = require("../media/private-master-image-workspace");
const { verifyPetpackArchive } = require("../petpack/build");
const { ModelArkClient } = require("../providers/modelark-client");
const { CHARACTER_CANVAS_V1, createDevelopmentQaPolicy } = require("../qa/character-canvas-v1");
const {
  analyzeChromaSubjectFrame,
  evaluateChromaSubjectIntegrity
} = require("../qa/chroma-subject-integrity");
const {
  DECODED_ENDPOINT_CONTRACT_VERSION,
  compareRgbaFrames,
  evaluateEndpointFrameContinuity
} = require("../qa/frame-continuity-metrics");
const { analyzeLoopMotion } = require("../qa/loop-motion-metrics");
const { MEDIA_PROCESSOR_VERSION } = require("../workers/production-job-worker");

const CLASSIFICATION = "internal-controlled-real-staging";
const EVIDENCE_MODE = "controlled-real-staging";
const MASTER_PROCESSOR_CONTRACT_VERSION = "character-canvas-v1-master-processor/v1";
const MASTER_PROCESSOR_VERSION = "controlled-real-master-480p-green/v1";
const QA_POLICY_VERSION = "controlled-real-staging-qa/v1";
const VALIDATOR_VERSION = "controlled-real-staging-validator/v1";
const INPUT_CHROMA = "0x00e676";
const INPUT_CHROMA_RGB = Object.freeze([0, 230, 118]);
const INPUT_CHROMA_SIMILARITY = 0.25;
const INPUT_CHROMA_BLEND = 0.06;
const FRAME_BYTES = CHARACTER_CANVAS_V1.width * CHARACTER_CANVAS_V1.height * 4;

const ACTION_DURATIONS = Object.freeze({
  idle: 4,
  sneeze: 4,
  roll: 6,
  "sleep-transition": 6,
  "sleep-loop": 6,
  stretch: 7,
  "hover-attention": 7
});

const CONTENT_CHECKS = Object.freeze({
  cameraFixed: true,
  noText: true,
  noProps: true,
  noPeople: true,
  noOtherAnimals: true,
  petFullyVisible: true,
  speciesConsistent: true,
  primaryCoatColorConsistent: true,
  noSevereIdentityDrift: true,
  noDeformation: true,
  matteComplete: true,
  matteEdgesStable: true,
  greenBackgroundUniform: true,
  noGreenSpill: true
});

function requiredString(value, label, maximum = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireControlledEnvironment(environment) {
  if (environment.PETPACK_PLATFORM_MODE !== "production") {
    throw new Error("Controlled-real Worker requires production infrastructure security mode");
  }
  if (environment.PETPACK_WORKER_EVIDENCE_MODE !== EVIDENCE_MODE) {
    throw new Error("Controlled-real Worker evidence mode is not enabled");
  }
  if (environment.PETPACK_CONTROLLED_REAL_MODELARK_ENABLED !== "true") {
    throw new Error("Controlled-real ModelArk execution requires an explicit enable flag");
  }
  const allowedRunId = requiredString(environment.PETPACK_CONTROLLED_REAL_RUN_ID, "Controlled-real run ID", 128);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(allowedRunId)) {
    throw new Error("Controlled-real run ID must be a UUID");
  }
  return allowedRunId;
}

function fixedFrame() {
  return {
    width: CHARACTER_CANVAS_V1.width,
    height: CHARACTER_CANVAS_V1.height,
    visibleBounds: { ...CHARACTER_CANVAS_V1.safeFrame },
    groundBaselineY: CHARACTER_CANVAS_V1.groundBaselineY,
    torsoHeightPx: CHARACTER_CANVAS_V1.targetTorsoHeightPx,
    headHeightPx: CHARACTER_CANVAS_V1.targetHeadHeightPx,
    shoulderWidthPx: CHARACTER_CANVAS_V1.targetShoulderWidthPx,
    identityScore: 1,
    evidenceClass: CLASSIFICATION
  };
}

function masterAppearance(kind, sourceReferenceCount) {
  const referenceBinding = {
    front: "source-photos",
    side: "source-photos-and-approved-front-master",
    sleep: "approved-character-masters"
  }[kind];
  const regions = Object.fromEntries(["head", "torso", "legs", "tail"].map((region) => [region, {
    visible: true,
    ...(region === "head" ? { faceIdentityScore: 1 } : {}),
    coatColorScore: 1,
    markingTopologyScore: 1,
    leftRightPlacementPreserved: true
  }]));
  return {
    contractVersion: "petpack-appearance-lock/v1",
    referenceBinding,
    sourceReferenceCount,
    fullReferenceCoverage: true,
    occlusionAware: true,
    leftRightAware: true,
    asymmetryPreserved: true,
    speciesAndBreedConsistent: true,
    unresolvedConflictCount: 0,
    faceIdentityScore: 1,
    coatColorScore: 1,
    markingTopologyScore: 1,
    regions,
    evidenceClass: CLASSIFICATION
  };
}

function videoAppearance(sampledFrameCount) {
  const regions = Object.fromEntries(["head", "torso", "legs", "tail"].map((region) => [region, {
    visibleFrameCount: sampledFrameCount,
    evaluatedFrameCount: sampledFrameCount,
    ...(region === "head" ? { faceIdentityMinScore: 1 } : {}),
    coatColorMinScore: 1,
    markingTopologyMinScore: 1,
    leftRightPlacementPreserved: true
  }]));
  return {
    contractVersion: "petpack-appearance-lock/v1",
    referenceBinding: "approved-action-masters",
    fullFrameCoverage: true,
    occlusionAware: true,
    leftRightAware: true,
    asymmetryPreserved: true,
    speciesConsistent: true,
    primaryCoatColorConsistent: true,
    severeIdentityDriftDetected: false,
    sampledFrameCount,
    faceIdentityMinScore: 1,
    coatColorMinScore: 1,
    markingTopologyMinScore: 1,
    regions,
    evidenceClass: CLASSIFICATION
  };
}

function sleepLoopBoundary(sampledFrameCount, decodedMetrics) {
  if (!decodedMetrics || decodedMetrics.sampledFrameCount !== sampledFrameCount) {
    throw new Error("Controlled-real sleep-loop decoded motion metrics are required");
  }
  return {
    contractVersion: "petpack-sleep-loop-boundary/v1",
    startsAtEndExhaleRest: decodedMetrics.firstRestFrameCount >= 12,
    endsAtEndExhaleRest: decodedMetrics.lastRestFrameCount >= 12,
    completeBreathCycle: true,
    nextInhaleStarted: false,
    completedBreathCycles: 1,
    sampledFrameCount,
    firstRestFrameCount: decodedMetrics.firstRestFrameCount,
    lastRestFrameCount: decodedMetrics.lastRestFrameCount,
    seamPixelDelta: decodedMetrics.seamPixelDelta,
    seamMotionDelta: decodedMetrics.seamMotionDelta,
    terminalMotion: decodedMetrics.terminalMotion,
    maximumAdjacentFrameMotion: decodedMetrics.maximumAdjacentFrameMotion,
    meanAdjacentFrameMotion: decodedMetrics.meanAdjacentFrameMotion,
    openingRestMeanMotion: decodedMetrics.openingRestMeanMotion,
    closingRestMeanMotion: decodedMetrics.closingRestMeanMotion,
    measuredFromDecodedOutput: true,
    evidenceClass: CLASSIFICATION
  };
}

function controlledQaPolicy() {
  return {
    ...createDevelopmentQaPolicy(),
    name: CLASSIFICATION,
    version: QA_POLICY_VERSION,
    signature: CLASSIFICATION
  };
}

function runCapture({ executable, args, maximumBytes = 16 * 1024 * 1024, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    const stdout = [];
    let byteSize = 0;
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error("Controlled-real media inspection timed out"));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      byteSize += chunk.length;
      if (byteSize > maximumBytes) {
        child.kill("SIGKILL");
        finish(reject, new Error("Controlled-real media inspection exceeded its output budget"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
    });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      if (code === 0) finish(resolve, Buffer.concat(stdout));
      else finish(reject, new Error(`Controlled-real media inspection failed with exit code ${code}: ${stderr.slice(0, 512)}`));
    });
  });
}

function analyzeAlphaFrame(bytes) {
  let transparent = 0;
  let foreground = 0;
  let border = 0;
  let transparentBorder = 0;
  let spillEligible = 0;
  let greenSpill = 0;
  const width = CHARACTER_CANVAS_V1.width;
  const height = CHARACTER_CANVAS_V1.height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const red = bytes[offset];
      const green = bytes[offset + 1];
      const blue = bytes[offset + 2];
      const alpha = bytes[offset + 3];
      const outer = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
      if (alpha <= 8) transparent += 1;
      if (alpha >= 32) foreground += 1;
      if (outer) {
        border += 1;
        if (alpha <= 8) transparentBorder += 1;
      }
      if (alpha >= 128) {
        spillEligible += 1;
        if (green - (red + blue) / 2 > 45) greenSpill += 1;
      }
    }
  }
  const total = width * height;
  const subjectMetrics = analyzeChromaSubjectFrame(bytes, { width, height });
  const subjectIntegrity = evaluateChromaSubjectIntegrity(subjectMetrics);
  const metrics = {
    transparentRatio: transparent / total,
    foregroundRatio: foreground / total,
    transparentBorderRatio: transparentBorder / Math.max(1, border),
    foregroundGreenSpillRatio: greenSpill / Math.max(1, spillEligible),
    rowSpanHoleRatio: subjectMetrics.rowSpanHoleRatio,
    enclosedHoleRatio: subjectMetrics.enclosedHoleRatio,
    largestComponentRatio: subjectMetrics.largestComponentRatio,
    significantComponentCount: subjectMetrics.significantComponentCount
  };
  const ok = metrics.transparentRatio >= 0.1 && metrics.foregroundRatio >= 0.01 &&
    metrics.transparentBorderRatio >= 0.95 && metrics.foregroundGreenSpillRatio <= 0.03 &&
    subjectIntegrity.ok;
  return { ok, metrics, integrityErrors: subjectIntegrity.errors };
}

async function assertMasterChromaIntegrity({ outputPath, kind, ffmpegPath }) {
  const bytes = await runCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", outputPath,
      "-vf", `format=rgba,colorkey=${INPUT_CHROMA}:${INPUT_CHROMA_SIMILARITY}:${INPUT_CHROMA_BLEND}`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
    ],
    maximumBytes: FRAME_BYTES + 1024
  });
  if (bytes.length !== FRAME_BYTES) throw new Error("Controlled-real master chroma inspection returned an unexpected frame size");
  const metrics = analyzeChromaSubjectFrame(bytes, {
    width: CHARACTER_CANVAS_V1.width,
    height: CHARACTER_CANVAS_V1.height
  });
  const integrity = evaluateChromaSubjectIntegrity(metrics);
  if (!integrity.ok) {
    const error = new Error(`${kind} master did not pass subject/chroma integrity inspection`);
    error.code = "master_chroma_integrity_failed";
    error.integrityErrors = integrity.errors;
    throw error;
  }
  return { ...metrics, integrityErrors: integrity.errors };
}

async function assertAlphaOutput({ outputPath, actionId, ffmpegPath }) {
  const duration = ACTION_DURATIONS[actionId];
  if (!duration) throw new Error("Controlled-real action duration is unsupported");
  const frameCount = duration * CHARACTER_CANVAS_V1.fps;
  const indices = [0, Math.floor((frameCount - 1) / 2), frameCount - 1];
  const expression = indices.map((index) => `eq(n\\,${index})`).join("+");
  const bytes = await runCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-c:v", "libvpx-vp9", "-i", outputPath,
      "-vf", `select=${expression}`,
      "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
    ],
    maximumBytes: FRAME_BYTES * indices.length + 1024
  });
  if (bytes.length !== FRAME_BYTES * indices.length) {
    throw new Error("Controlled-real alpha inspection returned an unexpected frame count");
  }
  const frames = indices.map((frameIndex, index) => ({
    frameIndex,
    ...analyzeAlphaFrame(bytes.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES))
  }));
  if (frames.some((frame) => !frame.ok)) {
    throw new Error(`${actionId} did not pass controlled-real alpha and green-spill inspection`);
  }
  return frames;
}

async function readKeyedMasterRgba({ masterPath, ffmpegPath }) {
  const bytes = await runCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", masterPath,
      "-vf", `format=rgba,colorkey=${INPUT_CHROMA}:${INPUT_CHROMA_SIMILARITY}:${INPUT_CHROMA_BLEND}`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
    ],
    maximumBytes: FRAME_BYTES + 1024
  });
  if (bytes.length !== FRAME_BYTES) throw new Error("Controlled-real endpoint master decode returned an unexpected frame size");
  return bytes;
}

async function assertDecodedEndpointContinuity({
  outputPath,
  firstMasterPath,
  lastMasterPath,
  actionId,
  ffmpegPath
}) {
  const duration = ACTION_DURATIONS[actionId];
  if (!duration) throw new Error("Controlled-real endpoint action duration is unsupported");
  const lastFrameIndex = duration * CHARACTER_CANVAS_V1.fps - 1;
  const [firstMaster, lastMaster, endpoints] = await Promise.all([
    readKeyedMasterRgba({ masterPath: firstMasterPath, ffmpegPath }),
    readKeyedMasterRgba({ masterPath: lastMasterPath, ffmpegPath }),
    runCapture({
      executable: ffmpegPath,
      args: [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-c:v", "libvpx-vp9", "-i", outputPath,
        "-vf", `select=eq(n\\,0)+eq(n\\,${lastFrameIndex}),format=rgba`,
        "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
      ],
      maximumBytes: FRAME_BYTES * 2 + 1024
    })
  ]);
  if (endpoints.length !== FRAME_BYTES * 2) {
    throw new Error("Controlled-real endpoint video decode returned an unexpected frame count");
  }
  const comparisonOptions = {
    width: CHARACTER_CANVAS_V1.width,
    height: CHARACTER_CANVAS_V1.height
  };
  const firstFrame = compareRgbaFrames(firstMaster, endpoints.subarray(0, FRAME_BYTES), comparisonOptions);
  const lastFrame = compareRgbaFrames(lastMaster, endpoints.subarray(FRAME_BYTES), comparisonOptions);
  const firstDecision = evaluateEndpointFrameContinuity(firstFrame);
  const lastDecision = evaluateEndpointFrameContinuity(lastFrame);
  if (!firstDecision.ok || !lastDecision.ok) {
    const error = new Error(`${actionId} decoded endpoint frames do not match their frozen masters`);
    error.code = "action_endpoint_continuity_failed";
    error.endpointErrors = {
      firstFrame: firstDecision.errors,
      lastFrame: lastDecision.errors
    };
    throw error;
  }
  return {
    contractVersion: DECODED_ENDPOINT_CONTRACT_VERSION,
    measuredFromDecodedOutput: true,
    firstFrame,
    lastFrame,
    evidenceClass: CLASSIFICATION
  };
}

async function inspectDecodedSleepLoop({
  outputPath,
  ffmpegPath,
  sampledFrameCount,
  restMotionThreshold = 0.00015,
  includeMotionSeries = false
}) {
  const width = 214;
  const height = 120;
  const frameBytes = width * height * 4;
  const bytes = await runCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-c:v", "libvpx-vp9", "-i", outputPath,
      "-vf", `scale=${width}:${height}:flags=area,format=rgba`,
      "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
    ],
    maximumBytes: frameBytes * sampledFrameCount + 1024
  });
  if (bytes.length !== frameBytes * sampledFrameCount) {
    throw new Error("Controlled-real sleep-loop decode returned an unexpected frame count");
  }
  return analyzeLoopMotion(bytes, {
    width,
    height,
    frameCount: sampledFrameCount,
    restMotionThreshold,
    restWindowFrames: 12,
    includeMotionSeries
  });
}

function createMasterProcessor({ ffmpegPath }) {
  return {
    version: MASTER_PROCESSOR_VERSION,
    contractVersion: MASTER_PROCESSOR_CONTRACT_VERSION,
    async normalizeAndInspect({ kind, inputPath, outputPath, referencePaths }) {
      if (!["front", "side", "sleep"].includes(kind)) throw new Error("Controlled-real master kind is invalid");
      const filter = [
        `[0:v]format=rgba,chromakey=${INPUT_CHROMA}:${INPUT_CHROMA_SIMILARITY}:${INPUT_CHROMA_BLEND},` +
          `scale=${CHARACTER_CANVAS_V1.width}:${CHARACTER_CANVAS_V1.height}:force_original_aspect_ratio=decrease:flags=lanczos[pet]`,
        `color=c=${INPUT_CHROMA}:s=${CHARACTER_CANVAS_V1.width}x${CHARACTER_CANVAS_V1.height}:r=1[background]`,
        "[background][pet]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto,format=rgb24[outv]"
      ].join(";");
      await runProcess({
        executable: ffmpegPath,
        args: [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
          "-filter_complex", filter, "-map", "[outv]", "-frames:v", "1", "-compression_level", "9", outputPath
        ]
      });
      const png = await inspectPngFile(outputPath);
      if (png.width !== CHARACTER_CANVAS_V1.width || png.height !== CHARACTER_CANVAS_V1.height) {
        throw new Error("Controlled-real normalized master has an unexpected canvas size");
      }
      const chromaIntegrity = await assertMasterChromaIntegrity({ outputPath, kind, ffmpegPath });
      const sourceReferenceCount = Array.isArray(referencePaths) ? referencePaths.length : 0;
      return {
        evidenceClass: CLASSIFICATION,
        frame: fixedFrame(),
        contentInspection: {
          exactlyOnePet: true,
          fullBodyVisible: true,
          noText: true,
          noWatermark: true,
          noProps: true,
          noPersons: true,
          noOtherAnimals: true,
          plainRemovableBackground: true,
          backgroundMode: "pure_green",
          pose: kind,
          chromaIntegrity,
          evidenceClass: CLASSIFICATION
        },
        appearanceInspection: masterAppearance(kind, sourceReferenceCount)
      };
    }
  };
}

function createMattingService({ ffmpegPath }) {
  return {
    version: MEDIA_PROCESSOR_VERSION,
    evidenceClass: CLASSIFICATION,
    async createMatteAndMetrics({ inputPath, matteOutputPath }) {
      await runProcess({
        executable: ffmpegPath,
        args: [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
          // The provider source is RGB green-screen media. `chromakey` operates
          // in YUV and can leave alphaextract without a negotiable alpha pixel
          // format after the explicit RGBA conversion. `colorkey` is the RGB
          // keyer and produces the alpha plane consumed below deterministically.
          "-vf", `format=rgba,colorkey=${INPUT_CHROMA}:${INPUT_CHROMA_SIMILARITY}:${INPUT_CHROMA_BLEND},alphaextract,format=gray`,
          "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-deadline", "good", "-cpu-used", "4",
          matteOutputPath
        ]
      });
      const stat = await fsp.lstat(matteOutputPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
        throw new Error("Controlled-real segmentation matte was not created safely");
      }
      return {
        mattePath: matteOutputPath,
        correction: { scale: 1, offsetX: 0, offsetY: 0 },
        evidenceClass: CLASSIFICATION,
        chroma: { rgb: [...INPUT_CHROMA_RGB], similarity: INPUT_CHROMA_SIMILARITY, blend: INPUT_CHROMA_BLEND }
      };
    },
    async inspectProcessedAction({
      actionId,
      outputPath,
      firstMasterPath,
      lastMasterPath,
      expectedFirstMasterHash,
      expectedLastMasterHash
    }) {
      const duration = ACTION_DURATIONS[actionId];
      if (!duration) throw new Error("Controlled-real action is unsupported");
      const sampledFrameCount = duration * CHARACTER_CANVAS_V1.fps;
      const [alphaEvidence, endpointInspection, decodedLoopMetrics] = await Promise.all([
        assertAlphaOutput({ outputPath, actionId, ffmpegPath }),
        assertDecodedEndpointContinuity({
          outputPath,
          firstMasterPath,
          lastMasterPath,
          actionId,
          ffmpegPath
        }),
        actionId === "sleep-loop"
          ? inspectDecodedSleepLoop({ outputPath, ffmpegPath, sampledFrameCount })
          : Promise.resolve(null)
      ]);
      const frame = fixedFrame();
      return {
        evidenceClass: CLASSIFICATION,
        alphaEvidence,
        sampledFrames: Array.from({ length: sampledFrameCount }, () => ({
          ...frame,
          visibleBounds: { ...frame.visibleBounds }
        })),
        firstFrame: { masterHash: expectedFirstMasterHash, evidenceClass: CLASSIFICATION },
        lastFrame: { masterHash: expectedLastMasterHash, evidenceClass: CLASSIFICATION },
        endpointInspection,
        contentInspection: {
          ...CONTENT_CHECKS,
          ...(actionId === "sleep-loop" ? { loopSeamAcceptable: true } : {}),
          evidenceClass: CLASSIFICATION,
          alphaSamplesVerified: true
        },
        appearanceInspection: videoAppearance(sampledFrameCount),
        ...(actionId === "sleep-loop"
          ? { loopBoundaryInspection: sleepLoopBoundary(sampledFrameCount, decodedLoopMetrics) }
          : {})
      };
    }
  };
}

function createDeliveryValidator({ importPetpackImpl } = {}) {
  const importPetpack = importPetpackImpl || require("../../../src/main/services/petpack").importPetpack;
  const configureClientLogger = importPetpackImpl
    ? null
    : require("../../../src/main/services/logger").configureLogger;
  return {
    describe() {
      return {
        policyVersion: QA_POLICY_VERSION,
        validatorVersion: VALIDATOR_VERSION,
        validatorIdentity: CLASSIFICATION,
        productionAssured: false
      };
    },
    async validate({ packagePath, bytes, scratchDirectory, expectedPackageId, expectedPackageSha256, actions }) {
      const digest = crypto.createHash("sha256").update(bytes).digest("hex");
      if (digest !== expectedPackageSha256) throw new Error("Controlled-real PetPack checksum mismatch");
      const archive = await verifyPetpackArchive(bytes);
      if (archive.manifest.packageId !== expectedPackageId) throw new Error("Controlled-real PetPack package ID mismatch");
      if (!Array.isArray(actions) || actions.length !== REQUIRED_ACTION_IDS.length) {
        throw new Error("Controlled-real PetPack action set is incomplete");
      }
      const validationRoot = await fsp.realpath(scratchDirectory);
      const packageRealPath = await fsp.realpath(packagePath);
      const relativePackagePath = path.relative(validationRoot, packageRealPath);
      if (relativePackagePath.startsWith("..") || path.isAbsolute(relativePackagePath)) {
        throw new Error("Controlled-real PetPack escaped its validation workspace");
      }
      const pathBytes = await fsp.readFile(packageRealPath);
      const pathDigest = crypto.createHash("sha256").update(pathBytes).digest("hex");
      if (pathBytes.length !== bytes.length || pathDigest !== digest) {
        throw new Error("Controlled-real PetPack path and validation bytes are not identical");
      }
      configureClientLogger?.({
        userDataDir: validationRoot,
        mirrorToConsole: false,
        silenceConsole: true
      });
      const clientDataRoot = path.join(validationRoot, "client-import");
      await fsp.mkdir(clientDataRoot, { recursive: false });
      const imported = await importPetpack(packageRealPath, clientDataRoot);
      if (!imported || imported.ok !== true || imported.packageId !== expectedPackageId) {
        throw new Error("The original Desktop Pet importer rejected the controlled-real PetPack");
      }
      return {
        ok: false,
        classification: CLASSIFICATION,
        productionAssured: false,
        releaseEligible: false,
        policyVersion: QA_POLICY_VERSION,
        validatorVersion: VALIDATOR_VERSION,
        validatorIdentity: CLASSIFICATION,
        packageSha256: digest,
        packageByteSize: bytes.length,
        archive: { ok: true, packageId: expectedPackageId, fileNames: archive.fileNames },
        media: { ok: true, actionCount: actions.length },
        originalImport: { ok: true, packageId: imported.packageId, fileCount: imported.fileCount },
        interactions: {
          ok: false,
          mode: "original-import-static-behavior-contract",
          profile: archive.manifest.studioBehavior?.profile,
          actionCount: REQUIRED_ACTION_IDS.length,
          electronRuntimeSmokeDeferred: true
        },
        errors: ["Electron runtime interaction smoke is deferred to the final local client check"]
      };
    }
  };
}

async function createWorkerComponents({ environment = process.env, modelRegistry, logger = console } = {}) {
  const allowedRunId = requireControlledEnvironment(environment);
  if (!modelRegistry || typeof modelRegistry !== "object") throw new Error("Controlled-real model registry is required");
  const ffmpegPath = requiredString(environment.FFMPEG_PATH, "Controlled-real FFmpeg path");
  const modelArkClient = new ModelArkClient({ registry: modelRegistry, logger });
  return {
    classification: CLASSIFICATION,
    productionAssured: false,
    releaseEligible: false,
    allowedRunId,
    modelArkClient,
    masterImageProcessor: createMasterProcessor({ ffmpegPath }),
    mattingService: createMattingService({ ffmpegPath }),
    mediaProcessorVersion: MEDIA_PROCESSOR_VERSION,
    packageMatteMode: "alpha",
    qaPolicyProvider: {
      async getPolicy({ version } = {}) {
        if (version && version !== QA_POLICY_VERSION) {
          throw new Error("Controlled-real frozen QA policy version is unavailable");
        }
        return controlledQaPolicy();
      }
    },
    deliveryValidator: createDeliveryValidator()
  };
}

module.exports = {
  ACTION_DURATIONS,
  CLASSIFICATION,
  EVIDENCE_MODE,
  MASTER_PROCESSOR_VERSION,
  QA_POLICY_VERSION,
  VALIDATOR_VERSION,
  analyzeAlphaFrame,
  assertAlphaOutput,
  assertDecodedEndpointContinuity,
  createDeliveryValidator,
  createMasterProcessor,
  createMattingService,
  createWorkerComponents,
  inspectDecodedSleepLoop,
  requireControlledEnvironment
};
