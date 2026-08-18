const { ACTION_ENDPOINTS, assertActionId } = require("../domain/action-catalog");
const {
  CHARACTER_CANVAS_V1,
  requireQaPolicy,
  validateActionEndpoints,
  validateCanvasFrame
} = require("./character-canvas-v1");
const { validateVideoAppearanceInspection } = require("./appearance-lock-v1");
const { validateActionMediaProbe } = require("./media-inspector");
const { validateDecodedEndpointInspection } = require("./frame-continuity-metrics");
const { validateSleepLoopBoundaryInspection } = require("./sleep-loop-boundary-v1");
const { validateChromaSubjectInspection } = require("./chroma-subject-integrity");
const { validateProductionEvidenceReport } = require("./production-evidence-provenance");

const ACTION_QA_CONTRACT_VERSION = "petpack-action-qa/v3";

const REQUIRED_CONTENT_CHECKS = Object.freeze([
  "cameraFixed",
  "noText",
  "noProps",
  "noPeople",
  "noOtherAnimals",
  "petFullyVisible",
  "speciesConsistent",
  "primaryCoatColorConsistent",
  "noSevereIdentityDrift",
  "noDeformation",
  "matteComplete",
  "matteEdgesStable",
  "greenBackgroundUniform",
  "noGreenSpill"
]);

function appendErrors(target, prefix, result) {
  if (!result || result.ok) return;
  for (const error of result.errors || ["failed"]) target.push(`${prefix}: ${error}`);
}

function getFrameCenterX(frame) {
  const bounds = frame && frame.visibleBounds;
  if (!bounds) return NaN;
  return (Number(bounds.left) + Number(bounds.right)) / 2;
}

function resolveActionMotionPolicy(policy, actionId, { production = false } = {}) {
  const envelope = policy?.actionMotionEnvelopes?.[actionId];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return {
      ok: !production,
      errors: production ? ["Production action motion envelope is required"] : [],
      policy,
      chromaThresholds: undefined,
      evidence: null
    };
  }
  const specifications = {
    maxGroundDeltaPx: [0, 100],
    maxCanvasScaleDelta: [0, 1],
    // A pose-morph action (curled sleep to a standing stretch apex) can more
    // than double its projected height relative to its first frame, so the
    // per-action envelope may declare a full-morph range beyond 1.
    maxRelativeScaleJitter: [0, 2],
    minAdjacentMaskIoU: [0, 1],
    maxRowSpanHoleRatio: [0, 1]
  };
  const normalized = {};
  const errors = [];
  for (const [key, [minimum, maximum]] of Object.entries(specifications)) {
    const value = Number(envelope[key]);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      errors.push(`Action motion envelope ${key} is invalid`);
    } else {
      normalized[key] = value;
    }
  }
  // Optional per-action composition margin: motion extremes (a roll flip, a
  // stretch apex) legitimately approach the canvas edges further than static
  // poses; each action's calibrated allowance overrides the policy globals for
  // both the visible-margin and safe-frame checks.
  if (envelope.minEdgeMarginPx !== undefined) {
    const margin = Number(envelope.minEdgeMarginPx);
    if (!Number.isFinite(margin) || margin < 0 || margin > 200) {
      errors.push("Action motion envelope minEdgeMarginPx is invalid");
    } else {
      normalized.minEdgeMarginPx = margin;
    }
  }
  // Optional per-action horizontal excursion: a roll displaces the subject
  // sideways mid-action by design and returns to its start; the calibrated
  // per-action bound replaces the static-pose global for those frames.
  if (envelope.maxHorizontalOffsetPx !== undefined) {
    const excursion = Number(envelope.maxHorizontalOffsetPx);
    if (!Number.isFinite(excursion) || excursion < 0 || excursion > 200) {
      errors.push("Action motion envelope maxHorizontalOffsetPx is invalid");
    } else {
      normalized.maxHorizontalOffsetPx = excursion;
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    policy: errors.length === 0 ? {
      ...policy,
      maxGroundBaselineDeltaPx: normalized.maxGroundDeltaPx,
      maxGroundJitterPx: normalized.maxGroundDeltaPx,
      maxRelativeTorsoDelta: normalized.maxCanvasScaleDelta,
      maxRelativeHeadDelta: normalized.maxCanvasScaleDelta,
      maxRelativeShoulderDelta: normalized.maxCanvasScaleDelta,
      maxRelativeFrameScaleJitter: normalized.maxRelativeScaleJitter,
      ...(normalized.minEdgeMarginPx !== undefined
        ? {
            minimumVisibleMarginPx: normalized.minEdgeMarginPx,
            safeFrameInsetPx: normalized.minEdgeMarginPx
          }
        : {}),
      ...(normalized.maxHorizontalOffsetPx !== undefined
        ? { maxHorizontalOffsetPx: normalized.maxHorizontalOffsetPx }
        : {})
    } : policy,
    chromaThresholds: errors.length === 0
      ? { maximumRowSpanHoleRatio: normalized.maxRowSpanHoleRatio }
      : undefined,
    evidence: errors.length === 0 ? { ...normalized } : null
  };
}

