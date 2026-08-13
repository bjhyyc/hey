const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { SUPPORTED_ASSET_EXTENSIONS } = require("../../shared/schema");
const { isSafeRelativePath } = require("../../shared/path-safety");

const VIDEO_ASSET_EXTENSIONS = [".webm", ".mp4", ".mov"];

let cachedFfmpegPath;
let didResolveFfmpeg = false;

function findFfmpegPath() {
  if (didResolveFfmpeg) return cachedFfmpegPath;
  didResolveFfmpeg = true;

  let bundledFfmpegPath = "";
  try {
    bundledFfmpegPath = require("ffmpeg-static") || "";
    if (bundledFfmpegPath.includes("app.asar")) {
      bundledFfmpegPath = bundledFfmpegPath.replace("app.asar", "app.asar.unpacked");
    }
  } catch (_error) {}

  const candidates = [
    process.env.DESKTOP_PET_FFMPEG_PATH,
    process.env.FFMPEG_PATH,
    bundledFfmpegPath,
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-version"], { stdio: "ignore" });
      cachedFfmpegPath = candidate;
      return cachedFfmpegPath;
    } catch (_error) {}
  }

  cachedFfmpegPath = "";
  return cachedFfmpegPath;
}

function parseDurationMs(text) {
  const match = String(text || "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return 0;
  return Math.round(((hours * 60 * 60) + (minutes * 60) + seconds) * 1000);
}

function parseProgressLine(line) {
  const [key, value] = String(line || "").trim().split("=");
  return key ? { key, value } : null;
}

function parseVideoCodecName(output) {
  const match = String(output || "").match(
    /Stream\s+#\d+:\d+(?:\([^)]+\))?:\s+Video:\s*([^,\s]+)/i
  );
  return match ? String(match[1]).toLowerCase() : "";
}

function getVideoCodecName(sourcePath, ffmpegPath = findFfmpegPath()) {
  if (!ffmpegPath || typeof sourcePath !== "string" || !sourcePath) return "";

  try {
    execFileSync(ffmpegPath, ["-hide_banner", "-i", sourcePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`;
    return parseVideoCodecName(output);
  }

  return "";
}

function emitProgress(onProgress, payload) {
  if (typeof onProgress === "function") {
    onProgress(payload);
  }
}

function getMovTranscodeArgs(sourcePath, outputPath, { progress = false, inputCodec = "" } = {}) {
  const args = [
    "-y",
    "-hide_banner"
  ];

  if (String(inputCodec).toLowerCase() === "vp9") {
    args.push("-c:v", "libvpx-vp9");
  }

  args.push(
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-auto-alt-ref",
    "0",
    "-metadata:s:v:0",
    "alpha_mode=1",
    "-g",
    "1",
    "-keyint_min",
    "1",
    "-lag-in-frames",
    "0",
    "-row-mt",
    "1",
    "-b:v",
    "0",
    "-crf",
    "30"
  );
  if (progress) {
    args.push("-nostats", "-progress", "pipe:1");
  } else {
    args.splice(2, 0, "-loglevel", "error");
  }
  args.push(outputPath);
  return args;
}

function clampUnitValue(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function normalizeHexColor(color) {
  const raw = String(color || "").trim();
  const match = raw.match(/^#?([0-9a-fA-F]{6})$/);
  return match ? match[1].toLowerCase() : "00ff00";
}

/**
 * Build ffmpeg args that key out a solid color and bake the transparency into a
 * VP9 webm with an all-keyframe layout (so keyframe animations can scrub each
 * frame instantly without any runtime per-pixel chroma keying).
 *
 * @param {string} sourcePath - Input video path
 * @param {string} outputPath - Output webm path
 * @param {object} options
 * @param {string} options.color - Key color as "#RRGGBB"
 * @param {number} options.tolerance - Color match tolerance 0..1 (ffmpeg colorkey similarity)
 * @param {number} options.softness - Edge feathering 0..1 (ffmpeg colorkey blend)
 * @param {boolean} options.progress - Emit -progress pipe when true
 */
function getColorkeyTranscodeArgs(sourcePath, outputPath, { color, tolerance, softness, progress = false } = {}) {
  const hex = normalizeHexColor(color);
  const similarity = clampUnitValue(tolerance, 0.22);
  const blend = clampUnitValue(softness, 0.08);
  const filter = `colorkey=0x${hex}:${similarity}:${blend},format=yuva420p`;

  const args = [
    "-y",
    "-hide_banner",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    filter,
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-auto-alt-ref",
    "0",
    "-metadata:s:v:0",
    "alpha_mode=1",
    "-g",
    "1",
    "-keyint_min",
    "1",
    "-lag-in-frames",
    "0",
    "-row-mt",
    "1",
    "-b:v",
    "0",
    "-crf",
    "28"
  ];
  if (progress) {
    args.push("-nostats", "-progress", "pipe:1");
  } else {
    args.splice(2, 0, "-loglevel", "error");
  }
  args.push(outputPath);
  return args;
}

function transcodeMovToWebm(sourcePath, targetPath, ffmpegPath = findFfmpegPath()) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg is unavailable for MOV conversion");
  }

  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}.webm`;
  try {
    const inputCodec = getVideoCodecName(sourcePath, ffmpegPath);
    execFileSync(ffmpegPath, getMovTranscodeArgs(sourcePath, tempPath, { inputCodec }), { stdio: "pipe" });
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_cleanupError) {}
    throw error;
  }
}

function transcodeMovToWebmAsync(sourcePath, targetPath, { onProgress, ffmpegPath = findFfmpegPath() } = {}) {
  if (!ffmpegPath) {
    return Promise.reject(new Error("ffmpeg is unavailable for MOV conversion"));
  }

  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}.webm`;
  emitProgress(onProgress, { stage: "converting", percent: 0 });

  return new Promise((resolve, reject) => {
    const inputCodec = getVideoCodecName(sourcePath, ffmpegPath);
    let stderr = "";
    let stdoutBuffer = "";
    let durationMs = 0;
    let lastPercent = -1;
    const child = spawn(ffmpegPath, getMovTranscodeArgs(sourcePath, tempPath, { progress: true, inputCodec }), {
      windowsHide: true
    });

    const finish = (error) => {
      try {
        if (error && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_cleanupError) {}
      if (error) {
        reject(error);
        return;
      }
      try {
        fs.renameSync(tempPath, targetPath);
        emitProgress(onProgress, { stage: "converting", percent: 100 });
        resolve();
      } catch (renameError) {
        reject(renameError);
      }
    };

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!durationMs) durationMs = parseDurationMs(text);
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach((line) => {
        const parsed = parseProgressLine(line);
        if (!parsed) return;
        if (parsed.key === "out_time_ms" && durationMs > 0) {
          const outTimeMs = Number(parsed.value) / 1000;
          if (!Number.isFinite(outTimeMs)) return;
          const percent = Math.min(99, Math.max(0, Math.round((outTimeMs / durationMs) * 100)));
          if (percent !== lastPercent) {
            lastPercent = percent;
            emitProgress(onProgress, { stage: "converting", percent });
          }
        }
        if (parsed.key === "progress" && parsed.value === "end") {
          emitProgress(onProgress, { stage: "converting", percent: 100 });
        }
      });
    });

    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ");
      finish(new Error(`MOV conversion failed${detail ? `: ${detail}` : ""}`));
    });
  });
}

function getMovTranscoder(customTranscoder) {
  if (typeof customTranscoder === "function") return customTranscoder;
  return findFfmpegPath()
    ? (sourcePath, targetPath) => transcodeMovToWebm(sourcePath, targetPath)
    : null;
}

/**
 * Bake a green-screen video into a transparent VP9 webm using the given key
 * parameters. Runs ffmpeg with the colorkey filter, streams progress, and
 * atomically renames the temp output into place. Mirrors
 * transcodeMovToWebmAsync's spawn/progress/cleanup lifecycle.
 *
 * @param {string} sourcePath - Absolute path to the source video
 * @param {string} targetPath - Absolute path for the baked webm
 * @param {object} options
 * @param {string} options.color - Key color "#RRGGBB"
 * @param {number} options.tolerance - 0..1
 * @param {number} options.softness - 0..1
 * @param {function} [options.onProgress] - progress callback
 * @param {string} [options.ffmpegPath]
 */
function bakeGreenScreenToWebmAsync(sourcePath, targetPath, { color, tolerance, softness, onProgress, ffmpegPath = findFfmpegPath() } = {}) {
  if (!ffmpegPath) {
    return Promise.reject(new Error("ffmpeg is unavailable for green screen baking"));
  }

  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}.webm`;
  emitProgress(onProgress, { stage: "baking", percent: 0 });

  return new Promise((resolve, reject) => {
    let stderr = "";
    let stdoutBuffer = "";
    let durationMs = 0;
    let lastPercent = -1;
    const child = spawn(
      ffmpegPath,
      getColorkeyTranscodeArgs(sourcePath, tempPath, { color, tolerance, softness, progress: true }),
      { windowsHide: true }
    );

    const finish = (error) => {
      try {
        if (error && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_cleanupError) {}
      if (error) {
        reject(error);
        return;
      }
      try {
        fs.renameSync(tempPath, targetPath);
        emitProgress(onProgress, { stage: "baking", percent: 100 });
        resolve();
      } catch (renameError) {
        reject(renameError);
      }
    };

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!durationMs) durationMs = parseDurationMs(text);
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach((line) => {
        const parsed = parseProgressLine(line);
        if (!parsed) return;
        if (parsed.key === "out_time_ms" && durationMs > 0) {
          const outTimeMs = Number(parsed.value) / 1000;
          if (!Number.isFinite(outTimeMs)) return;
          const percent = Math.min(99, Math.max(0, Math.round((outTimeMs / durationMs) * 100)));
          if (percent !== lastPercent) {
            lastPercent = percent;
            emitProgress(onProgress, { stage: "baking", percent });
          }
        }
        if (parsed.key === "progress" && parsed.value === "end") {
          emitProgress(onProgress, { stage: "baking", percent: 100 });
        }
      });
    });

    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ");
      finish(new Error(`Green screen baking failed${detail ? `: ${detail}` : ""}`));
    });
  });
}

