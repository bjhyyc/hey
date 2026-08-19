"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const PROTOCOL_VERSION = "petpack-electron-interaction/v1";
const MAX_PACKAGE_BYTES = 320 * 1024 * 1024;
const REQUIRED_ACTION_IDS = Object.freeze([
  "idle",
  "sneeze",
  "roll",
  "sleep-transition",
  "sleep-loop",
  "stretch",
  "hover-attention"
]);
const REQUIRED_CHECKS = Object.freeze([
  "startupStretchThenIdle",
  "singleClickSneeze",
  "doubleClickRollWithoutSneeze",
  "rightClickStretchAndWake",
  "idleTwentyTwoSecondsThenSleepLoop",
  "hoverTwoSecondsOnceWithCooldown",
  "noMovementOrProps"
]);
const ACTION_KEY_BY_ID = Object.freeze({
  idle: "idle",
  sneeze: "sneeze",
  roll: "roll",
  "sleep-transition": "sleepTransition",
  "sleep-loop": "sleepLoop",
  stretch: "stretch",
  "hover-attention": "hoverAttention"
});

class InteractionCheckError extends Error {
  constructor(check, message) {
    super(message);
    this.name = "InteractionCheckError";
    this.check = check;
  }
}

function createVerificationCursor(screen) {
  if (!screen || typeof screen.getCursorScreenPoint !== "function") {
    throw new Error("Electron interaction runner requires the native screen cursor API");
  }
  const initial = screen.getCursorScreenPoint();
  let point = {
    x: Number.isFinite(Number(initial?.x)) ? Math.round(Number(initial.x)) : 0,
    y: Number.isFinite(Number(initial?.y)) ? Math.round(Number(initial.y)) : 0
  };
  return Object.freeze({
    set(clientWindow, clientPoint) {
      if (!clientWindow || typeof clientWindow.getBounds !== "function") {
        throw new Error("Electron interaction cursor requires a BrowserWindow");
      }
      const bounds = clientWindow.getBounds();
      const x = Math.round(Number(clientPoint?.x));
      const y = Math.round(Number(clientPoint?.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("Electron interaction cursor point is invalid");
      }
      point = { x: bounds.x + x, y: bounds.y + y };
      return { ...point };
    },
    read() {
      return { ...point };
    }
  });
}

function installVerificationCursorTracker(clientRoot, verificationCursor) {
  if (!verificationCursor || typeof verificationCursor.read !== "function") {
    throw new Error("Electron interaction runner requires an isolated verification cursor");
  }
  const trackerPath = path.join(clientRoot, "src", "main", "global-mouse-tracker.js");
  const trackerModule = require(trackerPath);
  const createTracker = trackerModule?.createGlobalMouseTracker;
  if (typeof createTracker !== "function") {
    throw new Error("Pinned Desktop Pet global mouse tracker is unavailable");
  }
  trackerModule.createGlobalMouseTracker = (options = {}) => createTracker({
    ...options,
    screenGetter: () => ({ getCursorScreenPoint: verificationCursor.read })
  });
}

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

function samePath(left, right) {
  const normalize = process.platform === "win32"
    ? (value) => path.resolve(value).toLowerCase()
    : (value) => path.resolve(value);
  return normalize(left) === normalize(right);
}

function isDescendant(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function requireExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function requireExactNames(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`${label} is incomplete`);
  }
  const names = value.map((entry) => requiredString(entry, `${label} entry`, 128));
  if (new Set(names).size !== expected.length || expected.some((entry) => !names.includes(entry))) {
    throw new Error(`${label} is incomplete`);
  }
  return [...expected];
}

function parseRunnerArguments(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 2) {
    throw new Error("Electron interaction runner requires exactly two pinned client arguments");
  }
  const values = new Map();
  for (const argument of argv) {
    const selected = requiredString(argument, "Electron interaction runner argument", 4096);
    const separator = selected.indexOf("=");
    if (separator <= 2) throw new Error("Electron interaction runner argument is invalid");
    const name = selected.slice(0, separator);
    const value = selected.slice(separator + 1);
    if (!["--client-root", "--client-tree-sha256"].includes(name) || values.has(name)) {
      throw new Error("Electron interaction runner argument is unsupported or duplicated");
    }
    values.set(name, value);
  }
  const root = path.resolve(requiredString(values.get("--client-root"), "Pinned Desktop Pet client root"));
  if (!path.isAbsolute(root)) throw new Error("Pinned Desktop Pet client root must be absolute");
  return Object.freeze({
    clientRoot: root,
    expectedClientTreeSha256: requiredSha256(
      values.get("--client-tree-sha256"),
      "Pinned Desktop Pet client tree checksum"
    )
  });
}

