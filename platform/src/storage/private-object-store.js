const { isSafeRelativePath } = require("../../../src/shared/path-safety");
const { MAX_HEADER_BYTES } = require("../media/image-header-dimensions");

const OBJECT_CLASSES = Object.freeze({
  SOURCE_PHOTO: "source-photo",
  AWAKE_MASTER: "awake-master",
  SLEEP_MASTER: "sleep-master",
  PROVIDER_INPUT: "provider-input",
  PROVIDER_OUTPUT: "provider-output",
  PROCESSING_INTERMEDIATE: "processing-intermediate",
  ACTION_VIDEO: "action-video",
  VALIDATION_PACK: "validation-pack",
  FINAL_PETPACK: "final-petpack"
});

const DEFAULT_DOWNLOAD_TTL_SECONDS = 10 * 60;
const MAX_DOWNLOAD_TTL_SECONDS = 60 * 60;

function safeSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe object-key segment`);
  }
  return value;
}

function safeFileName(value) {
  if (typeof value !== "string" || !isSafeRelativePath(value) || value.includes("/")) {
    throw new Error("Object file name must be a safe single path segment");
  }
  return value;
}

function assertObjectClass(value) {
  if (!Object.values(OBJECT_CLASSES).includes(value)) {
    throw new Error("Unsupported private object class");
  }
  return value;
}

function createProjectObjectKey({ projectId, runId, objectClass, fileName, actionId } = {}) {
  const segments = [
    "private",
    "projects",
    safeSegment(projectId, "projectId")
  ];
  if (runId) segments.push("runs", safeSegment(runId, "runId"));
  segments.push(assertObjectClass(objectClass));
  if (actionId) segments.push(safeSegment(actionId, "actionId"));
  segments.push(safeFileName(fileName));
  return segments.join("/");
}

function assertPrivateObjectKey(objectKey) {
  if (typeof objectKey !== "string" || !objectKey.startsWith("private/") || !isSafeRelativePath(objectKey)) {
    throw new Error("Only safe private object keys are permitted");
  }
  return objectKey;
}

function normalizeSha256(value, label = "Object checksum") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

function assertPositiveByteSize(value, label = "Object byte size") {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function resolveDownloadTtlSeconds(requestedTtlSeconds, policy = {}) {
  const defaultTtl = Number(policy.defaultDownloadTtlSeconds || DEFAULT_DOWNLOAD_TTL_SECONDS);
  const maximumTtl = Number(policy.maxDownloadTtlSeconds || MAX_DOWNLOAD_TTL_SECONDS);
  const ttl = Number(requestedTtlSeconds || defaultTtl);
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > maximumTtl) {
    throw new Error(`Signed download TTL must be between 1 and ${maximumTtl} seconds`);
  }
  return ttl;
}

function requireStorageDriver(driver) {
  if (!driver || typeof driver.createSignedUpload !== "function" || typeof driver.createSignedDownload !== "function" || typeof driver.putPrivate !== "function") {
    throw new Error("A private object-storage driver with signed URL support is required");
  }
  return driver;
}

/**
 * Server-only storage façade. It produces temporary access grants and accepts
 * provider URLs only to archive them into private storage; no permanent media
 * URL reaches a browser or database-facing response.
 */
class PrivateObjectStore {
  constructor({ driver, policy = {}, fetchImpl = globalThis.fetch, logger = console } = {}) {
    this.driver = requireStorageDriver(driver);
    if (typeof fetchImpl !== "function") throw new Error("A server-side fetch implementation is required");
    this.policy = policy;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  async createUploadGrant({ objectKey, contentType, expectedSha256, expectedByteSize, expiresInSeconds } = {}) {
    const key = assertPrivateObjectKey(objectKey);
    const hasIntegrityExpectation = expectedSha256 !== undefined || expectedByteSize !== undefined;
    const integrity = hasIntegrityExpectation ? {
      expectedSha256: normalizeSha256(expectedSha256, "Expected upload checksum"),
      expectedByteSize: assertPositiveByteSize(expectedByteSize, "Expected upload byte size")
    } : {};
    const result = await this.driver.createSignedUpload({
      objectKey: key,
      contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
      ...integrity,
      expiresInSeconds: resolveDownloadTtlSeconds(expiresInSeconds, this.policy)
    });
    if (!result || typeof result.url !== "string" || !result.url) {
      throw new Error("Private object-storage driver returned an invalid upload grant");
    }
    return { objectKey: key, url: result.url, expiresInSeconds: resolveDownloadTtlSeconds(expiresInSeconds, this.policy) };
  }

  /**
   * A browser-provided checksum is only a claim. Before an upload can become a
   * source photo, the server re-reads trusted object metadata through its
   * storage credential and compares the expected type, size, and digest.
   * Drivers are expected to expose a HEAD-equivalent `headPrivate` operation.
   */
  async verifyUploadedObject({ objectKey, expectedContentType, expectedSha256, expectedByteSize } = {}) {
    const key = assertPrivateObjectKey(objectKey);
    if (typeof this.driver.headPrivate !== "function") {
      throw new Error("Private object-storage driver must support trusted uploaded-object inspection");
    }
    if (typeof expectedContentType !== "string" || !expectedContentType) {
      throw new Error("Expected uploaded object content type is required");
    }
    const expectedDigest = normalizeSha256(expectedSha256, "Expected uploaded object checksum");
    const expectedSize = assertPositiveByteSize(expectedByteSize, "Expected uploaded object byte size");
    const head = await this.driver.headPrivate({ objectKey: key });
    if (!head || typeof head !== "object") {
      throw new Error("Uploaded object was not found in private storage");
    }
    if (head.contentType !== expectedContentType) {
      throw new Error("Uploaded object content type does not match its upload reservation");
    }
    if (Number(head.byteSize) !== expectedSize) {
      throw new Error("Uploaded object byte size does not match its upload reservation");
    }
    if (normalizeSha256(head.sha256, "Trusted uploaded object checksum") !== expectedDigest) {
      throw new Error("Uploaded object checksum does not match its upload reservation");
    }
    return {
      objectKey: key,
      contentType: head.contentType,
      byteSize: expectedSize,
      sha256: expectedDigest
    };
  }

  /**
   * Reads the leading bytes of a private object. Enough to parse an image
   * header without pulling a whole photograph into the API runtime.
   */
  async readObjectHead({ objectKey, maxBytes = MAX_HEADER_BYTES } = {}) {
    const key = assertPrivateObjectKey(objectKey);
    if (typeof this.driver.getPrivate !== "function") {
      throw new Error("Private object-storage driver must support trusted object reads");
    }
    const limit = Number(maxBytes);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_HEADER_BYTES) {
      throw new Error("Object head read size is invalid");
    }
    const object = await this.driver.getPrivate({ objectKey: key });
    const payload = object && (object.body ?? object.bytes ?? object.Body ?? object);
    if (Buffer.isBuffer(payload)) return payload.subarray(0, limit);
    if (!payload || typeof payload[Symbol.asyncIterator] !== "function") {
      throw new Error("Private object read did not return readable bytes");
    }
    const chunks = [];
    let collected = 0;
    for await (const chunk of payload) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(piece);
      collected += piece.length;
      if (collected >= limit) break;
    }
    if (typeof payload.destroy === "function") payload.destroy();
    return Buffer.concat(chunks).subarray(0, limit);
  }

  async createDownloadGrant({ objectKey, expiresInSeconds, disposition = "attachment" } = {}) {
    const key = assertPrivateObjectKey(objectKey);
    const ttl = resolveDownloadTtlSeconds(expiresInSeconds, this.policy);
    const result = await this.driver.createSignedDownload({ objectKey: key, expiresInSeconds: ttl, disposition });
    if (!result || typeof result.url !== "string" || !result.url) {
      throw new Error("Private object-storage driver returned an invalid download grant");
    }
    return { objectKey: key, url: result.url, expiresInSeconds: ttl };
  }

  async archiveProviderOutput({ sourceUrl, objectKey, contentType } = {}) {
    const key = assertPrivateObjectKey(objectKey);
    let parsed;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new Error("Provider output URL must be absolute");
    }
    if (!["https:", "http:"].includes(parsed.protocol)) {
      throw new Error("Provider output URL must use HTTP(S)");
    }
    const response = await this.fetch(parsed.toString());
    if (!response.ok || !response.body) {
      throw new Error(`Provider output download failed with HTTP ${response.status}`);
    }
    const stored = await this.driver.putPrivate({
      objectKey: key,
      body: response.body,
      contentType: contentType || response.headers?.get?.("content-type") || "application/octet-stream"
    });
    let metadata = stored && typeof stored === "object" ? stored : null;
    if ((!metadata || metadata.sha256 === undefined || metadata.byteSize === undefined) && typeof this.driver.headPrivate === "function") {
      metadata = await this.driver.headPrivate({ objectKey: key });
    }
    this.logger.info?.("petpack.storage.provider_output_archived", { objectKey: key });
    if (metadata && metadata.sha256 !== undefined && metadata.byteSize !== undefined && typeof metadata.contentType === "string") {
      return {
        objectKey: key,
        sha256: normalizeSha256(metadata.sha256, "Archived provider output checksum"),
        byteSize: assertPositiveByteSize(Number(metadata.byteSize), "Archived provider output byte size"),
        contentType: metadata.contentType
      };
    }
    return { objectKey: key };
  }
}

module.exports = {
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  MAX_DOWNLOAD_TTL_SECONDS,
  OBJECT_CLASSES,
  PrivateObjectStore,
  assertPrivateObjectKey,
  assertPositiveByteSize,
  createProjectObjectKey,
  normalizeSha256,
  resolveDownloadTtlSeconds
};
