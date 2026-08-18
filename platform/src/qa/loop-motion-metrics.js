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

function finiteRatio(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new TypeError(`${label} must be between zero and one`);
  }
  return parsed;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function countProminentAreaPeaks(values, {
  startIndex,
  endIndex,
  restArea,
  amplitude,
  minimumSeparationFrames
}) {
  const threshold = restArea + amplitude * 0.5;
  const candidates = [];
  for (let index = Math.max(1, startIndex + 1); index < Math.min(values.length - 1, endIndex); index += 1) {
    const value = values[index];
    if (value < threshold) continue;
    if (value >= values[index - 1] && value >= values[index + 1] &&
        (value > values[index - 1] || value > values[index + 1])) {
      candidates.push({ index, value });
    }
  }
  const peaks = [];
  for (const candidate of candidates) {
    const previous = peaks[peaks.length - 1];
    if (previous && candidate.index - previous.index < minimumSeparationFrames) {
      if (candidate.value > previous.value) peaks[peaks.length - 1] = candidate;
    } else {
      peaks.push(candidate);
    }
  }
  if (peaks.length < 2) return peaks.length;
  let prominent = 1;
  for (let index = 1; index < peaks.length; index += 1) {
    const left = peaks[index - 1];
    const right = peaks[index];
    const valley = Math.min(...values.slice(left.index + 1, right.index));
    if (Math.min(left.value, right.value) - valley >= amplitude * 0.2) prominent += 1;
  }
  return prominent;
}

/**
 * Detects the low-frequency expand-and-return contour of one breathing cycle.
 * Adjacent RGB deltas are dominated by VP9 noise at 24fps and can miss a slow
 * abdominal rise entirely. Foreground area is instead smoothed across time;
 * one excursion away from the opening/closing rest area is one complete breath.
 */
function analyzeForegroundAreaCycle(bytes, {
  width,
  height,
  frameCount,
  restWindowFrames = 12,
  alphaThreshold = 32,
  smoothingWindowFrames = 7,
  minimumAmplitudeRatio = 0.015,
  activeFraction = 0.35,
  minimumActiveSegmentFrames = 12,
  maximumRestAreaDeltaRatio = 0.015
} = {}) {
  const normalizedWidth = positiveInteger(width, "Loop width");
  const normalizedHeight = positiveInteger(height, "Loop height");
  const normalizedFrameCount = positiveInteger(frameCount, "Loop frame count");
  const restFrames = positiveInteger(restWindowFrames, "Loop rest window");
  const threshold = positiveInteger(alphaThreshold, "Loop alpha threshold");
  const smoothingFrames = positiveInteger(smoothingWindowFrames, "Loop area smoothing window");
  const minimumActiveFrames = positiveInteger(minimumActiveSegmentFrames, "Loop active segment length");
  if (threshold > 255) throw new TypeError("Loop alpha threshold must not exceed 255");
  if (restFrames * 2 + minimumActiveFrames > normalizedFrameCount) {
    throw new TypeError("Loop does not contain enough frames for rest and breathing analysis");
  }
  const minimumAmplitude = finiteRatio(minimumAmplitudeRatio, "Loop minimum area amplitude ratio");
  const normalizedActiveFraction = finiteRatio(activeFraction, "Loop active area fraction");
  const maximumRestDelta = finiteRatio(maximumRestAreaDeltaRatio, "Loop maximum rest area delta ratio");
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError("Loop RGBA bytes are required");
  const frameBytes = normalizedWidth * normalizedHeight * 4;
  if (bytes.length !== frameBytes * normalizedFrameCount) {
    throw new TypeError("Loop RGBA byte size does not match the declared frames");
  }

  const areas = [];
  for (let frameIndex = 0; frameIndex < normalizedFrameCount; frameIndex += 1) {
    let foreground = 0;
    const base = frameIndex * frameBytes;
    for (let offset = 3; offset < frameBytes; offset += 4) {
      if (bytes[base + offset] >= threshold) foreground += 1;
    }
    areas.push(foreground);
  }
  const radius = Math.floor(smoothingFrames / 2);
  const smoothedAreas = areas.map((_, index) => mean(areas.slice(
    Math.max(0, index - radius),
    Math.min(areas.length, index + radius + 1)
  )));
  const openingRestMeanArea = mean(smoothedAreas.slice(0, restFrames));
  const closingRestMeanArea = mean(smoothedAreas.slice(-restFrames));
  const restArea = (openingRestMeanArea + closingRestMeanArea) / 2;
  let peakFrameIndex = 0;
  for (let index = 1; index < smoothedAreas.length; index += 1) {
    if (smoothedAreas[index] > smoothedAreas[peakFrameIndex]) peakFrameIndex = index;
  }
  const peakArea = smoothedAreas[peakFrameIndex];
  const amplitude = Math.max(0, peakArea - restArea);
  const amplitudeRatio = amplitude / Math.max(1, restArea);
  const restAreaDeltaRatio = Math.abs(openingRestMeanArea - closingRestMeanArea) / Math.max(1, restArea);
  const activeAreaThreshold = restArea + amplitude * normalizedActiveFraction;
  const prominentPeakCount = countProminentAreaPeaks(smoothedAreas, {
    startIndex: restFrames,
    endIndex: normalizedFrameCount - restFrames,
    restArea,
    amplitude,
    minimumSeparationFrames: Math.max(3, Math.floor(minimumActiveFrames / 2))
  });

  let activeSegments = 0;
  let activeRun = 0;
  for (let index = restFrames; index < normalizedFrameCount - restFrames; index += 1) {
    if (smoothedAreas[index] > activeAreaThreshold) {
      activeRun += 1;
      continue;
    }
    if (activeRun >= minimumActiveFrames) activeSegments += 1;
    activeRun = 0;
  }
  if (activeRun >= minimumActiveFrames) activeSegments += 1;

  const closing = smoothedAreas.slice(-restFrames);
  const closingHalf = Math.max(1, Math.floor(closing.length / 2));
  const earlyClosingArea = mean(closing.slice(0, closingHalf));
  const lateClosingArea = mean(closing.slice(-closingHalf));
  const nextInhaleStarted = amplitude > 0 &&
    lateClosingArea - earlyClosingArea > amplitude * 0.1 &&
    closingRestMeanArea - openingRestMeanArea > amplitude * 0.15;
  const completedBreathCycles = amplitudeRatio >= minimumAmplitude &&
    restAreaDeltaRatio <= maximumRestDelta &&
    peakFrameIndex >= restFrames &&
    peakFrameIndex < normalizedFrameCount - restFrames &&
    prominentPeakCount === 1 &&
    !nextInhaleStarted
    ? activeSegments
    : 0;

  return Object.freeze({
    completedBreathCycles,
    nextInhaleStarted,
    openingRestMeanArea,
    closingRestMeanArea,
    peakArea,
    peakFrameIndex,
    prominentPeakCount,
    amplitudeRatio,
    restAreaDeltaRatio,
    activeAreaThreshold
  });
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
  analyzeForegroundAreaCycle,
  analyzeLoopMotion,
  frameDelta
};
