const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ffmpegStaticPath = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

const { REQUIRED_ACTION_IDS } = require("../domain/action-catalog");
const { createTrustedFileProbe } = require("../media/ffprobe-media-probe");
const { inspectPngFile } = require("../media/private-master-image-workspace");
const { buildPetpack, verifyPetpackArchive } = require("../petpack/build");
const { createDeterministicUuid } = require("../petpack/package-contract");
const { CHARACTER_CANVAS_V1 } = require("../qa/character-canvas-v1");
const { validateActionMediaProbe } = require("../qa/media-inspector");

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const CONTROLLED_REAL_CANARY_ROOT = path.join(PROJECT_ROOT, ".tmp", "controlled-real-canary");
const CONTROLLED_PROCESS_TEMP_ROOT = path.join(PROJECT_ROOT, ".tmp", "tests");
const CLASSIFICATION = "internal-controlled-real-test";
const MANUAL_QA_SCHEMA_VERSION = 1;
const REQUEST_SCHEMA_VERSION = 1;
const MASTER_KINDS = Object.freeze(["front", "side", "sleep"]);
const MASTER_INPUT_EXTENSIONS = Object.freeze([".png", ".jpg", ".jpeg", ".webp"]);
const MASTER_MIME_BY_CODEC = Object.freeze({
  png: "image/png",
  mjpeg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp"
});
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_PROCESS_STDERR_BYTES = 128 * 1024;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const RGB_FRAME_BYTES = CHARACTER_CANVAS_V1.width * CHARACTER_CANVAS_V1.height * 3;
const RGBA_FRAME_BYTES = CHARACTER_CANVAS_V1.width * CHARACTER_CANVAS_V1.height * 4;
const FINAL_ALPHA_KEY = Object.freeze({
  color: "#00FF00",
  ffmpegColor: "0x00ff00",
  similarity: 0.2,
  blend: 0.04,
  greenCorrection: 0.5,
  alphaInsetPixels: 1
});
const BACKGROUND_THRESHOLDS = Object.freeze({
  greenDistance: 56,
  minimumOverallGreenRatio: 0.15,
  minimumOuterGreenRatio: 0.97,
  maximumEdgeContactRatio: 0.005,
  maximumOuterNearBlackRatio: 0.02,
  edgeBandPx: 8,
  contactBandPx: 4,
  nearBlackMaximum: 18
});
const ALPHA_THRESHOLDS = Object.freeze({
  transparentMaximum: 8,
  foregroundMinimum: 9,
  spillAlphaMinimum: 32,
  spillGreenExcess: 16,
  minimumOverallTransparentRatio: 0.15,
  minimumOuterTransparentRatio: 0.97,
  maximumEdgeContactRatio: 0.005,
  maximumForegroundGreenSpillRatio: 0.02,
  edgeBandPx: 8,
  contactBandPx: 4
});

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw codedError(`${label} is required`, "canary_input_invalid");
  }
  return value.trim();
}

function assertDevelopmentOnly(environment = process.env) {
  const mode = typeof environment.PETPACK_PLATFORM_MODE === "string" && environment.PETPACK_PLATFORM_MODE.trim()
    ? environment.PETPACK_PLATFORM_MODE.trim()
    : "development";
  if (!new Set(["development", "test"]).has(mode)) {
    throw codedError("Controlled-real canary runner is forbidden outside development or test mode", "canary_production_forbidden");
  }
  return mode;
}

function isRejectedDrive(filePath) {
  return process.platform === "win32" && /^e:[\\/]/i.test(path.resolve(filePath));
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

async function ensureFixedDirectory(directoryPath, label) {
  await fsp.mkdir(directoryPath, { recursive: true });
  const stat = await fsp.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw codedError(`${label} must be a regular directory`, "canary_output_path_invalid");
  }
  const realPath = await fsp.realpath(directoryPath);
  if (!samePath(realPath, directoryPath) || isRejectedDrive(realPath)) {
    throw codedError(`${label} must not redirect outside its fixed local path`, "canary_output_path_invalid");
  }
  return realPath;
}

function assertNoUrl(value, label) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || ""))) {
    throw codedError(`${label} must be a worker-local file path`, "canary_network_input_forbidden");
  }
}

async function requireRegularLocalFile(value, label, { extensions } = {}) {
  assertNoUrl(value, label);
  const selected = requiredString(value, label, 4096);
  if (!path.isAbsolute(selected)) {
    throw codedError(`${label} must be an absolute local path`, "canary_input_path_invalid");
  }
  if (isRejectedDrive(selected)) {
    throw codedError(`${label} must not use the E drive`, "canary_e_drive_forbidden");
  }
  const stat = await fsp.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw codedError(`${label} must be a regular non-symbolic file`, "canary_input_not_regular");
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_MEDIA_BYTES) {
    throw codedError(`${label} has an invalid byte size`, "canary_input_size_invalid");
  }
  const realPath = await fsp.realpath(selected);
  if (isRejectedDrive(realPath)) {
    throw codedError(`${label} resolves to the E drive`, "canary_e_drive_forbidden");
  }
  if (Array.isArray(extensions) && !extensions.includes(path.extname(realPath).toLowerCase())) {
    throw codedError(`${label} has an unsupported extension`, "canary_input_extension_invalid");
  }
  return { path: realPath, byteSize: stat.size };
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

async function detectMasterImageMime(filePath) {
  const descriptor = await fsp.open(filePath, "r");
  try {
    const signature = Buffer.alloc(12);
    const { bytesRead } = await descriptor.read(signature, 0, signature.length, 0);
    if (bytesRead >= 8 && signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      return "image/png";
    }
    if (bytesRead >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) {
      return "image/jpeg";
    }
    if (bytesRead >= 12 && signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP") {
      return "image/webp";
    }
  } finally {
    await descriptor.close();
  }
  throw codedError("Master image has an unsupported file signature", "canary_master_source_invalid");
}

