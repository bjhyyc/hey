const { requireActor, requireProjectOwner } = require("../auth/authorization");
const { assertPaymentMethod } = require("../domain/payment-state-machine");
const { PRODUCTION_STATES } = require("../domain/production-state-machine");
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
    "getAwakeCandidate", "getDeliveryForProject", "authorizeDeliveryDownload",
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

function ensureExactlyTwoPhotos(files) {
  if (!Array.isArray(files) || files.length !== 2) throw new Error("Exactly two clear full-body pet photos are required");
  return files.map((file, index) => {
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
    return {
      ordinal: index + 1,
      contentType: file.contentType,
      sha256: file.sha256.toLowerCase(),
      byteSize: file.byteSize,
      fileName: `source-${index + 1}.${extension}`
    };
  });
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
  constructor({ repository, paymentProvider, objectStore, workflow, logger = console } = {}) {
    this.repository = requireRepository(repository);
    if (!paymentProvider || typeof paymentProvider.createCheckout !== "function" || typeof paymentProvider.handleNotification !== "function") {
      throw new Error("A payment provider is required");
    }
    if (!objectStore || typeof objectStore.createUploadGrant !== "function" || typeof objectStore.createDownloadGrant !== "function" || typeof objectStore.verifyUploadedObject !== "function") {
      throw new Error("A private object store is required");
    }
    if (!workflow || typeof workflow.startPaidOrder !== "function" || typeof workflow.photosAccepted !== "function" || typeof workflow.confirmAwakeMaster !== "function" || typeof workflow.regenerateAwakeMaster !== "function") {
      throw new Error("A production workflow is required");
    }
    this.paymentProvider = paymentProvider;
    this.objectStore = objectStore;
    this.workflow = workflow;
    this.logger = logger;
  }

  async createCheckout({ actor, planCode, displayName, paymentMethod, idempotencyKey }) {
    const user = requireActor(actor);
    const order = await this.repository.createProjectOrder({
      userId: user.id,
      planCode: requiredString(planCode, "Plan code"),
      displayName: requiredString(displayName, "Pet display name"),
      paymentMethod: assertPaymentMethod(paymentMethod),
      idempotencyKey: requiredString(idempotencyKey, "Checkout idempotency key")
    });
    const checkout = await this.paymentProvider.createCheckout({
      platformOrderId: order.id,
      idempotencyKey: `checkout:${idempotencyKey}`
    });
    this.logger.info?.("petpack.api.checkout_created", { orderId: order.id, userId: user.id, paymentMethod: order.paymentMethod });
    return {
      project: { id: order.projectId },
      order: { id: order.id, status: checkout.state, paymentMethod: checkout.paymentMethod, amountFen: order.amountFen },
      checkout: { provider: checkout.provider, providerOrderId: checkout.providerOrderId, checkoutUrl: checkout.checkoutUrl }
    };
  }

  async listProjects({ actor }) {
    const user = requireActor(actor);
    const records = await this.repository.listUserProjects(user.id);
    const items = Array.isArray(records) ? records.map(createUserProjectSummary) : [];
    this.logger.info?.("petpack.api.projects_listed", { userId: user.id, count: items.length });
    return { items };
  }

  async createSourcePhotoUploadGrants({ actor, projectId, files }) {
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    ensurePaid(bundle);
    const run = await this.repository.getRunByProject(bundle.project.id);
    if (!run || run.state !== PRODUCTION_STATES.AWAITING_PHOTOS) {
      throw new Error("Photo upload is not available at this stage");
    }
    const normalizedFiles = ensureExactlyTwoPhotos(files);
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
        byteSize: file.byteSize
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
    if (![1, 2].includes(Number(ordinal))) throw new Error("Photo ordinal must be 1 or 2");
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

  async regenerateAwakeCharacter({ actor, projectId }) {
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    ensurePaid(bundle);
    const run = await this.repository.getRunByProject(bundle.project.id);
    if (!run || run.state !== PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION) {
      throw new Error("Awake character regeneration is not available at this stage");
    }
    const sourcePhotoRevisionId = await this.repository.getSourcePhotoRevision({
      projectId: bundle.project.id,
      runId: run.id
    });
    if (!sourcePhotoRevisionId) throw new Error("The immutable source-photo revision is unavailable");
    await this.workflow.regenerateAwakeMaster({ run, sourcePhotoRevisionId });
    return { accepted: true };
  }

  async confirmAwakeCharacter({ actor, projectId, awakeMasterRevisionId }) {
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    ensurePaid(bundle);
    const run = await this.repository.getRunByProject(bundle.project.id);
    if (!run || run.state !== PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION) {
      throw new Error("Awake character confirmation is not available at this stage");
    }
    const candidate = await this.repository.getAwakeCandidate(bundle.project.id, requiredString(awakeMasterRevisionId, "Awake master revision ID"));
    if (!candidate || candidate.qaStatus !== "passed") throw new Error("The selected awake character did not pass quality checks");
    await this.workflow.confirmAwakeMaster({ run, awakeMasterRevisionId: candidate.id });
    return { accepted: true };
  }

  async getProjectView({ actor, projectId }) {
    const bundle = await this.repository.getProjectBundle(requiredString(projectId, "Project ID"));
    requireProjectOwner(actor, bundle.project);
    const [run, awakeCandidate, delivery] = await Promise.all([
      this.repository.getRunByProject(bundle.project.id),
      this.repository.getAwakeCandidate(bundle.project.id),
      this.repository.getDeliveryForProject(bundle.project.id)
    ]);
    let signedAwakeCandidate = awakeCandidate;
    if (awakeCandidate) {
      if (typeof awakeCandidate.objectKey !== "string" || !awakeCandidate.objectKey.startsWith("private/")) {
        throw new Error("Awake character preview is not available from private storage");
      }
      const preview = await this.objectStore.createDownloadGrant({
        objectKey: awakeCandidate.objectKey,
        disposition: "inline"
      });
      signedAwakeCandidate = { ...awakeCandidate, previewUrl: preview.url };
    }
    return createUserProjectView({ project: bundle.project, order: bundle.order, run, awakeCandidate: signedAwakeCandidate, delivery });
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

  async handlePaymentNotification({ platformOrderId, rawNotification }) {
    const reconciliation = await this.paymentProvider.handleNotification({ platformOrderId, rawNotification });
    const order = await this.repository.markOrderPaymentState({ platformOrderId, reconciliation });
    if (reconciliation.state === "paid" && order.productionRunNeeded) {
      await this.workflow.startPaidOrder({ order, projectId: order.projectId, runId: order.productionRunId });
    }
    return { accepted: true };
  }
}

module.exports = {
  PetPackStudioService,
  SOURCE_IMAGE_TYPES,
  createUserProjectView,
  ensureExactlyTwoPhotos,
  resolveDeliveryDownloadTtlSeconds
};