function checksumPinnedClientTree(clientRoot) {
  const root = path.resolve(requiredString(clientRoot, "Desktop Pet client root"));
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Desktop Pet client root must be a regular directory");
  }
  const realRoot = fs.realpathSync(root);
  if (!samePath(root, realRoot)) throw new Error("Desktop Pet client root cannot be redirected");
  const files = [];
  for (const relative of ["package.json", "package-lock.json"]) {
    const absolute = path.join(realRoot, relative);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Pinned client file is invalid: ${relative}`);
    files.push(relative);
  }
  const sourceRoot = path.join(realRoot, "src");
  const sourceStat = fs.lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Pinned client tree is missing src");
  }
  function visit(directory, relativeDirectory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = `${relativeDirectory}/${entry.name}`;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Pinned client tree contains a symbolic link: ${relative}`);
      if (stat.isDirectory()) {
        visit(absolute, relative);
      } else if (stat.isFile()) {
        files.push(relative.split(path.sep).join("/"));
      } else {
        throw new Error(`Pinned client tree contains an unsupported entry: ${relative}`);
      }
    }
  }
  visit(sourceRoot, "src");
  const hash = crypto.createHash("sha256");
  for (const relative of [...new Set(files)].sort()) {
    hash.update(relative);
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(path.join(realRoot, ...relative.split("/"))));
    hash.update(Buffer.from([0]));
  }
  return Object.freeze({ root: realRoot, sha256: hash.digest("hex") });
}

function normalizeRunnerRequest(value) {
  requireExactKeys(value, [
    "protocolVersion",
    "requestId",
    "packagePath",
    "packageId",
    "packageSha256",
    "packageByteSize",
    "workspacePath",
    "actionIds"
  ], "Electron interaction request");
  if (value.protocolVersion !== PROTOCOL_VERSION) throw new Error("Electron interaction protocol is unsupported");
  const requestId = requiredString(value.requestId, "Electron interaction request ID", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error("Electron interaction request ID must be a UUID");
  }
  const packageId = requiredString(value.packageId, "Electron interaction package ID", 128);
  if (!/^[A-Za-z0-9._-]+$/.test(packageId)) throw new Error("Electron interaction package ID is unsafe");
  const packageByteSize = Number(value.packageByteSize);
  if (!Number.isSafeInteger(packageByteSize) || packageByteSize <= 0 || packageByteSize > MAX_PACKAGE_BYTES) {
    throw new Error("Electron interaction PetPack byte size is invalid");
  }
  const workspacePath = path.resolve(requiredString(value.workspacePath, "Electron interaction workspace"));
  const workspaceStat = fs.lstatSync(workspacePath);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error("Electron interaction workspace must be a regular directory");
  }
  const workspaceRealPath = fs.realpathSync(workspacePath);
  if (!samePath(workspacePath, workspaceRealPath)) {
    throw new Error("Electron interaction workspace cannot be redirected");
  }
  const packagePath = path.resolve(requiredString(value.packagePath, "Electron interaction PetPack path"));
  const packageStat = fs.lstatSync(packagePath);
  if (!packageStat.isFile() || packageStat.isSymbolicLink()) {
    throw new Error("Electron interaction PetPack must be a regular file");
  }
  const packageRealPath = fs.realpathSync(packagePath);
  if (!isDescendant(workspaceRealPath, packageRealPath)) {
    throw new Error("Electron interaction PetPack escaped its workspace");
  }
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    packagePath: packageRealPath,
    packageId,
    packageSha256: requiredSha256(value.packageSha256, "Electron interaction PetPack checksum"),
    packageByteSize,
    workspacePath: workspaceRealPath,
    actionIds: Object.freeze(requireExactNames(value.actionIds, REQUIRED_ACTION_IDS, "Electron interaction action IDs"))
  });
}

async function copyImmutablePackageSnapshot(request, runRoot) {
  const snapshotPath = path.join(runRoot, "package.petpack");
  const source = await fsp.open(request.packagePath, "r");
  const target = await fsp.open(snapshotPath, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteSize = 0;
  try {
    const initial = await source.stat();
    if (!initial.isFile() || initial.size !== request.packageByteSize) {
      throw new Error("Electron interaction PetPack changed before snapshot");
    }
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, null);
        if (!result.bytesWritten) throw new Error("Electron interaction PetPack snapshot write stalled");
        written += result.bytesWritten;
      }
      hash.update(buffer.subarray(0, bytesRead));
      byteSize += bytesRead;
      if (byteSize > MAX_PACKAGE_BYTES) throw new Error("Electron interaction PetPack snapshot exceeded its limit");
    }
    await target.sync();
    const finalSource = await source.stat();
    const finalTarget = await target.stat();
    const sha256 = hash.digest("hex");
    if (!finalSource.isFile() || finalSource.size !== request.packageByteSize ||
        !finalTarget.isFile() || finalTarget.size !== request.packageByteSize ||
        byteSize !== request.packageByteSize || sha256 !== request.packageSha256) {
      throw new Error("Electron interaction PetPack snapshot does not match its immutable binding");
    }
  } finally {
    await Promise.allSettled([source.close(), target.close()]);
  }
  const stat = await fsp.lstat(snapshotPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Electron interaction snapshot is invalid");
  return snapshotPath;
}