function safeChildPath(root, ...segments) {
  const target = path.resolve(root, ...segments);
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw codedError("Controlled-real canary path escaped its assigned root", "canary_output_path_invalid");
  }
  return target;
}

function normalizeRunId(value) {
  const runId = requiredString(value, "Controlled-real run ID", 96);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(runId)) {
    throw codedError("Controlled-real run ID is unsafe", "canary_run_id_invalid");
  }
  return runId;
}

function normalizeChroma(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("Canary chroma settings must be an object", "canary_input_invalid");
  }
  const color = typeof value.color === "string" && value.color.trim() ? value.color.trim().toUpperCase() : "#00FF00";
  if (!/^#[0-9A-F]{6}$/.test(color)) {
    throw codedError("Canary chroma color must be a six-digit hex color", "canary_chroma_invalid");
  }
  const similarity = value.similarity === undefined ? 0.1 : Number(value.similarity);
  const blend = value.blend === undefined ? 0.02 : Number(value.blend);
  if (!Number.isFinite(similarity) || similarity < 0.01 || similarity > 0.5 ||
      !Number.isFinite(blend) || blend < 0 || blend > 0.2) {
    throw codedError("Canary chroma similarity or blend is outside its bounded range", "canary_chroma_invalid");
  }
  return Object.freeze({
    color,
    ffmpegColor: `0x${color.slice(1).toLowerCase()}`,
    rgb: [
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16)
    ],
    similarity,
    blend
  });
}

async function readBoundedJson(filePath, label) {
  const file = await requireRegularLocalFile(filePath, label, { extensions: [".json"] });
  if (file.byteSize > MAX_JSON_BYTES) {
    throw codedError(`${label} exceeds its byte limit`, "canary_json_too_large");
  }
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(file.path, "utf8"));
  } catch {
    throw codedError(`${label} is not valid JSON`, "canary_json_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw codedError(`${label} must contain a JSON object`, "canary_json_invalid");
  }
  return { file, parsed };
}

function boundedDuration(value, actionId) {
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 1 || duration > 60) {
    throw codedError(`${actionId} expected duration must be an integer from 1 to 60 seconds`, "canary_duration_invalid");
  }
  return duration;
}

async function normalizeRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw codedError("Controlled-real request must be an object", "canary_input_invalid");
  }
  if (Number(request.schemaVersion) !== REQUEST_SCHEMA_VERSION) {
    throw codedError(`Controlled-real request schemaVersion must be ${REQUEST_SCHEMA_VERSION}`, "canary_schema_invalid");
  }
  const runId = normalizeRunId(request.runId);
  const packageName = requiredString(request.packageName, "Controlled-real package name", 200);
  const masters = {};
  for (const kind of MASTER_KINDS) {
    const descriptor = request.masters?.[kind];
    const artifactPath = descriptor && typeof descriptor === "object" && !Array.isArray(descriptor)
      ? (descriptor.path || descriptor.artifactPath)
      : descriptor;
    masters[kind] = await requireRegularLocalFile(artifactPath, `${kind} master image`, {
      extensions: MASTER_INPUT_EXTENSIONS
    });
  }
  const videos = {};
  for (const actionId of REQUIRED_ACTION_IDS) {
    const selected = request.videos?.[actionId];
    if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
      throw codedError(`${actionId} raw video descriptor is required`, "canary_input_invalid");
    }
    videos[actionId] = {
      ...(await requireRegularLocalFile(selected.path, `${actionId} raw video`)),
      expectedDuration: boundedDuration(selected.expectedDuration, actionId)
    };
  }
  const manualQa = await readBoundedJson(request.manualQaPath, "Controlled-real manual QA sidecar");
  const chroma = normalizeChroma(request.chroma);
  return { runId, packageName, masters, videos, manualQa, chroma };
}

function normalizeManualEntry(entry, label, sourceSha256) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw codedError(`${label} manual QA entry is required`, "canary_manual_qa_invalid");
  }
  const reviewerNote = requiredString(entry.reviewerNote, `${label} reviewerNote`, 2000);
  const boundDigest = requiredString(entry.sourceSha256, `${label} sourceSha256`, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(boundDigest) || boundDigest !== sourceSha256) {
    throw codedError(`${label} manual QA is not bound to the current source bytes`, "canary_manual_qa_stale");
  }
  if (entry.human !== true) {
    throw codedError(`${label} manual QA must explicitly set human=true`, "canary_manual_qa_invalid");
  }
  return Object.freeze({
    human: true,
    accepted: entry.accepted === true,
    reviewerNote,
    sourceSha256: boundDigest
  });
}

function validateManualQa(sidecar, sources) {
  if (Number(sidecar.schemaVersion) !== MANUAL_QA_SCHEMA_VERSION) {
    throw codedError(`Manual QA schemaVersion must be ${MANUAL_QA_SCHEMA_VERSION}`, "canary_manual_qa_invalid");
  }
  const masters = {};
  const videos = {};
  for (const kind of MASTER_KINDS) {
    masters[kind] = normalizeManualEntry(sidecar.masters?.[kind], `${kind} master`, sources.masters[kind].sha256);
  }
  for (const actionId of REQUIRED_ACTION_IDS) {
    videos[actionId] = normalizeManualEntry(sidecar.videos?.[actionId], `${actionId} video`, sources.videos[actionId].sha256);
  }
  const rejected = [
    ...MASTER_KINDS.filter((kind) => !masters[kind].accepted).map((kind) => `master:${kind}`),
    ...REQUIRED_ACTION_IDS.filter((actionId) => !videos[actionId].accepted).map((actionId) => `video:${actionId}`)
  ];
  return {
    source: "human-sidecar",
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    reviewedAt: typeof sidecar.reviewedAt === "string" ? sidecar.reviewedAt : null,
    masters,
    videos,
    allAccepted: rejected.length === 0,
    rejected
  };
}

