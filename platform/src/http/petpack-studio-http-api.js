const { createHash, timingSafeEqual } = require("node:crypto");
const { readCookieValue } = require("../auth/phone-auth-service");
const { DEFAULT_PET_SPECIES, PET_SPECIES } = require("../domain/action-catalog");

const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

const HTTP_API_ROUTES = Object.freeze({
  AUTH_CLOUDBASE_SESSION: "POST /api/auth/cloudbase/session",
  AUTH_SESSION: "GET /api/auth/session",
  AUTH_LOGOUT: "POST /api/auth/logout",
  CREATE_CHECKOUT: "POST /api/checkout",
  LIST_PROJECTS: "GET /api/projects",
  CREATE_PHOTO_UPLOAD_GRANTS: "POST /api/projects/:projectId/photos/upload-grants",
  CONFIRM_PHOTO_UPLOAD: "POST /api/projects/:projectId/photos/:ordinal/confirm",
  REGENERATE_FRONT_CHARACTER: "POST /api/projects/:projectId/character/front/regenerate",
  REGENERATE_SIDE_CHARACTER: "POST /api/projects/:projectId/character/side/regenerate",
  CONFIRM_CHARACTER: "POST /api/projects/:projectId/character/confirm",
  GET_PROJECT: "GET /api/projects/:projectId",
  CREATE_PETPACK_DOWNLOAD: "POST /api/projects/:projectId/petpack-download",
  KAIPAY_NOTIFICATION: "POST /api/payments/kaipay/notify/:platformOrderId",
  ADMIN_OPERATIONS: "GET /api/admin/operations",
  ADMIN_OPERATION_COSTS: "GET /api/admin/operations/costs",
  ADMIN_ORDERS_SEARCH: "GET /api/admin/orders",
  ADMIN_ORDER_DETAIL: "GET /api/admin/orders/:orderId",
  ADMIN_ORDER_RERUN: "POST /api/admin/orders/:orderId/rerun",
  ADMIN_ORDER_DELIVERY_REISSUE: "POST /api/admin/orders/:orderId/delivery/reissue",
  ADMIN_RETENTION_PLAN: "GET /api/admin/retention/plan",
  ADMIN_IMAGE_PROMPT_HISTORY: "GET /api/admin/image-prompts/:kind/history",
  ADMIN_SAVE_IMAGE_PROMPT_DRAFT: "POST /api/admin/image-prompts/drafts",
  ADMIN_COPY_IMAGE_PROMPT_VERSION: "POST /api/admin/image-prompts/:kind/copy",
  ADMIN_PUBLISH_IMAGE_PROMPT_VERSION: "POST /api/admin/image-prompts/:kind/publish",
  ADMIN_ROLLBACK_IMAGE_PROMPT_VERSION: "POST /api/admin/image-prompts/:kind/rollback",
  ADMIN_PROMPT_HISTORY: "GET /api/admin/prompts/:actionId/history",
  ADMIN_SAVE_PROMPT_DRAFT: "POST /api/admin/prompts/drafts",
  ADMIN_COPY_PROMPT_VERSION: "POST /api/admin/prompts/:actionId/copy",
  ADMIN_PUBLISH_PROMPT_VERSION: "POST /api/admin/prompts/:actionId/publish",
  ADMIN_ROLLBACK_PROMPT_VERSION: "POST /api/admin/prompts/:actionId/rollback"
});

class HttpApiError extends Error {
  constructor({ status, code, message }) {
    super(message);
    this.name = "HttpApiError";
    this.status = status;
    this.code = code;
  }
}

function badRequest(message = "请求参数无效") {
  return new HttpApiError({ status: 400, code: "invalid_request", message });
}

function notFound() {
  return new HttpApiError({ status: 404, code: "not_found", message: "接口不存在" });
}

function integrationDisabled(message = "服务尚未开放") {
  return new HttpApiError({ status: 503, code: "integration_disabled", message });
}

function requireFunction(value, label) {
  if (typeof value !== "function") throw new Error(`${label} is required`);
  return value;
}

function requireNormalUserService(service) {
  const methods = [
    "createCheckout", "listProjects", "refreshPaymentStatus",
    "createSourcePhotoUploadGrants",
    "confirmSourcePhotoUpload",
    "regenerateCharacterMaster",
    "confirmCharacter",
    "getProjectView",
    "createPetpackDownload",
    "handlePaymentNotification"
  ];
  const missing = methods.filter((method) => !service || typeof service[method] !== "function");
  if (missing.length > 0) {
    throw new Error(`PetPack Studio HTTP API service is incomplete: ${missing.join(", ")}`);
  }
  return service;
}

function requireAuthService(service) {
  const methods = ["exchangeCloudBaseAccessToken", "revokeSessionToken"];
  const missing = methods.filter((method) => !service || typeof service[method] !== "function");
  if (missing.length > 0) throw new Error(`Phone auth service is incomplete: ${missing.join(", ")}`);
  return service;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoUnsafeJsonKeys(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoUnsafeJsonKeys);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw badRequest();
    }
    assertNoUnsafeJsonKeys(child);
  }
}

function decodeJsonObject(value, { maxJsonBytes = DEFAULT_MAX_JSON_BYTES } = {}) {
  let parsed = value;
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    if (Buffer.byteLength(text, "utf8") > maxJsonBytes) throw badRequest("请求内容过大");
    try {
      parsed = JSON.parse(text);
    } catch {
      throw badRequest("请求 JSON 格式无效");
    }
  }
  if (!isPlainObject(parsed)) throw badRequest("请求正文必须是 JSON 对象");
  assertNoUnsafeJsonKeys(parsed);
  return parsed;
}

// Kaipay V3 signs the SHA-256 of the exact POST body. Preserve the bounded raw
// bytes and let the pinned protocol adapter verify them before JSON parsing.
function readBoundedRawNotification(request, { maxJsonBytes = DEFAULT_MAX_JSON_BYTES } = {}) {
  const rawNotification = request?.rawBody;
  if (typeof rawNotification === "string" || Buffer.isBuffer(rawNotification)) {
    if (!rawNotification.length || Buffer.byteLength(rawNotification) > maxJsonBytes) throw badRequest("支付通知内容无效");
    return rawNotification;
  }
  throw badRequest("支付通知必须保留原始字节");
}

function requirePaymentAcknowledgement(value) {
  const status = Number(value && value.status);
  const body = value && typeof value.body === "string" ? value.body : "";
  const contentType = value && typeof value.contentType === "string" ? value.contentType.trim() : "";
  const noContent = status === 204 && body === "" && contentType === "";
  const permittedStatus = (status >= 200 && status <= 299) || (status >= 400 && status <= 599);
  if (!Number.isInteger(status) || !permittedStatus ||
      (!noContent && (!body || Buffer.byteLength(body, "utf8") > 4096 ||
        !/^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+(?:; ?charset=[A-Za-z0-9._-]+)?$/.test(contentType)))) {
    throw new Error("The Kaipay adapter returned an invalid callback acknowledgement");
  }
  return { status, body, contentType };
}

function assertExactKeys(value, { allowed, required = allowed }) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw badRequest();
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw badRequest();
  }
  return value;
}

function requireString(value, { maxLength = 512 } = {}) {
  if (typeof value !== "string") throw badRequest();
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw badRequest();
  return normalized;
}

function requirePositiveSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw badRequest();
  return value;
}

function requirePathParameter(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw badRequest(`${label} 格式无效`);
  }
  return value;
}

function parseRequestTarget(request) {
  const rawPath = typeof request?.path === "string" ? request.path : request?.url;
  if (typeof rawPath !== "string" || !rawPath) throw badRequest("请求路径无效");
  let url;
  try {
    url = new URL(rawPath, "https://petpack.invalid");
  } catch {
    throw badRequest("请求路径无效");
  }
  if (url.hash || !url.pathname.startsWith("/") || url.pathname.includes("//")) {
    throw badRequest("请求路径无效");
  }
  const rawSegments = url.pathname.split("/").slice(1);
  const segments = rawSegments.map((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      if (!decoded || decoded.includes("/") || decoded.includes("\\")) throw badRequest("请求路径无效");
      return decoded;
    } catch (error) {
      if (error instanceof HttpApiError) throw error;
      throw badRequest("请求路径无效");
    }
  });
  return { segments, searchParams: url.searchParams, rawSearch: url.search ? url.search.slice(1) : "", hasSearch: Boolean(url.search) };
}

function parseRequestPath(request) {
  const target = parseRequestTarget(request);
  if (target.hasSearch) throw badRequest("请求路径无效");
  return target.segments;
}

function getMethod(request) {
  if (typeof request?.method !== "string") throw badRequest("请求方法无效");
  return request.method.toUpperCase();
}

function assertNoBody(request) {
  if (request.body !== undefined && request.body !== null && request.body !== "") throw badRequest();
}