function getGifColorTableSize(packedByte) {
  return (packedByte & 0x80) ? 3 * (2 ** ((packedByte & 0x07) + 1)) : 0;
}

function skipGifSubBlocks(buffer, offset) {
  let nextOffset = offset;
  while (nextOffset < buffer.length) {
    const blockSize = buffer[nextOffset];
    nextOffset += 1;
    if (blockSize === 0) return nextOffset;
    nextOffset += blockSize;
  }
  return buffer.length;
}

function getGifDurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 14) return null;
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;

  let offset = 13 + getGifColorTableSize(buffer[10]);
  let pendingDelayMs = 0;
  let totalDurationMs = 0;
  let frameCount = 0;

  while (offset < buffer.length) {
    const blockType = buffer[offset];

    if (blockType === 0x3b) break;

    if (blockType === 0x21) {
      const label = buffer[offset + 1];
      if (label === 0xf9 && buffer[offset + 2] === 0x04 && offset + 7 < buffer.length) {
        pendingDelayMs = buffer.readUInt16LE(offset + 4) * 10;
        offset += 8;
        continue;
      }
      offset = skipGifSubBlocks(buffer, offset + 2);
      continue;
    }

    if (blockType === 0x2c) {
      if (offset + 9 >= buffer.length) break;
      const localColorTableSize = getGifColorTableSize(buffer[offset + 9]);
      offset += 10 + localColorTableSize;
      if (offset >= buffer.length) break;
      offset += 1; // LZW minimum code size
      offset = skipGifSubBlocks(buffer, offset);
      totalDurationMs += pendingDelayMs;
      pendingDelayMs = 0;
      frameCount += 1;
      continue;
    }

    break;
  }

  return frameCount > 0 && totalDurationMs > 0 ? totalDurationMs : null;
}

