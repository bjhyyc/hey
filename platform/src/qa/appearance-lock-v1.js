const APPEARANCE_LOCK_CONTRACT_VERSION = "petpack-appearance-lock/v1";
const APPEARANCE_REGIONS = Object.freeze(["head", "torso", "legs", "tail"]);
const REQUIRED_FRONT_MASTER_REGIONS = Object.freeze(["head", "torso", "legs"]);
const REQUIRED_SIDE_MASTER_REGIONS = Object.freeze(["head", "torso", "legs"]);
const REQUIRED_SLEEP_MASTER_REGIONS = Object.freeze(["head", "torso"]);
const REQUIRED_VIDEO_REGIONS = Object.freeze(["head", "torso"]);
/**
 * Left/right marking placement is decided by scoring the candidate's image
 * halves against a reference's halves straight, then mirrored, and rejecting
 * the candidate when the mirrored pairing wins. That comparison only means
 * something when the candidate and the reference show the same aspect of the
 * animal. A front master is bound to front source photos, so a coat the model
 * mirrored is caught. A side or sleeping master is bound to references in a
 * different projection - the approved front master, or standing photos - where
 * one flank fills the silhouette and the two halves no longer map to the same
 * sides of the animal. There the verdict is near arbitrary, and it rejects
 * asymmetrically marked pets (calico cats, tortoiseshells, patchy mixed breeds)
 * systematically rather than occasionally. Enforce it where it is decidable and
 * record it everywhere else; the coat colour, marking topology, face identity
 * and species gates still apply to every kind.
 */
const LEFT_RIGHT_ENFORCED_MASTER_KINDS = Object.freeze(["front"]);

function cloneEvidence(value) {
  return value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : null;
}

function score(value, label, errors) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    errors.push(`${label} must be a score between 0 and 1`);
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

function appearanceThresholds(policy) {
  return {
    face: Number(policy.minFaceIdentityScore),
    color: Number(policy.minCoatColorScore),
    markings: Number(policy.minMarkingTopologyScore)
  };
}

function checkScores({ face, color, markings }, thresholds, prefix, errors, { requireFace = false } = {}) {
  const faceScore = requireFace ? score(face, `${prefix}.faceIdentityScore`, errors) : null;
  const colorScore = score(color, `${prefix}.coatColorScore`, errors);
  const markingScore = score(markings, `${prefix}.markingTopologyScore`, errors);
  if (requireFace && Number.isFinite(faceScore) && faceScore < thresholds.face) {
    errors.push(`${prefix}.faceIdentityScore is below the configured threshold`);
  }
  if (Number.isFinite(colorScore) && colorScore < thresholds.color) {
    errors.push(`${prefix}.coatColorScore is below the configured threshold`);
  }
  if (Number.isFinite(markingScore) && markingScore < thresholds.markings) {
    errors.push(`${prefix}.markingTopologyScore is below the configured threshold`);
  }
}

/**
 * Validates evidence produced by the private master-image inspector. Scores
 * compare visible anatomical regions only; hidden regions must be declared as
 * not visible instead of being hallucinated or silently treated as matches.
 */
