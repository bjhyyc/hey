// Retained only so frozen historical revisions remain interpretable. New
// production runs must bind to CHARACTER_CANVAS_V1 below and are never
// silently upscaled from a 480p provider output to this legacy canvas.
const LEGACY_CHARACTER_CANVAS_V1 = Object.freeze({
  id: "character_canvas_v1",
  width: 1280,
  height: 720,
  aspectRatio: "16:9",
  fps: 24,
  safeFrame: Object.freeze({ left: 160, top: 54, right: 1120, bottom: 680 }),
  groundBaselineY: 620,
  targetTorsoHeightPx: 300,
  targetHeadHeightPx: 165,
  targetShoulderWidthPx: 250,
  minimumVisibleMarginsPx: Object.freeze({ left: 48, top: 36, right: 48, bottom: 24 }),
  intermediateBackground: "#00FF00",
  finalAlphaPreferred: true
});

const CHARACTER_CANVAS_V1 = Object.freeze({
  id: "character_canvas_480p_v1",
  width: 854,
  height: 480,
  aspectRatio: "16:9",
  fps: 24,
  safeFrame: Object.freeze({ left: 107, top: 36, right: 747, bottom: 453 }),
  groundBaselineY: 413,
  targetTorsoHeightPx: 200,
  targetHeadHeightPx: 110,
  targetShoulderWidthPx: 167,
  minimumVisibleMarginsPx: Object.freeze({ left: 32, top: 24, right: 32, bottom: 16 }),
  intermediateBackground: "#00FF00",
  finalAlphaPreferred: true
});

function createDevelopmentQaPolicy() {
  return {
    // Development-only values let pipeline wiring be tested. Production must
    // supply a signed/configured policy approved through the QA blocker.
    name: "development-only",
    version: "development-only",
    signature: "development-only",
    maxGroundBaselineDeltaPx: 6,
    maxRelativeTorsoDelta: 0.04,
    maxRelativeHeadDelta: 0.05,
    maxRelativeShoulderDelta: 0.05,
    maxHorizontalOffsetPx: 32,
    maxGroundJitterPx: 4,
    maxRelativeFrameScaleJitter: 0.025,
    minIdentityScore: 0.85,
    minSevereVideoIdentityScore: 0.7,
    maxSevereVideoIdentityFrameRatio: 0.02,
    minFaceIdentityScore: 0.9,
    minCoatColorScore: 0.9,
    minMarkingTopologyScore: 0.9,
    maxLoopSeamPixelDelta: 0.015,
    maxLoopBoundaryMotion: 0.02,
    minLoopRestFrameCount: 12
  };
}