async function collectSourceFacts(request) {
  const masters = {};
  const videos = {};
  for (const kind of MASTER_KINDS) {
    masters[kind] = { ...request.masters[kind], ...(await checksumFile(request.masters[kind].path)) };
  }
  for (const actionId of REQUIRED_ACTION_IDS) {
    videos[actionId] = { ...request.videos[actionId], ...(await checksumFile(request.videos[actionId].path)) };
  }
  return { masters, videos };
}

function resolveToolPath(explicitPath, fallbackPath, label) {
  const selected = typeof explicitPath === "string" && explicitPath.trim() ? explicitPath.trim() : fallbackPath;
  if (typeof selected !== "string" || !path.isAbsolute(selected) || isRejectedDrive(selected)) {
    throw codedError(`${label} must be an absolute executable path outside E drive`, "canary_tool_invalid");
  }
  const stat = fs.lstatSync(selected);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw codedError(`${label} must be a regular non-symbolic executable`, "canary_tool_invalid");
  }
  const realPath = fs.realpathSync(selected);
  if (isRejectedDrive(realPath)) {
    throw codedError(`${label} must not resolve to the E drive`, "canary_tool_invalid");
  }
  return realPath;
}

function runProcessCapture({ executable, args, cwd, environment, timeoutMs = 10 * 60 * 1000, stdoutLimit = 4 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    let stdoutBytes = 0;
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
      finish(reject, codedError("Controlled-real media process exceeded its timeout", "canary_process_timeout"));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) {
        child.kill?.("SIGKILL");
        finish(reject, codedError("Controlled-real media process output exceeded its limit", "canary_process_output_too_large"));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_PROCESS_STDERR_BYTES) {
        stderr += String(chunk).slice(0, MAX_PROCESS_STDERR_BYTES - stderr.length);
      }
    });
    child.once("error", () => finish(reject, codedError("Controlled-real media process could not start", "canary_process_start_failed")));
    child.once("close", (code) => {
      if (code !== 0) {
        const error = codedError(`Controlled-real media process failed with exit code ${code}`, "canary_process_failed");
        error.stderr = stderr.slice(0, 4096);
        finish(reject, error);
        return;
      }
      finish(resolve, { stdout: Buffer.concat(stdout), stderr });
    });
  });
}

function getVideoStream(probe) {
  return Array.isArray(probe?.streams)
    ? probe.streams.find((stream) => stream?.codec_type === "video")
    : null;
}

function getAudioStreamCount(probe) {
  return Array.isArray(probe?.streams)
    ? probe.streams.filter((stream) => stream?.codec_type === "audio").length
    : 0;
}

function imageProbeSummary(probe) {
  const video = getVideoStream(probe);
  return {
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    codec: String(video?.codec_name || ""),
    pixelFormat: String(video?.pix_fmt || ""),
    fps: null,
    duration: null,
    audioStreams: getAudioStreamCount(probe)
  };
}

function analyzeRgbFrame(buffer, chromaRgb) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== RGB_FRAME_BYTES) {
    throw codedError("Controlled-real RGB frame has an invalid size", "canary_frame_invalid");
  }
  const width = CHARACTER_CANVAS_V1.width;
  const height = CHARACTER_CANVAS_V1.height;
  const thresholds = BACKGROUND_THRESHOLDS;
  let greenPixels = 0;
  let outerPixels = 0;
  let outerGreenPixels = 0;
  let edgeContactPixels = 0;
  let outerNearBlackPixels = 0;
  let nearGreenForegroundPixels = 0;
  let nonGreenPixels = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const r = buffer[offset];
      const g = buffer[offset + 1];
      const b = buffer[offset + 2];
      const greenDistance = Math.max(
        Math.abs(r - chromaRgb[0]),
        Math.abs(g - chromaRgb[1]),
        Math.abs(b - chromaRgb[2])
      );
      const green = greenDistance <= thresholds.greenDistance;
      const outer = x < thresholds.edgeBandPx || y < thresholds.edgeBandPx ||
        x >= width - thresholds.edgeBandPx || y >= height - thresholds.edgeBandPx;
      const contact = x < thresholds.contactBandPx || y < thresholds.contactBandPx ||
        x >= width - thresholds.contactBandPx || y >= height - thresholds.contactBandPx;
      if (green) greenPixels += 1;
      if (outer) {
        outerPixels += 1;
        if (green) outerGreenPixels += 1;
        if (r <= thresholds.nearBlackMaximum && g <= thresholds.nearBlackMaximum && b <= thresholds.nearBlackMaximum) {
          outerNearBlackPixels += 1;
        }
      }
      if (!green) {
        nonGreenPixels += 1;
        if (contact) edgeContactPixels += 1;
        if (greenDistance <= thresholds.greenDistance * 2) nearGreenForegroundPixels += 1;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  const totalPixels = width * height;
  const visibleBounds = nonGreenPixels > 0 ? { left, top, right: right + 1, bottom: bottom + 1 } : null;
  const safeMargins = visibleBounds &&
    visibleBounds.left >= CHARACTER_CANVAS_V1.minimumVisibleMarginsPx.left &&
    visibleBounds.top >= CHARACTER_CANVAS_V1.minimumVisibleMarginsPx.top &&
    visibleBounds.right <= width - CHARACTER_CANVAS_V1.minimumVisibleMarginsPx.right &&
    visibleBounds.bottom <= height - CHARACTER_CANVAS_V1.minimumVisibleMarginsPx.bottom;
  const metrics = {
    overallGreenRatio: greenPixels / totalPixels,
    outerGreenRatio: outerGreenPixels / Math.max(1, outerPixels),
    edgeContactRatio: edgeContactPixels / Math.max(1, outerPixels),
    outerNearBlackRatio: outerNearBlackPixels / Math.max(1, outerPixels),
    nearGreenForegroundRatio: nearGreenForegroundPixels / Math.max(1, nonGreenPixels),
    nonGreenPixelCount: nonGreenPixels,
    visibleBounds,
    safeMargins: Boolean(safeMargins)
  };
  const errors = [];
  if (!visibleBounds) errors.push("No non-chroma foreground was measured");
  if (metrics.overallGreenRatio < thresholds.minimumOverallGreenRatio) errors.push("Measured background is not sufficiently chroma-green");
  if (metrics.outerGreenRatio < thresholds.minimumOuterGreenRatio) errors.push("Outer frame background is not uniformly chroma-green");
  if (metrics.edgeContactRatio > thresholds.maximumEdgeContactRatio) errors.push("Foreground contacts the outer frame edge");
  if (metrics.outerNearBlackRatio > thresholds.maximumOuterNearBlackRatio) errors.push("Outer frame contains excessive near-black pixels");
  if (!metrics.safeMargins) errors.push("Measured foreground exceeds minimum canvas margins");
  return { ok: errors.length === 0, errors, metrics };
}

