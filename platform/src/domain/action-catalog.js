const profile = require("../../../src/shared/studio-behavior-profile.json");

const VIDEO_CONSTRAINTS_VERSION = "petpack-studio-video-constraints/v1";

const ACTION_DEFINITIONS = Object.freeze([
  { actionId: "idle", studioActionKey: "idle", firstMaster: "awake", lastMaster: "awake", clipType: "default" },
  { actionId: "sneeze", studioActionKey: "sneeze", firstMaster: "awake", lastMaster: "awake", clipType: "oneshot" },
  { actionId: "roll", studioActionKey: "roll", firstMaster: "awake", lastMaster: "awake", clipType: "oneshot" },
  { actionId: "sleep-transition", studioActionKey: "sleepTransition", firstMaster: "awake", lastMaster: "sleep", clipType: "oneshot" },
  { actionId: "sleep-loop", studioActionKey: "sleepLoop", firstMaster: "sleep", lastMaster: "sleep", clipType: "loop" },
  { actionId: "stretch", studioActionKey: "stretch", firstMaster: "sleep", lastMaster: "awake", clipType: "oneshot" },
  { actionId: "hover-attention", studioActionKey: "hoverAttention", firstMaster: "awake", lastMaster: "awake", clipType: "oneshot" }
]);

const REQUIRED_ACTION_IDS = Object.freeze(ACTION_DEFINITIONS.map((definition) => definition.actionId));
const ACTION_BY_ID = Object.freeze(Object.fromEntries(ACTION_DEFINITIONS.map((definition) => [definition.actionId, definition])));
const ACTION_BY_STUDIO_KEY = Object.freeze(Object.fromEntries(ACTION_DEFINITIONS.map((definition) => [definition.studioActionKey, definition])));
const ACTION_ENDPOINTS = Object.freeze(Object.fromEntries(ACTION_DEFINITIONS.map((definition) => [
  definition.actionId,
  {
    firstMaster: definition.firstMaster,
    lastMaster: definition.lastMaster,
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
    publishedByAction.set(version.actionId, version);
  }
  const missing = REQUIRED_ACTION_IDS.filter((actionId) => !publishedByAction.has(actionId));
  if (missing.length > 0) {
    throw new Error(`All seven published prompts are required; missing: ${missing.join(", ")}`);
  }
  return REQUIRED_ACTION_IDS.map((actionId) => ({
    actionId,
    promptVersionId: publishedByAction.get(actionId).id,
    promptVersion: publishedByAction.get(actionId).version
  }));
}

function createVideoJobSnapshot({ actionId, promptVersion, awakeMaster, sleepMaster, modelReference }) {
  assertActionId(actionId);
  if (!promptVersion || promptVersion.status !== "published" || !promptVersion.id) {
    throw new Error(`A published immutable prompt version is required for ${actionId}`);
  }
  if (!awakeMaster || !sleepMaster) {
    throw new Error("Awake and sleeping master revisions are both required");
  }
  for (const [label, master] of [["awakeMaster", awakeMaster], ["sleepMaster", sleepMaster]]) {
    if (typeof master.objectKey !== "string" || !master.objectKey.startsWith("private/")) {
      throw new Error(`${label} must reference a private object key`);
    }
  }
  if (!modelReference || modelReference.resolution !== "720p") {
    throw new Error("A 720p ModelArk video model reference is required");
  }

  const endpoint = ACTION_ENDPOINTS[actionId];
  const masters = { awake: awakeMaster, sleep: sleepMaster };
  return {
    actionId,
    promptVersionId: promptVersion.id,
    promptVersion: promptVersion.version,
    modelReference: { ...modelReference },
    firstFrameObjectKey: masters[endpoint.firstMaster].objectKey,
    lastFrameObjectKey: masters[endpoint.lastMaster].objectKey,
    firstFrameRole: "first_frame",
    lastFrameRole: "last_frame",
    resolution: "720p",
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
  REQUIRED_ACTION_IDS,
  VIDEO_CONSTRAINTS_VERSION,
  assertActionId,
  assertPublishedPromptSet,
  createVideoJobSnapshot,
  toActionId,
  toStudioActionKey
};
