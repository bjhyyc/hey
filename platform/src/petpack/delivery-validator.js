const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const JSZip = require("jszip");

const { validateManifest } = require("../../../src/shared/manifest-validator");
const studioProfile = require("../../../src/shared/studio-behavior-profile.json");
const { REQUIRED_ACTION_IDS, toStudioActionKey } = require("../domain/action-catalog");
const { validateActionMediaProbe } = require("../qa/media-inspector");
const { ACTION_FILE_NAMES, verifyPetpackArchive } = require("./build");
const {
  PETPACK_VALIDATION_POLICY_VERSION,
  normalizePackageInputActions,
  requiredString
} = require("./package-contract");

const PETPACK_VALIDATOR_VERSION = "petpack-studio-validator/v1";
const REQUIRED_INTERACTION_CHECKS = Object.freeze([
  "startupStretchThenIdle",
  "singleClickSneeze",
  "doubleClickRollWithoutSneeze",
  "rightClickStretchAndWake",
  "idleTwentyTwoSecondsThenSleepLoop",
  "hoverTwoSecondsOnceWithCooldown",
  "noMovementOrProps"
]);
const ATTESTED_UPSTREAM_VERIFIERS = new WeakSet();
const ATTESTED_ELECTRON_VERIFIERS = new WeakSet();
const PRODUCTION_ASSURED_VALIDATORS = new WeakSet();

function checksumBuffer(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function checksumFile(filePath) {
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    byteSize += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), byteSize };
}

