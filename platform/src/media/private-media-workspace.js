const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const {
  assertPositiveByteSize,
  assertPrivateObjectKey,
  normalizeSha256
} = require("../storage/private-object-store");

const DEFAULT_MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_MASTER_BYTES = 32 * 1024 * 1024;

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function requireStorageDriver(driver) {
  if (!driver || typeof driver.getPrivate !== "function" || typeof driver.putPrivate !== "function") {
    throw new Error("Media workspace requires private object download and upload support");
  }
  return driver;
}

function readableBody(result) {
  const body = result && typeof result === "object" && "body" in result ? result.body : result;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Readable.from([body]);
  if (body && typeof body.pipe === "function") return body;
  if (body && typeof body.getReader === "function") return Readable.fromWeb(body);
  if (body && typeof body[Symbol.asyncIterator] === "function") return Readable.from(body);
  throw codedError("Private media download returned no readable body", "private_media_body_invalid");
}

async function inspectRegularFile(filePath, { maxByteSize = DEFAULT_MAX_VIDEO_BYTES } = {}) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw codedError("Media worker output must be a regular local file", "worker_output_not_regular");
  }
  if (stat.size <= 0 || !Number.isSafeInteger(stat.size)) {
    throw codedError("Media worker output must be non-empty", "worker_output_empty");
  }
  if (stat.size > maxByteSize) {
    throw codedError("Media worker output exceeds its configured byte limit", "worker_output_too_large");
  }
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    byteSize += chunk.length;
    hash.update(chunk);
  }
  if (byteSize !== stat.size) {
    throw codedError("Media worker output changed during inspection", "worker_output_changed");
  }
  return { sha256: hash.digest("hex"), byteSize };
}

function hasTrustedMetadata(value) {
  return Boolean(
    value && typeof value === "object" && value.sha256 !== undefined && value.byteSize !== undefined &&
    typeof value.contentType === "string" && value.contentType.trim()
  );
}

function sameResolvedPath(left, right) {
  const normalize = process.platform === "win32"
    ? (value) => path.resolve(value).toLowerCase()
    : (value) => path.resolve(value);
  return normalize(left) === normalize(right);
}

async function downloadVerifiedObject({ driver, objectKey, expectedSha256, expectedByteSize, maxByteSize, localPath }) {
  const key = assertPrivateObjectKey(objectKey);
  const expectedDigest = normalizeSha256(expectedSha256, "Expected private media checksum");
  const expectedSize = assertPositiveByteSize(Number(expectedByteSize), "Expected private media byte size");
  if (!Number.isSafeInteger(maxByteSize) || maxByteSize < 1 || expectedSize > maxByteSize) {
    throw codedError("Private media exceeds its configured byte limit", "private_media_too_large");
  }
  const downloaded = await driver.getPrivate({ objectKey: key });
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += bytes.length;
      if (byteSize > expectedSize) {
        callback(codedError("Private media exceeds its recorded byte size", "private_media_size_mismatch"));
        return;
      }
      hash.update(bytes);
      callback(null, bytes);
    }
  });
  await pipeline(readableBody(downloaded), meter, fs.createWriteStream(localPath, { flags: "wx" }));
  const actualDigest = hash.digest("hex");
  if (byteSize !== expectedSize || actualDigest !== expectedDigest) {
    throw codedError("Private media does not match its integrity record", "private_media_integrity_mismatch");
  }
  return { objectKey: key, sha256: actualDigest, byteSize };
}

/**
 * Materializes one private source object into an isolated worker directory,
 * verifies its database-bound integrity, and uploads only a newly-created
 * regular output file. Object keys never become local file names.
 */
class PrivateMediaWorkspace {
  constructor({
    driver,
    tempRoot = os.tmpdir(),
    maxVideoBytes = DEFAULT_MAX_VIDEO_BYTES,
    maxMasterBytes = DEFAULT_MAX_MASTER_BYTES,
    logger = console
  } = {}) {
    this.driver = requireStorageDriver(driver);
    if (typeof tempRoot !== "string" || !path.isAbsolute(tempRoot)) {
      throw new Error("Media workspace temporary root must be an absolute path");
    }
    this.tempRoot = tempRoot;
    this.maxVideoBytes = assertPositiveByteSize(Number(maxVideoBytes), "Maximum video byte size");
    this.maxMasterBytes = assertPositiveByteSize(Number(maxMasterBytes), "Maximum master-frame byte size");
    this.logger = logger;
  }

