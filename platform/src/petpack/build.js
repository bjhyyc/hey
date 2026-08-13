const crypto = require("node:crypto");
const JSZip = require("jszip");

const { validateManifest } = require("../../../src/shared/manifest-validator");
const profile = require("../../../src/shared/studio-behavior-profile.json");
const { REQUIRED_ACTION_IDS, assertActionId, toStudioActionKey } = require("../domain/action-catalog");
const { CHARACTER_CANVAS_V1 } = require("../qa/character-canvas-v1");
const { validateActionMediaProbe } = require("../qa/media-inspector");
const { isSafeRelativePath } = require("../../../src/shared/path-safety");

const ACTION_FILE_NAMES = Object.freeze({
  idle: "idle.webm",
  sneeze: "sneeze.webm",
  roll: "roll.webm",
  "sleep-transition": "sleep-transition.webm",
  "sleep-loop": "sleep-loop.webm",
  stretch: "stretch.webm",
  "hover-attention": "hover-attention.webm"
});

const GREEN_SCREEN_CONFIG = Object.freeze({
  enabled: true,
  color: "#00FF00",
  tolerance: 0.22,
  softness: 0.08
});

// ZIP entry timestamps are part of the archive bytes. A fixed, DOS-compatible
// instant plus caller-supplied deterministic clip UUIDs makes a retry produce
// the same PetPack checksum instead of silently creating a second artifact.
const DETERMINISTIC_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 320 * 1024 * 1024;
const MAX_ARCHIVE_COMPRESSION_RATIO = 100;

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function assertUuid(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value;
}

function ensureExactActions(assets) {
  if (!Array.isArray(assets)) throw new Error("Exactly seven quality-approved action assets are required");
  const byAction = new Map();
  for (const asset of assets) {
    assertActionId(asset && asset.actionId);
    if (byAction.has(asset.actionId)) throw new Error(`Duplicate action asset: ${asset.actionId}`);
    byAction.set(asset.actionId, asset);
  }
  const missing = REQUIRED_ACTION_IDS.filter((actionId) => !byAction.has(actionId));
  if (missing.length > 0 || byAction.size !== REQUIRED_ACTION_IDS.length) {
    throw new Error(`Exactly the seven required action assets are required; missing: ${missing.join(", ") || "none"}`);
  }
  return byAction;
}

function assertSafePackageId(packageId) {
  if (typeof packageId !== "string" || !isSafeRelativePath(packageId) || packageId.includes("/")) {
    throw new Error("PetPack packageId must be a safe single directory name");
  }
  return packageId;
}

function assertWebmSignature(buffer, actionId) {
  const webmHeader = [0x1A, 0x45, 0xDF, 0xA3];
  if (buffer.length < webmHeader.length || !webmHeader.every((value, index) => buffer[index] === value)) {
    throw new Error(`${actionId} output does not have a WebM container signature`);
  }
}

