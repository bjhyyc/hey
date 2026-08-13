const crypto = require("node:crypto");

const { REQUIRED_ACTION_IDS, assertActionId } = require("../domain/action-catalog");
const {
  assertPositiveByteSize,
  assertPrivateObjectKey,
  normalizeSha256
} = require("../storage/private-object-store");

const PETPACK_BUILDER_VERSION = "petpack-studio-builder/v1";
const PETPACK_BUILD_POLICY_VERSION = "petpack-studio-build-qa/v1";
const PETPACK_VALIDATION_POLICY_VERSION = "petpack-studio-delivery-qa/v1";
const PETPACK_CONTENT_TYPE = "application/vnd.petpack+zip";

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])])
    );
  }
  return value;
}

function checksumJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalizeJson(value))).digest("hex");
}

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function parseJsonObject(value, label) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error(`${label} is invalid JSON`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed;
}

function normalizePassedActionQa(value, actionId) {
  const qa = parseJsonObject(value, `${actionId} QA report`);
  if (qa.ok !== true || !Array.isArray(qa.errors) || qa.errors.length !== 0) {
    throw new Error(`${actionId} does not have a passing action QA report`);
  }
  for (const gate of ["media", "canvas", "endpoints", "content", "continuity"]) {
    if (!qa[gate] || qa[gate].ok !== true) {
      throw new Error(`${actionId} QA report is missing a passing ${gate} gate`);
    }
  }
  const evidence = qa.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
      !evidence.contentInspection || typeof evidence.contentInspection !== "object" ||
      !evidence.continuity || typeof evidence.continuity !== "object" ||
      !evidence.endpoints || typeof evidence.endpoints !== "object") {
    throw new Error(`${actionId} QA report is missing immutable inspection evidence`);
  }
  for (const field of [
    "cameraFixed", "noText", "noProps", "noPeople", "noOtherAnimals",
    "petFullyVisible", "identityConsistent", "noDeformation", "matteComplete",
    "matteEdgesStable", "greenBackgroundUniform", "noGreenSpill"
  ]) {
    if (evidence.contentInspection[field] !== true) {
      throw new Error(`${actionId} QA evidence is missing passing ${field}`);
    }
  }
  const sampledFrameCount = evidence.continuity.sampledFrameCount;
  if (!Number.isSafeInteger(sampledFrameCount) || sampledFrameCount < 1 ||
      !Array.isArray(qa.frameResults) || qa.frameResults.length !== sampledFrameCount ||
      qa.frameResults.some((frame) => !frame || frame.ok !== true)) {
    throw new Error(`${actionId} QA evidence has no complete frame sample count`);
  }
  for (const label of ["firstFrame", "lastFrame"]) {
    const frame = evidence.continuity[label];
    const visible = frame?.visibleBounds;
    const metrics = [
      frame?.width, frame?.height, visible?.left, visible?.top, visible?.right, visible?.bottom,
      frame?.groundBaselineY, frame?.torsoHeightPx, frame?.headHeightPx,
      frame?.shoulderWidthPx, frame?.identityScore
    ];
    if (metrics.some((metric) => !Number.isFinite(Number(metric)))) {
      throw new Error(`${actionId} QA evidence has incomplete ${label} geometry`);
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(String(evidence.endpoints.firstMasterHash || "")) ||
      !/^[a-f0-9]{64}$/i.test(String(evidence.endpoints.lastMasterHash || ""))) {
    throw new Error(`${actionId} QA evidence has incomplete endpoint bindings`);
  }
  if (actionId === "sleep-loop" && evidence.contentInspection.loopSeamAcceptable !== true) {
    throw new Error("sleep-loop QA report has no explicit passing loop-seam evidence");
  }
  return qa;
}

function ensureCanonicalActions(actions) {
  if (!Array.isArray(actions)) throw new Error("Exactly seven package input actions are required");
  const byAction = new Map();
  for (const item of actions) {
    const actionId = requiredString(item && item.actionId, "Package input action ID", 64);
    assertActionId(actionId);
    if (byAction.has(actionId)) throw new Error(`Duplicate package input action: ${actionId}`);
    byAction.set(actionId, item);
  }
  const missing = REQUIRED_ACTION_IDS.filter((actionId) => !byAction.has(actionId));
  if (missing.length > 0 || byAction.size !== REQUIRED_ACTION_IDS.length) {
    throw new Error(`Exactly the seven canonical package inputs are required; missing: ${missing.join(", ") || "none"}`);
  }
  return REQUIRED_ACTION_IDS.map((actionId) => byAction.get(actionId));
}

