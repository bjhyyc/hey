const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_MAX_MASTER_BYTES,
  downloadVerifiedObject,
  hasTrustedMetadata,
  sameResolvedPath
} = require("./private-media-workspace");
const {
  assertPositiveByteSize,
  assertPrivateObjectKey,
  normalizeSha256
} = require("../storage/private-object-store");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_MAX_PROVIDER_IMAGE_BYTES = 48 * 1024 * 1024;

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function requireStorageDriver(driver) {
  if (!driver || typeof driver.getPrivate !== "function" || typeof driver.putPrivate !== "function") {
    throw new Error("Master image workspace requires private object download and upload support");
  }
  return driver;
}

async function inspectPngFile(filePath, { maxByteSize = DEFAULT_MAX_MASTER_BYTES } = {}) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw codedError("Normalized master must be a regular local PNG", "master_output_not_regular");
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 24 || stat.size > maxByteSize) {
    throw codedError("Normalized master PNG has an invalid byte size", "master_output_size_invalid");
  }
  const handle = await fsp.open(filePath, "r");
  let header;
  try {
    header = Buffer.alloc(24);
    const result = await handle.read(header, 0, header.length, 0);
    if (result.bytesRead !== header.length) throw codedError("Normalized master PNG header is incomplete", "master_png_invalid");
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, 8).equals(PNG_SIGNATURE) || header.toString("ascii", 12, 16) !== "IHDR") {
    throw codedError("Normalized master output is not a PNG", "master_png_invalid");
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    byteSize += chunk.length;
    hash.update(chunk);
  }
  if (byteSize !== stat.size) throw codedError("Normalized master changed during inspection", "master_output_changed");
  return { width, height, byteSize, sha256: hash.digest("hex") };
}

class PrivateMasterImageWorkspace {
  constructor({
    driver,
    tempRoot = os.tmpdir(),
    maxProviderImageBytes = DEFAULT_MAX_PROVIDER_IMAGE_BYTES,
    maxMasterBytes = DEFAULT_MAX_MASTER_BYTES,
    logger = console
  } = {}) {
    this.driver = requireStorageDriver(driver);
    if (typeof tempRoot !== "string" || !path.isAbsolute(tempRoot)) {
      throw new Error("Master image workspace temporary root must be absolute");
    }
    this.tempRoot = tempRoot;
    this.maxProviderImageBytes = assertPositiveByteSize(Number(maxProviderImageBytes), "Maximum provider image byte size");
    this.maxMasterBytes = assertPositiveByteSize(Number(maxMasterBytes), "Maximum normalized master byte size");
    this.logger = logger;
  }

  async withMasterWorkspace({
    input,
    references,
    outputObjectKey,
    beforeUpload
  } = {}, operation) {
    if (!input || typeof input !== "object") throw new Error("Archived Seedream input is required");
    if (!Array.isArray(references) || ![1, 2].includes(references.length)) {
      throw new Error("Master image workspace requires one or two immutable references");
    }
    if (typeof operation !== "function") throw new Error("Master image workspace operation is required");
    if (beforeUpload !== undefined && typeof beforeUpload !== "function") {
      throw new Error("Master image before-upload guard must be a function");
    }

    const inputKey = assertPrivateObjectKey(input.objectKey);
    const root = await fsp.realpath(this.tempRoot);
    const workspacePath = await fsp.mkdtemp(path.join(root, "petpack-master-"));
    if (!sameResolvedPath(path.dirname(workspacePath), root) || !path.basename(workspacePath).startsWith("petpack-master-")) {
      throw new Error("Master image workspace escaped its configured temporary root");
    }
    const inputPath = path.join(workspacePath, "provider-image.bin");
    const outputPath = path.join(workspacePath, "normalized-master.png");
    const referencePaths = references.map((_reference, index) => path.join(workspacePath, `reference-${index + 1}.bin`));
    let operationError;
    try {
      await downloadVerifiedObject({
        driver: this.driver,
        objectKey: inputKey,
        expectedSha256: input.sha256,
        expectedByteSize: input.byteSize,
        maxByteSize: this.maxProviderImageBytes,
        localPath: inputPath
      });
      for (let index = 0; index < references.length; index += 1) {
        const reference = references[index];
        await downloadVerifiedObject({
          driver: this.driver,
          objectKey: reference.objectKey,
          expectedSha256: reference.sha256,
          expectedByteSize: reference.byteSize,
          maxByteSize: this.maxMasterBytes,
          localPath: referencePaths[index]
        });
      }

      const operationResult = await operation({
        inputPath,
        outputPath,
        referencePaths,
        scratchDirectory: workspacePath
      });
      const localArtifact = await inspectPngFile(outputPath, { maxByteSize: this.maxMasterBytes });
      const resolvedOutputKey = typeof outputObjectKey === "function"
        ? outputObjectKey({ ...localArtifact })
        : outputObjectKey;
      const destinationKey = assertPrivateObjectKey(resolvedOutputKey);
      if (destinationKey === inputKey || references.some((reference) => reference.objectKey === destinationKey)) {
        throw new Error("Normalized master must not overwrite an input image");
      }
      if (beforeUpload) await beforeUpload({ ...localArtifact });

      const body = fs.createReadStream(outputPath);
      let stored;
      let putError;
      try {
        stored = await this.driver.putPrivate({
          objectKey: destinationKey,
          body,
          contentType: "image/png",
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
        throw codedError("Private master storage did not confirm integrity metadata", "master_storage_metadata_missing");
      }
      const storedSha256 = normalizeSha256(trusted.sha256, "Stored master checksum");
      const storedByteSize = assertPositiveByteSize(Number(trusted.byteSize), "Stored master byte size");
      if (storedSha256 !== localArtifact.sha256 || storedByteSize !== localArtifact.byteSize || trusted.contentType !== "image/png") {
        throw codedError("Stored master metadata does not match the normalized PNG", "master_storage_integrity_mismatch");
      }
      this.logger.info?.("petpack.media.master_workspace_uploaded", { byteSize: storedByteSize });
      return {
        operationResult,
        localArtifact,
        artifact: {
          objectKey: destinationKey,
          sha256: storedSha256,
          byteSize: storedByteSize,
          contentType: "image/png"
        }
      };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (sameResolvedPath(path.dirname(workspacePath), root) && path.basename(workspacePath).startsWith("petpack-master-")) {
        try {
          await fsp.rm(workspacePath, { recursive: true, force: true });
        } catch (cleanupError) {
          this.logger.warn?.("petpack.media.master_workspace_cleanup_failed", { code: "master_workspace_cleanup_failed" });
          if (!operationError) throw cleanupError;
        }
      }
    }
  }
}

module.exports = {
  DEFAULT_MAX_PROVIDER_IMAGE_BYTES,
  PNG_SIGNATURE,
  PrivateMasterImageWorkspace,
  inspectPngFile
};