function getAssetDurationMs(filePath, ext = path.extname(filePath).toLowerCase()) {
  if (ext !== ".gif") return null;
  try {
    return getGifDurationMs(fs.readFileSync(filePath));
  } catch (_error) {
    return null;
  }
}

function validateAsset(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return { ok: false, error: "Asset path is required" };
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_ASSET_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `Unsupported asset extension: ${ext || "(none)"}` };
  }

  let linkStats;
  let stats;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    linkStats = fs.lstatSync(filePath);
    if (linkStats.isSymbolicLink()) {
      return { ok: false, error: "Asset path cannot be a symbolic link" };
    }
    stats = fs.statSync(filePath);
  } catch (_error) {
    return { ok: false, error: "Asset file is not readable" };
  }

  if (!stats.isFile()) {
    return { ok: false, error: "Asset path is not a file" };
  }

  return { ok: true, ext, size: stats.size };
}

function getSafeFilename(sourcePath, importName = "", targetExt = path.extname(sourcePath).toLowerCase()) {
  const sourceExt = path.extname(sourcePath).toLowerCase();
  const rawName = typeof importName === "string" && importName.trim()
    ? importName.trim()
    : path.basename(sourcePath);
  const parsedExt = path.extname(rawName).toLowerCase();
  const filename = targetExt !== sourceExt && parsedExt
    ? `${path.basename(rawName, parsedExt)}${targetExt}`
    : (parsedExt ? rawName : `${rawName}${targetExt}`);
  return filename
    .normalize("NFKC")
    .replace(/[\\/]/g, "_")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "") || `asset${targetExt}`;
}

