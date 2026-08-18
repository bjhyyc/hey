"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { CHARACTER_CANVAS_V1 } = require("./character-canvas-v1");
const { ACTION_ENDPOINTS: CATALOG_ACTION_ENDPOINTS } = require("../domain/action-catalog");
const {
  DECODED_ENDPOINT_CONTRACT_VERSION,
  compareRgbaFrames,
  evaluateEndpointFrameContinuity
} = require("./frame-continuity-metrics");

const FRAME_BYTES = CHARACTER_CANVAS_V1.width * CHARACTER_CANVAS_V1.height * 4;
const INPUT_CHROMA = "0x00e676";
const INPUT_CHROMA_SIMILARITY = "0.25";
const INPUT_CHROMA_BLEND = "0.06";
const MAX_CAPTURE_BYTES = FRAME_BYTES * 2 + 4096;
const DEFAULT_TIMEOUT_MS = 120_000;
// Every production action must pass trusted decoded-endpoint inspection, so
// this table is derived from the frozen action catalog instead of naming only
// the sleep-adjacent actions.
const ACTION_ENDPOINTS = Object.freeze(Object.fromEntries(
  Object.entries(CATALOG_ACTION_ENDPOINTS).map(([actionId, endpoint]) => [
    actionId,
    Object.freeze({ firstMasterKind: endpoint.firstMaster, lastMasterKind: endpoint.lastMaster })
  ])
));

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} is required`);
  return value.trim();
}

function requireRegularFile(filePath, label) {
  const resolved = path.resolve(requiredString(filePath, label));
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return resolved;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function runCapture({ executable, args, spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS, maximumBytes = MAX_CAPTURE_BYTES }) {
  requiredString(executable, "FFmpeg executable");
  if (!Array.isArray(args)) throw new TypeError("FFmpeg arguments are required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    throw new RangeError("Endpoint decoder timeout is outside the allowed range");
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, args, { shell: false, windowsHide: true });
    } catch (error) {
      reject(new Error(`Endpoint decoder could not start: ${error.message}`));
      return;
    }
    const chunks = [];
    let total = 0;
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (message, code) => {
      const error = new Error(message);
      if (code) error.code = code;
      finish(reject, error);
    };
    timer = setTimeout(() => {
      child.kill?.("SIGKILL");
      fail("Endpoint decoder exceeded its execution timeout", "endpoint_decoder_timeout");
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maximumBytes) {
        child.kill?.("SIGKILL");
        fail("Endpoint decoder output exceeded its bounded limit", "endpoint_decoder_output_too_large");
        return;
      }
      chunks.push(bytes);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
    });
    child.once("error", (error) => fail(`Endpoint decoder could not start: ${error.message}`, "endpoint_decoder_start_failed"));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(`Endpoint decoder failed with exit code ${code}${stderr ? `: ${stderr}` : ""}`, "endpoint_decoder_failed");
        return;
      }
      finish(resolve, Buffer.concat(chunks, total));
    });
  });
}

async function decodeRgba({ filePath, frameIndices, ffmpegPath, spawnImpl }) {
  const isWebm = path.extname(filePath).toLowerCase() === ".webm";
  const expression = frameIndices.map((index) => `eq(n\\,${index})`).join("+");
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  if (isWebm) args.push("-c:v", "libvpx-vp9");
  args.push(
    "-i", filePath,
    "-vf", `select=${expression},format=rgba`,
    "-frames:v", String(frameIndices.length),
    "-vsync", "0",
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "pipe:1"
  );
  const bytes = await runCapture({ executable: ffmpegPath, args, spawnImpl, maximumBytes: FRAME_BYTES * frameIndices.length + 4096 });
  if (bytes.length !== FRAME_BYTES * frameIndices.length) {
    const error = new Error("Endpoint decoder returned an unexpected RGBA frame count");
    error.code = "endpoint_decoder_frame_count_mismatch";
    throw error;
  }
  return frameIndices.map((frameIndex, index) => ({
    frameIndex,
    bytes: bytes.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES)
  }));
}

async function decodeKeyedMaster({ filePath, ffmpegPath, spawnImpl }) {
  const args = [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-i", filePath,
    "-vf", `format=rgba,chromakey=${INPUT_CHROMA}:${INPUT_CHROMA_SIMILARITY}:${INPUT_CHROMA_BLEND}`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"
  ];
  const bytes = await runCapture({ executable: ffmpegPath, args, spawnImpl, maximumBytes: FRAME_BYTES + 4096 });
  if (bytes.length !== FRAME_BYTES) {
    const error = new Error("Master decoder returned an unexpected RGBA frame size");
    error.code = "master_decoder_frame_size_mismatch";
    throw error;
  }
  return bytes;
}

function createTrustedActionEndpointInspector({ ffmpegPath, spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const executable = requireRegularFile(ffmpegPath, "FFmpeg executable");
  let executableHashPromise;
  const getExecutableHash = () => {
    executableHashPromise ||= sha256File(executable);
    return executableHashPromise;
  };

  return async function inspectTrustedActionEndpoints({
    actionId,
    outputPath,
    firstMasterPath,
    lastMasterPath,
    expectedFirstMasterHash,
    expectedLastMasterHash,
    frameCount
  } = {}) {
    const normalizedActionId = requiredString(actionId, "actionId");
    const endpointRoles = ACTION_ENDPOINTS[normalizedActionId];
    if (!endpointRoles) throw new Error(`Trusted endpoint inspection does not support ${normalizedActionId}`);
    const output = requireRegularFile(outputPath, "Action output");
    const firstMaster = requireRegularFile(firstMasterPath, "First master");
    const lastMaster = requireRegularFile(lastMasterPath, "Last master");
    const normalizedFrameCount = Number(frameCount);
    if (!Number.isSafeInteger(normalizedFrameCount) || normalizedFrameCount < 2 || normalizedFrameCount > 3600) {
      throw new TypeError("A valid normalized action frame count is required");
    }
    const [firstMasterSha256, lastMasterSha256, outputSha256, firstBytes, lastBytes, endpointFrames, decoderSha256] = await Promise.all([
      sha256File(firstMaster),
      sha256File(lastMaster),
      sha256File(output),
      decodeKeyedMaster({ filePath: firstMaster, ffmpegPath: executable, spawnImpl }),
      decodeKeyedMaster({ filePath: lastMaster, ffmpegPath: executable, spawnImpl }),
      decodeRgba({ filePath: output, frameIndices: [0, normalizedFrameCount - 1], ffmpegPath: executable, spawnImpl }),
      getExecutableHash()
    ]);
    const normalizedExpectedFirst = expectedFirstMasterHash ? requiredString(expectedFirstMasterHash, "expectedFirstMasterHash").toLowerCase() : null;
    const normalizedExpectedLast = expectedLastMasterHash ? requiredString(expectedLastMasterHash, "expectedLastMasterHash").toLowerCase() : null;
    if (normalizedExpectedFirst && normalizedExpectedFirst !== firstMasterSha256) {
      const error = new Error("First master bytes do not match the frozen expected hash");
      error.code = "first_master_hash_mismatch";
      throw error;
    }
    if (normalizedExpectedLast && normalizedExpectedLast !== lastMasterSha256) {
      const error = new Error("Last master bytes do not match the frozen expected hash");
      error.code = "last_master_hash_mismatch";
      throw error;
    }
    // Bounded centroid alignment factors out the provider's systematic
    // endpoint reframing (a uniform ~9px translation measured across every
    // action of a real batch) before the strict content thresholds apply; the
    // applied offset is bounded and recorded in the evidence.
    const options = {
      width: CHARACTER_CANVAS_V1.width,
      height: CHARACTER_CANVAS_V1.height,
      alignment: { maxOffsetPx: 12 }
    };
    const firstFrame = compareRgbaFrames(firstBytes, endpointFrames[0].bytes, options);
    const lastFrame = compareRgbaFrames(lastBytes, endpointFrames[1].bytes, options);
    const firstDecision = evaluateEndpointFrameContinuity(firstFrame);
    const lastDecision = evaluateEndpointFrameContinuity(lastFrame);
    if (!firstDecision.ok || !lastDecision.ok) {
      const error = new Error(`${normalizedActionId} decoded endpoint frames do not match frozen masters`);
      error.code = "action_endpoint_continuity_failed";
      error.endpointErrors = { firstFrame: firstDecision.errors, lastFrame: lastDecision.errors };
      throw error;
    }
    return Object.freeze({
      contractVersion: DECODED_ENDPOINT_CONTRACT_VERSION,
      measuredFromDecodedOutput: true,
      trustedDecoder: Object.freeze({
        kind: "ffmpeg-libvpx-vp9-rgba/v1",
        executableSha256: decoderSha256
      }),
      actionId: normalizedActionId,
      outputSha256,
      outputFrameCount: normalizedFrameCount,
      endpointFrameIndices: Object.freeze([0, normalizedFrameCount - 1]),
      firstMasterKind: endpointRoles.firstMasterKind,
      lastMasterKind: endpointRoles.lastMasterKind,
      firstMasterSha256,
      lastMasterSha256,
      firstFrame,
      lastFrame,
      terminalFrameMatches: true,
      evidenceClass: "production-trusted-decoded-media"
    });
  };
}

module.exports = {
  ACTION_ENDPOINTS,
  createTrustedActionEndpointInspector,
  decodeKeyedMaster,
  decodeRgba,
  runCapture
};