async function extractRgbFrames({ ffmpegPath, inputPath, frameIndices, environment }) {
  const unique = [...new Set(frameIndices)].sort((left, right) => left - right);
  const expression = unique.map((index) => `eq(n\\,${index})`).join("+");
  const result = await runProcessCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", inputPath,
      "-vf", `select=${expression}`,
      "-vsync", "0",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "pipe:1"
    ],
    environment,
    stdoutLimit: RGB_FRAME_BYTES * unique.length + 1024
  });
  if (result.stdout.length !== RGB_FRAME_BYTES * unique.length) {
    throw codedError("Controlled-real frame sampler returned an unexpected frame count", "canary_frame_sample_invalid");
  }
  return unique.map((frameIndex, index) => ({
    frameIndex,
    bytes: result.stdout.subarray(index * RGB_FRAME_BYTES, (index + 1) * RGB_FRAME_BYTES)
  }));
}

async function extractRgbaFrames({ ffmpegPath, inputPath, frameIndices, environment }) {
  const unique = [...new Set(frameIndices)].sort((left, right) => left - right);
  const expression = unique.map((index) => `eq(n\\,${index})`).join("+");
  const result = await runProcessCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-c:v", "libvpx-vp9",
      "-i", inputPath,
      "-vf", `select=${expression}`,
      "-vsync", "0",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "pipe:1"
    ],
    environment,
    stdoutLimit: RGBA_FRAME_BYTES * unique.length + 1024
  });
  if (result.stdout.length !== RGBA_FRAME_BYTES * unique.length) {
    throw codedError("Controlled-real alpha sampler returned an unexpected frame count", "canary_alpha_sample_invalid");
  }
  return unique.map((frameIndex, index) => ({
    frameIndex,
    bytes: result.stdout.subarray(index * RGBA_FRAME_BYTES, (index + 1) * RGBA_FRAME_BYTES)
  }));
}

function analyzeRgbaFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== RGBA_FRAME_BYTES) {
    throw codedError("Controlled-real alpha frame has an invalid byte size", "canary_alpha_sample_invalid");
  }
  const width = CHARACTER_CANVAS_V1.width;
  const height = CHARACTER_CANVAS_V1.height;
  const thresholds = ALPHA_THRESHOLDS;
  let transparentPixels = 0;
  let outerTransparentPixels = 0;
  let outerPixels = 0;
  let edgeContactPixels = 0;
  let foregroundPixels = 0;
  let spillEligiblePixels = 0;
  let greenSpillPixels = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const r = buffer[offset];
      const g = buffer[offset + 1];
      const b = buffer[offset + 2];
      const alpha = buffer[offset + 3];
      const outer = x < thresholds.edgeBandPx || y < thresholds.edgeBandPx ||
        x >= width - thresholds.edgeBandPx || y >= height - thresholds.edgeBandPx;
      const contact = x < thresholds.contactBandPx || y < thresholds.contactBandPx ||
        x >= width - thresholds.contactBandPx || y >= height - thresholds.contactBandPx;
      const transparent = alpha <= thresholds.transparentMaximum;
      const foreground = alpha >= thresholds.foregroundMinimum;
      if (transparent) transparentPixels += 1;
      if (outer) {
        outerPixels += 1;
        if (transparent) outerTransparentPixels += 1;
      }
      if (!foreground) continue;
      foregroundPixels += 1;
      if (contact) edgeContactPixels += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      if (alpha >= thresholds.spillAlphaMinimum) {
        spillEligiblePixels += 1;
        if (g - (r + b) / 2 > thresholds.spillGreenExcess) greenSpillPixels += 1;
      }
    }
  }
  const totalPixels = width * height;
  const visibleBounds = foregroundPixels > 0 ? { left, top, right: right + 1, bottom: bottom + 1 } : null;
  const safeMargins = visibleBounds &&
    visibleBounds.left >= CHARACTER_CANVAS_V1.minimumVisibleMarginsPx.left &&
    visibleBounds.top >= CHARACTER_CANVAS_V1.minimumVisibleMarginsPx.top &&
    visibleBounds.right <= width - CHARACTER_CANVAS_V1.minimumVisibleMarginsPx.right &&
    visibleBounds.bottom <= height - CHARACTER_CANVAS_V1.minimumVisibleMarginsPx.bottom;
  const metrics = {
    overallTransparentRatio: transparentPixels / totalPixels,
    outerTransparentRatio: outerTransparentPixels / Math.max(1, outerPixels),
    edgeContactRatio: edgeContactPixels / Math.max(1, outerPixels),
    foregroundGreenSpillRatio: greenSpillPixels / Math.max(1, spillEligiblePixels),
    foregroundPixelCount: foregroundPixels,
    visibleBounds,
    safeMargins: Boolean(safeMargins)
  };
  const errors = [];
  if (!visibleBounds) errors.push("No alpha foreground was measured");
  if (metrics.overallTransparentRatio < thresholds.minimumOverallTransparentRatio) {
    errors.push("Alpha output does not contain enough transparent background");
  }
  if (metrics.outerTransparentRatio < thresholds.minimumOuterTransparentRatio) {
    errors.push("Outer frame is not uniformly transparent");
  }
  if (metrics.edgeContactRatio > thresholds.maximumEdgeContactRatio) {
    errors.push("Alpha foreground contacts the outer frame edge");
  }
  if (metrics.foregroundGreenSpillRatio > thresholds.maximumForegroundGreenSpillRatio) {
    errors.push("Alpha foreground retains excessive green spill");
  }
  if (!metrics.safeMargins) errors.push("Alpha foreground exceeds minimum canvas margins");
  return { ok: errors.length === 0, errors, metrics };
}