function getAssetCandidate(filename, counter) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  return counter === 0 ? filename : `${base}-${counter}${ext}`;
}

function copyAssetToPackage({ sourcePath, packageDir, importName = "", movTranscoder } = {}) {
  const validation = validateAsset(sourcePath);
  if (!validation.ok) {
    return validation;
  }

  if (typeof packageDir !== "string" || packageDir.trim() === "") {
    return { ok: false, error: "Package directory is required" };
  }

  const assetsDir = path.join(packageDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const movConverter = validation.ext === ".mov" ? getMovTranscoder(movTranscoder) : null;
  const targetExt = movConverter ? ".webm" : validation.ext;
  const safeFilename = getSafeFilename(sourcePath, importName, targetExt);
  let counter = 0;

  while (counter < 1000) {
    const filename = getAssetCandidate(safeFilename, counter);
    const absolutePath = path.join(assetsDir, filename);

    if (importName && counter === 0 && fs.existsSync(absolutePath)) {
      return { ok: false, error: `Asset name already exists: ${filename}` };
    }

    try {
      if (movConverter) {
        movConverter(sourcePath, absolutePath);
      } else {
        fs.copyFileSync(sourcePath, absolutePath, fs.constants.COPYFILE_EXCL);
      }
      return {
        ok: true,
        asset: `assets/${filename}`,
        ...(movConverter ? { convertedFrom: ".mov" } : {}),
        ...(importName ? { displayName: filename } : {})
      };
    } catch (error) {
      if (error && error.code === "EEXIST") {
        counter += 1;
        continue;
      }

      throw error;
    }
  }

  return { ok: false, error: "Could not find an available asset filename" };
}

async function copyAssetToPackageWithProgress({ sourcePath, packageDir, importName = "", onProgress } = {}) {
  const validation = validateAsset(sourcePath);
  if (!validation.ok) {
    return validation;
  }

  if (typeof packageDir !== "string" || packageDir.trim() === "") {
    return { ok: false, error: "Package directory is required" };
  }

  const assetsDir = path.join(packageDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const shouldConvertMov = validation.ext === ".mov" && Boolean(findFfmpegPath());
  if (validation.ext === ".mov" && !shouldConvertMov) {
    return { ok: false, error: "MOV assets must be converted to WebM, but ffmpeg is unavailable" };
  }
  const targetExt = shouldConvertMov ? ".webm" : validation.ext;
  const safeFilename = getSafeFilename(sourcePath, importName, targetExt);
  let counter = 0;

  while (counter < 1000) {
    const filename = getAssetCandidate(safeFilename, counter);
    const absolutePath = path.join(assetsDir, filename);

    if (importName && counter === 0 && fs.existsSync(absolutePath)) {
      return { ok: false, error: `Asset name already exists: ${filename}` };
    }

    if (fs.existsSync(absolutePath)) {
      counter += 1;
      continue;
    }

    try {
      if (shouldConvertMov) {
        await transcodeMovToWebmAsync(sourcePath, absolutePath, { onProgress });
      } else {
        emitProgress(onProgress, { stage: "copying", percent: 0 });
        fs.copyFileSync(sourcePath, absolutePath, fs.constants.COPYFILE_EXCL);
        emitProgress(onProgress, { stage: "copying", percent: 100 });
      }
      return {
        ok: true,
        asset: `assets/${filename}`,
        ...(shouldConvertMov ? { convertedFrom: ".mov" } : {}),
        ...(importName ? { displayName: filename } : {})
      };
    } catch (error) {
      if (error && error.code === "EEXIST") {
        counter += 1;
        continue;
      }

      throw error;
    }
  }

  return { ok: false, error: "Could not find an available asset filename" };
}

function resolveSafePackageAsset(packageDir, assetPath) {
  if (typeof packageDir !== "string" || packageDir.trim() === "") {
    return { ok: false, error: "Package directory is required" };
  }

  if (!isSafeRelativePath(assetPath) || !assetPath.startsWith("assets/")) {
    return { ok: false, error: "Asset path is unsafe" };
  }

  const ext = path.extname(assetPath).toLowerCase();
  if (!SUPPORTED_ASSET_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `Unsupported asset extension: ${ext || "(none)"}` };
  }

  const packageRoot = path.resolve(packageDir);
  const absolutePath = path.resolve(packageRoot, assetPath);
  const relative = path.relative(packageRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: "Asset path is unsafe" };
  }

  return { ok: true, absolutePath, ext };
}

