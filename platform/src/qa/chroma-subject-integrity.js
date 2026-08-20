"use strict";

const CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION = "petpack-chroma-subject-integrity/v1";

// The enclosed ceiling is measured, not guessed: re-running this metric over
// all 35 masters the platform has produced puts every one of them at or below
// 0.0492, and the eleven that failed quality at or below 0.0095 - none of them
// was actually torn. 0.12 leaves that population untouched while a subject
// with an eighth of its area punched out is unmistakably a broken cutout.
//
// A still master is judged on holes punched through the subject, never on how
// deep its silhouette gaps are: a dog photographed head-on with its legs apart
// puts a tenth of every row's span between the legs, and the row-span measure
// cannot tell that from a torn cutout. Motion keeps the span measure, where a
// silhouette warping between frames is the thing actually being watched.
const MASTER_STILL_THRESHOLDS = Object.freeze({ maximumRowSpanHoleRatio: 1 });

const DEFAULT_THRESHOLDS = Object.freeze({
  minimumForegroundRatio: 0.01,
  maximumForegroundRatio: 0.6,
  minimumTransparentBorderRatio: 0.95,
  maximumRowSpanHoleRatio: 0.12,
  maximumEnclosedHoleRatio: 0.12,
  minimumLargestComponentRatio: 0.97,
  maximumSignificantComponentCount: 1,
  maximumForegroundGreenSpillRatio: 0.08,
  maximumBackgroundResidualAlpha: 8,
  alphaForegroundThreshold: 32,
  alphaSolidThreshold: 128,
  greenSpillExcess: 45,
  significantComponentPixels: 64
});

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive integer`);
  return parsed;
}

function finiteRatio(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new TypeError(`${label} must be between zero and one`);
  return parsed;
}

function normalizeThresholds(overrides = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  for (const key of [
    "minimumForegroundRatio",
    "maximumForegroundRatio",
    "minimumTransparentBorderRatio",
    "maximumRowSpanHoleRatio",
    "maximumEnclosedHoleRatio",
    "minimumLargestComponentRatio",
    "maximumForegroundGreenSpillRatio"
  ]) {
    thresholds[key] = finiteRatio(thresholds[key], key);
  }
  for (const key of [
    "maximumSignificantComponentCount",
    "alphaForegroundThreshold",
    "alphaSolidThreshold",
    "greenSpillExcess",
    "significantComponentPixels"
  ]) {
    thresholds[key] = positiveInteger(thresholds[key], key);
  }
  if (thresholds.minimumForegroundRatio > thresholds.maximumForegroundRatio) {
    throw new TypeError("Foreground ratio thresholds are inverted");
  }
  if (thresholds.alphaForegroundThreshold > thresholds.alphaSolidThreshold || thresholds.alphaSolidThreshold > 255) {
    throw new TypeError("Alpha thresholds are invalid");
  }
  return Object.freeze(thresholds);
}

function analyzeComponents(mask, width, height, significantComponentPixels) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let componentCount = 0;
  let significantComponentCount = 0;
  let largestComponentPixels = 0;

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] !== 0) continue;
    componentCount += 1;
    visited[start] = 1;
    let head = 0;
    let tail = 1;
    let pixels = 0;
    queue[0] = start;
    while (head < tail) {
      const current = queue[head];
      head += 1;
      pixels += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      const neighbours = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1
      ];
      for (const neighbour of neighbours) {
        if (neighbour < 0 || mask[neighbour] === 0 || visited[neighbour] !== 0) continue;
        visited[neighbour] = 1;
        queue[tail] = neighbour;
        tail += 1;
      }
    }
    if (pixels >= significantComponentPixels) significantComponentCount += 1;
    if (pixels > largestComponentPixels) largestComponentPixels = pixels;
  }
  return { componentCount, significantComponentCount, largestComponentPixels };
}

/**
 * Transparent pixels the background cannot reach - genuine holes punched
 * through the subject. Flood-filling the background inward from the canvas
 * border is what separates them from the gaps a silhouette legitimately has:
 * the space between four legs, or between an ear and the head, opens onto the
 * background and is therefore not a hole at all.
 */
function measureEnclosedHoles(mask, width, height) {
  const outside = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let tail = 0;
  const push = (index) => {
    if (mask[index] !== 0 || outside[index] !== 0) return;
    outside[index] = 1;
    queue[tail] = index;
    tail += 1;
  };
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }
  for (let head = 0; head < tail; head += 1) {
    const current = queue[head];
    const x = current % width;
    const y = (current - x) / width;
    if (x > 0) push(current - 1);
    if (x + 1 < width) push(current + 1);
    if (y > 0) push(current - width);
    if (y + 1 < height) push(current + width);
  }
  let enclosedHolePixels = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0 && outside[index] === 0) enclosedHolePixels += 1;
  }
  return enclosedHolePixels;
}

function analyzeChromaSubjectFrame(bytes, { width, height, thresholds: thresholdOverrides } = {}) {
  const normalizedWidth = positiveInteger(width, "Frame width");
  const normalizedHeight = positiveInteger(height, "Frame height");
  const thresholds = normalizeThresholds(thresholdOverrides);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError("RGBA frame bytes are required");
  }
  const expectedBytes = normalizedWidth * normalizedHeight * 4;
  if (bytes.length !== expectedBytes) throw new TypeError("RGBA frame byte size does not match its dimensions");

  const pixelCount = normalizedWidth * normalizedHeight;
  const mask = new Uint8Array(pixelCount);
  let foregroundPixels = 0;
  let solidForegroundPixels = 0;
  let greenSpillPixels = 0;
  let borderPixels = 0;
  let maximumBorderAlpha = 0;
  let transparentBorderPixels = 0;
  let minX = normalizedWidth;
  let minY = normalizedHeight;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < normalizedHeight; y += 1) {
    for (let x = 0; x < normalizedWidth; x += 1) {
      const pixelIndex = y * normalizedWidth + x;
      const byteIndex = pixelIndex * 4;
      const red = bytes[byteIndex];
      const green = bytes[byteIndex + 1];
      const blue = bytes[byteIndex + 2];
      const alpha = bytes[byteIndex + 3];
      const border = x < 8 || y < 8 || x >= normalizedWidth - 8 || y >= normalizedHeight - 8;
      if (border) {
        borderPixels += 1;
        if (alpha < thresholds.alphaForegroundThreshold) transparentBorderPixels += 1;
        if (alpha > maximumBorderAlpha) maximumBorderAlpha = alpha;
      }
      if (alpha < thresholds.alphaForegroundThreshold) continue;
      mask[pixelIndex] = 1;
      foregroundPixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (alpha >= thresholds.alphaSolidThreshold) {
        solidForegroundPixels += 1;
        if (green - (red + blue) / 2 > thresholds.greenSpillExcess) greenSpillPixels += 1;
      }
    }
  }

  let rowSpanPixels = 0;
  let rowSpanHolePixels = 0;
  for (let y = 0; y < normalizedHeight; y += 1) {
    let first = -1;
    let last = -1;
    const rowOffset = y * normalizedWidth;
    for (let x = 0; x < normalizedWidth; x += 1) {
      if (mask[rowOffset + x] === 0) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0) continue;
    rowSpanPixels += last - first + 1;
    for (let x = first; x <= last; x += 1) {
      if (mask[rowOffset + x] === 0) rowSpanHolePixels += 1;
    }
  }

  const enclosedHolePixels = measureEnclosedHoles(mask, normalizedWidth, normalizedHeight);
  const components = analyzeComponents(mask, normalizedWidth, normalizedHeight, thresholds.significantComponentPixels);
  const boundingBox = foregroundPixels === 0
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return Object.freeze({
    width: normalizedWidth,
    height: normalizedHeight,
    foregroundRatio: foregroundPixels / pixelCount,
    transparentBorderRatio: transparentBorderPixels / Math.max(1, borderPixels),
    rowSpanHoleRatio: rowSpanHolePixels / Math.max(1, rowSpanPixels),
    enclosedHoleRatio: enclosedHolePixels / Math.max(1, foregroundPixels + enclosedHolePixels),
    largestComponentRatio: components.largestComponentPixels / Math.max(1, foregroundPixels),
    significantComponentCount: components.significantComponentCount,
    componentCount: components.componentCount,
    foregroundGreenSpillRatio: greenSpillPixels / Math.max(1, solidForegroundPixels),
    maximumBorderAlpha,
    boundingBox
  });
}

function evaluateChromaSubjectIntegrity(metrics, thresholdOverrides) {
  if (!metrics || typeof metrics !== "object") throw new TypeError("Chroma subject metrics are required");
  const thresholds = normalizeThresholds(thresholdOverrides);
  const errors = [];
  for (const key of [
    "foregroundRatio",
    "transparentBorderRatio",
    "rowSpanHoleRatio",
    "enclosedHoleRatio",
    "largestComponentRatio",
    "foregroundGreenSpillRatio"
  ]) {
    if (!Number.isFinite(Number(metrics[key])) || Number(metrics[key]) < 0 || Number(metrics[key]) > 1) {
      errors.push(`subject_metric_invalid:${key}`);
    }
  }
  if (!Number.isSafeInteger(Number(metrics.significantComponentCount)) ||
      Number(metrics.significantComponentCount) < 0) {
    errors.push("subject_metric_invalid:significantComponentCount");
  }
  if (!Number.isSafeInteger(Number(metrics.componentCount)) || Number(metrics.componentCount) < 0) {
    errors.push("subject_metric_invalid:componentCount");
  }
  if (errors.length > 0) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors), thresholds });
  }
  if (metrics.foregroundRatio < thresholds.minimumForegroundRatio) errors.push("subject_foreground_too_small");
  if (metrics.foregroundRatio > thresholds.maximumForegroundRatio) errors.push("subject_foreground_too_large");
  if (metrics.transparentBorderRatio < thresholds.minimumTransparentBorderRatio) errors.push("subject_touches_canvas_border");
  if (metrics.enclosedHoleRatio > thresholds.maximumEnclosedHoleRatio) errors.push("subject_internal_holes_detected");
  if (metrics.rowSpanHoleRatio > thresholds.maximumRowSpanHoleRatio) errors.push("subject_silhouette_span_gaps");
  if (metrics.largestComponentRatio < thresholds.minimumLargestComponentRatio) errors.push("subject_fragmented");
  if (metrics.significantComponentCount > thresholds.maximumSignificantComponentCount) errors.push("subject_multiple_components");
  if (metrics.foregroundGreenSpillRatio > thresholds.maximumForegroundGreenSpillRatio) errors.push("subject_green_spill_detected");
  // A letterbox band filled with limited-range black merges as a faint but
  // visible alpha haze (16/255). It stays under the foreground threshold, so it
  // must be judged separately: background pixels have to be truly transparent.
  if (Number.isFinite(Number(metrics.maximumBorderAlpha)) &&
      Number(metrics.maximumBorderAlpha) > thresholds.maximumBackgroundResidualAlpha) {
    errors.push("subject_border_residual_alpha");
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), thresholds });
}

function validateChromaSubjectInspection(inspection, {
  production = false,
  expectedFrameCount = 1,
  thresholds
} = {}) {
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    return production
      ? { ok: false, errors: ["Chroma subject inspection is required"], evidence: null }
      : { ok: true, errors: [], evidence: null };
  }
  const errors = [];
  if (inspection.contractVersion !== CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION) {
    errors.push(`Chroma subject contractVersion must be ${CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION}`);
  }
  if (inspection.measuredFromDecodedOutput !== true) {
    errors.push("Chroma subject inspection must use decoded output frames");
  }
  if (inspection.fullFrameCoverage !== true) {
    errors.push("Chroma subject inspection must cover every output frame");
  }
  const normalizedExpectedFrameCount = Number(expectedFrameCount);
  const sampledFrameCount = Number(inspection.sampledFrameCount);
  if (!Number.isSafeInteger(normalizedExpectedFrameCount) || normalizedExpectedFrameCount < 1 ||
      !Number.isSafeInteger(sampledFrameCount) || sampledFrameCount !== normalizedExpectedFrameCount) {
    errors.push("Chroma subject inspection frame count is inconsistent");
  }
  let decision;
  try {
    decision = evaluateChromaSubjectIntegrity(inspection.worstFrame, thresholds);
  } catch {
    decision = { ok: false, errors: ["subject_metrics_invalid"], thresholds: normalizeThresholds(thresholds) };
  }
  for (const error of decision.errors) errors.push(`worstFrame: ${error}`);
  return {
    ok: errors.length === 0,
    errors,
    evidence: {
      contractVersion: inspection.contractVersion,
      measuredFromDecodedOutput: inspection.measuredFromDecodedOutput === true,
      fullFrameCoverage: inspection.fullFrameCoverage === true,
      sampledFrameCount,
      worstFrame: inspection.worstFrame || null
    }
  };
}

module.exports = {
  CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION,
  DEFAULT_THRESHOLDS,
  MASTER_STILL_THRESHOLDS,
  analyzeChromaSubjectFrame,
  evaluateChromaSubjectIntegrity,
  normalizeThresholds,
  validateChromaSubjectInspection
};