function parsePhotoUploadGrantsBody(body) {
  assertExactKeys(body, { allowed: ["files"] });
  if (!Array.isArray(body.files) || body.files.length < 3 || body.files.length > 4) throw badRequest();
  const files = body.files.map((file) => {
    if (!isPlainObject(file)) throw badRequest();
    assertExactKeys(file, { allowed: ["contentType", "sha256", "byteSize"] });
    return {
      contentType: requireString(file.contentType, { maxLength: 64 }),
      sha256: requireString(file.sha256, { maxLength: 128 }),
      byteSize: requirePositiveSafeInteger(file.byteSize)
    };
  });
  return { files };
}

function parseCheckoutBody(body) {
  const required = ["planCode", "displayName", "paymentMethod", "paymentChannel", "idempotencyKey"];
  assertExactKeys(body, { allowed: [...required, "species", "precheckId"], required });
  const paymentChannel = requireString(body.paymentChannel, { maxLength: 16 }).toUpperCase();
  if (!["ALIPAY", "WXPAY"].includes(paymentChannel)) throw badRequest("支付渠道无效");
  // The web bundle deploys on its own schedule, so a checkout from a build that
  // predates the species picker must still work rather than taking orders down.
  // Absent means the historical behaviour: the dog prompt set.
  const species = body.species === undefined ? DEFAULT_PET_SPECIES : requireString(body.species, { maxLength: 8 });
  if (!PET_SPECIES.includes(species)) throw badRequest("宠物种类无效");
  return {
    planCode: requireString(body.planCode, { maxLength: 128 }),
    displayName: requireString(body.displayName, { maxLength: 120 }),
    paymentMethod: requireString(body.paymentMethod, { maxLength: 16 }),
    paymentChannel,
    idempotencyKey: requireString(body.idempotencyKey, { maxLength: 256 }),
    species,
    ...(body.precheckId === undefined ? {} : { precheckId: requireString(body.precheckId, { maxLength: 64 }) })
  };
}

// Downscaled data URLs make this the one deliberately large request body.
const PRECHECK_MAX_JSON_BYTES = 8 * 1024 * 1024;

function parsePhotoPrecheckBody(body) {
  assertExactKeys(body, { allowed: ["species", "photos"], required: ["species", "photos"] });
  const species = requireString(body.species, { maxLength: 8 });
  if (!PET_SPECIES.includes(species)) throw badRequest("宠物种类无效");
  if (!Array.isArray(body.photos) || body.photos.length < 3 || body.photos.length > 4) {
    throw badRequest("预检需要 3 到 4 张照片");
  }
  const photos = body.photos.map((photo, index) => {
    assertExactKeys(photo, {
      allowed: ["ordinal", "originalSha256", "dataUrl"],
      required: ["ordinal", "originalSha256", "dataUrl"]
    });
    const ordinal = Number(photo.ordinal);
    if (ordinal !== index + 1) throw badRequest("预检照片序号无效");
    return {
      ordinal,
      originalSha256: requireString(photo.originalSha256, { maxLength: 64 }),
      dataUrl: requireString(photo.dataUrl, { maxLength: 2 * 1024 * 1024 })
    };
  });
  return { species, photos };
}

function parsePhotoConfirmationBody(body) {
  assertExactKeys(body, { allowed: ["sha256", "byteSize"] });
  return {
    sha256: requireString(body.sha256, { maxLength: 128 }),
    byteSize: requirePositiveSafeInteger(body.byteSize)
  };
}

function parseSingleRevisionBody(body, field) {
  assertExactKeys(body, { allowed: [field] });
  return { [field]: requireString(body[field], { maxLength: 256 }) };
}

function parseCharacterConfirmationBody(body) {
  assertExactKeys(body, { allowed: ["frontMasterRevisionId", "sideMasterRevisionId"] });
  return {
    frontMasterRevisionId: requireString(body.frontMasterRevisionId, { maxLength: 256 }),
    sideMasterRevisionId: requireString(body.sideMasterRevisionId, { maxLength: 256 })
  };
}

function parseCloudBaseSessionBody(body) {
  assertExactKeys(body, { allowed: ["accessToken"] });
  const accessToken = requireString(body.accessToken, { maxLength: 16_384 });
  if (accessToken.length < 24 || /[\s\x00-\x1f\x7f]/.test(accessToken)) throw badRequest();
  return { accessToken };
}

function parseAdminVersionBody(body, fields) {
  assertExactKeys(body, { allowed: fields });
  if (Object.prototype.hasOwnProperty.call(body, "version") && !isPlainObject(body.version)) throw badRequest();
  const parsed = {};
  for (const field of fields) {
    if (field === "version") {
      parsed.version = body.version;
    } else {
      parsed[field] = requireString(body[field], { maxLength: 256 });
    }
  }
  return parsed;
}

function parseAdminImagePromptDraftBody(body) {
  assertExactKeys(body, { allowed: ["version"] });
  if (!isPlainObject(body.version)) throw badRequest();
  assertExactKeys(body.version, { allowed: ["id", "kind", "prompt", "negativePrompt", "version"] });
  if (typeof body.version.negativePrompt !== "string" || body.version.negativePrompt.length > 20000) throw badRequest();
  return { version: {
    id: requireString(body.version.id, { maxLength: 256 }),
    kind: requireString(body.version.kind, { maxLength: 16 }),
    prompt: requireString(body.version.prompt, { maxLength: 20000 }),
    negativePrompt: body.version.negativePrompt.trim(),
    version: requireString(body.version.version, { maxLength: 128 })
  } };
}

function parseAdminImagePromptPublishBody(body) {
  assertExactKeys(body, { allowed: ["publishId", "contentPolicyAttested"] });
  if (body.contentPolicyAttested !== true) throw badRequest("发布前必须确认品牌中立内容政策");
  return {
    publishId: requireString(body.publishId, { maxLength: 256 }),
    contentPolicyAttested: true
  };
}

function parseAdminOperationsQuery(searchParams) {
  const allowed = new Set(["cursor", "limit", "status"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) throw badRequest();
  }
  const cursor = searchParams.get("cursor");
  const status = searchParams.get("status");
  const rawLimit = searchParams.get("limit");
  if (cursor !== null && (!/^[A-Za-z0-9_-]{8,512}$/.test(cursor))) throw badRequest();
  if (status !== null && (!/^[a-z_]{1,32}$/.test(status))) throw badRequest();
  if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) throw badRequest();
  return compactObject({
    cursor: cursor === null ? undefined : cursor,
    status: status === null ? undefined : status,
    limit: rawLimit === null ? undefined : Number(rawLimit)
  });
}

const ADMIN_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_RERUN_STAGE_PATTERN = /^(front_master|side_master|sleep_master|action:[a-z][a-z-]{0,31})$/;

function parseAdminOrdersSearchQuery(searchParams) {
  const allowed = new Set(["orderId", "projectId"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) throw badRequest();
  }
  const orderId = searchParams.get("orderId");
  const projectId = searchParams.get("projectId");
  if (Boolean(orderId) === Boolean(projectId)) throw badRequest("检索需要订单 ID 或项目 ID 之一");
  const target = orderId || projectId;
  if (!ADMIN_UUID_PATTERN.test(target)) throw badRequest("检索 ID 必须是 UUID");
  return compactObject({ orderId: orderId || undefined, projectId: projectId || undefined });
}

function parseAdminRerunBody(body) {
  assertExactKeys(body, { allowed: ["stage", "reason"] });
  const stage = requireString(body.stage, { maxLength: 64 });
  if (!ADMIN_RERUN_STAGE_PATTERN.test(stage)) throw badRequest("重跑环节无效");
  return { stage, reason: requireString(body.reason, { maxLength: 200 }) };
}

function parseAdminDisposalReasonBody(body) {
  assertExactKeys(body, { allowed: ["reason"] });
  return { reason: requireString(body.reason, { maxLength: 200 }) };
}

function parseAdminCostQuery(searchParams) {
  const allowed = new Set(["from", "to", "operation", "actionId", "bucket"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) throw badRequest();
  }
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!from || !to || from.length > 64 || to.length > 64 ||
      !Number.isFinite(new Date(from).getTime()) || !Number.isFinite(new Date(to).getTime())) {
    throw badRequest("成本统计时间范围无效");
  }
  const operation = searchParams.get("operation");
  const actionId = searchParams.get("actionId");
  const bucket = searchParams.get("bucket") || "day";
  if (operation !== null && !/^[a-z_]{1,64}$/.test(operation)) throw badRequest();
  if (actionId !== null && (!ID_PATTERN.test(actionId) || !COST_ACTION_IDS.has(actionId))) throw badRequest();
  if (actionId !== null && operation !== null && operation !== "seedance_video") throw badRequest();
  if (bucket !== "day") throw badRequest();
  return compactObject({ from, to, operation: operation || undefined, actionId: actionId || undefined, bucket });
}

