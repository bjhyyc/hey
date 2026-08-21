/**
 * Local trial harness for the support console (`/admin/operations`).
 *
 * Development only. It runs the REAL HTTP API, the REAL AdminOperationsService
 * and AdminOrdersService, and the REAL production state machine, over an
 * in-memory fixture store and a stub payment provider. Nothing here touches
 * PostgreSQL, Kaipay, COS, or any deployed environment - which is the point:
 * the disposal buttons (rerun, force-pass, reissue, refund, disable account)
 * can all be pressed and observed without a real order or a real yuan.
 *
 * Every fixture order is one of the stuck shapes the console exists to rescue.
 * Media previews are served from this same process so images and videos really
 * render; the "signed grant" is a plain local URL, not a COS signature.
 *
 * Start:  node platform/src/development/start-admin-console-fixture.js
 * Then point apps/web at http://127.0.0.1:8788 and open /admin/operations.
 */

const http = require("node:http");
const crypto = require("node:crypto");

const { createPetPackStudioHttpApi } = require("../http/petpack-studio-http-api");
const { AdminOperationsService } = require("../api/admin-operations-service");
const { AdminOrdersService } = require("../api/admin-orders-service");
const { ProductionWorkflow } = require("../workflow/production-workflow");
const { PRODUCTION_STATES } = require("../domain/production-state-machine");
const { REQUIRED_ACTION_IDS } = require("../domain/action-catalog");
const { createFixtureMedia } = require("./admin-console-fixture-media");

const FIXTURE_ADMIN = Object.freeze({ id: "0f9f1a44-1111-4111-8111-000000000001", role: "admin" });
const MODEL_REGISTRY = Object.freeze({
  version: "seedream-seedance-480p-v1",
  modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
});

function uuid(seed) {
  const hash = crypto.createHash("sha256").update(String(seed)).digest("hex");
  return [hash.slice(0, 8), hash.slice(8, 12), `4${hash.slice(13, 16)}`, `8${hash.slice(17, 20)}`, hash.slice(20, 32)].join("-");
}

function isoAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * Six orders, each stuck in a different way, so every disposal path in the
 * console has something real to act on.
 */
