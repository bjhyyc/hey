"use strict";

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive integer`);
  return parsed;
}

function frameDelta(bytes, firstOffset, secondOffset, frameBytes) {
  let total = 0;
  for (let offset = 0; offset < frameBytes; offset += 4) {
    const firstAlpha = bytes[firstOffset + offset + 3] / 255;
    const secondAlpha = bytes[secondOffset + offset + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      const first = (bytes[firstOffset + offset + channel] / 255) * firstAlpha;
      const second = (bytes[secondOffset + offset + channel] / 255) * secondAlpha;
      total += Math.abs(first - second);
    }
    total += Math.abs(firstAlpha - secondAlpha);
  }
  return total / frameBytes;
}

function analyzeLoopMotion(bytes, {
  width,
  height,
  frameCount,
  restMotionThreshold = 0.0025,
  restWindowFrames = 12,
  includeMotionSeries = false
} = {}) {
  const normalizedWidth = positiveInteger(width, "Loop width");
  const normalizedHeight = positiveInteger(height, "Loop height");
  const normalizedFrameCount = positiveInteger(frameCount, "Loop frame count");
  const normalizedRestWindow = positiveInteger(restWindowFrames, "Loop rest window");
  const normalizedRestThreshold = Number(restMotionThreshold);
  if (!Number.isFinite(normalizedRestThreshold) || normalizedRestThreshold < 0 || normalizedRestThreshold > 1) {
    throw new TypeError("Loop rest motion threshold must be between zero and one");
  }
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError("Loop RGBA bytes are required");
  const frameBytes = normalizedWidth * normalizedHeight * 4;
  if (bytes.length !== frameBytes * normalizedFrameCount) {
    throw new TypeError("Loop RGBA byte size does not match the declared frames");
  }

  const motion = [];
  for (let index = 1; index < normalizedFrameCount; index += 1) {
    motion.push(frameDelta(bytes, (index - 1) * frameBytes, index * frameBytes, frameBytes));
  }
  const seamPixelDelta = frameDelta(bytes, 0, (normalizedFrameCount - 1) * frameBytes, frameBytes);
  const seamMotionDelta = Math.max(seamPixelDelta, motion[0] || 0);
  const terminalMotion = Math.max(0, ...motion.slice(-normalizedRestWindow));

  const evaluatedRestWindowFrames = Math.min(normalizedRestWindow, normalizedFrameCount);
  const openingMotion = motion.slice(0, Math.max(0, evaluatedRestWindowFrames - 1));
  const closingMotion = motion.slice(-Math.max(0, evaluatedRestWindowFrames - 1));
  const openingRestMeanMotion = openingMotion.reduce((sum, value) => sum + value, 0) / Math.max(1, openingMotion.length);
  const closingRestMeanMotion = closingMotion.reduce((sum, value) => sum + value, 0) / Math.max(1, closingMotion.length);
  // Codec noise can cause isolated adjacent-frame spikes even across a visually
  // static hold. Judge the required opening/closing window by its mean decoded
  // motion instead of stopping on a single compressed frame.
  const firstRestFrameCount = openingRestMeanMotion <= normalizedRestThreshold ? evaluatedRestWindowFrames : 1;
  const lastRestFrameCount = closingRestMeanMotion <= normalizedRestThreshold ? evaluatedRestWindowFrames : 1;

  return Object.freeze({
    sampledFrameCount: normalizedFrameCount,
    seamPixelDelta,
    seamMotionDelta,
    terminalMotion,
    firstRestFrameCount,
    lastRestFrameCount,
    openingRestMeanMotion,
    closingRestMeanMotion,
    maximumAdjacentFrameMotion: Math.max(0, ...motion),
    meanAdjacentFrameMotion: motion.reduce((sum, value) => sum + value, 0) / Math.max(1, motion.length),
    restMotionThreshold: normalizedRestThreshold,
    ...(includeMotionSeries ? { motionSeries: Object.freeze([...motion]) } : {})
  });
}

module.exports = {
  analyzeLoopMotion,
  frameDelta
};