async function assertQualityApproved(asset, probeAsset) {
  const buffer = Buffer.isBuffer(asset && asset.buffer) ? asset.buffer : null;
  if (!buffer || buffer.length === 0) throw new Error(`${asset && asset.actionId || "action"} output bytes are required`);
  assertWebmSignature(buffer, asset.actionId);
  if (asset.matteMode !== "green-screen") {
    throw new Error(`${asset.actionId} must use the Desktop Pet-compatible green-screen media profile`);
  }
  if (asset.container !== "webm" || asset.codec !== "vp9") {
    throw new Error(`${asset.actionId} must be a VP9 WebM asset`);
  }
  if (typeof asset.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(asset.expectedSha256)) {
    throw new Error(`${asset.actionId} requires the post-QA SHA-256 checksum`);
  }
  const actualSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actualSha256 !== asset.expectedSha256.toLowerCase()) {
    throw new Error(`${asset.actionId} output bytes differ from the quality-approved artifact`);
  }
  if (typeof probeAsset !== "function") {
    throw new Error("A trusted post-build media probe is required before PetPack packaging");
  }
  if (typeof asset.localPath !== "string" || !asset.localPath.trim()) {
    throw new Error(`${asset.actionId} requires a worker-local post-build media path`);
  }
  const qa = asset.qa || {};
  for (const gate of ["media", "canvas", "endpoints", "content", "continuity"]) {
    if (!qa[gate] || qa[gate].ok !== true) {
      throw new Error(`${asset.actionId} cannot be packaged until ${gate} QA passes`);
    }
  }
  const summary = qa.media.summary || {};
  const probeResult = await probeAsset({
    actionId: asset.actionId,
    buffer,
    expectedSha256: actualSha256,
    localPath: asset.localPath
  });
  const liveProbe = probeResult && probeResult.probe ? probeResult.probe : probeResult;
  const probedChecksum = probeResult && probeResult.checksumSha256;
  if (typeof probedChecksum !== "string" || probedChecksum.toLowerCase() !== actualSha256) {
    throw new Error(`${asset.actionId} trusted media probe did not bind to the quality-approved bytes`);
  }
  const liveMedia = validateActionMediaProbe(liveProbe);
  if (!liveMedia.ok) {
    throw new Error(`${asset.actionId} failed its trusted post-build media probe: ${liveMedia.errors.join("; ")}`);
  }
  if (
    Number(summary.width) !== CHARACTER_CANVAS_V1.width ||
    Number(summary.height) !== CHARACTER_CANVAS_V1.height ||
    Math.abs(Number(summary.fps) - CHARACTER_CANVAS_V1.fps) > 0.01 ||
    Number(summary.audioStreams) !== 0 ||
    String(summary.codec || "").toLowerCase() !== "vp9"
  ) {
    throw new Error(`${asset.actionId} media summary does not match the required desktop media profile`);
  }
  if (
    Number(summary.width) !== Number(liveMedia.summary.width) ||
    Number(summary.height) !== Number(liveMedia.summary.height) ||
    Math.abs(Number(summary.fps) - Number(liveMedia.summary.fps)) > 0.01 ||
    Number(summary.audioStreams) !== Number(liveMedia.summary.audioStreams) ||
    String(summary.codec || "").toLowerCase() !== String(liveMedia.summary.codec || "").toLowerCase()
  ) {
    throw new Error(`${asset.actionId} QA report does not match the post-build media probe`);
  }
  return { buffer, durationMs: Math.round(Number(liveMedia.summary.duration) * 1000) };
}

function createStudioPetpackManifest({ packageId, name, version, actionClipIds, assets }) {
  const assetByAction = ensureExactActions(assets);
  const assetPath = (actionId) => `assets/${ACTION_FILE_NAMES[actionId]}`;
  const createClip = (actionId) => {
    const studioActionKey = toStudioActionKey(actionId);
    return {
    id: actionClipIds[studioActionKey],
    name: studioActionKey,
    asset: assetPath(actionId),
    ...(actionId === "sleep-loop" ? { type: "loop" } : { type: "oneshot" }),
    durationMs: Number(assetByAction.get(actionId).durationMs),
    greenScreen: { ...GREEN_SCREEN_CONFIG },
    ...(profile.interruptActionKeys.includes(studioActionKey) ? { interrupt: true } : {})
    };
  };
  return {
    schemaVersion: 1,
    packageId: assertSafePackageId(requireString(packageId, "PetPack packageId")),
    name: requireString(name, "PetPack name"),
    version: requireString(version, "PetPack version"),
    animations: {
      default: {
        id: actionClipIds[toStudioActionKey("idle")],
        name: "idle",
        asset: assetPath("idle"),
        greenScreen: { ...GREEN_SCREEN_CONFIG }
      },
      clips: REQUIRED_ACTION_IDS.filter((actionId) => actionId !== "idle").map(createClip)
    },
    triggerRules: [],
    studioBehavior: {
      profile: profile.profile,
      actionClipIds: { ...actionClipIds },
      timing: { ...profile.defaultTiming }
    }
  };
}

