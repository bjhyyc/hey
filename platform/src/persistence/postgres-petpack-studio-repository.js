const crypto = require("node:crypto");

const { PAYMENT_METHODS, PAYMENT_STATES } = require("../domain/payment-state-machine");
const { PRODUCTION_STATES } = require("../domain/production-state-machine");
const {
  DEFAULT_PET_SPECIES,
  REQUIRED_ACTION_IDS,
  VIDEO_CONSTRAINTS_VERSION,
  assertActionId,
  assertPetSpecies
} = require("../domain/action-catalog");
const { assertPromptVersionShape } = require("../domain/prompt-lifecycle");
const {
  assertImagePromptKind,
  assertImagePromptVersionShape
} = require("../domain/image-prompt-lifecycle");
const {
  IMAGE_CONSTRAINTS_VERSION,
  IMAGE_PROMPT_CONTENT_POLICY_VERSION
} = require("../providers/modelark-client");
const {
  assertPositiveByteSize,
  assertPrivateObjectKey,
  normalizeSha256
} = require("../storage/private-object-store");

const SOURCE_PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const RECONCILABLE_PAYMENT_STATES = new Set([
  PAYMENT_STATES.PENDING_PAYMENT,
  PAYMENT_STATES.PAID,
  PAYMENT_STATES.PAYMENT_REVIEW,
  PAYMENT_STATES.EXPIRED,
  PAYMENT_STATES.REFUNDED
]);

// Operational lists are deliberately bounded. At the expected 1,000 daily
// orders this keeps the PostgreSQL read predictable and prevents a browser
// from turning the operations screen into an unbounded export endpoint.
const ADMIN_OPERATIONS_DEFAULT_LIMIT = 50;
const ADMIN_OPERATIONS_MAX_LIMIT = 100;
const ADMIN_OPERATIONS_CURSOR_VERSION = 1;
const ADMIN_OPERATION_STATUSES = Object.freeze([
  "all",
  "attention",
  "failed",
  "payment_review",
  "paid",
  "run_active",
  "delivering",
  "delivered",
  "outbox_failed"
]);
const ADMIN_OPERATION_STATUS_SET = new Set(ADMIN_OPERATION_STATUSES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_NOTIFICATION_ALGORITHM = "aes-256-gcm";
const PAYMENT_NOTIFICATION_IV_BYTES = 12;
const PAYMENT_NOTIFICATION_TAG_BYTES = 16;
const PAYMENT_NOTIFICATION_MAX_BYTES = 1024 * 1024;
const PAYMENT_EVENT_PROVIDER = "KAIPAY";
const KAIPAY_FUYOU_ADAPTER_VERSION = "kaipay-pay-api-v3-hmac-sha256/1";

// These fragments are selected exclusively from ADMIN_OPERATION_STATUSES;
// browser input is never interpolated into SQL. `action` / `outbox` aliases
// exist only inside correlated EXISTS clauses, so the page CTE stays small.
const ADMIN_OPERATION_STATUS_SQL = Object.freeze({
  all: "TRUE",
  attention: `(
    order_record.status IN ('payment_review', 'expired', 'refund_pending', 'refunded')
    OR run.state = 'failed'
    OR EXISTS (
      SELECT 1 FROM generation_action action
       WHERE action.run_id = run.id AND action.state = 'failed'
    )
    OR EXISTS (
      SELECT 1 FROM outbox_job outbox
       WHERE outbox.aggregate_type = 'production_run'
         AND outbox.aggregate_id = run.id
         AND outbox.status IN ('failed', 'dead')
    )
  )`,
  failed: `(
    run.state = 'failed'
    OR EXISTS (
      SELECT 1 FROM generation_action action
       WHERE action.run_id = run.id AND action.state = 'failed'
    )
    OR EXISTS (
      SELECT 1 FROM outbox_job outbox
       WHERE outbox.aggregate_type = 'production_run'
         AND outbox.aggregate_id = run.id
         AND outbox.status IN ('failed', 'dead')
    )
  )`,
  payment_review: "order_record.status = 'payment_review'",
  paid: "order_record.status = 'paid'",
  run_active: `run.state IN (
    'awaiting_photos', 'awake_generating', 'awaiting_character_confirmation',
    'sleep_generating', 'awaiting_prompt_gate', 'video_generating',
    'media_processing', 'packaging', 'validating'
  )`,
  delivering: "run.state = 'deliverable' AND (delivery.id IS NULL OR delivery.status = 'pending')",
  delivered: "delivery.status IN ('ready', 'downloaded')",
  outbox_failed: `EXISTS (
    SELECT 1 FROM outbox_job outbox
     WHERE outbox.aggregate_type = 'production_run'
       AND outbox.aggregate_id = run.id
       AND outbox.status IN ('failed', 'dead')
  )`
});

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function") {
    throw new Error("A PostgreSQL transaction runner is required");
  }
  return database;
}

function requireTransactionQuery(transaction) {
  if (!transaction || typeof transaction.query !== "function") {
    throw new Error("A PostgreSQL transaction query interface is required");
  }
  return transaction;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe integer`);
  return value;
}

function rows(result) {
  return Array.isArray(result && result.rows) ? result.rows : [];
}

function oneRow(result, message) {
  const found = rows(result);
  if (found.length !== 1) throw new Error(message);
  return found[0];
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function normalizePaymentNotificationEncryptionKey(value) {
  if (value === undefined || value === null || value === "") return null;
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw new Error("Payment notification encryption key must contain exactly 32 bytes");
    return Buffer.from(value);
  }
  if (typeof value !== "string") throw new Error("Payment notification encryption key is invalid");
  const normalized = value.trim();
  const decoded = /^[a-f0-9]{64}$/i.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64");
  if (decoded.length !== 32) throw new Error("Payment notification encryption key must contain exactly 32 bytes");
  return decoded;
}

function rawNotificationBytes(value) {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : typeof value === "string" ? Buffer.from(value, "utf8") : null;
  if (!bytes || bytes.length < 1 || bytes.length > PAYMENT_NOTIFICATION_MAX_BYTES) {
    throw new Error("Raw payment notification byte size is invalid");
  }
  return bytes;
}

function encryptPaymentNotification(value, key, iv = crypto.randomBytes(PAYMENT_NOTIFICATION_IV_BYTES)) {
  const encryptionKey = normalizePaymentNotificationEncryptionKey(key);
  if (!encryptionKey) throw new Error("Payment notification encryption key is required");
  if (!Buffer.isBuffer(iv) || iv.length !== PAYMENT_NOTIFICATION_IV_BYTES) throw new Error("Payment notification IV is invalid");
  const cipher = crypto.createCipheriv(PAYMENT_NOTIFICATION_ALGORITHM, encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(rawNotificationBytes(value)), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

function assertPaymentProvider(value) {
  if (value !== PAYMENT_EVENT_PROVIDER) throw new Error("Payment event provider must be KAIPAY");
  return value;
}

function isKaipayV3Adapter(value) {
  return typeof value === "string" && value.startsWith("kaipay-pay-api-v3-");
}

function normalizeKaipayV3Credential(value, adapterVersion) {
  const normalized = nullableString(value);
  if (isKaipayV3Adapter(adapterVersion) && (!normalized || !/^kpv3-[a-f0-9]{64}$/.test(normalized))) {
    throw new Error("Kaipay V3 credential version is required");
  }
  if (normalized && !/^kpv3-[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Kaipay credential version is invalid");
  }
  return normalized;
}

function normalizeProviderEventId(value) {
  const normalized = nullableString(value);
  if (normalized && !/^[A-Za-z0-9._:/-]{1,256}$/.test(normalized)) {
    throw new Error("Payment provider event ID is invalid");
  }
  return normalized;
}

function normalizeKaipayV3Route(event, adapterVersion) {
  if (!isKaipayV3Adapter(adapterVersion)) {
    return { paymentChannel: null, payMethod: null, providerCode: null, paymentScene: null };
  }
  const paymentChannel = requiredString(event.paymentChannel, "Kaipay payment channel");
  const payMethod = requiredString(event.payMethod, "Kaipay pay method");
  const providerCode = requiredString(event.providerCode, "Kaipay provider code");
  const paymentScene = requiredString(event.scene, "Kaipay payment scene");
  const fuyouRoute = providerCode === "fuyou" && adapterVersion === KAIPAY_FUYOU_ADAPTER_VERSION;
  const valid = (
    paymentChannel === "ALIPAY" && payMethod === "alipay" &&
    ((providerCode === "alipay" && ["web", "native"].includes(paymentScene)) ||
      (fuyouRoute && paymentScene === "native"))
  ) || (
    paymentChannel === "WXPAY" && payMethod === "wechat" &&
    (providerCode === "wechat" || fuyouRoute) && paymentScene === "native"
  );
  if (!valid) throw new Error("Kaipay V3 route identity is invalid");
  return { paymentChannel, payMethod, providerCode, paymentScene };
}

function optionalPaymentStatus(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = requiredString(value, "Payment provider status").toUpperCase();
  if (!["PAID", "PENDING", "EXPIRED", "FAILED"].includes(normalized)) throw new Error("Payment provider status is not canonical");
  return normalized;
}

function isoTimestampOrNull(value) {
  if (!value) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Database timestamp is invalid");
  return timestamp.toISOString();
}

function databaseNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) throw new Error(`${label} is not a safe database integer`);
  return numeric;
}

function databaseNonNegativeNumber(value, label) {
  const numeric = Number(value || 0);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`${label} is not a non-negative safe database integer`);
  return numeric;
}

function canonicalCursorTimestamp(value, label) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${label} is invalid`);
  return timestamp.toISOString();
}

function assertCursorOrderId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Operations cursor order ID is invalid");
  }
  return value;
}