function getBehaviorContract(manifest, actionIds) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.packageId === undefined) {
    throw new Error("Installed PetPack manifest is invalid");
  }
  if (!manifest.studioBehavior || manifest.studioBehavior.profile !== "petpack-studio/v1" ||
      !manifest.studioBehavior.actionClipIds) {
    throw new Error("Installed PetPack does not declare the Studio behavior contract");
  }
  if (!Array.isArray(manifest.triggerRules) || manifest.triggerRules.length !== 0) {
    throw new Error("Studio PetPack cannot include generic trigger rules");
  }
  const clips = [manifest.animations?.default, ...(manifest.animations?.clips || [])].filter(Boolean);
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const selected = {};
  for (const actionId of actionIds) {
    const key = ACTION_KEY_BY_ID[actionId];
    const clipId = manifest.studioBehavior.actionClipIds[key];
    const clip = byId.get(clipId);
    if (!clip || typeof clip.id !== "string" || !clip.asset || clip.movement) {
      throw new Error(`Installed PetPack action contract is invalid: ${actionId}`);
    }
    selected[actionId] = Object.freeze({
      id: clip.id,
      durationMs: actionId === "idle" ? 0 : Number(clip.durationMs)
    });
  }
  const timing = manifest.studioBehavior.timing || {};
  if (Number(timing.idleTimeoutMs) !== 22000 || Number(timing.hoverDelayMs) !== 2000 ||
      !Number.isFinite(Number(timing.hoverCooldownMs))) {
    throw new Error("Installed PetPack timing contract is invalid");
  }
  for (const actionId of actionIds.filter((entry) => entry !== "idle")) {
    if (!Number.isInteger(selected[actionId].durationMs) || selected[actionId].durationMs <= 0) {
      throw new Error(`Installed PetPack action duration is invalid: ${actionId}`);
    }
  }
  return Object.freeze({
    actions: Object.freeze(selected),
    timing: Object.freeze({
      idleTimeoutMs: Number(timing.idleTimeoutMs),
      hoverDelayMs: Number(timing.hoverDelayMs),
      hoverCooldownMs: Number(timing.hoverCooldownMs)
    })
  });
}

function createRuntimeDirectories(request) {
  const runRoot = fs.mkdtempSync(path.join(request.workspacePath, "electron-interaction-"));
  recordRunnerStage(runRoot, "run-root-created");
  const runStat = fs.lstatSync(runRoot);
  const runRealPath = fs.realpathSync(runRoot);
  if (!runStat.isDirectory() || runStat.isSymbolicLink() || !isDescendant(request.workspacePath, runRealPath)) {
    throw new Error("Electron interaction run directory is unsafe");
  }
  recordRunnerStage(runRealPath, "run-root-verified");
  const directories = Object.freeze({
    runRoot: runRealPath,
    userData: path.join(runRealPath, "user-data"),
    sessionData: path.join(runRealPath, "session-data"),
    temp: path.join(runRealPath, "temp"),
    crashDumps: path.join(runRealPath, "crash-dumps")
  });
  for (const directory of Object.values(directories).slice(1)) {
    fs.mkdirSync(directory, { recursive: false });
  }
  recordRunnerStage(runRealPath, "runtime-directories-created");
  return directories;
}

