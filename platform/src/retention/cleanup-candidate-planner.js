const { createHash } = require("node:crypto");
const { requireAdmin } = require("../auth/authorization");
const {
  MEDIA_KINDS,
  RETENTION_PLAN_MODE,
  assertDryRunMode,
  isAutomaticCandidateKind,
  isKnownMediaKind,
  normalizeCleanupQuery,
  normalizeRetentionPolicy,
  objectKeyMatchesMediaKind
} = require("./retention-policy-contract");

const BLOCKING_REASONS = Object.freeze({
  POLICY_DISABLED: "policy_disabled",
  AUTOMATIC_CLEANUP_UNSUPPORTED: "automatic_cleanup_unsupported",
  UNTRACKED_OBJECT: "untracked_object",
  INVENTORY_INVALID: "inventory_invalid",
  DEPENDENCIES_UNVERIFIED: "dependencies_unverified",
  UNKNOWN_DEPENDENCY: "unknown_dependency",
  OBJECT_KEY_CLASS_MISMATCH: "object_key_class_mismatch",
  ASSET_ALREADY_TOMBSTONED: "asset_already_tombstoned",
  CREATED_AT_INVALID: "created_at_invalid",
  CREATED_AT_IN_FUTURE: "created_at_in_future",
  RETENTION_WINDOW_NOT_ELAPSED: "retention_window_not_elapsed",
  ACTIVE_RUN: "active_run",
  ACTIVE_JOB: "active_job",
  ACTIVE_OUTBOX: "active_outbox",
  RECONCILIATION_REQUIRED: "reconciliation_required",
  RETENTION_HOLD: "retention_hold",
  SOURCE_PHOTO_REFERENCE: "source_photo_reference",
  MASTER_FRAME_REFERENCE: "master_frame_reference",
  ACTION_MASTER_FRAME_REFERENCE: "action_master_frame_reference",
  CHARACTER_REVISION_REFERENCE: "character_revision_reference",
  IMAGE_CANDIDATE_REFERENCE: "image_candidate_reference",
  MASTER_GENERATION_REFERENCE: "master_generation_reference",
  QA_EVIDENCE_REFERENCE: "qa_evidence_reference",
  GENERATION_ACTION_REFERENCE: "generation_action_reference",
  PETPACK_SNAPSHOT_REFERENCE: "petpack_snapshot_reference",
  PETPACK_BUILD_REFERENCE: "petpack_build_reference",
  VALIDATION_EVIDENCE_REFERENCE: "validation_evidence_reference",
  LIVE_DELIVERY: "live_delivery",
  PAYMENT_ATTENTION: "payment_attention",
  SOURCE_RESERVATION_REFERENCE: "source_reservation_reference",
  SOURCE_RESERVATION_UNSETTLED: "source_reservation_unsettled"
});

const REPOSITORY_BLOCKER_SET = new Set(Object.values(BLOCKING_REASONS).filter((reason) => ![
  BLOCKING_REASONS.POLICY_DISABLED,
  BLOCKING_REASONS.AUTOMATIC_CLEANUP_UNSUPPORTED,
  BLOCKING_REASONS.UNTRACKED_OBJECT,
  BLOCKING_REASONS.INVENTORY_INVALID,
  BLOCKING_REASONS.DEPENDENCIES_UNVERIFIED,
  BLOCKING_REASONS.UNKNOWN_DEPENDENCY,
  BLOCKING_REASONS.OBJECT_KEY_CLASS_MISMATCH,
  BLOCKING_REASONS.ASSET_ALREADY_TOMBSTONED,
  BLOCKING_REASONS.CREATED_AT_INVALID,
  BLOCKING_REASONS.CREATED_AT_IN_FUTURE,
  BLOCKING_REASONS.RETENTION_WINDOW_NOT_ELAPSED
].includes(reason)));

function requireCleanupRepository(repository) {
  if (!repository || typeof repository.listCleanupInventory !== "function") {
    throw new Error("A cleanup inventory repository is required");
  }
  return repository;
}

