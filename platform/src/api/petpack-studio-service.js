const { readImageHeaderDimensions } = require("../media/image-header-dimensions");
const { requireActor, requireProjectOwner } = require("../auth/authorization");
const { PAYMENT_STATES, assertPaymentMethod } = require("../domain/payment-state-machine");
const {
  MAX_USER_REGENERATIONS_PER_VIEW,
  PRODUCTION_STATES,
  assertCharacterMasterView
} = require("../domain/production-state-machine");
const {
  OBJECT_CLASSES,
  createProjectObjectKey,
  resolveDownloadTtlSeconds
} = require("../storage/private-object-store");
const { createUserProjectSummary, createUserProjectView } = require("./project-progress");
const { assertPetSpecies } = require("../domain/action-catalog");
const crypto = require("node:crypto");

const SOURCE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requireRepository(repository) {
  const methods = [
    "createProjectOrder", "listUserProjects", "getProjectBundle", "reserveSourcePhoto",
    "getReservedSourcePhoto", "acceptSourcePhoto", "getRunByProject",
    "getSourcePhotoRevision",
    "getCharacterCandidate", "getCharacterCandidates", "getDeliveryForProject", "authorizeDeliveryDownload",
    "markOrderPaymentState",
    "createPhotoPrecheck", "findPhotoPrecheckByFingerprint", "getPhotoPrecheck", "countRecentPhotoPrechecks"
  ];
  const missing = methods.filter((method) => !repository || typeof repository[method] !== "function");
  if (missing.length > 0) throw new Error(`PetPack Studio repository is incomplete: ${missing.join(", ")}`);
  return repository;
}

function ensurePaid(bundle) {
  if (!bundle || !bundle.order || bundle.order.status !== "paid") {
    throw new Error("A paid order is required for this step");
  }
}

function ensureSourcePhotoSet(files) {
  if (!Array.isArray(files) || files.length < 3 || files.length > 4) {
    throw new Error("Two front full-body photos and one or two 45-degree full-body photos are required");
  }
  const normalized = files.map((file, index) => {
    if (!file || !SOURCE_IMAGE_TYPES.has(file.contentType)) {
      throw new Error(`Photo ${index + 1} must be JPEG, PNG, or WebP`);
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error(`Photo ${index + 1} checksum must be a SHA-256 hex digest`);
    }
    if (!Number.isSafeInteger(file.byteSize) || file.byteSize <= 0) {
      throw new Error(`Photo ${index + 1} byte size must be a positive safe integer`);
    }
    const extension = file.contentType === "image/jpeg" ? "jpg" : file.contentType.split("/")[1];
    const roleName = index < 2 ? `front-${index + 1}` : `angle-${index - 1}`;
    return {
      ordinal: index + 1,
      contentType: file.contentType,
      sha256: file.sha256.toLowerCase(),
      byteSize: file.byteSize,
      fileName: `${roleName}.${extension}`
    };
  });
  if (new Set(normalized.map((file) => file.sha256)).size !== normalized.length) {
    throw new Error("All pet source photos must be different");
  }
  return normalized;
}

function resolveDeliveryDownloadTtlSeconds({ expiresAt, now = Date.now(), storagePolicy = {} } = {}) {
  const configuredTtl = resolveDownloadTtlSeconds(undefined, storagePolicy);
  if (!expiresAt) return configuredTtl;
  const expiryTime = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryTime)) throw new Error("PetPack delivery expiry is invalid");
  const remainingSeconds = Math.floor((expiryTime - Number(now)) / 1000);
  if (!Number.isSafeInteger(remainingSeconds) || remainingSeconds < 1) {
    throw new Error("PetPack delivery has expired");
  }
  return Math.min(configuredTtl, remainingSeconds);
}

const PRECHECK_MAX_DATA_URL_BYTES = 1536 * 1024;
const PRECHECK_TTL_HOURS = 24;
const PRECHECK_VIEW_LABELS = Object.freeze({ front: "正面", side45: "侧面" });

// The master-image processor refuses any identity reference whose decoded edge
// exceeds this, and it does so deep inside generation - after the customer has
// paid. Refuse it here instead, while they can still replace the photograph.
const MAX_SOURCE_PHOTO_EDGE = 4096;

