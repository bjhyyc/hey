const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  downloadVerifiedObject,
  hasTrustedMetadata,
  inspectRegularFile,
  sameResolvedPath
} = require("../media/private-media-workspace");
const {
  assertPositiveByteSize,
  assertPrivateObjectKey,
  normalizeSha256
} = require("../storage/private-object-store");
const { ACTION_FILE_NAMES } = require("./build");
const {
  PETPACK_CONTENT_TYPE,
  normalizePackageInputActions,
  normalizePetpackArtifact
} = require("./package-contract");

// Seven short 480p VP9 actions should remain far below these ceilings. Tight
// caps are intentional because JSZip materializes the archive in memory; one
// malformed order must not consume a multi-GB worker process.
const DEFAULT_MAX_ACTION_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_ACTION_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_PETPACK_BYTES = 320 * 1024 * 1024;

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function requireStorageDriver(driver) {
  if (!driver || typeof driver.getPrivate !== "function" || typeof driver.putPrivate !== "function") {
    throw new Error("PetPack workspace requires private object download and upload support");
  }
  return driver;
}

function assertAbsoluteTempRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("PetPack workspace temporary root must be an absolute path");
  }
  return value;
}

function assertZipSignature(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw codedError("PetPack builder did not return a ZIP archive", "petpack_zip_signature_invalid");
  }
}

