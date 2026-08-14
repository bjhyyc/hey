const SLEEP_LOOP_BOUNDARY_CONTRACT_VERSION = "petpack-sleep-loop-boundary/v1";

function cloneEvidence(value) {
  return value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : null;
}

function finiteNonNegative(value, label, errors) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    errors.push(`${label} must be a non-negative number`);
    return NaN;
  }
  return normalized;
}

function integer(value, label, errors, { min = 0 } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min) {
    errors.push(`${label} must be an integer of at least ${min}`);
    return NaN;
  }
  return normalized;
}

function requireTrue(value, label, errors) {
  if (value !== true) errors.push(`${label} must be true`);
}

/**
 * A seamless breathing loop must start and end at the same end-exhale rest
 * pose. Pixel similarity alone is insufficient: motion must also decay to zero
 * before the last frame, otherwise the next iteration creates an acceleration
 * spike even when the endpoint images look alike.
 */
function validateSleepLoopBoundaryInspection(inspection, { sampledFrameCount, policy } = {}) {
  const errors = [];
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    return { ok: false, errors: ["Sleep-loop boundary inspection is required"], evidence: null };
  }
  if (inspection.contractVersion !== SLEEP_LOOP_BOUNDARY_CONTRACT_VERSION) {
    errors.push(`Sleep-loop boundary contractVersion must be ${SLEEP_LOOP_BOUNDARY_CONTRACT_VERSION}`);
  }
  requireTrue(inspection.startsAtEndExhaleRest, "Sleep-loop startsAtEndExhaleRest", errors);
  requireTrue(inspection.endsAtEndExhaleRest, "Sleep-loop endsAtEndExhaleRest", errors);
  requireTrue(inspection.completeBreathCycle, "Sleep-loop completeBreathCycle", errors);
  if (inspection.nextInhaleStarted !== false) {
    errors.push("Sleep-loop nextInhaleStarted must be false");
  }
  if (integer(inspection.completedBreathCycles, "Sleep-loop completedBreathCycles", errors, { min: 1 }) !== 1) {
    errors.push("Sleep-loop must contain exactly one completed breath cycle");
  }
  const declaredSamples = integer(inspection.sampledFrameCount, "Sleep-loop sampledFrameCount", errors, { min: 1 });
  if (Number.isFinite(declaredSamples) && declaredSamples !== Number(sampledFrameCount)) {
    errors.push("Sleep-loop boundary inspection must cover every normalized frame");
  }
  const firstRestFrames = integer(inspection.firstRestFrameCount, "Sleep-loop firstRestFrameCount", errors, { min: 1 });
  const lastRestFrames = integer(inspection.lastRestFrameCount, "Sleep-loop lastRestFrameCount", errors, { min: 1 });
  if (Number.isFinite(firstRestFrames) && firstRestFrames < Number(policy.minLoopRestFrameCount)) {
    errors.push("Sleep-loop opening rest is shorter than the configured threshold");
  }
  if (Number.isFinite(lastRestFrames) && lastRestFrames < Number(policy.minLoopRestFrameCount)) {
    errors.push("Sleep-loop closing rest is shorter than the configured threshold");
  }
  const seamPixelDelta = finiteNonNegative(inspection.seamPixelDelta, "Sleep-loop seamPixelDelta", errors);
  const seamMotionDelta = finiteNonNegative(inspection.seamMotionDelta, "Sleep-loop seamMotionDelta", errors);
  const terminalMotion = finiteNonNegative(inspection.terminalMotion, "Sleep-loop terminalMotion", errors);
  if (Number.isFinite(seamPixelDelta) && seamPixelDelta > Number(policy.maxLoopSeamPixelDelta)) {
    errors.push("Sleep-loop endpoint pixel delta exceeds the configured threshold");
  }
  if (Number.isFinite(seamMotionDelta) && seamMotionDelta > Number(policy.maxLoopBoundaryMotion)) {
    errors.push("Sleep-loop boundary motion delta exceeds the configured threshold");
  }
  if (Number.isFinite(terminalMotion) && terminalMotion > Number(policy.maxLoopBoundaryMotion)) {
    errors.push("Sleep-loop terminal motion has not settled to rest");
  }
  return { ok: errors.length === 0, errors, evidence: cloneEvidence(inspection) };
}

module.exports = {
  SLEEP_LOOP_BOUNDARY_CONTRACT_VERSION,
  validateSleepLoopBoundaryInspection
};
