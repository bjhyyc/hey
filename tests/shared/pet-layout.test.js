import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as browserLayout from "../../src/shared/pet-layout.browser.mjs";

const require = createRequire(import.meta.url);
const layout = require("../../src/shared/pet-layout");

const STUDIO = 854 / 480;

describe("pet layout", () => {
  it("keeps square and tall media in the classic square box and window", () => {
    expect(layout.computeSpriteBox({ scale: 1, aspect: 1 })).toEqual({ width: 232, height: 232 });
    expect(layout.computeSpriteBox({ scale: 2, aspect: 0.75 })).toEqual({ width: 464, height: 464 });
    expect(layout.computePetWindowSize({ scale: 1.5, aspect: 1 })).toEqual({ width: 480, height: 480 });
    expect(layout.computePetWindowSize({ scale: 1, aspect: 0.5 })).toEqual({ width: 320, height: 320 });
  });

  it("widens the box and the window for a studio pack's 16:9 canvas", () => {
    expect(layout.computeSpriteBox({ scale: 1, aspect: STUDIO })).toEqual({ width: 413, height: 232 });
    expect(layout.computePetWindowSize({ scale: 1, aspect: STUDIO })).toEqual({ width: 501, height: 320 });
    expect(layout.computePetWindowSize({ scale: 1.5, aspect: STUDIO })).toEqual({ width: 751, height: 480 });
  });

  it("tolerates garbage scale and aspect values", () => {
    expect(layout.computeSpriteBox({ scale: "x", aspect: NaN })).toEqual({ width: 232, height: 232 });
    expect(layout.computeSpriteBox({ scale: 1, aspect: 99 })).toEqual({ width: 928, height: 232 });
    expect(layout.normalizeMediaAspect(-1)).toBe(1);
    expect(layout.normalizeMediaAspect(0.1)).toBe(0.25);
  });

  it("recommends the starting scale the first customer chose by hand", () => {
    // The calibration point: on this 1440x852 logical work area the customer
    // dragged the slider to 1.86; the recommendation lands within 4%.
    const chosenByHand = 1.86;
    const recommended = layout.recommendStudioScale({ workAreaWidth: 1440, workAreaHeight: 852 });
    expect(recommended).toBe(1.8);
    expect(Math.abs(recommended - chosenByHand) / chosenByHand).toBeLessThan(0.04);
    // 1080p desktop: a ~229 px pet in a 1097x701 window.
    expect(layout.recommendStudioScale({ workAreaWidth: 1920, workAreaHeight: 1040 })).toBe(2.19);
    // 768 px laptop: a ~161 px pet.
    expect(layout.recommendStudioScale({ workAreaWidth: 1366, workAreaHeight: 728 })).toBe(1.53);
    // A narrow work area is capped by the window's width budget, not height.
    expect(layout.recommendStudioScale({ workAreaWidth: 600, workAreaHeight: 2000 })).toBe(0.9);
    // Never outside the display tab's slider range.
    expect(layout.recommendStudioScale({ workAreaWidth: 200, workAreaHeight: 200 })).toBe(0.5);
    expect(layout.recommendStudioScale({ workAreaWidth: 8000, workAreaHeight: 8000 })).toBe(3);
    expect(layout.recommendStudioScale({ workAreaHeight: 0 })).toBe(1);
  });

  it("resolves the sprite rectangle inside the window for the hover tracker", () => {
    // Square window (aspect <= 1): a near-square box near the bottom, scaled.
    expect(layout.spriteBoxWithinWindow({ width: 320, height: 320 })).toEqual({ x: 44, y: 64, width: 232, height: 228 });
    expect(layout.spriteBoxWithinWindow({ width: 576, height: 576 })).toEqual({ x: 79, y: 115, width: 418, height: 410 });
    // Studio window (wide): the box widens to cover the whole canvas.
    const studio = layout.computePetWindowSize({ scale: 1.8, aspect: STUDIO });
    const box = layout.spriteBoxWithinWindow(studio);
    expect(box.width).toBeGreaterThan(box.height);
    expect(box.width).toBe(studio.width - Math.round(88 * (studio.height / 320)));
    // The box always stays inside the window.
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(studio.width);
    expect(box.y + box.height).toBeLessThanOrEqual(studio.height);
    // Degenerate input never throws.
    expect(layout.spriteBoxWithinWindow({ width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("keeps the browser mirror in step with the CommonJS source", () => {
    for (const scale of [0.5, 1, 1.79, 3]) {
      for (const aspect of [0.6, 1, STUDIO, 2.5, "junk"]) {
        expect(browserLayout.computeSpriteBox({ scale, aspect })).toEqual(layout.computeSpriteBox({ scale, aspect }));
        expect(browserLayout.computePetWindowSize({ scale, aspect })).toEqual(layout.computePetWindowSize({ scale, aspect }));
        expect(browserLayout.normalizeMediaAspect(aspect)).toBe(layout.normalizeMediaAspect(aspect));
      }
    }
    expect(browserLayout.PET_SPRITE_BASE_SIZE).toBe(layout.PET_SPRITE_BASE_SIZE);
    expect(browserLayout.PET_WINDOW_BASE_SIZE).toBe(layout.PET_WINDOW_BASE_SIZE);
  });
});