function deleteAssetFromPackage({ packageDir, assetPath }) {
  const target = resolveSafePackageAsset(packageDir, assetPath);
  if (!target.ok) return target;

  const absolutePath = target.absolutePath;

  if (!fs.existsSync(absolutePath)) {
    return { ok: false, error: "Asset file does not exist" };
  }

  const stats = fs.lstatSync(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { ok: false, error: "Asset path is not a file" };
  }

  fs.unlinkSync(absolutePath);
  return { ok: true, asset: assetPath };
}

function replaceAssetInPackage({ packageDir, sourcePath, targetAssetPath, movTranscoder } = {}) {
  const validation = validateAsset(sourcePath);
  if (!validation.ok) return validation;

  const target = resolveSafePackageAsset(packageDir, targetAssetPath);
  if (!target.ok) return target;

  const movConverter = validation.ext === ".mov" && target.ext === ".webm"
    ? getMovTranscoder(movTranscoder)
    : null;

  if (validation.ext !== target.ext && !movConverter) {
    return { ok: false, error: "Replacement file extension must match the selected asset" };
  }

  const targetPath = target.absolutePath;
  if (!fs.existsSync(targetPath)) {
    return { ok: false, error: "Target asset file does not exist" };
  }

  const targetStats = fs.lstatSync(targetPath);
  if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
    return { ok: false, error: "Target asset path is not a file" };
  }

  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (movConverter) {
      movConverter(sourcePath, tempPath);
    } else {
      fs.copyFileSync(sourcePath, tempPath);
    }
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_cleanupError) {}
    throw error;
  }

  return { ok: true, asset: targetAssetPath, ...(movConverter ? { convertedFrom: ".mov" } : {}) };
}