function precheckFingerprint(species, photoSha256s) {
  const sorted = [...photoSha256s].sort();
  return crypto.createHash("sha256").update(`${species}:${sorted.join(",")}`).digest("hex");
}

function ensurePrecheckPhotoSet(photos) {
  if (!Array.isArray(photos) || photos.length < 3 || photos.length > 4) {
    throw new Error("预检需要 3 到 4 张照片");
  }
  return photos.map((photo, index) => {
    const ordinal = Number(photo && photo.ordinal);
    if (ordinal !== index + 1) throw new Error("预检照片序号必须为 1..N");
    if (typeof photo.originalSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(photo.originalSha256)) {
      throw new Error(`第 ${ordinal} 张照片缺少校验和`);
    }
    if (typeof photo.dataUrl !== "string" ||
        !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo.dataUrl)) {
      throw new Error(`第 ${ordinal} 张照片预览格式无效`);
    }
    if (photo.dataUrl.length > PRECHECK_MAX_DATA_URL_BYTES) {
      throw new Error(`第 ${ordinal} 张照片预览过大`);
    }
    return { ordinal, originalSha256: photo.originalSha256.toLowerCase(), dataUrl: photo.dataUrl };
  });
}

// Deterministic verdicts from the model report: slots 1-2 must be usable front
// full-body shots, slot 3 (and 4 when present) usable 45-degree side shots, and
// every photo must show the same animal. Framing faults reject rather than warn
// - weak references cost the customer a weak result, so they are worth a
// re-shoot before any money changes hands.
// Deterministic verdicts from the model report. Calibrated against reality:
// the first delivered order's photos were a sitting front shot, a lying
// cropped shot with a hand in frame, and a sleeping side shot, and they made a
// good pack - so pose, tails and full bodies are none of the gate's business.
// Generation needs exactly two things: the face and coat from the front slots,
// the flank pattern from the side slots. Only what breaks those rejects; every
// framing nicety is a warning the customer may ignore.
function derivePrecheckVerdicts(report, photoCount) {
  const byOrdinal = new Map(
    (Array.isArray(report.photos) ? report.photos : [])
      .filter((entry) => Number.isInteger(entry?.ordinal))
      .map((entry) => [entry.ordinal, entry])
  );
  const verdicts = [];
  for (let ordinal = 1; ordinal <= photoCount; ordinal += 1) {
    const isFrontSlot = ordinal <= 2;
    const judged = byOrdinal.get(ordinal);
    const reasons = [];
    const warnings = [];
    if (!judged) {
      reasons.push("未能识别这张照片");
    } else if (!judged.pet_present) {
      reasons.push("画面里没有真实宠物");
    } else {
      if (!judged.species_match) reasons.push("宠物种类与所选不符");
      if (!judged.single_animal) reasons.push("画面里有多只动物");
      if (!judged.sharp) reasons.push("画面不够清晰");
      if (judged.heavy_obstruction) reasons.push("主体遮挡过多");
      if (!judged.coat_clear) reasons.push("毛发和花色看不清");
      if (isFrontSlot) {
        if (!judged.face_clear) reasons.push("需要五官清晰的正面照");
        else if (judged.view !== "front") warnings.push("更像侧面照，正面效果可能打折");
      } else if (!judged.flank_visible) {
        reasons.push("需要能看到身体侧面花色的照片");
      }
      if (reasons.length > 0 && judged.issue) reasons.push(judged.issue);
    }
    verdicts.push({ ordinal, ok: reasons.length === 0, reasons, warnings });
  }
  const samePet = report.same_animal === true;
  const setReasons = samePet
    ? []
    : ["这几张照片看起来不是同一只宠物"];
  // Photographs from different periods are still the same animal, so the
  // identity check passes them - but generation blends every reference, so a
  // pre-haircut and a post-haircut photo average into a pet the owner does not
  // recognise. That is a trade-off the customer is entitled to make, and one
  // they cannot unmake after paying, so warn rather than refuse.
  const setWarnings = [];
  if (samePet && report.appearance_consistent === false) {
    const note = typeof report.appearance_note === "string" ? report.appearance_note.trim() : "";
    setWarnings.push(
      "这几张看起来不是同一时期的样子" +
      (note ? `（${note}）` : "") +
      "；生成时会融合所有参考图，成品可能和它平时的样子有出入。" +
      "建议换成同一时期、你最熟悉的那个样子。"
    );
  }
  const passed = samePet && verdicts.every((verdict) => verdict.ok);
  return { verdicts, samePet, passed, setReasons, setWarnings };
}