async function prepareIsolatedClient({ clientRoot, request, directories }) {
  const runRealPath = directories.runRoot;
  const snapshotPath = await copyImmutablePackageSnapshot(request, runRealPath);
  recordRunnerStage(runRealPath, "package-snapshot-created");
  const { configureLogger } = require(path.join(clientRoot, "src", "main", "services", "logger.js"));
  configureLogger({ userDataDir: directories.userData, enabled: false, level: "silent" });
  const { importPetpack } = require(path.join(clientRoot, "src", "main", "services", "petpack.js"));
  const { createConfigStore } = require(path.join(clientRoot, "src", "main", "services", "config-store.js"));
  const imported = await importPetpack(snapshotPath, directories.userData);
  if (!imported || imported.ok !== true || imported.packageId !== request.packageId) {
    throw new Error("Pinned Desktop Pet client rejected the immutable PetPack snapshot");
  }
  recordRunnerStage(runRealPath, "package-imported");
  const manifestPath = path.join(directories.userData, "packages", request.packageId, "manifest.json");
  const manifestStat = await fsp.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Pinned Desktop Pet client did not install a regular manifest");
  }
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (manifest.packageId !== request.packageId) throw new Error("Installed PetPack ID does not match its request");
  const behavior = getBehaviorContract(manifest, request.actionIds);
  const store = createConfigStore(directories.userData);
  store.save({
    currentPackageId: request.packageId,
    display: {
      x: 80,
      y: 160,
      scale: 1,
      opacity: 1,
      alwaysOnTop: true,
      mousePassthrough: false,
      locked: false
    },
    system: {
      onboardingVersion: 1,
      interactionsPaused: false,
      logging: { enabled: false, level: "silent" }
    },
    animations: manifest.animations,
    triggerRules: manifest.triggerRules,
    interactions: {
      clickMessages: [],
      randomMessages: [],
      timedMessages: [],
      bubble: { maxWidth: 220, durationMs: 1000, showCloseButton: false }
    }
  });
  recordRunnerStage(runRealPath, "package-activated");
  return Object.freeze({ directories, snapshotPath, manifest, behavior });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function recordRunnerStage(runRoot, stage) {
  const selectedStage = requiredString(stage, "Electron interaction runner stage", 128);
  fs.appendFileSync(
    path.join(runRoot, "runner-stages.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), stage: selectedStage })}\n`,
    { encoding: "utf8", flag: "a" }
  );
}

async function waitFor(callback, { timeoutMs, intervalMs = 50, message }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(lastError ? `${message}: ${lastError.message}` : message);
}

function configureElectronIsolation(app, session, directories, runtimeFaults) {
  app.setPath("userData", directories.userData);
  app.setPath("sessionData", directories.sessionData);
  app.setPath("temp", directories.temp);
  app.setPath("crashDumps", directories.crashDumps);
  app.on("render-process-gone", (_event, _contents, details) => {
    runtimeFaults.push({ type: "render-process-gone", reason: String(details?.reason || "unknown") });
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler?.(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, targetUrl) => {
      let protocol = "invalid:";
      try { protocol = new URL(targetUrl).protocol; } catch { /* invalid remains denied */ }
      if (protocol !== "file:") {
        runtimeFaults.push({ type: "navigation-blocked", protocol });
        event.preventDefault();
      }
    });
    contents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame) runtimeFaults.push({ type: "load-failed", code: Number(errorCode) || 0 });
    });
  });
  return app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      let protocol = "invalid:";
      try { protocol = new URL(details.url).protocol; } catch { /* invalid remains denied */ }
      const blocked = ["http:", "https:", "ws:", "wss:"].includes(protocol);
      if (blocked) runtimeFaults.push({ type: "network-blocked", protocol });
      callback({ cancel: blocked });
    });
  });
}

async function installRuntimeTrace(webContents) {
  await webContents.executeJavaScript(`(() => {
    if (window.__petpackInteractionVerifier) return true;
    const trace = [];
    let lastKey = "";
    const capture = () => {
      const state = typeof window.__getPetRuntimeState === "function" ? window.__getPetRuntimeState() : null;
      if (!state || !state.currentState) return;
      const entry = {
        at: Date.now(),
        animation: String(state.currentState.animation || ""),
        animationState: String(state.currentState.animationState || ""),
        idleStartedAt: Number(state.timers && state.timers.idleStartedAt) || 0,
        hoverStartedAt: Number(state.timers && state.timers.hoverStartedAt) || 0
      };
      const key = entry.animation + "|" + entry.animationState + "|" + entry.idleStartedAt + "|" + entry.hoverStartedAt;
      if (key !== lastKey) {
        lastKey = key;
        trace.push(entry);
        if (trace.length > 2048) trace.shift();
      }
    };
    const timer = window.setInterval(capture, 20);
    Object.defineProperty(window, "__petpackInteractionVerifier", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({ trace, capture, timer })
    });
    capture();
    return true;
  })()`, true);
}

async function readRuntime(webContents) {
  return webContents.executeJavaScript(
    `typeof window.__getPetRuntimeState === "function" ? window.__getPetRuntimeState() : null`,
    true
  );
}

async function readTrace(webContents) {
  return webContents.executeJavaScript(
    `window.__petpackInteractionVerifier ? window.__petpackInteractionVerifier.trace.slice() : []`,
    true
  );
}

async function waitForAnimation(webContents, animationId, { afterAt = 0, timeoutMs = 5000 } = {}) {
  return waitFor(async () => {
    const trace = await readTrace(webContents);
    return trace.find((entry) => entry.at >= afterAt && entry.animation === animationId) || null;
  }, { timeoutMs, intervalMs: 40, message: `Timed out waiting for animation ${animationId}` });
}

async function waitForCurrentAnimation(webContents, animationId, timeoutMs) {
  return waitFor(async () => {
    const state = await readRuntime(webContents);
    return state?.currentState?.animation === animationId ? state : null;
  }, { timeoutMs, intervalMs: 40, message: `Timed out waiting for current animation ${animationId}` });
}

