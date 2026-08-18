const {
  CHARACTER_CANVAS_V1,
  requireQaPolicy,
  validateCanvasFrame
} = require("./character-canvas-v1");
const { validateMasterAppearanceInspection } = require("./appearance-lock-v1");
const { validateChromaSubjectInspection } = require("./chroma-subject-integrity");
const { validateProductionEvidenceReport } = require("./production-evidence-provenance");

const MASTER_IMAGE_QA_CONTRACT_VERSION = "petpack-master-image-qa/v2";
const REQUIRED_CONTENT_ASSERTIONS = Object.freeze([
  "exactlyOnePet",
  "fullBodyVisible",
  "noText",
  "noWatermark",
  "noProps",
  "noPersons",
  "noOtherAnimals",
  "plainRemovableBackground"
]);

function requireKind(value) {
  if (!["front", "side", "sleep"].includes(value)) {
    throw new Error("Master image kind must be front, side, or sleep");
  }
  return value;
}

function finiteMetric(value, label) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function normalizeReferenceMetrics(frame) {
  const visible = frame && frame.visibleBounds;
  if (!visible || typeof visible !== "object") {
    throw new Error("Master image visible bounds are required");
  }
  return {
    groundBaselineY: finiteMetric(frame.groundBaselineY, "Master ground baseline"),
    torsoHeightPx: finiteMetric(frame.torsoHeightPx, "Master torso height"),
    headHeightPx: finiteMetric(frame.headHeightPx, "Master head height"),
    shoulderWidthPx: finiteMetric(frame.shoulderWidthPx, "Master shoulder width"),
    centerX: (finiteMetric(visible.left, "Master visible left") + finiteMetric(visible.right, "Master visible right")) / 2
  };
}

function validateContentInspection(contentInspection, { kind } = {}) {
  const errors = [];
  if (!contentInspection || typeof contentInspection !== "object" || Array.isArray(contentInspection)) {
    return { ok: false, errors: ["Master image content inspection is required"] };
  }
  for (const key of REQUIRED_CONTENT_ASSERTIONS) {
    if (contentInspection[key] !== true) {
      errors.push(`Master image content assertion failed: ${key}`);
    }
  }
  if (!["transparent", "pure_green"].includes(contentInspection.backgroundMode)) {
    errors.push("Master image background must be transparent or pure green");
  }
  if (contentInspection.pose !== kind) {
    errors.push(`Master image pose must be ${kind}`);
  }
  return { ok: errors.length === 0, errors };
}

function validateMasterImage({
  kind,
  frame,
  contentInspection,
  appearanceInspection,
  provenance,
  referenceMetrics,
  sourceReferenceCount,
  policy,
  production = false
} = {}) {
  const normalizedKind = requireKind(kind);
  const resolvedPolicy = requireQaPolicy(policy, { production });
  const errors = [];
  const referenceCount = Number(sourceReferenceCount);
  const validReferenceCount = normalizedKind === "front"
    ? referenceCount >= 3 && referenceCount <= 4
    : normalizedKind === "side"
      ? referenceCount >= 4 && referenceCount <= 5
      : referenceCount === 2;
  if (!validReferenceCount) {
    errors.push(`${normalizedKind} master has an invalid identity reference count`);
  }
  const canvas = validateCanvasFrame(frame, {
    canvas: CHARACTER_CANVAS_V1,
    policy: resolvedPolicy,
    production,
    expectedIdentityScore: resolvedPolicy.minIdentityScore,
    referenceMetrics: normalizedKind === "front" ? undefined : referenceMetrics
  });
  if (!canvas.ok) errors.push(...canvas.errors);
  const content = validateContentInspection(contentInspection, { kind: normalizedKind });
  if (!content.ok) errors.push(...content.errors);
  const chromaIntegrity = validateChromaSubjectInspection(contentInspection?.chromaIntegrity, {
    production,
    expectedFrameCount: 1
  });
  if (!chromaIntegrity.ok) errors.push(...chromaIntegrity.errors);
  const productionEvidence = validateProductionEvidenceReport({
    kind: normalizedKind,
    provenance
  }, { production });
  if (!productionEvidence.ok) errors.push(...productionEvidence.errors);
  const appearance = validateMasterAppearanceInspection(appearanceInspection, {
    kind: normalizedKind,
    sourceReferenceCount: Number(sourceReferenceCount),
    policy: resolvedPolicy
  });
  if (!appearance.ok) errors.push(...appearance.errors);

  let immutableReferenceMetrics = null;
  try {
    immutableReferenceMetrics = normalizedKind === "front"
      ? normalizeReferenceMetrics(frame)
      : {
          groundBaselineY: finiteMetric(referenceMetrics?.groundBaselineY, "Front reference ground baseline"),
          torsoHeightPx: finiteMetric(referenceMetrics?.torsoHeightPx, "Front reference torso height"),
          headHeightPx: finiteMetric(referenceMetrics?.headHeightPx, "Front reference head height"),
          shoulderWidthPx: finiteMetric(referenceMetrics?.shoulderWidthPx, "Front reference shoulder width"),
          centerX: finiteMetric(referenceMetrics?.centerX, "Front reference center")
        };
  } catch (error) {
    errors.push(error.message);
  }

  return {
    ok: errors.length === 0,
    errors,
    contractVersion: MASTER_IMAGE_QA_CONTRACT_VERSION,
    canvasId: CHARACTER_CANVAS_V1.id,
    kind: normalizedKind,
    policyVersion: resolvedPolicy.version,
    sourceReferenceCount: Number(sourceReferenceCount),
    frame: frame && typeof frame === "object" ? JSON.parse(JSON.stringify(frame)) : null,
    contentInspection: contentInspection && typeof contentInspection === "object"
      ? JSON.parse(JSON.stringify(contentInspection))
      : null,
    chromaIntegrity: chromaIntegrity.evidence,
    provenance: productionEvidence.evidence,
    appearance: appearance.evidence,
    referenceMetrics: immutableReferenceMetrics
  };
}

module.exports = {
  MASTER_IMAGE_QA_CONTRACT_VERSION,
  REQUIRED_CONTENT_ASSERTIONS,
  normalizeReferenceMetrics,
  validateContentInspection,
  validateMasterImage
};