function normalizePackageInputAction(value) {
  const actionId = requiredString(value && value.actionId, "Package input action ID", 64);
  assertActionId(actionId);
  const contentType = requiredString(value.contentType, `${actionId} content type`, 256);
  if (contentType !== "video/webm") throw new Error(`${actionId} package input must be video/webm`);
  return {
    actionId,
    generationActionId: requiredString(value.generationActionId, `${actionId} generation action ID`, 128),
    mediaAssetId: requiredString(value.mediaAssetId, `${actionId} media asset ID`, 128),
    qaReportId: requiredString(value.qaReportId, `${actionId} QA report ID`, 128),
    promptVersionId: requiredString(value.promptVersionId, `${actionId} prompt version ID`, 128),
    promptVersionLabel: requiredString(value.promptVersionLabel, `${actionId} prompt version label`, 128),
    objectKey: assertPrivateObjectKey(value.objectKey),
    sha256: normalizeSha256(value.sha256, `${actionId} media checksum`),
    byteSize: assertPositiveByteSize(Number(value.byteSize), `${actionId} media byte size`),
    contentType,
    processingPolicyVersion: requiredString(value.processingPolicyVersion, `${actionId} QA policy version`, 128),
    processorVersion: requiredString(value.processorVersion, `${actionId} processor version`, 128),
    qa: normalizePassedActionQa(value.qa, actionId)
  };
}

function normalizePackageInputActions(actions) {
  return ensureCanonicalActions(actions).map(normalizePackageInputAction);
}

function createPackageInputRevision({ runId, packageName, actions } = {}) {
  const safeRunId = requiredString(runId, "Package input run ID", 128);
  const safePackageName = requiredString(packageName, "Frozen PetPack display name", 256);
  const normalized = normalizePackageInputActions(actions);
  const material = {
    runId: safeRunId,
    packageName: safePackageName,
    builderVersion: PETPACK_BUILDER_VERSION,
    buildPolicyVersion: PETPACK_BUILD_POLICY_VERSION,
    actions: normalized.map((action) => ({
      actionId: action.actionId,
      generationActionId: action.generationActionId,
      mediaAssetId: action.mediaAssetId,
      qaReportId: action.qaReportId,
      promptVersionId: action.promptVersionId,
      promptVersionLabel: action.promptVersionLabel,
      sha256: action.sha256,
      byteSize: action.byteSize,
      processingPolicyVersion: action.processingPolicyVersion,
      processorVersion: action.processorVersion,
      qaSha256: checksumJson(action.qa)
    }))
  };
  return {
    revisionSha256: checksumJson(material),
    packageName: safePackageName,
    actions: normalized
  };
}

function createDeterministicUuid(seed) {
  const bytes = crypto.createHash("sha256").update(requiredString(seed, "Deterministic UUID seed", 2048)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createPackageId(revisionSha256) {
  const digest = normalizeSha256(revisionSha256, "Package input revision");
  return `petpack-${digest.slice(0, 24)}`;
}

function createPetpackFileName({ revisionSha256, packageSha256, builderVersion = PETPACK_BUILDER_VERSION } = {}) {
  const revision = normalizeSha256(revisionSha256, "Package input revision");
  const packageDigest = normalizeSha256(packageSha256, "PetPack checksum");
  const builder = requiredString(builderVersion, "PetPack builder version", 128);
  const digest = crypto.createHash("sha256").update(`${revision}|${packageDigest}|${builder}`).digest("hex");
  return `petpack-${digest.slice(0, 48)}.petpack`;
}

function normalizePetpackArtifact(value) {
  if (!value || typeof value !== "object") throw new Error("PetPack artifact metadata is required");
  const contentType = requiredString(value.contentType, "PetPack content type", 256);
  if (contentType !== PETPACK_CONTENT_TYPE) throw new Error(`PetPack content type must be ${PETPACK_CONTENT_TYPE}`);
  return {
    objectKey: assertPrivateObjectKey(value.objectKey),
    sha256: normalizeSha256(value.sha256, "PetPack checksum"),
    byteSize: assertPositiveByteSize(Number(value.byteSize), "PetPack byte size"),
    contentType
  };
}

function normalizeBoundedJson(value, label, maxBytes = 512 * 1024) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds its persistence limit`);
  }
  return { value: JSON.parse(serialized), serialized };
}

module.exports = {
  PETPACK_BUILDER_VERSION,
  PETPACK_BUILD_POLICY_VERSION,
  PETPACK_CONTENT_TYPE,
  PETPACK_VALIDATION_POLICY_VERSION,
  canonicalizeJson,
  checksumJson,
  createDeterministicUuid,
  createPackageId,
  createPackageInputRevision,
  createPetpackFileName,
  ensureCanonicalActions,
  normalizeBoundedJson,
  normalizePackageInputAction,
  normalizePackageInputActions,
  normalizePassedActionQa,
  normalizePetpackArtifact,
  parseJsonObject,
  requiredString
};
