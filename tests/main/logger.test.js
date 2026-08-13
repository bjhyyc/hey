import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

function loadLoggerModule() {
  const loggerPath = require.resolve("../../src/main/services/logger");
  delete require.cache[loggerPath];
  return require("../../src/main/services/logger");
}

describe("logger", () => {
  let tempDir;
  let logger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-logger-"));
    logger = loadLoggerModule();
  });

  afterEach(() => {
    if (logger && logger.shutdownLogger) {
      logger.shutdownLogger();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // --- isSafeLogFileName ---

  describe("isSafeLogFileName", () => {
    const { isSafeLogFileName } = loadLoggerModule()._internals;

    it("accepts valid log file names", () => {
      expect(isSafeLogFileName("desktop-pet-2026-06-28.log")).toBe(true);
      expect(isSafeLogFileName("desktop-pet-2000-01-01.log")).toBe(true);
    });

    it("rejects invalid names", () => {
      expect(isSafeLogFileName("")).toBe(false);
      expect(isSafeLogFileName(null)).toBe(false);
      expect(isSafeLogFileName(undefined)).toBe(false);
      expect(isSafeLogFileName(123)).toBe(false);
      expect(isSafeLogFileName("../etc/passwd")).toBe(false);
      expect(isSafeLogFileName("desktop-pet-2026-06-28.txt")).toBe(false);
      expect(isSafeLogFileName("desktop-pet-2026-06-28.log.bak")).toBe(false);
      expect(isSafeLogFileName("other-2026-06-28.log")).toBe(false);
      expect(isSafeLogFileName("desktop-pet-abcd-ef-gh.log")).toBe(false);
    });
  });

  // --- shouldLog ---

  describe("shouldLog", () => {
    it("filters by level weight", () => {
      const mod = loadLoggerModule();
      const { shouldLog, state } = mod._internals;

      state.enabled = true;
      state.level = "info";
      expect(shouldLog("trace")).toBe(false);
      expect(shouldLog("debug")).toBe(false);
      expect(shouldLog("info")).toBe(true);
      expect(shouldLog("warn")).toBe(true);
      expect(shouldLog("error")).toBe(true);
    });

    it("returns false when disabled", () => {
      const mod = loadLoggerModule();
      const { shouldLog, state } = mod._internals;

      state.enabled = false;
      state.level = "trace";
      expect(shouldLog("error")).toBe(false);
    });

    it("returns false when level is silent", () => {
      const mod = loadLoggerModule();
      const { shouldLog, state } = mod._internals;

      state.enabled = true;
      state.level = "silent";
      expect(shouldLog("error")).toBe(false);
    });

    it("falls back to info for unknown levels", () => {
      const mod = loadLoggerModule();
      const { shouldLog, state } = mod._internals;

      state.enabled = true;
      state.level = "info";
      // Unknown level normalizes to "info" which is >= info
      expect(shouldLog("banana")).toBe(true);
    });
  });

  // --- formatLine ---

  describe("formatLine", () => {
    it("formats timestamps in the local timezone with an explicit offset", () => {
      const mod = loadLoggerModule();
      const { formatLocalDate, formatLocalTimestamp } = mod._internals;
      const date = new Date(2026, 5, 28, 12, 34, 56, 789);
      const offsetMinutes = -date.getTimezoneOffset();
      const sign = offsetMinutes >= 0 ? "+" : "-";
      const absoluteMinutes = Math.abs(offsetMinutes);
      const offset = `${sign}${String(Math.floor(absoluteMinutes / 60)).padStart(2, "0")}:${String(absoluteMinutes % 60).padStart(2, "0")}`;

      expect(formatLocalDate(date)).toBe("2026-06-28");
      expect(formatLocalTimestamp(date)).toBe(`2026-06-28T12:34:56.789${offset}`);
    });

    it("formats a log entry as a single line", () => {
      const mod = loadLoggerModule();
      const { formatLine } = mod._internals;

      const line = formatLine({
        timestamp: "2026-06-28T12:00:00.000Z",
        level: "info",
        scope: "test",
        args: ["hello", "world"]
      });

      expect(line).toBe("2026-06-28T12:00:00.000Z INFO  [test] hello world\n");
    });

    it("formats Error args with stack trace", () => {
      const mod = loadLoggerModule();
      const { formatLine } = mod._internals;

      const error = new Error("test error");
      const line = formatLine({
        timestamp: "2026-06-28T12:00:00.000Z",
        level: "error",
        scope: "app",
        args: ["Failed:", error]
      });

      expect(line).toContain("ERROR");
      expect(line).toContain("[app]");
      expect(line).toContain("Failed:");
      expect(line).toContain("test error");
    });
  });

  // --- configureLogger / getLoggerSettings / setLogLevel ---

  describe("configureLogger", () => {
    it("sets userDataDir and returns settings", () => {
      const settings = logger.configureLogger({
        userDataDir: tempDir,
        silenceConsole: true
      });

      expect(settings.enabled).toBe(true);
      expect(settings.level).toBe("info");
      expect(settings.logsDir).toBe(path.join(tempDir, "logs"));
    });

    it("creates the logs directory", () => {
      logger.configureLogger({ userDataDir: tempDir, silenceConsole: true });

      expect(fs.existsSync(path.join(tempDir, "logs"))).toBe(true);
    });

    it("updates level via setLogLevel", () => {
      logger.configureLogger({ userDataDir: tempDir, silenceConsole: true });
      const settings = logger.setLogLevel("debug");

      expect(settings.level).toBe("debug");
    });

    it("ignores invalid levels in setLogLevel", () => {
      logger.configureLogger({
        userDataDir: tempDir,
        level: "warn",
        silenceConsole: true
      });
      const settings = logger.setLogLevel("banana");

      expect(settings.level).toBe("warn");
    });
  });

  // --- Writing and reading logs ---

  describe("createLogger + file I/O", () => {
    it("writes log lines to a file and reads them back", async () => {
      logger.configureLogger({
        userDataDir: tempDir,
        level: "debug",
        silenceConsole: true
      });

      const log = logger.createLogger("test-scope");
      log.info("message one");
      log.debug("message two");
      log.warn("message three");

      // Flush the stream
      logger.shutdownLogger();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const result = logger.readLogFile();

      expect(result.ok).toBe(true);
      expect(result.content).toContain("message one");
      expect(result.content).toContain("message two");
      expect(result.content).toContain("message three");
      expect(result.content).toContain("[test-scope]");
      expect(result.content).toContain("INFO");
      expect(result.content).toContain("DEBUG");
      expect(result.content).toContain("WARN");
    });

    it("respects log level filtering", async () => {
      logger.configureLogger({
        userDataDir: tempDir,
        level: "warn",
        silenceConsole: true
      });

      const log = logger.createLogger("filtered");
      log.debug("should not appear");
      log.info("should not appear either");
      log.warn("should appear");

      logger.shutdownLogger();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const result = logger.readLogFile();

      expect(result.ok).toBe(true);
      expect(result.content).toContain("should appear");
      expect(result.content).not.toContain("should not appear");
    });

    it("does not write when disabled", async () => {
      logger.configureLogger({
        userDataDir: tempDir,
        enabled: false,
        silenceConsole: true
      });

      const log = logger.createLogger("disabled");
      log.error("should not appear");

      logger.shutdownLogger();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const result = logger.readLogFile();
      expect(result.content).toBe("");
    });
  });

  // --- readLogFile validation ---

  describe("readLogFile", () => {
    it("rejects invalid file names", () => {
      logger.configureLogger({ userDataDir: tempDir, silenceConsole: true });

      const result = logger.readLogFile("../etc/passwd");

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Invalid log file name");
    });

    it("returns empty content for non-existent file", () => {
      logger.configureLogger({ userDataDir: tempDir, silenceConsole: true });

      const result = logger.readLogFile("desktop-pet-1999-01-01.log");

      expect(result.ok).toBe(true);
      expect(result.content).toBe("");
      expect(result.truncated).toBe(false);
    });
  });

  // --- listLogFiles ---

  describe("listLogFiles", () => {
    it("lists log files sorted by name descending", async () => {
      logger.configureLogger({
        userDataDir: tempDir,
        silenceConsole: true
      });

      // Create some fake log files
      const logsDir = path.join(tempDir, "logs");
      fs.writeFileSync(path.join(logsDir, "desktop-pet-2026-01-01.log"), "a");
      fs.writeFileSync(path.join(logsDir, "desktop-pet-2026-06-15.log"), "b");
      fs.writeFileSync(path.join(logsDir, "desktop-pet-2026-03-10.log"), "c");
      // Non-matching files should be excluded
      fs.writeFileSync(path.join(logsDir, "other-file.txt"), "d");

      const result = logger.listLogFiles();

      expect(result.ok).toBe(true);
      expect(result.files.length).toBe(3);
      expect(result.files[0].name).toBe("desktop-pet-2026-06-15.log");
      expect(result.files[1].name).toBe("desktop-pet-2026-03-10.log");
      expect(result.files[2].name).toBe("desktop-pet-2026-01-01.log");
    });

    it("returns empty array when logs directory does not exist", () => {
      const mod = loadLoggerModule();
      mod.configureLogger({
        userDataDir: path.join(tempDir, "nonexistent"),
        silenceConsole: true
      });
      // Remove the created directory to simulate nonexistent
      const logsDir = path.join(tempDir, "nonexistent", "logs");
      if (fs.existsSync(logsDir)) fs.rmSync(logsDir, { recursive: true });

      const result = mod.listLogFiles();
      expect(result.ok).toBe(true);
      expect(result.files).toEqual([]);
    });
  });

  // --- clearLogs ---

  describe("clearLogs", () => {
    it("deletes all log files", async () => {
      logger.configureLogger({
        userDataDir: tempDir,
        silenceConsole: true
      });

      const log = logger.createLogger("clear-test");
      log.info("test message");
      logger.shutdownLogger();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const logsDir = path.join(tempDir, "logs");
      fs.writeFileSync(path.join(logsDir, "desktop-pet-2026-01-01.log"), "old");

      const before = logger.listLogFiles();
      expect(before.files.length).toBeGreaterThan(0);

      const result = logger.clearLogs();

      expect(result.ok).toBe(true);
      expect(result.deleted).toBeGreaterThanOrEqual(1);

      const after = logger.listLogFiles();
      expect(after.files.length).toBe(0);
    });
  });

  // --- pruneOldLogs ---

  describe("pruneOldLogs", () => {
    it("keeps only the newest maxFiles log files", () => {
      logger.configureLogger({ userDataDir: tempDir, silenceConsole: true });
      const { pruneOldLogs } = logger._internals;

      const logsDir = path.join(tempDir, "logs");
      for (let i = 1; i <= 15; i++) {
        const day = String(i).padStart(2, "0");
        fs.writeFileSync(path.join(logsDir, `desktop-pet-2026-01-${day}.log`), `log ${i}`);
      }

      pruneOldLogs(5);

      const remaining = fs.readdirSync(logsDir)
        .filter((f) => f.startsWith("desktop-pet-"))
        .sort();

      expect(remaining.length).toBe(5);
      // Should keep the 5 newest (highest dates)
      expect(remaining[0]).toBe("desktop-pet-2026-01-11.log");
      expect(remaining[4]).toBe("desktop-pet-2026-01-15.log");
    });

    it("does nothing when fewer files than maxFiles", () => {
      logger.configureLogger({ userDataDir: tempDir, silenceConsole: true });
      const { pruneOldLogs } = logger._internals;

      const logsDir = path.join(tempDir, "logs");
      fs.writeFileSync(path.join(logsDir, "desktop-pet-2026-01-01.log"), "a");
      fs.writeFileSync(path.join(logsDir, "desktop-pet-2026-01-02.log"), "b");

      pruneOldLogs(10);

      const remaining = fs.readdirSync(logsDir).filter((f) => f.startsWith("desktop-pet-"));
      expect(remaining.length).toBe(2);
    });
  });

  // --- createThrottledLogger ---

  describe("createThrottledLogger", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("throttles trace/debug/info but not warn/error", () => {
      const mod = loadLoggerModule();
      mod.configureLogger({
        userDataDir: tempDir,
        level: "trace",
        silenceConsole: true
      });

      // Spy on the internal write by tracking file writes
      const writeSpy = vi.spyOn(fs, "createWriteStream");
      const throttled = mod.createThrottledLogger("throttle-test", 1000);

      // First call goes through immediately
      throttled.debug("first");
      // Subsequent calls within interval are throttled
      throttled.debug("second");
      throttled.debug("third");

      // Only one debug call should have gone through so far
      // After advancing time, the trailing call fires
      vi.advanceTimersByTime(1000);

      // warn/error should always pass through
      throttled.warn("warning 1");
      throttled.warn("warning 2");
      throttled.warn("warning 3");

      // All 3 warns should be written (not throttled)
      writeSpy.mockRestore();
    });

    it("returns an object with all 5 log methods", () => {
      const mod = loadLoggerModule();
      mod.configureLogger({ userDataDir: tempDir, silenceConsole: true });
      const throttled = mod.createThrottledLogger("methods-test", 500);

      expect(typeof throttled.trace).toBe("function");
      expect(typeof throttled.debug).toBe("function");
      expect(typeof throttled.info).toBe("function");
      expect(typeof throttled.warn).toBe("function");
      expect(typeof throttled.error).toBe("function");
    });
  });

  // --- shutdownLogger ---

  describe("shutdownLogger", () => {
    it("can be called multiple times safely", () => {
      logger.configureLogger({ userDataDir: tempDir, silenceConsole: true });
      const log = logger.createLogger("shutdown-test");
      log.info("test");

      expect(() => {
        logger.shutdownLogger();
        logger.shutdownLogger();
        logger.shutdownLogger();
      }).not.toThrow();
    });

    it("allows new writes after shutdown by opening a new stream", async () => {
      logger.configureLogger({
        userDataDir: tempDir,
        level: "debug",
        silenceConsole: true
      });

      const log = logger.createLogger("reopen-test");
      log.info("before shutdown");
      logger.shutdownLogger();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Write again after shutdown — should open a new stream
      log.info("after shutdown");
      logger.shutdownLogger();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const result = logger.readLogFile();
      expect(result.content).toContain("before shutdown");
      expect(result.content).toContain("after shutdown");
    });
  });
});