function validateMasterAppearanceInspection(inspection, { kind, sourceReferenceCount, policy } = {}) {
  const errors = [];
  const warnings = [];
  const leftRightEnforced = LEFT_RIGHT_ENFORCED_MASTER_KINDS.includes(kind);
  const requireLeftRight = (value, label) => {
    if (value === true) return;
    if (leftRightEnforced) errors.push(`${label} must be true`);
    else warnings.push(`${label} is not decidable against a cross-view reference`);
  };
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    return { ok: false, errors: ["Master appearance inspection is required"], warnings, evidence: null };
  }
  if (inspection.contractVersion !== APPEARANCE_LOCK_CONTRACT_VERSION) {
    errors.push(`Master appearance contractVersion must be ${APPEARANCE_LOCK_CONTRACT_VERSION}`);
  }
  const expectedBinding = {
    front: "source-photos",
    side: "source-photos-and-approved-front-master",
    sleep: "approved-character-masters"
  }[kind];
  if (inspection.referenceBinding !== expectedBinding) {
    errors.push(`Master appearance referenceBinding must be ${expectedBinding}`);
  }
  if (Number(inspection.sourceReferenceCount) !== Number(sourceReferenceCount)) {
    errors.push("Master appearance source reference count is inconsistent");
  }
  requireTrue(inspection.fullReferenceCoverage, "Master appearance fullReferenceCoverage", errors);
  requireTrue(inspection.occlusionAware, "Master appearance occlusionAware", errors);
  requireTrue(inspection.leftRightAware, "Master appearance leftRightAware", errors);
  requireLeftRight(inspection.asymmetryPreserved, "Master appearance asymmetryPreserved");
  requireTrue(inspection.speciesAndBreedConsistent, "Master appearance speciesAndBreedConsistent", errors);
  if (integer(inspection.unresolvedConflictCount, "Master appearance unresolvedConflictCount", errors) !== 0) {
    errors.push("Master appearance has unresolved source-reference conflicts");
  }

  const thresholds = appearanceThresholds(policy);
  const requiredRegions = kind === "front"
    ? REQUIRED_FRONT_MASTER_REGIONS
    : kind === "side"
      ? REQUIRED_SIDE_MASTER_REGIONS
      : REQUIRED_SLEEP_MASTER_REGIONS;
  checkScores({
    face: inspection.faceIdentityScore,
    color: inspection.coatColorScore,
    markings: inspection.markingTopologyScore
  }, thresholds, "Master appearance", errors, { requireFace: true });

  const regions = inspection.regions;
  if (!regions || typeof regions !== "object" || Array.isArray(regions)) {
    errors.push("Master appearance regions are required");
  } else {
    for (const region of APPEARANCE_REGIONS) {
      const evidence = regions[region];
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
        errors.push(`Master appearance region ${region} is required`);
        continue;
      }
      if (requiredRegions.includes(region) && evidence.visible !== true) {
        errors.push(`Master appearance region ${region} must be visible`);
      }
      if (typeof evidence.visible !== "boolean") {
        errors.push(`Master appearance region ${region}.visible must be boolean`);
        continue;
      }
      if (evidence.visible) {
        checkScores({
          face: evidence.faceIdentityScore,
          color: evidence.coatColorScore,
          markings: evidence.markingTopologyScore
        }, thresholds, `Master appearance region ${region}`, errors, { requireFace: region === "head" });
        requireLeftRight(evidence.leftRightPlacementPreserved, `Master appearance region ${region}.leftRightPlacementPreserved`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, evidence: cloneEvidence(inspection) };
}

/**
 * Validates dense, every-frame appearance evidence against the approved first
 * and last masters. Region scores are minima across visible frames, so one
 * moving, mirrored, recolored, duplicated, or erased marking fails the action.
 */
function validateVideoAppearanceInspection(inspection, { sampledFrameCount, policy } = {}) {
  const errors = [];
  const warnings = [];
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    return { ok: false, errors: ["Video appearance inspection is required"], evidence: null };
  }
  if (inspection.contractVersion !== APPEARANCE_LOCK_CONTRACT_VERSION) {
    errors.push(`Video appearance contractVersion must be ${APPEARANCE_LOCK_CONTRACT_VERSION}`);
  }
  if (inspection.referenceBinding !== "approved-action-masters") {
    errors.push("Video appearance referenceBinding must be approved-action-masters");
  }
  requireTrue(inspection.fullFrameCoverage, "Video appearance fullFrameCoverage", errors);
  requireTrue(inspection.occlusionAware, "Video appearance occlusionAware", errors);
  requireTrue(inspection.leftRightAware, "Video appearance leftRightAware", errors);
  if (inspection.asymmetryPreserved !== true) warnings.push("Video appearance asymmetry changed during motion");
  requireTrue(inspection.speciesConsistent, "Video appearance speciesConsistent", errors);
  requireTrue(inspection.primaryCoatColorConsistent, "Video appearance primaryCoatColorConsistent", errors);
  if (inspection.severeIdentityDriftDetected !== false) {
    errors.push("Video appearance severeIdentityDriftDetected must be false");
  }
  const declaredSamples = integer(inspection.sampledFrameCount, "Video appearance sampledFrameCount", errors, { min: 1 });
  if (Number.isFinite(declaredSamples) && declaredSamples !== Number(sampledFrameCount)) {
    errors.push("Video appearance inspection must cover every normalized frame");
  }

  const thresholds = appearanceThresholds(policy);
  const faceIdentityMinScore = score(inspection.faceIdentityMinScore, "Video appearance.faceIdentityMinScore", errors);
  const coatColorMinScore = score(inspection.coatColorMinScore, "Video appearance.coatColorMinScore", errors);
  const markingTopologyMinScore = score(inspection.markingTopologyMinScore, "Video appearance.markingTopologyMinScore", errors);
  const severeIdentityThreshold = Number(policy.minSevereVideoIdentityScore);
  if (Number.isFinite(faceIdentityMinScore) && faceIdentityMinScore < severeIdentityThreshold) {
    errors.push("Video appearance.faceIdentityMinScore indicates severe identity drift");
  } else if (Number.isFinite(faceIdentityMinScore) && faceIdentityMinScore < thresholds.face) {
    warnings.push("Video appearance.faceIdentityMinScore is below the preferred threshold");
  }
  if (Number.isFinite(coatColorMinScore) && coatColorMinScore < thresholds.color) {
    warnings.push("Video appearance.coatColorMinScore is below the preferred threshold");
  }
  if (Number.isFinite(markingTopologyMinScore) && markingTopologyMinScore < thresholds.markings) {
    warnings.push("Video appearance.markingTopologyMinScore is below the preferred threshold");
  }

  const regions = inspection.regions;
  if (!regions || typeof regions !== "object" || Array.isArray(regions)) {
    errors.push("Video appearance regions are required");
  } else {
    for (const region of APPEARANCE_REGIONS) {
      const evidence = regions[region];
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
        errors.push(`Video appearance region ${region} is required`);
        continue;
      }
      const visibleFrames = integer(evidence.visibleFrameCount, `Video appearance region ${region}.visibleFrameCount`, errors);
      const evaluatedFrames = integer(evidence.evaluatedFrameCount, `Video appearance region ${region}.evaluatedFrameCount`, errors);
      if (Number.isFinite(visibleFrames) && Number.isFinite(evaluatedFrames) && evaluatedFrames !== visibleFrames) {
        errors.push(`Video appearance region ${region} must evaluate every visible frame`);
      }
      if (REQUIRED_VIDEO_REGIONS.includes(region) && visibleFrames < 1) {
        errors.push(`Video appearance region ${region} must be visible in at least one frame`);
      }
      if (visibleFrames > 0) {
        const regionFace = region === "head"
          ? score(evidence.faceIdentityMinScore, `Video appearance region ${region}.faceIdentityMinScore`, errors)
          : null;
        const regionColor = score(evidence.coatColorMinScore, `Video appearance region ${region}.coatColorMinScore`, errors);
        const regionMarkings = score(evidence.markingTopologyMinScore, `Video appearance region ${region}.markingTopologyMinScore`, errors);
        if (region === "head" && Number.isFinite(regionFace) && regionFace < severeIdentityThreshold) {
          errors.push(`Video appearance region ${region}.faceIdentityMinScore indicates severe identity drift`);
        } else if (region === "head" && Number.isFinite(regionFace) && regionFace < thresholds.face) {
          warnings.push(`Video appearance region ${region}.faceIdentityMinScore is below the preferred threshold`);
        }
        if (Number.isFinite(regionColor) && regionColor < thresholds.color) {
          warnings.push(`Video appearance region ${region}.coatColorMinScore is below the preferred threshold`);
        }
        if (Number.isFinite(regionMarkings) && regionMarkings < thresholds.markings) {
          warnings.push(`Video appearance region ${region}.markingTopologyMinScore is below the preferred threshold`);
        }
        if (evidence.leftRightPlacementPreserved !== true) {
          warnings.push(`Video appearance region ${region}.leftRightPlacementPreserved is not stable during motion`);
        }
      }
    }
  }
  const evidence = cloneEvidence(inspection);
  if (evidence) evidence.qualityWarnings = [...warnings];
  return { ok: errors.length === 0, errors, warnings, evidence };
}

module.exports = {
  APPEARANCE_LOCK_CONTRACT_VERSION,
  APPEARANCE_REGIONS,
  REQUIRED_FRONT_MASTER_REGIONS,
  REQUIRED_SIDE_MASTER_REGIONS,
  REQUIRED_SLEEP_MASTER_REGIONS,
  REQUIRED_VIDEO_REGIONS,
  validateMasterAppearanceInspection,
  validateVideoAppearanceInspection
};
