const CHARACTER_CANVAS_V1 = Object.freeze({
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
    minIdentityScore: 0.85
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
    "minIdentityScore"
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
    ["maxRelativeFrameScaleJitter", 0, 1],
    ["minIdentityScore", 0, 1]
  ].filter(([key, min, max]) => Number(policy[key]) < min || Number(policy[key]) > max)
    .map(([key]) => key);
  if (invalidRanges.length > 0) {
    throw new Error(`Character QA policy has invalid ranges: ${invalidRanges.join(", ")}`);
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
    if (visible.left < canvas.minimumVisibleMarginsPx.left) errors.push("Pet exceeds left safety margin");
    if (visible.top < canvas.minimumVisibleMarginsPx.top) errors.push("Pet exceeds top safety margin");
    if (visible.right > canvas.width - canvas.minimumVisibleMarginsPx.right) errors.push("Pet exceeds right safety margin");
    if (visible.bottom > canvas.height - canvas.minimumVisibleMarginsPx.bottom) errors.push("Pet exceeds bottom safety margin");
    if (
      visible.left < canvas.safeFrame.left ||
      visible.top < canvas.safeFrame.top ||
      visible.right > canvas.safeFrame.right ||
      visible.bottom > canvas.safeFrame.bottom
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
  if (expectedIdentityScore !== undefined && (!Number.isFinite(Number(frame.identityScore)) || Number(frame.identityScore) < resolvedPolicy.minIdentityScore)) {
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
  createDevelopmentQaPolicy,
  requireQaPolicy,
  validateActionEndpoints,
  validateCanvasFrame
};
