"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ELECTRON_INTERACTION_PROTOCOL_VERSION = "petpack-electron-interaction/v1";
const DEFAULT_ELECTRON_INTERACTION_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_ELECTRON_INTERACTION_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CHILD_STDOUT_BYTES = 1024 * 1024;
const MAX_CHILD_STDERR_BYTES = 64 * 1024;
const FORBIDDEN_CHILD_ENVIRONMENT_KEYS = new Set([
  "DYLD_INSERT_LIBRARIES",
  "ELECTRON_RUN_AS_NODE",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH"
]);

// Child protocol: stdin receives exactly one JSON object containing
// {protocolVersion, requestId, packagePath, packageId, packageSha256,
// packageByteSize, workspacePath, actionIds}. A completed verification exits
// zero and writes exactly one JSON object with the same protocol/request/package
// bindings plus {ok, checks}. Non-zero exit is reserved for runner failure;
// diagnostics belong on bounded stderr, never stdout.

function requiredString(value, label, maximum = 2048) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requiredSha256(value, label) {
  const digest = requiredString(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be SHA-256`);
  return digest;
}

function sameResolvedPath(left, right) {
  const normalize = process.platform === "win32"
    ? (value) => path.resolve(value).toLowerCase()
    : (value) => path.resolve(value);
  return normalize(left) === normalize(right);
}

function checksumRegularFileSync(filePath, label) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  let byteSize = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      byteSize += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || byteSize !== stat.size) throw new Error(`${label} changed during checksum`);
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: hash.digest("hex"), byteSize };
}

function inspectPinnedFileSync(filePath, expectedSha256, label) {
  const selected = requiredString(filePath, label);
  if (!path.isAbsolute(selected)) throw new Error(`${label} must be an absolute path`);
  const resolved = path.resolve(selected);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symbolic file`);
  const realPath = fs.realpathSync(resolved);
  const expectedDigest = requiredSha256(expectedSha256, `${label} checksum`);
  const artifact = checksumRegularFileSync(realPath, label);
  if (artifact.byteSize <= 0) throw new Error(`${label} must be non-empty`);
  if (artifact.sha256 !== expectedDigest) throw new Error(`${label} does not match its pinned checksum`);
  return Object.freeze({ path: realPath, sha256: artifact.sha256, byteSize: artifact.byteSize });
}

function normalizeRunnerApplicationManifest(value, runnerFileName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Electron interaction runner application manifest is invalid");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["main", "name", "private", "version"].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) ||
      value.name !== "petpack-electron-interaction-runner" || value.version !== "1.0.0" ||
      value.private !== true || value.main !== runnerFileName) {
    throw new Error("Electron interaction runner application manifest is invalid");
  }
  return value;
}

function inspectRunnerApplicationSync(runnerPath) {
  const applicationPath = path.dirname(runnerPath);
  const applicationStat = fs.lstatSync(applicationPath);
  if (!applicationStat.isDirectory() || applicationStat.isSymbolicLink()) {
    throw new Error("Electron interaction runner application must be a regular directory");
  }
  const realApplicationPath = fs.realpathSync(applicationPath);
  if (!sameResolvedPath(applicationPath, realApplicationPath)) {
    throw new Error("Electron interaction runner application path cannot be redirected");
  }
  const manifestPath = path.join(realApplicationPath, "package.json");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Electron interaction runner application manifest must be a regular file");
  }
  const realManifestPath = fs.realpathSync(manifestPath);
  normalizeRunnerApplicationManifest(
    JSON.parse(fs.readFileSync(realManifestPath, "utf8")),
    path.basename(runnerPath)
  );
  const artifact = checksumRegularFileSync(realManifestPath, "Electron interaction runner application manifest");
  return Object.freeze({
    path: realApplicationPath,
    manifestPath: realManifestPath,
    manifestSha256: artifact.sha256,
    manifestByteSize: artifact.byteSize
  });
}

