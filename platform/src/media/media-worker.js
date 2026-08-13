const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { validateVideoAction } = require("../qa/action-quality-gate");
const { getVideoStream, parseFrameRate } = require("../qa/media-inspector");
const { createVideoNormalizationPlan } = require("./ffmpeg-plan");

function runProcess({ executable, args }, { spawnImpl = spawn, timeoutMs = 10 * 60 * 1000 } = {}) {
  if (typeof spawnImpl !== "function") throw new Error("A process spawn implementation is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) {
    throw new Error("Media process timeout must be between 1 second and 1 hour");
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { shell: false, windowsHide: true });
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill?.("SIGKILL");
      finish(reject, new Error("Media process exceeded its execution timeout"));
    }, timeoutMs);
    timer.unref?.();
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - stderr.length);
    });
    child.once("error", (error) => finish(reject, new Error(`Media process could not start: ${error.message}`)));
    child.once("close", (code) => {
      if (code === 0) finish(resolve);
      else finish(reject, new Error(`Media process failed with exit code ${code}: ${stderr.slice(0, 1024)}`));
    });
  });
}

function requireMattingService(service) {
  if (!service || typeof service.createMatteAndMetrics !== "function" || typeof service.inspectProcessedAction !== "function") {
    throw new Error("A local matting and final-output inspection service is required");
  }
  return service;
}

function requireTrustedProbe(probeAsset) {
  if (typeof probeAsset !== "function") throw new Error("A trusted local media probe is required");
  return probeAsset;
}

function requireRegularWorkerFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Worker matte must be a regular local file");
  }
  return filePath;
}

/**
 * Media-worker orchestration. The injected matting service is a local worker
 * responsibility (no second image/video-generation provider); it must return
 * sampled segmentation metrics and a grayscale matte. Any unknown inspection
 * causes QA to fail, which lets the workflow regenerate the single action.
 */
class MediaWorker {
  constructor({
    mattingService,
    probeAsset,
    runPlan = runProcess,
    verifyLocalFile = requireRegularWorkerFile,
    logger = console
  } = {}) {
    this.mattingService = requireMattingService(mattingService);
    this.probeAsset = requireTrustedProbe(probeAsset);
    if (typeof runPlan !== "function") throw new Error("A media plan runner is required");
    if (typeof verifyLocalFile !== "function") throw new Error("A worker-local file verifier is required");
    this.runPlan = runPlan;
    this.verifyLocalFile = verifyLocalFile;
    this.logger = logger;
  }

  async processAction({
    actionId,
    inputPath,
    outputPath,
    mattePath,
    firstMasterPath,
    lastMasterPath,
    scratchDirectory,
    correction,
    expectedFirstMasterHash,
    expectedLastMasterHash,
    requestedDuration,
    referenceMetrics,
    qaPolicy,
    production = false
  } = {}) {
    const inputProbeResult = await this.probeAsset({ localPath: inputPath, actionId, mediaRole: "provider-source" });
    const inputProbe = inputProbeResult && inputProbeResult.probe ? inputProbeResult.probe : inputProbeResult;
    const inputVideo = getVideoStream(inputProbe);
    const inputDuration = Number(inputVideo?.duration ?? inputProbe?.format?.duration);
    if (!Number.isFinite(inputDuration) || inputDuration <= 0) {
      throw new Error("Provider source video has no trusted positive duration");
    }
    if (!Number.isFinite(Number(requestedDuration)) || Number(requestedDuration) <= 0 ||
        Math.abs(inputDuration - Number(requestedDuration)) > 0.25) {
      throw new Error("Provider source video duration does not match its frozen action request");
    }
    const matte = await this.mattingService.createMatteAndMetrics({
      actionId,
      inputPath,
      firstMasterPath,
      lastMasterPath,
      matteOutputPath: mattePath,
      scratchDirectory,
      expectedFirstMasterHash,
      expectedLastMasterHash,
      referenceMetrics
    });
    if (!matte || typeof matte.mattePath !== "string") {
      throw new Error("Matting service returned no segmentation matte");
    }
    if (mattePath && path.resolve(matte.mattePath) !== path.resolve(mattePath)) {
      throw new Error("Matting service wrote outside its assigned matte path");
    }
    this.verifyLocalFile(matte.mattePath);
    const plan = createVideoNormalizationPlan({
      inputPath,
      mattePath: matte.mattePath,
      outputPath,
      correction: correction || matte.correction
    });
    await this.runPlan(plan);
    const [probeResult, inspection] = await Promise.all([
      this.probeAsset({ localPath: outputPath, actionId, mediaRole: "processed-action" }),
      this.mattingService.inspectProcessedAction({
        actionId,
        outputPath,
        firstMasterPath,
        lastMasterPath,
        scratchDirectory,
        expectedFirstMasterHash,
        expectedLastMasterHash,
        referenceMetrics
      })
    ]);
    if (!inspection || !Array.isArray(inspection.sampledFrames) || !inspection.firstFrame || !inspection.lastFrame) {
      throw new Error("Final action inspection returned incomplete media QA inputs");
    }
    const mediaProbe = probeResult && probeResult.probe ? probeResult.probe : probeResult;
    const outputVideo = getVideoStream(mediaProbe);
    const outputDuration = Number(outputVideo?.duration ?? mediaProbe?.format?.duration);
    const outputFps = parseFrameRate(outputVideo?.avg_frame_rate || outputVideo?.r_frame_rate);
    const declaredFrameCount = Number(outputVideo?.nb_frames);
    const expectedFrameCount = Number.isSafeInteger(declaredFrameCount) && declaredFrameCount > 0
      ? declaredFrameCount
      : Math.round(outputDuration * outputFps);
    if (!Number.isSafeInteger(expectedFrameCount) || expectedFrameCount < 1 || inspection.sampledFrames.length !== expectedFrameCount) {
      throw new Error("Final action inspection must cover every normalized video frame");
    }
    const qa = validateVideoAction({
      actionId,
      mediaProbe,
      sampledFrames: inspection.sampledFrames,
      firstFrame: inspection.firstFrame,
      lastFrame: inspection.lastFrame,
      expectedFirstMasterHash,
      expectedLastMasterHash,
      referenceMetrics,
      contentInspection: inspection.contentInspection,
      expectedDuration: inputDuration,
      policy: qaPolicy,
      production
    });
    this.logger.info?.("petpack.media.action_processed", { actionId, ok: qa.ok });
    if (!qa.ok) {
      const error = new Error(`Action media QA failed: ${qa.errors.join("; ")}`);
      error.qa = qa;
      throw error;
    }
    return { plan, probeResult, qa, matteMode: plan.mediaProfile.matteMode };
  }
}

module.exports = {
  MediaWorker,
  requireRegularWorkerFile,
  runProcess
};