async function replaceAssetInPackageWithProgress({ packageDir, sourcePath, targetAssetPath, onProgress } = {}) {
  const validation = validateAsset(sourcePath);
  if (!validation.ok) return validation;

  const target = resolveSafePackageAsset(packageDir, targetAssetPath);
  if (!target.ok) return target;

  const shouldConvertMov = validation.ext === ".mov" && target.ext === ".webm" && Boolean(findFfmpegPath());

  if (validation.ext === ".mov" && !shouldConvertMov) {
    return { ok: false, error: "MOV assets must be converted to WebM, but ffmpeg is unavailable" };
  }

  if (validation.ext !== target.ext && !shouldConvertMov) {
    return { ok: false, error: "Replacement file extension must match the selected asset" };
  }

  const targetPath = target.absolutePath;
  if (!fs.existsSync(targetPath)) {
    return { ok: false, error: "Target asset file does not exist" };
  }

  const targetStats = fs.lstatSync(targetPath);
  if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
    return { ok: false, error: "Target asset path is not a file" };
  }

  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (shouldConvertMov) {
      await transcodeMovToWebmAsync(sourcePath, tempPath, { onProgress });
    } else {
      emitProgress(onProgress, { stage: "copying", percent: 0 });
      fs.copyFileSync(sourcePath, tempPath);
      emitProgress(onProgress, { stage: "copying", percent: 100 });
    }
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_cleanupError) {}
    throw error;
  }

  return { ok: true, asset: targetAssetPath, ...(shouldConvertMov ? { convertedFrom: ".mov" } : {}) };
}

/**
 * Bake a green-screen source asset in a package into a transparent webm sibling.
 * Resolves a safe target path (`assets/{name}.webm`, de-duplicated on collision),
 * runs the colorkey transcode, and returns the new asset's package-relative path.
 *
 * @param {object} params
 * @param {string} params.packageDir - Absolute package directory
 * @param {string} params.sourceAssetPath - Package-relative source ("assets/foo.mp4")
 * @param {string} params.color - Key color "#RRGGBB"
 * @param {number} params.tolerance - 0..1
 * @param {number} params.softness - 0..1
 * @param {function} [params.onProgress]
 */
async function bakeGreenScreenInPackage({ packageDir, sourceAssetPath, color, tolerance, softness, onProgress } = {}) {
  if (!findFfmpegPath()) {
    return { ok: false, error: "ffmpeg is unavailable for green screen baking" };
  }

  const source = resolveSafePackageAsset(packageDir, sourceAssetPath);
  if (!source.ok) return source;
  if (!VIDEO_ASSET_EXTENSIONS.includes(source.ext)) {
    return { ok: false, error: "Green screen baking requires a video source" };
  }
  if (!fs.existsSync(source.absolutePath)) {
    return { ok: false, error: "Source asset file does not exist" };
  }

  const baseName = path.basename(sourceAssetPath, path.extname(sourceAssetPath));
  let targetAssetPath = `assets/${baseName}.webm`;
  let target = resolveSafePackageAsset(packageDir, targetAssetPath);
  if (!target.ok) return target;
  // Avoid overwriting an existing sibling (including the source itself if it is
  // already a .webm) by suffixing until we find a free name.
  let suffix = 1;
  while (fs.existsSync(target.absolutePath)) {
    targetAssetPath = `assets/${baseName}-transparent${suffix > 1 ? `-${suffix}` : ""}.webm`;
    target = resolveSafePackageAsset(packageDir, targetAssetPath);
    if (!target.ok) return target;
    suffix += 1;
  }

  try {
    await bakeGreenScreenToWebmAsync(source.absolutePath, target.absolutePath, {
      color,
      tolerance,
      softness,
      onProgress
    });
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }

  return { ok: true, asset: targetAssetPath };
}

module.exports = {
  copyAssetToPackage,
  copyAssetToPackageWithProgress,
  deleteAssetFromPackage,
  replaceAssetInPackage,
  replaceAssetInPackageWithProgress,
  transcodeMovToWebm,
  transcodeMovToWebmAsync,
  bakeGreenScreenToWebmAsync,
  bakeGreenScreenInPackage,
  getAssetDurationMs,
  getGifDurationMs,
  validateAsset,
  findFfmpegPath,
  _internals: {
    getMovTranscodeArgs,
    getColorkeyTranscodeArgs,
    parseVideoCodecName,
    getVideoCodecName
  }
};
