const { requireAdmin } = require("../auth/authorization");
const {
  decodeAdminOperationsCursor,
  normalizeAdminOperationsQuery
} = require("../persistence/postgres-petpack-studio-repository");

const PAYMENT_ATTENTION_STATES = new Set([
  "payment_review",
  "expired",
  "refund_pending",
  "refunded"
]);

function requireOperationsRepository(repository) {
  if (!repository || typeof repository.listAdminOperations !== "function") {
    throw new Error("An administrator operations repository is required");
  }
  return repository;
}

function nonNegativeInteger(value) {
  const numeric = Number(value || 0);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function redactAction(action) {
  return {
    actionId: action.actionId,
    state: action.state,
    retryCount: nonNegativeInteger(action.retryCount),
    updatedAt: action.updatedAt || null
  };
}

function safeNextCursor(value) {
  if (value === null || value === undefined) return null;
  // The cursor is opaque pagination state, never a link. Re-validating the
  // repository result avoids forwarding an accidentally added URL or payload.
  decodeAdminOperationsCursor(value);
  return value;
}

/**
 * Explicitly maps only operations-safe fields. Do not spread repository rows
 * here: prompt text, private object keys, URLs, provider payloads/IDs, and
 * customer/account data must remain inaccessible even to the default admin
 * feed response.
 */
function createAdminOperationsView(record) {
  const actions = Array.isArray(record.actions) ? record.actions.map(redactAction) : [];
  const outbox = record.outbox || {};
  const failedActionIds = actions.filter((action) => action.state === "failed").map((action) => action.actionId);
  const attentionReasons = [];
  if (PAYMENT_ATTENTION_STATES.has(record.order.status)) attentionReasons.push("payment_attention");
  if (record.run && record.run.state === "failed") attentionReasons.push("run_failed");
  if (record.run && record.run.hasFailure) attentionReasons.push("run_failure_recorded");
  if (failedActionIds.length > 0) attentionReasons.push("action_failed");
  if (nonNegativeInteger(outbox.failed) > 0) attentionReasons.push("outbox_retrying");
  if (nonNegativeInteger(outbox.dead) > 0) attentionReasons.push("outbox_dead");

  return {
    lastActivityAt: record.activityAt,
    order: {
      id: record.order.id,
      amountFen: record.order.amountFen,
      createdAt: record.order.createdAt || null,
      updatedAt: record.order.updatedAt || null
    },
    project: {
      id: record.project.id,
      state: record.project.state,
      createdAt: record.project.createdAt || null,
      updatedAt: record.project.updatedAt || null
    },
    payment: {
      state: record.order.status,
      method: record.order.paymentMethod,
      paidAt: record.order.paidAt || null
    },
    run: record.run ? {
      id: record.run.id,
      characterRevisionId: record.run.characterRevisionId || null,
      state: record.run.state,
      hasFailure: Boolean(record.run.hasFailure),
      awakeGenerationAttempts: nonNegativeInteger(record.run.awakeGenerationAttempts),
      sleepGenerationAttempts: nonNegativeInteger(record.run.sleepGenerationAttempts),
      version: nonNegativeInteger(record.run.version),
      updatedAt: record.run.updatedAt || null
    } : null,
    actions,
    delivery: record.delivery ? {
      status: record.delivery.status,
      downloadCount: nonNegativeInteger(record.delivery.downloadCount),
      expiresAt: record.delivery.expiresAt || null,
      updatedAt: record.delivery.updatedAt || null
    } : null,
    dispatch: {
      pending: nonNegativeInteger(outbox.pending),
      leased: nonNegativeInteger(outbox.leased),
      failed: nonNegativeInteger(outbox.failed),
      dead: nonNegativeInteger(outbox.dead)
    },
    attention: {
      required: attentionReasons.length > 0,
      reasons: attentionReasons,
      failedActionIds
    }
  };
}

class AdminOperationsService {
  constructor({ repository, logger = console } = {}) {
    this.repository = requireOperationsRepository(repository);
    this.logger = logger;
  }

  async listOperations({ actor, cursor, limit, status } = {}) {
    requireAdmin(actor);
    const query = normalizeAdminOperationsQuery({ cursor, limit, status });
    const page = await this.repository.listAdminOperations(query);
    const items = Array.isArray(page && page.items) ? page.items.map(createAdminOperationsView) : [];
    const response = {
      items,
      page: {
        limit: query.limit,
        status: query.status,
        nextCursor: safeNextCursor(page && page.nextCursor)
      }
    };
    this.logger.info?.("petpack.admin.operations_listed", {
      status: query.status,
      returned: items.length,
      hasNextPage: Boolean(response.page.nextCursor)
    });
    return response;
  }
}

module.exports = {
  AdminOperationsService,
  createAdminOperationsView
};