function parseAdminRetentionQuery(searchParams) {
  const allowed = new Set(["mode", "cursor", "limit"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) throw badRequest();
  }
  if (searchParams.get("mode") !== "dry-run") throw badRequest("清理规划只支持 dry-run");
  const cursor = searchParams.get("cursor");
  const rawLimit = searchParams.get("limit");
  if (cursor !== null && !/^[A-Za-z0-9_-]{40,512}$/.test(cursor)) throw badRequest();
  if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) throw badRequest();
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && limit > 100) throw badRequest();
  return compactObject({ mode: "dry-run", cursor: cursor || undefined, limit });
}

function safeString(value, { maxLength = 4096 } = {}) {
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function safeBoolean(value) {
  return value === true;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

// Ordinary responses are deliberately shaped, not merely redacted. This makes
// accidental future additions (prompts, provider task IDs, storage keys, etc.)
// fail closed at the public HTTP boundary.
function serializeCheckout(value) {
  return {
    project: compactObject({ id: safeString(value?.project?.id, { maxLength: 256 }) }),
    order: compactObject({
      id: safeString(value?.order?.id, { maxLength: 256 }),
      status: safeString(value?.order?.status, { maxLength: 64 }),
      paymentMethod: safeString(value?.order?.paymentMethod, { maxLength: 16 }),
      amountFen: safeInteger(value?.order?.amountFen)
    }),
    checkout: compactObject({
      paymentChannel: safeString(value?.checkout?.paymentChannel, { maxLength: 16 }),
      nextAction: serializeKaipayNextAction(value?.checkout?.nextAction)
    })
  };
}

function serializeKaipayNextAction(value) {
  if (!isPlainObject(value)) return undefined;
  const type = safeString(value.type, { maxLength: 32 });
  if (type === "redirect") {
    const url = safeString(value.url, { maxLength: 8192 });
    return url ? { type, url } : undefined;
  }
  if (type === "qr_code") {
    const qrCode = safeString(value.qrCode, { maxLength: 8192 });
    const qrCodeImageUrl = safeString(value.qrCodeImageUrl, { maxLength: 8192 });
    return qrCode || qrCodeImageUrl ? compactObject({ type, qrCode, qrCodeImageUrl }) : undefined;
  }
  if (type === "retry" || type === "poll") {
    const retryAfterSeconds = safeInteger(value.retryAfterSeconds);
    if (!retryAfterSeconds || retryAfterSeconds > 3600) return undefined;
    return compactObject({
      type,
      retryAfterSeconds,
      message: safeString(value.message, { maxLength: 256 })
    });
  }
  return type === "none" ? { type } : undefined;
}

function serializePaymentStatus(value) {
  return {
    order: compactObject({
      id: safeString(value?.order?.id, { maxLength: 256 }),
      status: safeString(value?.order?.status, { maxLength: 64 })
    }),
    nextAction: serializeKaipayNextAction(value?.nextAction)
  };
}

const KAIPAY_V3_WEBHOOK_HEADERS = Object.freeze([
  "X-KPay-API-Version",
  "X-KPay-Event",
  "X-KPay-Timestamp",
  "X-KPay-Nonce",
  "X-KPay-Signature-Method",
  "X-KPay-Body-SHA256",
  "X-KPay-Signature"
]);

function readKaipayV3WebhookHeaders(request) {
  return Object.fromEntries(KAIPAY_V3_WEBHOOK_HEADERS.map((name) => [name, requestHeader(request, name)]));
}

function serializeProjectList(value) {
  const items = Array.isArray(value?.items) ? value.items : [];
  return {
    items: items.map((item) => ({
      project: compactObject({
        id: safeString(item?.project?.id, { maxLength: 256 }),
        displayName: safeString(item?.project?.displayName, { maxLength: 120 }),
        state: safeString(item?.project?.state, { maxLength: 64 }),
        updatedAt: safeString(item?.project?.updatedAt, { maxLength: 64 })
      }),
      order: item?.order ? compactObject({
        id: safeString(item.order.id, { maxLength: 256 }),
        status: safeString(item.order.status, { maxLength: 64 }),
        paymentMethod: safeString(item.order.paymentMethod, { maxLength: 16 }),
        amountFen: safeInteger(item.order.amountFen)
      }) : null,
      productionState: item?.productionState === null ? null : safeString(item?.productionState, { maxLength: 64 }),
      downloadReady: safeBoolean(item?.downloadReady),
      failed: safeBoolean(item?.failed),
      nextStep: safeString(item?.nextStep, { maxLength: 32 })
    }))
  };
}

function serializeUploadGrants(value) {
  if (!Array.isArray(value)) return [];
  return value.map((grant) => compactObject({
    ordinal: safeInteger(grant?.ordinal),
    uploadUrl: safeString(grant?.uploadUrl, { maxLength: 4096 }),
    expiresInSeconds: safeInteger(grant?.expiresInSeconds)
  }));
}

function serializeProjectView(value) {
  const candidates = value?.characterCandidates || {};
  const serializeCandidate = (candidate) => candidate ? compactObject({
    id: safeString(candidate.id, { maxLength: 256 }),
    view: safeString(candidate.view, { maxLength: 16 }),
    previewUrl: safeString(candidate.previewUrl, { maxLength: 4096 }),
    canRegenerate: safeBoolean(candidate.canRegenerate),
    remainingRegenerations: safeInteger(candidate.remainingRegenerations),
    attempts: Array.isArray(candidate.attempts)
      ? candidate.attempts.slice(0, 8).map((attempt) => compactObject({
          id: safeString(attempt.id, { maxLength: 256 }),
          generationAttempt: safeInteger(attempt.generationAttempt),
          previewUrl: safeString(attempt.previewUrl, { maxLength: 4096 }),
          isCurrent: safeBoolean(attempt.isCurrent)
        }))
      : []
  }) : null;
  return {
    project: value?.project ? compactObject({
      id: safeString(value.project.id, { maxLength: 256 }),
      displayName: safeString(value.project.displayName, { maxLength: 120 }),
      state: safeString(value.project.state, { maxLength: 64 })
    }) : null,
    order: value?.order ? compactObject({
      id: safeString(value.order.id, { maxLength: 256 }),
      status: safeString(value.order.status, { maxLength: 64 }),
      paymentMethod: safeString(value.order.paymentMethod, { maxLength: 16 }),
      amountFen: safeInteger(value.order.amountFen)
    }) : null,
    characterCandidates: {
      front: serializeCandidate(candidates.front),
      side: serializeCandidate(candidates.side),
      canConfirm: safeBoolean(candidates.canConfirm)
    },
    productionState: safeString(value?.productionState, { maxLength: 64 }),
    progress: Array.isArray(value?.progress) ? value.progress.map((step) => compactObject({
      id: safeString(step?.id, { maxLength: 128 }),
      label: safeString(step?.label, { maxLength: 256 }),
      state: safeString(step?.state, { maxLength: 32 })
    })) : [],
    actions: Array.isArray(value?.actions) ? value.actions.map((action) => ({
      actionId: safeString(action?.actionId, { maxLength: 64 }),
      label: safeString(action?.label, { maxLength: 64 }),
      stateLabel: safeString(action?.stateLabel, { maxLength: 32 }),
      regenerated: safeBoolean(action?.regenerated),
      complete: safeBoolean(action?.complete)
    })) : [],
    downloadReady: safeBoolean(value?.downloadReady),
    failed: safeBoolean(value?.failed)
  };
}

function serializeDownload(value) {
  return compactObject({
    downloadUrl: safeString(value?.downloadUrl, { maxLength: 4096 }),
    expiresInSeconds: safeInteger(value?.expiresInSeconds)
  });
}

function serializeAdminOperationsPage(value) {
  const items = Array.isArray(value?.items) ? value.items : [];
  return {
    items: items.map((item) => ({
      lastActivityAt: safeString(item?.lastActivityAt, { maxLength: 64 }) || null,
      order: compactObject({
        id: safeString(item?.order?.id, { maxLength: 256 }),
        amountFen: safeInteger(item?.order?.amountFen),
        createdAt: safeString(item?.order?.createdAt, { maxLength: 64 }),
        updatedAt: safeString(item?.order?.updatedAt, { maxLength: 64 })
      }),
      project: compactObject({
        id: safeString(item?.project?.id, { maxLength: 256 }),
        state: safeString(item?.project?.state, { maxLength: 64 }),
        createdAt: safeString(item?.project?.createdAt, { maxLength: 64 }),
        updatedAt: safeString(item?.project?.updatedAt, { maxLength: 64 })
      }),
      payment: compactObject({
        state: safeString(item?.payment?.state, { maxLength: 64 }),
        method: safeString(item?.payment?.method, { maxLength: 16 }),
        paidAt: safeString(item?.payment?.paidAt, { maxLength: 64 })
      }),
      run: item?.run ? compactObject({
        id: safeString(item.run.id, { maxLength: 256 }),
        state: safeString(item.run.state, { maxLength: 64 }),
        hasFailure: safeBoolean(item.run.hasFailure),
        frontGenerationAttempts: safeInteger(item.run.frontGenerationAttempts),
        sideGenerationAttempts: safeInteger(item.run.sideGenerationAttempts),
        sleepGenerationAttempts: safeInteger(item.run.sleepGenerationAttempts),
        version: safeInteger(item.run.version),
        updatedAt: safeString(item.run.updatedAt, { maxLength: 64 })
      }) : null,
      actions: Array.isArray(item?.actions) ? item.actions.map((action) => compactObject({
        actionId: safeString(action?.actionId, { maxLength: 128 }),
        state: safeString(action?.state, { maxLength: 64 }),
        retryCount: safeInteger(action?.retryCount),
        updatedAt: safeString(action?.updatedAt, { maxLength: 64 })
      })) : [],
      delivery: item?.delivery ? compactObject({
        status: safeString(item.delivery.status, { maxLength: 64 }),
        downloadCount: safeInteger(item.delivery.downloadCount),
        expiresAt: safeString(item.delivery.expiresAt, { maxLength: 64 }),
        updatedAt: safeString(item.delivery.updatedAt, { maxLength: 64 })
      }) : null,
      dispatch: compactObject({
        pending: safeInteger(item?.dispatch?.pending),
        leased: safeInteger(item?.dispatch?.leased),
        failed: safeInteger(item?.dispatch?.failed),
        dead: safeInteger(item?.dispatch?.dead)
      }),
      attention: {
        required: safeBoolean(item?.attention?.required),
        reasons: Array.isArray(item?.attention?.reasons)
          ? item.attention.reasons.map((reason) => safeString(reason, { maxLength: 128 })).filter(Boolean)
          : [],
        failedActionIds: Array.isArray(item?.attention?.failedActionIds)
          ? item.attention.failedActionIds.map((actionId) => safeString(actionId, { maxLength: 128 })).filter(Boolean)
          : []
      }
    })),
    page: compactObject({
      limit: safeInteger(value?.page?.limit),
      status: safeString(value?.page?.status, { maxLength: 32 }),
      nextCursor: value?.page?.nextCursor === null ? null : safeString(value?.page?.nextCursor, { maxLength: 512 })
    })
  };
}

function serializeAdminOrdersSearch(value) {
  return { items: serializeAdminOperationsPage({ items: value?.items }).items };
}

function serializeAdminQaSummary(value) {
  if (!value) return null;
  return {
    status: safeString(value.status, { maxLength: 32 }) || null,
    reasons: Array.isArray(value.reasons)
      ? value.reasons.map((reason) => safeString(reason, { maxLength: 200 })).filter(Boolean).slice(0, 5)
      : []
  };
}

// The rescue detail is deliberately shaped like every other admin response:
// preview URLs are already short-lived grants minted by the service, and
// object keys, prompt text, and provider payloads must never appear here.
function serializeAdminOrderDetail(value) {
  return {
    order: compactObject({
      id: safeString(value?.order?.id, { maxLength: 256 }),
      amountFen: safeInteger(value?.order?.amountFen),
      currency: safeString(value?.order?.currency, { maxLength: 8 }),
      paymentMethod: safeString(value?.order?.paymentMethod, { maxLength: 16 }),
      status: safeString(value?.order?.status, { maxLength: 32 }),
      paidAt: safeString(value?.order?.paidAt, { maxLength: 64 }),
      deliveryStatus: safeString(value?.order?.deliveryStatus, { maxLength: 32 }),
      planCode: safeString(value?.order?.planCode, { maxLength: 64 }),
      createdAt: safeString(value?.order?.createdAt, { maxLength: 64 }),
      updatedAt: safeString(value?.order?.updatedAt, { maxLength: 64 })
    }),
    project: compactObject({
      id: safeString(value?.project?.id, { maxLength: 256 }),
      displayName: safeString(value?.project?.displayName, { maxLength: 128 }),
      state: safeString(value?.project?.state, { maxLength: 64 }),
      createdAt: safeString(value?.project?.createdAt, { maxLength: 64 }),
      updatedAt: safeString(value?.project?.updatedAt, { maxLength: 64 })
    }),
    run: value?.run ? compactObject({
      id: safeString(value.run.id, { maxLength: 256 }),
      state: safeString(value.run.state, { maxLength: 64 }),
      failureCode: safeString(value.run.failureCode, { maxLength: 128 }) || null,
      frontGenerationAttempts: safeInteger(value.run.frontGenerationAttempts),
      sideGenerationAttempts: safeInteger(value.run.sideGenerationAttempts),
      sleepGenerationAttempts: safeInteger(value.run.sleepGenerationAttempts),
      frontUserRegenerationsUsed: safeInteger(value.run.frontUserRegenerationsUsed),
      sideUserRegenerationsUsed: safeInteger(value.run.sideUserRegenerationsUsed),
      frontQaRetries: safeInteger(value.run.frontQaRetries),
      sideQaRetries: safeInteger(value.run.sideQaRetries),
      version: safeInteger(value.run.version),
      updatedAt: safeString(value.run.updatedAt, { maxLength: 64 })
    }) : null,
    failedFromState: safeString(value?.failedFromState, { maxLength: 64 }) || null,
    rescue: {
      adminRerunCount: safeInteger(value?.rescue?.adminRerunCount) ?? 0,
      maxAdminRerunsPerOrder: safeInteger(value?.rescue?.maxAdminRerunsPerOrder) ?? 0,
      rerunBudgetExhausted: safeBoolean(value?.rescue?.rerunBudgetExhausted),
      availableStages: Array.isArray(value?.rescue?.availableStages)
        ? value.rescue.availableStages.map((entry) => compactObject({
            stage: safeString(entry?.stage, { maxLength: 64 }),
            mode: safeString(entry?.mode, { maxLength: 32 })
          })).filter((entry) => entry.stage)
        : []
    },
    masters: Array.isArray(value?.masters) ? value.masters.map((attempt) => compactObject({
      id: safeString(attempt?.id, { maxLength: 256 }),
      kind: safeString(attempt?.kind, { maxLength: 16 }),
      generationAttempt: safeInteger(attempt?.generationAttempt),
      status: safeString(attempt?.status, { maxLength: 64 }),
      lastErrorCode: safeString(attempt?.lastErrorCode, { maxLength: 128 }),
      qa: serializeAdminQaSummary(attempt?.qa) || undefined,
      previewUrl: safeString(attempt?.previewUrl, { maxLength: 4096 }),
      createdAt: safeString(attempt?.createdAt, { maxLength: 64 })
    })) : [],
    actions: Array.isArray(value?.actions) ? value.actions.map((action) => compactObject({
      actionId: safeString(action?.actionId, { maxLength: 128 }),
      state: safeString(action?.state, { maxLength: 64 }),
      retryCount: safeInteger(action?.retryCount),
      qa: serializeAdminQaSummary(action?.qa) || undefined,
      previewUrl: safeString(action?.previewUrl, { maxLength: 4096 }),
      updatedAt: safeString(action?.updatedAt, { maxLength: 64 })
    })) : [],
    delivery: value?.delivery ? compactObject({
      status: safeString(value.delivery.status, { maxLength: 32 }),
      downloadCount: safeInteger(value.delivery.downloadCount),
      expiresAt: safeString(value.delivery.expiresAt, { maxLength: 64 }),
      assetRetained: safeBoolean(value.delivery.assetRetained),
      updatedAt: safeString(value.delivery.updatedAt, { maxLength: 64 })
    }) : null,
    dispatch: compactObject({
      pending: safeInteger(value?.dispatch?.pending),
      leased: safeInteger(value?.dispatch?.leased),
      failed: safeInteger(value?.dispatch?.failed),
      dead: safeInteger(value?.dispatch?.dead)
    }),
    timeline: Array.isArray(value?.timeline) ? value.timeline.map((entry) => compactObject({
      source: safeString(entry?.source, { maxLength: 16 }),
      at: safeString(entry?.at, { maxLength: 64 }),
      label: safeString(entry?.label, { maxLength: 128 }),
      detail: safeString(entry?.detail, { maxLength: 256 })
    })) : []
  };
}

function serializeAdminRescueOutcome(value) {
  return compactObject({
    mode: safeString(value?.mode, { maxLength: 64 }),
    stage: safeString(value?.stage, { maxLength: 64 }),
    run: value?.run ? compactObject({
      id: safeString(value.run.id, { maxLength: 256 }),
      state: safeString(value.run.state, { maxLength: 64 })
    }) : undefined,
    delivery: value?.delivery ? compactObject({
      status: safeString(value.delivery.status, { maxLength: 32 }),
      expiresAt: safeString(value.delivery.expiresAt, { maxLength: 64 }),
      downloadCount: safeInteger(value.delivery.downloadCount)
    }) : undefined
  });
}

function safeDecimalString(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text) && text.length <= 128 ? text : undefined;
}

const COST_OPERATION_CODES = new Set(["seedream_front", "seedream_side", "seedream_sleep", "seedance_video"]);
const COST_ACTION_IDS = new Set([
  "idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"
]);

function safeCostOperation(value) {
  return COST_OPERATION_CODES.has(value) ? value : undefined;
}

function safeCostActionId(value, operation) {
  if (value === null && operation !== "seedance_video") return null;
  return operation === "seedance_video" && COST_ACTION_IDS.has(value) ? value : undefined;
}

function serializeCostMetrics(value) {
  return compactObject({
    attempted: safeNonNegativeInteger(value?.attempted),
    accepted: safeNonNegativeInteger(value?.accepted),
    succeeded: safeNonNegativeInteger(value?.succeeded),
    rejected: safeNonNegativeInteger(value?.rejected),
    failed: safeNonNegativeInteger(value?.failed),
    unknown: safeNonNegativeInteger(value?.unknown),
    unpriced: safeNonNegativeInteger(value?.unpriced),
    unresolved: safeNonNegativeInteger(value?.unresolved),
    confirmedCostCny: safeDecimalString(value?.confirmedCostCny),
    adjustmentCostCny: safeDecimalString(value?.adjustmentCostCny),
    totalCostCny: safeDecimalString(value?.totalCostCny)
  });
}

function serializeAdminCostSummary(value) {
  const rangeOperation = value?.range?.operation === null ? null : safeCostOperation(value?.range?.operation);
  const rangeActionId = value?.range?.actionId === null
    ? null
    : safeCostActionId(value?.range?.actionId, rangeOperation);
  const groups = Array.isArray(value?.groups) ? value.groups.flatMap((group) => {
    const operation = safeCostOperation(group?.operation);
    const bucketStart = safeCanonicalTimestamp(group?.bucketStart);
    const actionId = group?.actionId === null ? safeCostActionId(null, operation) : safeCostActionId(group?.actionId, operation);
    return operation && bucketStart && actionId !== undefined
      ? [{ bucketStart, operation, actionId, ...serializeCostMetrics(group) }]
      : [];
  }) : [];
  return {
    range: compactObject({
      from: safeCanonicalTimestamp(value?.range?.from),
      to: safeCanonicalTimestamp(value?.range?.to),
      operation: rangeOperation,
      actionId: rangeActionId,
      bucket: value?.range?.bucket === "day" ? "day" : undefined
    }),
    currency: value?.currency === "CNY" ? "CNY" : undefined,
    total: serializeCostMetrics(value?.total),
    groups
  };
}

const RETENTION_MEDIA_KINDS = [
  "source_photo", "front_master", "side_master", "sleep_master", "provider_input", "provider_output",
  "processing_intermediate", "action_video", "validation_pack", "final_petpack"
];

const RETENTION_BLOCKER_CODES = new Set([
  "policy_disabled", "automatic_cleanup_unsupported", "untracked_object", "inventory_invalid",
  "dependencies_unverified", "unknown_dependency", "object_key_class_mismatch",
  "asset_already_tombstoned", "created_at_invalid", "created_at_in_future",
  "retention_window_not_elapsed", "active_run", "active_job", "active_outbox",
  "reconciliation_required", "retention_hold", "source_photo_reference",
  "source_reservation_reference", "master_frame_reference", "action_master_frame_reference",
  "character_revision_reference", "image_candidate_reference", "master_generation_reference",
  "qa_evidence_reference", "generation_action_reference", "petpack_snapshot_reference",
  "petpack_build_reference", "validation_evidence_reference", "live_delivery",
  "payment_attention", "source_reservation_unsettled"
]);

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeCanonicalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

function safeRetentionPolicyVersion(value) {
  if (value === "unconfigured") return value;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(value)) return undefined;
  return `rp_${createHash("sha256").update(value).digest("hex")}`;
}