function calculateContinuity(sampledFrames, policy) {
  if (!Array.isArray(sampledFrames) || sampledFrames.length === 0) {
    return { ok: false, errors: ["At least one sampled frame metric is required"] };
  }
  const baseline = sampledFrames[0];
  const baselineCenterX = getFrameCenterX(baseline);
  const baselineGroundY = Number(baseline.groundBaselineY);
  const baselineTorso = Number(baseline.torsoHeightPx);
  const errors = [];
  for (const [index, frame] of sampledFrames.entries()) {
    const centerX = getFrameCenterX(frame);
    const groundY = Number(frame.groundBaselineY);
    const torso = Number(frame.torsoHeightPx);
    if (!Number.isFinite(centerX) || !Number.isFinite(groundY) || !Number.isFinite(torso)) {
      errors.push(`sampledFrames[${index}] continuity metrics are incomplete`);
      continue;
    }
    if (Math.abs(centerX - baselineCenterX) > policy.maxHorizontalOffsetPx) {
      errors.push(`sampledFrames[${index}] horizontal drift exceeds tolerance`);
    }
    if (Math.abs(groundY - baselineGroundY) > policy.maxGroundJitterPx) {
      errors.push(`sampledFrames[${index}] ground jitter exceeds tolerance`);
    }
    if (Math.abs(torso - baselineTorso) / Math.max(1, baselineTorso) > policy.maxRelativeFrameScaleJitter) {
      errors.push(`sampledFrames[${index}] torso scale jitter exceeds tolerance`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function frameEvidence(frame) {
  const visible = frame && frame.visibleBounds || {};
  return {
    width: Number(frame?.width),
    height: Number(frame?.height),
    visibleBounds: {
      left: Number(visible.left),
      top: Number(visible.top),
      right: Number(visible.right),
      bottom: Number(visible.bottom)
    },
    groundBaselineY: Number(frame?.groundBaselineY),
    torsoHeightPx: Number(frame?.torsoHeightPx),
    headHeightPx: Number(frame?.headHeightPx),
    shoulderWidthPx: Number(frame?.shoulderWidthPx),
    identityScore: Number(frame?.identityScore)
  };
}

function validateContentInspection(inspection, actionId) {
  const errors = [];
  if (!inspection || typeof inspection !== "object") {
    return { ok: false, errors: ["Content inspection is required"] };
  }
  for (const field of REQUIRED_CONTENT_CHECKS) {
    if (inspection[field] !== true) errors.push(`Content check failed: ${field}`);
  }
  if (actionId === "sleep-loop" && inspection.loopSeamAcceptable !== true) {
    errors.push("Content check failed: loopSeamAcceptable");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Combines immutable technical gates. Frame segmentation and content analysis
 * are performed by a worker and supplied as metrics; unknown or omitted checks
 * always fail closed rather than entering a PetPack.
 */
function validateVideoAction({
  actionId,
  mediaProbe,
  sampledFrames,
  firstFrame,
  lastFrame,
  endpointInspection,
  expectedFirstMasterHash,
  expectedLastMasterHash,
  referenceMetrics,
  contentInspection,
  appearanceInspection,
  provenance,
  loopBoundaryInspection,
  expectedDuration,
  policy,
  production = false
} = {}) {
  assertActionId(actionId);
  const resolvedPolicy = requireQaPolicy(policy, { production });
  const errors = [];
  const motion = resolveActionMotionPolicy(resolvedPolicy, actionId, { production });
  appendErrors(errors, "motionPolicy", motion);
  const media = validateActionMediaProbe(mediaProbe, {
    allowedVideoCodecs: ["vp9"],
    allowedFormatNames: ["webm", "matroska"],
    expectedDuration
  });
  appendErrors(errors, "media", media);

  const endpoints = validateActionEndpoints({
    firstFrame,
    lastFrame,
    expectedFirstMasterHash,
    expectedLastMasterHash
  });
  appendErrors(errors, "endpoints", endpoints);
  const decodedEndpoints = validateDecodedEndpointInspection(endpointInspection, {
    production,
    actionId,
    expectedFirstMasterHash,
    expectedLastMasterHash,
    expectedOutputHash: provenance?.outputSha256,
    expectedFrameCount: Array.isArray(sampledFrames) ? sampledFrames.length : null
  });
  appendErrors(errors, "decodedEndpoints", decodedEndpoints);

  const frames = Array.isArray(sampledFrames) ? sampledFrames : [];
  const chromaIntegrity = validateChromaSubjectInspection(contentInspection?.chromaIntegrity, {
    production,
    expectedFrameCount: frames.length,
    thresholds: motion.chromaThresholds
  });
  appendErrors(errors, "chromaIntegrity", chromaIntegrity);
  const productionEvidence = validateProductionEvidenceReport({ actionId, provenance }, { production });
  appendErrors(errors, "productionEvidence", productionEvidence);
  const frameResults = frames.map((frame) => validateCanvasFrame(frame, {
    canvas: CHARACTER_CANVAS_V1,
    policy: motion.policy,
    production,
    expectedIdentityScore: true,
    identityThreshold: resolvedPolicy.minSevereVideoIdentityScore,
    referenceMetrics
  }));
  if (frameResults.length === 0) errors.push("canvas: sampled frame metrics are required");
  frameResults.forEach((result, index) => appendErrors(errors, `canvas frame ${index}`, result));

  const continuity = calculateContinuity(frames, motion.policy);
  appendErrors(errors, "continuity", continuity);
  const content = validateContentInspection(contentInspection, actionId);
  appendErrors(errors, "content", content);
  const appearance = validateVideoAppearanceInspection(appearanceInspection, {
    sampledFrameCount: frames.length,
    policy: resolvedPolicy
  });
  appendErrors(errors, "appearance", appearance);
  const loopBoundary = actionId === "sleep-loop"
    ? validateSleepLoopBoundaryInspection(loopBoundaryInspection, {
      sampledFrameCount: frames.length,
      policy: resolvedPolicy
    })
    : { ok: true, errors: [], evidence: null };
  appendErrors(errors, "loopBoundary", loopBoundary);
  const canvas = {
    ok: frameResults.length > 0 && frameResults.every((result) => result.ok),
    errors: frameResults.flatMap((result) => result.errors || [])
  };

  const expectedEndpoints = ACTION_ENDPOINTS[actionId];
  const contentEvidence = Object.fromEntries(
    REQUIRED_CONTENT_CHECKS.map((field) => [field, contentInspection?.[field] === true])
  );
  if (actionId === "sleep-loop") {
    contentEvidence.loopSeamAcceptable = contentInspection?.loopSeamAcceptable === true;
  }
  return {
    actionId,
    contractVersion: ACTION_QA_CONTRACT_VERSION,
    expectedEndpoints: { ...expectedEndpoints },
    ok: errors.length === 0,
    errors,
    media,
    endpoints,
    decodedEndpoints,
    chromaIntegrity,
    productionEvidence,
    provenance: productionEvidence.evidence,
    canvas,
    continuity,
    content,
    appearance,
    warnings: appearance.warnings || [],
    loopBoundary,
    frameResults,
    evidence: {
      contentInspection: contentEvidence,
      chromaIntegrity: chromaIntegrity.evidence,
      provenance: productionEvidence.evidence,
      appearance: appearance.evidence,
      ...(actionId === "sleep-loop" ? { loopBoundary: loopBoundary.evidence } : {}),
      endpoints: {
        firstMasterHash: String(firstFrame?.masterHash || ""),
        lastMasterHash: String(lastFrame?.masterHash || ""),
        decoded: decodedEndpoints.evidence
      },
      continuity: {
        motionEnvelope: motion.evidence,
        sampledFrameCount: frames.length,
        firstFrame: frames.length > 0 ? frameEvidence(frames[0]) : null,
        lastFrame: frames.length > 0 ? frameEvidence(frames[frames.length - 1]) : null
      }
    }
  };
}

module.exports = {
  ACTION_QA_CONTRACT_VERSION,
  REQUIRED_CONTENT_CHECKS,
  calculateContinuity,
  resolveActionMotionPolicy,
  validateContentInspection,
  validateVideoAction
};