function aggregateAlphaAnalysis(samples) {
  const frames = samples.map(({ frameIndex, bytes }) => ({ frameIndex, ...analyzeRgbaFrame(bytes) }));
  return {
    ok: frames.every((frame) => frame.ok),
    errors: frames.flatMap((frame) => frame.errors.map((error) => `frame ${frame.frameIndex}: ${error}`)),
    thresholds: { ...ALPHA_THRESHOLDS },
    frames: frames.map(({ frameIndex, ok, errors, metrics }) => ({ frameIndex, ok, errors, metrics }))
  };
}

function aggregateFrameAnalysis(samples, chromaRgb) {
  const frames = samples.map(({ frameIndex, bytes }) => ({ frameIndex, ...analyzeRgbFrame(bytes, chromaRgb) }));
  return {
    ok: frames.every((frame) => frame.ok),
    errors: frames.flatMap((frame) => frame.errors.map((error) => `frame ${frame.frameIndex}: ${error}`)),
    thresholds: { ...BACKGROUND_THRESHOLDS },
    frames: frames.map(({ frameIndex, ok, errors, metrics }) => ({ frameIndex, ok, errors, metrics }))
  };
}

function masterFilter(chroma) {
  const canvas = CHARACTER_CANVAS_V1;
  return [
    `[0:v]format=rgba,chromakey=${chroma.ffmpegColor}:${chroma.similarity}:${chroma.blend},` +
      `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease:flags=lanczos[pet]`,
    `color=c=${chroma.ffmpegColor}:s=${canvas.width}x${canvas.height}:r=1[background]`,
    "[background][pet]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto,format=rgb24[outv]"
  ].join(";");
}

async function processMaster({ kind, source, outputPath, ffmpegPath, probeAsset, chroma, environment }) {
  const signatureMimeType = await detectMasterImageMime(source.path);
  const sourceProbe = await probeAsset({ localPath: source.path, mediaRole: `${kind}-master-source` });
  const sourceSummary = imageProbeSummary(sourceProbe.probe);
  const probeMimeType = MASTER_MIME_BY_CODEC[sourceSummary.codec.toLowerCase()] || null;
  if (!probeMimeType || probeMimeType !== signatureMimeType || sourceSummary.width < 1 ||
      sourceSummary.height < 1 || sourceSummary.audioStreams !== 0) {
    throw codedError(`${kind} master source is not a valid PNG, JPEG, or WebP image`, "canary_master_source_invalid");
  }
  sourceSummary.mimeType = probeMimeType;
  await runProcessCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
      "-i", source.path,
      "-filter_complex", masterFilter(chroma),
      "-map", "[outv]",
      "-frames:v", "1",
      "-compression_level", "9",
      outputPath
    ],
    environment,
    stdoutLimit: 1024
  });
  const png = await inspectPngFile(outputPath);
  const outputProbe = await probeAsset({ localPath: outputPath, mediaRole: `${kind}-master-normalized` });
  const summary = imageProbeSummary(outputProbe.probe);
  const frame = aggregateFrameAnalysis(
    await extractRgbFrames({ ffmpegPath, inputPath: outputPath, frameIndices: [0], environment }),
    chroma.rgb
  );
  const errors = [];
  if (png.width !== CHARACTER_CANVAS_V1.width || png.height !== CHARACTER_CANVAS_V1.height) {
    errors.push(`Normalized master must be ${CHARACTER_CANVAS_V1.width}x${CHARACTER_CANVAS_V1.height}`);
  }
  if (summary.codec !== "png" || summary.audioStreams !== 0) errors.push("Normalized master probe is invalid");
  if (!frame.ok) errors.push(...frame.errors);
  return {
    kind,
    source: { sha256: source.sha256, byteSize: source.byteSize, probe: sourceSummary },
    output: { path: outputPath, sha256: png.sha256, byteSize: png.byteSize, probe: summary },
    geometry: { mode: "contain", cropped: false, canvasId: CHARACTER_CANVAS_V1.id },
    background: frame,
    ok: errors.length === 0,
    errors
  };
}

function alphaEdgeDecontaminationFilter() {
  const greenExcess = "max(g(X,Y)-(r(X,Y)+b(X,Y))/2,0)";
  const insetAlpha = "min(alpha(X,Y),min(alpha(X-1,Y),min(alpha(X+1,Y),min(alpha(X,Y-1),alpha(X,Y+1)))))";
  return `geq=r='clip(r(X,Y)+(${greenExcess})*${FINAL_ALPHA_KEY.greenCorrection},0,255)'` +
    `:g='clip(g(X,Y)-(${greenExcess})*${FINAL_ALPHA_KEY.greenCorrection},0,255)'` +
    `:b='clip(b(X,Y)+(${greenExcess})*${FINAL_ALPHA_KEY.greenCorrection},0,255)'` +
    `:a='${insetAlpha}'`;
}

