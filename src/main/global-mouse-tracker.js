const { screen } = require("electron");
const { createThrottledLogger } = require("./services/logger");

const DEFAULT_INTERVAL_MS = 30;
const logger = createThrottledLogger("global-mouse", 500);

function getPetBounds(petWindow) {
  if (!petWindow || petWindow.isDestroyed()) return null;
  return petWindow.getBounds();
}

function distanceToBounds(point, bounds) {
  const nearestX = Math.max(bounds.x, Math.min(point.x, bounds.x + bounds.width));
  const nearestY = Math.max(bounds.y, Math.min(point.y, bounds.y + bounds.height));
  return Math.hypot(point.x - nearestX, point.y - nearestY);
}

function isPointInsideBounds(point, bounds) {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}


function getSpriteBounds(windowBounds) {
  if (windowBounds.width <= 120 || windowBounds.height <= 120) {
    return { ...windowBounds };
  }

  const baseSize = Math.min(232, windowBounds.width * 0.78, windowBounds.height - 92);
  const size = Math.max(1, baseSize);
  return {
    x: windowBounds.x + (windowBounds.width - size) / 2,
    y: windowBounds.y + windowBounds.height - 28 - size,
    width: size,
    height: size
  };
}

function getPetCenter(bounds) {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
}

function getAngleContext(point, center) {
  const angle = Math.atan2(point.y - center.y, point.x - center.x);
  const normalized = angle < 0 ? angle + Math.PI * 2 : angle;
  const progressFromTop = (normalized / (Math.PI * 2) + 0.25) % 1;
  return {
    angleToPet: Math.round(angle * 10000) / 10000,
    angleToPetDegrees: Math.round(progressFromTop * 360),
    angleToPetProgress: Math.round(progressFromTop * 10000) / 10000
  };
}

function getDirection(dx, dy) {
  if (dx === 0 && dy === 0) return "none";
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function samePoint(left, right) {
  return Boolean(left && right) && left.x === right.x && left.y === right.y;
}

function sameBounds(left, right) {
  return Boolean(left && right) &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height;
}

function debugMouseLog(...args) {
  if (process.env.DESKTOP_PET_DEBUG_RULES === "1") {
    logger.debug(...args);
  }
}

/**
 * Create a global mouse tracker that polls the cursor position and emits
 * mouse-move events to the pet window for global cursor tracking.
 */
function createGlobalMouseTracker({
  getPetWindow,
  intervalMs = DEFAULT_INTERVAL_MS,
  screenGetter
} = {}) {
  const getScreen = screenGetter || (() => screen);
  let timer = null;
  let lastEmittedAt = 0;
  let lastPosition = null;
  let lastPositionAt = 0;
  let lastEmittedPosition = null;
  let lastEmittedBounds = null;
  let lastEmittedTarget = null;

  function tick() {
    const petWindow = typeof getPetWindow === "function" ? getPetWindow() : null;
    if (!petWindow || petWindow.isDestroyed() || !petWindow.webContents) {
      return;
    }

    const windowBounds = getPetBounds(petWindow);
    if (!windowBounds) return;
    const bounds = getSpriteBounds(windowBounds);

    const target = petWindow.webContents;
    if (lastEmittedTarget !== target) {
      lastPosition = null;
      lastPositionAt = 0;
      lastEmittedPosition = null;
      lastEmittedBounds = null;
      lastEmittedAt = 0;
    }

    const activeScreen = getScreen();
    if (!activeScreen || typeof activeScreen.getCursorScreenPoint !== "function") return;

    const point = activeScreen.getCursorScreenPoint();
    const distance = isPointInsideBounds(point, bounds) ? 0 : distanceToBounds(point, bounds);

    const now = Date.now();
    const pointerMoved = !samePoint(lastEmittedPosition, point);
    const boundsChanged = !sameBounds(lastEmittedBounds, bounds);
    if (!pointerMoved && !boundsChanged) return;

    const previousPosition = lastPosition;
    const previousPositionAt = lastPositionAt;
    if (now - lastEmittedAt < intervalMs) return;
    lastEmittedAt = now;

    if (pointerMoved) {
      lastPosition = { x: point.x, y: point.y };
      lastPositionAt = now;
    }

    const center = getPetCenter(bounds);
    const deltaX = pointerMoved && previousPosition ? point.x - previousPosition.x : 0;
    const deltaY = pointerMoved && previousPosition ? point.y - previousPosition.y : 0;
    const distanceDelta = previousPosition ? Math.hypot(deltaX, deltaY) : 0;
    const elapsedMs = pointerMoved && previousPosition ? Math.max(0, now - previousPositionAt) : 0;
    const speed = elapsedMs > 0 ? distanceDelta / (elapsedMs / 1000) : 0;
    const previousDistanceToCenter = previousPosition
      ? Math.hypot(previousPosition.x - center.x, previousPosition.y - center.y)
      : null;
    const currentDistanceToCenter = Math.hypot(point.x - center.x, point.y - center.y);

    const payload = {
      type: "mouseMove",
      timestamp: now,
      eventSource: "globalMouse",
      pointerMoved,
      boundsChanged,
      petPosition: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      mousePosition: { x: point.x, y: point.y },
      mouseLocalPosition: {
        x: round(point.x - bounds.x),
        y: round(point.y - bounds.y)
      },
      screenPosition: { x: point.x, y: point.y },
      isInsidePet: isPointInsideBounds(point, bounds),
      distanceToPetCenter: round(currentDistanceToCenter),
      distanceToPetBounds: round(distance),
      deltaX: round(deltaX),
      deltaY: round(deltaY),
      speed: round(speed),
      direction: getDirection(deltaX, deltaY),
      ...getAngleContext(point, center),
      isMovingTowardPet: Boolean(previousPosition && currentDistanceToCenter < previousDistanceToCenter),
      isMovingAwayFromPet: Boolean(previousPosition && currentDistanceToCenter > previousDistanceToCenter)
    };

    debugMouseLog({
      distanceToPetCenter: payload.distanceToPetCenter,
      distanceToPetBounds: payload.distanceToPetBounds,
      speed: payload.speed,
      angleToPetProgress: payload.angleToPetProgress,
      isInsidePet: payload.isInsidePet,
      isMovingTowardPet: payload.isMovingTowardPet,
      isMovingAwayFromPet: payload.isMovingAwayFromPet,
      mousePosition: payload.mousePosition,
      petPosition: payload.petPosition
    });
    petWindow.webContents.send("pet:global-mouse-move", payload);
    lastEmittedPosition = { x: point.x, y: point.y };
    lastEmittedBounds = { ...bounds };
    lastEmittedTarget = target;
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    lastPosition = null;
    lastPositionAt = 0;
    lastEmittedPosition = null;
    lastEmittedBounds = null;
    lastEmittedTarget = null;
    lastEmittedAt = 0;
  }

  return { start, stop };
}

module.exports = { createGlobalMouseTracker };
