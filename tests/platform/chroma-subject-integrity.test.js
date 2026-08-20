import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION,
  analyzeChromaSubjectFrame,
  evaluateChromaSubjectIntegrity,
  validateChromaSubjectInspection
} = require("../../platform/src/qa/chroma-subject-integrity");

function frame(width = 120, height = 80) {
  return { width, height, bytes: Buffer.alloc(width * height * 4) };
}

function paint(target, x0, y0, x1, y1, rgba = [150, 130, 120, 255]) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * target.width + x) * 4;
      target.bytes[offset] = rgba[0];
      target.bytes[offset + 1] = rgba[1];
      target.bytes[offset + 2] = rgba[2];
      target.bytes[offset + 3] = rgba[3];
    }
  }
}

describe("chroma subject integrity", () => {
  it("accepts one clean connected subject with a transparent border", () => {
    const target = frame();
    paint(target, 30, 22, 90, 60);
    const metrics = analyzeChromaSubjectFrame(target.bytes, target);
    expect(evaluateChromaSubjectIntegrity(metrics)).toMatchObject({ ok: true, errors: [] });
    expect(metrics.largestComponentRatio).toBe(1);
    expect(metrics.significantComponentCount).toBe(1);
  });

  it("rejects green-key holes through the middle of a subject", () => {
    const target = frame();
    paint(target, 20, 18, 100, 65);
    paint(target, 38, 28, 82, 55, [0, 0, 0, 0]);
    const result = evaluateChromaSubjectIntegrity(analyzeChromaSubjectFrame(target.bytes, target));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subject_internal_holes_detected");
  });

  // A dog photographed head-on puts a tenth of every row's span between its
  // legs. The row-span measure counted that as a hole and rejected three
  // regenerations in a row of a paid order, so what counts as a hole is now
  // whatever the background cannot reach.
  it("does not mistake the gap between a subject's legs for a hole", () => {
    const target = frame();
    paint(target, 30, 18, 90, 45);
    paint(target, 34, 45, 46, 66);
    paint(target, 74, 45, 86, 66);
    const metrics = analyzeChromaSubjectFrame(target.bytes, target);

    expect(metrics.rowSpanHoleRatio).toBeGreaterThan(0.2);
    expect(metrics.enclosedHoleRatio).toBe(0);
    expect(evaluateChromaSubjectIntegrity(metrics, { maximumRowSpanHoleRatio: 1 }))
      .toMatchObject({ ok: true, errors: [] });
  });

  it("still rejects a cutout torn through the middle of the subject", () => {
    const target = frame();
    paint(target, 20, 18, 100, 65);
    paint(target, 46, 32, 74, 52, [0, 0, 0, 0]);
    const metrics = analyzeChromaSubjectFrame(target.bytes, target);

    expect(metrics.enclosedHoleRatio).toBeGreaterThan(0.12);
    const result = evaluateChromaSubjectIntegrity(metrics, { maximumRowSpanHoleRatio: 1 });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subject_internal_holes_detected");
  });

  it("rejects a subject split into multiple large components", () => {
    const target = frame();
    paint(target, 18, 20, 50, 62);
    paint(target, 70, 20, 102, 62);
    const result = evaluateChromaSubjectIntegrity(analyzeChromaSubjectFrame(target.bytes, target));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subject_fragmented");
    expect(result.errors).toContain("subject_multiple_components");
  });

  it("rejects green spill in solid foreground pixels", () => {
    const target = frame();
    paint(target, 30, 22, 90, 60, [35, 170, 45, 255]);
    const result = evaluateChromaSubjectIntegrity(analyzeChromaSubjectFrame(target.bytes, target));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subject_green_spill_detected");
  });

  it("rejects malformed frames and inverted thresholds", () => {
    expect(() => analyzeChromaSubjectFrame(Buffer.alloc(4), { width: 2, height: 2 })).toThrow(/byte size/i);
    expect(() => analyzeChromaSubjectFrame(Buffer.alloc(16), {
      width: 2,
      height: 2,
      thresholds: { minimumForegroundRatio: 0.8, maximumForegroundRatio: 0.2 }
    })).toThrow(/inverted/i);
  });

  it("fails closed when persisted metrics are missing or non-finite", () => {
    expect(evaluateChromaSubjectIntegrity({})).toMatchObject({ ok: false });
    expect(evaluateChromaSubjectIntegrity({
      foregroundRatio: Number.NaN,
      transparentBorderRatio: 1,
      rowSpanHoleRatio: 0,
      enclosedHoleRatio: 0,
      largestComponentRatio: 1,
      significantComponentCount: 1,
      componentCount: 1,
      foregroundGreenSpillRatio: 0
    }).errors).toContain("subject_metric_invalid:foregroundRatio");
  });

  it("requires decoded full-frame evidence in production", () => {
    expect(validateChromaSubjectInspection(null, { production: false })).toMatchObject({ ok: true });
    expect(validateChromaSubjectInspection(null, { production: true })).toMatchObject({
      ok: false,
      errors: ["Chroma subject inspection is required"]
    });

    const target = frame();
    paint(target, 30, 22, 90, 60);
    const worstFrame = analyzeChromaSubjectFrame(target.bytes, target);
    expect(validateChromaSubjectInspection({
      contractVersion: CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION,
      measuredFromDecodedOutput: true,
      fullFrameCoverage: true,
      sampledFrameCount: 96,
      worstFrame
    }, { production: true, expectedFrameCount: 96 })).toMatchObject({ ok: true, errors: [] });

    expect(validateChromaSubjectInspection({
      contractVersion: CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION,
      measuredFromDecodedOutput: true,
      fullFrameCoverage: false,
      sampledFrameCount: 3,
      worstFrame
    }, { production: true, expectedFrameCount: 96 })).toMatchObject({ ok: false });
  });
});