/**
 * API service used by HTTP route handlers. It returns normal-user-safe DTOs;
 * prompts, provider credentials, raw provider output, QA internals, and object
 * storage keys never appear in `getProjectView`.
 */
class PetPackStudioService {
  constructor({
    repository,
    paymentProvider,
    objectStore,
    workflow,
    checkoutEnabled = true,
    precheckVisionClient = null,
    photoPrecheckEnforced = false,
    precheckDailyLimit = 8,
    logger = console
  } = {}) {
    this.repository = requireRepository(repository);
    if (!paymentProvider || typeof paymentProvider.createCheckout !== "function" ||
        typeof paymentProvider.handleNotification !== "function" || typeof paymentProvider.queryStatus !== "function") {
      throw new Error("A payment provider is required");
    }
    if (!objectStore || typeof objectStore.createUploadGrant !== "function" || typeof objectStore.createDownloadGrant !== "function" || typeof objectStore.verifyUploadedObject !== "function") {
      throw new Error("A private object store is required");
    }
    if (!workflow || typeof workflow.startPaidOrder !== "function" || typeof workflow.photosAccepted !== "function" || typeof workflow.confirmCharacterMasters !== "function" || typeof workflow.regenerateCharacterMaster !== "function") {
      throw new Error("A production workflow is required");
    }
    this.paymentProvider = paymentProvider;
    this.objectStore = objectStore;
    this.workflow = workflow;
    if (typeof checkoutEnabled !== "boolean") throw new Error("Checkout admission must be a boolean");
    this.checkoutEnabled = checkoutEnabled;
    if (typeof photoPrecheckEnforced !== "boolean") throw new Error("Photo precheck enforcement must be a boolean");
    if (photoPrecheckEnforced && (!precheckVisionClient || !precheckVisionClient.configured)) {
      throw new Error("Photo precheck enforcement requires a configured vision client");
    }
    if (!Number.isSafeInteger(precheckDailyLimit) || precheckDailyLimit < 1 || precheckDailyLimit > 100) {
      throw new Error("Precheck daily limit must be 1-100");
    }
    this.precheckVisionClient = precheckVisionClient;
    this.photoPrecheckEnforced = photoPrecheckEnforced;
    this.precheckDailyLimit = precheckDailyLimit;
    this.logger = logger;
  }

  /**
   * Judges a candidate photo set BEFORE payment. Identical sets are served from
   * the stored verdict without a model call and without consuming quota.
   */
  async photoPrecheck({ actor, species, photos }) {
    const user = requireActor(actor);
    if (!this.precheckVisionClient || !this.precheckVisionClient.configured) {
      const error = new Error("照片预检暂不可用，请稍后重试");
      error.code = "precheck_unavailable";
      throw error;
    }
    const safeSpecies = assertPetSpecies(species);
    const photoSet = ensurePrecheckPhotoSet(photos);
    const fingerprint = precheckFingerprint(safeSpecies, photoSet.map((photo) => photo.originalSha256));

    const cached = await this.repository.findPhotoPrecheckByFingerprint(fingerprint);
    if (cached && cached.promptVersion === this.precheckVisionClient.promptVersion) {
      this.logger.info?.("petpack.precheck.cache_hit", { userId: user.id, precheckId: cached.id, passed: cached.passed });
      return this._precheckResponse(cached, { remainingToday: null });
    }

    const used = await this.repository.countRecentPhotoPrechecks({ userId: user.id });
    if (used >= this.precheckDailyLimit) {
      const error = new Error("今日预检次数已用完，请明天再试");
      error.code = "precheck_quota_exhausted";
      throw error;
    }

    const requestId = crypto.randomUUID();
    const report = await this.precheckVisionClient.judgePhotoSet({ species: safeSpecies, photos: photoSet, requestId });
    const { verdicts, samePet, passed, setReasons, setWarnings } = derivePrecheckVerdicts(report, photoSet.length);
    const stored = await this.repository.createPhotoPrecheck({
      userId: user.id,
      species: safeSpecies,
      fingerprint,
      photoSha256s: photoSet.map((photo) => photo.originalSha256),
      verdicts: { verdicts, samePet, setReasons, setWarnings },
      passed,
      modelId: this.precheckVisionClient.modelId,
      promptVersion: this.precheckVisionClient.promptVersion
    });
    this.logger.info?.("petpack.precheck.judged", {
      userId: user.id, precheckId: stored.id, passed, samePet,
      failedSlots: verdicts.filter((verdict) => !verdict.ok).map((verdict) => verdict.ordinal)
    });
    return this._precheckResponse(stored, { remainingToday: this.precheckDailyLimit - used - 1 });
  }