async function uploadExactPrivateObject({ driver, localPath, objectKey, contentType, localArtifact }) {
  const destinationKey = assertPrivateObjectKey(objectKey);
  const body = fs.createReadStream(localPath);
  let stored;
  let putError;
  try {
    stored = await driver.putPrivate({
      objectKey: destinationKey,
      body,
      contentType,
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
  if (!trusted && typeof driver.headPrivate === "function") {
    trusted = await driver.headPrivate({ objectKey: destinationKey });
  }
  if (!hasTrustedMetadata(trusted)) {
    if (putError) throw putError;
    throw codedError("Private PetPack storage did not confirm integrity metadata", "petpack_storage_metadata_missing");
  }
  const storedDigest = normalizeSha256(trusted.sha256, "Stored PetPack checksum");
  const storedSize = assertPositiveByteSize(Number(trusted.byteSize), "Stored PetPack byte size");
  const storedType = trusted.contentType.trim();
  if (storedDigest !== localArtifact.sha256 || storedSize !== localArtifact.byteSize || storedType !== contentType) {
    throw codedError("Private PetPack storage metadata does not match the archive", "petpack_storage_integrity_mismatch");
  }
  return { objectKey: destinationKey, sha256: storedDigest, byteSize: storedSize, contentType: storedType };
}

class PrivatePetpackWorkspace {
  constructor({
    driver,
    tempRoot = os.tmpdir(),
    maxActionBytes = DEFAULT_MAX_ACTION_BYTES,
    maxTotalActionBytes = DEFAULT_MAX_TOTAL_ACTION_BYTES,
    maxPetpackBytes = DEFAULT_MAX_PETPACK_BYTES,
    logger = console
  } = {}) {
    this.driver = requireStorageDriver(driver);
    this.tempRoot = assertAbsoluteTempRoot(tempRoot);
    this.maxActionBytes = assertPositiveByteSize(Number(maxActionBytes), "Maximum package action byte size");
    this.maxTotalActionBytes = assertPositiveByteSize(Number(maxTotalActionBytes), "Maximum total package input byte size");
    this.maxPetpackBytes = assertPositiveByteSize(Number(maxPetpackBytes), "Maximum PetPack byte size");
    if (this.maxTotalActionBytes < this.maxActionBytes) {
      throw new Error("Total package input byte limit cannot be smaller than the per-action limit");
    }
    this.logger = logger;
  }

  async _createWorkspace(prefix) {
    const root = await fsp.realpath(this.tempRoot);
    const workspacePath = await fsp.mkdtemp(path.join(root, prefix));
    if (!sameResolvedPath(path.dirname(workspacePath), root) || !path.basename(workspacePath).startsWith(prefix)) {
      throw new Error("PetPack workspace escaped its configured temporary root");
    }
    return { root, workspacePath };
  }

  async _cleanup({ root, workspacePath }, operationError) {
    if (!sameResolvedPath(path.dirname(workspacePath), root) || !path.basename(workspacePath).startsWith("petpack-")) return;
    try {
      await fsp.rm(workspacePath, { recursive: true, force: true });
    } catch (cleanupError) {
      this.logger.warn?.("petpack.package.workspace_cleanup_failed", { code: "workspace_cleanup_failed" });
      if (!operationError) throw cleanupError;
    }
  }

  async withBuildWorkspace({ assets, outputObjectKey, beforeUpload } = {}, operation) {
    const normalizedAssets = normalizePackageInputActions(assets);
    const totalBytes = normalizedAssets.reduce((sum, asset) => sum + asset.byteSize, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > this.maxTotalActionBytes) {
      throw codedError("Seven action inputs exceed the configured package byte budget", "petpack_inputs_too_large");
    }
    if (normalizedAssets.some((asset) => asset.byteSize > this.maxActionBytes)) {
      throw codedError("A package action exceeds its configured byte limit", "petpack_action_too_large");
    }
    if (typeof outputObjectKey !== "function") throw new Error("PetPack output object-key resolver is required");
    if (typeof operation !== "function") throw new Error("PetPack build operation is required");
    if (beforeUpload !== undefined && typeof beforeUpload !== "function") {
      throw new Error("PetPack workspace before-upload guard must be a function");
    }

    const workspace = await this._createWorkspace("petpack-build-");
    const outputPath = path.join(workspace.workspacePath, "candidate.petpack");
    let operationError;
    try {
      const localAssets = [];
      for (const asset of normalizedAssets) {
        const localPath = path.join(workspace.workspacePath, ACTION_FILE_NAMES[asset.actionId]);
        await downloadVerifiedObject({
          driver: this.driver,
          objectKey: asset.objectKey,
          expectedSha256: asset.sha256,
          expectedByteSize: asset.byteSize,
          maxByteSize: this.maxActionBytes,
          localPath
        });
        const buffer = await fsp.readFile(localPath);
        localAssets.push({ ...asset, localPath, buffer });
      }

      const built = await operation({
        assets: localAssets,
        outputPath,
        scratchDirectory: workspace.workspacePath
      });
      const bytes = built && built.bytes;
      assertZipSignature(bytes);
      if (bytes.length > this.maxPetpackBytes) {
        throw codedError("Built PetPack exceeds its configured byte limit", "petpack_output_too_large");
      }
      await fsp.writeFile(outputPath, bytes, { flag: "wx" });
      const localArtifact = await inspectRegularFile(outputPath, { maxByteSize: this.maxPetpackBytes });
      if (normalizeSha256(built.checksumSha256, "Builder PetPack checksum") !== localArtifact.sha256) {
        throw codedError("Builder checksum does not match its PetPack bytes", "petpack_builder_integrity_mismatch");
      }
      if (beforeUpload) await beforeUpload({ ...localArtifact });
      const destinationKey = outputObjectKey({ ...localArtifact });
      const artifact = await uploadExactPrivateObject({
        driver: this.driver,
        localPath: outputPath,
        objectKey: destinationKey,
        contentType: PETPACK_CONTENT_TYPE,
        localArtifact
      });
      const { bytes: _discardedBytes, ...operationResult } = built;
      this.logger.info?.("petpack.package.workspace_uploaded", { byteSize: artifact.byteSize });
      return { artifact, operationResult };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      await this._cleanup(workspace, operationError);
    }
  }

  async withValidationWorkspace({ artifact } = {}, operation) {
    const expected = normalizePetpackArtifact(artifact);
    if (expected.byteSize > this.maxPetpackBytes) {
      throw codedError("PetPack validation input exceeds its configured byte limit", "petpack_validation_input_too_large");
    }
    if (typeof operation !== "function") throw new Error("PetPack validation operation is required");
    const workspace = await this._createWorkspace("petpack-validate-");
    const packagePath = path.join(workspace.workspacePath, "candidate.petpack");
    let operationError;
    try {
      await downloadVerifiedObject({
        driver: this.driver,
        objectKey: expected.objectKey,
        expectedSha256: expected.sha256,
        expectedByteSize: expected.byteSize,
        maxByteSize: this.maxPetpackBytes,
        localPath: packagePath
      });
      const bytes = await fsp.readFile(packagePath);
      assertZipSignature(bytes);
      return await operation({ packagePath, bytes, scratchDirectory: workspace.workspacePath });
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      await this._cleanup(workspace, operationError);
    }
  }
}

module.exports = {
  DEFAULT_MAX_ACTION_BYTES,
  DEFAULT_MAX_PETPACK_BYTES,
  DEFAULT_MAX_TOTAL_ACTION_BYTES,
  PrivatePetpackWorkspace,
  assertZipSignature,
  uploadExactPrivateObject
};
