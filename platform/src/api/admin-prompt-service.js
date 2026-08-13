const { requireAdmin } = require("../auth/authorization");
const {
  assertPromptVersionShape,
  createDraftCopy,
  createPublicationTransition,
  createRollbackDraft
} = require("../domain/prompt-lifecycle");
const { VIDEO_CONSTRAINTS_VERSION } = require("../domain/action-catalog");

function requirePromptRepository(repository) {
  const methods = ["getPromptVersions", "savePromptVersions", "getPromptHistory"];
  const missing = methods.filter((method) => !repository || typeof repository[method] !== "function");
  if (missing.length > 0) throw new Error(`Prompt repository is incomplete: ${missing.join(", ")}`);
  return repository;
}

class AdminPromptService {
  constructor({ repository, logger = console } = {}) {
    this.repository = requirePromptRepository(repository);
    this.logger = logger;
  }

  async getActionHistory({ actor, actionId }) {
    requireAdmin(actor);
    return this.repository.getPromptHistory(actionId);
  }

  async saveDraft({ actor, version, now = new Date().toISOString() }) {
    const admin = requireAdmin(actor);
    const draft = {
      ...version,
      status: "draft",
      immutableConstraintsVersion: VIDEO_CONSTRAINTS_VERSION,
      createdAt: now,
      createdBy: admin.id,
      publishedAt: null,
      publishedBy: null,
      disabledAt: null,
      disabledBy: null
    };
    assertPromptVersionShape(draft);
    await this.repository.savePromptVersions({ actionId: draft.actionId, versions: [draft], actorId: admin.id });
    this.logger.info?.("petpack.admin.prompt_draft_saved", { actionId: draft.actionId, versionId: draft.id, actorId: admin.id });
    return { id: draft.id, status: draft.status };
  }

  async copyVersion({ actor, actionId, sourceId, id, version, now }) {
    const admin = requireAdmin(actor);
    const versions = await this.repository.getPromptVersions(actionId);
    const source = versions.find((item) => item.id === sourceId);
    const draft = createDraftCopy({ source, id, version, actorId: admin.id, now });
    await this.repository.savePromptVersions({
      actionId,
      versions: [draft],
      actorId: admin.id,
      publicationEvent: { eventType: "copy", fromVersionId: sourceId, toVersionId: draft.id }
    });
    return { id: draft.id, status: draft.status };
  }

  async publishVersion({ actor, actionId, publishId, now }) {
    const admin = requireAdmin(actor);
    const versions = await this.repository.getPromptVersions(actionId);
    const transitioned = createPublicationTransition({ versions, publishId, actorId: admin.id, now });
    await this.repository.savePromptVersions({
      actionId,
      versions: transitioned,
      actorId: admin.id,
      publicationEvent: { eventType: "publish", toVersionId: publishId }
    });
    return { id: publishId, status: "published" };
  }

  async rollbackVersion({ actor, actionId, targetId, id, version, now }) {
    const admin = requireAdmin(actor);
    const versions = await this.repository.getPromptVersions(actionId);
    const draft = createRollbackDraft({ versions, targetId, id, version, actorId: admin.id, now });
    await this.repository.savePromptVersions({
      actionId,
      versions: [draft],
      actorId: admin.id,
      publicationEvent: { eventType: "rollback", fromVersionId: targetId, toVersionId: draft.id }
    });
    return { id: draft.id, status: draft.status };
  }
}

module.exports = { AdminPromptService };