function requireQaPolicy(policy, { production = false } = {}) {
  if (!policy) {
    if (production) {
      throw new Error("Production character QA policy must be configured");
    }
    return createDevelopmentQaPolicy();
  }
  const required = [
    "maxGroundBaselineDeltaPx",
    "maxRelativeTorsoDelta",
    "maxRelativeHeadDelta",
    "maxRelativeShoulderDelta",
    "maxHorizontalOffsetPx",
    "maxGroundJitterPx",
    "maxRelativeFrameScaleJitter",
    "minIdentityScore",
    "minSevereVideoIdentityScore",
    "maxSevereVideoIdentityFrameRatio",
    "minFaceIdentityScore",
    "minCoatColorScore",
    "minMarkingTopologyScore",
    "maxLoopSeamPixelDelta",
    "maxLoopBoundaryMotion",
    "minLoopRestFrameCount"
  ];
  const missing = required.filter((key) => !Number.isFinite(Number(policy[key])));
  if (missing.length > 0) {
    throw new Error(`Character QA policy is incomplete: ${missing.join(", ")}`);
  }
  const invalidRanges = [
    ["maxGroundBaselineDeltaPx", 0, 100],
    ["maxRelativeTorsoDelta", 0, 1],
    ["maxRelativeHeadDelta", 0, 1],
    ["maxRelativeShoulderDelta", 0, 1],
    ["maxHorizontalOffsetPx", 0, 200],
    ["maxGroundJitterPx", 0, 100],
    // Pose-morph actions can more than double their projected height between
    // their first frame and the motion apex, so per-action merged policies may
    // declare a full-morph range beyond 1.
    ["maxRelativeFrameScaleJitter", 0, 2],
    ["minIdentityScore", 0, 1],
    ["minSevereVideoIdentityScore", 0, 1],
    ["maxSevereVideoIdentityFrameRatio", 0, 1],
    ["minFaceIdentityScore", 0, 1],
    ["minCoatColorScore", 0, 1],
    ["minMarkingTopologyScore", 0, 1],
    ["maxLoopSeamPixelDelta", 0, 1],
    ["maxLoopBoundaryMotion", 0, 1],
    ["minLoopRestFrameCount", 1, CHARACTER_CANVAS_V1.fps * 2]
  ].filter(([key, min, max]) => Number(policy[key]) < min || Number(policy[key]) > max)
    .map(([key]) => key);
  if (invalidRanges.length > 0) {
    throw new Error(`Character QA policy has invalid ranges: ${invalidRanges.join(", ")}`);
  }
  if (!Number.isSafeInteger(Number(policy.minLoopRestFrameCount))) {
    throw new Error("Character QA policy minLoopRestFrameCount must be an integer");
  }
  for (const [key, min, max] of [["minimumVisibleMarginPx", 0, 100], ["safeFrameInsetPx", 0, 200]]) {
    if (policy[key] !== undefined &&
        (!Number.isFinite(Number(policy[key])) || Number(policy[key]) < min || Number(policy[key]) > max)) {
      throw new Error(`Character QA policy ${key} is outside its allowed range`);
    }
  }
  if (production && (
    policy.name === "development-only" ||
    typeof policy.version !== "string" || !policy.version ||
    typeof policy.signature !== "string" || !policy.signature
  )) {
    throw new Error("Production character QA policy must be approved and signed");
  }
  return policy;
}

function relativeDelta(actual, target) {
  if (!Number.isFinite(Number(actual)) || !Number.isFinite(Number(target)) || Number(target) === 0) return Infinity;
  return Math.abs(Number(actual) - Number(target)) / Math.abs(Number(target));
}

