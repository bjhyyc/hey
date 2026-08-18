import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { analyzeLoopMotion } = require("../../platform/src/qa/loop-motion-metrics");

function rgbaFrames(frameValues, width = 4, height = 2) {
  const frameBytes = width * height * 4;
  const bytes = Buffer.alloc(frameBytes * frameValues.length);
  frameValues.forEach((value, frameIndex) => {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = frameIndex * frameBytes + pixel * 4;
      bytes[offset] = value;
      bytes[offset + 1] = value;
      bytes[offset + 2] = value;
      bytes[offset + 3] = 255;
    }
  });
  return { bytes, width, height, frameCount: frameValues.length };
}

describe("decoded sleep-loop motion metrics", () => {
  it("reports a settled loop with identical endpoints", () => {
    const input = rgbaFrames([10, 10, 10, 30, 50, 30, 10, 10, 10]);
    const metrics = analyzeLoopMotion(input.bytes, { ...input, restMotionThreshold: 0.03, restWindowFrames: 2 });
    expect(metrics.seamPixelDelta).toBe(0);
    expect(metrics.firstRestFrameCount).toBe(2);
    expect(metrics.lastRestFrameCount).toBe(2);
    expect(metrics.terminalMotion).toBe(0);
  });

  it("detects a terminal jump and mismatched seam", () => {
    const input = rgbaFrames([10, 10, 20, 30, 80]);
    const metrics = analyzeLoopMotion(input.bytes, { ...input, restMotionThreshold: 0.03, restWindowFrames: 2 });
    expect(metrics.seamPixelDelta).toBeGreaterThan(0.1);
    expect(metrics.terminalMotion).toBeGreaterThan(0.1);
    expect(metrics.lastRestFrameCount).toBe(1);
  });

  it("rejects an incomplete byte stream", () => {
    expect(() => analyzeLoopMotion(Buffer.alloc(16), { width: 2, height: 2, frameCount: 2 })).toThrow(/byte size/i);
  });
});
