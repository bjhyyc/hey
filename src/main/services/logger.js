const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "silent"];
const LEVEL_WEIGHTS = new Map(LOG_LEVELS.map((level, index) => [level, index]));
const DEFAULT_LEVEL = "info";
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_LOG_FILES = 10;

const state = {
  userDataDir: "",
  enabled: true,
  level: DEFAULT_LEVEL,
  mirrorToConsole: process.env.NODE_ENV !== "test" && process.env.VITEST !== "true",
  // When true, suppress ALL console output including warn/error (for test environments)
  silenceConsole: process.env.VITEST === "true",
  dirEnsured: false,
  stream: null,
  streamPath: ""
};

function normalizeLevel(level, fallback = DEFAULT_LEVEL) {
  return LEVEL_WEIGHTS.has(level) ? level : fallback;
}

function getLogsDir() {
  const baseDir = state.userDataDir || process.cwd();
  return path.join(baseDir, "logs");
}

function padNumber(value, length = 2) {
  return String(value).padStart(length, "0");
}

function formatLocalDate(date = new Date()) {
  return [
    date.getFullYear(),
    padNumber(date.getMonth() + 1),
    padNumber(date.getDate())
  ].join("-");
}

function formatTimezoneOffset(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${padNumber(hours)}:${padNumber(minutes)}`;
}

function formatLocalTimestamp(date = new Date()) {
  return `${formatLocalDate(date)}T${[
    padNumber(date.getHours()),
    padNumber(date.getMinutes()),
    padNumber(date.getSeconds())
  ].join(":")}.${padNumber(date.getMilliseconds(), 3)}${formatTimezoneOffset(date)}`;
}

function getLogFileName(date = new Date()) {
  return `desktop-pet-${formatLocalDate(date)}.log`;
}

function getCurrentLogPath() {
  return path.join(getLogsDir(), getLogFileName());
}

function shouldLog(level) {
  if (!state.enabled) return false;
  const normalized = normalizeLevel(level);
  return LEVEL_WEIGHTS.get(normalized) >= LEVEL_WEIGHTS.get(state.level) &&
    state.level !== "silent";
}

function formatArg(arg) {
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`;
  }

  if (typeof arg === "string") return arg;

  return util.inspect(arg, {
    depth: 5,
    breakLength: 120,
    compact: true
  });
}

function formatLine(entry) {
  const parts = [
    entry.timestamp,
    entry.level.toUpperCase().padEnd(5),
    `[${entry.scope}]`,
    ...entry.args.map(formatArg)
  ];
  return `${parts.join(" ")}\n`;
}

// --- WriteStream management ---

function ensureLogsDir() {
  if (state.dirEnsured) return;
  try {
    fs.mkdirSync(getLogsDir(), { recursive: true });
    state.dirEnsured = true;
  } catch (error) {
    if (state.mirrorToConsole && !state.silenceConsole) {
      console.warn("Failed to create logs directory", error);
    }
  }
}

function getOrCreateStream() {
  const targetPath = getCurrentLogPath();

  // Reuse existing stream if path matches
  if (state.stream && state.streamPath === targetPath) {
    return state.stream;
  }

  // Date rolled over or first call — close old stream and open new one
  if (state.stream) {
    try { state.stream.end(); } catch (_error) { /* ignore */ }
  }

  ensureLogsDir();

  try {
    const stream = fs.createWriteStream(targetPath, { flags: "a", encoding: "utf8" });
    stream.on("error", (error) => {
      if (state.mirrorToConsole && !state.silenceConsole) {
        console.warn("Log stream error", error);
      }
      // Invalidate so next write retries
      state.stream = null;
      state.streamPath = "";
    });
    state.stream = stream;
    state.streamPath = targetPath;
    return stream;
  } catch (error) {
    if (state.mirrorToConsole && !state.silenceConsole) {
      console.warn("Failed to create log stream", error);
    }
    return null;
  }
}

function writeLine(line) {
  const stream = getOrCreateStream();
  if (stream) {
    stream.write(line);
  }
}

function shutdownLogger() {
  if (state.stream) {
    try { state.stream.end(); } catch (_error) { /* ignore */ }
    state.stream = null;
    state.streamPath = "";
  }
}

// --- Console mirror ---

function mirrorToConsole(level, scope, args) {
  // Test environments: suppress all console output
  if (state.silenceConsole) return;

  // Production: warn/error always visible; others only if mirrorToConsole is on
  if (!state.mirrorToConsole && level !== "warn" && level !== "error") return;

  const consoleMethod = level === "trace" || level === "debug"
    ? "debug"
    : (level === "warn" || level === "error" ? level : "log");
  const writer = typeof console[consoleMethod] === "function" ? console[consoleMethod] : console.log;
  writer.call(console, ...args);
}

// --- Log rotation ---

function isSafeLogFileName(fileName) {
  return typeof fileName === "string" &&
    /^desktop-pet-\d{4}-\d{2}-\d{2}\.log$/.test(fileName);
}

function pruneOldLogs(maxFiles = DEFAULT_MAX_LOG_FILES) {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) return;

  try {
    const files = fs.readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSafeLogFileName(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    // Keep the newest maxFiles, delete the rest
    for (let i = maxFiles; i < files.length; i++) {
      fs.rmSync(path.join(logsDir, files[i]), { force: true });
    }
  } catch (_error) {
    // Non-critical: best-effort cleanup
  }
}

