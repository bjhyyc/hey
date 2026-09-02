// Browser-native ESM mirror of pet-layout.js for the pet renderer, which
// Electron loads straight over file:// in development. pet-layout.js stays the
// CommonJS source of truth; the sync test keeps both in step.

const PET_SPRITE_BASE_SIZE = 232;
const PET_WINDOW_BASE_SIZE = 320;
const PET_WINDOW_HORIZONTAL_CHROME = PET_WINDOW_BASE_SIZE - PET_SPRITE_BASE_SIZE;
const MIN_MEDIA_ASPECT = 0.25;
const MAX_MEDIA_ASPECT = 4;

function normalizeScale(scale) {
  const parsed = Number(scale);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function normalizeMediaAspect(aspect) {
  const parsed = Number(aspect);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(MAX_MEDIA_ASPECT, Math.max(MIN_MEDIA_ASPECT, parsed));
}

export function computeSpriteBox({ scale = 1, aspect = 1 } = {}) {
  const safeScale = normalizeScale(scale);
  const safeAspect = normalizeMediaAspect(aspect);
  const height = Math.max(1, Math.round(PET_SPRITE_BASE_SIZE * safeScale));
  const width = Math.max(1, Math.round(PET_SPRITE_BASE_SIZE * Math.max(1, safeAspect) * safeScale));
  return { width, height };
}

export function computePetWindowSize({ scale = 1, aspect = 1 } = {}) {
  const safeScale = normalizeScale(scale);
  const safeAspect = normalizeMediaAspect(aspect);
  const height = Math.max(1, Math.round(PET_WINDOW_BASE_SIZE * safeScale));
  const width = safeAspect > 1
    ? Math.max(1, Math.round((PET_SPRITE_BASE_SIZE * safeAspect + PET_WINDOW_HORIZONTAL_CHROME) * safeScale))
    : height;
  return { width, height };
}

export const STUDIO_CANVAS_ASPECT = 854 / 480;

export { PET_SPRITE_BASE_SIZE, PET_WINDOW_BASE_SIZE };