function validateCanvasFrame(frame, {
  canvas = CHARACTER_CANVAS_V1,
  policy,
  production = false,
  expectedIdentityScore,
  identityThreshold,
  referenceMetrics
} = {}) {
  const resolvedPolicy = requireQaPolicy(policy, { production });
  const errors = [];
  if (!frame || typeof frame !== "object") {
    return { ok: false, errors: ["Frame metrics are required"] };
  }
  if (frame.width !== canvas.width || frame.height !== canvas.height) {
    errors.push(`Frame must be ${canvas.width}x${canvas.height}`);
  }
  const visible = frame.visibleBounds || {};
  // Composition margins are calibration data: a reviewed policy may override
  // the conservative canvas defaults after a batch's framing is approved
  // (larger subjects give the client more effective resolution). Actual
  // border clipping stays independently guarded by the chroma
  // transparent-border gate.
  const marginOverride = Number(resolvedPolicy.minimumVisibleMarginPx);
  const margins = Number.isFinite(marginOverride)
    ? { left: marginOverride, top: marginOverride, right: marginOverride, bottom: marginOverride }
    : canvas.minimumVisibleMarginsPx;
  const safeInsetOverride = Number(resolvedPolicy.safeFrameInsetPx);
  const safeFrame = Number.isFinite(safeInsetOverride)
    ? {
        left: safeInsetOverride,
        top: safeInsetOverride,
        right: canvas.width - safeInsetOverride,
        bottom: canvas.height - safeInsetOverride
      }
    : canvas.safeFrame;
  if (
    !Number.isFinite(Number(visible.left)) || !Number.isFinite(Number(visible.top)) ||
    !Number.isFinite(Number(visible.right)) || !Number.isFinite(Number(visible.bottom))
  ) {
    errors.push("Visible pet bounds are required");
  } else {
    if (visible.left < 0 || visible.top < 0 || visible.right > canvas.width || visible.bottom > canvas.height) {
      errors.push("Pet bounds must be inside the canvas");
    }
    if (visible.left >= visible.right || visible.top >= visible.bottom) {
      errors.push("Pet bounds must have positive width and height");
    }
    if (visible.left < margins.left) errors.push("Pet exceeds left safety margin");
    if (visible.top < margins.top) errors.push("Pet exceeds top safety margin");
    if (visible.right > canvas.width - margins.right) errors.push("Pet exceeds right safety margin");
    if (visible.bottom > canvas.height - margins.bottom) errors.push("Pet exceeds bottom safety margin");
    if (
      visible.left < safeFrame.left ||
      visible.top < safeFrame.top ||
      visible.right > safeFrame.right ||
      visible.bottom > safeFrame.bottom
    ) {
      errors.push("Pet exceeds the character canvas safe frame");
    }
  }
  const reference = referenceMetrics && typeof referenceMetrics === "object" ? referenceMetrics : {};
  const groundBaselineY = Number.isFinite(Number(reference.groundBaselineY))
    ? Number(reference.groundBaselineY)
    : canvas.groundBaselineY;
  const torsoHeightPx = Number.isFinite(Number(reference.torsoHeightPx))
    ? Number(reference.torsoHeightPx)
    : canvas.targetTorsoHeightPx;
  const headHeightPx = Number.isFinite(Number(reference.headHeightPx))
    ? Number(reference.headHeightPx)
    : canvas.targetHeadHeightPx;
  const shoulderWidthPx = Number.isFinite(Number(reference.shoulderWidthPx))
    ? Number(reference.shoulderWidthPx)
    : canvas.targetShoulderWidthPx;
  if (Math.abs(Number(frame.groundBaselineY) - groundBaselineY) > resolvedPolicy.maxGroundBaselineDeltaPx) {
    errors.push("Ground baseline is outside configured tolerance");
  }
  if (relativeDelta(frame.torsoHeightPx, torsoHeightPx) > resolvedPolicy.maxRelativeTorsoDelta) {
    errors.push("Torso scale is outside configured tolerance");
  }
  if (relativeDelta(frame.headHeightPx, headHeightPx) > resolvedPolicy.maxRelativeHeadDelta) {
    errors.push("Head scale is outside configured tolerance");
  }
  if (relativeDelta(frame.shoulderWidthPx, shoulderWidthPx) > resolvedPolicy.maxRelativeShoulderDelta) {
    errors.push("Shoulder scale is outside configured tolerance");
  }
  const expectedCenterX = Number.isFinite(Number(reference.centerX)) ? Number(reference.centerX) : canvas.width / 2;
  if (Number.isFinite(Number(visible.left)) && Number.isFinite(Number(visible.right))) {
    const centerX = (Number(visible.left) + Number(visible.right)) / 2;
    if (Math.abs(centerX - expectedCenterX) > resolvedPolicy.maxHorizontalOffsetPx) {
      errors.push("Pet horizontal position is outside configured tolerance");
    }
  }
  const requiredIdentityScore = Number.isFinite(Number(identityThreshold))
    ? Number(identityThreshold)
    : resolvedPolicy.minIdentityScore;
  if (expectedIdentityScore !== undefined && (!Number.isFinite(Number(frame.identityScore)) || Number(frame.identityScore) < requiredIdentityScore)) {
    errors.push("Character identity is below configured threshold");
  }
  return { ok: errors.length === 0, errors, policyName: resolvedPolicy.name || "configured" };
}

function validateActionEndpoints({ firstFrame, lastFrame, expectedFirstMasterHash, expectedLastMasterHash }) {
  const errors = [];
  if (!firstFrame || !lastFrame) {
    return { ok: false, errors: ["First and last frame audits are required"] };
  }
  if (expectedFirstMasterHash && firstFrame.masterHash !== expectedFirstMasterHash) {
    errors.push("First frame does not match the required master revision");
  }
  if (expectedLastMasterHash && lastFrame.masterHash !== expectedLastMasterHash) {
    errors.push("Last frame does not match the required master revision");
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  CHARACTER_CANVAS_V1,
  LEGACY_CHARACTER_CANVAS_V1,
  createDevelopmentQaPolicy,
  requireQaPolicy,
  validateActionEndpoints,
  validateCanvasFrame
};