async function getSpritePoints(webContents) {
  return webContents.executeJavaScript(`(() => {
    const element = document.querySelector("#pet-sprite");
    if (!element) return [];
    const rect = element.getBoundingClientRect();
    const fractions = [[.5,.5],[.5,.68],[.38,.62],[.62,.62],[.5,.8],[.35,.78],[.65,.78],[.42,.45],[.58,.45]];
    return fractions.map(([fx, fy]) => ({
      x: Math.max(1, Math.min(window.innerWidth - 2, Math.round(rect.left + rect.width * fx))),
      y: Math.max(1, Math.min(window.innerHeight - 2, Math.round(rect.top + rect.height * fy)))
    }));
  })()`, true);
}

async function sampleClientPoints(webContents, points) {
  const normalized = points.slice(0, 4096).map((point) => ({
    x: Math.round(Number(point.x)),
    y: Math.round(Number(point.y))
  }));
  const samples = await webContents.executeJavaScript(
    `typeof window.__samplePetPixelsForVerification === "function" ` +
      `? window.__samplePetPixelsForVerification(${JSON.stringify(normalized)}) : []`,
    true
  );
  return normalized.map((point, index) => ({
    ...point,
    status: samples[index]?.status || "unavailable",
    alpha: Number.isFinite(Number(samples[index]?.alpha)) ? Number(samples[index].alpha) : null
  }));
}

async function getClientOpaquePoints(webContents) {
  const points = await webContents.executeJavaScript(`(() => {
    const element = document.querySelector("#pet-sprite");
    if (!element) return [];
    const rect = element.getBoundingClientRect();
    const points = [];
    for (let y = Math.ceil(rect.top) + 4; y < Math.floor(rect.bottom) - 4; y += 6) {
      for (let x = Math.ceil(rect.left) + 4; x < Math.floor(rect.right) - 4; x += 6) {
        points.push({ x, y });
      }
    }
    return points;
  })()`, true);
  return (await sampleClientPoints(webContents, points))
    .filter((sample) => sample.status === "mapped" && sample.alpha !== null && sample.alpha >= 24)
    .sort((left, right) => right.alpha - left.alpha);
}

async function findStableClientOpaquePoint(webContents, { sampleCount = 12, intervalMs = 200 } = {}) {
  const initial = (await getClientOpaquePoints(webContents)).slice(0, 256);
  if (initial.length === 0) return null;
  const candidates = initial.map((sample) => ({ ...sample, minimumAlpha: sample.alpha }));
  for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
    await delay(intervalMs);
    const next = await sampleClientPoints(webContents, candidates);
    for (let index = 0; index < candidates.length; index += 1) {
      const alpha = next[index].status === "mapped" && next[index].alpha !== null ? next[index].alpha : 0;
      candidates[index].minimumAlpha = Math.min(candidates[index].minimumAlpha, alpha);
    }
  }
  const stable = candidates
    .filter((candidate) => candidate.minimumAlpha >= 24)
    .sort((left, right) => right.minimumAlpha - left.minimumAlpha);
  return stable[0] ? { x: stable[0].x, y: stable[0].y } : null;
}

function sendMouseMove(petWindow, point, verificationCursor) {
  // Electron's sendInputEvent does not receive the OS-level mouse forwarding
  // that a real cursor gets while a transparent BrowserWindow is ignoring
  // mouse events. Temporarily make the window receptive before injecting the
  // native event; the renderer's normal pixel hit-test immediately decides
  // whether passthrough should be enabled again.
  petWindow.setIgnoreMouseEvents(false, { forward: true });
  const cursor = verificationCursor.set(petWindow, point);
  petWindow.webContents.sendInputEvent({
    type: "mouseMove",
    x: point.x,
    y: point.y,
    globalX: cursor.x,
    globalY: cursor.y,
    movementX: 0,
    movementY: 0
  });
}

function sendClick(petWindow, point, button, clickCount, verificationCursor) {
  petWindow.setIgnoreMouseEvents(false, { forward: true });
  const cursor = verificationCursor.set(petWindow, point);
  const common = {
    x: point.x,
    y: point.y,
    globalX: cursor.x,
    globalY: cursor.y,
    button,
    clickCount
  };
  petWindow.webContents.sendInputEvent({ type: "mouseDown", ...common });
  petWindow.webContents.sendInputEvent({ type: "mouseUp", ...common });
}

async function findOpaqueInteractionPoint(
  petWindow,
  verificationCursor,
  { requireHover = true, check = "singleClickSneeze" } = {}
) {
  const webContents = petWindow.webContents;
  const outside = { x: 2, y: 2 };
  const sampledPoints = (await getClientOpaquePoints(webContents)).slice(0, 32);
  const fallbackSamples = (await sampleClientPoints(webContents, await getSpritePoints(webContents)))
    .filter((sample) => sample.status === "mapped" && sample.alpha !== null && sample.alpha >= 24);
  const points = [...sampledPoints, ...fallbackSamples].filter(Boolean);
  if (!requireHover && points[0]) return points[0];
  for (const point of points) {
    sendMouseMove(petWindow, outside, verificationCursor);
    await delay(80);
    sendMouseMove(petWindow, point, verificationCursor);
    const active = await waitFor(async () => {
      const state = await readRuntime(webContents);
      return Number(state?.timers?.hoverStartedAt) > 0 ? state : null;
    }, { timeoutMs: 700, intervalMs: 35, message: "Opaque point probe did not activate hover" }).catch(() => null);
    if (active) return point;
  }
  throw new InteractionCheckError(check, "No opaque PetPack interaction point was found");
}

