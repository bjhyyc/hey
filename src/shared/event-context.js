function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function distanceBetween(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function getPetCenter(petPosition) {
  return {
    x: petPosition.x + petPosition.width / 2,
    y: petPosition.y + petPosition.height / 2
  };
}

function isPointInsideRect(point, rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function distanceToBounds(point, rect) {
  if (isPointInsideRect(point, rect)) return 0;

  const nearestX = Math.max(rect.x, Math.min(point.x, rect.x + rect.width));
  const nearestY = Math.max(rect.y, Math.min(point.y, rect.y + rect.height));
  return distanceBetween(point, { x: nearestX, y: nearestY });
}

function getDirection(deltaX, deltaY) {
  if (deltaX === 0 && deltaY === 0) return "none";
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX > 0 ? "right" : "left";
  }
  return deltaY > 0 ? "down" : "up";
}

function getAngleContext(point, center) {
  const angle = Math.atan2(point.y - center.y, point.x - center.x);
  const normalizedAngle = angle < 0 ? angle + Math.PI * 2 : angle;
  const progressFromTop = (normalizedAngle / (Math.PI * 2) + 0.25) % 1;

  return {
    angleToPet: round(angle, 4),
    angleToPetDegrees: round(progressFromTop * 360),
    angleToPetProgress: round(progressFromTop, 4)
  };
}

function getPreviousMousePosition(previous) {
  if (!previous || typeof previous !== "object") return null;
  if (previous.mousePosition && typeof previous.mousePosition === "object") return previous.mousePosition;
  return null;
}

function snapshotPoint(point) {
  return {
    x: point.x,
    y: point.y
  };
}

function snapshotRect(rect) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  };
}

function createMouseMoveContext({
  timestamp,
  previous,
  mousePosition,
  petPosition
}) {
  const currentMousePosition = snapshotPoint(mousePosition);
  const currentPetPosition = snapshotRect(petPosition);
  const previousMousePosition = getPreviousMousePosition(previous);
  const deltaX = previousMousePosition ? currentMousePosition.x - previousMousePosition.x : 0;
  const deltaY = previousMousePosition ? currentMousePosition.y - previousMousePosition.y : 0;
  const elapsedMs = previousMousePosition && typeof previous.timestamp === "number"
    ? Math.max(0, timestamp - previous.timestamp)
    : 0;
  const distanceDelta = previousMousePosition ? distanceBetween(currentMousePosition, previousMousePosition) : 0;
  const speed = elapsedMs > 0 ? distanceDelta / (elapsedMs / 1000) : 0;

  const petCenter = getPetCenter(currentPetPosition);
  const currentDistanceToCenter = distanceBetween(currentMousePosition, petCenter);
  const previousDistanceToCenter = previousMousePosition ? distanceBetween(previousMousePosition, petCenter) : currentDistanceToCenter;
  const angleContext = getAngleContext(currentMousePosition, petCenter);

  return {
    type: "mouseMove",
    timestamp,
    eventSource: "globalMouse",
    petPosition: currentPetPosition,
    mousePosition: currentMousePosition,
    screenPosition: currentMousePosition,
    mouseLocalPosition: {
      x: round(currentMousePosition.x - currentPetPosition.x),
      y: round(currentMousePosition.y - currentPetPosition.y)
    },
    isInsidePet: isPointInsideRect(currentMousePosition, currentPetPosition),
    distanceToPetCenter: round(currentDistanceToCenter),
    distanceToPetBounds: round(distanceToBounds(currentMousePosition, currentPetPosition)),
    deltaX: round(deltaX),
    deltaY: round(deltaY),
    speed: round(speed),
    direction: getDirection(deltaX, deltaY),
    ...angleContext,
    isMovingTowardPet: Boolean(previousMousePosition && currentDistanceToCenter < previousDistanceToCenter),
    isMovingAwayFromPet: Boolean(previousMousePosition && currentDistanceToCenter > previousDistanceToCenter)
  };
}

function createMouseStillContext({
  timestamp,
  previous,
  durationMs
}) {
  const source = previous && typeof previous === "object" ? previous : {};
  const mousePosition = source.mousePosition ? snapshotPoint(source.mousePosition) : null;
  const petPosition = source.petPosition ? snapshotRect(source.petPosition) : null;

  return {
    ...source,
    type: "mouseStill",
    timestamp,
    eventSource: "globalMouse",
    ...(petPosition ? { petPosition } : {}),
    ...(mousePosition ? {
      mousePosition,
      screenPosition: mousePosition
    } : {}),
    durationMs: Math.max(0, Number(durationMs) || 0)
  };
}

const eventContextApi = {
  createMouseMoveContext,
  createMouseStillContext
};

export {
  createMouseMoveContext,
  createMouseStillContext
};

export default eventContextApi;

if (typeof module !== "undefined" && module.exports) {
  module.exports = eventContextApi;
}
