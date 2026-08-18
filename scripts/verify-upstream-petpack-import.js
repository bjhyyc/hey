"use strict";

// Isolated child used by createUpstreamImportVerifier. It loads the PINNED
// clean upstream Desktop Pet importer (never this repository's customized
// runtime import path) and imports one PetPack into a throwaway user-data
// directory. Exactly one JSON object is written to stdout; every diagnostic
// goes to stderr so the parent can parse the result safely.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const PROTOCOL_VERSION = "petpack-upstream-import/v1";

function boundedMessage(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 512);
}

// The upstream importer logs through console/logger helpers. stdout must stay
// a single-JSON channel, so console output is rerouted before any upstream
// module loads.
for (const method of ["log", "info", "warn", "error", "debug"]) {
  console[method] = (...parts) => {
    try {
      process.stderr.write(`${parts.map((part) => boundedMessage(typeof part === "string" ? part : JSON.stringify(part))).join(" ")}\n`);
    } catch {
      // Diagnostics are best-effort; verification result integrity matters.
    }
  };
}

function emit(payload, exitCode) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = exitCode;
}

async function main() {
  const upstreamRoot = process.argv[2];
  const packagePath = process.argv[3];
  if (typeof upstreamRoot !== "string" || !upstreamRoot.trim() || !path.isAbsolute(upstreamRoot)) {
    throw new Error("Upstream root must be an absolute path");
  }
  if (typeof packagePath !== "string" || !packagePath.trim() || !path.isAbsolute(packagePath)) {
    throw new Error("PetPack path must be an absolute path");
  }
  const importerPath = path.join(upstreamRoot, "src", "main", "services", "petpack.js");
  const importerStat = fs.lstatSync(importerPath);
  if (!importerStat.isFile() || importerStat.isSymbolicLink()) {
    throw new Error("Pinned upstream importer is not a regular file");
  }
  const packageStat = fs.lstatSync(packagePath);
  if (!packageStat.isFile() || packageStat.isSymbolicLink()) {
    throw new Error("PetPack to verify is not a regular file");
  }

  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "petpack-upstream-import-"));
  try {
    try {
      const loggerModule = require(path.join(upstreamRoot, "src", "main", "services", "logger.js"));
      loggerModule?.configureLogger?.({
        userDataDir: dataRoot,
        mirrorToConsole: false,
        silenceConsole: true
      });
    } catch (error) {
      process.stderr.write(`upstream logger configuration skipped: ${boundedMessage(error.message)}\n`);
    }
    const importerModule = require(importerPath);
    if (typeof importerModule?.importPetpack !== "function") {
      throw new Error("Pinned upstream importer does not export importPetpack");
    }
    const result = await importerModule.importPetpack(packagePath, dataRoot);
    const packageId = typeof result?.packageId === "string" ? result.packageId : null;
    const manifestInstalled = Boolean(
      result?.ok === true &&
      packageId &&
      fs.existsSync(path.join(dataRoot, "packages", packageId, "manifest.json"))
    );
    emit({
      protocolVersion: PROTOCOL_VERSION,
      manifestInstalled,
      result: {
        ok: result?.ok === true && manifestInstalled,
        packageId,
        fileCount: Number.isSafeInteger(result?.fileCount) ? result.fileCount : null,
        error: result?.ok === true ? null : boundedMessage(result?.error || "upstream import rejected the PetPack")
      }
    }, result?.ok === true && manifestInstalled ? 0 : 1);
  } finally {
    await fsp.rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${boundedMessage(error?.stack || error?.message || error)}\n`);
  process.exitCode = 2;
});