  _precheckResponse(row, { remainingToday }) {
    const payload = row.verdicts && Array.isArray(row.verdicts.verdicts)
      ? row.verdicts
      : { verdicts: [], samePet: false, setReasons: [], setWarnings: [] };
    return {
      precheckId: row.id,
      passed: row.passed,
      samePet: payload.samePet,
      verdicts: payload.verdicts,
      setReasons: Array.isArray(payload.setReasons) ? payload.setReasons : [],
      setWarnings: Array.isArray(payload.setWarnings) ? payload.setWarnings : [],
      remainingToday
    };
  }

  async _requirePassingPrecheck({ userId, species, precheckId }) {
    if (typeof precheckId !== "string" || !precheckId.trim()) {
      const error = new Error("需要先通过照片预检才能下单");
      error.code = "precheck_required";
      throw error;
    }
    const row = await this.repository.getPhotoPrecheck(precheckId.trim());
    const ageMs = row ? Date.now() - new Date(row.createdAt).getTime() : Infinity;
    if (!row || row.userId !== userId || !row.passed || row.species !== species ||
        !(ageMs >= 0 && ageMs <= PRECHECK_TTL_HOURS * 3600 * 1000)) {
      const error = new Error("需要先通过照片预检才能下单");
      error.code = "precheck_required";
      throw error;
    }
    return row;
  }

  async createCheckout({ actor, planCode, displayName, paymentMethod, paymentChannel, idempotencyKey, species, precheckId }) {
    const user = requireActor(actor);
    if (!this.checkoutEnabled) {
      const error = new Error("New PetPack orders are temporarily disabled");
      error.code = "generation_sales_disabled";
      throw error;
    }
    if (this.photoPrecheckEnforced) {
      await this._requirePassingPrecheck({
        userId: user.id,
        species: assertPetSpecies(species),
        precheckId
      });
    }
    const order = await this.repository.createProjectOrder({
      userId: user.id,
      planCode: requiredString(planCode, "Plan code"),
      displayName: requiredString(displayName, "Pet display name"),
      paymentMethod: assertPaymentMethod(paymentMethod),
      idempotencyKey: requiredString(idempotencyKey, "Checkout idempotency key"),
      species
    });
    const checkout = await this.paymentProvider.createCheckout({
      platformOrderId: order.id,
      paymentChannel: requiredString(paymentChannel, "Payment channel"),
      idempotencyKey: `checkout:${idempotencyKey}`
    });
    this.logger.info?.("petpack.api.checkout_created", { orderId: order.id, userId: user.id, paymentMethod: order.paymentMethod });
    return {
      project: { id: order.projectId },
      order: { id: order.id, status: checkout.state, paymentMethod: checkout.paymentMethod, amountFen: order.amountFen },
      checkout: {
        provider: checkout.provider,
        providerOrderId: checkout.providerOrderId,
        nextAction: checkout.nextAction,
        paymentChannel: checkout.paymentChannel
      }
    };
  }

  async listProjects({ actor }) {
    const user = requireActor(actor);
    const records = await this.repository.listUserProjects(user.id);
    const items = Array.isArray(records) ? records.map(createUserProjectSummary) : [];
    this.logger.info?.("petpack.api.projects_listed", { userId: user.id, count: items.length });
    return { items };
  }

