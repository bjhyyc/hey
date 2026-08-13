const { requireAdmin } = require("../auth/authorization");
const {
  assertImagePromptKind,
  assertImagePromptVersionShape,
  createImagePromptDraftCopy,
  createImagePromptPublicationTransition,
  createImagePromptRollbackDraft
} = require("../domain/image-prompt-lifecycle");
const {
  IMAGE_CONSTRAINTS_VERSION,
  IMAGE_PROMPT_CONTENT_POLICY_VERSION
} = require("../providers/modelark-client");

function requireRepository(repository) {
  const methods = ["getImagePromptVersions", "getImagePromptHistory", "saveImagePromptVersions"];
  const missing = methods.filter((method) => !repository || typeof repository[method] !== "function");
  if (missing.length > 0) throw new Error(`Image prompt repository is incomplete: ${missing.join(", ")}`);
  return repository;
}

class AdminImagePromptService {
  constructor({ repository, logger = console } = {}) {
    this.repository = requireRepository(repository);
    this.logger = logger;
  }

  async getHistory({ actor, kind }) {
    requireAdmin(actor);
    return this.repository.getImagePromptHistory(assertImagePromptKind(kind));
  }

  async saveDraft({ actor, version, now = new Date().toISOString() }) {
    const admin = requireAdmin(actor);
    const draft = {
      ...version,
      kind: assertImagePromptKind(version?.kind),
      status: "draft",
      immutableConstraintsVersion: IMAGE_CONSTRAINTS_VERSION,
      contentPolicyVersion: IMAGE_PROMPT_CONTENT_POLICY_VERSION,
      contentPolicyApprovedAt: null,
      contentPolicyApprovedBy: null,
      createdAt: now,
      createdBy: admin.id,
      publishedAt: null,
      publishedBy: null,
      disabledAt: null,
      disabledBy: null,
      supersedesVersionId: null
    };
    assertImagePromptVersionShape(draft);
    await this.repository.saveImagePromptVersions({ kind: draft.kind, versions: [draft], actorId: admin.id });
    this.logger.info?.("petpack.admin.image_prompt_draft_saved", { kind: draft.kind, versionId: draft.id, actorId: admin.id });
    return { id: draft.id, status: draft.status };
  }

  async copyVersion({ actor, kind, sourceId, id, version, now }) {
    const admin = requireAdmin(actor);
    const safeKind = assertImagePromptKind(kind);
    const versions = await this.repository.getImagePromptVersions(safeKind);
    const source = versions.find((item) => item.id === sourceId);
    const draft = createImagePromptDraftCopy({ source, id, version, actorId: admin.id, now });
    await this.repository.saveImagePromptVersions({
      kind: safeKind,
      versions: [draft],
      actorId: admin.id,
      publicationEvent: { eventType: "copy", fromVersionId: sourceId, toVersionId: draft.id }
    });
    return { id: draft.id, status: draft.status };
  }

  async publishVersion({ actor, kind, publishId, contentPolicyAttested, now }) {
    const admin = requireAdmin(actor);
    const safeKind = assertImagePromptKind(kind);
    const versions = await this.repository.getImagePromptVersions(safeKind);
    const transitioned = createImagePromptPublicationTransition({
      versions,
      publishId,
      actorId: admin.id,
      contentPolicyAttested,
      now
    });
    await this.repository.saveImagePromptVersions({
      kind: safeKind,
      versions: transitioned,
      actorId: admin.id,
      publicationEvent: { eventType: "publish", toVersionId: publishId }
    });
    return { id: publishId, status: "published" };
  }

  async rollbackVersion({ actor, kind, targetId, id, version, now }) {
    const admin = requireAdmin(actor);
    const safeKind = assertImagePromptKind(kind);
    const versions = await this.repository.getImagePromptVersions(safeKind);
    const draft = createImagePromptRollbackDraft({ versions, targetId, id, version, actorId: admin.id, now });
    await this.repository.saveImagePromptVersions({
      kind: safeKind,
      versions: [draft],
      actorId: admin.id,
      publicationEvent: { eventType: "rollback", fromVersionId: targetId, toVersionId: draft.id }
    });
    return { id: draft.id, status: draft.status };
  }
}

module.exports = { AdminImagePromptService };
