"use strict";

const { ACTION_ENDPOINTS } = require("../domain/action-catalog");

// Calibrated against the real 2026-08-16 Seedance batch: genuine endpoint
// adherence shows sub-pixel centroid drift and tiny premultiplied deltas, so
// those two remain the sharp discriminators. Mask/bbox IoU carries a
// systematic edge-band deficit from keying and matte-closing differences and
// is tolerated down to the measured floor of real compliant output.
const DEFAULT_ENDPOINT_THRESHOLDS = Object.freeze({
  alphaThreshold: 32,
  minimumMaskIoU: 0.85,
  minimumBoundingBoxIoU: 0.88,
  maximumCentroidDeltaPx: 5,
  maximumPremultipliedMeanAbsoluteDelta: 0.02
});
const DECODED_ENDPOINT_CONTRACT_VERSION = "petpack-decoded-endpoint-continuity/v1";
const TRUSTED_ENDPOINT_DECODER_KIND = "ffmpeg-libvpx-vp9-rgba/v1";
const TRUSTED_ENDPOINT_EVIDENCE_CLASS = "production-trusted-decoded-media";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive integer`);
  return parsed;
}

function finite(value, label, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new TypeError(`${label} is outside its allowed range`);
  return parsed;
}

function normalizeEndpointThresholds(overrides = {}) {
  const thresholds = { ...DEFAULT_ENDPOINT_THRESHOLDS, ...overrides };
  thresholds.alphaThreshold = positiveInteger(thresholds.alphaThreshold, "alphaThreshold");
  if (thresholds.alphaThreshold > 255) throw new TypeError("alphaThreshold is outside its allowed range");
  thresholds.minimumMaskIoU = finite(thresholds.minimumMaskIoU, "minimumMaskIoU", { max: 1 });
  thresholds.minimumBoundingBoxIoU = finite(thresholds.minimumBoundingBoxIoU, "minimumBoundingBoxIoU", { max: 1 });
  thresholds.maximumCentroidDeltaPx = finite(thresholds.maximumCentroidDeltaPx, "maximumCentroidDeltaPx");
  thresholds.maximumPremultipliedMeanAbsoluteDelta = finite(
    thresholds.maximumPremultipliedMeanAbsoluteDelta,
    "maximumPremultipliedMeanAbsoluteDelta",
    { max: 1 }
  );
  return Object.freeze(thresholds);
}

function requireRgba(bytes, width, height, label) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError(`${label} RGBA bytes are required`);
  if (bytes.length !== width * height * 4) throw new TypeError(`${label} RGBA byte size does not match its dimensions`);
}

function boundsIoU(first, second) {
  if (!first || !second) return 0;
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  const intersection = Math.max(0, right - left + 1) * Math.max(0, bottom - top + 1);
  const firstArea = (first.right - first.left + 1) * (first.bottom - first.top + 1);
  const secondArea = (second.right - second.left + 1) * (second.bottom - second.top + 1);
  return intersection / Math.max(1, firstArea + secondArea - intersection);
}

function compareRgbaFrames(referenceBytes, candidateBytes, { width, height, alphaThreshold = 32 } = {}) {
  const normalizedWidth = positiveInteger(width, "Frame width");
  const normalizedHeight = positiveInteger(height, "Frame height");
  const normalizedAlphaThreshold = positiveInteger(alphaThreshold, "alphaThreshold");
  if (normalizedAlphaThreshold > 255) throw new TypeError("alphaThreshold is outside its allowed range");
  requireRgba(referenceBytes, normalizedWidth, normalizedHeight, "Reference frame");
  requireRgba(candidateBytes, normalizedWidth, normalizedHeight, "Candidate frame");

  let intersection = 0;
  let union = 0;
  let absoluteDelta = 0;
  let referenceCount = 0;
  let candidateCount = 0;
  let referenceX = 0;
  let referenceY = 0;
  let candidateX = 0;
  let candidateY = 0;
  const referenceBounds = { left: normalizedWidth, top: normalizedHeight, right: -1, bottom: -1 };
  const candidateBounds = { left: normalizedWidth, top: normalizedHeight, right: -1, bottom: -1 };

  for (let y = 0; y < normalizedHeight; y += 1) {
    for (let x = 0; x < normalizedWidth; x += 1) {
      const offset = (y * normalizedWidth + x) * 4;
      const referenceAlphaByte = referenceBytes[offset + 3];
      const candidateAlphaByte = candidateBytes[offset + 3];
      const referenceOn = referenceAlphaByte >= normalizedAlphaThreshold;
      const candidateOn = candidateAlphaByte >= normalizedAlphaThreshold;
      if (referenceOn && candidateOn) intersection += 1;
      if (referenceOn || candidateOn) union += 1;
      if (referenceOn) {
        referenceCount += 1;
        referenceX += x;
        referenceY += y;
        referenceBounds.left = Math.min(referenceBounds.left, x);
        referenceBounds.top = Math.min(referenceBounds.top, y);
        referenceBounds.right = Math.max(referenceBounds.right, x);
        referenceBounds.bottom = Math.max(referenceBounds.bottom, y);
      }
      if (candidateOn) {
        candidateCount += 1;
        candidateX += x;
        candidateY += y;
        candidateBounds.left = Math.min(candidateBounds.left, x);
        candidateBounds.top = Math.min(candidateBounds.top, y);
        candidateBounds.right = Math.max(candidateBounds.right, x);
        candidateBounds.bottom = Math.max(candidateBounds.bottom, y);
      }
      const referenceAlpha = referenceAlphaByte / 255;
      const candidateAlpha = candidateAlphaByte / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        const reference = (referenceBytes[offset + channel] / 255) * referenceAlpha;
        const candidate = (candidateBytes[offset + channel] / 255) * candidateAlpha;
        absoluteDelta += Math.abs(reference - candidate);
      }
      absoluteDelta += Math.abs(referenceAlpha - candidateAlpha);
    }
  }

  const referenceCentroid = referenceCount > 0
    ? { x: referenceX / referenceCount, y: referenceY / referenceCount }
    : null;
  const candidateCentroid = candidateCount > 0
    ? { x: candidateX / candidateCount, y: candidateY / candidateCount }
    : null;
  const centroidDeltaPx = referenceCentroid && candidateCentroid
    ? Math.hypot(referenceCentroid.x - candidateCentroid.x, referenceCentroid.y - candidateCentroid.y)
    : Number.POSITIVE_INFINITY;
  return Object.freeze({
    width: normalizedWidth,
    height: normalizedHeight,
    maskIoU: intersection / Math.max(1, union),
    boundingBoxIoU: boundsIoU(
      referenceCount > 0 ? referenceBounds : null,
      candidateCount > 0 ? candidateBounds : null
    ),
    centroidDeltaPx,
    premultipliedMeanAbsoluteDelta: absoluteDelta / (normalizedWidth * normalizedHeight * 4),
    referenceForegroundPixels: referenceCount,
    candidateForegroundPixels: candidateCount
  });
}

function evaluateEndpointFrameContinuity(metrics, thresholdOverrides) {
  if (!metrics || typeof metrics !== "object") throw new TypeError("Endpoint frame metrics are required");
  const thresholds = normalizeEndpointThresholds(thresholdOverrides);
  const errors = [];
  const requiredFiniteMetrics = [
    "maskIoU",
    "boundingBoxIoU",
    "centroidDeltaPx",
    "premultipliedMeanAbsoluteDelta",
    "referenceForegroundPixels",
    "candidateForegroundPixels"
  ];
  if (requiredFiniteMetrics.some((key) => !Number.isFinite(Number(metrics[key])))) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze(["endpoint_metrics_incomplete"]),
      thresholds
    });
  }
  if (metrics.maskIoU < thresholds.minimumMaskIoU) errors.push("endpoint_mask_iou_below_threshold");
  if (metrics.boundingBoxIoU < thresholds.minimumBoundingBoxIoU) errors.push("endpoint_bounds_iou_below_threshold");
  if (metrics.centroidDeltaPx > thresholds.maximumCentroidDeltaPx) errors.push("endpoint_centroid_delta_above_threshold");
  if (metrics.premultipliedMeanAbsoluteDelta > thresholds.maximumPremultipliedMeanAbsoluteDelta) {
    errors.push("endpoint_pixel_delta_above_threshold");
  }
  if (metrics.referenceForegroundPixels < 1 || metrics.candidateForegroundPixels < 1) errors.push("endpoint_foreground_missing");
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), thresholds });
}

function validateDecodedEndpointInspection(inspection, {
  production = false,
  thresholds,
  actionId = null,
  expectedFirstMasterHash = null,
  expectedLastMasterHash = null,
  expectedOutputHash = null,
  expectedFrameCount = null
} = {}) {
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    return production
      ? { ok: false, errors: ["Decoded endpoint inspection is required"], evidence: null }
      : { ok: true, errors: [], evidence: null };
  }
  const errors = [];
  if (inspection.contractVersion !== DECODED_ENDPOINT_CONTRACT_VERSION) {
    errors.push(`Decoded endpoint contractVersion must be ${DECODED_ENDPOINT_CONTRACT_VERSION}`);
  }
  if (inspection.measuredFromDecodedOutput !== true) errors.push("Decoded endpoint inspection must use decoded output frames");
  const first = evaluateEndpointFrameContinuity(inspection.firstFrame || {}, thresholds);
  const last = evaluateEndpointFrameContinuity(inspection.lastFrame || {}, thresholds);
  for (const error of first.errors) errors.push(`firstFrame: ${error}`);
  for (const error of last.errors) errors.push(`lastFrame: ${error}`);
  if (production) {
    const endpoint = typeof actionId === "string" ? ACTION_ENDPOINTS[actionId] : null;
    if (!endpoint) errors.push("Decoded endpoint inspection requires a supported actionId");
    if (inspection.actionId !== actionId) errors.push("Decoded endpoint actionId does not match the frozen action");
    if (inspection.evidenceClass !== TRUSTED_ENDPOINT_EVIDENCE_CLASS) {
      errors.push(`Decoded endpoint evidenceClass must be ${TRUSTED_ENDPOINT_EVIDENCE_CLASS}`);
    }
    if (!inspection.trustedDecoder || inspection.trustedDecoder.kind !== TRUSTED_ENDPOINT_DECODER_KIND) {
      errors.push(`Decoded endpoint trustedDecoder.kind must be ${TRUSTED_ENDPOINT_DECODER_KIND}`);
    }
    if (!SHA256_PATTERN.test(inspection.trustedDecoder?.executableSha256 || "")) {
      errors.push("Decoded endpoint trusted decoder SHA-256 is required");
    }
    const outputFrameCount = Number(inspection.outputFrameCount);
    if (!Number.isSafeInteger(outputFrameCount) || outputFrameCount < 2 || outputFrameCount > 3600) {
      errors.push("Decoded endpoint outputFrameCount is invalid");
    }
    const frozenFrameCount = Number(expectedFrameCount);
    if (!Number.isSafeInteger(frozenFrameCount) || frozenFrameCount < 2 || frozenFrameCount > 3600) {
      errors.push("Frozen expected output frame count is required");
    } else if (outputFrameCount !== frozenFrameCount) {
      errors.push("Decoded endpoint outputFrameCount does not match the frozen media frame count");
    }
    if (!Array.isArray(inspection.endpointFrameIndices) || inspection.endpointFrameIndices.length !== 2 ||
        inspection.endpointFrameIndices[0] !== 0 || inspection.endpointFrameIndices[1] !== outputFrameCount - 1) {
      errors.push("Decoded endpoint frame indices do not cover the first and terminal output frames");
    }
    if (inspection.terminalFrameMatches !== true) {
      errors.push("Decoded endpoint terminal frame is not confirmed against its frozen master");
    }
    if (endpoint && inspection.firstMasterKind !== endpoint.firstMaster) {
      errors.push("Decoded endpoint first master kind does not match the action contract");
    }
    if (endpoint && inspection.lastMasterKind !== endpoint.lastMaster) {
      errors.push("Decoded endpoint last master kind does not match the action contract");
    }
    for (const [field, expected, label] of [
      ["firstMasterSha256", expectedFirstMasterHash, "first master"],
      ["lastMasterSha256", expectedLastMasterHash, "last master"],
      ["outputSha256", expectedOutputHash, "output"]
    ]) {
      if (!SHA256_PATTERN.test(inspection[field] || "")) {
        errors.push(`Decoded endpoint ${label} SHA-256 is required`);
      }
      if (!SHA256_PATTERN.test(expected || "")) {
        errors.push(`Frozen expected ${label} SHA-256 is required`);
      } else if (inspection[field] !== expected) {
        errors.push(`Decoded endpoint ${label} SHA-256 does not match the frozen asset`);
      }
    }
  }
  const evidence = production
    ? {
        contractVersion: inspection.contractVersion,
        measuredFromDecodedOutput: inspection.measuredFromDecodedOutput === true,
        trustedDecoder: inspection.trustedDecoder ? {
          kind: inspection.trustedDecoder.kind,
          executableSha256: inspection.trustedDecoder.executableSha256
        } : null,
        actionId: inspection.actionId,
        outputSha256: inspection.outputSha256,
        outputFrameCount: inspection.outputFrameCount,
        endpointFrameIndices: Array.isArray(inspection.endpointFrameIndices)
          ? [...inspection.endpointFrameIndices]
          : null,
        firstMasterKind: inspection.firstMasterKind,
        lastMasterKind: inspection.lastMasterKind,
        firstMasterSha256: inspection.firstMasterSha256,
        lastMasterSha256: inspection.lastMasterSha256,
        firstFrame: inspection.firstFrame || null,
        lastFrame: inspection.lastFrame || null,
        terminalFrameMatches: inspection.terminalFrameMatches === true,
        evidenceClass: inspection.evidenceClass
      }
    : {
        contractVersion: inspection.contractVersion,
        measuredFromDecodedOutput: inspection.measuredFromDecodedOutput === true,
        firstFrame: inspection.firstFrame || null,
        lastFrame: inspection.lastFrame || null
      };
  return {
    ok: errors.length === 0,
    errors,
    evidence
  };
}

module.exports = {
  DECODED_ENDPOINT_CONTRACT_VERSION,
  DEFAULT_ENDPOINT_THRESHOLDS,
  TRUSTED_ENDPOINT_DECODER_KIND,
  TRUSTED_ENDPOINT_EVIDENCE_CLASS,
  compareRgbaFrames,
  evaluateEndpointFrameContinuity,
  normalizeEndpointThresholds,
  validateDecodedEndpointInspection
};