function safeRetentionCursor(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,512}$/.test(value) ? value : undefined;
}

function serializeAdminRetentionPlan(value) {
  const safeReasonList = (reasons) => Array.isArray(reasons)
    ? [...new Set(reasons.filter((reason) => RETENTION_BLOCKER_CODES.has(reason)))]
    : [];
  const candidates = Array.isArray(value?.candidates) ? value.candidates.flatMap((candidate) => {
    const candidateId = /^cc_[a-f0-9]{64}$/.test(candidate?.candidateId || "") ? candidate.candidateId : undefined;
    const kind = RETENTION_MEDIA_KINDS.includes(candidate?.kind) ? candidate.kind : undefined;
    const eligibleAt = safeCanonicalTimestamp(candidate?.eligibleAt);
    return candidateId && kind && eligibleAt ? [{ candidateId, kind, eligibleAt }] : [];
  }) : [];
  const blocked = Array.isArray(value?.blocked) ? value.blocked.flatMap((item) => {
    const kind = RETENTION_MEDIA_KINDS.includes(item?.kind) ? item.kind : undefined;
    const reasons = safeReasonList(item?.reasons);
    return kind && reasons.length > 0 ? [{ kind, reasons }] : [];
  }) : [];
  return compactObject({
    mode: value?.mode === "dry-run" ? "dry-run" : undefined,
    policyVersion: safeRetentionPolicyVersion(value?.policyVersion),
    asOf: safeCanonicalTimestamp(value?.asOf),
    candidates,
    blocked,
    summary: compactObject({
      inspected: safeNonNegativeInteger(value?.summary?.inspected),
      candidates: safeNonNegativeInteger(value?.summary?.candidates),
      blocked: safeNonNegativeInteger(value?.summary?.blocked),
      candidatesByKind: Object.fromEntries(RETENTION_MEDIA_KINDS.map((kind) => [
        kind,
        safeNonNegativeInteger(value?.summary?.candidatesByKind?.[kind]) || 0
      ])),
      blockedByReason: Object.fromEntries(Object.entries(value?.summary?.blockedByReason || {})
        .filter(([reason, count]) => RETENTION_BLOCKER_CODES.has(reason) && safeNonNegativeInteger(count) !== undefined)
        .map(([reason, count]) => [reason, count]))
    }),
    page: compactObject({
      limit: Number.isSafeInteger(value?.page?.limit) && value.page.limit >= 1 && value.page.limit <= 100
        ? value.page.limit
        : undefined,
      nextCursor: value?.page?.nextCursor === null ? null : safeRetentionCursor(value?.page?.nextCursor)
    })
  });
}