  async refreshPaymentStatus({ actor, projectId }) {
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    const terminalStates = new Set([PAYMENT_STATES.PAID, PAYMENT_STATES.EXPIRED, PAYMENT_STATES.REFUNDED]);
    if (terminalStates.has(bundle.order.status)) {
      return { order: { id: bundle.order.id, status: bundle.order.status }, nextAction: { type: "none" } };
    }
    const reconciliation = await this.paymentProvider.queryStatus({ platformOrderId: bundle.order.id });
    if (!reconciliation || reconciliation.applyToOrder === false) {
      throw new Error("Kaipay payment status could not be confirmed");
    }
    const order = await this.repository.markOrderPaymentState({ platformOrderId: bundle.order.id, reconciliation });
    if (reconciliation.state === PAYMENT_STATES.PAID && order.productionRunNeeded) {
      await this.workflow.startPaidOrder({
        order,
        projectId: order.projectId,
        runId: order.productionRunId,
        species: order.species
      });
    }
    return {
      order: { id: order.id, status: order.status },
      nextAction: reconciliation.nextAction || { type: "none" }
    };
  }

  async createSourcePhotoUploadGrants({ actor, projectId, files }) {
    const user = requireActor(actor);
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    ensurePaid(bundle);
    const run = await this.repository.getRunByProject(bundle.project.id);
    if (!run || run.state !== PRODUCTION_STATES.AWAITING_PHOTOS) {
      throw new Error("Photo upload is not available at this stage");
    }
    const normalizedFiles = ensureSourcePhotoSet(files);
    if (this.photoPrecheckEnforced) {
      // Species lives on the project, not on the order. Reading it from the
      // order yielded undefined, so the fingerprint was computed over
      // "undefined:<digests>" and could never match the stored pre-check -
      // every paid customer hit "这组照片尚未通过预检" at the upload step.
      const fingerprint = precheckFingerprint(
        bundle.project.species,
        normalizedFiles.map((file) => file.sha256)
      );
      const precheck = await this.repository.findPhotoPrecheckByFingerprint(fingerprint);
      if (!precheck || !precheck.passed || precheck.userId !== user.id) {
        const error = new Error("这组照片尚未通过预检，请先在首页完成预检");
        error.code = "precheck_required";
        throw error;
      }
    }
    const grants = [];
    for (const file of normalizedFiles) {
      const objectKey = createProjectObjectKey({
        projectId: bundle.project.id,
        objectClass: OBJECT_CLASSES.SOURCE_PHOTO,
        fileName: file.fileName
      });
      await this.repository.reserveSourcePhoto({
        projectId: bundle.project.id,
        ordinal: file.ordinal,
        objectKey,
        contentType: file.contentType,
        sha256: file.sha256,
        byteSize: file.byteSize,
        expectedPhotoCount: normalizedFiles.length
      });
      grants.push(await this.objectStore.createUploadGrant({
        objectKey,
        contentType: file.contentType,
        expectedSha256: file.sha256,
        expectedByteSize: file.byteSize
      }));
    }
    return grants.map((grant, index) => ({ ordinal: index + 1, uploadUrl: grant.url, expiresInSeconds: grant.expiresInSeconds }));
  }

  // The processor's decode limit is enforced here, at the moment the upload is
  // accepted, because failing it later means a paid run dies with nothing the
  // customer can do about it.
  async _assertPhotoWithinDecodeLimit(objectKey, ordinal) {
    if (typeof this.objectStore.readObjectHead !== "function") return;
    let dimensions = null;
    try {
      dimensions = readImageHeaderDimensions(await this.objectStore.readObjectHead({ objectKey }));
    } catch (error) {
      // An unreadable header is not proof of an oversized photo; let the
      // pipeline judge it rather than refusing a good upload on a read blip.
      this.logger.warn?.("petpack.photo.dimension_probe_failed", {
        ordinal,
        errorName: error && error.name ? error.name : "Error"
      });
      return;
    }
    if (!dimensions) return;
    if (dimensions.width > MAX_SOURCE_PHOTO_EDGE || dimensions.height > MAX_SOURCE_PHOTO_EDGE) {
      const error = new Error(
        `第 ${ordinal} 张照片尺寸过大（${dimensions.width}×${dimensions.height}），` +
        `长边不能超过 ${MAX_SOURCE_PHOTO_EDGE} 像素，请压缩后重新上传`
      );
      error.code = "source_photo_too_large";
      throw error;
    }
  }