function videoFilter(chroma, duration) {
  const canvas = CHARACTER_CANVAS_V1;
  return [
    `[0:v]trim=start=0:end=${duration},setpts=PTS-STARTPTS,fps=${canvas.fps},` +
      `tpad=stop_mode=clone:stop_duration=${1 / canvas.fps},format=rgba,` +
      `chromakey=${chroma.ffmpegColor}:${chroma.similarity}:${chroma.blend},` +
      `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease:flags=lanczos[cutout]`,
    `color=c=${FINAL_ALPHA_KEY.ffmpegColor}:s=${canvas.width}x${canvas.height}:r=${canvas.fps}:d=${duration}[background]`,
    `[background][cutout]overlay=(W-w)/2:(H-h)/2:shortest=0:repeatlast=1:format=auto,format=rgba,` +
      `colorkey=${FINAL_ALPHA_KEY.ffmpegColor}:${FINAL_ALPHA_KEY.similarity}:${FINAL_ALPHA_KEY.blend},` +
      `${alphaEdgeDecontaminationFilter()},fps=${canvas.fps},setsar=1,format=yuva420p[outv]`
  ].join(";");
}

async function processVideo({ actionId, source, outputPath, ffmpegPath, probeAsset, chroma, environment }) {
  const sourceProbe = await probeAsset({ localPath: source.path, actionId, mediaRole: "canary-provider-source" });
  const sourceVideo = getVideoStream(sourceProbe.probe);
  const sourceDuration = Number(sourceVideo?.duration ?? sourceProbe.probe?.format?.duration);
  if (!sourceVideo || !Number.isFinite(sourceDuration) || sourceDuration <= 0 ||
      Math.abs(sourceDuration - source.expectedDuration) > 0.25) {
    throw codedError(`${actionId} source duration does not match its frozen expected duration`, "canary_source_duration_mismatch");
  }
  const frameCount = source.expectedDuration * CHARACTER_CANVAS_V1.fps;
  await runProcessCapture({
    executable: ffmpegPath,
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
      "-i", source.path,
      "-filter_complex", videoFilter(chroma, source.expectedDuration),
      "-map", "[outv]",
      "-an",
      "-c:v", "libvpx-vp9",
      "-pix_fmt", "yuva420p",
      "-deadline", "good",
      "-cpu-used", "4",
      "-row-mt", "1",
      "-auto-alt-ref", "0",
      "-metadata:s:v:0", "alpha_mode=1",
      "-crf", "28",
      "-b:v", "0",
      "-threads", "1",
      "-r", String(CHARACTER_CANVAS_V1.fps),
      "-frames:v", String(frameCount),
      outputPath
    ],
    environment,
    stdoutLimit: 1024
  });
  const outputProbe = await probeAsset({ localPath: outputPath, actionId, mediaRole: "canary-processed-action" });
  const media = validateActionMediaProbe(outputProbe.probe, {
    allowedVideoCodecs: ["vp9"],
    allowedFormatNames: ["webm", "matroska"],
    expectedDuration: source.expectedDuration
  });
  const outputArtifact = await checksumFile(outputPath);
  if (outputArtifact.sha256 !== String(outputProbe.checksumSha256 || "").toLowerCase()) {
    throw codedError(`${actionId} output changed after trusted ffprobe`, "canary_output_integrity_mismatch");
  }
  const outputFrameCount = Number(media.summary?.frameCount);
  const sampleIndices = [0, Math.floor((Math.max(1, outputFrameCount) - 1) / 2), Math.max(0, outputFrameCount - 1)];
  const outputVideo = getVideoStream(outputProbe.probe);
  const alphaMode = String(outputVideo?.tags?.ALPHA_MODE ?? outputVideo?.tags?.alpha_mode ?? "");
  const transparency = aggregateAlphaAnalysis(
    await extractRgbaFrames({ ffmpegPath, inputPath: outputPath, frameIndices: sampleIndices, environment })
  );
  const errors = [];
  if (!media.ok) errors.push(...media.errors);
  if (alphaMode !== "1") errors.push("VP9 output is missing its alpha_mode=1 stream tag");
  if (!transparency.ok) errors.push(...transparency.errors);
  const outputSummary = {
    ...media.summary,
    pixelFormat: String(outputVideo?.pix_fmt || ""),
    alphaMode
  };
  return {
    actionId,
    expectedDuration: source.expectedDuration,
    source: {
      sha256: source.sha256,
      byteSize: source.byteSize,
      probe: {
        width: Number(sourceVideo.width) || 0,
        height: Number(sourceVideo.height) || 0,
        codec: String(sourceVideo.codec_name || ""),
        fps: String(sourceVideo.avg_frame_rate || sourceVideo.r_frame_rate || ""),
        duration: sourceDuration,
        audioStreams: getAudioStreamCount(sourceProbe.probe)
      }
    },
    output: {
      path: outputPath,
      sha256: outputArtifact.sha256,
      byteSize: outputArtifact.byteSize,
      probe: outputSummary
    },
    geometry: { mode: "contain", cropped: false, canvasId: CHARACTER_CANVAS_V1.id },
    transparency,
    ok: errors.length === 0,
    errors
  };
}

