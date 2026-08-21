const { requireAdmin } = require("../auth/authorization");
const { REQUIRED_ACTION_IDS } = require("../domain/action-catalog");
const { PRODUCTION_STATES, ADMIN_RERUN_RESUME_STATES } = require("../domain/production-state-machine");
const { createAdminOperationsView } = require("./admin-operations-service");

const STAGE_PATTERN = /^(front_master|side_master|sleep_master|action:[a-z][a-z-]{0,31})$/;
const DEFAULT_MAX_ADMIN_RERUNS_PER_ORDER = 6;
const DEFAULT_DELIVERY_REISSUE_SECONDS = 72 * 3600;

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireOrdersRepository(repository) {
  const methods = [
    "findAdminOperations",
    "getAdminOrderRescueContext",
    "recordAdminAuditEvent",
    "extendDeliveryWindow"
  ];
  const missing = methods.filter((method) => !repository || typeof repository[method] !== "function");
  if (missing.length) throw new Error(`Administrator orders repository is incomplete: ${missing.join(", ")}`);
  return repository;
}

function requireRescueWorkflow(workflow) {
  const methods = [
    "adminRerunCharacterMaster",
    "adminRerunSleepMaster",
    "adminRerunVideoAction",
    "adminGrantCharacterRegeneration",
    "adminOverrideCharacterMaster",
    "adminOverrideSleepMaster",
    "adminOverrideVideoAction"
  ];
  const missing = methods.filter((method) => !workflow || typeof workflow[method] !== "function");
  if (missing.length) throw new Error(`Administrator rescue workflow is incomplete: ${missing.join(", ")}`);
  return workflow;
}

function requireObjectStore(objectStore) {
  if (!objectStore || typeof objectStore.createDownloadGrant !== "function") {
    throw new Error("A private object store is required");
  }
  return objectStore;
}

function stageUnavailableError(message) {
  const error = new Error(message);
  error.code = "admin_rerun_stage_unavailable";
  return error;
}

function parseStage(stage) {
  const value = requiredString(stage, "Rerun stage", 64);
  if (!STAGE_PATTERN.test(value)) throw stageUnavailableError(`Administrator rerun does not support stage: ${value}`);
  if (value.startsWith("action:")) {
    const actionId = value.slice("action:".length);
    if (!REQUIRED_ACTION_IDS.includes(actionId)) {
      throw stageUnavailableError(`Unknown video action for rerun: ${actionId}`);
    }
    return { kind: "action", actionId, stage: value };
  }
  if (value === "sleep_master") return { kind: "sleep", stage: value };
  return { kind: "master", view: value === "front_master" ? "front" : "side", stage: value };
}

/**
 * A QA report is free-form JSON sized for machines; the console needs a
 * sentence. Pull out up to five human-readable reasons from the shapes the QA
 * modules actually emit, and never forward the raw report to the browser.
 */
function summarizeQaReport(status, report) {
  if (!status && !report) return null;
  const reasons = [];
  const source = report && typeof report === "object" && !Array.isArray(report) ? report : {};
  for (const key of ["reasons", "failures", "errors"]) {
    const values = source[key];
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      if (typeof item === "string" && item.trim()) reasons.push(item.trim().slice(0, 200));
      else if (item && typeof item === "object" && typeof item.reason === "string" && item.reason.trim()) {
        reasons.push(item.reason.trim().slice(0, 200));
      }
      if (reasons.length >= 5) break;
    }
    if (reasons.length >= 5) break;
  }
  return { status: status || null, reasons };
}

/**
 * Which rescue buttons the console may show for this order right now. The
 * POST endpoint re-validates everything - this list only spares the UI from
 * re-deriving state-machine rules.
 */
function availableRescueStages(context) {
  const run = context.run;
  if (!run) return [];
  const stages = [];
  if (run.state === PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION) {
    for (const view of ["front", "side"]) {
      if (Number(run[`${view}UserRegenerationsUsed`] || 0) > 0) {
        stages.push({ stage: `${view}_master`, mode: "regeneration_grant" });
      }
    }
    return stages;
  }
  if (run.state !== PRODUCTION_STATES.FAILED) return [];
  const failedFrom = context.failedFromState;
  if (failedFrom === PRODUCTION_STATES.AWAKE_GENERATING) {
    // When the failure code names the view, offer only that view - a rerun of
    // the healthy one would spend budget on a master that did not fail. Codes
    // that do not name a view (provider errors, budget exhaustion) offer both.
    if (run.failureCode === "front_master_qa_failed") stages.push({ stage: "front_master", mode: "rerun" });
    else if (run.failureCode === "side_master_qa_failed") stages.push({ stage: "side_master", mode: "rerun" });
    else stages.push({ stage: "front_master", mode: "rerun" }, { stage: "side_master", mode: "rerun" });
  } else if (failedFrom === PRODUCTION_STATES.SLEEP_GENERATING) {
    stages.push({ stage: "sleep_master", mode: "rerun" });
  } else if (failedFrom === PRODUCTION_STATES.VIDEO_GENERATING) {
    for (const action of context.actions) {
      if (action.state === "failed") stages.push({ stage: `action:${action.actionId}`, mode: "rerun" });
    }
  }
  return stages;
}