async function inspectRunnerApplication(application, runnerPath) {
  const directoryStat = await fsp.lstat(application.path);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Electron interaction runner application changed after verifier startup");
  }
  const realApplicationPath = await fsp.realpath(application.path);
  if (!sameResolvedPath(realApplicationPath, application.path)) {
    throw new Error("Electron interaction runner application changed after verifier startup");
  }
  const manifest = await inspectPinnedFile(application.manifestPath, {
    path: application.manifestPath,
    sha256: application.manifestSha256,
    byteSize: application.manifestByteSize
  }, "Electron interaction runner application manifest");
  normalizeRunnerApplicationManifest(
    JSON.parse(await fsp.readFile(manifest.path, "utf8")),
    path.basename(runnerPath)
  );
  return application;
}

async function inspectPinnedFile(filePath, expected, label) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must remain a regular non-symbolic file`);
  const realPath = await fsp.realpath(filePath);
  if (!sameResolvedPath(realPath, expected.path)) throw new Error(`${label} path changed after verifier startup`);
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  for await (const chunk of fs.createReadStream(realPath)) {
    byteSize += chunk.length;
    hash.update(chunk);
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== expected.sha256 || byteSize !== expected.byteSize) {
    throw new Error(`${label} changed after verifier startup`);
  }
  return { path: realPath, sha256, byteSize };
}

async function inspectPackageFile(packagePath, expectedSha256) {
  const selected = requiredString(packagePath, "Electron interaction PetPack path");
  if (!path.isAbsolute(selected)) throw new Error("Electron interaction PetPack path must be absolute");
  const resolved = path.resolve(selected);
  const stat = await fsp.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Electron interaction PetPack must be a regular non-symbolic file");
  }
  const realPath = await fsp.realpath(resolved);
  const expectedDigest = requiredSha256(expectedSha256, "Electron interaction PetPack checksum");
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  for await (const chunk of fs.createReadStream(realPath)) {
    byteSize += chunk.length;
    hash.update(chunk);
  }
  const sha256 = hash.digest("hex");
  if (byteSize <= 0) throw new Error("Electron interaction PetPack must be non-empty");
  if (sha256 !== expectedDigest) throw new Error("Electron interaction PetPack does not match its expected checksum");
  return { path: realPath, sha256, byteSize };
}

function normalizeStaticArguments(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("Electron interaction runner arguments must be an array with at most 32 entries");
  }
  return Object.freeze(value.map((entry) => requiredString(entry, "Electron interaction runner argument", 1024)));
}

function normalizeChildEnvironment(value) {
  if (value === undefined) return Object.freeze({ NODE_ENV: "production" });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Electron interaction child environment must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error("Electron interaction child environment has too many entries");
  const environment = Object.assign(Object.create(null), { NODE_ENV: "production" });
  const normalizedNames = new Set(["NODE_ENV"]);
  for (const [rawName, rawValue] of entries) {
    const name = requiredString(rawName, "Electron interaction child environment name", 128);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Electron interaction child environment name is invalid: ${name}`);
    }
    const normalizedName = name.toUpperCase();
    if (FORBIDDEN_CHILD_ENVIRONMENT_KEYS.has(normalizedName)) {
      throw new Error(`Electron interaction child environment cannot set ${name}`);
    }
    if (typeof rawValue !== "string" || rawValue.length > 8192 || rawValue.includes("\0")) {
      throw new Error(`Electron interaction child environment value is invalid: ${name}`);
    }
    if (normalizedNames.has(normalizedName) && normalizedName !== "NODE_ENV") {
      throw new Error(`Electron interaction child environment name is duplicated: ${name}`);
    }
    normalizedNames.add(normalizedName);
    if (normalizedName !== "NODE_ENV") environment[name] = rawValue;
  }
  environment.NODE_ENV = "production";
  return Object.freeze(environment);
}

function normalizeRequiredNames(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  const names = value.map((entry) => requiredString(entry, `${label} entry`, 128));
  if (new Set(names).size !== names.length) throw new Error(`${label} cannot contain duplicates`);
  return Object.freeze(names);
}

function requireExactNames(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length) throw new Error(`${label} is incomplete`);
  const received = new Set(value.map((entry) => requiredString(entry, `${label} entry`, 128)));
  if (received.size !== expected.length || expected.some((entry) => !received.has(entry))) {
    throw new Error(`${label} is incomplete`);
  }
  return [...expected];
}

function boundedDiagnostic(buffers) {
  return Buffer.concat(buffers).toString("utf8").replace(/[\r\n]+/g, " ").slice(0, 1024);
}

