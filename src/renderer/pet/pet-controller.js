const DRAG_THRESHOLD_PX = 4;

export function resolveDragVisualOffset({ requestedBounds, actualPosition, topBoundary }) {
  const requestedY = Number(requestedBounds && requestedBounds.y);
  const actualY = Number(actualPosition && actualPosition.y);
  const boundaryY = Number.isFinite(Number(topBoundary)) ? Number(topBoundary) : actualY;
  if (
    !Number.isFinite(requestedY) ||
    !Number.isFinite(actualY) ||
    !Number.isFinite(boundaryY) ||
    requestedY >= boundaryY
  ) {
    return { x: 0, y: 0 };
  }

  return { x: 0, y: Math.round(requestedY - Math.max(actualY, boundaryY)) };
}

export function createBoundsScheduler({
  requestFrame = requestAnimationFrame,
  setBounds,
  onError = () => {},
  now = () => (globalThis.performance && typeof globalThis.performance.now === "function" ? globalThis.performance.now() : Date.now()),
  logger = null,
  slowSetBoundsMs = 32
}) {
  let latestBounds = null;
  let frameId = null;
  let inFlight = false;

  function roundDuration(value) {
    return Math.round(value * 100) / 100;
  }

  function logSetBoundsTiming(bounds, startedAt) {
    if (!logger || (typeof logger.debug !== "function" && typeof logger.warn !== "function")) return;

    const durationMs = roundDuration(now() - startedAt);
    const data = {
      durationMs,
      bounds,
      hasPendingBounds: Boolean(latestBounds)
    };

    if (durationMs >= slowSetBoundsMs && typeof logger.warn === "function") {
      logger.warn("pet window setBounds completed slowly", data);
    }
  }

  function scheduleFlush() {
    if (frameId !== null || inFlight || !latestBounds) return;
    frameId = requestFrame(flush);
  }

  function flush() {
    frameId = null;
    if (inFlight || !latestBounds) return;

    const bounds = latestBounds;
    latestBounds = null;
    inFlight = true;
    const startedAt = now();

    Promise.resolve(setBounds(bounds))
      .then(() => logSetBoundsTiming(bounds, startedAt))
      .catch((error) => onError("Failed to move pet window", error))
      .finally(() => {
        inFlight = false;
        scheduleFlush();
      });
  }

  return {
    request(bounds) {
      latestBounds = bounds;
      scheduleFlush();
    }
  };
}

export function stopPetEvent(event) {
  event.stopPropagation();
}

export function createPetController({
  clearIdle,
  movePetWindow,
  getWindowPosition,
  getWindowSize,
  getDragTopBoundary = () => null,
  setDraggingClass,
  setDragVisualOffset = () => {},
  setPointerCapture,
  releasePointerCapture,
  hasPointerCapture,
  onClick = () => false,
  onDragStart = () => false,
  onDragging = () => false,
  onDragEnd = () => false,
  onDragCancel = () => {},
  dragThresholdPx = DRAG_THRESHOLD_PX
}) {
  let dragSession = null;
  let didDrag = false;

  function getBoundsAt(screenX, screenY, offsetX, offsetY) {
    const size = getWindowSize();
    return {
      x: screenX - offsetX,
      y: screenY - offsetY,
      width: size.width,
      height: size.height
    };
  }

  return {
   startDrag(event) {
     if (event.button !== 0) return;

     const position = getWindowPosition();
     clearIdle();
     didDrag = false;
     dragSession = {
       pointerId: event.pointerId,
       offsetX: event.screenX - position.x,
       offsetY: event.screenY - position.y,
       startScreenX: event.screenX,
       startScreenY: event.screenY,
       lastScreenX: event.screenX,
       lastScreenY: event.screenY
     };

     setPointerCapture(event.pointerId);
     setDraggingClass(true);
   },

   continueDrag(event) {
     if (!dragSession || dragSession.pointerId !== event.pointerId) return;

     const distanceX = event.screenX - dragSession.startScreenX;
     const distanceY = event.screenY - dragSession.startScreenY;
     if (!didDrag && Math.hypot(distanceX, distanceY) < dragThresholdPx) return;

     dragSession.lastScreenX = event.screenX;
     dragSession.lastScreenY = event.screenY;
     const firstDrag = !didDrag;
     didDrag = true;
     if (firstDrag) {
       onDragStart(event, { position: getWindowPosition() });
     }
     onDragging(event, {
        startScreenX: dragSession.startScreenX,
        startScreenY: dragSession.startScreenY,
        offsetX: dragSession.offsetX,
        offsetY: dragSession.offsetY,
        distanceX,
        distanceY
      });
      const nextBounds = getBoundsAt(event.screenX, event.screenY, dragSession.offsetX, dragSession.offsetY);
      setDragVisualOffset(resolveDragVisualOffset({
        requestedBounds: nextBounds,
        actualPosition: getWindowPosition(),
        topBoundary: getDragTopBoundary()
      }));
      movePetWindow(nextBounds);
    },

    endDrag(event) {
      if (!dragSession || dragSession.pointerId !== event.pointerId) return;

      if (hasPointerCapture(event.pointerId)) {
        releasePointerCapture(event.pointerId);
      }

      dragSession = null;
      setDraggingClass(false);

      if (didDrag) {
        // 回默认由动画系统内部（clip 播完且等待区空）或 dragEnd 规则决定，
        // 手势本身不再强制 returnToDefault（否则会冲掉规则排队的动画）。
        onDragEnd(event);
      }
    },

    lostPointerCapture() {
      const wasDragging = Boolean(dragSession && didDrag);
      const lastDragSession = dragSession;

      dragSession = null;
      setDraggingClass(false);

      if (wasDragging) {
        // 与 endDrag 一致：取消拖拽不强制回默认，交给动画系统内部/规则决定。
        onDragCancel({
          pointerId: lastDragSession.pointerId,
          screenX: lastDragSession.lastScreenX,
          screenY: lastDragSession.lastScreenY
        });
      }
    },

    click(event) {
      if (didDrag) {
        didDrag = false;
        return;
      }

      // 点击交互完全由规则决定；无规则命中时不再硬编码问候/回默认。
      onClick(event);
    }
  };
}