async function writeJsonExclusive(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function baseReport({ request, sources, manualQa, mode, runDirectory, sidecarArtifact }) {
  return {
    classification: CLASSIFICATION,
    productionAssured: false,
    releaseEligible: false,
    ok: false,
    status: "running",
    schemaVersion: 1,
    mode,
    runId: request.runId,
    packageName: request.packageName,
    outputDirectory: runDirectory,
    processTempDirectory: CONTROLLED_PROCESS_TEMP_ROOT,
    canvas: { ...CHARACTER_CANVAS_V1 },
    chroma: {
      color: request.chroma.color,
      similarity: request.chroma.similarity,
      blend: request.chroma.blend
    },
    alphaPostprocess: {
      keyColor: FINAL_ALPHA_KEY.color,
      similarity: FINAL_ALPHA_KEY.similarity,
      blend: FINAL_ALPHA_KEY.blend,
      greenCorrection: FINAL_ALPHA_KEY.greenCorrection,
      alphaInsetPixels: FINAL_ALPHA_KEY.alphaInsetPixels,
      codec: "vp9",
      pixelFormat: "yuva420p"
    },
    manualQa: {
      ...manualQa,
      sidecarSha256: sidecarArtifact.sha256,
      sidecarByteSize: sidecarArtifact.byteSize
    },
    sourceArtifacts: {
      masters: Object.fromEntries(MASTER_KINDS.map((kind) => [kind, {
        sha256: sources.masters[kind].sha256,
        byteSize: sources.masters[kind].byteSize
      }])),
      videos: Object.fromEntries(REQUIRED_ACTION_IDS.map((actionId) => [actionId, {
        sha256: sources.videos[actionId].sha256,
        byteSize: sources.videos[actionId].byteSize,
        expectedDuration: sources.videos[actionId].expectedDuration
      }]))
    },
    machineQa: { masters: {}, videos: {}, allPassed: false },
    package: null,
    clientImport: null,
    errors: []
  };
}

function packageAsset(video, manual) {
  const humanGate = {
    ok: manual.human === true && manual.accepted === true,
    evidenceMode: "human",
    sourceSha256: manual.sourceSha256,
    reviewerNote: manual.reviewerNote
  };
  return {
    actionId: video.actionId,
    buffer: fs.readFileSync(video.output.path),
    localPath: video.output.path,
    matteMode: "alpha",
    container: "webm",
    codec: "vp9",
    expectedSha256: video.output.sha256,
    qa: {
      media: { ok: video.ok, errors: [...video.errors], summary: video.output.probe },
      canvas: { ok: video.transparency.ok, errors: [...video.transparency.errors], evidenceMode: "machine" },
      endpoints: { ...humanGate },
      content: { ...humanGate, machineTransparencyPassed: video.transparency.ok },
      continuity: { ...humanGate }
    }
  };
}

async function runIsolatedClientImport({ packagePath, userDataDir, runDirectory, environment }) {
  const importerPath = path.resolve(PROJECT_ROOT, "src/main/services/petpack.js");
  const script = [
    "const [importerPath, packagePath, userDataDir] = process.argv.slice(1);",
    "const { importPetpack } = require(importerPath);",
    "importPetpack(packagePath, userDataDir).then((result) => {",
    "  process.stdout.write(JSON.stringify(result));",
    "  process.exitCode = result && result.ok ? 0 : 2;",
    "}).catch(() => { process.stdout.write(JSON.stringify({ok:false,error:'import_crashed'})); process.exitCode = 3; });"
  ].join("\n");
  const result = await runProcessCapture({
    executable: process.execPath,
    args: ["-e", script, importerPath, packagePath, userDataDir],
    cwd: runDirectory,
    environment: { ...environment, NODE_ENV: "test", VITEST: "true" },
    timeoutMs: 120 * 1000,
    stdoutLimit: 1024 * 1024
  });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw codedError("Isolated Desktop Pet importer returned invalid JSON", "canary_import_invalid");
  }
  if (!parsed || parsed.ok !== true) {
    throw codedError("Desktop Pet rejected the controlled-real PetPack", "canary_import_rejected");
  }
  return parsed;
}