/**
 * Support-console orders: point search, a rescue-oriented detail view, and the
 * two P1 disposals (authorize one extra generation; reopen a download window).
 * Every disposal requires an explicit reason and lands in audit_event.
 */
class AdminOrdersService {
  constructor({
    repository,
    workflow,
    objectStore,
    maxAdminRerunsPerOrder = DEFAULT_MAX_ADMIN_RERUNS_PER_ORDER,
    deliveryReissueSeconds = DEFAULT_DELIVERY_REISSUE_SECONDS,
    logger = console
  } = {}) {
    this.repository = requireOrdersRepository(repository);
    this.workflow = requireRescueWorkflow(workflow);
    this.objectStore = requireObjectStore(objectStore);
    if (!Number.isSafeInteger(maxAdminRerunsPerOrder) || maxAdminRerunsPerOrder < 1 || maxAdminRerunsPerOrder > 20) {
      throw new Error("maxAdminRerunsPerOrder must be an integer between 1 and 20");
    }
    if (!Number.isSafeInteger(deliveryReissueSeconds) || deliveryReissueSeconds < 3600) {
      throw new Error("deliveryReissueSeconds must be at least one hour");
    }
    this.maxAdminRerunsPerOrder = maxAdminRerunsPerOrder;
    this.deliveryReissueSeconds = deliveryReissueSeconds;
    this.logger = logger;
  }

  async searchOrders({ actor, orderId, projectId } = {}) {
    requireAdmin(actor);
    if (Boolean(orderId) === Boolean(projectId)) {
      throw new Error("Operations search requires exactly one of orderId or projectId");
    }
    const records = await this.repository.findAdminOperations({ orderId: orderId || null, projectId: projectId || null });
    const items = records.map(createAdminOperationsView);
    this.logger.info?.("petpack.admin.orders_searched", {
      by: orderId ? "orderId" : "projectId",
      returned: items.length
    });
    return { items };
  }

  async _signPreview(objectKey) {
    if (typeof objectKey !== "string" || !objectKey.startsWith("private/")) return null;
    const grant = await this.objectStore.createDownloadGrant({ objectKey, disposition: "inline" });
    return grant && typeof grant.url === "string" ? grant.url : null;
  }

  async getOrderDetail({ actor, orderId } = {}) {
    requireAdmin(actor);
    const context = await this.repository.getAdminOrderRescueContext(requiredString(orderId, "Order ID"));
    if (!context) {
      throw new Error("Order was not found");
    }
    const masters = [];
    for (const attempt of context.masterAttempts) {
      masters.push({
        id: attempt.id,
        kind: attempt.kind,
        generationAttempt: attempt.generationAttempt,
        status: attempt.status,
        lastErrorCode: attempt.lastErrorCode,
        qa: summarizeQaReport(attempt.qaStatus, attempt.qaReport),
        previewUrl: await this._signPreview(attempt.objectKey),
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt
      });
    }
    const actions = [];
    for (const action of context.actions) {
      actions.push({
        actionId: action.actionId,
        state: action.state,
        retryCount: action.retryCount,
        qa: summarizeQaReport(action.qaStatus, action.qaReport),
        // The rejected provider video, so an administrator can judge it before
        // spending another generation on the action.
        previewUrl: action.state === "failed" ? await this._signPreview(action.objectKey) : null,
        updatedAt: action.updatedAt
      });
    }
    const rejectedActionVideos = [];
    for (const video of context.rejectedActionVideos || []) {
      rejectedActionVideos.push({
        actionId: video.actionId,
        assetId: video.assetId,
        qa: summarizeQaReport("failed", video.qaReport),
        rejectedAt: video.rejectedAt,
        previewUrl: await this._signPreview(video.objectKey)
      });
    }
    const detail = {
      order: context.order,
      project: context.project,
      run: context.run,
      failedFromState: context.failedFromState,
      rescue: {
        adminRerunCount: context.adminRerunCount,
        maxAdminRerunsPerOrder: this.maxAdminRerunsPerOrder,
        rerunBudgetExhausted: context.adminRerunCount >= this.maxAdminRerunsPerOrder,
        availableStages: availableRescueStages(context)
      },
      masters,
      actions,
      rejectedActionVideos,
      delivery: context.delivery,
      dispatch: context.dispatch,
      timeline: context.timeline
    };
    this.logger.info?.("petpack.admin.order_detail_viewed", {
      orderId: context.order.id,
      runState: context.run ? context.run.state : null,
      failureCode: context.run ? context.run.failureCode : null
    });
    return detail;
  }