function createFixtureState() {
  const users = new Map();
  const orders = new Map();
  const auditEvents = [];
  const refunds = new Map();

  function addUser(key, { status = "active" } = {}) {
    const id = uuid(`user:${key}`);
    users.set(id, {
      id,
      role: "user",
      status,
      createdAt: isoAgo(60 * 24 * 9),
      sessions: 2,
      prechecks24h: key === "abuser" ? 47 : 3
    });
    return id;
  }

  function masterAttempt({ order, kind, attempt, status, reasons = [] }) {
    return {
      id: uuid(`gen:${order}:${kind}:${attempt}`),
      kind,
      generationAttempt: attempt,
      status,
      lastErrorCode: null,
      qaStatus: status === "qa_passed" ? "passed" : "failed",
      qaReport: status === "qa_passed" ? { ok: true } : { ok: false, reasons },
      objectKey: `private/fixture/${order}/${kind}-${attempt}.png`,
      createdAt: isoAgo(120 - attempt * 5),
      updatedAt: isoAgo(115 - attempt * 5)
    };
  }

  function actionRows({ failedActionId = null, failedRetryCount = 2 } = {}) {
    return REQUIRED_ACTION_IDS.map((actionId) => actionId === failedActionId
      ? {
          actionId,
          state: "failed",
          retryCount: failedRetryCount,
          qaStatus: "failed",
          qaReport: { ok: false, reasons: ["主体被打穿一个洞（holePunched）", "末帧未回到正面坐姿"] },
          objectKey: `private/fixture/roll-final.webm`,
          updatedAt: isoAgo(20)
        }
      : { actionId, state: "qa_passed", retryCount: 0, qaStatus: "passed", qaReport: { ok: true }, objectKey: null, updatedAt: isoAgo(30) });
  }

  function addOrder(key, shape) {
    const orderId = uuid(`order:${key}`);
    const projectId = uuid(`project:${key}`);
    const runId = uuid(`run:${key}`);
    const record = {
      order: {
        id: orderId,
        userId: shape.userId,
        amountFen: 4900,
        currency: "CNY",
        paymentMethod: "KAIPAY",
        status: shape.orderStatus || "paid",
        paidAt: isoAgo(180),
        deliveryStatus: shape.deliveryStatus || "pending",
        planCode: "petpack-standard",
        createdAt: isoAgo(200),
        updatedAt: isoAgo(10)
      },
      project: {
        id: projectId,
        displayName: shape.displayName,
        state: shape.projectState || "producing",
        createdAt: isoAgo(200),
        updatedAt: isoAgo(10)
      },
      run: shape.run === null ? null : {
        id: runId,
        projectId,
        orderId,
        species: shape.species || "cat",
        modelRegistryVersion: MODEL_REGISTRY.version,
        characterRevisionId: shape.characterRevisionId === undefined ? uuid(`revision:${key}`) : shape.characterRevisionId,
        state: shape.runState,
        failureCode: shape.failureCode || null,
        frontGenerationAttempts: shape.frontGenerationAttempts ?? 3,
        sideGenerationAttempts: shape.sideGenerationAttempts ?? 1,
        frontUserRegenerationsUsed: shape.frontUserRegenerationsUsed ?? 0,
        sideUserRegenerationsUsed: shape.sideUserRegenerationsUsed ?? 0,
        frontQaRetries: shape.frontQaRetries ?? 2,
        sideQaRetries: 0,
        sleepGenerationAttempts: shape.sleepGenerationAttempts ?? 1,
        version: 7,
        createdAt: isoAgo(190),
        updatedAt: isoAgo(10)
      },
      failedFromState: shape.failedFromState || null,
      masterAttempts: shape.masterAttempts || [],
      actions: shape.actions || [],
      rejectedActionVideos: shape.rejectedActionVideos || [],
      delivery: shape.delivery || null,
      dispatch: shape.dispatch || { pending: 0, leased: 0, failed: 0, dead: 0 },
      timeline: shape.timeline || [
        { source: "payment", at: isoAgo(180), label: "provider_reconciliation", detail: "PAID -> paid" },
        { source: "run", at: isoAgo(178), label: "awaiting_photos", detail: "" },
        { source: "run", at: isoAgo(150), label: shape.runState || "producing", detail: "" }
      ]
    };
    orders.set(orderId, record);
    return record;
  }

  const normalUser = addUser("normal");
  const abuserUser = addUser("abuser");

  addOrder("front-failed", {
    userId: normalUser,
    displayName: "豆豆（正面母图三次未过）",
    runState: PRODUCTION_STATES.FAILED,
    failureCode: "front_master_qa_failed",
    failedFromState: PRODUCTION_STATES.AWAKE_GENERATING,
    characterRevisionId: null,
    sideGenerationAttempts: 0,
    masterAttempts: [
      masterAttempt({ order: "front-failed", kind: "front", attempt: 1, status: "qa_failed", reasons: ["主体偏离画布中心", "毛色与参照差异过大"] }),
      masterAttempt({ order: "front-failed", kind: "front", attempt: 2, status: "qa_failed", reasons: ["抠图边缘残留绿边"] }),
      masterAttempt({ order: "front-failed", kind: "front", attempt: 3, status: "qa_failed", reasons: ["面部结构变形（faceIdentityMinScore）"] })
    ],
    dispatch: { pending: 0, leased: 0, failed: 0, dead: 1 }
  });

  addOrder("sleep-failed", {
    userId: normalUser,
    displayName: "橘子（睡姿母图未过）",
    runState: PRODUCTION_STATES.FAILED,
    failureCode: "sleep_master_qa_failed",
    failedFromState: PRODUCTION_STATES.SLEEP_GENERATING,
    sleepGenerationAttempts: 3,
    masterAttempts: [
      masterAttempt({ order: "sleep-failed", kind: "front", attempt: 1, status: "qa_passed" }),
      masterAttempt({ order: "sleep-failed", kind: "side", attempt: 1, status: "qa_passed" }),
      masterAttempt({ order: "sleep-failed", kind: "sleep", attempt: 2, status: "qa_failed", reasons: ["前爪与毯子粘连", "身份一致性低于阈值"] }),
      masterAttempt({ order: "sleep-failed", kind: "sleep", attempt: 3, status: "qa_failed", reasons: ["睡姿轮廓破损"] })
    ]
  });

  const rollVideoAssetA = uuid("asset:roll:a");
  const rollVideoAssetB = uuid("asset:roll:b");
  addOrder("action-failed", {
    userId: normalUser,
    displayName: "小黑（打滚动作三次未过）",
    runState: PRODUCTION_STATES.FAILED,
    failureCode: "action_qa_failed",
    failedFromState: PRODUCTION_STATES.VIDEO_GENERATING,
    masterAttempts: [
      masterAttempt({ order: "action-failed", kind: "front", attempt: 1, status: "qa_passed" }),
      masterAttempt({ order: "action-failed", kind: "side", attempt: 1, status: "qa_passed" }),
      masterAttempt({ order: "action-failed", kind: "sleep", attempt: 1, status: "qa_passed" })
    ],
    actions: actionRows({ failedActionId: "roll", failedRetryCount: 2 }),
    rejectedActionVideos: [
      {
        actionId: "roll",
        assetId: rollVideoAssetA,
        qaReport: { ok: false, reasons: ["整体悬空，未贴地基线"] },
        rejectedAt: isoAgo(60),
        objectKey: "private/fixture/roll-attempt-1.webm"
      },
      {
        actionId: "roll",
        assetId: rollVideoAssetB,
        qaReport: { ok: false, reasons: ["末帧质心偏移 14px（阈值 12px）"] },
        rejectedAt: isoAgo(25),
        objectKey: "private/fixture/roll-attempt-2.webm"
      }
    ],
    dispatch: { pending: 0, leased: 0, failed: 0, dead: 1 }
  });

  addOrder("soft-stuck", {
    userId: normalUser,
    displayName: "花卷（重生成用完仍不满意）",
    runState: PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION,
    projectState: "awaiting_confirmation",
    frontUserRegenerationsUsed: 2,
    sideUserRegenerationsUsed: 2,
    masterAttempts: [
      masterAttempt({ order: "soft-stuck", kind: "front", attempt: 1, status: "qa_passed" }),
      masterAttempt({ order: "soft-stuck", kind: "front", attempt: 3, status: "qa_passed" }),
      masterAttempt({ order: "soft-stuck", kind: "side", attempt: 1, status: "qa_passed" })
    ]
  });

  addOrder("delivery-expired", {
    userId: normalUser,
    displayName: "奶昔（下载链接已过期）",
    runState: PRODUCTION_STATES.DELIVERABLE,
    projectState: "deliverable",
    deliveryStatus: "ready",
    masterAttempts: [
      masterAttempt({ order: "delivery-expired", kind: "front", attempt: 1, status: "qa_passed" }),
      masterAttempt({ order: "delivery-expired", kind: "side", attempt: 1, status: "qa_passed" }),
      masterAttempt({ order: "delivery-expired", kind: "sleep", attempt: 1, status: "qa_passed" })
    ],
    actions: actionRows(),
    delivery: {
      id: uuid("delivery:expired"),
      status: "ready",
      downloadCount: 1,
      expiresAt: isoAgo(60 * 24),
      assetRetained: true,
      updatedAt: isoAgo(60 * 24)
    }
  });

  addOrder("refund-candidate", {
    userId: abuserUser,
    displayName: "闪电（打包验证反复失败，候选退款）",
    runState: PRODUCTION_STATES.FAILED,
    failureCode: "package_validation_failed",
    failedFromState: PRODUCTION_STATES.VALIDATING,
    masterAttempts: [
      masterAttempt({ order: "refund-candidate", kind: "front", attempt: 1, status: "qa_passed" }),
      masterAttempt({ order: "refund-candidate", kind: "side", attempt: 1, status: "qa_passed" }),
      masterAttempt({ order: "refund-candidate", kind: "sleep", attempt: 1, status: "qa_passed" })
    ],
    actions: actionRows(),
    dispatch: { pending: 0, leased: 0, failed: 2, dead: 1 }
  });

  return { users, orders, auditEvents, refunds };
}