function requireAdministratorAuthorizer(authorizeAdmin) {
  if (typeof authorizeAdmin !== "function") throw new Error("An administrator authorizer is required");
  return authorizeAdmin;
}

function normalizePlanTime(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Cleanup planning time is invalid");
  return date;
}

function normalizePage(page, limit) {
  const normalized = Array.isArray(page) ? { items: page, nextCursor: null } : page;
  if (!normalized || typeof normalized !== "object" || !Array.isArray(normalized.items)) {
    throw new Error("Cleanup inventory repository returned an invalid page");
  }
  if (normalized.items.length > limit) {
    throw new Error("Cleanup inventory repository exceeded the requested page limit");
  }
  const nextCursor = normalized.nextCursor === undefined || normalized.nextCursor === null ? null : normalized.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(nextCursor))) {
    throw new Error("Cleanup inventory repository returned an invalid cursor");
  }
  return { items: normalized.items, nextCursor };
}

function validAssetIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function normalizeRepositoryBlockers(value) {
  if (!Array.isArray(value)) return [BLOCKING_REASONS.DEPENDENCIES_UNVERIFIED];
  const reasons = new Set();
  for (const candidate of value) {
    if (typeof candidate === "string" && REPOSITORY_BLOCKER_SET.has(candidate)) reasons.add(candidate);
    else reasons.add(BLOCKING_REASONS.UNKNOWN_DEPENDENCY);
  }
  return [...reasons].sort();
}

function inventoryAsset(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) || !record.asset ||
    typeof record.asset !== "object" || Array.isArray(record.asset)) {
    return null;
  }
  return record.asset;
}

function safeKind(asset) {
  return asset && isKnownMediaKind(asset.kind) ? asset.kind : "unknown";
}

function candidateId({ policyVersion, asset }) {
  return `cc_${createHash("sha256")
    .update("petpack-cleanup-candidate-v1\u0000")
    .update(policyVersion)
    .update("\u0000")
    .update(asset.id)
    .update("\u0000")
    .update(asset.kind)
    .update("\u0000")
    .update(asset.objectKey)
    .update("\u0000")
    .update(asset.sha256.toLowerCase())
    .digest("hex")}`;
}

function assessInventoryRecord(record, { policy, asOf }) {
  const asset = inventoryAsset(record);
  const kind = safeKind(asset);
  const reasons = new Set();
  if (!asset || kind === "unknown") reasons.add(BLOCKING_REASONS.INVENTORY_INVALID);

  if (!asset || record.tracked !== true) reasons.add(BLOCKING_REASONS.UNTRACKED_OBJECT);
  if (kind !== "unknown" && !isAutomaticCandidateKind(kind)) {
    reasons.add(BLOCKING_REASONS.AUTOMATIC_CLEANUP_UNSUPPORTED);
  }
  if (kind !== "unknown" && !policy.rules[kind].enabled) reasons.add(BLOCKING_REASONS.POLICY_DISABLED);

  if (asset) {
    if (!validAssetIdentifier(asset.id) || !validSha256(asset.sha256)) reasons.add(BLOCKING_REASONS.INVENTORY_INVALID);
    if (asset.deletedAt !== null && asset.deletedAt !== undefined) reasons.add(BLOCKING_REASONS.ASSET_ALREADY_TOMBSTONED);
    if (kind !== "unknown" && !objectKeyMatchesMediaKind(asset.objectKey, kind)) {
      reasons.add(BLOCKING_REASONS.OBJECT_KEY_CLASS_MISMATCH);
    }

    const createdAt = normalizeAssetCreatedAt(asset.createdAt);
    if (!createdAt) {
      reasons.add(BLOCKING_REASONS.CREATED_AT_INVALID);
    } else if (createdAt.getTime() > asOf.getTime()) {
      reasons.add(BLOCKING_REASONS.CREATED_AT_IN_FUTURE);
    } else if (kind !== "unknown" && policy.rules[kind].enabled &&
      asOf.getTime() - createdAt.getTime() < policy.rules[kind].minimumAgeMs) {
      reasons.add(BLOCKING_REASONS.RETENTION_WINDOW_NOT_ELAPSED);
    }
  }

  for (const reason of normalizeRepositoryBlockers(record && record.blockers)) reasons.add(reason);
  const normalizedReasons = [...reasons].sort();
  const createdAt = asset ? normalizeAssetCreatedAt(asset.createdAt) : null;
  const rule = kind === "unknown" ? null : policy.rules[kind];
  if (normalizedReasons.length > 0) return { kind, reasons: normalizedReasons };
  return {
    kind,
    candidate: {
      candidateId: candidateId({ policyVersion: policy.version, asset }),
      kind,
      eligibleAt: new Date(createdAt.getTime() + rule.minimumAgeMs).toISOString()
    }
  };
}

