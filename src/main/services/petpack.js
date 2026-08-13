const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const JSZip = require("jszip");
const { createLogger } = require("./logger");
const { validateManifest } = require("../../shared/manifest-validator");
const { isSafeRelativePath } = require("../../shared/path-safety");
const { SUPPORTED_ASSET_EXTENSIONS } = require("../../shared/schema");

const logger = createLogger("petpack");
const ZIP_READ_MEMORY_FRACTION = 0.5;
const EXTRACTION_DISK_FRACTION = 0.9;
const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_SYMLINK_TYPE = 0o120000;

function errorResult(error) {
  return { ok: false, error };
}

function isSafePackageId(packageId) {
  return isSafeRelativePath(packageId) && !packageId.includes("/");
}

function assertSafePackagePath(userDataDir, packageId) {
  if (typeof userDataDir !== "string" || userDataDir.trim() === "") {
    return { ok: false, error: "User data directory is required" };
  }

  if (typeof packageId !== "string" || packageId.trim() === "" || !isSafePackageId(packageId)) {
    return { ok: false, error: "Package ID is unsafe" };
  }

  const packagesDir = path.resolve(userDataDir, "packages");
  const packageDir = path.resolve(packagesDir, packageId);
  const relative = path.relative(packagesDir, packageDir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: "Package path is unsafe" };
  }

  return { ok: true, packagesDir, packageDir };
}

function uniquePath(parentDir, prefix) {
  return path.join(parentDir, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function getEntryOriginalName(entry) {
  return entry.unsafeOriginalName || entry.name;
}

function isZipSymlink(entry) {
  if (!entry || typeof entry.unixPermissions !== "number") return false;
  return (entry.unixPermissions & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMLINK_TYPE;
}

function isAllowedPackageFile(relativePath) {
  if (relativePath === "manifest.json") return true;
  return SUPPORTED_ASSET_EXTENSIONS.includes(path.extname(relativePath).toLowerCase());
}

const IGNORED_PACKAGE_FILENAMES = new Set([".DS_Store", "Thumbs.db", "ehthumbs.db", "desktop.ini"]);
const IGNORED_PACKAGE_DIRS = new Set(["__MACOSX"]);

// OS-generated metadata (macOS .DS_Store / AppleDouble ._ files, Windows
// Thumbs.db / desktop.ini, Finder __MACOSX zip metadata) is not part of the
// package and should be skipped silently during collection/import rather than
// rejected as an unsupported extension.
function isIgnoredPackageEntry(relativePath) {
  const segments = relativePath.split("/");
  const base = segments[segments.length - 1];
  if (base && (IGNORED_PACKAGE_FILENAMES.has(base) || base.startsWith("._"))) return true;
  return segments.some((segment) => IGNORED_PACKAGE_DIRS.has(segment));
}

function validateZipEntries(zip) {
  const entries = Object.values(zip.files);
  const files = [];

  for (const entry of entries) {
    const originalName = getEntryOriginalName(entry);
    const originalPath = entry.dir && originalName.endsWith("/") ? originalName.slice(0, -1) : originalName;
    const entryPath = entry.dir && entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    if (!isSafeRelativePath(originalPath) || !isSafeRelativePath(entryPath) || originalPath !== entryPath) {
      return { ok: false, error: `Unsafe zip entry: ${originalName}` };
    }

    if (isZipSymlink(entry)) {
      return { ok: false, error: `Zip entry cannot be a symbolic link: ${originalName}` };
    }

    if (entry.dir) {
      continue;
    }

    if (isIgnoredPackageEntry(originalPath)) {
      continue;
    }

    if (!isAllowedPackageFile(entry.name)) {
      return { ok: false, error: `Petpack entry extension is not supported: ${entry.name}` };
    }

    files.push(entry);
  }

  return { ok: true, files };
}

function getZipReadBudgetBytes() {
  const freeMemoryBytes = os.freemem();
  if (!Number.isFinite(freeMemoryBytes) || freeMemoryBytes <= 0) return 0;
  return Math.floor(freeMemoryBytes * ZIP_READ_MEMORY_FRACTION);
}

function getAvailableDiskBytes(targetDir) {
  if (typeof fs.statfsSync !== "function") return Infinity;
  const stats = fs.statfsSync(targetDir);
  const availableBlocks = Number(stats && (stats.bavail ?? stats.bfree));
  const blockSize = Number(stats && (stats.bsize || stats.frsize));
  if (!Number.isFinite(availableBlocks) || !Number.isFinite(blockSize) || availableBlocks < 0 || blockSize <= 0) {
    return Infinity;
  }
  return availableBlocks * blockSize;
}

function getExtractionBudgetBytes(targetDir) {
  const availableDiskBytes = getAvailableDiskBytes(targetDir);
  if (!Number.isFinite(availableDiskBytes)) return Infinity;
  return Math.floor(availableDiskBytes * EXTRACTION_DISK_FRACTION);
}

function createByteBudgetTransform(state, errorMessage) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const byteLength = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      state.writtenBytes += byteLength;
      if (state.writtenBytes > state.budgetBytes) {
        callback(new Error(errorMessage));
        return;
      }
      callback(null, chunk);
    }
  });
}

