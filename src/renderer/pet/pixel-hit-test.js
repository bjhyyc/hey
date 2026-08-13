export const PIXEL_HIT_UNKNOWN = "unknown";
export const PIXEL_HIT_OPAQUE = "opaque";
export const PIXEL_HIT_TRANSPARENT = "transparent";

export const DEFAULT_ALPHA_HIT_OPTIONS = Object.freeze({
  opaqueThreshold: 24,
  transparentThreshold: 8,
  transparentConfirmationFrames: 2
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  const x = finiteNumber(rect.x ?? rect.left);
  const y = finiteNumber(rect.y ?? rect.top);
  const width = finiteNumber(rect.width);
  const height = finiteNumber(rect.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function normalizeSize(size) {
  if (!size || typeof size !== "object") return null;
  const width = finiteNumber(size.width);
  const height = finiteNumber(size.height);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Return the painted content rectangle for `object-fit: contain`.
 * `elementRect` and subsequent pointer coordinates must share one coordinate space.
 */
export function getObjectContainRect(elementRect, intrinsicSize) {
  const rect = normalizeRect(elementRect);
  const source = normalizeSize(intrinsicSize);
  if (!rect || !source) return null;

  const scale = Math.min(rect.width / source.width, rect.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height
  };
}

/**
 * Map a pointer to source-media coordinates after `object-fit: contain`.
 * Right and bottom edges are exclusive, matching source pixel bounds.
 */
export function mapPointToObjectContain({ point, elementRect, intrinsicSize } = {}) {
  const contentRect = getObjectContainRect(elementRect, intrinsicSize);
  const source = normalizeSize(intrinsicSize);
  const pointX = finiteNumber(point && point.x);
  const pointY = finiteNumber(point && point.y);

  if (!contentRect || !source || pointX === null || pointY === null) {
    return { status: "unknown", contentRect: contentRect || null };
  }

  const inside = pointX >= contentRect.x &&
    pointX < contentRect.x + contentRect.width &&
    pointY >= contentRect.y &&
    pointY < contentRect.y + contentRect.height;
  if (!inside) return { status: "outside", contentRect };

  const normalizedX = clamp((pointX - contentRect.x) / contentRect.width, 0, 1);
  const normalizedY = clamp((pointY - contentRect.y) / contentRect.height, 0, 1);
  const sourceX = normalizedX * source.width;
  const sourceY = normalizedY * source.height;
  return {
    status: "mapped",
    contentRect,
    normalizedX,
    normalizedY,
    sourceX,
    sourceY,
    pixelX: clamp(Math.floor(sourceX), 0, Math.max(0, Math.ceil(source.width) - 1)),
    pixelY: clamp(Math.floor(sourceY), 0, Math.max(0, Math.ceil(source.height) - 1))
  };
}

function clampByte(value, fallback = 0) {
  const number = finiteNumber(value);
  return number === null ? fallback : clamp(number, 0, 255);
}

function clampUnit(value, fallback) {
  const number = finiteNumber(value);
  return number === null ? fallback : clamp(number, 0, 1);
}

function parseKeyColor(color) {
  if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) {
    return {
      r: parseInt(color.slice(1, 3), 16),
      g: parseInt(color.slice(3, 5), 16),
      b: parseInt(color.slice(5, 7), 16)
    };
  }
  if (color && typeof color === "object") {
    return {
      r: clampByte(color.r),
      g: clampByte(color.g),
      b: clampByte(color.b)
    };
  }
  return { r: 0, g: 255, b: 0 };
}

/** Apply the same RGB-distance keying formula used by the runtime shader. */
export function getEffectiveGreenScreenAlpha(pixel, greenScreen = {}) {
  const sourceAlpha = clampByte(pixel && (pixel.a ?? pixel.alpha), 255);
  if (!greenScreen || greenScreen.enabled === false) return Math.round(sourceAlpha);

  const keyColor = parseKeyColor(greenScreen.color);
  const tolerance = clampUnit(greenScreen.tolerance, 0.35);
  const softness = clampUnit(greenScreen.softness, 0.08);
  const distance = Math.hypot(
    clampByte(pixel && pixel.r) - keyColor.r,
    clampByte(pixel && pixel.g) - keyColor.g,
    clampByte(pixel && pixel.b) - keyColor.b
  ) / Math.sqrt(255 * 255 * 3);

  if (distance <= tolerance) return 0;
  const fadeEnd = Math.min(1, tolerance + softness);
  if (softness > 0 && distance < fadeEnd) {
    const scale = (distance - tolerance) / Math.max(0.0001, fadeEnd - tolerance);
    return Math.round(sourceAlpha * scale);
  }
  return Math.round(sourceAlpha);
}

function normalizeClassification(value) {
  return value === PIXEL_HIT_OPAQUE || value === PIXEL_HIT_TRANSPARENT
    ? value
    : PIXEL_HIT_UNKNOWN;
}

function normalizeAlphaOptions(options = {}) {
  const transparentThreshold = clampByte(
    options.transparentThreshold,
    DEFAULT_ALPHA_HIT_OPTIONS.transparentThreshold
  );
  const opaqueThreshold = Math.max(
    transparentThreshold,
    clampByte(options.opaqueThreshold, DEFAULT_ALPHA_HIT_OPTIONS.opaqueThreshold)
  );
  const requestedFrames = finiteNumber(options.transparentConfirmationFrames);
  const transparentConfirmationFrames = requestedFrames === null
    ? DEFAULT_ALPHA_HIT_OPTIONS.transparentConfirmationFrames
    : Math.max(1, Math.floor(requestedFrames));
  return { opaqueThreshold, transparentThreshold, transparentConfirmationFrames };
}

export function createAlphaHitState(classification = PIXEL_HIT_UNKNOWN) {
  return {
    classification: normalizeClassification(classification),
    transparentFrames: 0
  };
}

/**
 * Pure alpha-state reducer. Opaque pixels recover interaction immediately;
 * transparent pixels need consecutive confirmation frames to avoid edge flicker.
 */
export function updateAlphaHitState(previousState, sampledAlpha, options = {}) {
  const previous = previousState && typeof previousState === "object"
    ? previousState
    : createAlphaHitState();
  const previousClassification = normalizeClassification(previous.classification);
  const alpha = finiteNumber(sampledAlpha);
  if (alpha === null) {
    return {
      classification: previousClassification,
      transparentFrames: 0,
      changed: false,
      sampleKnown: false
    };
  }

  const normalizedAlpha = clamp(alpha, 0, 255);
  const thresholds = normalizeAlphaOptions(options);
  if (normalizedAlpha >= thresholds.opaqueThreshold) {
    return {
      classification: PIXEL_HIT_OPAQUE,
      transparentFrames: 0,
      changed: previousClassification !== PIXEL_HIT_OPAQUE,
      sampleKnown: true
    };
  }

  if (normalizedAlpha <= thresholds.transparentThreshold) {
    if (previousClassification === PIXEL_HIT_TRANSPARENT) {
      return {
        classification: PIXEL_HIT_TRANSPARENT,
        transparentFrames: thresholds.transparentConfirmationFrames,
        changed: false,
        sampleKnown: true
      };
    }
    const transparentFrames = Math.min(
      thresholds.transparentConfirmationFrames,
      Math.max(0, Math.floor(Number(previous.transparentFrames) || 0)) + 1
    );
    const classification = transparentFrames >= thresholds.transparentConfirmationFrames
      ? PIXEL_HIT_TRANSPARENT
      : previousClassification;
    return {
      classification,
      transparentFrames,
      changed: classification !== previousClassification,
      sampleKnown: true
    };
  }

  return {
    classification: previousClassification,
    transparentFrames: 0,
    changed: false,
    sampleKnown: true
  };
}

/** Resolve Electron window passthrough with explicit safety priorities. */
export function resolvePixelMousePassthrough({
  hidden = false,
  forcePassthrough = false,
  dragging = false,
  pointerInsideContent,
  alphaState
} = {}) {
  if (hidden) return { mousePassthrough: true, reason: "hidden" };
  if (forcePassthrough) return { mousePassthrough: true, reason: "forced" };
  if (dragging) return { mousePassthrough: false, reason: "dragging" };
  if (pointerInsideContent === false) return { mousePassthrough: true, reason: "outside-content" };

  const classification = normalizeClassification(
    typeof alphaState === "string" ? alphaState : alphaState && alphaState.classification
  );
  if (classification === PIXEL_HIT_TRANSPARENT) {
    return { mousePassthrough: true, reason: "transparent-pixel" };
  }
  if (classification === PIXEL_HIT_OPAQUE) {
    return { mousePassthrough: false, reason: "opaque-pixel" };
  }

  // Unknown/missing samples stay interactive inside the content rectangle so
  // a decode or readback failure cannot make the pet permanently unreachable.
  return { mousePassthrough: false, reason: "unknown-safe-interactive" };
}