// --- Configuration ---

function configureLogger(options = {}) {
  if (typeof options.userDataDir === "string" && options.userDataDir) {
    if (state.userDataDir !== options.userDataDir) {
      state.dirEnsured = false;
      // Close existing stream since directory changed
      shutdownLogger();
    }
    state.userDataDir = options.userDataDir;
  }
  if (Object.prototype.hasOwnProperty.call(options, "enabled")) {
    state.enabled = Boolean(options.enabled);
  }
  if (Object.prototype.hasOwnProperty.call(options, "level")) {
    state.level = normalizeLevel(options.level);
  }
  if (Object.prototype.hasOwnProperty.call(options, "mirrorToConsole")) {
    state.mirrorToConsole = Boolean(options.mirrorToConsole);
  }
  if (Object.prototype.hasOwnProperty.call(options, "silenceConsole")) {
    state.silenceConsole = Boolean(options.silenceConsole);
  }

  // Ensure directory and prune old logs on configure (typically at boot)
  ensureLogsDir();
  pruneOldLogs();

  return getLoggerSettings();
}

function getLoggerSettings() {
  return {
    enabled: state.enabled,
    level: state.level,
    levels: LOG_LEVELS.filter((level) => level !== "silent"),
    logsDir: getLogsDir(),
    currentLogPath: getCurrentLogPath()
  };
}

function setLogLevel(level) {
  state.level = normalizeLevel(level, state.level);
  return getLoggerSettings();
}

// --- Core logging ---

function log(scope, level, ...args) {
  const normalizedLevel = normalizeLevel(level);
  if (!shouldLog(normalizedLevel)) return;

  const entry = {
    timestamp: formatLocalTimestamp(),
    level: normalizedLevel,
    scope: scope || "app",
    args
  };
  writeLine(formatLine(entry));
  mirrorToConsole(normalizedLevel, entry.scope, args);
}

function createLogger(scope) {
  return {
    trace: (...args) => log(scope, "trace", ...args),
    debug: (...args) => log(scope, "debug", ...args),
    info: (...args) => log(scope, "info", ...args),
    warn: (...args) => log(scope, "warn", ...args),
    error: (...args) => log(scope, "error", ...args)
  };
}

// --- Throttled logger for high-frequency events ---

function createThrottledLogger(scope, intervalMs = 500) {
  const inner = createLogger(scope);

  function makeThrottled(fn) {
    let lastCallTime = 0;
    let timeoutId = null;
    let lastArgs = null;

    return function throttled(...args) {
      const now = Date.now();
      lastArgs = args;

      if (now - lastCallTime >= intervalMs) {
        lastCallTime = now;
        fn(...args);
        return;
      }

      if (!timeoutId) {
        timeoutId = setTimeout(() => {
          lastCallTime = Date.now();
          timeoutId = null;
          if (lastArgs) fn(...lastArgs);
        }, intervalMs - (now - lastCallTime));
      }
    };
  }

  return {
    trace: makeThrottled(inner.trace),
    debug: makeThrottled(inner.debug),
    info: makeThrottled(inner.info),
    // warn/error are never throttled — they are always important
    warn: inner.warn,
    error: inner.error
  };
}

// --- File management ---

function listLogFiles() {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) {
    return { ok: true, files: [], logsDir };
  }

  const files = fs.readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSafeLogFileName(entry.name))
    .map((entry) => {
      const filePath = path.join(logsDir, entry.name);
      const stats = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString()
      };
    })
    .sort((left, right) => right.name.localeCompare(left.name));

  return { ok: true, files, logsDir };
}

function readLogFile(fileName, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const selectedName = fileName || getLogFileName();
  if (!isSafeLogFileName(selectedName)) {
    return { ok: false, error: "Invalid log file name" };
  }

  const filePath = path.join(getLogsDir(), selectedName);
  if (!fs.existsSync(filePath)) {
    return { ok: true, fileName: selectedName, content: "", truncated: false };
  }

  const stats = fs.statSync(filePath);
  const bytesToRead = Math.min(stats.size, Math.max(1, Math.min(Number(maxBytes) || DEFAULT_MAX_BYTES, 1024 * 1024)));
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, bytesToRead, stats.size - bytesToRead);
  } finally {
    fs.closeSync(fd);
  }

  return {
    ok: true,
    fileName: selectedName,
    path: filePath,
    content: buffer.toString("utf8"),
    truncated: stats.size > bytesToRead,
    size: stats.size
  };
}

function clearLogs() {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) {
    return { ok: true, deleted: 0 };
  }

  // Close the current stream before deleting files
  shutdownLogger();

  let deleted = 0;
  for (const entry of fs.readdirSync(logsDir, { withFileTypes: true })) {
    if (entry.isFile() && isSafeLogFileName(entry.name)) {
      fs.rmSync(path.join(logsDir, entry.name), { force: true });
      deleted += 1;
    }
  }
  return { ok: true, deleted };
}

module.exports = {
  LOG_LEVELS,
  configureLogger,
  createLogger,
  createThrottledLogger,
  getLoggerSettings,
  listLogFiles,
  readLogFile,
  clearLogs,
  setLogLevel,
  shutdownLogger,
  // Exported for testing
  _internals: {
    state,
    shouldLog,
    formatLocalDate,
    formatLocalTimestamp,
    formatLine,
    isSafeLogFileName,
    pruneOldLogs,
    ensureLogsDir
  }
};