async function runControlledRealCanary({
  request,
  environment = process.env,
  logger = console,
  ffmpegPath,
  ffprobePath
} = {}) {
  const mode = assertDevelopmentOnly(environment);
  const normalized = await normalizeRequest(request);
  const resolvedFfmpeg = resolveToolPath(ffmpegPath || environment.FFMPEG_PATH, ffmpegStaticPath, "Controlled-real FFmpeg");
  const resolvedFfprobe = resolveToolPath(ffprobePath || environment.FFPROBE_PATH, ffprobeStatic.path, "Controlled-real ffprobe");
  const sources = await collectSourceFacts(normalized);
  const sidecarArtifact = await checksumFile(normalized.manualQa.file.path);
  const manualQa = validateManualQa(normalized.manualQa.parsed, sources);

  const processTempDirectory = await ensureFixedDirectory(
    CONTROLLED_PROCESS_TEMP_ROOT,
    "Controlled-real process temp directory"
  );
  const processEnvironment = {
    ...environment,
    TEMP: processTempDirectory,
    TMP: processTempDirectory,
    TMPDIR: processTempDirectory
  };
  const root = await ensureFixedDirectory(
    CONTROLLED_REAL_CANARY_ROOT,
    "Controlled-real output root"
  );
  const runDirectory = safeChildPath(root, normalized.runId);
  await fsp.mkdir(runDirectory, { recursive: false });
  const reportPath = safeChildPath(runDirectory, "report.json");
  const report = baseReport({ request: normalized, sources, manualQa, mode, runDirectory, sidecarArtifact });

  if (!manualQa.allAccepted) {
    report.status = "manual_qa_rejected";
    report.errors = manualQa.rejected.map((item) => `Manual QA rejected ${item}`);
    await writeJsonExclusive(reportPath, report);
    logger.warn?.("petpack.controlled_real.manual_qa_rejected", { runId: normalized.runId, rejected: manualQa.rejected.length });
    return { reportPath, report };
  }

  const probeAsset = createTrustedFileProbe({
    ffprobePath: resolvedFfprobe,
    spawnImpl: (executable, args, options) => spawn(executable, args, {
      ...options,
      env: processEnvironment,
      windowsHide: true,
      shell: false
    })
  });
  const mastersDirectory = safeChildPath(runDirectory, "masters");
  const videosDirectory = safeChildPath(runDirectory, "videos");
  await fsp.mkdir(mastersDirectory);
  await fsp.mkdir(videosDirectory);

  try {
    for (const kind of MASTER_KINDS) {
      report.machineQa.masters[kind] = await processMaster({
        kind,
        source: sources.masters[kind],
        outputPath: safeChildPath(mastersDirectory, `${kind}.png`),
        ffmpegPath: resolvedFfmpeg,
        probeAsset,
        chroma: normalized.chroma,
        environment: processEnvironment
      });
    }
    for (const actionId of REQUIRED_ACTION_IDS) {
      report.machineQa.videos[actionId] = await processVideo({
        actionId,
        source: sources.videos[actionId],
        outputPath: safeChildPath(videosDirectory, `${actionId}.webm`),
        ffmpegPath: resolvedFfmpeg,
        probeAsset,
        chroma: normalized.chroma,
        environment: processEnvironment
      });
    }
    report.machineQa.allPassed =
      MASTER_KINDS.every((kind) => report.machineQa.masters[kind].ok) &&
      REQUIRED_ACTION_IDS.every((actionId) => report.machineQa.videos[actionId].ok);
    if (!report.machineQa.allPassed) {
      report.status = "machine_qa_failed";
      report.errors = [
        ...MASTER_KINDS.flatMap((kind) => report.machineQa.masters[kind].errors.map((error) => `${kind}: ${error}`)),
        ...REQUIRED_ACTION_IDS.flatMap((actionId) => report.machineQa.videos[actionId].errors.map((error) => `${actionId}: ${error}`))
      ];
      await writeJsonExclusive(reportPath, report);
      return { reportPath, report };
    }

    const revisionMaterial = [
      normalized.runId,
      ...MASTER_KINDS.map((kind) => report.machineQa.masters[kind].output.sha256),
      ...REQUIRED_ACTION_IDS.map((actionId) => report.machineQa.videos[actionId].output.sha256)
    ].join("|");
    const revisionSha256 = crypto.createHash("sha256").update(revisionMaterial).digest("hex");
    const packageId = `internal-canary-${revisionSha256.slice(0, 24)}`;
    const built = await buildPetpack({
      packageId,
      name: `[INTERNAL TEST] ${normalized.packageName}`,
      version: "0.0.0-internal-canary",
      assets: REQUIRED_ACTION_IDS.map((actionId) => packageAsset(
        report.machineQa.videos[actionId],
        manualQa.videos[actionId]
      )),
      idFactory: (actionId) => createDeterministicUuid(`${CLASSIFICATION}|${revisionSha256}|${actionId}`),
      probeAsset
    });
    const packagePath = safeChildPath(runDirectory, "internal-controlled-real-test.petpack");
    await fsp.writeFile(packagePath, built.bytes, { flag: "wx" });
    const archive = await verifyPetpackArchive(built.bytes);
    const packageArtifact = await checksumFile(packagePath);
    if (packageArtifact.sha256 !== built.checksumSha256) {
      throw codedError("Controlled-real PetPack changed after build", "canary_package_integrity_mismatch");
    }
    const clientUserData = safeChildPath(runDirectory, "client-user-data");
    const clientImport = await runIsolatedClientImport({
      packagePath,
      userDataDir: clientUserData,
      runDirectory,
      environment: processEnvironment
    });
    if (clientImport.packageId !== packageId || clientImport.fileCount !== archive.fileNames.length) {
      throw codedError("Isolated Desktop Pet import is not bound to the built archive", "canary_import_binding_failed");
    }
    report.package = {
      path: packagePath,
      packageId,
      sha256: packageArtifact.sha256,
      byteSize: packageArtifact.byteSize,
      fileNames: archive.fileNames,
      manifestValidation: archive.validation
    };
    report.clientImport = {
      ok: true,
      isolatedUserDataDirectory: clientUserData,
      packageId: clientImport.packageId,
      fileCount: clientImport.fileCount
    };
    report.ok = true;
    report.status = "completed";
    await writeJsonExclusive(reportPath, report);
    logger.info?.("petpack.controlled_real.completed", {
      runId: normalized.runId,
      packageSha256: packageArtifact.sha256,
      releaseEligible: false
    });
    return { reportPath, packagePath, report };
  } catch (error) {
    report.status = "failed";
    report.errors = [{ code: error?.code || "canary_failed", message: error?.message || "Controlled-real canary failed" }];
    if (!fs.existsSync(reportPath)) await writeJsonExclusive(reportPath, report).catch(() => undefined);
    error.reportPath = reportPath;
    throw error;
  }
}

async function main({ argv = process.argv.slice(2), environment = process.env, logger = console } = {}) {
  if (argv.length !== 2 || argv[0] !== "--request") {
    throw codedError("Usage: node controlled-real-canary.js --request <absolute-request.json>", "canary_cli_invalid");
  }
  const loaded = await readBoundedJson(argv[1], "Controlled-real request file");
  const result = await runControlledRealCanary({ request: loaded.parsed, environment, logger });
  process.stdout.write(`${JSON.stringify({
    classification: CLASSIFICATION,
    productionAssured: false,
    releaseEligible: false,
    status: result.report.status,
    reportPath: result.reportPath,
    packagePath: result.packagePath || null
  })}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      classification: CLASSIFICATION,
      productionAssured: false,
      releaseEligible: false,
      code: error?.code || "canary_failed",
      reportPath: error?.reportPath || null
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALPHA_THRESHOLDS,
  BACKGROUND_THRESHOLDS,
  CLASSIFICATION,
  CONTROLLED_REAL_CANARY_ROOT,
  CONTROLLED_PROCESS_TEMP_ROOT,
  MANUAL_QA_SCHEMA_VERSION,
  MASTER_INPUT_EXTENSIONS,
  MASTER_KINDS,
  REQUEST_SCHEMA_VERSION,
  analyzeRgbaFrame,
  analyzeRgbFrame,
  assertDevelopmentOnly,
  detectMasterImageMime,
  main,
  runControlledRealCanary
};