function attentionOf(record) {
  const reasons = [];
  if (["payment_review", "expired", "refund_pending", "refunded"].includes(record.order.status)) reasons.push("payment_attention");
  if (record.run && record.run.state === "failed") reasons.push("run_failed");
  if (record.run && record.run.state === "awaiting_character_confirmation" &&
      (record.run.frontUserRegenerationsUsed >= 2 || record.run.sideUserRegenerationsUsed >= 2)) {
    reasons.push("regenerations_exhausted");
  }
  if (record.delivery && record.delivery.status === "ready" && record.delivery.expiresAt &&
      new Date(record.delivery.expiresAt).getTime() < Date.now()) {
    reasons.push("delivery_expired");
  }
  if (record.run && record.run.failureCode) reasons.push("run_failure_recorded");
  if (record.actions.some((action) => action.state === "failed")) reasons.push("action_failed");
  if (record.dispatch.dead > 0) reasons.push("outbox_dead");
  return reasons;
}

/**
 * The operations-feed row shape the real repository produces. Only the fields
 * the redacting view reads are present.
 */
function feedRow(record) {
  return {
    activityAt: record.order.updatedAt,
    order: {
      id: record.order.id,
      status: record.order.status,
      paymentMethod: record.order.paymentMethod,
      amountFen: record.order.amountFen,
      paidAt: record.order.paidAt,
      createdAt: record.order.createdAt,
      updatedAt: record.order.updatedAt
    },
    project: {
      id: record.project.id,
      state: record.project.state,
      createdAt: record.project.createdAt,
      updatedAt: record.project.updatedAt
    },
    run: record.run ? {
      id: record.run.id,
      characterRevisionId: record.run.characterRevisionId,
      state: record.run.state,
      hasFailure: Boolean(record.run.failureCode),
      awakeGenerationAttempts: record.run.frontGenerationAttempts,
      sleepGenerationAttempts: record.run.sleepGenerationAttempts,
      frontUserRegenerationsUsed: record.run.frontUserRegenerationsUsed,
      sideUserRegenerationsUsed: record.run.sideUserRegenerationsUsed,
      version: record.run.version,
      updatedAt: record.run.updatedAt
    } : null,
    actions: record.actions.map((action) => ({
      actionId: action.actionId,
      state: action.state,
      retryCount: action.retryCount,
      updatedAt: action.updatedAt
    })),
    delivery: record.delivery ? {
      status: record.delivery.status,
      downloadCount: record.delivery.downloadCount,
      expiresAt: record.delivery.expiresAt,
      updatedAt: record.delivery.updatedAt
    } : null,
    outbox: record.dispatch
  };
}