  async _recordDisposal({ actor, context, eventType, metadata }) {
    // The disposal already committed; a failed audit write must be loud but
    // must not report the committed rescue as failed.
    try {
      await this.repository.recordAdminAuditEvent({
        actorId: actor.id,
        projectId: context.project ? context.project.id : null,
        orderId: context.order.id,
        eventType,
        metadata
      });
    } catch (error) {
      this.logger.error?.("petpack.admin.audit_write_failed", {
        orderId: context.order.id,
        eventType,
        errorName: error && error.name ? error.name : "Error",
        errorMessage: error && error.message ? error.message : ""
      });
    }
  }

  async rerunStage({ actor, orderId, stage, reason } = {}) {
    const admin = requireAdmin(actor);
    const safeReason = requiredString(reason, "Disposal reason", 200);
    const parsed = parseStage(stage);
    const context = await this.repository.getAdminOrderRescueContext(requiredString(orderId, "Order ID"));
    if (!context) throw new Error("Order was not found");
    const run = context.run;
    if (!run) throw stageUnavailableError("This order has no production run to rerun");

    // Soft-stuck path: the run is healthy but the customer's regeneration
    // budget is spent. Hand one back instead of queueing anything.
    if (run.state === PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION && parsed.kind === "master") {
      const next = await this.workflow.adminGrantCharacterRegeneration({ run, view: parsed.view });
      await this._recordDisposal({
        actor: admin,
        context,
        eventType: "admin_regeneration_granted",
        metadata: { stage: parsed.stage, view: parsed.view, reason: safeReason, runId: run.id }
      });
      this.logger.warn?.("petpack.admin.regeneration_granted", { orderId: context.order.id, view: parsed.view });
      return { mode: "regeneration_granted", stage: parsed.stage, run: { id: next.id, state: next.state } };
    }

    if (run.state !== PRODUCTION_STATES.FAILED) {
      throw stageUnavailableError(`Only a failed production run can be rerun; the run state is ${run.state}`);
    }
    if (context.adminRerunCount >= this.maxAdminRerunsPerOrder) {
      const error = new Error(`This order has reached the administrator rerun limit of ${this.maxAdminRerunsPerOrder}`);
      error.code = "admin_rerun_limit_reached";
      throw error;
    }
    // Stage validation happens where the run died, not by failure code, so
    // provider-error and budget-exhaustion failures are rescuable too.
    const expectedResume = ADMIN_RERUN_RESUME_STATES[parsed.kind === "action" ? "action" : parsed.stage];
    if (context.failedFromState !== expectedResume) {
      throw stageUnavailableError(
        `The run failed from ${context.failedFromState || "an unknown state"}; the ${parsed.stage} stage cannot be rerun`
      );
    }

    let next;
    if (parsed.kind === "master") {
      next = await this.workflow.adminRerunCharacterMaster({ run, view: parsed.view, failedFromState: context.failedFromState });
    } else if (parsed.kind === "sleep") {
      next = await this.workflow.adminRerunSleepMaster({ run, failedFromState: context.failedFromState });
    } else {
      const action = context.actions.find((candidate) => candidate.actionId === parsed.actionId);
      if (!action || action.state !== "failed") {
        throw stageUnavailableError(`Action ${parsed.actionId} is not in a failed state`);
      }
      next = await this.workflow.adminRerunVideoAction({ run, actionId: parsed.actionId, failedFromState: context.failedFromState });
    }
    await this._recordDisposal({
      actor: admin,
      context,
      eventType: "admin_rerun_granted",
      metadata: {
        stage: parsed.stage,
        reason: safeReason,
        runId: run.id,
        previousFailureCode: run.failureCode || null,
        failedFromState: context.failedFromState
      }
    });
    this.logger.warn?.("petpack.admin.rerun_granted", {
      orderId: context.order.id,
      stage: parsed.stage,
      grantedSoFar: context.adminRerunCount + 1
    });
    return { mode: "rerun_authorized", stage: parsed.stage, run: { id: next.id, state: next.state } };
  }

