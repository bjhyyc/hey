const { requireAdmin } = require("../auth/authorization");
const { REQUIRED_ACTION_IDS } = require("../domain/action-catalog");
const { PRODUCTION_STATES, ADMIN_RERUN_RESUME_STATES } = require("../domain/production-state-machine");
const { createAdminOperationsView } = require("./admin-operations-service");

const STAGE_PATTERN = /^(front_master|side_master|sleep_master|package|action:[a-z][a-z-]{0,31})$/;
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
    "extendDeliveryWindow",
    "createAdminRefund",
    "applyAdminRefundRequested",
    "completeAdminRefund",
    "getAdminUserView",
    "setAdminUserStatus"
  ];
  const missing = methods.filter((method) => !repository || typeof repository[method] !== "function");
  if (missing.length) throw new Error(`Administrator orders repository is incomplete: ${missing.join(", ")}`);
  return repository;
}

function refundDisabledError() {
  const error = new Error("Administrator refunds are not enabled on this deployment");
  error.code = "admin_refund_disabled";
  return error;
}

function refundUnavailableError(message) {
  const error = new Error(message);
  error.code = "admin_refund_unavailable";
  return error;
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

/**
 * Every rescue either spends provider money or hands back a download, so it
 * requires an order that is still paid for. Without this a refunded order
 * still offered its rescue buttons - and the state machine happily accepted
 * them, because a refund leaves the run `failed` exactly like any other
 * failure. Refunding then re-running would burn generation budget on an order
 * the customer no longer holds.
 */
function assertOrderEntitled(order) {
  if (!order || order.status !== "paid") {
    const error = new Error(`This order is ${order ? order.status : "unknown"}; rescues are available only while it is paid`);
    error.code = "admin_order_not_entitled";
    throw error;
  }
  return order;
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
  if (value === "package") return { kind: "package", stage: value };
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
  // A refunded or unpaid order gets no rescue buttons at all.
  if (!context.order || context.order.status !== "paid") return [];
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
  } else if (failedFrom === PRODUCTION_STATES.MEDIA_PROCESSING) {
    // Refused at the media gate: every master and video is still on record,
    // so the only disposal is to queue packaging again.
    stages.push({ stage: "package", mode: "rerun" });
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
    paymentProvider = null,
    refundEnabled = false,
    maxAdminRerunsPerOrder = DEFAULT_MAX_ADMIN_RERUNS_PER_ORDER,
    deliveryReissueSeconds = DEFAULT_DELIVERY_REISSUE_SECONDS,
    logger = console
  } = {}) {
    this.repository = requireOrdersRepository(repository);
    this.workflow = requireRescueWorkflow(workflow);
    this.objectStore = requireObjectStore(objectStore);
    if (typeof refundEnabled !== "boolean") throw new Error("refundEnabled must be a boolean");
    if (refundEnabled && (!paymentProvider || typeof paymentProvider.refund !== "function" || typeof paymentProvider.queryStatus !== "function")) {
      throw new Error("Enabled administrator refunds require a payment provider with refund and queryStatus");
    }
    this.paymentProvider = paymentProvider;
    this.refundEnabled = refundEnabled;
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
    assertOrderEntitled(context.order);
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
    } else if (parsed.kind === "package") {
      // Newer than the other rescues; a workflow without it simply cannot
      // offer this disposal rather than failing the whole service.
      if (typeof this.workflow.adminResumeMediaProcessing !== "function") {
        throw stageUnavailableError("This deployment cannot resume packaging");
      }
      next = await this.workflow.adminResumeMediaProcessing({ run, failedFromState: context.failedFromState });
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
    if (parsed.kind === "package") throw stageUnavailableError("Packaging has no QA verdict to override; resume it instead");
    const context = await this.repository.getAdminOrderRescueContext(requiredString(orderId, "Order ID"));
    if (!context) throw new Error("Order was not found");
    assertOrderEntitled(context.order);
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

  /**
   * The last resort, and one state-driven endpoint. On a paid order it
   * initiates the full-amount refund (reason required); on refund_pending it
   * queries the provider and converges to refunded when the money is
   * confirmed returned - the ordinary payment reconciliation deliberately
   * freezes refund states, so this poll is the only path forward; on a
   * refunded order it reports completion. Gated off by default until the
   * controlled real-refund acceptance in BLOCKED.md has been performed.
   */
  async refundOrder({ actor, orderId, reason } = {}) {
    const admin = requireAdmin(actor);
    if (!this.refundEnabled || !this.paymentProvider) throw refundDisabledError();
    const context = await this.repository.getAdminOrderRescueContext(requiredString(orderId, "Order ID"));
    if (!context) throw new Error("Order was not found");
    const order = context.order;

    if (order.status === "refunded") {
      return { mode: "refund_already_complete", order: { id: order.id, status: order.status } };
    }

    if (order.status === "refund_pending") {
      const reconciliation = await this.paymentProvider.queryStatus({ platformOrderId: order.id });
      if (reconciliation && reconciliation.state === "refunded") {
        await this.repository.completeAdminRefund({
          orderId: order.id,
          paymentEventKey: reconciliation.paymentEventKey
        });
        await this._recordDisposal({
          actor: admin,
          context,
          eventType: "admin_refund_confirmed",
          metadata: { reason: "provider_query_refunded" }
        });
        this.logger.warn?.("petpack.admin.refund_confirmed", { orderId: order.id });
        return { mode: "refund_confirmed", order: { id: order.id, status: "refunded" } };
      }
      this.logger.info?.("petpack.admin.refund_still_pending", {
        orderId: order.id,
        providerState: reconciliation ? reconciliation.state : null
      });
      return {
        mode: "refund_pending",
        order: { id: order.id, status: order.status },
        providerState: reconciliation ? reconciliation.state : null
      };
    }

    if (order.status !== "paid") {
      throw refundUnavailableError(`Only a paid order can be refunded; the order status is ${order.status}`);
    }
    const safeReason = requiredString(reason, "Refund reason", 200);
    const staged = await this.repository.createAdminRefund({
      orderId: order.id,
      actorId: admin.id,
      reason: safeReason
    });
    if (staged.amountFen !== order.amountFen) {
      throw refundUnavailableError("The staged refund amount does not match the order; partial refunds are not supported");
    }
    let providerResult;
    try {
      providerResult = await this.paymentProvider.refund({
        platformOrderId: order.id,
        // The refund row ID doubles as the stable unique refundRequestNo, so a
        // retry after a transport failure repeats the same provider request.
        refundId: staged.refundId,
        amountFen: staged.amountFen,
        reason: safeReason,
        idempotencyKey: `admin-refund:${order.id}`
      });
    } catch (error) {
      // Kaipay treats a replayed refundRequestNo as a conflict, not an
      // idempotent replay (business code 7, "refundRequestNo 已被其他退款请求
      // 占用" - learned from the first real refund on 2026-09-03, where the
      // refund succeeded at the provider while our response handling failed).
      // The conflict therefore proves OUR request number is already registered
      // there, so the order advances to refund_pending and the ordinary
      // reconciliation poll converges on the provider's verdict.
      if (error?.code !== "kaipay_business_error" || error?.providerCode !== 7) throw error;
      this.logger.warn?.("petpack.admin.refund_already_at_provider", {
        orderId: order.id,
        refundId: staged.refundId,
        providerMessage: error?.providerMessage || null
      });
      providerResult = { providerRefundId: null, alreadyAtProvider: true };
    }
    await this.repository.applyAdminRefundRequested({
      orderId: order.id,
      refundId: staged.refundId,
      providerRefundId: providerResult && typeof providerResult.providerRefundId === "string"
        ? providerResult.providerRefundId
        : null
    });
    await this._recordDisposal({
      actor: admin,
      context,
      eventType: "admin_refund_requested",
      metadata: {
        reason: safeReason,
        refundId: staged.refundId,
        amountFen: staged.amountFen,
        alreadyStaged: staged.alreadyRequested === true,
        alreadyAtProvider: providerResult.alreadyAtProvider === true
      }
    });
    this.logger.warn?.("petpack.admin.refund_requested", {
      orderId: order.id,
      refundId: staged.refundId,
      amountFen: staged.amountFen
    });
    return {
      mode: "refund_requested",
      order: { id: order.id, status: "refund_pending" },
      refund: { id: staged.refundId, amountFen: staged.amountFen }
    };
  }

  async getUserView({ actor, userId } = {}) {
    requireAdmin(actor);
    const view = await this.repository.getAdminUserView(requiredString(userId, "User ID"));
    if (!view) throw new Error("User was not found");
    this.logger.info?.("petpack.admin.user_viewed", { targetUserId: view.id, status: view.status });
    return view;
  }

  async setUserStatus({ actor, userId, status, reason } = {}) {
    const admin = requireAdmin(actor);
    const safeUserId = requiredString(userId, "User ID");
    const safeReason = requiredString(reason, "Disposal reason", 200);
    if (!["active", "disabled"].includes(status)) throw new Error("User status must be active or disabled");
    if (safeUserId === admin.id) {
      const error = new Error("An administrator cannot change their own account status");
      error.code = "admin_user_disposal_unavailable";
      throw error;
    }
    // The repository refuses non-user roles in its WHERE clause; the audit row
    // is written in the same transaction as the status change.
    const result = await this.repository.setAdminUserStatus({
      userId: safeUserId,
      status,
      actorId: admin.id,
      reason: safeReason
    });
    this.logger.warn?.("petpack.admin.user_status_changed", {
      targetUserId: safeUserId,
      status: result.status,
      revokedSessions: result.revokedSessions
    });
    return { user: { id: result.id, status: result.status }, revokedSessions: result.revokedSessions };
  }

  async reissueDelivery({ actor, orderId, reason } = {}) {
    const admin = requireAdmin(actor);
    const safeReason = requiredString(reason, "Disposal reason", 200);
    const context = await this.repository.getAdminOrderRescueContext(requiredString(orderId, "Order ID"));
    if (!context) throw new Error("Order was not found");
    assertOrderEntitled(context.order);
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