const ADMIN_FORBIDDEN_FIELDS = /(?:^|[_-])(object[_-]?key|private[_-]?key|secret|token|password|raw[_-]?notification|provider[_-]?task|provider[_-]?order)(?:$|[_-])/i;

function isAdminForbiddenField(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return ADMIN_FORBIDDEN_FIELDS.test(normalized);
}

function serializeAdminValue(value, { depth = 0 } = {}) {
  if (depth > 8 || value === null || value === undefined) return value === null ? null : undefined;
  if (typeof value === "string") return value.length <= 16 * 1024 ? value : undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => serializeAdminValue(item, { depth: depth + 1 })).filter((item) => item !== undefined);
  if (!isPlainObject(value)) return undefined;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (isAdminForbiddenField(key)) continue;
    const serialized = serializeAdminValue(child, { depth: depth + 1 });
    if (serialized !== undefined) safe[key] = serialized;
  }
  return safe;
}

function jsonResponse(status, body, extraHeaders = {}) {
  const noContent = Number(status) === 204 && body === "";
  return {
    status,
    headers: {
      ...(noContent ? {} : { "content-type": "application/json; charset=utf-8" }),
      "cache-control": "no-store",
      ...extraHeaders
    },
    body
  };
}

function requireCookieName(value) {
  if (typeof value !== "string" || !COOKIE_NAME_PATTERN.test(value)) {
    throw new Error("Session cookie name is invalid");
  }
  return value;
}

function serializeSessionCookie({ name, value, expiresAt, secure = true } = {}) {
  const cookieName = requireCookieName(name);
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,256}$/.test(value)) throw new Error("Session cookie value is invalid");
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) throw new Error("Session cookie expiry is invalid");
  const maxAge = Math.max(0, Math.floor((expiry.getTime() - Date.now()) / 1000));
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax;${secure ? " Secure;" : ""} Max-Age=${maxAge}; Expires=${expiry.toUTCString()}`;
}

function serializeExpiredSessionCookie({ name, secure = true } = {}) {
  const cookieName = requireCookieName(name);
  return `${cookieName}=expired; Path=/; HttpOnly; SameSite=Lax;${secure ? " Secure;" : ""} Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function requestHeader(request, name) {
  const headers = request && request.headers;
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) || undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry && entry[1];
}

function normalizeInternalBearerToken(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\u0000]/.test(value)) {
    throw new Error("Studio internal bearer token is invalid");
  }
  return value;
}