function createFixtureRepository(state, logger) {
  function requireRecord(orderId) {
    const record = state.orders.get(orderId);
    if (!record) throw new Error("Order was not found");
    return record;
  }
  function touch(record) {
    record.order.updatedAt = new Date().toISOString();
    if (record.run) record.run.updatedAt = record.order.updatedAt;
  }
  return {
    _state: state,
    _requireRecord: requireRecord,
    _touch: touch,

    async listAdminOperations(query = {}) {
      const all = [...state.orders.values()];
      const filtered = query.status === "attention" || query.status === undefined
        ? all.filter((record) => attentionOf(record).length > 0)
        : all;
      const items = (query.status === "all" ? all : filtered).map(feedRow);
      items.sort((left, right) => String(right.activityAt).localeCompare(String(left.activityAt)));
      return { items, nextCursor: null, limit: query.limit || 50, status: query.status || "attention" };
    },

    async findAdminOperations({ orderId = null, projectId = null } = {}) {
      const all = [...state.orders.values()];
      const found = orderId
        ? all.filter((record) => record.order.id === orderId)
        : all.filter((record) => record.project.id === projectId);
      return found.map(feedRow);
    },

    async getAdminOrderRescueContext(orderId) {
      const record = state.orders.get(orderId);
      if (!record) return null;
      return {
        order: { ...record.order },
        project: { ...record.project },
        run: record.run ? { ...record.run } : null,
        failedFromState: record.failedFromState,
        adminRerunCount: state.auditEvents.filter(
          (event) => event.orderId === orderId && event.eventType === "admin_rerun_granted"
        ).length,
        masterAttempts: record.masterAttempts.map((attempt) => ({ ...attempt })),
        actions: record.actions.map((action) => ({ ...action })),
        rejectedActionVideos: record.rejectedActionVideos.map((video) => ({ ...video })),
        delivery: record.delivery ? { ...record.delivery } : null,
        dispatch: { ...record.dispatch },
        timeline: [...record.timeline].sort((left, right) => String(right.at).localeCompare(String(left.at)))
      };
    },

    async recordAdminAuditEvent({ actorId, projectId, orderId, eventType, metadata }) {
      state.auditEvents.push({ actorId, projectId, orderId, eventType, metadata, at: new Date().toISOString() });
      const record = state.orders.get(orderId);
      if (record) {
        record.timeline.unshift({
          source: "admin",
          at: new Date().toISOString(),
          label: eventType,
          detail: (metadata && (metadata.stage || metadata.reason)) || ""
        });
      }
      logger.info?.("fixture.audit", { eventType, orderId });
      return { recorded: true };
    },

    async extendDeliveryWindow({ orderId, extendSeconds }) {
      const record = requireRecord(orderId);
      if (!record.delivery || record.delivery.status !== "ready" || record.delivery.assetRetained !== true) {
        const error = new Error("PetPack delivery cannot be reissued: the package is not ready or is no longer retained");
        error.code = "delivery_reissue_unavailable";
        throw error;
      }
      record.delivery.expiresAt = new Date(Date.now() + extendSeconds * 1000).toISOString();
      record.delivery.updatedAt = new Date().toISOString();
      touch(record);
      return { ...record.delivery };
    },

    async createAdminRefund({ orderId, actorId, reason }) {
      const record = requireRecord(orderId);
      if (record.order.status !== "paid") {
        const error = new Error(`Only a paid order can be refunded; the order status is ${record.order.status}`);
        error.code = "admin_refund_unavailable";
        throw error;
      }
      const existing = state.refunds.get(orderId);
      if (existing) return { ...existing, alreadyRequested: true };
      const refund = { refundId: uuid(`refund:${orderId}`), amountFen: record.order.amountFen, status: "requested" };
      state.refunds.set(orderId, refund);
      state.auditEvents.push({ actorId, orderId, eventType: "admin_refund_staged", metadata: { reason }, at: new Date().toISOString() });
      return { ...refund, alreadyRequested: false };
    },

    async applyAdminRefundRequested({ orderId }) {
      const record = requireRecord(orderId);
      record.order.status = "refund_pending";
      if (record.delivery) record.delivery.status = "revoked";
      let runsStopped = 0;
      if (record.run && !["deliverable", "failed"].includes(record.run.state)) {
        record.run.state = "failed";
        record.run.failureCode = "order_refunded";
        runsStopped = 1;
      }
      const refund = state.refunds.get(orderId);
      if (refund) refund.status = "processing";
      touch(record);
      return { orderStatus: record.order.status, refundStatus: "processing", runsStopped };
    },

    async completeAdminRefund({ orderId }) {
      const record = requireRecord(orderId);
      record.order.status = "refunded";
      const refund = state.refunds.get(orderId);
      if (refund) refund.status = "success";
      touch(record);
      return { orderStatus: record.order.status };
    },

    async getAdminUserView(userId) {
      const user = state.users.get(userId);
      if (!user) return null;
      const recentOrders = [...state.orders.values()]
        .filter((record) => record.order.userId === userId)
        .map((record) => ({
          id: record.order.id,
          projectId: record.project.id,
          status: record.order.status,
          amountFen: record.order.amountFen,
          createdAt: record.order.createdAt
        }));
      return {
        id: user.id,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        orderCount: recentOrders.length,
        activeSessions: user.status === "disabled" ? 0 : user.sessions,
        prechecks24h: user.prechecks24h,
        recentOrders
      };
    },

    async setAdminUserStatus({ userId, status, actorId, reason }) {
      const user = state.users.get(userId);
      if (!user || user.role !== "user") {
        const error = new Error("Only an existing customer account can have its status changed");
        error.code = "admin_user_disposal_unavailable";
        throw error;
      }
      const revokedSessions = status === "disabled" ? user.sessions : 0;
      user.status = status;
      if (status === "disabled") user.sessions = 0;
      else user.sessions = 1;
      state.auditEvents.push({
        actorId,
        eventType: status === "disabled" ? "admin_user_disabled" : "admin_user_enabled",
        metadata: { targetUserId: userId, reason, revokedSessions },
        at: new Date().toISOString()
      });
      return { id: userId, status, revokedSessions };
    }
  };
}