  async withActionWorkspace({
    inputObjectKey,
    expectedSha256,
    expectedByteSize,
    firstMaster,
    lastMaster,
    outputObjectKey,
    outputContentType = "video/webm",
    beforeUpload
  } = {}, operation) {
    const sourceKey = assertPrivateObjectKey(inputObjectKey);
    if (!firstMaster || typeof firstMaster !== "object" || !lastMaster || typeof lastMaster !== "object") {
      throw new Error("Media workspace requires both immutable master-frame assets");
    }
    if (typeof outputContentType !== "string" || !outputContentType.trim() || outputContentType.length > 256) {
      throw new Error("Media workspace output content type is required");
    }
    if (typeof operation !== "function") throw new Error("Media workspace operation is required");
    if (beforeUpload !== undefined && typeof beforeUpload !== "function") {
      throw new Error("Media workspace before-upload guard must be a function");
    }

    const root = await fsp.realpath(this.tempRoot);
    const workspacePath = await fsp.mkdtemp(path.join(root, "petpack-action-"));
    if (!sameResolvedPath(path.dirname(workspacePath), root) || !path.basename(workspacePath).startsWith("petpack-action-")) {
      throw new Error("Media workspace escaped its configured temporary root");
    }
    const inputPath = path.join(workspacePath, "provider-source.bin");
    const firstMasterPath = path.join(workspacePath, "first-master.bin");
    const lastMasterPath = path.join(workspacePath, "last-master.bin");
    const mattePath = path.join(workspacePath, "segmentation-matte.webm");
    const outputPath = path.join(workspacePath, "normalized-action.webm");

    let operationError;
    try {
      await downloadVerifiedObject({
        driver: this.driver,
        objectKey: sourceKey,
        expectedSha256,
        expectedByteSize,
        maxByteSize: this.maxVideoBytes,
        localPath: inputPath
      });
      await downloadVerifiedObject({
        driver: this.driver,
        objectKey: firstMaster.objectKey,
        expectedSha256: firstMaster.sha256,
        expectedByteSize: firstMaster.byteSize,
        maxByteSize: this.maxMasterBytes,
        localPath: firstMasterPath
      });
      await downloadVerifiedObject({
        driver: this.driver,
        objectKey: lastMaster.objectKey,
        expectedSha256: lastMaster.sha256,
        expectedByteSize: lastMaster.byteSize,
        maxByteSize: this.maxMasterBytes,
        localPath: lastMasterPath
      });

      const operationResult = await operation({
        inputPath,
        firstMasterPath,
        lastMasterPath,
        mattePath,
        outputPath,
        scratchDirectory: workspacePath
      });
      const localArtifact = await inspectRegularFile(outputPath, { maxByteSize: this.maxVideoBytes });
      const resolvedOutputKey = typeof outputObjectKey === "function"
        ? outputObjectKey({ ...localArtifact })
        : outputObjectKey;
      const destinationKey = assertPrivateObjectKey(resolvedOutputKey);
      if (destinationKey === sourceKey) {
        throw new Error("Processed action media must not overwrite its provider source");
      }
      if (beforeUpload) await beforeUpload({ ...localArtifact });
      const body = fs.createReadStream(outputPath);
      let stored;
      let putError;
      try {
        stored = await this.driver.putPrivate({
          objectKey: destinationKey,
          body,
          contentType: outputContentType.trim(),
          sha256: localArtifact.sha256,
          byteSize: localArtifact.byteSize,
          ifNoneMatch: "*"
        });
      } catch (error) {
        putError = error;
      } finally {
        body.destroy();
      }
      let trusted = hasTrustedMetadata(stored) ? stored : null;
      if (!trusted && typeof this.driver.headPrivate === "function") {
        trusted = await this.driver.headPrivate({ objectKey: destinationKey });
      }
      if (!hasTrustedMetadata(trusted)) {
        if (putError) throw putError;
        throw codedError("Private output storage did not confirm integrity metadata", "output_storage_metadata_missing");
      }
      const storedDigest = normalizeSha256(trusted.sha256, "Stored action media checksum");
      const storedSize = assertPositiveByteSize(Number(trusted.byteSize), "Stored action media byte size");
      const storedType = trusted.contentType.trim();
      if (storedDigest !== localArtifact.sha256 || storedSize !== localArtifact.byteSize || storedType !== outputContentType.trim()) {
        throw codedError("Private output storage metadata does not match the processed file", "output_storage_integrity_mismatch");
      }
      this.logger.info?.("petpack.media.workspace_uploaded", { byteSize: storedSize });
      return {
        operationResult,
        artifact: {
          objectKey: destinationKey,
          sha256: storedDigest,
          byteSize: storedSize,
          contentType: storedType
        }
      };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (sameResolvedPath(path.dirname(workspacePath), root) && path.basename(workspacePath).startsWith("petpack-action-")) {
        try {
          await fsp.rm(workspacePath, { recursive: true, force: true });
        } catch (cleanupError) {
          this.logger.warn?.("petpack.media.workspace_cleanup_failed", { code: "workspace_cleanup_failed" });
          if (!operationError) throw cleanupError;
        }
      }
    }
  }
}

module.exports = {
  DEFAULT_MAX_MASTER_BYTES,
  DEFAULT_MAX_VIDEO_BYTES,
  PrivateMediaWorkspace,
  downloadVerifiedObject,
  hasTrustedMetadata,
  inspectRegularFile,
  readableBody,
  sameResolvedPath
};