function hasValidInternalBearer(request, expectedToken) {
  if (!expectedToken) return true;
  const supplied = requestHeader(request, "authorization");
  if (typeof supplied !== "string" || !supplied.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(supplied.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function mapError(error) {
  if (error instanceof HttpApiError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error?.code === "generation_sales_disabled") {
    return { status: 503, code: "generation_sales_disabled", message: "新订单暂未开放，请稍后再试" };
  }
  if (error?.code === "precheck_quota_exhausted") {
    return { status: 429, code: "precheck_quota_exhausted", message: error.message };
  }
  if (error?.code === "precheck_unavailable" || error?.code === "precheck_provider_error") {
    return { status: 503, code: error.code, message: error.message };
  }
  if (error?.code === "precheck_required") {
    return { status: 409, code: "precheck_required", message: error.message };
  }
  if (error?.code === "character_regeneration_limit_reached") {
    return { status: 409, code: "character_regeneration_limit_reached", message: "该视角的重新生成次数已用完" };
  }
  if (error?.code === "admin_rerun_stage_unavailable") {
    return { status: 409, code: "admin_rerun_stage_unavailable", message: "该环节当前不能重跑" };
  }
  if (error?.code === "admin_rerun_limit_reached") {
    return { status: 409, code: "admin_rerun_limit_reached", message: "该订单的管理员重跑次数已达上限" };
  }
  if (error?.code === "admin_regeneration_grant_unavailable") {
    return { status: 409, code: "admin_regeneration_grant_unavailable", message: "该视角仍有未用完的重新生成次数" };
  }
  if (error?.code === "delivery_reissue_unavailable") {
    return { status: 409, code: "delivery_reissue_unavailable", message: "交付无法补发：包体未就绪或已超出保留期" };
  }
  const message = typeof error?.message === "string" ? error.message : "";
  if (/authenticated actor is required/i.test(message)) {
    return { status: 401, code: "unauthenticated", message: "请先登录后继续" };
  }
  if (/access token was rejected|identity is not active|not phone verified|verified cloudbase phone identity/i.test(message)) {
    return { status: 401, code: "invalid_credentials", message: "登录状态无效，请重新获取验证码" };
  }
  if (/cloudbase identity verification timed out/i.test(message)) {
    return { status: 503, code: "auth_unavailable", message: "登录服务暂时不可用，请稍后重试" };
  }
  if (/access is denied|administrator role is required|unsupported role/i.test(message)) {
    return { status: 403, code: "forbidden", message: "无权执行此操作" };
  }
  if (/not found|was not found/i.test(message)) {
    return { status: 404, code: "not_found", message: "请求的资源不存在" };
  }
  if (/not available|paid order|required for this step|not ready|did not pass|must pass quality checks|current state|stale|conflict|changed concurrently/i.test(message)) {
    return { status: 409, code: "operation_unavailable", message: "当前状态暂不能执行此操作" };
  }
  if (/must be|is required|invalid|exactly two|checksum|byte size|accepts only/i.test(message)) {
    return { status: 400, code: "invalid_request", message: "请求参数无效" };
  }
  return { status: 500, code: "internal_error", message: "服务暂时不可用，请稍后重试" };
}

function createActorResolutionRequest(request) {
  return {
    method: request.method,
    path: request.path || request.url,
    headers: request.headers,
    context: request.context,
    session: request.session
  };
}

function matchRoute(method, segments, normalService, authService, adminPromptService, adminImagePromptService, adminOperationsService, adminCostService, adminRetentionService, adminOrdersService) {
  const is = (...parts) => segments.length === parts.length && parts.every((part, index) => part === segments[index]);
  const projectPrefix = segments[0] === "api" && segments[1] === "projects";
  const adminPrefix = segments[0] === "api" && segments[1] === "admin" && segments[2] === "prompts";
  const adminImagePromptPrefix = segments[0] === "api" && segments[1] === "admin" && segments[2] === "image-prompts";
  const adminOrdersPrefix = segments[0] === "api" && segments[1] === "admin" && segments[2] === "orders";

  if (method === "POST" && is("api", "auth", "cloudbase", "session") && typeof authService?.exchangeCloudBaseAccessToken === "function") {
    return { id: "auth_cloudbase_session" };
  }
  if (method === "GET" && is("api", "auth", "session") && authService) {
    return { id: "auth_session", requiresActor: true };
  }
  if (method === "POST" && is("api", "auth", "logout") && typeof authService?.revokeSessionToken === "function") {
    return { id: "auth_logout" };
  }

  if (normalService && method === "POST" && is("api", "checkout")) return { id: "checkout", requiresActor: true };
  if (normalService && method === "POST" && is("api", "photo-precheck")) return { id: "photo_precheck", requiresActor: true };
  if (normalService && method === "GET" && is("api", "projects")) return { id: "project_list", requiresActor: true };
  if (normalService && method === "POST" && projectPrefix && segments.length === 4 && segments[2] && segments[3] === "payment-status") {
    return { id: "payment_status", requiresActor: true, projectId: requirePathParameter(segments[2], "项目 ID") };
  }
  if (normalService && method === "POST" && projectPrefix && segments.length === 5 && segments[2] && segments[3] === "photos" && segments[4] === "upload-grants") {
    return { id: "photo_upload_grants", requiresActor: true, projectId: requirePathParameter(segments[2], "项目 ID") };
  }
  if (normalService && method === "POST" && projectPrefix && segments.length === 6 && segments[2] && segments[3] === "photos" && segments[5] === "confirm") {
    return {
      id: "photo_upload_confirmation",
      requiresActor: true,
      projectId: requirePathParameter(segments[2], "项目 ID"),
      ordinal: requirePathParameter(segments[4], "照片序号")
    };
  }
  if (normalService && method === "POST" && projectPrefix && segments.length === 6 && segments[2] && segments[3] === "character" && ["front", "side"].includes(segments[4]) && segments[5] === "regenerate") {
    return {
      id: "regenerate_character_master",
      requiresActor: true,
      projectId: requirePathParameter(segments[2], "项目 ID"),
      view: segments[4]
    };
  }
  if (normalService && method === "POST" && projectPrefix && segments.length === 5 && segments[2] && segments[3] === "character" && segments[4] === "confirm") {
    return { id: "confirm_character", requiresActor: true, projectId: requirePathParameter(segments[2], "项目 ID") };
  }
  if (normalService && method === "GET" && projectPrefix && segments.length === 3 && segments[2]) {
    return { id: "project_view", requiresActor: true, projectId: requirePathParameter(segments[2], "项目 ID") };
  }
  if (normalService && method === "POST" && projectPrefix && segments.length === 4 && segments[2] && segments[3] === "petpack-download") {
    return { id: "petpack_download", requiresActor: true, projectId: requirePathParameter(segments[2], "项目 ID") };
  }
  if (normalService && method === "POST" && is("api", "payments", "kaipay", "notify", segments[4])) {
    return { id: "kaipay_notification", platformOrderId: requirePathParameter(segments[4], "平台订单 ID") };
  }
  if (method === "GET" && is("api", "admin", "operations") && typeof adminOperationsService?.listOperations === "function") {
    return { id: "admin_operations", requiresActor: true, acceptsQuery: true };
  }
  if (method === "GET" && is("api", "admin", "operations", "costs") && typeof adminCostService?.getCostSummary === "function") {
    return { id: "admin_operation_costs", requiresActor: true, acceptsQuery: true };
  }
  if (method === "GET" && is("api", "admin", "retention", "plan") && typeof adminRetentionService?.planCleanup === "function") {
    return { id: "admin_retention_plan", requiresActor: true, acceptsQuery: true };
  }
  if (adminOrdersPrefix && adminOrdersService) {
    if (method === "GET" && segments.length === 3 && typeof adminOrdersService.searchOrders === "function") {
      return { id: "admin_orders_search", requiresActor: true, acceptsQuery: true };
    }
    if (method === "GET" && segments.length === 4 && typeof adminOrdersService.getOrderDetail === "function") {
      return { id: "admin_order_detail", requiresActor: true, orderId: requirePathParameter(segments[3], "订单 ID") };
    }
    if (method === "POST" && segments.length === 5 && segments[4] === "rerun" && typeof adminOrdersService.rerunStage === "function") {
      return { id: "admin_order_rerun", requiresActor: true, orderId: requirePathParameter(segments[3], "订单 ID") };
    }
    if (method === "POST" && segments.length === 6 && segments[4] === "delivery" && segments[5] === "reissue" && typeof adminOrdersService.reissueDelivery === "function") {
      return { id: "admin_order_delivery_reissue", requiresActor: true, orderId: requirePathParameter(segments[3], "订单 ID") };
    }
  }
  if (adminImagePromptPrefix) {
    if (method === "GET" && segments.length === 5 && segments[4] === "history" && typeof adminImagePromptService?.getHistory === "function") {
      return { id: "admin_image_prompt_history", requiresActor: true, kind: requirePathParameter(segments[3], "母图提示词类型") };
    }
    if (method === "POST" && is("api", "admin", "image-prompts", "drafts") && typeof adminImagePromptService?.saveDraft === "function") {
      return { id: "admin_save_image_prompt_draft", requiresActor: true };
    }
    if (method === "POST" && segments.length === 5 && segments[4] === "copy" && typeof adminImagePromptService?.copyVersion === "function") {
      return { id: "admin_copy_image_prompt_version", requiresActor: true, kind: requirePathParameter(segments[3], "母图提示词类型") };
    }
    if (method === "POST" && segments.length === 5 && segments[4] === "publish" && typeof adminImagePromptService?.publishVersion === "function") {
      return { id: "admin_publish_image_prompt_version", requiresActor: true, kind: requirePathParameter(segments[3], "母图提示词类型") };
    }
    if (method === "POST" && segments.length === 5 && segments[4] === "rollback" && typeof adminImagePromptService?.rollbackVersion === "function") {
      return { id: "admin_rollback_image_prompt_version", requiresActor: true, kind: requirePathParameter(segments[3], "母图提示词类型") };
    }
  }
  if (!adminPrefix) return null;

  if (method === "GET" && segments.length === 5 && segments[4] === "history" && typeof adminPromptService?.getActionHistory === "function") {
    return { id: "admin_prompt_history", requiresActor: true, actionId: requirePathParameter(segments[3], "动作 ID") };
  }
  if (method === "POST" && is("api", "admin", "prompts", "drafts") && typeof adminPromptService?.saveDraft === "function") {
    return { id: "admin_save_prompt_draft", requiresActor: true };
  }
  if (method === "POST" && segments.length === 5 && segments[4] === "copy" && typeof adminPromptService?.copyVersion === "function") {
    return { id: "admin_copy_prompt_version", requiresActor: true, actionId: requirePathParameter(segments[3], "动作 ID") };
  }
  if (method === "POST" && segments.length === 5 && segments[4] === "publish" && typeof adminPromptService?.publishVersion === "function") {
    return { id: "admin_publish_prompt_version", requiresActor: true, actionId: requirePathParameter(segments[3], "动作 ID") };
  }
  if (method === "POST" && segments.length === 5 && segments[4] === "rollback" && typeof adminPromptService?.rollbackVersion === "function") {
    return { id: "admin_rollback_prompt_version", requiresActor: true, actionId: requirePathParameter(segments[3], "动作 ID") };
  }
  return null;
}

/**
 * Framework-neutral HTTP command adapter. An Express/Fastify/Next route need
 * only translate its request into `{ method, path, headers, body, rawBody,
 * context, session }`, call `handle`, then write the returned status/headers/
 * response body (JSON for application routes, exact provider acknowledgement
 * text for payment callbacks). `resolveActor` is intentionally injected: session, login, PII,
 * and CORS policy remain deployment decisions listed in BLOCKED.md.
 */
function createPetPackStudioHttpApi({ service, petpackService, authService, phoneAuthExchangeEnabled = false, adminPromptService, adminImagePromptService, adminOperationsService, adminCostService, adminRetentionService, adminOrdersService, resolveActor, sessionCookieName, secureSessionCookie = true, internalBearerToken, logger = console, maxJsonBytes = DEFAULT_MAX_JSON_BYTES, now = () => new Date().toISOString() } = {}) {
  const normalServiceCandidate = service || petpackService;
  const normalService = normalServiceCandidate ? requireNormalUserService(normalServiceCandidate) : null;
  const phoneAuthService = authService ? requireAuthService(authService) : null;
  const actorResolver = requireFunction(resolveActor, "A server-side actor resolver");
  const gatewayToken = normalizeInternalBearerToken(internalBearerToken);
  const cookieName = phoneAuthService ? requireCookieName(sessionCookieName) : null;
  if (typeof phoneAuthExchangeEnabled !== "boolean") throw new Error("Phone auth exchange gate must be a boolean");
  if (typeof secureSessionCookie !== "boolean") throw new Error("Secure session-cookie policy is invalid");
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes <= 0) throw new Error("maxJsonBytes must be a positive safe integer");
  if (typeof now !== "function") throw new Error("A server-side clock function is required");

  async function resolveRouteActor(request, route) {
    const actor = await actorResolver({ request: createActorResolutionRequest(request), route: route.id });
    if (!actor) throw new HttpApiError({ status: 401, code: "unauthenticated", message: "请先登录后继续" });
    return actor;
  }

  async function execute(route, request, actor) {
    switch (route.id) {
      case "auth_cloudbase_session": {
        const body = parseCloudBaseSessionBody(decodeJsonObject(request.body, { maxJsonBytes }));
        const session = await phoneAuthService.exchangeCloudBaseAccessToken(body);
        return {
          status: 200,
          headers: { "set-cookie": serializeSessionCookie({ name: cookieName, value: session.sessionToken, expiresAt: session.expiresAt, secure: secureSessionCookie }) },
          body: { authenticated: true, redirectTo: "/projects" }
        };
      }
      case "auth_session": {
        assertNoBody(request);
        return { status: 200, body: { authenticated: Boolean(actor) } };
      }
      case "auth_logout": {
        assertExactKeys(decodeJsonObject(request.body, { maxJsonBytes }), { allowed: [] });
        const sessionToken = readCookieValue(requestHeader(request, "cookie"), cookieName);
        if (sessionToken) await phoneAuthService.revokeSessionToken(sessionToken);
        return {
          status: 200,
          headers: { "set-cookie": serializeExpiredSessionCookie({ name: cookieName, secure: secureSessionCookie }) },
          body: { authenticated: false }
        };
      }
      case "checkout": {
        const body = parseCheckoutBody(decodeJsonObject(request.body, { maxJsonBytes }));
        return { status: 201, body: serializeCheckout(await normalService.createCheckout({ actor, ...body })) };
      }
      case "photo_precheck": {
        const body = parsePhotoPrecheckBody(decodeJsonObject(request.body, { maxJsonBytes: PRECHECK_MAX_JSON_BYTES }));
        const result = await normalService.photoPrecheck({ actor, ...body });
        return {
          status: 200,
          body: compactObject({
            precheckId: safeString(result.precheckId, { maxLength: 64 }),
            passed: safeBoolean(result.passed),
            samePet: safeBoolean(result.samePet),
            verdicts: Array.isArray(result.verdicts)
              ? result.verdicts.map((verdict) => compactObject({
                  ordinal: safeInteger(verdict.ordinal),
                  ok: safeBoolean(verdict.ok),
                  reasons: Array.isArray(verdict.reasons)
                    ? verdict.reasons.map((reason) => safeString(reason, { maxLength: 200 })).filter(Boolean)
                    : [],
                  warnings: Array.isArray(verdict.warnings)
                    ? verdict.warnings.map((warning) => safeString(warning, { maxLength: 200 })).filter(Boolean)
                    : []
                }))
              : [],
            setReasons: Array.isArray(result.setReasons)
              ? result.setReasons.map((reason) => safeString(reason, { maxLength: 200 })).filter(Boolean)
              : [],
            setWarnings: Array.isArray(result.setWarnings)
              ? result.setWarnings.map((warning) => safeString(warning, { maxLength: 300 })).filter(Boolean)
              : [],
            remainingToday: result.remainingToday === null ? undefined : safeInteger(result.remainingToday)
          })
        };
      }
      case "project_list": {
        assertNoBody(request);
        return { status: 200, body: serializeProjectList(await normalService.listProjects({ actor })) };
      }
      case "payment_status": {
        assertExactKeys(decodeJsonObject(request.body, { maxJsonBytes }), { allowed: [] });
        const result = await normalService.refreshPaymentStatus({ actor, projectId: route.projectId });
        return { status: 200, body: serializePaymentStatus(result) };
      }
      case "photo_upload_grants": {
        const body = parsePhotoUploadGrantsBody(decodeJsonObject(request.body, { maxJsonBytes }));
        return { status: 201, body: serializeUploadGrants(await normalService.createSourcePhotoUploadGrants({ actor, projectId: route.projectId, ...body })) };
      }
      case "photo_upload_confirmation": {
        const body = parsePhotoConfirmationBody(decodeJsonObject(request.body, { maxJsonBytes }));
        const ordinal = Number(route.ordinal);
        if (![1, 2, 3, 4].includes(ordinal)) throw badRequest("照片序号必须为 1 到 4");
        const result = await normalService.confirmSourcePhotoUpload({ actor, projectId: route.projectId, ordinal, ...body });
        return { status: 200, body: compactObject({ acceptedCount: safeInteger(result?.acceptedCount) }) };
      }
      case "regenerate_character_master": {
        assertExactKeys(decodeJsonObject(request.body, { maxJsonBytes }), { allowed: [] });
        const result = await normalService.regenerateCharacterMaster({ actor, projectId: route.projectId, view: route.view });
        return { status: 202, body: { accepted: safeBoolean(result?.accepted), view: safeString(result?.view, { maxLength: 16 }) } };
      }
      case "confirm_character": {
        const body = parseCharacterConfirmationBody(decodeJsonObject(request.body, { maxJsonBytes }));
        return { status: 202, body: { accepted: safeBoolean((await normalService.confirmCharacter({ actor, projectId: route.projectId, ...body }))?.accepted) } };
      }
      case "project_view": {
        assertNoBody(request);
        return { status: 200, body: serializeProjectView(await normalService.getProjectView({ actor, projectId: route.projectId })) };
      }
      case "petpack_download": {
        assertExactKeys(decodeJsonObject(request.body, { maxJsonBytes }), { allowed: [] });
        return { status: 200, body: serializeDownload(await normalService.createPetpackDownload({ actor, projectId: route.projectId })) };
      }
      case "kaipay_notification": {
        const rawNotification = readBoundedRawNotification(request, { maxJsonBytes });
        const result = await normalService.handlePaymentNotification({
          platformOrderId: route.platformOrderId,
          rawNotification,
          notificationHeaders: readKaipayV3WebhookHeaders(request)
        });
        // The exact Kaipay acknowledgement is supplied by the pinned protocol
        // adapter. The HTTP layer validates it but never guesses provider text.
        const acknowledgement = requirePaymentAcknowledgement(result && result.acknowledgement);
        return {
          status: acknowledgement.status,
          headers: acknowledgement.contentType ? { "content-type": acknowledgement.contentType } : {},
          body: acknowledgement.body
        };
      }
      case "admin_operations": {
        assertNoBody(request);
        const result = await adminOperationsService.listOperations({ actor, ...route.query });
        return { status: 200, body: serializeAdminOperationsPage(result) };
      }
      case "admin_operation_costs": {
        assertNoBody(request);
        const result = await adminCostService.getCostSummary({ actor, ...route.query });
        return { status: 200, body: serializeAdminCostSummary(result) };
      }
      case "admin_orders_search": {
        assertNoBody(request);
        const result = await adminOrdersService.searchOrders({ actor, ...route.query });
        return { status: 200, body: serializeAdminOrdersSearch(result) };
      }
      case "admin_order_detail": {
        assertNoBody(request);
        const result = await adminOrdersService.getOrderDetail({ actor, orderId: route.orderId });
        return { status: 200, body: serializeAdminOrderDetail(result) };
      }
      case "admin_order_rerun": {
        const body = parseAdminRerunBody(decodeJsonObject(request.body, { maxJsonBytes }));
        const result = await adminOrdersService.rerunStage({ actor, orderId: route.orderId, ...body });
        return { status: 202, body: serializeAdminRescueOutcome(result) };
      }
      case "admin_order_delivery_reissue": {
        const body = parseAdminDisposalReasonBody(decodeJsonObject(request.body, { maxJsonBytes }));
        const result = await adminOrdersService.reissueDelivery({ actor, orderId: route.orderId, ...body });
        return { status: 200, body: serializeAdminRescueOutcome(result) };
      }
      case "admin_retention_plan": {
        assertNoBody(request);
        const result = await adminRetentionService.planCleanup({ actor, ...route.query });
        return { status: 200, body: serializeAdminRetentionPlan(result) };
      }
      case "admin_image_prompt_history": {
        assertNoBody(request);
        const result = await adminImagePromptService.getHistory({ actor, kind: route.kind });
        return { status: 200, body: { items: serializeAdminValue(result) || [] } };
      }
      case "admin_save_image_prompt_draft": {
        const body = parseAdminImagePromptDraftBody(decodeJsonObject(request.body, { maxJsonBytes }));
        const result = await adminImagePromptService.saveDraft({ actor, version: body.version, now: now() });
        return { status: 200, body: serializeAdminValue(result) || {} };
      }
      case "admin_copy_image_prompt_version": {
        const body = parseAdminVersionBody(decodeJsonObject(request.body, { maxJsonBytes }), ["sourceId", "id", "version"]);
        const result = await adminImagePromptService.copyVersion({ actor, kind: route.kind, ...body, now: now() });
        return { status: 200, body: serializeAdminValue(result) || {} };
      }
      case "admin_publish_image_prompt_version": {
        const body = parseAdminImagePromptPublishBody(decodeJsonObject(request.body, { maxJsonBytes }));
        const result = await adminImagePromptService.publishVersion({ actor, kind: route.kind, ...body, now: now() });
        return { status: 200, body: serializeAdminValue(result) || {} };
      }
      case "admin_rollback_image_prompt_version": {
        const body = parseAdminVersionBody(decodeJsonObject(request.body, { maxJsonBytes }), ["targetId", "id", "version"]);
        const result = await adminImagePromptService.rollbackVersion({ actor, kind: route.kind, ...body, now: now() });
        return { status: 200, body: serializeAdminValue(result) || {} };
      }
      case "admin_prompt_history": {
        assertNoBody(request);
        const result = await adminPromptService.getActionHistory({ actor, actionId: route.actionId });
        return { status: 200, body: { items: serializeAdminValue(result) || [] } };
      }
      case "admin_save_prompt_draft": {
        const body = parseAdminVersionBody(decodeJsonObject(request.body, { maxJsonBytes }), ["version"]);
        const result = await adminPromptService.saveDraft({ actor, version: body.version, now: now() });
        return { status: 200, body: serializeAdminValue(result) || {} };
      }
      case "admin_copy_prompt_version": {
        const body = parseAdminVersionBody(decodeJsonObject(request.body, { maxJsonBytes }), ["sourceId", "id", "version"]);
        const result = await adminPromptService.copyVersion({ actor, actionId: route.actionId, ...body, now: now() });
        return { status: 200, body: serializeAdminValue(result) || {} };
      }
      case "admin_publish_prompt_version": {
        const body = parseAdminVersionBody(decodeJsonObject(request.body, { maxJsonBytes }), ["publishId"]);
        const result = await adminPromptService.publishVersion({ actor, actionId: route.actionId, publishId: body.publishId, now: now() });
        return { status: 200, body: serializeAdminValue(result) || {} };
      }
      case "admin_rollback_prompt_version": {
        const body = parseAdminVersionBody(decodeJsonObject(request.body, { maxJsonBytes }), ["targetId", "id", "version"]);
        const result = await adminPromptService.rollbackVersion({ actor, actionId: route.actionId, ...body, now: now() });
        return { status: 200, body: serializeAdminValue(result) || {} };
      }
      default:
        throw notFound();
    }
  }

  return {
    routes: HTTP_API_ROUTES,
    async handle(request) {
      let route;
      try {
        const method = getMethod(request);
        const target = parseRequestTarget(request);
        route = matchRoute(method, target.segments, normalService, phoneAuthService, adminPromptService, adminImagePromptService, adminOperationsService, adminCostService, adminRetentionService, adminOrdersService);
        if (!route) throw notFound();
        if (route.id !== "kaipay_notification" && !hasValidInternalBearer(request, gatewayToken)) {
          throw new HttpApiError({ status: 401, code: "invalid_gateway", message: "服务端网关认证失败" });
        }
        if (route.id === "auth_cloudbase_session" && !phoneAuthExchangeEnabled) {
          throw integrationDisabled("手机号登录暂未开放");
        }
        if (target.hasSearch && !route.acceptsQuery) throw badRequest("请求路径无效");
        if (route.acceptsQuery) {
          if (route.id === "admin_operation_costs") route.query = parseAdminCostQuery(target.searchParams);
          else if (route.id === "admin_retention_plan") route.query = parseAdminRetentionQuery(target.searchParams);
          else if (route.id === "admin_orders_search") route.query = parseAdminOrdersSearchQuery(target.searchParams);
          else route.query = parseAdminOperationsQuery(target.searchParams);
        }
        const actor = route.requiresActor ? await resolveRouteActor(request, route) : undefined;
        const result = await execute(route, request, actor);
        return jsonResponse(result.status, result.body, result.headers);
      } catch (error) {
        const safeError = mapError(error);
        logger.warn?.("petpack.http.request_failed", {
          route: route?.id || "unmatched",
          status: safeError.status,
          code: safeError.code,
          errorName: error && error.name ? error.name : "Error"
        });
        return jsonResponse(safeError.status, { error: { code: safeError.code, message: safeError.message } });
      }
    }
  };
}

module.exports = {
  DEFAULT_MAX_JSON_BYTES,
  HTTP_API_ROUTES,
  HttpApiError,
  createPetPackStudioHttpApi,
  decodeJsonObject,
  mapError,
  parseRequestPath,
  readBoundedRawNotification,
  requirePaymentAcknowledgement,
  serializeExpiredSessionCookie,
  serializeAdminCostSummary,
  serializeAdminOperationsPage,
  serializeAdminRetentionPlan,
  serializeSessionCookie,
  serializeProjectView
};
