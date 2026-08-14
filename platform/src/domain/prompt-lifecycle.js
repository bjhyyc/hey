const { ACTION_ENDPOINTS, VIDEO_CONSTRAINTS_VERSION, assertActionId } = require("./action-catalog");

const PROMPT_STATUSES = Object.freeze({
  DRAFT: "draft",
  PUBLISHED: "published",
  DISABLED: "disabled"
});

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requirePositiveDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Prompt duration must be positive");
  return duration;
}

function assertPromptVersionShape(version, { requireContent = true } = {}) {
  if (!version || typeof version !== "object") throw new Error("Prompt version is required");
  requireString(version.id, "Prompt version ID");
  assertActionId(version.actionId);
  requireString(version.title, "Prompt title");
  if (requireContent) {
    requireString(version.prompt, "Prompt content");
    if (typeof version.negativePrompt !== "string") throw new Error("Negative prompt content must be a string");
  }
  requireString(version.model, "Prompt model reference");
  if (!["480p", "720p"].includes(version.resolution)) throw new Error("PetPack Studio video prompts must use 480p or 720p");
  requirePositiveDuration(version.duration);
  requireString(version.version, "Prompt version label");
  if (version.immutableConstraintsVersion !== VIDEO_CONSTRAINTS_VERSION) {
    throw new Error("Prompt version targets an unsupported immutable constraints version");
  }
  const endpoint = ACTION_ENDPOINTS[version.actionId];
  if (version.firstFrameMode !== endpoint.firstFrameMode || version.lastFrameMode !== endpoint.lastFrameMode) {
    throw new Error(`${version.actionId} prompt frame modes must be ${endpoint.firstFrameMode} to ${endpoint.lastFrameMode}`);
  }
  if (!Object.values(PROMPT_STATUSES).includes(version.status)) {
    throw new Error("Prompt version has an unsupported status");
  }
  return version;
}

function createDraftCopy({ source, id, version, actorId, now = new Date().toISOString() } = {}) {
  assertPromptVersionShape(source);
  return {
    id: requireString(id, "New prompt version ID"),
    actionId: source.actionId,
    title: source.title,
    prompt: source.prompt,
    negativePrompt: source.negativePrompt,
    model: source.model,
    resolution: source.resolution,
    duration: source.duration,
    firstFrameMode: source.firstFrameMode,
    lastFrameMode: source.lastFrameMode,
    immutableConstraintsVersion: source.immutableConstraintsVersion,
    version: requireString(version, "New prompt version label"),
    status: PROMPT_STATUSES.DRAFT,
    createdAt: now,
    createdBy: requireString(actorId, "Administrator actor ID"),
    publishedAt: null,
    publishedBy: null,
    supersedesVersionId: source.id
  };
}

/**
 * Produces immutable records for a transactional persistence layer. Publishing
 * never mutates a delivered run's saved snapshot; it disables only the prior
 * live version for the same canonical action.
 */
function createPublicationTransition({ versions, publishId, actorId, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(versions)) throw new Error("Prompt versions are required");
  const candidate = versions.find((version) => version && version.id === publishId);
  if (!candidate) throw new Error("Prompt version to publish was not found");
  assertPromptVersionShape(candidate);
  if (candidate.status !== PROMPT_STATUSES.DRAFT) throw new Error("Only draft prompt versions can be published");
  const administrator = requireString(actorId, "Administrator actor ID");
  const publishedAt = now;
  return versions.map((version) => {
    if (!version || version.actionId !== candidate.actionId) return version;
    if (version.id === candidate.id) {
      return { ...version, status: PROMPT_STATUSES.PUBLISHED, publishedAt, publishedBy: administrator, disabledAt: null };
    }
    if (version.status === PROMPT_STATUSES.PUBLISHED && !version.disabledAt) {
      return { ...version, status: PROMPT_STATUSES.DISABLED, disabledAt: publishedAt, disabledBy: administrator };
    }
    return version;
  });
}

function createRollbackDraft({ versions, targetId, id, version, actorId, now } = {}) {
  if (!Array.isArray(versions)) throw new Error("Prompt versions are required");
  const target = versions.find((item) => item && item.id === targetId);
  if (!target) throw new Error("Prompt version to roll back to was not found");
  return createDraftCopy({ source: target, id, version, actorId, now });
}

module.exports = {
  PROMPT_STATUSES,
  assertPromptVersionShape,
  createDraftCopy,
  createPublicationTransition,
  createRollbackDraft
};
