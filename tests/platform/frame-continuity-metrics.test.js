import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  DECODED_ENDPOINT_CONTRACT_VERSION,
  TRUSTED_ENDPOINT_DECODER_KIND,
  TRUSTED_ENDPOINT_EVIDENCE_CLASS,
  compareRgbaFrames,
  evaluateEndpointFrameContinuity,
  validateDecodedEndpointInspection
} = require("../../platform/src/qa/frame-continuity-metrics");

function frame(width = 80, height = 60) {
  return { width, height, bytes: Buffer.alloc(width * height * 4) };
}

function paint(target, x0, y0, x1, y1, rgba = [180, 140, 110, 255]) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * target.width + x) * 4;
      target.bytes.set(rgba, offset);
    }
  }
}

describe("decoded endpoint frame continuity", () => {
  it("accepts the same decoded subject", () => {
    const reference = frame();
    paint(reference, 20, 15, 60, 48);
    const metrics = compareRgbaFrames(reference.bytes, Buffer.from(reference.bytes), reference);
    expect(metrics).toMatchObject({ maskIoU: 1, boundingBoxIoU: 1, centroidDeltaPx: 0, premultipliedMeanAbsoluteDelta: 0 });
    expect(evaluateEndpointFrameContinuity(metrics)).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects an endpoint shifted away from its master", () => {
    const reference = frame();
    const shifted = frame();
    paint(reference, 18, 15, 50, 48);
    paint(shifted, 28, 15, 60, 48);
    const result = evaluateEndpointFrameContinuity(compareRgbaFrames(reference.bytes, shifted.bytes, reference));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("endpoint_mask_iou_below_threshold");
    expect(result.errors).toContain("endpoint_centroid_delta_above_threshold");
  });

  it("rejects a green-key hole even when the outer bounds remain stable", () => {
    const reference = frame();
    const damaged = frame();
    paint(reference, 18, 15, 62, 50);
    paint(damaged, 18, 15, 62, 50);
    paint(damaged, 30, 24, 50, 42, [0, 0, 0, 0]);
    const result = evaluateEndpointFrameContinuity(compareRgbaFrames(reference.bytes, damaged.bytes, reference));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("endpoint_mask_iou_below_threshold");
    expect(result.errors).toContain("endpoint_pixel_delta_above_threshold");
  });

  it("rejects malformed buffers", () => {
    expect(() => compareRgbaFrames(Buffer.alloc(4), Buffer.alloc(4), { width: 2, height: 2 })).toThrow(/byte size/i);
  });

  it("requires decoded evidence in production while preserving legacy development fixtures", () => {
    expect(validateDecodedEndpointInspection(null, { production: false })).toMatchObject({ ok: true });
    expect(validateDecodedEndpointInspection(null, { production: true })).toMatchObject({
      ok: false,
      errors: ["Decoded endpoint inspection is required"]
    });
    const target = frame();
    paint(target, 20, 15, 60, 48);
    const metrics = compareRgbaFrames(target.bytes, target.bytes, target);
    const legacyEvidence = {
      contractVersion: DECODED_ENDPOINT_CONTRACT_VERSION,
      measuredFromDecodedOutput: true,
      firstFrame: metrics,
      lastFrame: metrics
    };
    expect(validateDecodedEndpointInspection(legacyEvidence, { production: false }))
      .toMatchObject({ ok: true, errors: [] });
    expect(validateDecodedEndpointInspection(legacyEvidence, {
      production: true,
      actionId: "sleep-transition",
      expectedFirstMasterHash: "1".repeat(64),
      expectedLastMasterHash: "2".repeat(64),
      expectedOutputHash: "3".repeat(64)
    })).toMatchObject({ ok: false });

    const trustedEvidence = {
      ...legacyEvidence,
      trustedDecoder: {
        kind: TRUSTED_ENDPOINT_DECODER_KIND,
        executableSha256: "4".repeat(64)
      },
      actionId: "sleep-transition",
      outputSha256: "3".repeat(64),
      outputFrameCount: 144,
      endpointFrameIndices: [0, 143],
      firstMasterKind: "front",
      lastMasterKind: "sleep",
      firstMasterSha256: "1".repeat(64),
      lastMasterSha256: "2".repeat(64),
      terminalFrameMatches: true,
      evidenceClass: TRUSTED_ENDPOINT_EVIDENCE_CLASS
    };
    expect(validateDecodedEndpointInspection(trustedEvidence, {
      production: true,
      actionId: "sleep-transition",
      expectedFirstMasterHash: "1".repeat(64),
      expectedLastMasterHash: "2".repeat(64),
      expectedOutputHash: "3".repeat(64)
    })).toMatchObject({
      ok: true,
      errors: [],
      evidence: {
        actionId: "sleep-transition",
        outputSha256: "3".repeat(64),
        terminalFrameMatches: true
      }
    });
  });
});