  /**
   * Force-pass one QA-rejected candidate. `candidateId` is the
   * master_image_generation ID for master stages, or the rejected provider
   * video's media asset ID for an action stage - both are surfaced with
   * previews in the order detail, so the administrator judges with their eyes
   * before overriding. The original rejection report is never edited.
   */
  async qaOverrideStage({ actor, orderId, stage, candidateId, reason } = {}) {
    const admin = requireAdmin(actor);
    const safeReason = requiredString(reason, "Disposal reason", 200);
    const safeCandidateId = requiredString(candidateId, "Override candidate ID", 128);
    const parsed = parseStage(stage);
    const context = await this.repository.getAdminOrderRescueContext(requiredString(orderId, "Order ID"));
    if (!context) throw new Error("Order was not found");
    const run = context.run;
    if (!run || run.state !== PRODUCTION_STATES.FAILED) {
      throw stageUnavailableError("Only a failed production run can accept a QA override");
    }
    const expectedResume = ADMIN_RERUN_RESUME_STATES[parsed.kind === "action" ? "action" : parsed.stage];
    if (context.failedFromState !== expectedResume) {
      throw stageUnavailableError(
        `The run failed from ${context.failedFromState || "an unknown state"}; the ${parsed.stage} stage cannot be overridden`
      );
    }
    const override = { actorId: admin.id, reason: safeReason };

    let next;
    if (parsed.kind === "master" || parsed.kind === "sleep") {
      const wantedKind = parsed.kind === "sleep" ? "sleep" : parsed.view;
      const attempt = context.masterAttempts.find((candidate) => candidate.id === safeCandidateId);
      if (!attempt || attempt.kind !== wantedKind || attempt.status !== "qa_failed") {
        throw stageUnavailableError("The selected candidate is not a QA-rejected master attempt of this stage");
      }
      next = parsed.kind === "sleep"
        ? await this.workflow.adminOverrideSleepMaster({
            run, generationId: safeCandidateId, override, failedFromState: context.failedFromState
          })
        : await this.workflow.adminOverrideCharacterMaster({
            run, view: parsed.view, generationId: safeCandidateId, override, failedFromState: context.failedFromState
          });
    } else {
      const action = context.actions.find((candidate) => candidate.actionId === parsed.actionId);
      if (!action || action.state !== "failed") {
        throw stageUnavailableError(`Action ${parsed.actionId} is not in a failed state`);
      }
      const video = (context.rejectedActionVideos || []).find(
        (candidate) => candidate.assetId === safeCandidateId && candidate.actionId === parsed.actionId
      );
      if (!video) {
        throw stageUnavailableError("The selected video is not a QA-rejected provider output of this action");
      }
      next = await this.workflow.adminOverrideVideoAction({
        run,
        actionId: parsed.actionId,
        sourceAssetId: safeCandidateId,
        override,
        failedFromState: context.failedFromState
      });
    }
    await this._recordDisposal({
      actor: admin,
      context,
      eventType: "admin_qa_override_granted",
      metadata: {
        stage: parsed.stage,
        candidateId: safeCandidateId,
        reason: safeReason,
        runId: run.id,
        previousFailureCode: run.failureCode || null,
        resultState: next.state
      }
    });
    this.logger.warn?.("petpack.admin.qa_override_granted", {
      orderId: context.order.id,
      stage: parsed.stage,
      candidateId: safeCandidateId,
      resultState: next.state
    });
    return { mode: "qa_overridden", stage: parsed.stage, run: { id: next.id, state: next.state } };
  }

  async reissueDelivery({ actor, orderId, reason } = {}) {
    const admin = requireAdmin(actor);
    const safeReason = requiredString(reason, "Disposal reason", 200);
    const context = await this.repository.getAdminOrderRescueContext(requiredString(orderId, "Order ID"));
    if (!context) throw new Error("Order was not found");
    const delivery = await this.repository.extendDeliveryWindow({
      orderId: context.order.id,
      extendSeconds: this.deliveryReissueSeconds
    });
    await this._recordDisposal({
      actor: admin,
      context,
      eventType: "admin_delivery_reissued",
      metadata: { reason: safeReason, deliveryId: delivery.id, expiresAt: delivery.expiresAt }
    });
    this.logger.warn?.("petpack.admin.delivery_reissued", {
      orderId: context.order.id,
      expiresAt: delivery.expiresAt
    });
    return { mode: "delivery_reissued", delivery: { status: delivery.status, expiresAt: delivery.expiresAt, downloadCount: delivery.downloadCount } };
  }
}

module.exports = {
  AdminOrdersService,
  availableRescueStages,
  parseStage,
  summarizeQaReport
};
