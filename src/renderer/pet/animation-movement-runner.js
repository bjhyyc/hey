/**
 * Clip-bound movement runner.
 *
 * Owns both delayed starts and requestAnimationFrame movement so a clip switch
 * can cancel the whole lifecycle, including a not-yet-started delayed move.
 */

const SUPPORTED_EASING_PRESETS = new Set(["linear", "easeIn", "easeOut", "easeInOut"]);

function getFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getNonNegativeNumber(value, fallback) {
  const number = getFiniteNumber(value, fallback);
  return number >= 0 ? number : fallback;
}

function normalizeEasingConfig(easing = {}, totalDurationMs) {
  const preset = SUPPORTED_EASING_PRESETS.has(easing.preset) ? easing.preset : "linear";
  const strength = Math.min(3, Math.max(0.1, getFiniteNumber(easing.strength, 1)));
  const defaultPhaseMs = totalDurationMs * 0.3;
  const hasEaseInMs = Object.prototype.hasOwnProperty.call(easing, "easeInMs");
  const hasEaseOutMs = Object.prototype.hasOwnProperty.call(easing, "easeOutMs");

  let easeInMs = 0;
  let easeOutMs = 0;
  if (preset === "easeIn" || preset === "easeInOut") easeInMs = defaultPhaseMs;
  if (preset === "easeOut" || preset === "easeInOut") easeOutMs = defaultPhaseMs;
  if (hasEaseInMs) easeInMs = getNonNegativeNumber(easing.easeInMs, 0);
  if (hasEaseOutMs) easeOutMs = getNonNegativeNumber(easing.easeOutMs, 0);

  return { preset, strength, easeInMs, easeOutMs };
}

export function applyMovementEasing(progress, easing = {}, totalDurationMs) {
  const normalizedProgress = Math.min(1, Math.max(0, Number(progress) || 0));
  if (!totalDurationMs || totalDurationMs <= 0) return progress;

  const { preset, strength, easeInMs, easeOutMs } = normalizeEasingConfig(easing, totalDurationMs);
  if (preset === "linear" || (!easeInMs && !easeOutMs)) return normalizedProgress;

  const totalEaseMs = easeInMs + easeOutMs;
  const scale = totalEaseMs > totalDurationMs ? totalDurationMs / totalEaseMs : 1;
  const tIn = (easeInMs * scale) / totalDurationMs;
  const tOut = (easeOutMs * scale) / totalDurationMs;
  const tConst = 1 - tIn - tOut;
  const exponent = 1 + strength;
  const vMax = 1 / ((tIn / exponent) + tConst + (tOut / exponent));

  if (normalizedProgress <= tIn && tIn > 0) {
    const t = normalizedProgress / tIn;
    return vMax * tIn * (Math.pow(t, exponent) / exponent);
  }

  const distAfterIn = vMax * tIn / exponent;

  if (normalizedProgress <= 1 - tOut) {
    return distAfterIn + vMax * (normalizedProgress - tIn);
  }

  const distAfterConst = distAfterIn + vMax * tConst;
  const t = (normalizedProgress - (1 - tOut)) / tOut;
  return distAfterConst + vMax * tOut * ((1 - Math.pow(1 - t, exponent)) / exponent);
}

export function createAnimationMovementRunner({
  requestAnimationFrame,
  cancelAnimationFrame,
  setTimeout,
  clearTimeout,
  now,
  getPosition,
  getSize,
  refreshWorkArea,
  clearDragVisualOffset,
  resolveMoveDirection,
  resolveMoveSpeed,
  wrapBoundsToScreen,
  boundsScheduler,
  logger,
  pushRuntimeState
}) {
  let frameId = 0;
  let timeoutId = 0;
  let generation = 0;

  function clearScheduled() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = 0;
    }
    if (frameId) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
  }

  function cancel() {
    generation += 1;
    clearScheduled();
  }

  async function start(clip) {
    cancel();

    const movement = clip && clip.movement;
    if (!movement || !movement.direction) return false;

    const clipDurationMs = Number(clip.durationMs);
    if (!clipDurationMs || clipDurationMs <= 0) return false;

    const token = generation;
    const workArea = await refreshWorkArea();
    if (token !== generation) return false;

    clearDragVisualOffset("animation-movement");

    const direction = movement.direction;
    const vector = resolveMoveDirection(direction);
    const speed = resolveMoveSpeed(movement.speed);
    const easing = movement.easing || {};
    const startDelayMs = getNonNegativeNumber(easing.startDelayMs, 0);
    const endDelayMs = getNonNegativeNumber(easing.endDelayMs, 0);
    const movementDurationMs = Math.max(0, clipDurationMs - startDelayMs - endDelayMs);
    if (movementDurationMs <= 0) return false;

    const totalDistance = speed * (movementDurationMs / 1000);

    const begin = () => {
      if (token !== generation) return;
      timeoutId = 0;

      const startPosition = getPosition();
      const size = getSize();
      const startedAt = now();

      logger.debug("animation movement started", {
        clipId: clip.id,
        direction,
        speed,
        durationMs: clipDurationMs,
        movementDurationMs,
        startDelayMs,
        endDelayMs,
        easing,
        startPosition
      });

      const step = (frameNow) => {
        if (token !== generation) return;

        const linearProgress = Math.min(1, Math.max(0, (frameNow - startedAt) / movementDurationMs));
        const easedProgress = applyMovementEasing(linearProgress, easing, movementDurationMs);
        const distance = totalDistance * easedProgress;
        const nextBounds = wrapBoundsToScreen({
          x: Math.round(startPosition.x + vector.x * distance),
          y: Math.round(startPosition.y + vector.y * distance),
          width: size.width,
          height: size.height
        }, workArea);

        boundsScheduler.request(nextBounds);

        if (linearProgress < 1) {
          frameId = requestAnimationFrame(step);
          return;
        }

        frameId = 0;
        logger.debug("animation movement completed", {
          clipId: clip.id,
          direction,
          endPosition: { x: nextBounds.x, y: nextBounds.y }
        });
        pushRuntimeState();
      };

      frameId = requestAnimationFrame(step);
    };

    if (startDelayMs > 0) {
      timeoutId = setTimeout(begin, startDelayMs);
      return true;
    }

    begin();
    return true;
  }

  return { start, cancel };
}
