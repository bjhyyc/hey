const {
  IMAGE_CONSTRAINTS_VERSION,
  IMAGE_PROMPT_CONTENT_POLICY_VERSION
} = require("../providers/modelark-client");

const IMAGE_PROMPT_KINDS = Object.freeze(["awake", "sleep"]);
const IMAGE_PROMPT_STATUSES = Object.freeze({
  DRAFT: "draft",
  PUBLISHED: "published",
  DISABLED: "disabled"
});

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function assertImagePromptKind(kind) {
  const normalized = requireString(kind, "Image prompt kind");
  if (!IMAGE_PROMPT_KINDS.includes(normalized)) throw new Error("Image prompt kind must be awake or sleep");
  return normalized;
}

function assertImagePromptVersionShape(version) {
  if (!version || typeof version !== "object") throw new Error("Image prompt version is required");
  requireString(version.id, "Image prompt version ID");
  assertImagePromptKind(version.kind);
  requireString(version.prompt, "Image prompt content");
  if (typeof version.negativePrompt !== "string") throw new Error("Image negative prompt content must be a string");
  requireString(version.version, "Image prompt version label");
  if (version.immutableConstraintsVersion !== IMAGE_CONSTRAINTS_VERSION) {
    throw new Error("Image prompt targets an unsupported immutable constraints version");
  }
  if (version.contentPolicyVersion !== IMAGE_PROMPT_CONTENT_POLICY_VERSION) {
    throw new Error("Image prompt targets an unsupported content policy version");
  }
  if (!Object.values(IMAGE_PROMPT_STATUSES).includes(version.status)) {
    throw new Error("Image prompt version has an unsupported status");
  }
  requireString(version.createdAt, "Image prompt creation timestamp");
  requireString(version.createdBy, "Image prompt creator");
  if (version.status === IMAGE_PROMPT_STATUSES.PUBLISHED) {
    requireString(version.publishedAt, "Image prompt publication timestamp");
    requireString(version.publishedBy, "Image prompt publisher");
    requireString(version.contentPolicyApprovedAt, "Image prompt content-policy approval timestamp");
    requireString(version.contentPolicyApprovedBy, "Image prompt content-policy approver");
    if (version.disabledAt || version.disabledBy) throw new Error("A published image prompt cannot be disabled");
  }
  if (version.status === IMAGE_PROMPT_STATUSES.DRAFT && (
    version.publishedAt || version.publishedBy || version.disabledAt || version.disabledBy ||
    version.contentPolicyApprovedAt || version.contentPolicyApprovedBy
  )) {
    throw new Error("A draft image prompt cannot carry publication or approval state");
  }
  return version;
}

function createImagePromptDraftCopy({ source, id, version, actorId, now = new Date().toISOString() } = {}) {
  assertImagePromptVersionShape(source);
  return {
    id: requireString(id, "New image prompt version ID"),
    kind: source.kind,
    prompt: source.prompt,
    negativePrompt: source.negativePrompt,
    immutableConstraintsVersion: source.immutableConstraintsVersion,
    contentPolicyVersion: source.contentPolicyVersion,
    version: requireString(version, "New image prompt version label"),
    status: IMAGE_PROMPT_STATUSES.DRAFT,
    createdAt: now,
    createdBy: requireString(actorId, "Administrator actor ID"),
    contentPolicyApprovedAt: null,
    contentPolicyApprovedBy: null,
    publishedAt: null,
    publishedBy: null,
    disabledAt: null,
    disabledBy: null,
    supersedesVersionId: source.id
  };
}

function createImagePromptPublicationTransition({
  versions,
  publishId,
  actorId,
  contentPolicyAttested,
  now = new Date().toISOString()
} = {}) {
  if (!Array.isArray(versions)) throw new Error("Image prompt versions are required");
  if (contentPolicyAttested !== true) throw new Error("Image prompt content-policy attestation is required");
  const candidate = versions.find((item) => item && item.id === publishId);
  if (!candidate) throw new Error("Image prompt version to publish was not found");
  assertImagePromptVersionShape(candidate);
  if (candidate.status !== IMAGE_PROMPT_STATUSES.DRAFT) {
    throw new Error("Only draft image prompt versions can be published");
  }
  const administrator = requireString(actorId, "Administrator actor ID");
  return versions.map((item) => {
    if (!item || item.kind !== candidate.kind) return item;
    if (item.id === candidate.id) {
      return {
        ...item,
        status: IMAGE_PROMPT_STATUSES.PUBLISHED,
        contentPolicyApprovedAt: now,
        contentPolicyApprovedBy: administrator,
        publishedAt: now,
        publishedBy: administrator,
        disabledAt: null,
        disabledBy: null
      };
    }
    if (item.status === IMAGE_PROMPT_STATUSES.PUBLISHED && !item.disabledAt) {
      return {
        ...item,
        status: IMAGE_PROMPT_STATUSES.DISABLED,
        disabledAt: now,
        disabledBy: administrator
      };
    }
    return item;
  });
}

function createImagePromptRollbackDraft({ versions, targetId, id, version, actorId, now } = {}) {
  if (!Array.isArray(versions)) throw new Error("Image prompt versions are required");
  const target = versions.find((item) => item && item.id === targetId);
  if (!target) throw new Error("Image prompt version to roll back to was not found");
  return createImagePromptDraftCopy({ source: target, id, version, actorId, now });
}

module.exports = {
  IMAGE_PROMPT_KINDS,
  IMAGE_PROMPT_STATUSES,
  assertImagePromptKind,
  assertImagePromptVersionShape,
  createImagePromptDraftCopy,
  createImagePromptPublicationTransition,
  createImagePromptRollbackDraft
};