  async confirmSourcePhotoUpload({ actor, projectId, ordinal, sha256, byteSize }) {
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    ensurePaid(bundle);
    if (![1, 2, 3, 4].includes(Number(ordinal))) throw new Error("Photo ordinal must be between 1 and 4");
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Photo checksum is invalid");
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error("Photo byte size is invalid");
    const run = await this.repository.getRunByProject(bundle.project.id);
    if (!run || run.state !== PRODUCTION_STATES.AWAITING_PHOTOS) {
      throw new Error("Photo upload confirmation is not available at this stage");
    }
    const reservation = await this.repository.getReservedSourcePhoto({ projectId: bundle.project.id, ordinal: Number(ordinal) });
    if (!reservation || !reservation.objectKey || !reservation.contentType) {
      throw new Error("Photo upload reservation was not found");
    }
    const verified = await this.objectStore.verifyUploadedObject({
      objectKey: reservation.objectKey,
      expectedContentType: reservation.contentType,
      expectedSha256: sha256.toLowerCase(),
      expectedByteSize: byteSize
    });
    await this._assertPhotoWithinDecodeLimit(reservation.objectKey, Number(ordinal));
    const acceptance = await this.repository.acceptSourcePhoto({
      projectId: bundle.project.id,
      ordinal: Number(ordinal),
      sha256: verified.sha256,
      byteSize: verified.byteSize
    });
    if (!acceptance || !Number.isInteger(acceptance.acceptedCount)) {
      throw new Error("Photo acceptance did not return a durable state");
    }
    // `allAcceptedNow` must be claimed transactionally by the persistence
    // adapter. It is the idempotency fence that prevents two completion calls
    // from enqueueing two awake-master generations.
    if (acceptance.allAcceptedNow) {
      if (typeof acceptance.sourcePhotoRevisionId !== "string" || !acceptance.sourcePhotoRevisionId) {
        throw new Error("Completed source photos require an immutable revision ID");
      }
      await this.workflow.photosAccepted({ run, sourcePhotoRevisionId: acceptance.sourcePhotoRevisionId });
    }
    return { acceptedCount: acceptance.acceptedCount };
  }

  async regenerateCharacterMaster({ actor, projectId, view }) {
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    ensurePaid(bundle);
    const run = await this.repository.getRunByProject(bundle.project.id);
    if (!run || run.state !== PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION) {
      throw new Error("Character master regeneration is not available at this stage");
    }
    const safeView = assertCharacterMasterView(view);
    const used = Number(run[`${safeView}UserRegenerationsUsed`] || 0);
    if (used >= MAX_USER_REGENERATIONS_PER_VIEW) {
      const error = new Error(`The ${safeView} character master self-service regeneration limit has been reached`);
      error.code = "character_regeneration_limit_reached";
      this.logger.warn?.("petpack.api.character_regeneration_rejected", {
        projectId: bundle.project.id,
        runId: run.id,
        view: safeView,
        reason: error.code,
        used
      });
      throw error;
    }
    const sourcePhotoRevisionId = await this.repository.getSourcePhotoRevision({
      projectId: bundle.project.id,
      runId: run.id
    });
    if (!sourcePhotoRevisionId) throw new Error("The immutable source-photo revision is unavailable");
    await this.workflow.regenerateCharacterMaster({ run, sourcePhotoRevisionId, view: safeView });
    return { accepted: true, view: safeView };
  }

  async confirmCharacter({ actor, projectId, frontMasterRevisionId, sideMasterRevisionId }) {
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    ensurePaid(bundle);
    const run = await this.repository.getRunByProject(bundle.project.id);
    if (!run || run.state !== PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION) {
      throw new Error("Character confirmation is not available at this stage");
    }
    const [front, side] = await Promise.all([
      this.repository.getCharacterCandidate(bundle.project.id, "front", requiredString(frontMasterRevisionId, "Front master revision ID")),
      this.repository.getCharacterCandidate(bundle.project.id, "side", requiredString(sideMasterRevisionId, "Side master revision ID"))
    ]);
    if (!front || front.qaStatus !== "passed" || !side || side.qaStatus !== "passed") {
      throw new Error("Both selected character masters must pass quality checks");
    }
    await this.workflow.confirmCharacterMasters({
      run,
      frontMasterRevisionId: front.id,
      sideMasterRevisionId: side.id
    });
    return { accepted: true };
  }

