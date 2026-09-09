// Geometry of the pet on screen, shared by the main process (window bounds)
// and the pet renderer (sprite box). Keep this file the CommonJS source of
// truth; pet-layout.browser.mjs mirrors it for the renderer, and the sync test
// keeps the two from drifting.
//
// A studio pack renders on a wide 854x480 character canvas with the pet
// standing about 45% of the canvas tall (the production QA geometry: master
// visible bounds run 42-51% of the 480 px height). The original square sprite
// box letterboxed that canvas, so at 100% the pet stood roughly 60 px tall.
// The box now follows the media's aspect: its height is the classic 232 px
// times the scale, and its width grows with the aspect, so the whole canvas
// (and every action's motion in it) stays visible at a size that reads as a
// desk pet.

const PET_SPRITE_BASE_SIZE = 232;
const PET_WINDOW_BASE_SIZE = 320;
// Horizontal chrome around the sprite: 34 px padding each side plus the 20 px
// the square window always had to spare.
const PET_WINDOW_HORIZONTAL_CHROME = PET_WINDOW_BASE_SIZE - PET_SPRITE_BASE_SIZE;
const MIN_MEDIA_ASPECT = 0.25;
const MAX_MEDIA_ASPECT = 4;

const STUDIO_CANVAS_ASPECT = 854 / 480;
const STUDIO_SUBJECT_HEIGHT_FRACTION = 0.45;
// The size a freshly imported pack starts at. This was derived from the work
// area for a while, which produced a pet sized right for a 1080p desktop and
// too large on a Retina Mac, where the same logical pixels are physically
// bigger. A fixed, modest default that the customer nudges from the Display
// tab beat a formula that has to be right on every screen.
const IMPORTED_STUDIO_DISPLAY_SCALE = 1.1;
// A desk pet that reads well: its body about 22% of the work area height.
// Calibrated against the size the first customer settled on by hand (scale
// 1.86 on an 852 px work area) rather than picked from the air.
const STUDIO_TARGET_SUBJECT_FRACTION = 0.22;
// The window is ~3x the pet's own height (the canvas leaves room for each
// action's motion) and is transparent and click-through outside the pet, so
// it may be large - but never so large that it owns the screen.
const MAX_WINDOW_WORK_AREA_FRACTION = 0.75;
const MIN_DISPLAY_SCALE = 0.5;
const MAX_DISPLAY_SCALE = 3;

function normalizeScale(scale) {
  const parsed = Number(scale);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeMediaAspect(aspect) {
  const parsed = Number(aspect);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(MAX_MEDIA_ASPECT, Math.max(MIN_MEDIA_ASPECT, parsed));
}

/**
 * The sprite box in CSS pixels. Tall and square media keep the square box
 * they always had; wide media widen the box so the media fills it.
 */
function computeSpriteBox({ scale = 1, aspect = 1 } = {}) {
  const safeScale = normalizeScale(scale);
  const safeAspect = normalizeMediaAspect(aspect);
  const height = Math.max(1, Math.round(PET_SPRITE_BASE_SIZE * safeScale));
  const width = Math.max(1, Math.round(PET_SPRITE_BASE_SIZE * Math.max(1, safeAspect) * safeScale));
  return { width, height };
}

/**
 * The pet window's size for a scale and the aspect of the media it shows.
 * Square/tall media keep the classic square window.
 */
function computePetWindowSize({ scale = 1, aspect = 1 } = {}) {
  const safeScale = normalizeScale(scale);
  const safeAspect = normalizeMediaAspect(aspect);
  const height = Math.max(1, Math.round(PET_WINDOW_BASE_SIZE * safeScale));
  const width = safeAspect > 1
    ? Math.max(1, Math.round((PET_SPRITE_BASE_SIZE * safeAspect + PET_WINDOW_HORIZONTAL_CHROME) * safeScale))
    : height;
  return { width, height };
}

// Where the rendered sprite actually sits inside the pet window, as offsets
// from the window's top-left. It mirrors what pet.css resolves the sprite box
// to (height capped by the vertical padding, width by the side padding), so
// the main-process hover tracker can gate on the same rectangle the renderer
// paints - the old fixed 232 px square missed a scaled or widened pet entirely.
function spriteBoxWithinWindow({ width, height } = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { x: 0, y: 0, width: Math.max(1, w || 1), height: Math.max(1, h || 1) };
  }
  const scale = h / PET_WINDOW_BASE_SIZE;
  const verticalPadding = 92 * scale;   // 64 top + 28 bottom
  const bottomPadding = 28 * scale;
  const sidePadding = 34 * scale;
  const boxHeight = Math.max(1, Math.min(PET_SPRITE_BASE_SIZE * scale, h - verticalPadding));
  // The window is sized as sprite + 88*scale of chrome, so the sprite spans the
  // window minus that chrome; never wider than the side padding allows.
  const boxWidth = Math.max(1, Math.min(w - (PET_WINDOW_BASE_SIZE - PET_SPRITE_BASE_SIZE) * scale, w - 2 * sidePadding));
  return {
    x: Math.round((w - boxWidth) / 2),
    y: Math.round(h - bottomPadding - boxHeight),
    width: Math.round(boxWidth),
    height: Math.round(boxHeight)
  };
}

module.exports = {
  IMPORTED_STUDIO_DISPLAY_SCALE,
  MAX_DISPLAY_SCALE,
  MIN_DISPLAY_SCALE,
  PET_SPRITE_BASE_SIZE,
  PET_WINDOW_BASE_SIZE,
  STUDIO_CANVAS_ASPECT,
  STUDIO_SUBJECT_HEIGHT_FRACTION,
  computePetWindowSize,
  computeSpriteBox,
  normalizeMediaAspect,
  spriteBoxWithinWindow
};