async function triggerStableHover(petWindow, animationId, hoverDelayMs, verificationCursor, hoverCooldownMs = 0) {
  const webContents = petWindow.webContents;
  const outside = { x: 2, y: 2 };
  sendMouseMove(petWindow, outside, verificationCursor);
  await delay(100);
  // Earlier checks leave the cursor resting on the pet while their animations
  // play out, which is a real hover and legitimately starts the hover rule's
  // cooldown. Probing inside that window would fail against a pet that is
  // behaving correctly, so wait the declared cooldown out before measuring.
  const cooldownMs = Number(hoverCooldownMs) || 0;
  if (cooldownMs > 0) {
    const priorTrace = await readTrace(webContents);
    const lastHoverAt = priorTrace.reduce(
      (latest, entry) => (entry.animation === animationId && entry.at > latest ? entry.at : latest),
      0
    );
    const remainingMs = lastHoverAt ? cooldownMs - (Date.now() - lastHoverAt) : 0;
    if (remainingMs > 0) await delay(Math.min(remainingMs + 250, cooldownMs + 250));
  }
  const stablePoint = await findStableClientOpaquePoint(webContents);
  const points = [stablePoint, ...(await getSpritePoints(webContents))].filter(Boolean);
  for (const point of points) {
    sendMouseMove(petWindow, outside, verificationCursor);
    await delay(100);
    sendMouseMove(petWindow, point, verificationCursor);
    const hoverStartedAt = await waitFor(async () => {
      const state = await readRuntime(webContents);
      return Number(state?.timers?.hoverStartedAt) > 0 ? Number(state.timers.hoverStartedAt) : 0;
    }, { timeoutMs: 700, intervalMs: 35, message: "Stable hover candidate was transparent" }).catch(() => 0);
    if (!hoverStartedAt) continue;
    const entry = await waitForAnimation(webContents, animationId, {
      afterAt: hoverStartedAt,
      timeoutMs: hoverDelayMs + 1800
    }).catch(() => null);
    if (entry) return { point, hoverStartedAt, entry };
  }
  throw new InteractionCheckError(
    "hoverTwoSecondsOnceWithCooldown",
    "No visible pet pixel remained opaque for the required two-second hover"
  );
}

function assertCheck(condition, check, message) {
  if (!condition) throw new InteractionCheckError(check, message);
}

async function inspectNoProps(webContents) {
  return webContents.executeJavaScript(`(() => {
    const root = document.querySelector("#pet-root");
    const childIds = root ? Array.from(root.children).map((child) => child.id) : [];
    return {
      childIds,
      messageHidden: document.querySelector("#message-bubble")?.hidden === true,
      pomodoroHidden: document.querySelector("#pomodoro-overlay")?.hidden === true,
      propCount: document.querySelectorAll("[data-prop], .pet-prop, .prop").length
    };
  })()`, true);
}

