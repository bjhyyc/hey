const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function requireLocalFile(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("Worker-local media path is required");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error("Worker-local media file is not available for trusted probing");
  }
  return filePath;
}

function checksumFile(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    let position = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function runFfprobe({ filePath, ffprobePath = "ffprobe", spawnImpl = spawn, timeoutMs = 60 * 1000 } = {}) {
  const target = requireLocalFile(filePath);
  if (typeof spawnImpl !== "function") throw new Error("A process spawn implementation is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 10 * 60 * 1000) {
    throw new Error("ffprobe timeout must be between 1 second and 10 minutes");
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl(ffprobePath, [
      "-v", "error",
      "-show_format",
      "-show_streams",
      "-of", "json",
      target
    ], { shell: false, windowsHide: true });
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
      finish(reject, new Error("ffprobe exceeded its execution timeout"));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      if (stdout.length + text.length > 4 * 1024 * 1024) {
        child.kill?.("SIGKILL");
        finish(reject, new Error("ffprobe output exceeded its inspection limit"));
        return;
      }
      stdout += text;
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - stderr.length);
    });
    child.once("error", (error) => finish(reject, new Error(`ffprobe could not start: ${error.message}`)));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(reject, new Error(`ffprobe failed with exit code ${code}: ${stderr.slice(0, 512)}`));
        return;
      }
      try {
        finish(resolve, JSON.parse(stdout));
      } catch {
        finish(reject, new Error("ffprobe returned invalid JSON"));
      }
    });
  });
}

function createTrustedFileProbe({ ffprobePath, spawnImpl } = {}) {
  return async ({ localPath }) => {
    const filePath = requireLocalFile(localPath);
    return {
      probe: await runFfprobe({ filePath, ffprobePath, spawnImpl }),
      checksumSha256: checksumFile(filePath)
    };
  };
}

module.exports = {
  checksumFile,
  createTrustedFileProbe,
  runFfprobe
};
