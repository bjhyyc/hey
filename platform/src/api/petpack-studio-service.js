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
    "markOrderPaymentState"
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
    this.logger = logger;
  }

  async createCheckout({ actor, planCode, displayName, paymentMethod, paymentChannel, idempotencyKey, species }) {
    const user = requireActor(actor);
    if (!this.checkoutEnabled) {
      const error = new Error("New PetPack orders are temporarily disabled");
      error.code = "generation_sales_disabled";
      throw error;
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
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    ensurePaid(bundle);
    const run = await this.repository.getRunByProject(bundle.project.id);
    if (!run || run.state !== PRODUCTION_STATES.AWAITING_PHOTOS) {
      throw new Error("Photo upload is not available at this stage");
    }
    const normalizedFiles = ensureSourcePhotoSet(files);
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
    }
    return createUserProjectView({ project: bundle.project, order: bundle.order, run, characterCandidates: signedCandidates, delivery });
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
