const profile = require("../../../src/shared/studio-behavior-profile.json");

const VIDEO_CONSTRAINTS_VERSION = "petpack-studio-video-constraints/v2";

const ACTION_DEFINITIONS = Object.freeze([
  { actionId: "idle", studioActionKey: "idle", firstMaster: "front", lastMaster: "front", clipType: "default" },
  { actionId: "sneeze", studioActionKey: "sneeze", firstMaster: "front", lastMaster: "front", clipType: "oneshot" },
  { actionId: "roll", studioActionKey: "roll", firstMaster: "front", lastMaster: "front", clipType: "oneshot" },
  { actionId: "sleep-transition", studioActionKey: "sleepTransition", firstMaster: "front", lastMaster: "sleep", clipType: "oneshot" },
  { actionId: "sleep-loop", studioActionKey: "sleepLoop", firstMaster: "sleep", lastMaster: "sleep", clipType: "loop" },
  { actionId: "stretch", studioActionKey: "stretch", firstMaster: "sleep", lastMaster: "front", clipType: "oneshot" },
  { actionId: "hover-attention", studioActionKey: "hoverAttention", firstMaster: "front", lastMaster: "front", clipType: "oneshot" }
]);

const REQUIRED_ACTION_IDS = Object.freeze(ACTION_DEFINITIONS.map((definition) => definition.actionId));
const ACTION_BY_ID = Object.freeze(Object.fromEntries(ACTION_DEFINITIONS.map((definition) => [definition.actionId, definition])));
const ACTION_BY_STUDIO_KEY = Object.freeze(Object.fromEntries(ACTION_DEFINITIONS.map((definition) => [definition.studioActionKey, definition])));
const ACTION_ENDPOINTS = Object.freeze(Object.fromEntries(ACTION_DEFINITIONS.map((definition) => [
  definition.actionId,
  {
    firstMaster: definition.firstMaster,
    lastMaster: definition.lastMaster,
    // Prompt versions and the public administrator API keep the historical
    // awake/sleep vocabulary. Internally, an awake endpoint resolves to the
    // user-confirmed front master; the side master remains a QA identity
    // reference because Seedance endpoint mode accepts only first/last frames.
    firstFrameMode: definition.firstMaster === "front" ? "awake" : "sleep",
    lastFrameMode: definition.lastMaster === "front" ? "awake" : "sleep",
    clipType: definition.clipType
  }
])));

if (ACTION_DEFINITIONS.length !== profile.actionKeys.length || ACTION_DEFINITIONS.some((definition) => !profile.actionKeys.includes(definition.studioActionKey))) {
  throw new Error("PetPack Studio action catalog is inconsistent with the client behavior profile");
}

function assertActionId(actionId) {
  if (!REQUIRED_ACTION_IDS.includes(actionId)) {
    throw new Error(`Unsupported PetPack Studio action: ${actionId}`);
  }
}

// Each action carries one published prompt per species. The wording differs by
// a single word today, but idle is the identity anchor as well as the
// most-played clip, so telling the model a cat is a dog there costs identity
// fidelity across the whole pack.
const PET_SPECIES = Object.freeze(["dog", "cat"]);
const DEFAULT_PET_SPECIES = "dog";

function assertPetSpecies(species) {
  if (!PET_SPECIES.includes(species)) {
    throw new Error(`Unsupported pet species: ${species}`);
  }
  return species;
}

function toStudioActionKey(actionId) {
  assertActionId(actionId);
  return ACTION_BY_ID[actionId].studioActionKey;
}

function toActionId(studioActionKey) {
  const definition = ACTION_BY_STUDIO_KEY[studioActionKey];
  if (!definition) throw new Error(`Unsupported PetPack Studio client action: ${studioActionKey}`);
  return definition.actionId;
}

function assertPublishedPromptSet(promptVersions) {
  if (!Array.isArray(promptVersions)) {
    throw new Error("Published action prompts are required before video generation");
  }
  const publishedByAction = new Map();
  for (const version of promptVersions) {
    if (!version || version.status !== "published" || version.disabledAt) continue;
    assertActionId(version.actionId);
    if (publishedByAction.has(version.actionId)) {
      throw new Error(`More than one published prompt version exists for ${version.actionId}`);
    }
    if (!version.id || !version.version) {
      throw new Error(`Published prompt metadata is incomplete for ${version.actionId}`);
    }
    if (!["480p", "720p"].includes(version.resolution)) {
      throw new Error(`Published prompt resolution is unsupported for ${version.actionId}`);
    }
    publishedByAction.set(version.actionId, version);
  }
  const missing = REQUIRED_ACTION_IDS.filter((actionId) => !publishedByAction.has(actionId));
  if (missing.length > 0) {
    throw new Error(`All seven published prompts are required; missing: ${missing.join(", ")}`);
  }
  return REQUIRED_ACTION_IDS.map((actionId) => ({
    actionId,
    promptVersionId: publishedByAction.get(actionId).id,
    promptVersion: publishedByAction.get(actionId).version,
    resolution: publishedByAction.get(actionId).resolution
  }));
}

function createVideoJobSnapshot({ actionId, promptVersion, frontMaster, sideMaster, sleepMaster, modelReference }) {
  assertActionId(actionId);
  if (!promptVersion || promptVersion.status !== "published" || !promptVersion.id) {
    throw new Error(`A published immutable prompt version is required for ${actionId}`);
  }
  if (!frontMaster || !sideMaster || !sleepMaster) {
    throw new Error("Front, side, and sleeping master revisions are required");
  }
  for (const [label, master] of [["frontMaster", frontMaster], ["sideMaster", sideMaster], ["sleepMaster", sleepMaster]]) {
    if (typeof master.objectKey !== "string" || !master.objectKey.startsWith("private/")) {
      throw new Error(`${label} must reference a private object key`);
    }
  }
  if (!modelReference || !["480p", "720p"].includes(modelReference.resolution)) {
    throw new Error("A 480p or 720p ModelArk video model reference is required");
  }
  if (promptVersion.resolution !== modelReference.resolution) {
    throw new Error(`Published prompt resolution must match the frozen model reference for ${actionId}`);
  }

  const endpoint = ACTION_ENDPOINTS[actionId];
  // Seedance first/last-frame mode is intentionally retained. The side master
  // is an immutable identity/QA reference, not a third provider image, because
  // ModelArk's multi-reference mode is mutually exclusive with endpoint mode.
  const masters = { front: frontMaster, sleep: sleepMaster };
  return {
    actionId,
    promptVersionId: promptVersion.id,
    promptVersion: promptVersion.version,
    modelReference: { ...modelReference },
    firstFrameObjectKey: masters[endpoint.firstMaster].objectKey,
    lastFrameObjectKey: masters[endpoint.lastMaster].objectKey,
    firstFrameRole: "first_frame",
    lastFrameRole: "last_frame",
    approvedCharacterReferenceObjectKeys: [frontMaster.objectKey, sideMaster.objectKey],
    resolution: modelReference.resolution,
    generateAudio: false,
    watermark: false,
    immutableConstraintsVersion: VIDEO_CONSTRAINTS_VERSION
  };
}

module.exports = {
  ACTION_BY_ID,
  ACTION_BY_STUDIO_KEY,
  ACTION_DEFINITIONS,
  ACTION_ENDPOINTS,
  DEFAULT_PET_SPECIES,
  PET_SPECIES,
  REQUIRED_ACTION_IDS,
  VIDEO_CONSTRAINTS_VERSION,
  assertActionId,
  assertPetSpecies,
  assertPublishedPromptSet,
  createVideoJobSnapshot,
  toActionId,
  toStudioActionKey
};