async function runInteractionChecks({ app, petWindow, panelWindow, behavior, runtimeFaults, checks, verificationCursor }) {
  const webContents = petWindow.webContents;
  const initialBounds = petWindow.getBounds();
  const actions = behavior.actions;
  await installRuntimeTrace(webContents);

  const startup = await waitForAnimation(webContents, actions.stretch.id, { timeoutMs: 7000 });
  await waitForCurrentAnimation(webContents, actions.idle.id, actions.stretch.durationMs + 5000);
  checks.startupStretchThenIdle = true;

  petWindow.show();
  petWindow.focus();
  await delay(150);
  const point = await findOpaqueInteractionPoint(petWindow, verificationCursor);
  const singleStartedAt = Date.now();
  sendClick(petWindow, point, "left", 1, verificationCursor);
  await waitForAnimation(webContents, actions.sneeze.id, { afterAt: singleStartedAt, timeoutMs: 2500 });
  await waitForCurrentAnimation(webContents, actions.idle.id, actions.sneeze.durationMs + 4000);
  checks.singleClickSneeze = true;

  const doubleStartedAt = Date.now();
  sendClick(petWindow, point, "left", 1, verificationCursor);
  await delay(60);
  sendClick(petWindow, point, "left", 2, verificationCursor);
  const rollEntry = await waitForAnimation(webContents, actions.roll.id, { afterAt: doubleStartedAt, timeoutMs: 2500 });
  const doubleTrace = await readTrace(webContents);
  assertCheck(
    !doubleTrace.some((entry) => entry.at >= doubleStartedAt && entry.at <= rollEntry.at && entry.animation === actions.sneeze.id),
    "doubleClickRollWithoutSneeze",
    "Double click also triggered the single-click sneeze"
  );
  await waitForCurrentAnimation(webContents, actions.idle.id, actions.roll.durationMs + 4000);
  checks.doubleClickRollWithoutSneeze = true;

  const outside = { x: 2, y: 2 };
  const stableHover = await triggerStableHover(
    petWindow,
    actions["hover-attention"].id,
    behavior.timing.hoverDelayMs,
    verificationCursor,
    behavior.timing.hoverCooldownMs
  );
  const hoverBaseline = stableHover.hoverStartedAt;
  const hoverEntry = stableHover.entry;
  assertCheck(
    hoverEntry.at - hoverBaseline >= behavior.timing.hoverDelayMs,
    "hoverTwoSecondsOnceWithCooldown",
    "Hover action fired before the two-second threshold"
  );
  await waitForCurrentAnimation(
    webContents,
    actions.idle.id,
    actions["hover-attention"].durationMs + 4000
  );
  // Leave and re-enter the pet so a fresh hover session begins: the cooldown,
  // not the session, is what must keep the action from firing again.
  sendMouseMove(petWindow, outside, verificationCursor);
  await delay(150);
  sendMouseMove(petWindow, stableHover.point, verificationCursor);
  await delay(behavior.timing.hoverDelayMs + 700);
  const hoverTrace = await readTrace(webContents);
  const hoverStarts = hoverTrace.filter(
    (entry) => entry.at >= hoverEntry.at && entry.animation === actions["hover-attention"].id
  );
  assertCheck(
    hoverStarts.length === 1,
    "hoverTwoSecondsOnceWithCooldown",
    `Hover action repeated inside its ${behavior.timing.hoverCooldownMs}ms cooldown`
  );
  checks.hoverTwoSecondsOnceWithCooldown = true;

  sendMouseMove(petWindow, outside, verificationCursor);
  const idleBaseline = await waitFor(async () => {
    const state = await readRuntime(webContents);
    return Number(state?.timers?.hoverStartedAt) === 0 && Number(state?.timers?.idleStartedAt) > 0
      ? Number(state.timers.idleStartedAt)
      : 0;
  }, { timeoutMs: 1500, intervalMs: 35, message: "Idle session did not reset after pointer leave" });
  const transitionEntry = await waitForAnimation(webContents, actions["sleep-transition"].id, {
    afterAt: idleBaseline,
    timeoutMs: behavior.timing.idleTimeoutMs + 5000
  });
  const idleElapsed = transitionEntry.at - transitionEntry.idleStartedAt;
  assertCheck(
    transitionEntry.idleStartedAt === idleBaseline && idleElapsed >= behavior.timing.idleTimeoutMs && idleElapsed < 25000,
    "idleTwentyTwoSecondsThenSleepLoop",
    `Sleep transition timing was outside the accepted window: ${idleElapsed}`
  );
  const loopEntry = await waitForAnimation(webContents, actions["sleep-loop"].id, {
    afterAt: transitionEntry.at,
    timeoutMs: actions["sleep-transition"].durationMs + 4000
  });
  const sleepTrace = await readTrace(webContents);
  assertCheck(
    !sleepTrace.some((entry) => entry.at > transitionEntry.at && entry.at < loopEntry.at && entry.animation === actions.idle.id),
    "idleTwentyTwoSecondsThenSleepLoop",
    "Sleep transition returned to idle before the sleep loop"
  );
  await waitForCurrentAnimation(webContents, actions["sleep-loop"].id, 1500);
  checks.idleTwentyTwoSecondsThenSleepLoop = true;

  const wakePoint = await findOpaqueInteractionPoint(petWindow, verificationCursor, {
    requireHover: false,
    check: "rightClickStretchAndWake"
  });
  const rightStartedAt = Date.now();
  sendClick(petWindow, wakePoint, "right", 1, verificationCursor);
  await waitForAnimation(webContents, actions.stretch.id, { afterAt: rightStartedAt, timeoutMs: 2500 });
  await waitForCurrentAnimation(webContents, actions.idle.id, actions.stretch.durationMs + 4000);
  checks.rightClickStretchAndWake = true;

  const finalBounds = petWindow.getBounds();
  const props = await inspectNoProps(webContents);
  const expectedChildren = ["message-bubble", "pomodoro-overlay", "pet-sprite"];
  assertCheck(
    JSON.stringify(finalBounds) === JSON.stringify(initialBounds) &&
      JSON.stringify(props.childIds) === JSON.stringify(expectedChildren) &&
      props.messageHidden && props.pomodoroHidden && props.propCount === 0 &&
      !panelWindow?.isVisible?.() && runtimeFaults.length === 0,
    "noMovementOrProps",
    "PetPack moved the window, displayed props, opened UI, or caused a runtime fault"
  );
  checks.noMovementOrProps = true;

  // Keep the startup timestamp live so an optimizer cannot remove the observed
  // startup phase as an unused wait.
  assertCheck(startup.at > 0, "startupStretchThenIdle", "Startup evidence timestamp is invalid");
  return Object.freeze(checks);
}