function normalizeAssetCreatedAt(value) {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function createSummary() {
  return {
    inspected: 0,
    candidates: 0,
    blocked: 0,
    candidatesByKind: Object.fromEntries(MEDIA_KINDS.map((kind) => [kind, 0])),
    blockedByReason: {}
  };
}

function addBlockedSummary(summary, reasons) {
  summary.blocked += 1;
  for (const reason of reasons) {
    summary.blockedByReason[reason] = (summary.blockedByReason[reason] || 0) + 1;
  }
}

/**
 * Read-only Stage 7 candidate planner. The injected repository supplies a
 * dependency-complete inventory, but this class never receives a storage
 * driver, has no mutation path, and emits only redacted candidate references.
 *
 * Inventory item contract:
 * {
 *   tracked: true,
 *   asset: { id, kind, objectKey, sha256, createdAt, deletedAt },
 *   blockers: string[] // complete dependency/hold/lifecycle blocker codes
 * }
 */
class CleanupCandidatePlanner {
  constructor({ repository, authorizeAdmin = requireAdmin, clock = () => new Date(), logger = console } = {}) {
    this.repository = requireCleanupRepository(repository);
    this.authorizeAdmin = requireAdministratorAuthorizer(authorizeAdmin);
    if (typeof clock !== "function") throw new Error("A cleanup planning clock is required");
    this.clock = clock;
    this.logger = logger;
  }

  async plan({ actor, mode, policy, cursor, limit, asOf } = {}) {
    this.authorizeAdmin(actor);
    assertDryRunMode(mode);
    const normalizedPolicy = normalizeRetentionPolicy(policy);
    const query = normalizeCleanupQuery({ cursor, limit });
    const planTime = normalizePlanTime(asOf === undefined ? this.clock() : asOf);
    const page = normalizePage(await this.repository.listCleanupInventory({
      cursor: query.cursor,
      limit: query.limit,
      asOf: planTime.toISOString()
    }), query.limit);

    const candidates = [];
    const blocked = [];
    const summary = createSummary();
    for (const record of page.items) {
      summary.inspected += 1;
      const assessment = assessInventoryRecord(record, { policy: normalizedPolicy, asOf: planTime });
      if (assessment.candidate) {
        candidates.push(assessment.candidate);
        summary.candidates += 1;
        summary.candidatesByKind[assessment.kind] += 1;
      } else {
        blocked.push({ kind: assessment.kind, reasons: assessment.reasons });
        addBlockedSummary(summary, assessment.reasons);
      }
    }

    const response = {
      mode: RETENTION_PLAN_MODE,
      policyVersion: normalizedPolicy.version,
      asOf: planTime.toISOString(),
      candidates,
      blocked,
      summary,
      page: { limit: query.limit, nextCursor: page.nextCursor }
    };
    this.logger.info?.("petpack.retention.cleanup_candidates_planned", {
      mode: response.mode,
      policyVersion: response.policyVersion,
      inspected: summary.inspected,
      candidates: summary.candidates,
      blocked: summary.blocked,
      hasNextPage: Boolean(response.page.nextCursor)
    });
    return response;
  }
}

module.exports = {
  BLOCKING_REASONS,
  CleanupCandidatePlanner,
  assessInventoryRecord,
  normalizePage
};