/**
 * Applies to the fixture what the real store commits transactionally. Each
 * method mirrors the persisted effects the console's next refresh should show.
 */
function createFixtureRunStore(repository, logger) {
  function record(runId) {
    for (const candidate of repository._state.orders.values()) {
      if (candidate.run && candidate.run.id === runId) return candidate;
    }
    throw new Error("Fixture run was not found");
  }
  function applyRun(runId, next) {
    const found = record(runId);
    found.run = { ...found.run, ...next, version: found.run.version + 1 };
    found.timeline.unshift({ source: "run", at: new Date().toISOString(), label: found.run.state, detail: "" });
    repository._touch(found);
    return { ...found.run };
  }
  return {
    async commitTransition({ run, jobs = [] }) {
      logger.info?.("fixture.transition", { runId: run.id, state: run.state, jobs: jobs.map((job) => job.name) });
      return applyRun(run.id, run);
    },
    async commitAdminActionRerun({ run, actionId }) {
      const found = record(run.id);
      found.actions = found.actions.map((action) => action.actionId === actionId
        ? { ...action, state: "queued", retryCount: action.retryCount + 1, qaStatus: null, qaReport: null, objectKey: null, updatedAt: new Date().toISOString() }
        : action);
      return applyRun(run.id, run);
    },
    async commitAdminMasterQaOverride({ run, view, generationId }) {
      const found = record(run.id);
      found.masterAttempts = found.masterAttempts.map((attempt) => attempt.id === generationId
        ? { ...attempt, status: "qa_passed", qaStatus: "passed", qaReport: { ok: true, adminOverride: { actorId: FIXTURE_ADMIN.id } }, updatedAt: new Date().toISOString() }
        : attempt);
      logger.info?.("fixture.master_override", { view, generationId });
      return applyRun(run.id, run);
    },
    async commitAdminSleepQaOverride({ run, generationId }) {
      const found = record(run.id);
      found.masterAttempts = found.masterAttempts.map((attempt) => attempt.id === generationId
        ? { ...attempt, status: "qa_passed", qaStatus: "passed", qaReport: { ok: true, adminOverride: { actorId: FIXTURE_ADMIN.id } }, updatedAt: new Date().toISOString() }
        : attempt);
      return applyRun(run.id, run);
    },
    async commitAdminActionQaOverride({ run, actionId, sourceAssetId }) {
      const found = record(run.id);
      found.actions = found.actions.map((action) => action.actionId === actionId
        ? { ...action, state: "succeeded", qaStatus: null, qaReport: null, updatedAt: new Date().toISOString() }
        : action);
      found.rejectedActionVideos = found.rejectedActionVideos.filter((video) => video.assetId !== sourceAssetId);
      return applyRun(run.id, run);
    },
    async getPromptGateMasters() {
      return {
        frontMaster: { objectKey: "private/fixture/front.png" },
        sideMaster: { objectKey: "private/fixture/side.png" },
        sleepMaster: { objectKey: "private/fixture/sleep.png" }
      };
    }
  };
}