function terminateChildTree(child) {
  const pid = Number(child?.pid);
  if (process.platform === "win32" && Number.isSafeInteger(pid) && pid > 0 &&
      child.exitCode === null && child.signalCode === null) {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (typeof systemRoot === "string" && path.isAbsolute(systemRoot)) {
      const taskkillPath = path.join(systemRoot, "System32", "taskkill.exe");
      try {
        const stat = fs.lstatSync(taskkillPath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          const result = spawnSync(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
            timeout: 5000
          });
          if (result.status === 0) return;
        }
      } catch {
        // Fall through to the fixed child handle. Timeout paths remain fail closed.
      }
    }
  }
  try { child?.kill?.("SIGKILL"); } catch { /* best-effort fixed-child cleanup */ }
}

function runJsonChild({
  executablePath,
  runnerApplicationPath,
  runnerArguments,
  workingDirectory,
  environment,
  request,
  spawnImpl,
  timeoutMs
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executablePath, [runnerApplicationPath, ...runnerArguments], {
        cwd: workingDirectory,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(new Error(`Electron interaction verifier could not start: ${error.message}`));
      return;
    }
    if (!child || typeof child.once !== "function" || !child.stdin || !child.stdout || !child.stderr ||
        typeof child.stdin.end !== "function" || typeof child.stdout.on !== "function" ||
        typeof child.stderr.on !== "function") {
      terminateChildTree(child);
      reject(new Error("Electron interaction verifier returned an invalid child process"));
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const fail = (error) => finish(reject, error);
    const terminate = (error) => {
      if (settled) return;
      fail(error);
      terminateChildTree(child);
    };

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_CHILD_STDOUT_BYTES) {
        terminate(new Error("Electron interaction verifier output exceeded its limit"));
        return;
      }
      stdout.push(bytes);
    });
    child.stdout.on("error", (error) => {
      terminate(new Error(`Electron interaction verifier stdout failed: ${error.message}`));
    });
    child.stderr.on("data", (chunk) => {
      if (settled || stderrBytes >= MAX_CHILD_STDERR_BYTES) return;
      const bytes = Buffer.from(chunk);
      const remaining = MAX_CHILD_STDERR_BYTES - stderrBytes;
      const selected = bytes.subarray(0, remaining);
      stderrBytes += selected.length;
      stderr.push(selected);
    });
    child.stderr.on("error", (error) => {
      terminate(new Error(`Electron interaction verifier stderr failed: ${error.message}`));
    });
    child.once("error", (error) => {
      terminate(new Error(`Electron interaction verifier could not start: ${error.message}`));
    });
    child.stdin.once?.("error", (error) => {
      terminate(new Error(`Electron interaction verifier request failed: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      const diagnostic = boundedDiagnostic(stderr);
      if (signal || code !== 0) {
        fail(new Error(`Electron interaction verifier crashed: ${diagnostic || signal || `exit ${code}`}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        fail(new Error("Electron interaction verifier returned invalid JSON"));
        return;
      }
      finish(resolve, parsed);
    });

    timer = setTimeout(() => {
      terminate(new Error("Electron interaction verifier exceeded its timeout"));
    }, timeoutMs);
    timer.unref?.();
    try {
      child.stdin.end(Buffer.from(`${JSON.stringify(request)}\n`, "utf8"));
    } catch (error) {
      terminate(new Error(`Electron interaction verifier request failed: ${error.message}`));
    }
  });
}

function normalizeChildResult(value, request, requiredChecks) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Electron interaction verifier returned an invalid JSON object");
  }
  if (value.protocolVersion !== ELECTRON_INTERACTION_PROTOCOL_VERSION || value.requestId !== request.requestId) {
    throw new Error("Electron interaction verifier returned an invalid protocol binding");
  }
  if (value.packageId !== request.packageId || value.packageSha256 !== request.packageSha256 ||
      value.packageByteSize !== request.packageByteSize) {
    throw new Error("Electron interaction verifier returned evidence for a different PetPack");
  }
  if (typeof value.ok !== "boolean") throw new Error("Electron interaction verifier omitted its result status");
  if (!value.checks || typeof value.checks !== "object" || Array.isArray(value.checks)) {
    throw new Error("Electron interaction verifier omitted its interaction checks");
  }
  const checks = Object.freeze(Object.fromEntries(
    requiredChecks.map((check) => [check, value.checks[check] === true])
  ));
  return Object.freeze({
    ok: value.ok,
    packageId: request.packageId,
    packageSha256: request.packageSha256,
    checks
  });
}