function encodeAdminOperationsCursor({ activityAt, orderId } = {}) {
  const payload = {
    v: ADMIN_OPERATIONS_CURSOR_VERSION,
    a: canonicalCursorTimestamp(activityAt, "Operations cursor activity timestamp"),
    o: assertCursorOrderId(orderId)
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeAdminOperationsCursor(cursor) {
  if (typeof cursor !== "string" || cursor.length < 8 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error("Operations cursor is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (_error) {
    throw new Error("Operations cursor is invalid");
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== ADMIN_OPERATIONS_CURSOR_VERSION) {
    throw new Error("Operations cursor is invalid");
  }
  return {
    activityAt: canonicalCursorTimestamp(parsed.a, "Operations cursor activity timestamp"),
    orderId: assertCursorOrderId(parsed.o)
  };
}

function normalizeAdminOperationsQuery({ cursor = null, limit = ADMIN_OPERATIONS_DEFAULT_LIMIT, status = "all" } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > ADMIN_OPERATIONS_MAX_LIMIT) {
    throw new Error(`Operations limit must be an integer between 1 and ${ADMIN_OPERATIONS_MAX_LIMIT}`);
  }
  if (typeof status !== "string" || !ADMIN_OPERATION_STATUS_SET.has(status.trim().toLowerCase())) {
    throw new Error(`Operations status must be one of: ${ADMIN_OPERATION_STATUSES.join(", ")}`);
  }
  if (cursor !== null && cursor !== undefined && typeof cursor !== "string") {
    throw new Error("Operations cursor is invalid");
  }
  return {
    cursor: cursor ? decodeAdminOperationsCursor(cursor) : null,
    limit,
    status: status.trim().toLowerCase()
  };
}

function parseJsonArray(value, label) {
  if (value === null || value === undefined) return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (_error) {
      throw new Error(`${label} is invalid JSON`);
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array`);
  return parsed;
}

function mapAdminOperationRow(row) {
  const actionRows = parseJsonArray(row.action_states, "Operations action states");
  const actionById = new Map(actionRows
    .filter((action) => action && REQUIRED_ACTION_IDS.includes(action.actionId))
    .map((action) => [action.actionId, {
      actionId: action.actionId,
      state: typeof action.state === "string" ? action.state : "unknown",
      retryCount: databaseNonNegativeNumber(action.retryCount, "Action retry count"),
      updatedAt: action.updatedAt || null
    }]));
  return {
    activityAt: canonicalCursorTimestamp(row.activity_at, "Operations activity timestamp"),
    order: {
      id: assertCursorOrderId(row.order_id),
      status: row.order_status,
      paymentMethod: row.payment_method,
      amountFen: databaseNonNegativeNumber(row.amount_fen, "Order amountFen"),
      paidAt: row.paid_at || null,
      createdAt: row.order_created_at || null,
      updatedAt: row.order_updated_at || null
    },
    project: {
      id: row.project_id,
      state: row.project_state,
      createdAt: row.project_created_at || null,
      updatedAt: row.project_updated_at || null
    },
    run: row.run_id ? {
      id: row.run_id,
      characterRevisionId: row.run_character_revision_id || null,
      state: row.run_state,
      hasFailure: Boolean(row.run_has_failure),
      awakeGenerationAttempts: databaseNonNegativeNumber(row.awake_generation_attempts, "Awake generation attempts"),
      sleepGenerationAttempts: databaseNonNegativeNumber(row.sleep_generation_attempts, "Sleep generation attempts"),
      version: databaseNonNegativeNumber(row.run_version, "Production run version"),
      updatedAt: row.run_updated_at || null
    } : null,
    actions: REQUIRED_ACTION_IDS.map((actionId) => actionById.get(actionId) || {
      actionId,
      state: "not_started",
      retryCount: 0,
      updatedAt: null
    }),
    delivery: row.delivery_status ? {
      status: row.delivery_status,
      downloadCount: databaseNonNegativeNumber(row.delivery_download_count, "Delivery download count"),
      expiresAt: row.delivery_expires_at || null,
      updatedAt: row.delivery_updated_at || null
    } : null,
    outbox: {
      pending: databaseNonNegativeNumber(row.outbox_pending, "Pending outbox count"),
      leased: databaseNonNegativeNumber(row.outbox_leased, "Leased outbox count"),
      failed: databaseNonNegativeNumber(row.outbox_failed, "Failed outbox count"),
      dead: databaseNonNegativeNumber(row.outbox_dead, "Dead outbox count")
    }
  };
}

function checkoutIdempotencyDigest({ userId, idempotencyKey }) {
  return crypto.createHash("sha256").update(`${userId}\u0000${idempotencyKey}`).digest("hex");
}

function assertPaymentMethod(paymentMethod) {
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw new Error("PetPack Studio accepts only KAIPAY payments");
  }
  return paymentMethod;
}

function assertSourcePhotoReservation({ projectId, ordinal, objectKey, contentType, sha256, byteSize, expectedPhotoCount } = {}) {
  const safeOrdinal = Number(ordinal);
  const safeExpectedPhotoCount = Number(expectedPhotoCount);
  if (!Number.isInteger(safeExpectedPhotoCount) || safeExpectedPhotoCount < 3 || safeExpectedPhotoCount > 4) {
    throw new Error("Source photo batch must contain 3 or 4 photos");
  }
  if (!Number.isInteger(safeOrdinal) || safeOrdinal < 1 || safeOrdinal > safeExpectedPhotoCount) {
    throw new Error("Source photo ordinal is outside its 3-to-4-photo batch");
  }
  if (!SOURCE_PHOTO_CONTENT_TYPES.has(contentType)) {
    throw new Error("Source photo content type must be JPEG, PNG, or WebP");
  }
  return {
    projectId: requiredString(projectId, "Project ID"),
    ordinal: safeOrdinal,
    objectKey: assertPrivateObjectKey(objectKey),
    contentType,
    sha256: normalizeSha256(sha256, "Source photo checksum"),
    byteSize: assertPositiveByteSize(byteSize, "Source photo byte size"),
    expectedPhotoCount: safeExpectedPhotoCount
  };
}

function mapProject(row) {
  if (!row) return null;
  const id = row.project_id || row.id;
  if (!id) return null;
  return {
    id,
    userId: row.project_user_id || row.user_id,
    displayName: row.display_name,
    state: row.project_state || row.state,
    createdAt: row.project_created_at || row.created_at,
    updatedAt: row.project_updated_at || row.updated_at
  };
}

function mapOrder(row) {
  if (!row) return null;
  const id = row.order_id || row.id;
  if (!id) return null;
  return {
    id,
    userId: row.order_user_id || row.user_id,
    projectId: row.project_id,
    planId: row.plan_id,
    amountFen: databaseNumber(row.amount_fen, "Order amountFen"),
    currency: row.currency,
    paymentMethod: row.payment_method,
    status: row.order_status || row.status,
    version: row.version === undefined || row.version === null ? undefined : databaseNumber(row.version, "Order version"),
    providerOrderId: nullableString(row.provider_order_id),
    paymentCredentialVersion: nullableString(row.payment_credential_version),
    paymentChannel: nullableString(row.payment_channel),
    paymentPayMethod: nullableString(row.payment_pay_method),
    paymentProviderCode: nullableString(row.payment_provider_code),
    paymentScene: nullableString(row.payment_scene),
    paidAt: row.paid_at || null,
    createdAt: row.order_created_at || row.created_at,
    updatedAt: row.order_updated_at || row.updated_at
  };
}

function mapReservation(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    ordinal: databaseNumber(row.ordinal, "Source photo ordinal"),
    objectKey: row.object_key,
    contentType: row.expected_content_type,
    sha256: row.expected_sha256,
    byteSize: databaseNumber(row.expected_byte_size, "Source photo byte size"),
    status: row.status,
    expectedPhotoCount: databaseNumber(row.expected_photo_count, "Expected source photo count"),
    sourcePhotoRevisionId: nullableString(row.source_photo_revision_id),
    expiresAt: row.expires_at || null,
    acceptedAt: row.accepted_at || null
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    orderId: row.order_id,
    characterRevisionId: row.character_revision_id || null,
    state: row.state,
    modelRegistryVersion: row.model_registry_version || null,
    frontGenerationAttempts: databaseNumber(row.front_generation_attempts || 0, "Front generation attempts"),
    sideGenerationAttempts: databaseNumber(row.side_generation_attempts || 0, "Side generation attempts"),
    frontUserRegenerationsUsed: databaseNumber(row.front_user_regenerations_used || 0, "Front user regenerations"),
    sideUserRegenerationsUsed: databaseNumber(row.side_user_regenerations_used || 0, "Side user regenerations"),
    frontQaRetries: databaseNumber(row.front_qa_retries || 0, "Front QA retries"),
    sideQaRetries: databaseNumber(row.side_qa_retries || 0, "Side QA retries"),
    sleepGenerationAttempts: databaseNumber(row.sleep_generation_attempts || 0, "Sleep generation attempts"),
    failureCode: row.failure_code || null,
    version: databaseNumber(row.version, "Production run version"),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function mapCharacterCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    view: row.kind,
    qaStatus: row.qa_status,
    confirmedAt: row.confirmed_at || null,
    // Server-only object key: PetPackStudioService converts it to a short-lived
    // preview grant and strips it from the normal-user DTO.
    objectKey: row.object_key
  };
}

function mapDelivery(row) {
  if (!row || !row.id) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    status: row.status,
    downloadCount: databaseNumber(row.download_count || 0, "Delivery download count"),
    expiresAt: row.expires_at || null,
    buildId: row.petpack_build_id || null,
    mediaAssetId: row.media_asset_id || null,
    sha256: row.sha256 || null,
    // This is server-only and is never returned directly by the service.
    objectKey: row.object_key || null
  };
}

function mapPromptVersion(row) {
  if (!row || !row.id) return null;
  return {
    id: row.id,
    actionId: row.action_id,
    title: row.title,
    prompt: row.prompt,
    negativePrompt: row.negative_prompt,
    model: row.model,
    resolution: row.resolution,
    duration: Number(row.duration),
    firstFrameMode: row.first_frame_mode,
    lastFrameMode: row.last_frame_mode,
    immutableConstraintsVersion: row.immutable_constraints_version,
    version: row.version,
    status: row.status,
    createdAt: isoTimestampOrNull(row.created_at),
    createdBy: row.created_by,
    publishedAt: isoTimestampOrNull(row.published_at),
    publishedBy: nullableString(row.published_by),
    disabledAt: isoTimestampOrNull(row.disabled_at),
    disabledBy: nullableString(row.disabled_by),
    supersedesVersionId: nullableString(row.supersedes_version_id)
  };
}

function mapImagePromptVersion(row) {
  if (!row || !row.id) return null;
  return {
    id: row.id,
    kind: row.kind,
    prompt: row.prompt,
    negativePrompt: row.negative_prompt,
    immutableConstraintsVersion: row.immutable_constraints_version,
    contentPolicyVersion: row.content_policy_version,
    contentPolicyApprovedAt: isoTimestampOrNull(row.content_policy_approved_at),
    contentPolicyApprovedBy: nullableString(row.content_policy_approved_by),
    version: row.version,
    status: row.status,
    createdAt: isoTimestampOrNull(row.created_at),
    createdBy: row.created_by,
    publishedAt: isoTimestampOrNull(row.published_at),
    publishedBy: nullableString(row.published_by),
    disabledAt: isoTimestampOrNull(row.disabled_at),
    disabledBy: nullableString(row.disabled_by),
    supersedesVersionId: nullableString(row.supersedes_version_id)
  };
}

function assertSamePromptContent(existing, next) {
  const immutableFields = [
    "actionId", "title", "prompt", "negativePrompt", "model", "resolution",
    "duration", "firstFrameMode", "lastFrameMode", "immutableConstraintsVersion", "version"
  ];
  if (immutableFields.some((field) => existing[field] !== next[field])) {
    throw new Error("Published prompt content and version metadata are immutable");
  }
}

function assertSameImagePromptContent(existing, next) {
  const immutableFields = [
    "kind", "prompt", "negativePrompt", "immutableConstraintsVersion",
    "contentPolicyVersion", "version", "createdAt", "createdBy", "supersedesVersionId"
  ];
  if (immutableFields.some((field) => existing[field] !== next[field])) {
    throw new Error("Image prompt content and immutable version metadata cannot be changed");
  }
}

function normalizePromptPublicationEvent(event) {
  if (!event) return null;
  if (!["publish", "disable", "rollback", "copy"].includes(event.eventType)) {
    throw new Error("Prompt publication event type is invalid");
  }
  return {
    eventType: event.eventType,
    fromVersionId: event.fromVersionId || null,
    toVersionId: event.toVersionId || null
  };
}

function normalizeImagePromptPublicationEvent(event) {
  if (!event) return null;
  if (!["publish", "rollback", "copy"].includes(event.eventType)) {
    throw new Error("Image prompt publication event type is invalid");
  }
  return {
    eventType: event.eventType,
    fromVersionId: event.fromVersionId || null,
    toVersionId: event.toVersionId || null
  };
}

function normalizeReconciliation(reconciliation) {
  if (!reconciliation || typeof reconciliation !== "object") {
    throw new Error("Verified payment reconciliation is required");
  }
  const state = requiredString(reconciliation.state, "Payment reconciliation state");
  if (!RECONCILABLE_PAYMENT_STATES.has(state)) {
    throw new Error("Payment reconciliation state is not supported");
  }
  const paymentEventKey = requiredString(reconciliation.paymentEventKey, "Payment event idempotency key");
  const providerOrderId = nullableString(reconciliation.providerOrderId);
  if (state === PAYMENT_STATES.PAID && !providerOrderId) {
    throw new Error("A paid reconciliation requires a provider order ID");
  }
  return { state, paymentEventKey, providerOrderId };
}

/**
 * Server-only PostgreSQL repository used by PetPackStudioService. It exposes
 * domain records to server code only; it neither signs URLs nor returns prompt
 * text, provider payloads, credentials, or permanent media URLs.
 */
class PostgresPetPackStudioRepository {
  constructor({ database, idFactory = crypto.randomUUID, reservationTtlSeconds = 600, paymentNotificationEncryptionKey, logger = console } = {}) {
    this.database = requireDatabase(database);
    if (typeof idFactory !== "function") throw new Error("An ID factory is required");
    if (!Number.isInteger(reservationTtlSeconds) || reservationTtlSeconds < 60 || reservationTtlSeconds > 3600) {
      throw new Error("Source photo reservation TTL must be between 60 and 3600 seconds");
    }
    this.idFactory = idFactory;
    this.reservationTtlSeconds = reservationTtlSeconds;
    this.paymentNotificationEncryptionKey = normalizePaymentNotificationEncryptionKey(paymentNotificationEncryptionKey);
    this.logger = logger;
  }

  async _transaction(callback) {
    return this.database.transaction(async (transaction) => callback(requireTransactionQuery(transaction)));
  }

  async _lockSourcePhotoStage(tx, projectId) {
    const row = oneRow(await tx.query(
      `SELECT p.id AS project_id,
              o.status AS order_status,
              r.id AS run_id,
              r.state AS run_state
         FROM pet_project p
         JOIN customer_order o ON o.project_id = p.id
         LEFT JOIN production_run r ON r.order_id = o.id
        WHERE p.id = $1
        FOR UPDATE OF p, o`,
      [projectId]
    ), "Project order was not found");
    if (row.order_status !== PAYMENT_STATES.PAID || row.run_state !== PRODUCTION_STATES.AWAITING_PHOTOS) {
      throw new Error("Source photo mutation is not available at this production stage");
    }
    return row;
  }

  async _finishSourcePhotoRevision(tx, projectId) {
    const batchRows = rows(await tx.query(
      `SELECT id, ordinal, status, expected_photo_count, source_photo_revision_id
         FROM source_photo_upload_reservation
        WHERE project_id = $1
        ORDER BY ordinal
        FOR UPDATE`,
      [projectId]
    ));
    if (batchRows.length < 3 || batchRows.length > 4) {
      return { acceptedCount: batchRows.filter((row) => row.status === "accepted").length, allAcceptedNow: false, sourcePhotoRevisionId: null };
    }
    const expectedCounts = [...new Set(batchRows.map((row) => Number(row.expected_photo_count)))];
    if (expectedCounts.length !== 1 || expectedCounts[0] !== batchRows.length ||
        batchRows.some((row, index) => Number(row.ordinal) !== index + 1)) {
      throw new Error("Source photo batch metadata is inconsistent");
    }
    const acceptedRows = batchRows.filter((row) => row.status === "accepted");
    const acceptedCount = acceptedRows.length;
    if (acceptedCount !== expectedCounts[0]) return { acceptedCount, allAcceptedNow: false, sourcePhotoRevisionId: null };

    const sourceRows = rows(await tx.query(
      `SELECT ordinal
         FROM source_photo
        WHERE project_id = $1
        ORDER BY ordinal
        FOR UPDATE`,
      [projectId]
    ));
    if (sourceRows.length !== expectedCounts[0] || sourceRows.some((row, index) => Number(row.ordinal) !== index + 1)) {
      throw new Error("Accepted source-photo records are incomplete");
    }

    const revisions = [...new Set(acceptedRows.map((row) => nullableString(row.source_photo_revision_id)).filter(Boolean))];
    if (revisions.length > 1 || (revisions.length === 1 && acceptedRows.some((row) => !nullableString(row.source_photo_revision_id)))) {
      throw new Error("Source photo revision records are inconsistent");
    }
    if (revisions.length === 1) {
      return { acceptedCount, allAcceptedNow: false, sourcePhotoRevisionId: revisions[0] };
    }

    const sourcePhotoRevisionId = this.idFactory();
    const claimed = rows(await tx.query(
      `UPDATE source_photo_upload_reservation
          SET source_photo_revision_id = $2,
              updated_at = now()
        WHERE project_id = $1
          AND status = 'accepted'
          AND source_photo_revision_id IS NULL
      RETURNING id`,
      [projectId, sourcePhotoRevisionId]
    ));
    if (claimed.length !== expectedCounts[0]) throw new Error("Source photo revision could not be claimed atomically");

    // 001 deliberately has no source-photo-revision table. The immutable
    // revision is therefore durably recorded on both accepted reservations;
    // accepted reservations are never mutable through reserveSourcePhoto.
    return { acceptedCount, allAcceptedNow: true, sourcePhotoRevisionId };
  }

  /**
   * Creates an order with the price from the enabled server-side product plan.
   * 001 has no checkout-idempotency column, so a hash-only audit marker plus a
   * transaction-scoped advisory lock provide the durable idempotency fence
   * without storing the caller's raw idempotency key.
   */
  async createProjectOrder({ userId, planCode, displayName, paymentMethod, idempotencyKey, species, amountFen } = {}) {
    if (amountFen !== undefined) throw new Error("Order amount must come from the server-side product plan");
    const input = {
      userId: requiredString(userId, "User ID"),
      planCode: requiredString(planCode, "Plan code"),
      displayName: requiredString(displayName, "Pet display name"),
      paymentMethod: assertPaymentMethod(paymentMethod),
      idempotencyKey: requiredString(idempotencyKey, "Checkout idempotency key"),
      species: assertPetSpecies(species === undefined ? DEFAULT_PET_SPECIES : species)
    };
    const idempotencyDigest = checkoutIdempotencyDigest(input);
    return this._transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`petpack-checkout:${idempotencyDigest}`]);
      const existing = rows(await tx.query(
        `SELECT o.id AS order_id, o.user_id AS order_user_id, o.project_id,
                o.plan_id, o.amount_fen, o.currency, o.payment_method,
                o.status AS order_status, o.version, o.provider_order_id,
                o.paid_at, o.created_at AS order_created_at, o.updated_at AS order_updated_at
           FROM audit_event event
           JOIN customer_order o ON o.id::text = (event.metadata ->> 'orderId')
          WHERE event.actor_id = $1
            AND event.event_type = 'checkout_order_created'
            AND event.metadata ->> 'idempotencyDigest' = $2
          ORDER BY event.created_at DESC
          LIMIT 1
          FOR UPDATE OF o`,
        [input.userId, idempotencyDigest]
      ));
      if (existing.length > 0) {
        const order = mapOrder(existing[0]);
        if (order.userId !== input.userId) throw new Error("Checkout idempotency record owner mismatch");
        return order;
      }

      const plan = oneRow(await tx.query(
        `SELECT id, code, amount_fen, currency
           FROM product_plan
          WHERE code = $1 AND enabled = true
          FOR SHARE`,
        [input.planCode]
      ), "Selected product plan is unavailable");
      const projectId = this.idFactory();
      const orderId = this.idFactory();
      const project = oneRow(await tx.query(
        `INSERT INTO pet_project (id, user_id, display_name, state, species)
         VALUES ($1, $2, $3, 'awaiting_payment', $4)
         RETURNING id, user_id, display_name, state, species, created_at, updated_at`,
        [projectId, input.userId, input.displayName, input.species]
      ), "Pet project could not be created");
      const order = oneRow(await tx.query(
        `INSERT INTO customer_order
          (id, user_id, project_id, plan_id, amount_fen, currency, payment_method, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_payment')
         RETURNING id AS order_id, user_id AS order_user_id, project_id, plan_id,
                   amount_fen, currency, payment_method, status AS order_status,
                   version, provider_order_id, paid_at,
                   created_at AS order_created_at, updated_at AS order_updated_at`,
        [orderId, input.userId, project.id, plan.id, databaseNumber(plan.amount_fen, "Plan amountFen"), plan.currency, input.paymentMethod]
      ), "Customer order could not be created");
      await tx.query(
        `INSERT INTO audit_event (id, actor_id, project_id, order_id, event_type, metadata)
         VALUES ($1, $2, $3, $4, 'checkout_order_created', $5::jsonb)`,
        [
          this.idFactory(),
          input.userId,
          project.id,
          orderId,
          JSON.stringify({ idempotencyDigest, planCode: plan.code, orderId, projectId: project.id })
        ]
      );
      const result = mapOrder(order);
      this.logger.info?.("petpack.persistence.checkout_order_created", {
        orderId: result.id,
        projectId: result.projectId,
        paymentMethod: result.paymentMethod
      });
      return result;
    });
  }

  async getProjectBundle(projectId) {
    const safeProjectId = requiredString(projectId, "Project ID");
    return this._transaction(async (tx) => {
      const result = rows(await tx.query(
        `SELECT p.id AS project_id, p.user_id AS project_user_id, p.display_name,
                p.state AS project_state, p.created_at AS project_created_at, p.updated_at AS project_updated_at,
                o.id AS order_id, o.user_id AS order_user_id, o.project_id AS order_project_id,
                o.plan_id, o.amount_fen, o.currency, o.payment_method, o.status AS order_status,
                o.version, o.provider_order_id, o.paid_at,
                o.created_at AS order_created_at, o.updated_at AS order_updated_at
           FROM pet_project p
           LEFT JOIN customer_order o ON o.project_id = p.id
          WHERE p.id = $1`,
        [safeProjectId]
      ));
      if (result.length === 0) return { project: null, order: null };
      const row = result[0];
      return {
        project: mapProject(row),
        order: row.order_id ? mapOrder({ ...row, project_id: row.order_project_id || row.project_id }) : null
      };
    });
  }

  async listUserProjects(userId) {
    const safeUserId = requiredString(userId, "User ID");
    return this._transaction(async (tx) => {
      const result = rows(await tx.query(
        `SELECT p.id AS project_id, p.user_id AS project_user_id, p.display_name,
                p.state AS project_state, p.created_at AS project_created_at,
                p.updated_at AS project_updated_at,
                o.id AS order_id, o.user_id AS order_user_id, o.project_id AS order_project_id,
                o.plan_id, o.amount_fen, o.currency, o.payment_method,
                o.status AS order_status, o.version, o.provider_order_id, o.paid_at,
                o.created_at AS order_created_at, o.updated_at AS order_updated_at,
                run.id AS run_id, run.order_id AS run_order_id,
                run.character_revision_id, run.state AS run_state,
                run.model_registry_version, run.species, run.front_generation_attempts,
                run.side_generation_attempts,
                run.front_user_regenerations_used, run.side_user_regenerations_used,
                run.front_qa_retries, run.side_qa_retries,
                run.sleep_generation_attempts, run.failure_code,
                run.version AS run_version, run.created_at AS run_created_at,
                run.updated_at AS run_updated_at,
                delivery.id AS delivery_id, delivery.status AS delivery_status,
                delivery.download_count, delivery.expires_at AS delivery_expires_at,
                delivery.created_at AS delivery_created_at,
                delivery.updated_at AS delivery_updated_at
           FROM pet_project p
           LEFT JOIN customer_order o ON o.project_id = p.id
           LEFT JOIN production_run run ON run.order_id = o.id AND run.project_id = p.id
           LEFT JOIN delivery ON delivery.order_id = o.id
          WHERE p.user_id = $1
          ORDER BY p.updated_at DESC, p.id DESC
          LIMIT 100`,
        [safeUserId]
      ));
      return result.map((row) => ({
        project: mapProject(row),
        order: row.order_id ? mapOrder({ ...row, project_id: row.order_project_id || row.project_id }) : null,
        run: row.run_id ? mapRun({
          id: row.run_id,
          project_id: row.project_id,
          order_id: row.run_order_id,
          character_revision_id: row.character_revision_id,
          state: row.run_state,
          model_registry_version: row.model_registry_version,
          front_generation_attempts: row.front_generation_attempts,
          side_generation_attempts: row.side_generation_attempts,
          front_user_regenerations_used: row.front_user_regenerations_used,
          side_user_regenerations_used: row.side_user_regenerations_used,
          front_qa_retries: row.front_qa_retries,
          side_qa_retries: row.side_qa_retries,
          sleep_generation_attempts: row.sleep_generation_attempts,
          failure_code: row.failure_code,
          version: row.run_version,
          created_at: row.run_created_at,
          updated_at: row.run_updated_at
        }) : null,
        delivery: row.delivery_id ? mapDelivery({
          id: row.delivery_id,
          order_id: row.order_id,
          status: row.delivery_status,
          download_count: row.download_count,
          expires_at: row.delivery_expires_at,
          created_at: row.delivery_created_at,
          updated_at: row.delivery_updated_at
        }) : null
      }));
    });
  }

  async getPromptVersions(actionId) {
    assertActionId(actionId);
    return this._transaction(async (tx) => rows(await tx.query(
      `SELECT version.id, template.action_id, version.title, version.prompt,
              version.negative_prompt, version.model, version.resolution,
              version.duration, version.first_frame_mode, version.last_frame_mode,
              version.immutable_constraints_version, version.version, version.status,
              version.created_at, version.created_by, version.published_at,
              version.published_by, version.disabled_at, version.disabled_by,
              version.supersedes_version_id
         FROM prompt_template template
         JOIN prompt_version version ON version.template_id = template.id
        WHERE template.action_id = $1
        ORDER BY version.created_at DESC, version.id DESC`,
      [actionId]
    )).map(mapPromptVersion));
  }

  async getPromptHistory(actionId) {
    return this.getPromptVersions(actionId);
  }

  async getPaymentOrder(platformOrderId) {
    const orderId = requiredString(platformOrderId, "Platform order ID");
    return this._transaction(async (tx) => {
      const row = rows(await tx.query(
        `SELECT order_record.id AS order_id, order_record.user_id AS order_user_id,
                order_record.project_id, order_record.plan_id, order_record.amount_fen,
                order_record.currency, order_record.payment_method,
                order_record.status AS order_status, order_record.version,
                COALESCE(order_record.provider_order_id, attempt.provider_order_id) AS provider_order_id,
                attempt.credential_version AS payment_credential_version,
                attempt.payment_channel, attempt.pay_method AS payment_pay_method,
                attempt.provider_code AS payment_provider_code,
                attempt.payment_scene, order_record.paid_at,
                order_record.created_at AS order_created_at,
                order_record.updated_at AS order_updated_at
           FROM customer_order order_record
           LEFT JOIN LATERAL (
             SELECT provider_order_id, credential_version, payment_channel,
                    pay_method, provider_code, payment_scene
               FROM payment_attempt
              WHERE order_id = order_record.id
              ORDER BY created_at DESC, id DESC
              LIMIT 1
           ) attempt ON TRUE
          WHERE order_record.id = $1`,
        [orderId]
      ));
      return row.length ? mapOrder(row[0]) : null;
    });
  }

  async appendIdempotent(event = {}) {
    const platformOrderId = requiredString(event.platformOrderId, "Payment event platform order ID");
    const idempotencyKey = requiredString(event.idempotencyKey, "Payment event idempotency key");
    const eventType = requiredString(event.type, "Payment event type");
    const provider = assertPaymentProvider(event.provider || PAYMENT_EVENT_PROVIDER);
    const providerOrderId = nullableString(event.providerOrderId);
    const adapterVersion = requiredString(event.adapterVersion, "Payment adapter version");
    const credentialVersion = normalizeKaipayV3Credential(event.credentialVersion, adapterVersion);
    const providerEventId = normalizeProviderEventId(event.providerEventId);
    const providerStatus = optionalPaymentStatus(event.providerStatus);
    const outcome = event.state && RECONCILABLE_PAYMENT_STATES.has(event.state) ? event.state : null;
    const rawNotificationDigest = nullableString(event.rawNotificationDigest);
    const signatureValid = typeof event.signatureValid === "boolean" ? event.signatureValid : null;
    if (idempotencyKey.length > 512 || eventType.length > 128 || adapterVersion.length > 128) {
      throw new Error("Payment event metadata is too long");
    }
    return this._transaction(async (tx) => {
      const order = oneRow(await tx.query(
        "SELECT id, amount_fen, payment_method FROM customer_order WHERE id = $1 FOR UPDATE",
        [platformOrderId]
      ), "Payment order was not found");
      if (eventType === "checkout_created" || eventType === "checkout_created_simulated") {
        const amountFen = databaseNumber(event.amountFen, "Checkout amountFen");
        if (amountFen !== databaseNumber(order.amount_fen, "Order amountFen")) throw new Error("Checkout amount does not match the order");
        const paymentMethod = assertPaymentMethod(event.paymentMethod);
        if (paymentMethod !== order.payment_method || !providerOrderId) throw new Error("Checkout payment identity does not match the order");
        const { paymentChannel, payMethod, providerCode, paymentScene } = normalizeKaipayV3Route(event, adapterVersion);
        const insertedAttempt = rows(await tx.query(
          `INSERT INTO payment_attempt
            (id, order_id, provider, provider_order_id, payment_method, amount_fen,
             status, idempotency_key, adapter_version, credential_version,
             payment_channel, pay_method, provider_code, payment_scene)
           VALUES ($1, $2, $3, $4, $5, $6, 'created', $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [
            this.idFactory(), platformOrderId, provider, providerOrderId,
            paymentMethod, amountFen, idempotencyKey, adapterVersion,
            credentialVersion, paymentChannel, payMethod, providerCode, paymentScene
          ]
        ));
        if (!insertedAttempt.length) {
          const existing = oneRow(await tx.query(
            `SELECT order_id, provider, provider_order_id, payment_method,
                    amount_fen, adapter_version, credential_version,
                    payment_channel, pay_method, provider_code, payment_scene
               FROM payment_attempt
              WHERE idempotency_key = $1`,
            [idempotencyKey]
          ), "Payment attempt idempotency record was not found");
          if (existing.order_id !== platformOrderId || existing.provider !== provider ||
              existing.provider_order_id !== providerOrderId || existing.payment_method !== paymentMethod ||
              databaseNumber(existing.amount_fen, "Existing checkout amountFen") !== amountFen ||
              existing.adapter_version !== adapterVersion ||
              nullableString(existing.credential_version) !== credentialVersion ||
              nullableString(existing.payment_channel) !== paymentChannel ||
              nullableString(existing.pay_method) !== payMethod ||
              nullableString(existing.provider_code) !== providerCode ||
              nullableString(existing.payment_scene) !== paymentScene) {
            throw new Error("Payment attempt idempotency key belongs to another checkout");
          }
        }
      }
      const inserted = rows(await tx.query(
        `INSERT INTO payment_event
          (id, order_id, provider_order_id, event_type, idempotency_key,
           raw_notification_digest, signature_valid, provider_status, outcome,
           provider, adapter_version, credential_version, provider_event_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::order_status, $10, $11, $12, $13)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          this.idFactory(), platformOrderId, providerOrderId, eventType, idempotencyKey,
          rawNotificationDigest,
          signatureValid,
          providerStatus, outcome, provider, adapterVersion,
          credentialVersion, providerEventId
        ]
      ));
      if (!inserted.length) {
        const existing = oneRow(await tx.query(
          `SELECT order_id, provider_order_id, event_type, raw_notification_digest,
                   signature_valid, provider_status, outcome, provider, adapter_version,
                   credential_version, provider_event_id
             FROM payment_event
            WHERE idempotency_key = $1`,
          [idempotencyKey]
        ), "Payment event idempotency record was not found");
        if (existing.order_id !== platformOrderId || nullableString(existing.provider_order_id) !== providerOrderId ||
            existing.event_type !== eventType || nullableString(existing.raw_notification_digest) !== rawNotificationDigest ||
            existing.signature_valid !== signatureValid || nullableString(existing.provider_status) !== providerStatus ||
             nullableString(existing.outcome) !== outcome || existing.provider !== provider ||
             existing.adapter_version !== adapterVersion ||
             nullableString(existing.credential_version) !== credentialVersion ||
             nullableString(existing.provider_event_id) !== providerEventId) {
          throw new Error("Payment event idempotency key conflicts with another event");
        }
      }
      return { inserted: inserted.length === 1 };
    });
  }

  async storeEncryptedNotification(event = {}) {
    if (!this.paymentNotificationEncryptionKey) throw new Error("Payment notification encryption key is required");
    const platformOrderId = requiredString(event.platformOrderId, "Payment notification platform order ID");
    const idempotencyKey = requiredString(event.idempotencyKey, "Payment notification idempotency key");
    const provider = assertPaymentProvider(event.provider || PAYMENT_EVENT_PROVIDER);
    const adapterVersion = requiredString(event.adapterVersion, "Payment adapter version");
    const credentialVersion = normalizeKaipayV3Credential(event.credentialVersion, adapterVersion);
    const rawBytes = rawNotificationBytes(event.rawNotification);
    const digest = crypto.createHash("sha256").update(rawBytes).digest("hex");
    const ciphertext = encryptPaymentNotification(rawBytes, this.paymentNotificationEncryptionKey);
    return this._transaction(async (tx) => {
      const inserted = rows(await tx.query(
        `INSERT INTO payment_event
          (id, order_id, provider_order_id, event_type, idempotency_key,
           raw_notification_ciphertext, raw_notification_digest, provider,
            adapter_version, credential_version)
          VALUES ($1, $2, $3, 'payment_notification_raw', $4, $5, $6, $7, $8, $9)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          this.idFactory(), platformOrderId, nullableString(event.providerOrderId),
          idempotencyKey, ciphertext, digest, provider, adapterVersion,
          credentialVersion
        ]
      ));
      if (!inserted.length) {
        const existing = oneRow(await tx.query(
          `SELECT order_id, provider_order_id, raw_notification_digest, provider,
                  adapter_version, credential_version
             FROM payment_event
            WHERE idempotency_key = $1`,
          [idempotencyKey]
        ), "Encrypted payment notification idempotency record was not found");
        if (existing.order_id !== platformOrderId ||
            nullableString(existing.provider_order_id) !== nullableString(event.providerOrderId) ||
             existing.raw_notification_digest !== digest || existing.provider !== provider ||
             existing.adapter_version !== adapterVersion ||
             nullableString(existing.credential_version) !== credentialVersion) {
          throw new Error("Encrypted payment notification idempotency key conflicts with another payload");
        }
      }
      return { inserted: inserted.length === 1, digest };
    });
  }

  async countLegacyOpenPayments() {
    return this._transaction(async (tx) => {
      const row = oneRow(await tx.query(
        `SELECT count(*)::integer AS count
           FROM customer_order
          WHERE payment_method = 'ALIPAY'
            AND status IN ('draft', 'pending_payment', 'payment_review', 'refund_pending')`
      ), "Legacy payment count was not returned");
      return databaseNonNegativeNumber(row.count, "Legacy open payment count");
    });
  }

  // A run freezes its species, and each action publishes one prompt per
  // species, so the caller must say which set it is generating against.
  async listPublishedMetadata({ species = DEFAULT_PET_SPECIES } = {}) {
    const safeSpecies = assertPetSpecies(species);
    return this._transaction(async (tx) => rows(await tx.query(
      `SELECT version.id, template.action_id, version.title, version.prompt,
              version.negative_prompt, version.model, version.resolution,
              version.duration, version.first_frame_mode, version.last_frame_mode,
              version.immutable_constraints_version, version.version, version.status,
              version.created_at, version.created_by, version.published_at,
              version.published_by, version.disabled_at, version.disabled_by,
              version.supersedes_version_id
         FROM prompt_template template
         JOIN prompt_version version
           ON version.id = template.current_published_version_id
          AND version.template_id = template.id
          AND version.status = 'published'
          AND version.published_at IS NOT NULL
          AND version.disabled_at IS NULL
        WHERE template.disabled_at IS NULL
          AND template.species = $1
        ORDER BY template.action_id`, [safeSpecies])
    ).map(mapPromptVersion));
  }

  async savePromptVersions({ actionId, versions, actorId, publicationEvent = null } = {}) {
    assertActionId(actionId);
    const administratorId = requiredString(actorId, "Administrator actor ID");
    const savedEvent = normalizePromptPublicationEvent(publicationEvent);
    if (!Array.isArray(versions) || versions.length === 0) throw new Error("Prompt versions are required");
    const checked = versions.map((version) => {
      assertPromptVersionShape(version);
      if (version.actionId !== actionId) throw new Error("Prompt action ID does not match its template");
      if (version.immutableConstraintsVersion !== VIDEO_CONSTRAINTS_VERSION) {
        throw new Error("Prompt constraints version is unsupported");
      }
      return version;
    });
    return this._transaction(async (tx) => {
      const template = oneRow(await tx.query(
        `INSERT INTO prompt_template (id, action_id, title)
         VALUES ($1, $2, $3)
         ON CONFLICT (action_id) DO UPDATE SET title = prompt_template.title
         RETURNING id, action_id, title, current_published_version_id`,
        [this.idFactory(), actionId, checked[0].title]
      ), "Prompt template could not be created or loaded");
      const existingRows = rows(await tx.query(
        `SELECT version.id, template.action_id, version.title, version.prompt,
                version.negative_prompt, version.model, version.resolution,
                version.duration, version.first_frame_mode, version.last_frame_mode,
                version.immutable_constraints_version, version.version, version.status,
                version.created_at, version.created_by, version.published_at,
                version.published_by, version.disabled_at, version.disabled_by,
                version.supersedes_version_id
           FROM prompt_version version
           JOIN prompt_template template ON template.id = version.template_id
          WHERE version.template_id = $1
          FOR UPDATE OF version`,
        [template.id]
      ));
      const existingById = new Map(existingRows.map((row) => [row.id, mapPromptVersion(row)]));
      const requiresNewVersion = !savedEvent || ["copy", "rollback"].includes(savedEvent.eventType);
      if (requiresNewVersion && checked.some((version) => existingById.has(version.id))) {
        throw new Error("A prompt draft must use a new immutable version ID");
      }
      if (savedEvent?.eventType === "publish" && checked.some((version) => !existingById.has(version.id))) {
        throw new Error("Only existing prompt drafts can participate in publication");
      }
      const ordered = [...checked].sort((left, right) => {
        const rank = { disabled: 0, draft: 1, published: 2 };
        return rank[left.status] - rank[right.status];
      });
      for (const version of ordered) {
        const existing = existingById.get(version.id);
        if (existing) {
          assertSamePromptContent(existing, version);
          await tx.query(
            `UPDATE prompt_version
                SET status = $3, published_at = $4, published_by = $5,
                    disabled_at = $6, disabled_by = $7
              WHERE id = $1 AND template_id = $2`,
            [
              version.id, template.id, version.status,
              version.publishedAt || null, version.publishedBy || null,
              version.disabledAt || null, version.disabledBy || null
            ]
          );
          continue;
        }
        if ((version.createdBy || administratorId) !== administratorId) {
          throw new Error("Prompt creator must match the administrator actor");
        }
        await tx.query(
          `INSERT INTO prompt_version
            (id, template_id, version, status, title, prompt, negative_prompt,
             model, resolution, duration, first_frame_mode, last_frame_mode,
             immutable_constraints_version, created_at, created_by,
             published_at, published_by, disabled_at, disabled_by,
             supersedes_version_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18, $19, $20)`,
          [
            version.id, template.id, version.version, version.status,
            version.title, version.prompt, version.negativePrompt,
            version.model, version.resolution, version.duration,
            version.firstFrameMode, version.lastFrameMode,
            version.immutableConstraintsVersion,
            requiredString(version.createdAt, "Prompt creation timestamp"),
            requiredString(version.createdBy || administratorId, "Prompt creator"),
            version.publishedAt || null, version.publishedBy || null,
            version.disabledAt || null, version.disabledBy || null,
            version.supersedesVersionId || null
          ]
        );
      }
      const live = rows(await tx.query(
        `SELECT id FROM prompt_version
          WHERE template_id = $1 AND status = 'published' AND disabled_at IS NULL`,
        [template.id]
      ));
      if (live.length > 1) throw new Error("Prompt template has more than one live published version");
      await tx.query(
        `UPDATE prompt_template SET current_published_version_id = $2 WHERE id = $1`,
        [template.id, live[0]?.id || null]
      );
      if (savedEvent) {
        await tx.query(
          `INSERT INTO prompt_publication_event
            (id, template_id, from_version_id, to_version_id, event_type, actor_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            this.idFactory(), template.id, savedEvent.fromVersionId,
            savedEvent.toVersionId, savedEvent.eventType, administratorId
          ]
        );
      }
      this.logger.info?.("petpack.persistence.prompt_versions_saved", {
        actionId,
        versionCount: checked.length,
        hasPublishedVersion: live.length === 1
      });
    });
  }

  async getImagePromptVersions(kind) {
    const safeKind = assertImagePromptKind(kind);
    return this._transaction(async (tx) => rows(await tx.query(
      `SELECT version.id, template.kind, version.version, version.status,
              version.prompt, version.negative_prompt,
              version.immutable_constraints_version, version.content_policy_version,
              version.content_policy_approved_at, version.content_policy_approved_by,
              version.created_at, version.created_by, version.published_at,
              version.published_by, version.disabled_at, version.disabled_by,
              version.supersedes_version_id
         FROM image_prompt_template template
         JOIN image_prompt_version version ON version.template_id = template.id
        WHERE template.kind = $1
        ORDER BY version.created_at DESC, version.id DESC`,
      [safeKind]
    )).map(mapImagePromptVersion));
  }

  async getImagePromptHistory(kind) {
    return this.getImagePromptVersions(kind);
  }

  async saveImagePromptVersions({ kind, versions, actorId, publicationEvent = null } = {}) {
    const safeKind = assertImagePromptKind(kind);
    const administratorId = requiredString(actorId, "Administrator actor ID");
    const savedEvent = normalizeImagePromptPublicationEvent(publicationEvent);
    if (!Array.isArray(versions) || versions.length === 0) throw new Error("Image prompt versions are required");
    const checked = versions.map((version) => {
      assertImagePromptVersionShape(version);
      if (version.kind !== safeKind) throw new Error("Image prompt kind does not match its template");
      if (version.immutableConstraintsVersion !== IMAGE_CONSTRAINTS_VERSION ||
          version.contentPolicyVersion !== IMAGE_PROMPT_CONTENT_POLICY_VERSION) {
        throw new Error("Image prompt policy versions are unsupported");
      }
      return version;
    });
    return this._transaction(async (tx) => {
      const template = oneRow(await tx.query(
        `INSERT INTO image_prompt_template (id, kind)
         VALUES ($1, $2)
         ON CONFLICT (kind) DO UPDATE SET updated_at = image_prompt_template.updated_at
         RETURNING id, kind, current_published_version_id, disabled_at`,
        [this.idFactory(), safeKind]
      ), "Image prompt template could not be created or loaded");
      if (template.disabled_at) throw new Error("Image prompt template is disabled");
      const existingRows = rows(await tx.query(
        `SELECT version.id, template.kind, version.version, version.status,
                version.prompt, version.negative_prompt,
                version.immutable_constraints_version, version.content_policy_version,
                version.content_policy_approved_at, version.content_policy_approved_by,
                version.created_at, version.created_by, version.published_at,
                version.published_by, version.disabled_at, version.disabled_by,
                version.supersedes_version_id
           FROM image_prompt_version version
           JOIN image_prompt_template template ON template.id = version.template_id
          WHERE version.template_id = $1
          FOR UPDATE OF version`,
        [template.id]
      ));
      const existingById = new Map(existingRows.map((row) => [row.id, mapImagePromptVersion(row)]));
      const requiresNewVersion = !savedEvent || ["copy", "rollback"].includes(savedEvent.eventType);
      if (requiresNewVersion && checked.some((version) => existingById.has(version.id))) {
        throw new Error("An image prompt draft must use a new immutable version ID");
      }
      if (savedEvent?.eventType === "publish" && checked.some((version) => !existingById.has(version.id))) {
        throw new Error("Only existing image prompt drafts can participate in publication");
      }
      const ordered = [...checked].sort((left, right) => {
        const rank = { disabled: 0, draft: 1, published: 2 };
        return rank[left.status] - rank[right.status];
      });
      for (const version of ordered) {
        const existing = existingById.get(version.id);
        if (existing) {
          assertSameImagePromptContent(existing, version);
          await tx.query(
            `UPDATE image_prompt_version
                SET status = $3,
                    content_policy_approved_at = $4,
                    content_policy_approved_by = $5,
                    published_at = $6,
                    published_by = $7,
                    disabled_at = $8,
                    disabled_by = $9
              WHERE id = $1 AND template_id = $2`,
            [
              version.id, template.id, version.status,
              version.contentPolicyApprovedAt || null, version.contentPolicyApprovedBy || null,
              version.publishedAt || null, version.publishedBy || null,
              version.disabledAt || null, version.disabledBy || null
            ]
          );
          continue;
        }
        if ((version.createdBy || administratorId) !== administratorId) {
          throw new Error("Image prompt creator must match the administrator actor");
        }
        await tx.query(
          `INSERT INTO image_prompt_version
            (id, template_id, version, status, prompt, negative_prompt,
             immutable_constraints_version, content_policy_version,
             content_policy_approved_at, content_policy_approved_by,
             created_by, published_at, published_by, disabled_at, disabled_by,
             supersedes_version_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   $12, $13, $14, $15, $16, $17)`,
          [
            version.id, template.id, version.version, version.status,
            version.prompt, version.negativePrompt,
            version.immutableConstraintsVersion, version.contentPolicyVersion,
            version.contentPolicyApprovedAt || null, version.contentPolicyApprovedBy || null,
            requiredString(version.createdBy || administratorId, "Image prompt creator"),
            version.publishedAt || null, version.publishedBy || null,
            version.disabledAt || null, version.disabledBy || null,
            version.supersedesVersionId || null,
            requiredString(version.createdAt, "Image prompt creation timestamp")
          ]
        );
      }
      const live = rows(await tx.query(
        `SELECT id FROM image_prompt_version
          WHERE template_id = $1 AND status = 'published' AND disabled_at IS NULL`,
        [template.id]
      ));
      if (live.length > 1) throw new Error("Image prompt template has more than one live published version");
      await tx.query(
        `UPDATE image_prompt_template
            SET current_published_version_id = $2, updated_at = now()
          WHERE id = $1`,
        [template.id, live[0]?.id || null]
      );
      if (savedEvent) {
        await tx.query(
          `INSERT INTO image_prompt_publication_event
            (id, template_id, from_version_id, to_version_id, event_type, actor_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            this.idFactory(), template.id, savedEvent.fromVersionId,
            savedEvent.toVersionId, savedEvent.eventType, administratorId
          ]
        );
      }
      this.logger.info?.("petpack.persistence.image_prompt_versions_saved", {
        kind: safeKind,
        versionCount: checked.length,
        hasPublishedVersion: live.length === 1
      });
    });
  }

  async appendPromptPublicationEvent({ actionId, eventType, fromVersionId = null, toVersionId = null, actorId } = {}) {
    assertActionId(actionId);
    const savedEvent = normalizePromptPublicationEvent({ eventType, fromVersionId, toVersionId });
    const administratorId = requiredString(actorId, "Administrator actor ID");
    return this._transaction(async (tx) => {
      const template = oneRow(await tx.query(
        `SELECT id FROM prompt_template WHERE action_id = $1 FOR SHARE`,
        [actionId]
      ), "Prompt template was not found");
      await tx.query(
        `INSERT INTO prompt_publication_event
          (id, template_id, from_version_id, to_version_id, event_type, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.idFactory(), template.id, savedEvent.fromVersionId, savedEvent.toVersionId, savedEvent.eventType, administratorId]
      );
    });
  }

  /**
   * Read-only operations feed. This intentionally selects a redacted subset:
   * no user rows, display names, prompt snapshots, provider identifiers or
   * payloads, media object keys, and no signed URLs. The page CTE applies a
   * bounded keyset page before the action/outbox aggregates are calculated.
   */
  async listAdminOperations(query = {}) {
    const normalized = normalizeAdminOperationsQuery(query);
    const statusSql = ADMIN_OPERATION_STATUS_SQL[normalized.status];
    const cursorActivityAt = normalized.cursor ? normalized.cursor.activityAt : null;
    const cursorOrderId = normalized.cursor ? normalized.cursor.orderId : null;
    const pageSize = normalized.limit + 1;
    return this._transaction(async (tx) => {
      const result = rows(await tx.query(
        `WITH page AS (
           SELECT order_record.id AS order_id,
                  order_record.status AS order_status,
                  order_record.payment_method,
                  order_record.amount_fen,
                  order_record.paid_at,
                  order_record.created_at AS order_created_at,
                  order_record.updated_at AS order_updated_at,
                  project.id AS project_id,
                  project.state AS project_state,
                  project.created_at AS project_created_at,
                  project.updated_at AS project_updated_at,
                  run.id AS run_id,
                  run.character_revision_id AS run_character_revision_id,
                  run.state AS run_state,
                  (run.failure_code IS NOT NULL) AS run_has_failure,
                  run.front_generation_attempts AS awake_generation_attempts,
                  run.sleep_generation_attempts,
                  run.version AS run_version,
                  run.updated_at AS run_updated_at,
                  delivery.status AS delivery_status,
                  delivery.download_count AS delivery_download_count,
                  delivery.expires_at AS delivery_expires_at,
                  delivery.updated_at AS delivery_updated_at,
                  COALESCE(run.updated_at, order_record.updated_at, project.updated_at) AS activity_at
             FROM customer_order order_record
             JOIN pet_project project ON project.id = order_record.project_id
             LEFT JOIN production_run run ON run.order_id = order_record.id
             LEFT JOIN delivery ON delivery.order_id = order_record.id
            WHERE (
                    $1::timestamptz IS NULL
                    OR COALESCE(run.updated_at, order_record.updated_at, project.updated_at) < $1::timestamptz
                    OR (
                      COALESCE(run.updated_at, order_record.updated_at, project.updated_at) = $1::timestamptz
                      AND order_record.id < $2::uuid
                    )
                  )
              AND ${statusSql}
            ORDER BY activity_at DESC, order_record.id DESC
            LIMIT $3
         )
         SELECT page.*,
                COALESCE(actions.action_states, '[]'::jsonb) AS action_states,
                COALESCE(outbox.pending_count, 0) AS outbox_pending,
                COALESCE(outbox.leased_count, 0) AS outbox_leased,
                COALESCE(outbox.failed_count, 0) AS outbox_failed,
                COALESCE(outbox.dead_count, 0) AS outbox_dead
           FROM page
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(
                      jsonb_build_object(
                        'actionId', action.action_id,
                        'state', action.state,
                        'retryCount', action.retry_count,
                        'updatedAt', action.updated_at
                      ) ORDER BY action.action_id
                    ) AS action_states
               FROM generation_action action
              WHERE action.run_id = page.run_id
           ) actions ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) FILTER (WHERE outbox.status = 'pending') AS pending_count,
                    COUNT(*) FILTER (WHERE outbox.status = 'leased') AS leased_count,
                    COUNT(*) FILTER (WHERE outbox.status = 'failed') AS failed_count,
                    COUNT(*) FILTER (WHERE outbox.status = 'dead') AS dead_count
               FROM outbox_job outbox
              WHERE outbox.aggregate_type = 'production_run'
                AND outbox.aggregate_id = page.run_id
           ) outbox ON TRUE
          ORDER BY page.activity_at DESC, page.order_id DESC`,
        [cursorActivityAt, cursorOrderId, pageSize]
      ));
      const hasNextPage = result.length > normalized.limit;
      const items = result.slice(0, normalized.limit).map(mapAdminOperationRow);
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasNextPage && last
          ? encodeAdminOperationsCursor({ activityAt: last.activityAt, orderId: last.order.id })
          : null,
        limit: normalized.limit,
        status: normalized.status
      };
    });
  }

  async reserveSourcePhoto(input = {}) {
    const reservation = assertSourcePhotoReservation(input);
    return this._transaction(async (tx) => {
      await this._lockSourcePhotoStage(tx, reservation.projectId);
      const existingBatch = rows(await tx.query(
        `SELECT expected_photo_count
           FROM source_photo_upload_reservation
          WHERE project_id = $1`,
        [reservation.projectId]
      ));
      if (existingBatch.some((row) => Number(row.expected_photo_count) !== reservation.expectedPhotoCount)) {
        throw new Error("Source photo batch size cannot change after upload grants are reserved");
      }
      const inserted = rows(await tx.query(
        `INSERT INTO source_photo_upload_reservation
          (id, project_id, ordinal, object_key, expected_content_type,
           expected_sha256, expected_byte_size, expected_photo_count, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', now() + make_interval(secs => $9::int))
         ON CONFLICT (project_id, ordinal) DO NOTHING
         RETURNING id, project_id, ordinal, object_key, expected_content_type,
                   expected_sha256, expected_byte_size, expected_photo_count, status,
                   source_photo_revision_id, expires_at, accepted_at`,
        [
          this.idFactory(), reservation.projectId, reservation.ordinal, reservation.objectKey,
          reservation.contentType, reservation.sha256, reservation.byteSize,
          reservation.expectedPhotoCount, this.reservationTtlSeconds
        ]
      ));
      if (inserted.length === 1) return mapReservation(inserted[0]);

      const existingRow = oneRow(await tx.query(
        `SELECT id, project_id, ordinal, object_key, expected_content_type,
                expected_sha256, expected_byte_size, status,
                expected_photo_count,
                source_photo_revision_id, expires_at, accepted_at
           FROM source_photo_upload_reservation
          WHERE project_id = $1 AND ordinal = $2
          FOR UPDATE`,
        [reservation.projectId, reservation.ordinal]
      ), "Source photo reservation could not be recovered");
      const existing = mapReservation(existingRow);
      const exactMatch = existing.objectKey === reservation.objectKey
        && existing.contentType === reservation.contentType
        && existing.sha256 === reservation.sha256
        && existing.byteSize === reservation.byteSize
        && existing.expectedPhotoCount === reservation.expectedPhotoCount;
      if (existing.status === "accepted") {
        if (!exactMatch) throw new Error("Accepted source photos are immutable");
        return existing;
      }
      const replaced = oneRow(await tx.query(
        `UPDATE source_photo_upload_reservation
            SET object_key = $3,
                expected_content_type = $4,
                expected_sha256 = $5,
                expected_byte_size = $6,
                expected_photo_count = $7,
                status = 'reserved',
                source_photo_revision_id = NULL,
                accepted_at = NULL,
                expires_at = now() + make_interval(secs => $8::int),
                updated_at = now()
          WHERE id = $1 AND project_id = $2 AND status <> 'accepted'
        RETURNING id, project_id, ordinal, object_key, expected_content_type,
                  expected_sha256, expected_byte_size, status,
                  expected_photo_count,
                  source_photo_revision_id, expires_at, accepted_at`,
        [
          existing.id, reservation.projectId, reservation.objectKey, reservation.contentType,
          reservation.sha256, reservation.byteSize, reservation.expectedPhotoCount,
          this.reservationTtlSeconds
        ]
      ), "Source photo reservation could not be replaced");
      return mapReservation(replaced);
    });
  }

  async getReservedSourcePhoto({ projectId, ordinal } = {}) {
    const safeProjectId = requiredString(projectId, "Project ID");
    const safeOrdinal = Number(ordinal);
    if (!Number.isInteger(safeOrdinal) || safeOrdinal < 1 || safeOrdinal > 4) throw new Error("Source photo ordinal must be between 1 and 4");
    return this._transaction(async (tx) => {
      const result = rows(await tx.query(
        `SELECT id, project_id, ordinal, object_key, expected_content_type,
                expected_sha256, expected_byte_size, status,
                expected_photo_count,
                source_photo_revision_id, expires_at, accepted_at
           FROM source_photo_upload_reservation
          WHERE project_id = $1
            AND ordinal = $2
            AND (status = 'accepted' OR expires_at > now())`,
        [safeProjectId, safeOrdinal]
      ));
      return result.length === 1 ? mapReservation(result[0]) : null;
    });
  }

  async acceptSourcePhoto({ projectId, ordinal, sha256, byteSize } = {}) {
    const safeProjectId = requiredString(projectId, "Project ID");
    const safeOrdinal = Number(ordinal);
    if (!Number.isInteger(safeOrdinal) || safeOrdinal < 1 || safeOrdinal > 4) throw new Error("Source photo ordinal must be between 1 and 4");
    const verifiedSha256 = normalizeSha256(sha256, "Verified source photo checksum");
    const verifiedByteSize = assertPositiveByteSize(byteSize, "Verified source photo byte size");
    return this._transaction(async (tx) => {
      const stage = await this._lockSourcePhotoStage(tx, safeProjectId);
      const reservationRow = oneRow(await tx.query(
        `SELECT id, project_id, ordinal, object_key, expected_content_type,
                expected_sha256, expected_byte_size, status,
                expected_photo_count,
                source_photo_revision_id, expires_at, accepted_at
           FROM source_photo_upload_reservation
          WHERE project_id = $1 AND ordinal = $2
          FOR UPDATE`,
        [safeProjectId, safeOrdinal]
      ), "Source photo upload reservation was not found");
      const reservation = mapReservation(reservationRow);
      if (reservation.sha256 !== verifiedSha256 || reservation.byteSize !== verifiedByteSize) {
        throw new Error("Verified source photo metadata does not match its reservation");
      }
      if (reservation.status === "accepted") {
        return this._finishSourcePhotoRevision(tx, safeProjectId);
      }

      const insertedMedia = rows(await tx.query(
        `INSERT INTO media_asset
          (id, project_id, run_id, kind, object_key, sha256, content_type, byte_size)
         VALUES ($1, $2, $3, 'source_photo', $4, $5, $6, $7)
         ON CONFLICT (object_key) DO NOTHING
         RETURNING id, project_id, run_id, kind, object_key, sha256, content_type, byte_size`,
        [
          this.idFactory(), safeProjectId, stage.run_id, reservation.objectKey,
          reservation.sha256, reservation.contentType, reservation.byteSize
        ]
      ));
      let mediaRow = insertedMedia[0];
      if (!mediaRow) {
        mediaRow = oneRow(await tx.query(
          `SELECT id, project_id, run_id, kind, object_key, sha256, content_type, byte_size
             FROM media_asset
            WHERE object_key = $1
            FOR UPDATE`,
          [reservation.objectKey]
        ), "Source photo media asset could not be recovered");
        if (mediaRow.project_id !== safeProjectId
          || mediaRow.run_id !== stage.run_id
          || mediaRow.kind !== "source_photo"
          || mediaRow.sha256 !== reservation.sha256
          || mediaRow.content_type !== reservation.contentType
          || databaseNumber(mediaRow.byte_size, "Existing source photo byte size") !== reservation.byteSize) {
          throw new Error("Source photo object key is already bound to different media");
        }
      }

      const sourcePhoto = rows(await tx.query(
        `INSERT INTO source_photo (id, project_id, media_asset_id, ordinal, accepted_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (project_id, ordinal) DO NOTHING
         RETURNING id, media_asset_id`,
        [this.idFactory(), safeProjectId, mediaRow.id, safeOrdinal]
      ));
      if (sourcePhoto.length === 0) {
        const existingPhoto = oneRow(await tx.query(
          `SELECT id, media_asset_id
             FROM source_photo
            WHERE project_id = $1 AND ordinal = $2
            FOR UPDATE`,
          [safeProjectId, safeOrdinal]
        ), "Accepted source photo could not be recovered");
        if (existingPhoto.media_asset_id !== mediaRow.id) {
          throw new Error("Accepted source photo is immutable");
        }
      }

      const accepted = rows(await tx.query(
        `UPDATE source_photo_upload_reservation
            SET status = 'accepted', accepted_at = now(), updated_at = now()
          WHERE id = $1
            AND project_id = $2
            AND status IN ('reserved', 'verified')
            AND expires_at > now()
            AND expected_sha256 = $3
            AND expected_byte_size = $4
        RETURNING id`,
        [reservation.id, safeProjectId, reservation.sha256, reservation.byteSize]
      ));
      if (accepted.length !== 1) {
        throw new Error("Source photo upload reservation has expired or changed");
      }
      return this._finishSourcePhotoRevision(tx, safeProjectId);
    });
  }

  async getRunByProject(projectId) {
    const safeProjectId = requiredString(projectId, "Project ID");
    return this._transaction(async (tx) => {
      const result = rows(await tx.query(
        `SELECT id, project_id, order_id, character_revision_id, state, model_registry_version, species,
                front_generation_attempts, side_generation_attempts,
                front_user_regenerations_used, side_user_regenerations_used,
                front_qa_retries, side_qa_retries, sleep_generation_attempts,
                failure_code, version, created_at, updated_at
           FROM production_run
          WHERE project_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [safeProjectId]
      ));
      return result.length === 1 ? mapRun(result[0]) : null;
    });
  }

  /**
   * Per-action progress for the waiting customer. Video generation is the long
   * stretch of the run - minutes of provider work across seven actions - and a
   * single "正在生成 7 个视频" step left the page frozen for all of it, which
   * reads like a hang. Regenerations are surfaced too: seeing an action redone
   * is what shows the quality gate working rather than something being broken.
   */
  async listActionProgress(runId) {
    const safeRunId = requiredString(runId, "Production run ID");
    return this._transaction(async (tx) => rows(await tx.query(
      `SELECT action_id, state, retry_count
         FROM generation_action
        WHERE run_id = $1
        ORDER BY action_id`,
      [safeRunId]
    )).map((row) => ({
      actionId: row.action_id,
      state: row.state,
      retryCount: Number(row.retry_count || 0)
    })));
  }

  async getSourcePhotoRevision({ projectId, runId } = {}) {
    const safeProjectId = requiredString(projectId, "Project ID");
    const safeRunId = requiredString(runId, "Production run ID");
    return this._transaction(async (tx) => {
      const result = rows(await tx.query(
        `SELECT reservation.ordinal, reservation.expected_photo_count, reservation.source_photo_revision_id
           FROM source_photo_upload_reservation reservation
           JOIN source_photo photo
             ON photo.project_id = reservation.project_id
            AND photo.ordinal = reservation.ordinal
           JOIN media_asset asset
             ON asset.id = photo.media_asset_id
            AND asset.project_id = reservation.project_id
            AND asset.run_id = $2
            AND asset.kind = 'source_photo'
            AND asset.deleted_at IS NULL
          WHERE reservation.project_id = $1
            AND reservation.status = 'accepted'
            AND reservation.source_photo_revision_id IS NOT NULL
          ORDER BY reservation.ordinal`,
        [safeProjectId, safeRunId]
      ));
      const expectedCounts = [...new Set(result.map((row) => Number(row.expected_photo_count)))];
      if (expectedCounts.length !== 1 || result.length !== expectedCounts[0] ||
          result.some((row, index) => Number(row.ordinal) !== index + 1)) return null;
      const revisions = [...new Set(result.map((row) => nullableString(row.source_photo_revision_id)).filter(Boolean))];
      return revisions.length === 1 ? revisions[0] : null;
    });
  }

  async getCharacterCandidate(projectId, view, characterMasterRevisionId) {
    const safeProjectId = requiredString(projectId, "Project ID");
    if (!["front", "side"].includes(view)) throw new Error("Character candidate view must be front or side");
    const selectedId = characterMasterRevisionId === undefined || characterMasterRevisionId === null
      ? null
      : requiredString(characterMasterRevisionId, "Character master revision ID");
    const attemptColumn = view === "front" ? "front_generation_attempts" : "side_generation_attempts";
    return this._transaction(async (tx) => {
      const result = rows(await tx.query(
        `SELECT candidate.id, candidate.project_id, candidate.qa_status, candidate.confirmed_at,
                 candidate.kind,
                 asset.object_key
           FROM image_candidate candidate
           JOIN production_run run
             ON run.id = candidate.run_id
            AND run.project_id = candidate.project_id
            AND run.order_id = candidate.order_id
            AND candidate.generation_attempt = run.${attemptColumn}
           JOIN master_image_generation generation
             ON generation.image_candidate_id = candidate.id
            AND generation.run_id = run.id
            AND generation.project_id = run.project_id
            AND generation.order_id = run.order_id
            AND generation.kind = $2
            AND generation.generation_attempt = run.${attemptColumn}
            AND generation.status = 'qa_passed'
           JOIN media_asset asset
             ON asset.id = candidate.media_asset_id
            AND asset.id = generation.normalized_media_asset_id
           JOIN qa_report qa
             ON qa.id = candidate.qa_report_id
            AND qa.id = generation.qa_report_id
           WHERE candidate.project_id = $1
             AND candidate.kind = $2
             AND candidate.qa_status = 'passed'
             AND asset.project_id = candidate.project_id
             AND asset.run_id = candidate.run_id
             AND asset.kind = ($2 || '_master')::media_kind
             AND asset.deleted_at IS NULL
             AND qa.project_id = candidate.project_id
             AND qa.run_id = candidate.run_id
             AND qa.subject_kind = 'image'
             AND qa.status = 'passed'
             AND qa.subject_media_asset_id = asset.id
             AND qa.source_media_asset_id = generation.provider_output_asset_id
             AND qa.policy_version = generation.processing_policy_version
             AND qa.processor_version = generation.processor_version
             AND ($3::uuid IS NULL OR candidate.id = $3::uuid)
          ORDER BY candidate.created_at DESC
          LIMIT 1`,
        [safeProjectId, view, selectedId]
      ));
      return result.length === 1 ? mapCharacterCandidate(result[0]) : null;
    });
  }

  async getCharacterCandidates(projectId) {
    const [front, side] = await Promise.all([
      this.getCharacterCandidate(projectId, "front"),
      this.getCharacterCandidate(projectId, "side")
    ]);
    return { front, side };
  }

  async getDeliveryForProject(projectId) {
    const safeProjectId = requiredString(projectId, "Project ID");
    return this._transaction(async (tx) => {
      const result = rows(await tx.query(
        `SELECT delivery.id, delivery.order_id, delivery.petpack_build_id,
                delivery.status, delivery.download_count, delivery.expires_at,
                asset.id AS media_asset_id, asset.object_key, asset.sha256
           FROM customer_order order_record
           JOIN delivery ON delivery.order_id = order_record.id
           JOIN petpack_build build
             ON build.id = delivery.petpack_build_id
            AND build.order_id = order_record.id
            AND build.project_id = order_record.project_id
            AND build.status = 'validated'
           JOIN production_run run ON run.id = build.run_id AND run.project_id = order_record.project_id
           JOIN media_asset asset ON asset.id = build.media_asset_id
                            AND asset.project_id = order_record.project_id
                             AND asset.run_id = run.id
                             AND asset.kind = 'final_petpack'
                             AND asset.content_type = 'application/vnd.petpack+zip'
                             AND asset.byte_size > 0
                             AND asset.sha256 = build.sha256
                            AND asset.deleted_at IS NULL
                            AND (asset.expires_at IS NULL OR asset.expires_at > now())
           JOIN qa_report package_qa
             ON package_qa.id = build.package_qa_report_id
            AND package_qa.status = 'passed'
             AND package_qa.subject_kind = 'petpack'
             AND package_qa.project_id = build.project_id
             AND package_qa.run_id = build.run_id
             AND package_qa.action_id IS NULL
             AND package_qa.source_media_asset_id IS NULL
             AND package_qa.petpack_build_id = build.id
             AND package_qa.subject_media_asset_id = asset.id
             AND package_qa.policy_version = build.validation_policy_version
             AND package_qa.validator_version = build.validator_version
             AND package_qa.processor_version = build.validator_version
           JOIN qa_report import_qa
             ON import_qa.id = build.import_qa_report_id
            AND import_qa.status = 'passed'
             AND import_qa.subject_kind = 'desktop_import'
             AND import_qa.project_id = build.project_id
             AND import_qa.run_id = build.run_id
             AND import_qa.action_id IS NULL
             AND import_qa.source_media_asset_id IS NULL
             AND import_qa.petpack_build_id = build.id
             AND import_qa.subject_media_asset_id = asset.id
             AND import_qa.policy_version = build.validation_policy_version
             AND import_qa.validator_version = build.validator_version
             AND import_qa.processor_version = build.validator_version
          WHERE order_record.project_id = $1
            AND order_record.status = 'paid'
            AND order_record.delivery_status = 'ready'
            AND run.state = 'deliverable'
            AND delivery.status = 'ready'
            AND build.package_qa_report_id <> build.import_qa_report_id
            AND build.original_import_verified_at IS NOT NULL
            AND build.customized_interactions_verified_at IS NOT NULL
            AND build.validated_at IS NOT NULL
            AND (delivery.expires_at IS NULL OR delivery.expires_at > now())`,
        [safeProjectId]
      ));
      return result.length === 1 ? mapDelivery(result[0]) : null;
    });
  }

  async recordDeliveryDownload({ deliveryId, actorId } = {}) {
    throw new Error("recordDeliveryDownload requires immutable delivery identities; use authorizeDeliveryDownload");
  }

  async authorizeDeliveryDownload({ deliveryId, actorId, buildId, mediaAssetId, objectKey, sha256 } = {}) {
    const safeDeliveryId = requiredString(deliveryId, "Delivery ID");
    const safeActorId = requiredString(actorId, "Actor ID");
    const safeBuildId = requiredString(buildId, "PetPack build ID");
    const safeMediaAssetId = requiredString(mediaAssetId, "PetPack media asset ID");
    const safeObjectKey = assertPrivateObjectKey(objectKey);
    const safeSha256 = normalizeSha256(sha256, "PetPack delivery checksum");
    return this._transaction(async (tx) => {
      // Resolve immutable identities without taking locks, then use the same
      // explicit lock order as the delivery worker: run -> order -> delivery ->
      // build/assets/QA. A multi-table FOR UPDATE cannot guarantee that order.
      const entitlement = oneRow(await tx.query(
        `SELECT order_record.id AS order_id, run.id AS run_id,
                build.project_id, build.id AS build_id
           FROM delivery
           JOIN customer_order order_record ON order_record.id = delivery.order_id
           JOIN petpack_build build
             ON build.id = delivery.petpack_build_id
            AND build.order_id = order_record.id
           JOIN production_run run
             ON run.id = build.run_id
            AND run.project_id = build.project_id
            AND run.order_id = order_record.id
          WHERE delivery.id = $1
            AND build.id = $2
            AND order_record.id = build.order_id`,
        [safeDeliveryId, safeBuildId]
      ), "PetPack delivery is not available to this account");
      oneRow(await tx.query(
        `SELECT id FROM production_run
          WHERE id = $1 AND project_id = $2 AND order_id = $3
            AND state = 'deliverable'
          FOR UPDATE`,
        [entitlement.run_id, entitlement.project_id, entitlement.order_id]
      ), "PetPack delivery is not available to this account");
      oneRow(await tx.query(
        `SELECT id FROM customer_order
          WHERE id = $1 AND project_id = $2
            AND status = 'paid' AND delivery_status = 'ready'
            AND (
              user_id = $3
              OR EXISTS (
                SELECT 1 FROM app_user actor
                 WHERE actor.id = $3 AND actor.role = 'admin' AND actor.status = 'active'
              )
            )
          FOR UPDATE`,
        [entitlement.order_id, entitlement.project_id, safeActorId]
      ), "PetPack delivery is not available to this account");
      const lockedDelivery = oneRow(await tx.query(
        `SELECT id, order_id, petpack_build_id, status, expires_at
           FROM delivery
          WHERE id = $1 AND order_id = $2 AND petpack_build_id = $3
            AND status = 'ready'
            AND (expires_at IS NULL OR expires_at > now())
          FOR UPDATE`,
        [safeDeliveryId, entitlement.order_id, safeBuildId]
      ), "PetPack delivery is not available to this account");
      oneRow(await tx.query(
        `SELECT build.id
           FROM petpack_build build
           JOIN media_asset asset
             ON asset.id = build.media_asset_id
            AND asset.project_id = build.project_id
            AND asset.run_id = build.run_id
            AND asset.kind = 'final_petpack'
            AND asset.content_type = 'application/vnd.petpack+zip'
            AND asset.byte_size > 0
            AND asset.sha256 = build.sha256
            AND asset.deleted_at IS NULL
            AND (asset.expires_at IS NULL OR asset.expires_at > now())
           JOIN qa_report package_qa
             ON package_qa.id = build.package_qa_report_id
            AND package_qa.status = 'passed'
            AND package_qa.subject_kind = 'petpack'
            AND package_qa.project_id = build.project_id
            AND package_qa.run_id = build.run_id
            AND package_qa.action_id IS NULL
            AND package_qa.source_media_asset_id IS NULL
            AND package_qa.petpack_build_id = build.id
            AND package_qa.subject_media_asset_id = asset.id
            AND package_qa.policy_version = build.validation_policy_version
            AND package_qa.validator_version = build.validator_version
            AND package_qa.processor_version = build.validator_version
           JOIN qa_report import_qa
             ON import_qa.id = build.import_qa_report_id
            AND import_qa.status = 'passed'
            AND import_qa.subject_kind = 'desktop_import'
            AND import_qa.project_id = build.project_id
            AND import_qa.run_id = build.run_id
            AND import_qa.action_id IS NULL
            AND import_qa.source_media_asset_id IS NULL
            AND import_qa.petpack_build_id = build.id
            AND import_qa.subject_media_asset_id = asset.id
            AND import_qa.policy_version = build.validation_policy_version
            AND import_qa.validator_version = build.validator_version
            AND import_qa.processor_version = build.validator_version
          WHERE build.id = $1
            AND build.project_id = $2
            AND build.run_id = $3
            AND build.order_id = $4
            AND build.status = 'validated'
            AND build.package_qa_report_id <> build.import_qa_report_id
            AND build.media_asset_id = $5
            AND asset.object_key = $6
            AND asset.sha256 = $7
            AND build.original_import_verified_at IS NOT NULL
            AND build.customized_interactions_verified_at IS NOT NULL
            AND build.validated_at IS NOT NULL
          FOR UPDATE OF build, asset, package_qa, import_qa`,
        [
          safeBuildId, entitlement.project_id, entitlement.run_id, entitlement.order_id,
          safeMediaAssetId, safeObjectKey, safeSha256
        ]
      ), "PetPack delivery evidence is no longer valid");
      const updated = rows(await tx.query(
        `UPDATE delivery
            SET download_count = download_count + 1,
                last_downloaded_at = now(),
                updated_at = now()
          WHERE id = $1 AND order_id = $2 AND petpack_build_id = $3
            AND status = 'ready'
            AND (expires_at IS NULL OR expires_at > now())
        RETURNING id, order_id, download_count, expires_at`,
        [lockedDelivery.id, entitlement.order_id, safeBuildId]
      ));
      if (updated.length !== 1) {
        throw new Error("PetPack delivery is not available to this account");
      }
      const delivery = updated[0];
      await tx.query(
        `INSERT INTO audit_event (id, actor_id, order_id, event_type, metadata)
         VALUES ($1, $2, $3, 'petpack_download_granted', $4::jsonb)`,
        [this.idFactory(), safeActorId, delivery.order_id, JSON.stringify({ deliveryId: delivery.id })]
      );
      // Keep status ready: users may need a new short-lived grant if an earlier
      // browser download expires or fails, while the audit/count remains durable.
      return {
        id: delivery.id,
        orderId: delivery.order_id,
        downloadCount: databaseNumber(delivery.download_count, "Delivery download count"),
        expiresAt: delivery.expires_at || null
      };
    });
  }

  async _paymentResult(tx, order, projectId) {
    if (order.status !== PAYMENT_STATES.PAID) {
      return { ...order, projectId, productionRunId: null, productionRunNeeded: false };
    }
    const runs = rows(await tx.query(
      `SELECT id
         FROM production_run
        WHERE order_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [order.id]
    ));
    const productionRunId = runs.length === 1 ? runs[0].id : this.idFactory();
    // The run freezes the species chosen at checkout, so it has to travel with
    // the paid order that starts production.
    const project = rows(await tx.query("SELECT species FROM pet_project WHERE id = $1", [projectId]));
    return {
      ...order,
      projectId,
      species: project.length === 1 ? project[0].species : DEFAULT_PET_SPECIES,
      productionRunId,
      productionRunNeeded: runs.length === 0
    };
  }

  async markOrderPaymentState({ platformOrderId, reconciliation } = {}) {
    const safeOrderId = requiredString(platformOrderId, "Platform order ID");
    const verified = normalizeReconciliation(reconciliation);
    return this._transaction(async (tx) => {
      const locked = oneRow(await tx.query(
        `SELECT o.id AS order_id, o.user_id AS order_user_id, o.project_id,
                o.plan_id, o.amount_fen, o.currency, o.payment_method,
                o.status AS order_status, o.version, o.provider_order_id,
                o.paid_at, o.created_at AS order_created_at, o.updated_at AS order_updated_at,
                p.id AS project_id
           FROM customer_order o
           JOIN pet_project p ON p.id = o.project_id
          WHERE o.id = $1
          FOR UPDATE OF o, p`,
        [safeOrderId]
      ), "Payment order was not found");
      const currentOrder = mapOrder(locked);
      let nextState = currentOrder.status === PAYMENT_STATES.PAID
        ? PAYMENT_STATES.PAID
        : verified.state;
      let nextProviderOrderId = currentOrder.providerOrderId || verified.providerOrderId;
      if (currentOrder.providerOrderId && verified.providerOrderId && currentOrder.providerOrderId !== verified.providerOrderId) {
        // Never accept a provider-order substitution, even if an upstream
        // provider response was otherwise marked paid.
        nextState = currentOrder.status === PAYMENT_STATES.PAID ? PAYMENT_STATES.PAID : PAYMENT_STATES.PAYMENT_REVIEW;
        nextProviderOrderId = currentOrder.providerOrderId;
      }
      if ([PAYMENT_STATES.REFUND_PENDING, PAYMENT_STATES.REFUNDED].includes(currentOrder.status)) {
        nextState = currentOrder.status;
      }

      const recorded = rows(await tx.query(
        `INSERT INTO payment_event
          (id, order_id, provider_order_id, event_type, idempotency_key, outcome)
         VALUES ($1, $2, $3, 'provider_reconciliation', $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [this.idFactory(), currentOrder.id, verified.providerOrderId, verified.paymentEventKey, nextState]
      ));
      if (recorded.length === 0) {
        const existingEvent = oneRow(await tx.query(
          "SELECT order_id FROM payment_event WHERE idempotency_key = $1",
          [verified.paymentEventKey]
        ), "Payment event idempotency record could not be recovered");
        if (existingEvent.order_id !== currentOrder.id) {
          throw new Error("Payment event idempotency key belongs to another order");
        }
        return this._paymentResult(tx, currentOrder, locked.project_id);
      }

      let resultingOrder = currentOrder;
      if (currentOrder.status !== nextState || currentOrder.providerOrderId !== nextProviderOrderId) {
        const updated = oneRow(await tx.query(
          `UPDATE customer_order
              SET status = $2::order_status,
                  provider_order_id = $3,
                  paid_at = CASE WHEN $2::order_status = 'paid' THEN COALESCE(paid_at, now()) ELSE paid_at END,
                  version = version + 1,
                  updated_at = now()
            WHERE id = $1
          RETURNING id AS order_id, user_id AS order_user_id, project_id, plan_id,
                    amount_fen, currency, payment_method, status AS order_status,
                    version, provider_order_id, paid_at,
                    created_at AS order_created_at, updated_at AS order_updated_at`,
          [currentOrder.id, nextState, nextProviderOrderId]
        ), "Payment order could not be updated");
        resultingOrder = mapOrder(updated);
      }

      if (resultingOrder.status === PAYMENT_STATES.PAID) {
        await tx.query(
          `UPDATE pet_project
              SET state = CASE
                            WHEN state IN ('draft', 'awaiting_payment') THEN 'awaiting_photos'
                            ELSE state
                          END,
                  updated_at = now()
            WHERE id = $1`,
          [locked.project_id]
        );
      }
      return this._paymentResult(tx, resultingOrder, locked.project_id);
    });
  }

  // ---- photo pre-check -----------------------------------------------------

  async createPhotoPrecheck({ userId, species, fingerprint, photoSha256s, verdicts, passed, modelId, promptVersion } = {}) {
    const id = this.idFactory();
    return this._transaction(async (tx) => {
      const inserted = rows(await tx.query(
        `INSERT INTO photo_precheck
           (id, user_id, species, fingerprint, photo_sha256s, verdicts, passed, model_id, prompt_version)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
         ON CONFLICT (fingerprint) DO UPDATE SET fingerprint = photo_precheck.fingerprint
         RETURNING id, user_id, species, fingerprint, photo_sha256s, verdicts, passed,
                   model_id, prompt_version, created_at`,
        [
          id, requiredString(userId, "User ID"), assertPetSpecies(species),
          requiredString(fingerprint, "Precheck fingerprint"),
          JSON.stringify(photoSha256s), JSON.stringify(verdicts),
          Boolean(passed), requiredString(modelId, "Precheck model ID"),
          requiredString(promptVersion, "Precheck prompt version")
        ]
      ));
      return mapPhotoPrecheck(inserted[0]);
    });
  }

  async findPhotoPrecheckByFingerprint(fingerprint) {
    return this._transaction(async (tx) => {
      const found = rows(await tx.query(
        `SELECT id, user_id, species, fingerprint, photo_sha256s, verdicts, passed,
                model_id, prompt_version, created_at
           FROM photo_precheck WHERE fingerprint = $1`,
        [requiredString(fingerprint, "Precheck fingerprint")]
      ));
      return found.length > 0 ? mapPhotoPrecheck(found[0]) : null;
    });
  }

  async getPhotoPrecheck(id) {
    return this._transaction(async (tx) => {
      const found = rows(await tx.query(
        `SELECT id, user_id, species, fingerprint, photo_sha256s, verdicts, passed,
                model_id, prompt_version, created_at
           FROM photo_precheck WHERE id = $1`,
        [requiredString(id, "Precheck ID")]
      ));
      return found.length > 0 ? mapPhotoPrecheck(found[0]) : null;
    });
  }

  async countRecentPhotoPrechecks({ userId, windowHours = 24 } = {}) {
    const window = Number(windowHours);
    if (!Number.isFinite(window) || window <= 0 || window > 168) {
      throw new Error("Precheck quota window must be 1-168 hours");
    }
    return this._transaction(async (tx) => {
      const counted = rows(await tx.query(
        `SELECT count(*)::int AS n FROM photo_precheck
          WHERE user_id = $1 AND created_at > now() - ($2 || ' hours')::interval`,
        [requiredString(userId, "User ID"), String(window)]
      ));
      return counted[0].n;
    });
  }
}

function mapPhotoPrecheck(row) {
  return {
    id: row.id,
    userId: row.user_id,
    species: row.species,
    fingerprint: row.fingerprint,
    photoSha256s: Array.isArray(row.photo_sha256s) ? row.photo_sha256s : [],
    verdicts: row.verdicts || null,
    passed: Boolean(row.passed),
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    createdAt: row.created_at
  };
}

module.exports = {
  mapPhotoPrecheck,
  ADMIN_OPERATIONS_DEFAULT_LIMIT,
  ADMIN_OPERATIONS_MAX_LIMIT,
  ADMIN_OPERATION_STATUSES,
  PostgresPetPackStudioRepository,
  SOURCE_PHOTO_CONTENT_TYPES,
  checkoutIdempotencyDigest,
  decodeAdminOperationsCursor,
  encodeAdminOperationsCursor,
  mapCharacterCandidate,
  mapAdminOperationRow,
  mapDelivery,
  mapOrder,
  mapProject,
  mapReservation,
  mapRun,
  encryptPaymentNotification,
  normalizePaymentNotificationEncryptionKey,
  normalizeAdminOperationsQuery,
  normalizeReconciliation
};