async function writeZipEntryToFile(entry, targetPath, extractionState) {
  await pipeline(
    entry.nodeStream("nodebuffer"),
    createByteBudgetTransform(extractionState, "Petpack extracted content exceeds available disk budget"),
    fs.createWriteStream(targetPath)
  );
}

async function readManifestFromZip(zip) {
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) {
    return errorResult("manifest.json is required");
  }

  try {
    return { ok: true, manifest: JSON.parse(await manifestEntry.async("string")) };
  } catch (_error) {
    return errorResult("manifest.json is not valid JSON");
  }
}

async function importPetpack(filePath, userDataDir) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return errorResult("Petpack path is required");
  }

  let fileStats;
  try {
    fileStats = fs.statSync(filePath);
  } catch (_error) {
    return errorResult("Petpack could not be read");
  }
  const compressedBytes = Number(fileStats.size) || 0;
  const zipReadBudgetBytes = getZipReadBudgetBytes();
  if (compressedBytes > zipReadBudgetBytes) {
    logger.warn("Petpack import rejected before read: compressed file exceeds memory budget", {
      compressedBytes,
      zipReadBudgetBytes
    });
    return errorResult("Petpack is too large for available memory");
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  } catch (_error) {
    return errorResult("Petpack could not be read");
  }

  const entryValidation = validateZipEntries(zip);
  if (!entryValidation.ok) return entryValidation;

  const manifestResult = await readManifestFromZip(zip);
  if (!manifestResult.ok) return manifestResult;

  const fileNames = new Set(entryValidation.files.map((entry) => entry.name));
  const manifestValidation = validateManifest(manifestResult.manifest, fileNames);
  if (!manifestValidation.ok) {
    return errorResult(`Manifest is invalid: ${manifestValidation.errors.join("; ")}`);
  }

  const packageId = manifestResult.manifest.packageId;
  const packagePath = assertSafePackagePath(userDataDir, packageId);
  if (!packagePath.ok) return packagePath;

  const tempDir = uniquePath(packagePath.packagesDir, `.tmp-${packageId}`);
  let backupDir = "";

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    const extractionState = {
      writtenBytes: 0,
      budgetBytes: getExtractionBudgetBytes(tempDir)
    };
    logger.info("Importing petpack with resource budget", {
      packageId,
      compressedBytes,
      zipReadBudgetBytes,
      extractionBudgetBytes: extractionState.budgetBytes,
      fileCount: entryValidation.files.length
    });

    for (const entry of entryValidation.files) {
      const targetPath = path.resolve(tempDir, entry.name);
      const relative = path.relative(tempDir, targetPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Unsafe zip entry: ${entry.name}`);
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      await writeZipEntryToFile(entry, targetPath, extractionState);
    }

    if (fs.existsSync(packagePath.packageDir)) {
      backupDir = uniquePath(packagePath.packagesDir, `.backup-${packageId}`);
      fs.renameSync(packagePath.packageDir, backupDir);
    }

    fs.renameSync(tempDir, packagePath.packageDir);
    if (backupDir) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    return { ok: true, packageId, fileCount: entryValidation.files.length };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(packagePath.packageDir)) {
      fs.renameSync(backupDir, packagePath.packageDir);
    }
    return errorResult(error.message || "Petpack import failed");
  }
}

function collectPackageFiles(packageDir, currentDir = packageDir, files = []) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(packageDir, absolutePath).split(path.sep).join("/");

    if (isIgnoredPackageEntry(relativePath)) {
      continue;
    }

    if (!isSafeRelativePath(relativePath)) {
      return { ok: false, error: `Unsafe package file: ${relativePath}` };
    }

    if (entry.isSymbolicLink()) {
      return { ok: false, error: `Package file cannot be a symbolic link: ${relativePath}` };
    }

    if (entry.isDirectory()) {
      const result = collectPackageFiles(packageDir, absolutePath, files);
      if (!result.ok) return result;
      continue;
    }

    if (!entry.isFile()) {
      return { ok: false, error: `Package entry is not a file: ${relativePath}` };
    }

    if (!isAllowedPackageFile(relativePath)) {
      return { ok: false, error: `Package file extension is not supported: ${relativePath}` };
    }

    files.push({ absolutePath, relativePath });
  }

  return { ok: true, files };
}

function mergeManifestWithConfig(manifest, config = {}) {
  return {
    ...manifest,
    animations: config.animations || manifest.animations,
    triggerRules: Array.isArray(config.triggerRules) ? config.triggerRules : (manifest.triggerRules || [])
  };
}

async function exportPetpack(packageId, userDataDir, targetPath, config = {}) {
  const packagePath = assertSafePackagePath(userDataDir, packageId);
  if (!packagePath.ok) return packagePath;

  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    return errorResult("Export path is required");
  }

  if (!fs.existsSync(packagePath.packageDir)) {
    return errorResult("Package does not exist");
  }

  const collected = collectPackageFiles(packagePath.packageDir);
  if (!collected.ok) return collected;

  if (!collected.files.some((file) => file.relativePath === "manifest.json")) {
    return errorResult("manifest.json is required");
  }

  const availableFiles = new Set(collected.files.map((file) => file.relativePath));
  const manifestFile = collected.files.find((file) => file.relativePath === "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile.absolutePath, "utf8"));
  } catch (_error) {
    return errorResult("manifest.json is not valid JSON");
  }

  if (!isSafePackageId(manifest.packageId)) {
    return errorResult("Manifest package ID is unsafe");
  }

  if (manifest.packageId !== packageId) {
    return errorResult("Manifest package ID does not match selected package");
  }

  const exportManifest = mergeManifestWithConfig(manifest, config);
  const manifestValidation = validateManifest(exportManifest, availableFiles);
  if (!manifestValidation.ok) {
    return errorResult(`Manifest is invalid: ${manifestValidation.errors.join("; ")}`);
  }

  const zip = new JSZip();
  for (const file of collected.files) {
    zip.file(
      file.relativePath,
      file.relativePath === "manifest.json"
        ? JSON.stringify(exportManifest, null, 2)
        : fs.readFileSync(file.absolutePath)
    );
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const targetDir = path.dirname(targetPath);
  const tempTargetPath = uniquePath(targetDir, `.tmp-${path.basename(targetPath)}`);

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tempTargetPath, buffer);
    fs.renameSync(tempTargetPath, targetPath);
    return { ok: true, packageId, fileCount: collected.files.length, targetPath };
  } catch (error) {
    fs.rmSync(tempTargetPath, { force: true });
    return errorResult(error.message || "Petpack export failed");
  }
}

module.exports = {
  exportPetpack,
  importPetpack,
  isSafePackageId,
  mergeManifestWithConfig,
  readManifestFromZip,
  validateZipEntries
};