function checksumPinnedUpstreamTree(root) {
  const files = [];
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Pinned upstream tree contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) {
        if (relativeDirectory === "" && [".git", "node_modules"].includes(entry.name)) continue;
        visit(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  for (const fileName of ["package.json", "package-lock.json"]) {
    const filePath = path.join(root, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Pinned upstream tree is missing ${fileName}`);
    }
    files.push(fileName);
  }
  const sourceRoot = path.join(root, "src");
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error("Pinned upstream tree is missing src");
  }
  visit(sourceRoot, "src");
  const hash = crypto.createHash("sha256");
  for (const relative of [...new Set(files)].sort()) {
    hash.update(relative);
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(path.join(root, ...relative.split("/"))));
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

function findManifestClip(manifest, actionId) {
  const key = toStudioActionKey(actionId);
  const clipId = manifest.studioBehavior.actionClipIds[key];
  const clips = [
    { ...manifest.animations.default, type: "default" },
    ...manifest.animations.clips
  ];
  return clips.find((clip) => clip.id === clipId) || null;
}

function requireVerifier(verifier, label) {
  if (!verifier || typeof verifier.verify !== "function") throw new Error(`${label} must implement verify`);
  verifier.mode = requiredString(verifier.mode, `${label} mode`, 64);
  verifier.identity = requiredString(verifier.identity, `${label} identity`, 256);
  verifier.version = requiredString(verifier.version, `${label} version`, 128);
  return verifier;
}

function normalizeImportResult(value, expectedPackageId, expectedPackageSha256, verifier) {
  if (!value || value.ok !== true || value.packageId !== expectedPackageId ||
      value.packageSha256 !== expectedPackageSha256) {
    throw new Error("The clean Desktop Pet importer rejected the built PetPack");
  }
  return {
    ok: true,
    packageId: expectedPackageId,
    packageSha256: expectedPackageSha256,
    verifierIdentity: verifier.identity,
    verifierVersion: verifier.version
  };
}

function normalizeInteractionResult(value, expectedPackageId, expectedPackageSha256, verifier) {
  if (!value || value.ok !== true || !value.checks || typeof value.checks !== "object") {
    throw new Error("The Desktop Pet interaction verifier rejected the built PetPack");
  }
  if (value.packageId !== expectedPackageId || value.packageSha256 !== expectedPackageSha256) {
    throw new Error("The Desktop Pet interaction evidence is not bound to this PetPack");
  }
  const checks = {};
  for (const check of REQUIRED_INTERACTION_CHECKS) {
    if (value.checks[check] !== true) throw new Error(`Desktop Pet interaction check failed: ${check}`);
    checks[check] = true;
  }
  return {
    ok: true,
    packageId: expectedPackageId,
    packageSha256: expectedPackageSha256,
    checks,
    verifierIdentity: verifier.identity,
    verifierVersion: verifier.version
  };
}

class PetpackValidationError extends Error {
  constructor(message, qa) {
    super(message);
    this.name = "PetpackValidationError";
    this.code = "petpack_validation_failed";
    this.qa = qa;
  }
}

/**
 * Runs the untouched upstream import implementation against an isolated
 * user-data directory. Pinning the importer file digest prevents a deployment
 * from silently replacing the validation target with the customized client.
 */
function createUpstreamImportVerifier({
  upstreamRoot,
  expectedSourceTreeSha256,
  identity = "duzexu/desktop-pet@f4b735b",
  nodePath = process.execPath,
  spawnImpl = spawn,
  timeoutMs = 120 * 1000
} = {}) {
  const root = path.resolve(requiredString(upstreamRoot, "Clean upstream Desktop Pet root", 2048));
  const importerPath = path.join(root, "src", "main", "services", "petpack.js");
  const expectedDigest = requiredString(expectedSourceTreeSha256, "Pinned upstream source-tree checksum", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("Pinned upstream source-tree checksum must be SHA-256");
  const actualDigest = checksumPinnedUpstreamTree(root);
  if (actualDigest !== expectedDigest) throw new Error("Clean upstream source tree does not match its pinned checksum");
  if (typeof spawnImpl !== "function") throw new Error("Upstream import verifier requires a process launcher");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 10 * 60 * 1000) {
    throw new Error("Upstream import verifier timeout must be between 1 second and 10 minutes");
  }
  const scriptPath = path.resolve(__dirname, "../../../scripts/verify-upstream-petpack-import.js");
  const verifier = {
    mode: "isolated-upstream-import",
    identity,
    version: actualDigest,
    async verify({ packagePath, expectedPackageId, packageSha256 }) {
      const target = path.resolve(requiredString(packagePath, "PetPack validation path", 2048));
      const expectedPackageDigest = requiredString(packageSha256, "PetPack validation checksum", 64).toLowerCase();
      const currentTreeDigest = checksumPinnedUpstreamTree(root);
      if (currentTreeDigest !== expectedDigest) {
        throw new Error("Clean upstream source tree changed after validator startup");
      }
      const localArtifact = await checksumFile(target);
      if (localArtifact.sha256 !== expectedPackageDigest) {
        throw new Error("Clean upstream importer path changed before isolated validation");
      }
      const result = await new Promise((resolve, reject) => {
        const child = spawnImpl(nodePath, [scriptPath, root, target], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback(value);
        };
        const timer = setTimeout(() => {
          child.kill?.("SIGKILL");
          finish(reject, new Error("Clean upstream import verifier exceeded its timeout"));
        }, timeoutMs);
        timer.unref?.();
        child.stdout?.on("data", (chunk) => {
          const text = String(chunk);
          if (stdout.length + text.length > 1024 * 1024) {
            child.kill?.("SIGKILL");
            finish(reject, new Error("Clean upstream import verifier output exceeded its limit"));
            return;
          }
          stdout += text;
        });
        child.stderr?.on("data", (chunk) => {
          if (stderr.length < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - stderr.length);
        });
        child.once("error", (error) => finish(reject, new Error(`Clean upstream import verifier could not start: ${error.message}`)));
        child.once("close", (code) => {
          let parsed;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            finish(reject, new Error(
              code === 0
                ? "Clean upstream import verifier returned invalid JSON"
                : `Clean upstream import verifier crashed: ${stderr.slice(0, 512) || `exit ${code}`}`
            ));
            return;
          }
          if (code !== 0 && (!parsed?.result || parsed.result.ok !== false)) {
            finish(reject, new Error(`Clean upstream import verifier crashed: ${stderr.slice(0, 512) || `exit ${code}`}`));
            return;
          }
          finish(resolve, parsed);
        });
      });
      return {
        ok: Boolean(result?.result?.ok && result.manifestInstalled),
        packageId: result?.result?.packageId || null,
        packageSha256: expectedPackageDigest,
        expectedPackageId
      };
    }
  };
  ATTESTED_UPSTREAM_VERIFIERS.add(verifier);
  return verifier;
}

/**
 * Static manifest conformance is useful in development, but is deliberately
 * marked contract-only and therefore cannot satisfy production validation.
 */
function createContractInteractionVerifier() {
  return {
    mode: "contract-only",
    identity: "petpack-studio-static-interaction-contract",
    version: PETPACK_VALIDATOR_VERSION,
    async verify({ manifest, expectedPackageId, packageSha256 }) {
      const files = new Set(["manifest.json", ...Object.values(ACTION_FILE_NAMES).map((name) => `assets/${name}`)]);
      const validation = validateManifest(manifest, files);
      return {
        ok: validation.ok,
        packageId: expectedPackageId,
        packageSha256,
        checks: Object.fromEntries(REQUIRED_INTERACTION_CHECKS.map((check) => [check, validation.ok]))
      };
    }
  };
}

class PetpackDeliveryValidator {
  constructor({
    probeAsset,
    originalImportVerifier,
    interactionVerifier,
    productionMode = process.env.PETPACK_PLATFORM_MODE === "production",
    policyVersion = PETPACK_VALIDATION_POLICY_VERSION,
    logger = console
  } = {}) {
    if (typeof probeAsset !== "function") throw new Error("PetPack delivery validation requires a trusted file probe");
    this.probeAsset = probeAsset;
    this.originalImportVerifier = requireVerifier(originalImportVerifier, "Original Desktop Pet importer verifier");
    this.interactionVerifier = requireVerifier(interactionVerifier, "Desktop Pet interaction verifier");
    this.productionMode = Boolean(productionMode);
    if (this.productionMode && (
      this.originalImportVerifier.mode !== "isolated-upstream-import" ||
      !ATTESTED_UPSTREAM_VERIFIERS.has(this.originalImportVerifier)
    )) {
      throw new Error("Production PetPack validation requires a pinned clean upstream importer");
    }
    if (this.productionMode && (
      this.interactionVerifier.mode !== "electron-runtime" ||
      !ATTESTED_ELECTRON_VERIFIERS.has(this.interactionVerifier)
    )) {
      throw new Error("Production PetPack validation requires an attested real Electron interaction runner");
    }
    this.policyVersion = requiredString(policyVersion, "PetPack validation policy version", 128);
    const versionDigest = crypto.createHash("sha256").update(
      `${PETPACK_VALIDATOR_VERSION}|${this.originalImportVerifier.version}|${this.interactionVerifier.version}`
    ).digest("hex").slice(0, 48);
    this.validatorVersion = `${PETPACK_VALIDATOR_VERSION}:${versionDigest}`;
    this.validatorIdentity = `${this.originalImportVerifier.identity}|${this.interactionVerifier.identity}`;
    this.logger = logger;
    if (this.productionMode) PRODUCTION_ASSURED_VALIDATORS.add(this);
  }

  describe() {
    return {
      policyVersion: this.policyVersion,
      validatorVersion: this.validatorVersion,
      validatorIdentity: this.validatorIdentity,
      productionAssured: PRODUCTION_ASSURED_VALIDATORS.has(this)
    };
  }

  async validate({ packagePath, bytes, expectedPackageId, expectedPackageSha256, actions, scratchDirectory } = {}) {
    const normalizedActions = normalizePackageInputActions(actions);
    const safePackageId = requiredString(expectedPackageId, "Expected PetPack package ID", 128);
    const expectedPackageDigest = requiredString(
      expectedPackageSha256,
      "Expected PetPack validation checksum",
      64
    ).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedPackageDigest)) {
      throw new Error("Expected PetPack validation checksum must be SHA-256");
    }
    const report = {
      ok: false,
      policyVersion: this.policyVersion,
      validatorVersion: this.validatorVersion,
      validatorIdentity: this.validatorIdentity,
      archive: { ok: false },
      media: { ok: false, actions: [] },
      originalImport: { ok: false },
      interactions: { ok: false },
      errors: []
    };
    const fail = (message) => {
      report.errors.push(message);
      throw new PetpackValidationError("PetPack delivery validation failed", report);
    };
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("PetPack validation bytes are required");
    if (typeof packagePath !== "string" || !path.isAbsolute(packagePath)) throw new Error("PetPack validation path must be absolute");
    if (typeof scratchDirectory !== "string" || !path.isAbsolute(scratchDirectory)) {
      throw new Error("PetPack validation scratch directory must be absolute");
    }
    const scratchRealPath = await fsp.realpath(scratchDirectory);
    const packageRealPath = await fsp.realpath(packagePath);
    const relativePackagePath = path.relative(scratchRealPath, packageRealPath);
    const packageStat = await fsp.lstat(packageRealPath);
    if (!packageStat.isFile() || packageStat.isSymbolicLink() || relativePackagePath.startsWith("..") ||
        path.isAbsolute(relativePackagePath)) {
      throw new Error("PetPack validation path escaped its isolated workspace");
    }
    const packageDigest = checksumBuffer(bytes);
    const pathArtifact = await checksumFile(packageRealPath);
    if (pathArtifact.sha256 !== packageDigest || pathArtifact.byteSize !== bytes.length) {
      throw new Error("PetPack validation path and validation bytes are not identical");
    }
    report.packageSha256 = packageDigest;
    report.packageByteSize = bytes.length;
    if (packageDigest !== expectedPackageDigest) {
      fail("PetPack validation bytes differ from the claimed immutable archive");
    }
    let archive;
    try {
      archive = await verifyPetpackArchive(bytes);
    } catch (error) {
      fail(error.message || "PetPack archive is invalid");
    }
    if (archive.manifest.packageId !== safePackageId) fail("PetPack package ID differs from its immutable build record");
    report.archive = { ok: true, fileCount: archive.fileNames.length, packageId: safePackageId };

    const zip = await JSZip.loadAsync(bytes);
    for (const action of normalizedActions) {
      const assetPath = `assets/${ACTION_FILE_NAMES[action.actionId]}`;
      const entry = zip.file(assetPath);
      if (!entry) fail(`${action.actionId} is missing from the PetPack archive`);
      const declaredSize = Number(entry?._data?.uncompressedSize);
      if (!Number.isSafeInteger(declaredSize) || declaredSize !== action.byteSize) {
        fail(`${action.actionId} archive entry size differs from the frozen package input`);
      }
      const assetBytes = await entry.async("nodebuffer");
      if (assetBytes.length !== action.byteSize) fail(`${action.actionId} extracted byte size is invalid`);
      const digest = checksumBuffer(assetBytes);
      if (digest !== action.sha256) fail(`${action.actionId} archive bytes differ from the frozen package input`);
      const clip = findManifestClip(archive.manifest, action.actionId);
      if (!clip || clip.asset !== assetPath) fail(`${action.actionId} manifest mapping is invalid`);
      if (clip.movement) fail(`${action.actionId} must not move the desktop pet window`);
      const localPath = path.join(scratchDirectory, `validate-${ACTION_FILE_NAMES[action.actionId]}`);
      await fsp.writeFile(localPath, assetBytes, { flag: "wx" });
      // A thrown probe error is infrastructure/runtime failure and must remain
      // retryable. Only a completed probe with invalid content is deterministic
      // package QA failure.
      const probed = await this.probeAsset({
        actionId: action.actionId,
        localPath,
        buffer: assetBytes,
        expectedSha256: action.sha256
      });
      if (!probed || String(probed.checksumSha256 || "").toLowerCase() !== action.sha256) {
        fail(`${action.actionId} validation probe is not bound to its frozen checksum`);
      }
      const expectedDuration = Number(action.qa.media?.summary?.duration);
      const media = validateActionMediaProbe(probed.probe || probed, {
        allowedVideoCodecs: ["vp9"],
        allowedFormatNames: ["webm", "matroska"],
        expectedDuration
      });
      if (!media.ok) fail(`${action.actionId} failed delivery media validation: ${media.errors.join("; ")}`);
      report.media.actions.push({
        actionId: action.actionId,
        sha256: action.sha256,
        summary: media.summary,
        sourceQaReportId: action.qaReportId,
        sourceQaPolicyVersion: action.processingPolicyVersion,
        sourceProcessorVersion: action.processorVersion,
        gates: {
          canvas: action.qa.canvas.ok,
          endpoints: action.qa.endpoints.ok,
          content: action.qa.content.ok,
          continuity: action.qa.continuity.ok,
          loopSeam: action.actionId === "sleep-loop"
            ? action.qa.evidence.contentInspection.loopSeamAcceptable === true
            : null
        }
      });
    }
    report.media.ok = report.media.actions.length === REQUIRED_ACTION_IDS.length;

    const importResult = await this.originalImportVerifier.verify({
      packagePath,
      expectedPackageId: safePackageId,
      packageSha256: packageDigest
    });
    try {
      report.originalImport = normalizeImportResult(importResult, safePackageId, packageDigest, this.originalImportVerifier);
    } catch (error) {
      fail(error.message || "The clean Desktop Pet importer rejected the built PetPack");
    }
    const interactionResult = await this.interactionVerifier.verify({
      packagePath,
      manifest: archive.manifest,
      expectedPackageId: safePackageId,
      packageSha256: packageDigest,
      actionIds: [...REQUIRED_ACTION_IDS]
    });
    try {
      report.interactions = normalizeInteractionResult(
        interactionResult,
        safePackageId,
        packageDigest,
        this.interactionVerifier
      );
    } catch (error) {
      fail(error.message || "The Desktop Pet interaction verifier rejected the built PetPack");
    }
    report.ok = report.archive.ok && report.media.ok && report.originalImport.ok && report.interactions.ok;
    this.logger.info?.("petpack.package.delivery_validated", { packageId: safePackageId });
    return report;
  }
}

function isProductionAssuredValidator(value) {
  return PRODUCTION_ASSURED_VALIDATORS.has(value);
}

module.exports = {
  PETPACK_VALIDATOR_VERSION,
  PetpackDeliveryValidator,
  PetpackValidationError,
  REQUIRED_INTERACTION_CHECKS,
  createContractInteractionVerifier,
  createUpstreamImportVerifier,
  checksumBuffer,
  checksumFile,
  checksumPinnedUpstreamTree,
  isProductionAssuredValidator
};