function makeResult(request, checks) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    packageId: request.packageId,
    packageSha256: request.packageSha256,
    packageByteSize: request.packageByteSize,
    ok: REQUIRED_CHECKS.every((name) => checks[name] === true),
    checks: Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, checks[name] === true]))
  };
}

function writeResultAndExit(app, result, exitCode) {
  const output = Buffer.from(JSON.stringify(result), "utf8");
  process.stdout.write(output, () => app.exit(exitCode));
}

function writeFailureAndExit(app, error) {
  const diagnostic = `${error?.name || "Error"}: ${error?.message || "Electron interaction runner failed"}`
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1024);
  process.stderr.write(Buffer.from(diagnostic, "utf8"), () => app.exit(1));
}

async function main() {
  let request;
  let app;
  try {
    const configuration = parseRunnerArguments();
    const client = checksumPinnedClientTree(configuration.clientRoot);
    if (client.sha256 !== configuration.expectedClientTreeSha256) {
      throw new Error("Pinned Desktop Pet client tree checksum is invalid");
    }
    const input = fs.readFileSync(0, "utf8");
    if (!input.trim() || input.trim().split(/[\r\n]+/).length !== 1 || Buffer.byteLength(input) > 1024 * 1024) {
      throw new Error("Electron interaction runner requires exactly one bounded JSON request");
    }
    request = normalizeRunnerRequest(JSON.parse(input));
    const directories = createRuntimeDirectories(request);
    recordRunnerStage(directories.runRoot, "requiring-electron");
    const electron = require("electron");
    app = electron.app;
    recordRunnerStage(directories.runRoot, "electron-required");
    const runtimeFaults = [];
    const isolationReady = configureElectronIsolation(app, electron.session, directories, runtimeFaults);
    recordRunnerStage(directories.runRoot, "electron-isolation-configured");
    const prepared = await prepareIsolatedClient({ clientRoot: client.root, request, directories });
    await isolationReady;
    recordRunnerStage(prepared.directories.runRoot, "electron-ready");
    const verificationCursor = createVerificationCursor(electron.screen);
    installVerificationCursorTracker(client.root, verificationCursor);
    recordRunnerStage(prepared.directories.runRoot, "verification-cursor-isolated");
    process.chdir(client.root);
    require(path.join(client.root, "src", "main", "main.js"));
    recordRunnerStage(prepared.directories.runRoot, "client-main-required");
    const windowsModule = require(path.join(client.root, "src", "main", "windows.js"));
    const petWindow = await waitFor(() => {
      const candidate = windowsModule.getWindows().pet;
      return candidate && !candidate.isDestroyed() && !candidate.webContents.isLoadingMainFrame() ? candidate : null;
    }, { timeoutMs: 15000, intervalMs: 50, message: "Pinned Desktop Pet window did not become ready" });
    recordRunnerStage(prepared.directories.runRoot, "pet-window-ready");
    const panelWindow = windowsModule.getWindows().panel;
    await waitFor(async () => {
      const state = await readRuntime(petWindow.webContents);
      return state?.currentState?.animation ? state : null;
    }, { timeoutMs: 10000, intervalMs: 40, message: "Pinned Desktop Pet runtime did not become ready" });
    const checks = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, false]));
    try {
      await runInteractionChecks({
        app,
        petWindow,
        panelWindow,
        behavior: prepared.behavior,
        runtimeFaults,
        checks,
        verificationCursor
      });
    } catch (error) {
      if (!(error instanceof InteractionCheckError)) throw error;
      recordRunnerStage(prepared.directories.runRoot, `interaction-failed-${error.check}`);
      process.stderr.write(`${error.check}: ${error.message}`.replace(/[\r\n]+/g, " ").slice(0, 1024));
      writeResultAndExit(app, makeResult(request, checks), 0);
      return;
    }
    writeResultAndExit(app, makeResult(request, checks), 0);
  } catch (error) {
    if (app) {
      writeFailureAndExit(app, error);
    } else {
      const diagnostic = `${error?.name || "Error"}: ${error?.message || "Electron interaction runner failed"}`
        .replace(/[\r\n]+/g, " ")
        .slice(0, 1024);
      process.stderr.write(diagnostic, () => process.exit(1));
    }
  }
}

if (require.main === module || (process.versions?.electron && process.type === "browser")) {
  main();
}

module.exports = {
  ACTION_KEY_BY_ID,
  MAX_PACKAGE_BYTES,
  PROTOCOL_VERSION,
  REQUIRED_ACTION_IDS,
  REQUIRED_CHECKS,
  checksumPinnedClientTree,
  createVerificationCursor,
  getBehaviorContract,
  installVerificationCursorTracker,
  normalizeRunnerRequest,
  parseRunnerArguments
};