function createFixtureObjectStore(mediaBaseUrl) {
  return {
    policy: {},
    async createDownloadGrant({ objectKey }) {
      const name = String(objectKey).split("/").pop();
      return { url: `${mediaBaseUrl}/${name}`, expiresInSeconds: 600 };
    },
    async createUploadGrant() { throw new Error("not used by the console"); },
    async verifyUploadedObject() { throw new Error("not used by the console"); }
  };
}

/**
 * Stub Kaipay: the first status query still reports the refund in flight, the
 * next one reports it returned, so the console's "查退款结果" button shows both
 * outcomes without a real merchant call.
 */
function createFixturePaymentProvider(logger) {
  const polls = new Map();
  return {
    async refund({ platformOrderId, refundId, amountFen }) {
      logger.warn?.("fixture.refund_requested", { platformOrderId, refundId, amountFen });
      return { state: "refund_pending", providerRefundId: `fixture-rf-${refundId.slice(0, 8)}` };
    },
    async queryStatus({ platformOrderId }) {
      const seen = (polls.get(platformOrderId) || 0) + 1;
      polls.set(platformOrderId, seen);
      const state = seen >= 2 ? "refunded" : "refund_pending";
      logger.info?.("fixture.refund_query", { platformOrderId, poll: seen, state });
      return { state, paymentEventKey: `fixture-event-${platformOrderId}-${seen}`, applyToOrder: true };
    },
    async createCheckout() { throw new Error("not used by the console"); },
    async handleNotification() { throw new Error("not used by the console"); }
  };
}