function createActionClipIds(idFactory = () => crypto.randomUUID()) {
  if (typeof idFactory !== "function") throw new Error("An action clip ID factory is required");
  const actionClipIds = {};
  const uniqueIds = new Set();
  for (const actionId of REQUIRED_ACTION_IDS) {
    const id = assertUuid(idFactory(actionId), `${actionId} animation ID`);
    if (uniqueIds.has(id)) throw new Error("Each PetPack Studio action must use a distinct animation UUID");
    uniqueIds.add(id);
    actionClipIds[toStudioActionKey(actionId)] = id;
  }
  return actionClipIds;
}

async function verifyPetpackArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) throw new Error("PetPack archive bytes are required");
  const zip = await JSZip.loadAsync(bytes);
  const fileNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
  const expectedFiles = ["manifest.json", ...REQUIRED_ACTION_IDS.map((actionId) => `assets/${ACTION_FILE_NAMES[actionId]}`)].sort();
  if (JSON.stringify(fileNames) !== JSON.stringify(expectedFiles)) {
    throw new Error("Built PetPack has unexpected or missing action resources");
  }
  let totalDeclaredBytes = 0;
  for (const fileName of fileNames) {
    const declaredSize = Number(zip.file(fileName)?._data?.uncompressedSize);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 1) {
      throw new Error(`PetPack archive entry has an invalid declared size: ${fileName}`);
    }
    if (fileName === "manifest.json" && declaredSize > MAX_MANIFEST_BYTES) {
      throw new Error("PetPack manifest exceeds its validation budget");
    }
    totalDeclaredBytes += declaredSize;
  }
  if (!Number.isSafeInteger(totalDeclaredBytes) || totalDeclaredBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES ||
      totalDeclaredBytes / bytes.length > MAX_ARCHIVE_COMPRESSION_RATIO) {
    throw new Error("PetPack archive exceeds its decompression budget");
  }
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  const validation = validateManifest(manifest, new Set(fileNames));
  if (!validation.ok) throw new Error(`Built PetPack manifest is invalid: ${validation.errors.join("; ")}`);
  return { fileNames, manifest, validation, totalDeclaredBytes };
}

async function buildPetpack({
  packageId,
  name,
  version = "1.0.0",
  assets,
  idFactory,
  probeAsset
} = {}) {
  const assetByAction = ensureExactActions(assets);
  const actionClipIds = createActionClipIds(idFactory);
  const approvedAssets = [];
  for (const actionId of REQUIRED_ACTION_IDS) {
    const asset = assetByAction.get(actionId);
    const approved = await assertQualityApproved(asset, probeAsset);
    approvedAssets.push({ ...asset, ...approved });
  }
  const manifest = createStudioPetpackManifest({ packageId, name, version, actionClipIds, assets: approvedAssets });
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2), {
    date: DETERMINISTIC_ZIP_DATE,
    createFolders: false
  });
  const checksums = {};
  for (const actionId of REQUIRED_ACTION_IDS) {
    const bytes = approvedAssets.find((asset) => asset.actionId === actionId).buffer;
    const fileName = `assets/${ACTION_FILE_NAMES[actionId]}`;
    zip.file(fileName, bytes, {
      binary: true,
      date: DETERMINISTIC_ZIP_DATE,
      createFolders: false
    });
    checksums[fileName] = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX"
  });
  const archive = await verifyPetpackArchive(bytes);
  return {
    bytes,
    checksumSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    checksums,
    manifest,
    archive
  };
}

module.exports = {
  ACTION_FILE_NAMES,
  DETERMINISTIC_ZIP_DATE,
  GREEN_SCREEN_CONFIG,
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_MANIFEST_BYTES,
  assertSafePackageId,
  buildPetpack,
  createActionClipIds,
  createStudioPetpackManifest,
  verifyPetpackArchive
};