function createPinnedElectronInteractionVerifier({
  electronExecutablePath,
  expectedElectronExecutableSha256,
  runnerPath,
  expectedRunnerSha256,
  identity = "desktop-pet-electron-interaction-runner",
  runnerArguments,
  childEnvironment,
  requiredActionIds,
  requiredInteractionChecks,
  spawnImpl,
  timeoutMs = DEFAULT_ELECTRON_INTERACTION_TIMEOUT_MS
} = {}) {
  if (typeof spawnImpl !== "function") throw new Error("Electron interaction verifier requires a process launcher");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_ELECTRON_INTERACTION_TIMEOUT_MS) {
    throw new Error("Electron interaction verifier timeout must be between 1 second and 15 minutes");
  }
  const executable = inspectPinnedFileSync(
    electronExecutablePath,
    expectedElectronExecutableSha256,
    "Electron executable"
  );
  const runner = inspectPinnedFileSync(runnerPath, expectedRunnerSha256, "Electron interaction runner");
  const runnerApplication = inspectRunnerApplicationSync(runner.path);
  const actions = normalizeRequiredNames(requiredActionIds, "Electron interaction required action IDs");
  const interactionChecks = normalizeRequiredNames(
    requiredInteractionChecks,
    "Electron interaction required checks"
  );
  const args = normalizeStaticArguments(runnerArguments);
  const environment = normalizeChildEnvironment(childEnvironment);
  const verifierIdentity = requiredString(identity, "Electron interaction verifier identity", 256);
  const versionDigest = crypto.createHash("sha256").update([
    ELECTRON_INTERACTION_PROTOCOL_VERSION,
    executable.sha256,
    runner.sha256,
    runnerApplication.manifestSha256,
    JSON.stringify(args),
    JSON.stringify(Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)))),
    JSON.stringify(actions),
    JSON.stringify(interactionChecks),
    String(timeoutMs)
  ].join("\0")).digest("hex").slice(0, 48);

  return Object.freeze({
    mode: "electron-runtime",
    identity: verifierIdentity,
    version: `${ELECTRON_INTERACTION_PROTOCOL_VERSION}:${versionDigest}`,
    protocolVersion: ELECTRON_INTERACTION_PROTOCOL_VERSION,
    electronExecutableSha256: executable.sha256,
    runnerSha256: runner.sha256,
    async verify({ packagePath, expectedPackageId, packageSha256, actionIds } = {}) {
      const packageId = requiredString(expectedPackageId, "Electron interaction expected package ID", 128);
      const normalizedActionIds = requireExactNames(actionIds, actions, "Electron interaction action IDs");
      await inspectPinnedFile(executable.path, executable, "Electron executable");
      await inspectPinnedFile(runner.path, runner, "Electron interaction runner");
      await inspectRunnerApplication(runnerApplication, runner.path);
      const artifact = await inspectPackageFile(packagePath, packageSha256);
      const request = Object.freeze({
        protocolVersion: ELECTRON_INTERACTION_PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        packagePath: artifact.path,
        packageId,
        packageSha256: artifact.sha256,
        packageByteSize: artifact.byteSize,
        workspacePath: path.dirname(artifact.path),
        actionIds: normalizedActionIds
      });
      const response = await runJsonChild({
        executablePath: executable.path,
        runnerApplicationPath: runnerApplication.path,
        runnerArguments: args,
        workingDirectory: path.dirname(runner.path),
        environment,
        request,
        spawnImpl,
        timeoutMs
      });
      return normalizeChildResult(response, request, interactionChecks);
    }
  });
}

module.exports = {
  DEFAULT_ELECTRON_INTERACTION_TIMEOUT_MS,
  ELECTRON_INTERACTION_PROTOCOL_VERSION,
  MAX_CHILD_STDERR_BYTES,
  MAX_CHILD_STDOUT_BYTES,
  createPinnedElectronInteractionVerifier
};
