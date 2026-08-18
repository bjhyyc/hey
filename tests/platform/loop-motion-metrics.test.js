import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { analyzeForegroundAreaCycle, analyzeLoopMotion } = require("../../platform/src/qa/loop-motion-metrics");

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

function alphaAreaFrames(areas, width = 10, height = 10) {
  const frameBytes = width * height * 4;
  const bytes = Buffer.alloc(frameBytes * areas.length);
  areas.forEach((area, frameIndex) => {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      bytes[frameIndex * frameBytes + pixel * 4 + 3] = pixel < area ? 255 : 0;
    }
  });
  return { bytes, width, height, frameCount: areas.length };
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

  it("detects one smoothed expand-and-return breathing area cycle", () => {
    const input = alphaAreaFrames([
      40, 40, 40, 40,
      42, 48, 55, 62, 70, 62, 55, 48, 42,
      40, 40, 40, 40
    ]);
    const metrics = analyzeForegroundAreaCycle(input.bytes, {
      ...input,
      restWindowFrames: 2,
      smoothingWindowFrames: 3,
      minimumAmplitudeRatio: 0.1,
      activeFraction: 0.35,
      minimumActiveSegmentFrames: 2,
      maximumRestAreaDeltaRatio: 0.05
    });
    expect(metrics.completedBreathCycles).toBe(1);
    expect(metrics.nextInhaleStarted).toBe(false);
    expect(metrics.amplitudeRatio).toBeGreaterThan(0.1);
  });

  it("does not accept an expansion that starts a second inhale at the tail", () => {
    const input = alphaAreaFrames([
      40, 40, 40, 42, 50, 62, 70, 62, 50, 42,
      40, 42, 48, 56, 64, 70, 72
    ]);
    const metrics = analyzeForegroundAreaCycle(input.bytes, {
      ...input,
      restWindowFrames: 2,
      smoothingWindowFrames: 3,
      minimumAmplitudeRatio: 0.1,
      activeFraction: 0.35,
      minimumActiveSegmentFrames: 2,
      maximumRestAreaDeltaRatio: 0.1
    });
    expect(metrics.completedBreathCycles).toBe(0);
    expect(metrics.nextInhaleStarted).toBe(true);
  });

  it("rejects a static loop instead of inventing a breath", () => {
    const input = alphaAreaFrames(Array.from({ length: 20 }, () => 40));
    const metrics = analyzeForegroundAreaCycle(input.bytes, {
      ...input,
      restWindowFrames: 4,
      smoothingWindowFrames: 3,
      minimumAmplitudeRatio: 0.015,
      activeFraction: 0.35,
      minimumActiveSegmentFrames: 4,
      maximumRestAreaDeltaRatio: 0.015
    });
    expect(metrics.completedBreathCycles).toBe(0);
    expect(metrics.amplitudeRatio).toBe(0);
  });

  it("rejects two complete expand-and-return cycles", () => {
    const input = alphaAreaFrames([
      40, 40, 40, 40,
      42, 50, 62, 74, 62, 50, 42,
      40, 40,
      42, 50, 62, 74, 62, 50, 42,
      40, 40, 40, 40
    ]);
    const metrics = analyzeForegroundAreaCycle(input.bytes, {
      ...input,
      restWindowFrames: 4,
      smoothingWindowFrames: 3,
      minimumAmplitudeRatio: 0.1,
      activeFraction: 0.35,
      minimumActiveSegmentFrames: 3,
      maximumRestAreaDeltaRatio: 0.05
    });
    expect(metrics.completedBreathCycles).toBe(0);
  });

  it("rejects a double peak even when the second inhale does not fully return to rest", () => {
    const input = alphaAreaFrames([
      40, 40, 40, 40,
      42, 50, 62, 74, 62, 50, 42,
      58, 68, 76, 68, 58,
      40, 40, 40, 40
    ]);
    const metrics = analyzeForegroundAreaCycle(input.bytes, {
      ...input,
      restWindowFrames: 4,
      smoothingWindowFrames: 3,
      minimumAmplitudeRatio: 0.1,
      activeFraction: 0.35,
      minimumActiveSegmentFrames: 3,
      maximumRestAreaDeltaRatio: 0.05
    });
    expect(metrics.prominentPeakCount).toBeGreaterThan(1);
    expect(metrics.completedBreathCycles).toBe(0);
  });
});