async function main({ port = 8788, logger = console } = {}) {
  const media = await createFixtureMedia({ logger });
  const state = createFixtureState();
  const repository = createFixtureRepository(state, logger);
  const runStore = createFixtureRunStore(repository, logger);
  const workflow = new ProductionWorkflow({
    runStore,
    queue: { enqueue: async (job) => logger.info?.("fixture.enqueue", { job: job.name }) },
    promptStore: {
      listPublishedMetadata: async () => REQUIRED_ACTION_IDS.map((actionId) => ({
        actionId,
        promptVersionId: uuid(`prompt:${actionId}`),
        version: "fixture-v1",
        status: "published"
      }))
    },
    modelRegistry: MODEL_REGISTRY,
    logger
  });
  const mediaBaseUrl = `http://127.0.0.1:${port}/fixture-media`;
  const adminOrdersService = new AdminOrdersService({
    repository,
    workflow,
    objectStore: createFixtureObjectStore(mediaBaseUrl),
    paymentProvider: createFixturePaymentProvider(logger),
    // Enabled here so the button can be exercised; production keeps this off
    // until the controlled real-refund acceptance in BLOCKED.md is done.
    refundEnabled: true,
    logger
  });
  const api = createPetPackStudioHttpApi({
    adminOperationsService: new AdminOperationsService({ repository, logger }),
    adminOrdersService,
    // The site chrome asks for a session on every page. Without an auth
    // service those routes do not exist and every page reports "接口不存在",
    // which reads like a broken build rather than a harness boundary.
    // Real phone login needs CloudBase SMS and cannot run locally; here the
    // session simply always exists and is always the fixture administrator.
    authService: {
      exchangeCloudBaseAccessToken: async () => {
        const error = new Error("Phone login needs CloudBase and cannot run in the local harness");
        error.code = "fixture_login_unavailable";
        throw error;
      },
      revokeSessionToken: async () => ({ revoked: true }),
      resolveSessionToken: async () => FIXTURE_ADMIN
    },
    sessionCookieName: "petpack_session",
    secureSessionCookie: false,
    // Development harness: every request is the fixture administrator. The real
    // deployment resolves this from a signed session cookie.
    resolveActor: async () => FIXTURE_ADMIN,
    logger
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith("/fixture-media/")) {
      const asset = media.get(url.pathname.slice("/fixture-media/".length));
      if (!asset) {
        response.writeHead(404).end("not found");
        return;
      }
      response.writeHead(200, { "content-type": asset.contentType, "content-length": asset.body.length, "cache-control": "no-store" });
      response.end(asset.body);
      return;
    }
    if (url.pathname === "/livez") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
      return;
    }
    // Only the console's own surface is implemented here. Saying so beats a
     // bare "接口不存在", which looks like a regression in the API itself.
    const servedPrefixes = ["/api/admin/", "/api/auth/"];
    if (url.pathname.startsWith("/api/") && !servedPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
      const payload = JSON.stringify({
        error: {
          code: "fixture_route_not_implemented",
          message: "本地试用装置只提供管理台与会话接口；该接口请在完整环境中使用"
        }
      });
      response.writeHead(501, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
      response.end(payload);
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const result = await api.handle({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body,
      rawBody: body
    });
    const payload = JSON.stringify(result.body === undefined ? {} : result.body);
    response.writeHead(result.status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(payload)
    });
    response.end(payload);
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  logger.info?.("fixture.ready", { port, orders: state.orders.size });
  process.stdout.write(`admin console fixture API listening on http://127.0.0.1:${port}\n`);
  for (const record of state.orders.values()) {
    process.stdout.write(`  ${record.project.displayName} -> order ${record.order.id}\n`);
  }
  return { server, state };
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`admin console fixture failed: ${error && error.message}\n`);
    process.exit(1);
  });
}

module.exports = { main, createFixtureState, createFixtureRepository };