  async getProjectView({ actor, projectId }) {
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    const [run, characterCandidates, delivery] = await Promise.all([
      this.repository.getRunByProject(bundle.project.id),
      this.repository.getCharacterCandidates(bundle.project.id),
      this.repository.getDeliveryForProject(bundle.project.id)
    ]);
    const signedCandidates = {};
    for (const view of ["front", "side"]) {
      const candidate = characterCandidates && characterCandidates[view];
      if (!candidate) {
        signedCandidates[view] = null;
        continue;
      }
      if (typeof candidate.objectKey !== "string" || !candidate.objectKey.startsWith("private/")) {
        throw new Error(`${view} character preview is not available from private storage`);
      }
      const preview = await this.objectStore.createDownloadGrant({
        objectKey: candidate.objectKey,
        disposition: "inline"
      });
      signedCandidates[view] = { ...candidate, view, previewUrl: preview.url };

      // Sign every earlier attempt too, so a customer out of regenerations can
      // still pick whichever version turned out best rather than the last one.
      if (typeof this.repository.listCharacterCandidates === "function") {
        const history = await this.repository.listCharacterCandidates(bundle.project.id, view);
        const signedHistory = [];
        for (const attempt of history) {
          if (typeof attempt.objectKey !== "string" || !attempt.objectKey.startsWith("private/")) continue;
          const grant = await this.objectStore.createDownloadGrant({
            objectKey: attempt.objectKey,
            disposition: "inline"
          });
          signedHistory.push({
            id: attempt.id,
            generationAttempt: attempt.generationAttempt,
            previewUrl: grant.url,
            isCurrent: attempt.id === candidate.id
          });
        }
        signedCandidates[view].attempts = signedHistory;
      }
    }
    const actions = run && typeof this.repository.listActionProgress === "function"
      ? await this.repository.listActionProgress(run.id)
      : [];
    return createUserProjectView({
      project: bundle.project,
      order: bundle.order,
      run,
      characterCandidates: signedCandidates,
      delivery,
      actions
    });
  }

  async createPetpackDownload({ actor, projectId }) {
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    const delivery = await this.repository.getDeliveryForProject(bundle.project.id);
    if (!delivery || delivery.status !== "ready" || !delivery.objectKey) {
      throw new Error("PetPack download is not ready");
    }
    const authorization = await this.repository.authorizeDeliveryDownload({
      deliveryId: delivery.id,
      actorId: actor.id,
      buildId: delivery.buildId,
      mediaAssetId: delivery.mediaAssetId,
      objectKey: delivery.objectKey,
      sha256: delivery.sha256
    });
    const expiresInSeconds = resolveDeliveryDownloadTtlSeconds({
      expiresAt: authorization.expiresAt || delivery.expiresAt,
      storagePolicy: this.objectStore.policy || {}
    });
    const grant = await this.objectStore.createDownloadGrant({
      objectKey: delivery.objectKey,
      disposition: "attachment",
      expiresInSeconds
    });
    return { downloadUrl: grant.url, expiresInSeconds: grant.expiresInSeconds };
  }

  async handlePaymentNotification({ platformOrderId, rawNotification, notificationHeaders }) {
    const reconciliation = await this.paymentProvider.handleNotification({
      platformOrderId,
      rawNotification,
      notificationHeaders
    });
    if (reconciliation.applyToOrder === false) {
      return { accepted: false, acknowledgement: reconciliation.acknowledgement };
    }
    const order = await this.repository.markOrderPaymentState({ platformOrderId, reconciliation });
    if (reconciliation.state === "paid" && order.productionRunNeeded) {
      await this.workflow.startPaidOrder({ order, projectId: order.projectId, runId: order.productionRunId });
    }
    return { accepted: true, acknowledgement: reconciliation.acknowledgement };
  }
}

module.exports = {
  PetPackStudioService,
  SOURCE_IMAGE_TYPES,
  createUserProjectView,
  ensureSourcePhotoSet,
  resolveDeliveryDownloadTtlSeconds
};
