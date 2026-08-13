import { describe, expect, it } from "vitest";
import {
  PIXEL_HIT_OPAQUE,
  PIXEL_HIT_TRANSPARENT,
  PIXEL_HIT_UNKNOWN,
  createAlphaHitState,
  getEffectiveGreenScreenAlpha,
  getObjectContainRect,
  mapPointToObjectContain,
  resolvePixelMousePassthrough,
  updateAlphaHitState
} from "../../src/renderer/pet/pixel-hit-test.js";

describe("object-fit contain pixel mapping", () => {
  it("letterboxes a wide source vertically and maps to source pixels", () => {
    const rect = getObjectContainRect(
      { x: 100, y: 50, width: 200, height: 200 },
      { width: 400, height: 200 }
    );
    expect(rect).toEqual({ x: 100, y: 100, width: 200, height: 100 });

    expect(mapPointToObjectContain({
      point: { x: 200, y: 150 },
      elementRect: { x: 100, y: 50, width: 200, height: 200 },
      intrinsicSize: { width: 400, height: 200 }
    })).toEqual(expect.objectContaining({
      status: "mapped",
      normalizedX: 0.5,
      normalizedY: 0.5,
      sourceX: 200,
      sourceY: 100,
      pixelX: 200,
      pixelY: 100
    }));
  });

  it("letterboxes a tall source horizontally", () => {
    expect(getObjectContainRect(
      { left: 10, top: 20, width: 200, height: 100 },
      { width: 100, height: 200 }
    )).toEqual({ x: 85, y: 20, width: 50, height: 100 });
  });

  it("distinguishes letterbox space, exclusive edges, and unknown geometry", () => {
    const input = {
      elementRect: { x: 0, y: 0, width: 200, height: 200 },
      intrinsicSize: { width: 400, height: 200 }
    };
    expect(mapPointToObjectContain({ ...input, point: { x: 100, y: 25 } }).status).toBe("outside");
    expect(mapPointToObjectContain({ ...input, point: { x: 199.999, y: 149.999 } }).status).toBe("mapped");
    expect(mapPointToObjectContain({ ...input, point: { x: 200, y: 150 } }).status).toBe("outside");
    expect(mapPointToObjectContain({ point: { x: 1, y: 1 }, elementRect: input.elementRect }).status).toBe("unknown");
  });

  it("clamps the final mapped source pixel", () => {
    const result = mapPointToObjectContain({
      point: { x: 99.999, y: 99.999 },
      elementRect: { x: 0, y: 0, width: 100, height: 100 },
      intrinsicSize: { width: 10, height: 10 }
    });
    expect(result).toEqual(expect.objectContaining({ pixelX: 9, pixelY: 9 }));
  });
});

describe("green-screen effective alpha", () => {
  it("preserves the source alpha when keying is disabled", () => {
    expect(getEffectiveGreenScreenAlpha(
      { r: 0, g: 255, b: 0, a: 73 },
      { enabled: false }
    )).toBe(73);
  });

  it("makes pixels inside the key tolerance transparent", () => {
    expect(getEffectiveGreenScreenAlpha(
      { r: 0, g: 250, b: 2, a: 255 },
      { enabled: true, color: "#00ff00", tolerance: 0.05, softness: 0.1 }
    )).toBe(0);
  });

  it("applies a linear alpha fade within the softness band", () => {
    expect(getEffectiveGreenScreenAlpha(
      { r: 51, g: 51, b: 51, a: 200 },
      { enabled: true, color: { r: 0, g: 0, b: 0 }, tolerance: 0.1, softness: 0.2 }
    )).toBe(100);
  });

  it("preserves far-away colors and defaults to a green key", () => {
    expect(getEffectiveGreenScreenAlpha(
      { r: 255, g: 0, b: 0, a: 221 },
      { enabled: true, tolerance: 0.05, softness: 0.05 }
    )).toBe(221);
  });
});

describe("alpha hit-state reducer", () => {
  it("requires two consecutive transparent frames from an unknown state", () => {
    const first = updateAlphaHitState(createAlphaHitState(), 0);
    expect(first).toEqual({
      classification: PIXEL_HIT_UNKNOWN,
      transparentFrames: 1,
      changed: false,
      sampleKnown: true
    });

    const second = updateAlphaHitState(first, 0);
    expect(second).toEqual({
      classification: PIXEL_HIT_TRANSPARENT,
      transparentFrames: 2,
      changed: true,
      sampleKnown: true
    });
  });

  it("recovers opaque interaction immediately", () => {
    const next = updateAlphaHitState(createAlphaHitState(PIXEL_HIT_TRANSPARENT), 24);
    expect(next.classification).toBe(PIXEL_HIT_OPAQUE);
    expect(next.transparentFrames).toBe(0);
    expect(next.changed).toBe(true);
  });

  it("uses hysteresis in the middle alpha band", () => {
    expect(updateAlphaHitState(createAlphaHitState(PIXEL_HIT_OPAQUE), 16).classification)
      .toBe(PIXEL_HIT_OPAQUE);
    expect(updateAlphaHitState(createAlphaHitState(PIXEL_HIT_TRANSPARENT), 16).classification)
      .toBe(PIXEL_HIT_TRANSPARENT);
  });

  it("resets an incomplete transparent run and retains state on an unknown sample", () => {
    const candidate = updateAlphaHitState(createAlphaHitState(PIXEL_HIT_OPAQUE), 8);
    expect(candidate.transparentFrames).toBe(1);

    expect(updateAlphaHitState(candidate, Number.NaN)).toEqual({
      classification: PIXEL_HIT_OPAQUE,
      transparentFrames: 0,
      changed: false,
      sampleKnown: false
    });

    const interrupted = updateAlphaHitState(candidate, 16);
    expect(interrupted.classification).toBe(PIXEL_HIT_OPAQUE);
    expect(interrupted.transparentFrames).toBe(0);

    expect(updateAlphaHitState(interrupted, Number.NaN)).toEqual({
      classification: PIXEL_HIT_OPAQUE,
      transparentFrames: 0,
      changed: false,
      sampleKnown: false
    });
  });

  it("supports a configurable transparent confirmation window", () => {
    const options = { transparentConfirmationFrames: 3 };
    const first = updateAlphaHitState(createAlphaHitState(PIXEL_HIT_OPAQUE), 0, options);
    const second = updateAlphaHitState(first, 0, options);
    const third = updateAlphaHitState(second, 0, options);
    expect(first.classification).toBe(PIXEL_HIT_OPAQUE);
    expect(second.classification).toBe(PIXEL_HIT_OPAQUE);
    expect(third.classification).toBe(PIXEL_HIT_TRANSPARENT);
  });
});

describe("pixel mouse-passthrough decision", () => {
  it.each([
    [{ hidden: true, dragging: true }, true, "hidden"],
    [{ forcePassthrough: true, dragging: true }, true, "forced"],
    [{ dragging: true, pointerInsideContent: false }, false, "dragging"],
    [{ pointerInsideContent: false }, true, "outside-content"],
    [{ pointerInsideContent: true, alphaState: PIXEL_HIT_TRANSPARENT }, true, "transparent-pixel"],
    [{ pointerInsideContent: true, alphaState: PIXEL_HIT_OPAQUE }, false, "opaque-pixel"],
    [{ pointerInsideContent: true, alphaState: PIXEL_HIT_UNKNOWN }, false, "unknown-safe-interactive"],
    [{ pointerInsideContent: true }, false, "unknown-safe-interactive"]
  ])("resolves %j to passthrough=%s", (input, mousePassthrough, reason) => {
    expect(resolvePixelMousePassthrough(input)).toEqual({ mousePassthrough, reason });
  });
});
