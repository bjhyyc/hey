import {
  createBoundsScheduler,
  createPetController,
  stopPetEvent
} from "./pet-controller.js";
import {
  buildRuntimeModel,
  createRuleRuntime,
  mapProgressThroughKeyframes
} from "./pet-runtime.js";
import { throttle } from "../../shared/throttle.js";
import { createMouseMoveContext, createMouseStillContext } from "../../shared/event-context.js";
import { t, setLocale, initLocale } from "../../shared/i18n.js";
import { getActionSequenceDurationMs, scheduleActionSequence } from "../../shared/action-sequence.js";
import { createRendererLogger } from "../shared/logger.js";
import { UserTriggerManager } from "./user-trigger-manager.js";
import { AnimationController } from "./animation-controller.js";
import { createPetMediaRenderer } from "./media-renderer.js";
import { createPomodoroRuntime } from "./pomodoro-runtime.js";
import { createAnimationMovementRunner } from "./animation-movement-runner.js";
import { createDebugLogger, setDebugRulesEnabled } from "./debug-utils.js";
import {
  applyPetHiddenState,
  isPointInsideRect,
  shouldDispatchHiddenMouseLeave,
  shouldSkipRuntimeEventWhileHidden
} from "./pet-visibility.js";
import {
  PIXEL_HIT_OPAQUE,
  PIXEL_HIT_TRANSPARENT,
  createAlphaHitState,
  getObjectContainRect,
  mapPointToObjectContain,
  resolvePixelMousePassthrough,
  updateAlphaHitState
} from "./pixel-hit-test.js";
import {
  LIFECYCLE_EVENT_TYPES,
  shouldSuppressRuntimeEventDuringDrag,
  shouldSuppressRuntimeEventWhileAsleep
} from "./event-suppression.js";
import {
  createOneShotEventLatch,
  getRuntimeUpdateLifecycleEvents,
  playDefaultThenDispatchLifecycleEvents,
  shouldReturnToDefaultForRuntimeUpdate
} from "./runtime-event-helpers.js";

// Initialize locale
initLocale();

const sprite = document.querySelector("#pet-sprite");
const spriteImage = document.querySelector("#pet-sprite-image");
const spriteVideo = document.querySelector("#pet-sprite-video");
const spriteCanvas = document.querySelector("#pet-sprite-canvas");
const spriteGreenCanvas = document.querySelector("#pet-sprite-green-canvas");
const bubble = document.querySelector("#message-bubble");
const pomodoroOverlay = document.querySelector("#pomodoro-overlay");
const root = document.querySelector("#pet-root");
const logger = createRendererLogger("pet");
const mediaRenderer = createPetMediaRenderer({
  container: sprite,
  image: spriteImage,
  video: spriteVideo,
  canvas: spriteCanvas,
  greenCanvas: spriteGreenCanvas,
  greenScreenBackendPreference: "webgl",
  onFramePresented: () => refreshPixelMouseInteraction("media-frame"),
  logger
});

const DEFAULT_MESSAGE_BUBBLE_MAX_WIDTH = 220;
const MIN_MESSAGE_BUBBLE_MAX_WIDTH = 120;
const MAX_MESSAGE_BUBBLE_MAX_WIDTH = 480;
const DEFAULT_MOVE_PET_SPEED = 120;
const DEFAULT_MOVE_PET_DURATION_MS = 1000;
const SINGLE_CLICK_CONFIRM_DELAY_MS = 240;
const MOVE_PET_DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  upLeft: { x: -1, y: -1 },
  upRight: { x: 1, y: -1 },
  downLeft: { x: -1, y: 1 },
  downRight: { x: 1, y: 1 }
};

let stateTimer = 0;
let messageTimer = 0;
let currentConfig = null;
let runtimeModel = buildRuntimeModel();
let ruleRuntime = createRuleRuntime();
let currentDisplay = {
  locked: false,
  scale: 1,
  opacity: 1,
  mousePassthrough: false
};
let petHidden = false;
let hiddenPetBounds = null;
let hiddenMouseLeaveDispatched = false;
let spriteMousePassthrough = null;
let interactionsPaused = false;
let dragStartedAt = 0;
let dragStartPosition = null;
let lastMouseMoveContext = null;
let lastGlobalMouseMoveContext = null;
let lastPixelPointer = null;
let pixelAlphaHitState = createAlphaHitState();
let pointerHitsOpaquePixel = false;
let pixelConfirmationFrame = 0;
let activePointerId = null;
let hoverStartedAt = 0;
let idleStartedAt = Date.now();
const hoverDurationLatch = createOneShotEventLatch();
const idleDurationLatch = createOneShotEventLatch();
const runtimeTimers = new Set();
let mouseStillTimers = [];
let actionSequenceTimers = [];
let movePetAnimationFrame = 0;
let animationMovementRunner = null;
let cachedDesktopWorkArea = null;
let dragVisualOffset = { x: 0, y: 0 };
let pendingSingleClickTimer = 0;
let pomodoroRuntime = null;

// Discrete interaction events (click, doubleClick, mouseEnter, mouseLeave, rightClick)
// suppress competing mouseMove rules for a short window so their animation isn't
// interrupted by "enter range" style mouseMove rules. Drag events are handled
// separately via dragStartedAt (continuous suppression for the whole drag).
const MOUSE_MOVE_SUPPRESS_DEFAULT_MS = 1000;
let mouseMoveSuppressedUntil = 0;

// Runtime state push throttling
let lastPushTime = 0;
const PUSH_THROTTLE_MS = 500;

const debugRulesLog = createDebugLogger("[desktop-pet:pet]", {
  throttleMsByMessage: {
    "global-mouse": 500,
    "mouse-passthrough:pixel": 500,
    "event:evaluate": 500,
    "event:actions": 500
  }
});

// API and DOM references
let userTriggerManager = null;
let animationController = null;

function isGlobalKeyframeMouseMove(eventContext) {
  return Boolean(
    eventContext &&
    eventContext.type === "mouseMove" &&
    eventContext.eventSource === "globalMouse" &&
    Number.isFinite(Number(eventContext.angleToPetProgress))
  );
}

function playDefaultAnimation(reason = "default") {
  cancelAnimationMovement();
  if (animationController) {
    debugRulesLog("animation:returnToDefault", { reason });
    animationController.returnToDefault();
    return;
  }
  debugRulesLog("animation:returnToDefault:missingController", { reason });
}

function clampMessageBubbleMaxWidth(value) {
  const maxWidth = Number(value);
  if (!Number.isFinite(maxWidth)) return null;
  return Math.max(MIN_MESSAGE_BUBBLE_MAX_WIDTH, Math.min(MAX_MESSAGE_BUBBLE_MAX_WIDTH, maxWidth));
}

function resolveMessageBubbleMaxWidth(options = {}) {
  const actionMaxWidth = clampMessageBubbleMaxWidth(options.bubbleMaxWidth ?? options.maxWidth);
  if (actionMaxWidth !== null) {
    return { maxWidth: actionMaxWidth, source: "action" };
  }

  const configMaxWidth = clampMessageBubbleMaxWidth(currentConfig?.interactions?.bubble?.maxWidth);
  if (configMaxWidth !== null) {
    return { maxWidth: configMaxWidth, source: "config" };
  }

  return { maxWidth: DEFAULT_MESSAGE_BUBBLE_MAX_WIDTH, source: "default" };
}

function showMessage(text, durationOrOptions = 1800, options = {}) {
  const messageOptions = durationOrOptions && typeof durationOrOptions === "object"
    ? durationOrOptions
    : options;
  const durationMs = durationOrOptions && typeof durationOrOptions === "object"
    ? durationOrOptions.durationMs || 1800
    : durationOrOptions;
  const { maxWidth, source } = resolveMessageBubbleMaxWidth(messageOptions);

  window.clearTimeout(messageTimer);
  root.style.setProperty("--message-bubble-max-width", `${maxWidth}px`);
  bubble.textContent = text;
  bubble.hidden = false;
  logger.debug("message bubble shown", {
    textLength: String(text || "").length,
    durationMs,
    maxWidth,
    maxWidthSource: source
  });

  messageTimer = window.setTimeout(() => {
    bubble.hidden = true;
    bubble.textContent = "";
  }, durationMs);
}

function resolveFiniteNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

function resolveMoveSpeed(value) {
  return Math.max(0, resolveFiniteNumber(value, DEFAULT_MOVE_PET_SPEED));
}

function resolveMoveDurationMs(value) {
  return Math.max(1, resolveFiniteNumber(value, DEFAULT_MOVE_PET_DURATION_MS));
}

function getScreenWorkArea() {
  if (cachedDesktopWorkArea) {
    return cachedDesktopWorkArea;
  }

  const screenInfo = window.screen || {};
  const left = resolveFiniteNumber(screenInfo.availLeft, 0);
  const top = resolveFiniteNumber(screenInfo.availTop, 0);
  const width = Math.max(1, resolveFiniteNumber(screenInfo.availWidth, window.innerWidth || window.outerWidth || 1));
  const height = Math.max(1, resolveFiniteNumber(screenInfo.availHeight, window.innerHeight || window.outerHeight || 1));
  return {
    left,
    top,
    right: left + width,
    bottom: top + height
  };
}

function getDragTopBoundary() {
  const screenInfo = window.screen || {};
  return resolveFiniteNumber(screenInfo.availTop, window.screenY || 0);
}

function normalizeDisplayWorkArea(display) {
  const area = display && (display.workArea || display.bounds || display);
  if (!area) return null;

  const left = resolveFiniteNumber(area.x, NaN);
  const top = resolveFiniteNumber(area.y, NaN);
  const width = resolveFiniteNumber(area.width, NaN);
  const height = resolveFiniteNumber(area.height, NaN);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    left,
    top,
    right: left + width,
    bottom: top + height
  };
}

function unionWorkAreas(workAreas) {
  const validAreas = workAreas.filter(Boolean);
  if (!validAreas.length) return null;

  return validAreas.reduce((union, area) => ({
    left: Math.min(union.left, area.left),
    top: Math.min(union.top, area.top),
    right: Math.max(union.right, area.right),
    bottom: Math.max(union.bottom, area.bottom)
  }));
}

async function refreshDesktopWorkArea() {
  if (!window.desktopPet?.pet || typeof window.desktopPet.pet.getDisplays !== "function") {
    return getScreenWorkArea();
  }

  try {
    const displays = await window.desktopPet.pet.getDisplays();
    const nextWorkArea = unionWorkAreas(Array.isArray(displays) ? displays.map(normalizeDisplayWorkArea) : []);
    if (nextWorkArea) {
      cachedDesktopWorkArea = nextWorkArea;
      logger.debug("display work area refreshed", {
        displayCount: Array.isArray(displays) ? displays.length : 0,
        workArea: cachedDesktopWorkArea
      });
    }
  } catch (error) {
    logger.warn("Failed to refresh display work area", error);
  }

  return getScreenWorkArea();
}

function wrapCoordinate(value, start, end) {
  const span = end - start;
  if (!Number.isFinite(value) || span <= 0) return value;
  return ((((value - start) % span) + span) % span) + start;
}

function wrapBoundsToScreen(bounds, workArea = getScreenWorkArea()) {
  return {
    ...bounds,
    x: Math.round(wrapCoordinate(bounds.x, workArea.left - bounds.width, workArea.right)),
    y: Math.round(wrapCoordinate(bounds.y, workArea.top - bounds.height, workArea.bottom))
  };
}

function resolveMoveDirection(direction) {
  const vector = MOVE_PET_DIRECTIONS[direction] || MOVE_PET_DIRECTIONS.right;
  const length = Math.hypot(vector.x, vector.y) || 1;
  return {
    x: vector.x / length,
    y: vector.y / length
  };
}

function cancelMovePetAnimation() {
  if (!movePetAnimationFrame) return;
  window.cancelAnimationFrame(movePetAnimationFrame);
  movePetAnimationFrame = 0;
}

function setDragVisualOffset(offset = {}) {
  const x = Number.isFinite(Number(offset.x)) ? Math.round(Number(offset.x)) : 0;
  const y = Number.isFinite(Number(offset.y)) ? Math.round(Number(offset.y)) : 0;
  if (dragVisualOffset.x === x && dragVisualOffset.y === y) return;

  const wasTopEscaped = dragVisualOffset.y < 0;
  const isTopEscaped = y < 0;
  dragVisualOffset = { x, y };
  root.style.setProperty("--pet-drag-visual-x", `${x}px`);
  root.style.setProperty("--pet-drag-visual-y", `${y}px`);

  if (wasTopEscaped !== isTopEscaped) {
    logger.debug("drag visual top overflow changed", {
      escaped: isTopEscaped,
      offset: dragVisualOffset,
      windowPosition: { x: window.screenX, y: window.screenY }
    });
  }
}

function clearDragVisualOffset(reason = "clear") {
  if (dragVisualOffset.x === 0 && dragVisualOffset.y === 0) return;
  logger.debug("drag visual offset cleared", {
    reason,
    previousOffset: dragVisualOffset
  });
  setDragVisualOffset({ x: 0, y: 0 });
}

function cancelPendingSingleClick(reason = "cancelled") {
  if (!pendingSingleClickTimer) return;
  window.clearTimeout(pendingSingleClickTimer);
  pendingSingleClickTimer = 0;
  logger.debug("pending single click cancelled", { reason });
}

async function runMovePet(action = {}) {
  const workArea = await refreshDesktopWorkArea();

  clearDragVisualOffset("move-pet-action");
  const direction = action.direction || "right";
  const vector = resolveMoveDirection(direction);
  const speed = resolveMoveSpeed(action.speed ?? action.pixelsPerSecond);
  const durationMs = resolveMoveDurationMs(action.durationMs);
  const startPosition = { x: window.screenX, y: window.screenY };
  const size = { width: window.outerWidth, height: window.outerHeight };
  const totalDistance = speed * (durationMs / 1000);
  const startedAt = performance.now();

  cancelMovePetAnimation();

  logger.debug("move pet action started", {
    direction,
    speed,
    durationMs,
    startPosition,
    vector,
    boundary: "wrap",
    workArea
  });

  const step = (now) => {
    const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
    const distance = totalDistance * progress;
    const nextBounds = wrapBoundsToScreen({
      x: Math.round(startPosition.x + vector.x * distance),
      y: Math.round(startPosition.y + vector.y * distance),
      width: size.width,
      height: size.height
    }, workArea);

    boundsScheduler.request(nextBounds);

    if (progress < 1) {
      movePetAnimationFrame = window.requestAnimationFrame(step);
      return;
    }

    movePetAnimationFrame = 0;
    logger.debug("move pet action completed", {
      direction,
      speed,
      durationMs,
      endPosition: { x: nextBounds.x, y: nextBounds.y }
    });
    pushRuntimeState();
  };

  movePetAnimationFrame = window.requestAnimationFrame(step);
}

function movePet(action = {}) {
  if (!window.desktopPet || !window.desktopPet.pet) return false;
  runMovePet(action).catch((error) => logger.error("Failed to move pet", error));
  return true;
}

function cancelAnimationMovement() {
  if (animationMovementRunner) {
    animationMovementRunner.cancel();
  }
}

function setSpriteMousePassthrough(enabled) {
  const nextEnabled = Boolean(enabled);
  if (spriteMousePassthrough === nextEnabled) return;
  spriteMousePassthrough = nextEnabled;
  if (window.desktopPet && window.desktopPet.pet && window.desktopPet.pet.setMousePassthrough) {
    const operation = window.desktopPet.pet.setMousePassthrough(nextEnabled);
    if (operation && typeof operation.catch === "function") {
      operation.catch((error) => {
        if (spriteMousePassthrough === nextEnabled) spriteMousePassthrough = null;
        logger.warn("mouse passthrough update failed", {
          enabled: nextEnabled,
          error: error && error.message ? error.message : String(error)
        });
      });
    }
  }
}

function syncHoverDurationWithPixelHit(isOpaquePixel, reason, { resetLatch = false } = {}) {
  const nextOpaquePixel = Boolean(isOpaquePixel);
  const pixelChanged = pointerHitsOpaquePixel !== nextOpaquePixel;
  pointerHitsOpaquePixel = nextOpaquePixel;
  const shouldTrackHover = nextOpaquePixel &&
    !petHidden &&
    !interactionsPaused &&
    activePointerId === null &&
    !dragStartedAt &&
    !Boolean(currentDisplay.mousePassthrough) &&
    (!animationController || animationController.getCurrentState() === "default");

  if (shouldTrackHover && !hoverStartedAt) {
    hoverStartedAt = Date.now();
    // The latch is per hover session, so arm it where the session begins. It
    // used to be cleared wherever tracking stopped, which included the hover
    // action itself starting - the state leaves "default" the moment the clip
    // plays - so an unmoved cursor fired the action again as soon as the clip
    // finished. Clearing only on a real pointer exit had the opposite fault: a
    // latch set earlier could never be released while the cursor stayed on the
    // pet. Arming at session start gives exactly one action per session.
    hoverDurationLatch.reset();
    debugRulesLog("hover:pixel-start", { reason });
    return;
  }

  if (!shouldTrackHover && (hoverStartedAt || pixelChanged)) {
    hoverStartedAt = 0;
    if (resetLatch && !nextOpaquePixel) hoverDurationLatch.reset();
    debugRulesLog("hover:pixel-stop", { reason, stillOnPet: nextOpaquePixel });
  }
}

function cancelPixelConfirmation() {
  if (!pixelConfirmationFrame) return;
  if (typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(pixelConfirmationFrame);
  }
  pixelConfirmationFrame = 0;
}

function invalidatePixelHit(reason) {
  cancelPixelConfirmation();
  pixelAlphaHitState = createAlphaHitState();
  syncHoverDurationWithPixelHit(false, reason, { resetLatch: false });
  setSpriteMousePassthrough(Boolean(petHidden || currentDisplay.mousePassthrough));
}

function schedulePixelConfirmation() {
  if (pixelConfirmationFrame || typeof window.requestAnimationFrame !== "function") return;
  pixelConfirmationFrame = window.requestAnimationFrame(() => {
    pixelConfirmationFrame = 0;
    refreshPixelMouseInteraction("alpha-confirmation");
  });
}

function setPetHidden(hidden, options = {}) {
  const hiddenBounds = hidden ? getRenderedMediaScreenRect() : null;
  const result = applyPetHiddenState({
    root,
    hidden,
    display: currentDisplay,
    setMousePassthrough: setSpriteMousePassthrough,
    logger: debugRulesLog,
    actionType: options.actionType,
    eventType: options.eventType
  });
  petHidden = result.hidden;
  hiddenPetBounds = result.hidden ? hiddenBounds : null;
  hiddenMouseLeaveDispatched = false;
  refreshPixelMouseInteraction(result.hidden ? "hidden" : "shown");
  return result;
}

function buildHiddenMouseLeaveContext(context) {
  const pointer = context && (context.screenPosition || context.mousePosition);
  const bounds = hiddenPetBounds || getRenderedMediaScreenRect();
  return {
    ...context,
    type: "mouseLeave",
    eventSource: "globalMouse",
    timestamp: Date.now(),
    petPosition: bounds || (context && context.petPosition),
    screenPosition: pointer,
    mousePosition: pointer,
    mouseLocalPosition: bounds && pointer ? {
      x: pointer.x - bounds.x,
      y: pointer.y - bounds.y
    } : context && context.mouseLocalPosition,
    isInsidePet: false
  };
}

function handleHiddenGlobalMouseLeave(context) {
  const pointer = context && (context.screenPosition || context.mousePosition);
  const bounds = hiddenPetBounds || getRenderedMediaScreenRect();
  if (!shouldDispatchHiddenMouseLeave({
    hidden: petHidden,
    leaveDispatched: hiddenMouseLeaveDispatched,
    pointer,
    bounds
  })) {
    return false;
  }

  hiddenMouseLeaveDispatched = true;
  debugRulesLog("visibility:hidden-global-leave", {
    pointer,
    bounds,
    eventSource: context && context.eventSource
  });
  evaluateRuntimeEvent(buildHiddenMouseLeaveContext(context));
  return true;
}

function getVisibleMediaElement() {
  if (spriteVideo && !spriteVideo.hidden) return spriteVideo;
  if (spriteGreenCanvas && !spriteGreenCanvas.hidden) return spriteGreenCanvas;
  if (spriteCanvas && !spriteCanvas.hidden) return spriteCanvas;
  if (spriteImage && !spriteImage.hidden) return spriteImage;
  return sprite;
}

function getMediaIntrinsicSize(element) {
  if (!element) return null;
  if (element === spriteVideo) {
    return spriteVideo.videoWidth && spriteVideo.videoHeight
      ? { width: spriteVideo.videoWidth, height: spriteVideo.videoHeight }
      : null;
  }
  if (element === spriteGreenCanvas) {
    // The green-screen canvas letterboxes the source video by its aspect ratio,
    // so the source video's intrinsic size describes the visible content.
    return spriteVideo.videoWidth && spriteVideo.videoHeight
      ? { width: spriteVideo.videoWidth, height: spriteVideo.videoHeight }
      : null;
  }
  if (element === spriteImage) {
    return spriteImage.naturalWidth && spriteImage.naturalHeight
      ? { width: spriteImage.naturalWidth, height: spriteImage.naturalHeight }
      : null;
  }
  if (element === spriteCanvas) {
    return spriteCanvas.width && spriteCanvas.height
      ? { width: spriteCanvas.width, height: spriteCanvas.height }
      : null;
  }
  return null;
}

function getRenderedMediaScreenRect() {
  const geometry = getVisibleMediaGeometry();
  return geometry ? geometry.contentRect : null;
}

function getVisibleMediaGeometry() {
  const element = getVisibleMediaElement();
  if (!element || typeof element.getBoundingClientRect !== "function") return null;

  const rect = element.getBoundingClientRect();
  const intrinsic = getMediaIntrinsicSize(element);
  const elementRect = {
    x: window.screenX + rect.left,
    y: window.screenY + rect.top,
    width: rect.width,
    height: rect.height
  };
  const contentRect = getObjectContainRect(elementRect, intrinsic) || elementRect;
  return { element, elementRect, intrinsic, contentRect };
}

function getDistanceToRect(point, rect) {
  if (!point || !rect || isPointInsideRect(point, rect)) return 0;
  const nearestX = Math.max(rect.x, Math.min(point.x, rect.x + rect.width));
  const nearestY = Math.max(rect.y, Math.min(point.y, rect.y + rect.height));
  return Math.hypot(point.x - nearestX, point.y - nearestY);
}

function refreshPixelMouseInteraction(reason, context = lastGlobalMouseMoveContext) {
  const contextPointer = context && (context.screenPosition || context.mousePosition);
  if (
    contextPointer &&
    Number.isFinite(Number(contextPointer.x)) &&
    Number.isFinite(Number(contextPointer.y))
  ) {
    lastPixelPointer = { x: Number(contextPointer.x), y: Number(contextPointer.y) };
  }
  const pointer = lastPixelPointer;
  const geometry = getVisibleMediaGeometry();
  const mapping = geometry && pointer && geometry.intrinsic
    ? mapPointToObjectContain({
      point: pointer,
      elementRect: geometry.elementRect,
      intrinsicSize: geometry.intrinsic
    })
    : geometry && pointer
      ? { status: isPointInsideRect(pointer, geometry.contentRect) ? "inside-unknown" : "outside" }
      : { status: "outside" };
  const pointerInsideContent = mapping.status === "mapped"
    ? true
    : mapping.status === "inside-unknown"
      ? true
    : mapping.status === "outside"
      ? false
      : undefined;

  let sampledAlpha = null;
  if (
    pointerInsideContent === true &&
    !petHidden &&
    !currentDisplay.mousePassthrough &&
    activePointerId === null &&
    !dragStartedAt
  ) {
    sampledAlpha = mediaRenderer.sampleAlphaAt({ x: mapping.sourceX, y: mapping.sourceY });
    pixelAlphaHitState = updateAlphaHitState(pixelAlphaHitState, sampledAlpha);
  } else if (pointerInsideContent !== true || petHidden || currentDisplay.mousePassthrough) {
    pixelAlphaHitState = createAlphaHitState();
  }

  const decision = resolvePixelMousePassthrough({
    hidden: petHidden,
    forcePassthrough: Boolean(currentDisplay.mousePassthrough),
    dragging: activePointerId !== null || Boolean(dragStartedAt),
    pointerInsideContent,
    alphaState: pixelAlphaHitState
  });
  const hitsOpaquePixel = Number.isFinite(sampledAlpha) &&
    pointerInsideContent === true &&
    pixelAlphaHitState.classification === PIXEL_HIT_OPAQUE;
  const resetHoverLatch = !hitsOpaquePixel && (
    petHidden ||
    currentDisplay.mousePassthrough ||
    activePointerId !== null ||
    pointerInsideContent === false ||
    pixelAlphaHitState.classification === PIXEL_HIT_TRANSPARENT ||
    reason === "mouse-leave" ||
    reason === "interactions-paused"
  );
  syncHoverDurationWithPixelHit(hitsOpaquePixel, reason, { resetLatch: resetHoverLatch });
  debugRulesLog("mouse-passthrough:pixel", {
    reason,
    eventType: context && context.type,
    eventSource: context && context.eventSource,
    hidden: petHidden,
    configuredMousePassthrough: Boolean(currentDisplay.mousePassthrough),
    mappingStatus: mapping.status,
    sampleKnown: Number.isFinite(sampledAlpha),
    classification: pixelAlphaHitState.classification,
    mousePassthrough: decision.mousePassthrough,
    decisionReason: decision.reason
  });
  setSpriteMousePassthrough(decision.mousePassthrough);
  if (
    Number.isFinite(sampledAlpha) &&
    pixelAlphaHitState.transparentFrames > 0 &&
    pixelAlphaHitState.classification !== PIXEL_HIT_TRANSPARENT
  ) {
    schedulePixelConfirmation();
  } else {
    cancelPixelConfirmation();
  }
  return decision;
}

function applyDisplay(display = {}) {
  currentDisplay = {
    ...currentDisplay,
    ...display
  };

  const scale = Number.isFinite(Number(currentDisplay.scale)) && Number(currentDisplay.scale) > 0
    ? Number(currentDisplay.scale)
    : 1;
  root.style.setProperty("--pet-scaled-sprite-size", `${Math.round(232 * scale)}px`);
  root.style.setProperty("--pet-padding-top", `${Math.round(64 * scale)}px`);
  root.style.setProperty("--pet-padding-x", `${Math.round(34 * scale)}px`);
  root.style.setProperty("--pet-padding-bottom", `${Math.round(28 * scale)}px`);
  root.style.setProperty("--pet-vertical-padding", `${Math.round(92 * scale)}px`);
  root.style.setProperty("--message-bubble-gap", `${Math.round(10 * scale)}px`);
  root.style.opacity = String(currentDisplay.opacity || 1);
  logger.debug("display applied", {
    scale,
    scaledSpriteSize: Math.round(232 * scale),
    messageBubbleGap: Math.round(10 * scale),
    opacity: currentDisplay.opacity || 1
  });
  refreshPixelMouseInteraction("display-change");
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => refreshPixelMouseInteraction("display-layout"));
  }

  pushRuntimeState();
}

function applyInteractionConfig(interactions = {}) {
  const bubbleConfig = interactions && interactions.bubble && typeof interactions.bubble === "object"
    ? interactions.bubble
    : {};
  const maxWidth = clampMessageBubbleMaxWidth(bubbleConfig.maxWidth) || DEFAULT_MESSAGE_BUBBLE_MAX_WIDTH;
  root.style.setProperty("--message-bubble-max-width", `${maxWidth}px`);
  logger.debug("message bubble config applied", { maxWidth });
}

function clearRuntimeTimers() {
  runtimeTimers.forEach((timerId) => window.clearTimeout(timerId));
  runtimeTimers.clear();
  clearMouseStillTimers();
  clearActionSequenceTimers("runtime-update");
  cancelPendingSingleClick("runtime-update");
  if (pomodoroRuntime) {
    pomodoroRuntime.destroy("runtime-update");
  }
}

function scheduleRuntimeTimeout(callback, delayMs) {
  let timerId = 0;
  timerId = window.setTimeout(() => {
    runtimeTimers.delete(timerId);
    callback();
  }, delayMs);
  runtimeTimers.add(timerId);
  return timerId;
}

function clearActionSequenceTimers(reason = "clear") {
  if (actionSequenceTimers.length > 0) {
    debugRulesLog("action-sequence:cancel", { reason, count: actionSequenceTimers.length });
  }
  actionSequenceTimers.forEach((timerId) => window.clearTimeout(timerId));
  actionSequenceTimers = [];
}

function getRuleConditions(rule) {
  if (Array.isArray(rule && rule.conditions)) return rule.conditions;
  return [];
}

function getRuleExitConditions(rule) {
  const state = rule && rule.state ? rule.state : null;
  return Array.isArray(state && state.exitConditions) ? state.exitConditions : [];
}

function getRuleAllConditions(rule) {
  return [...getRuleConditions(rule), ...getRuleExitConditions(rule)];
}

function runtimeHasCondition(type) {
  return runtimeModel.rules.some((rule) => getRuleAllConditions(rule).some((condition) => (
    condition && condition.type === type
  )));
}

function getScheduledConditionEntries(type) {
  const entries = [];
  runtimeModel.rules.forEach((rule) => {
    if (!rule || rule.enabled === false || !rule.id) return;
    // Scan both top-level conditions and state.exitConditions so a timer/randomTimer
    // placed in exitConditions (used to exit a sustained state on a timer) is also
    // scheduled. One timer per (rule, type): the first matching condition wins.
    // Multiple timer conditions on one rule would otherwise each schedule a timer
    // and double-fire the rule on every tick; use separate rules for distinct cadences.
    const condition = getRuleAllConditions(rule).find((item) => {
      if (!item) return false;
      return item.type === type;
    });
    if (!condition) return;
    entries.push({ rule, condition });
  });
  return entries;
}

function getMouseStillDurations() {
  const durations = [];
  for (const rule of runtimeModel.rules) {
    for (const condition of getRuleAllConditions(rule)) {
      if (!condition || condition.type !== "mouseStill") continue;

      const durationFilters = Array.isArray(condition.filters)
        ? condition.filters.filter((item) => item && item.field === "durationMs")
        : [];

      if (durationFilters.length === 0) {
        durations.push(1000);
        continue;
      }

      durationFilters.forEach((filter) => {
        const thresholds = getMouseStillThresholds(filter);
        durations.push(...thresholds);
      });
    }
  }

  return [...new Set(durations.map((duration) => Math.max(0, duration)).filter((duration) => Number.isFinite(duration)))]
    .sort((left, right) => left - right);
}

function getMouseStillThresholds(filter) {
  if (!filter || filter.field !== "durationMs") return [];
  if (Array.isArray(filter.value)) {
    const values = filter.value.map(Number).filter(Number.isFinite);
    if (values.length === 0) return [];
    return [Math.min(...values)];
  }

  const value = Number(filter.value);
  if (!Number.isFinite(value)) return [];
  return filter.operator === ">" ? [value + 1] : [value];
}

function clearMouseStillTimers() {
  if (mouseStillTimers.length > 0) {
    debugRulesLog("mouse-still:cancel", { count: mouseStillTimers.length });
  }
  mouseStillTimers.forEach((timerId) => window.clearTimeout(timerId));
  mouseStillTimers = [];
}

function scheduleMouseStillEvents(context) {
  clearMouseStillTimers();
  if (!runtimeHasCondition("mouseStill") || !context || context.type !== "mouseMove" || context.eventSource !== "globalMouse") return;

  const startedAt = Date.now();
  const durations = getMouseStillDurations();
  debugRulesLog("mouse-still:schedule", {
    durations,
    mousePosition: context.mousePosition
  });

  durations.forEach((durationMs) => {
    const timerId = window.setTimeout(() => {
      if (interactionsPaused) {
        debugRulesLog("mouse-still:paused", { durationMs });
        return;
      }

      const now = Date.now();
      const eventContext = createMouseStillContext({
        timestamp: now,
        previous: lastGlobalMouseMoveContext || context,
        durationMs: now - startedAt
      });
      debugRulesLog("mouse-still:trigger", {
        durationMs: eventContext.durationMs,
        mousePosition: eventContext.mousePosition
      });
      evaluateRuntimeEvent(eventContext);
    }, durationMs);
    mouseStillTimers.push(timerId);
  });
}

function markInteraction() {
  idleStartedAt = Date.now();
  if (idleDurationLatch.reset()) {
    debugRulesLog("duration-event:latch-reset", { type: "idleDuration", reason: "interaction" });
  }
}

function resetDurationSessions({ resumeHover = false, reason = "runtime-update" } = {}) {
  idleStartedAt = Date.now();
  idleDurationLatch.reset();
  hoverStartedAt = 0;
  hoverDurationLatch.reset();
  debugRulesLog("duration-event:sessions-reset", {
    reason,
    hoverResumed: false
  });
  if (resumeHover && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => refreshPixelMouseInteraction(`${reason}:hover-resume`));
  }
}

function pauseHoverForDrag(eventContext = {}) {
  if (!hoverStartedAt) return;
  debugRulesLog("hover:paused-drag", {
    eventType: eventContext.type,
    elapsedMs: Date.now() - hoverStartedAt
  });
  hoverStartedAt = 0;
  if (hoverDurationLatch.reset()) {
    debugRulesLog("duration-event:latch-reset", { type: "hoverDuration", reason: "drag" });
  }
}

function resumeHoverAfterDrag(event) {
  const context = getPointerContext("hoverDuration", event);
  refreshPixelMouseInteraction("drag-resume", context);
  if (!pointerHitsOpaquePixel || petHidden) {
    debugRulesLog("hover:resume-skipped", {
      pointerHitsOpaquePixel,
      petHidden
    });
    return;
  }

  debugRulesLog("hover:resumed-after-drag", {
    screenPosition: context.screenPosition
  });
}

/**
 * Sleeping is a sustained state. While the sleep transition or the sleep loop
 * is active (or already queued), the idle rule must not fire again: any pointer
 * pass over the sleeping pet re-arms the idle session, and a second idle event
 * would restart the whole sequence and visibly cut the loop back to the
 * transition clip. Waking the pet plays another clip, which lifts this hold.
 */
function isSleepStateActive() {
  const sleepClipIds = runtimeModel && runtimeModel.sleepStateClipIds;
  if (!sleepClipIds || sleepClipIds.size === 0 || !animationController) return false;
  const activeClip = animationController.getCurrentClip();
  if (activeClip && sleepClipIds.has(activeClip.id)) return true;
  const pending = animationController.pending;
  return Boolean(pending && sleepClipIds.has(pending.clipId));
}

function scheduleRuntimeEvents() {
  clearRuntimeTimers();

  if (runtimeHasCondition("idleDuration")) {
    // Use a fixed check interval (every 2 seconds) instead of reading from elapsedMs filter
    const intervalMs = 2000;
    const tickIdle = () => {
      const now = Date.now();
      if (isSleepStateActive()) {
        debugRulesLog("duration-event:held-asleep", { type: "idleDuration" });
        scheduleRuntimeTimeout(tickIdle, intervalMs);
        return;
      }
      const fired = idleDurationLatch.run(() => evaluateRuntimeEvent({
        type: "idleDuration",
        timestamp: now,
        eventSource: "timer",
        elapsedMs: now - idleStartedAt
      }));
      if (fired) {
        debugRulesLog("duration-event:latched", {
          type: "idleDuration",
          elapsedMs: now - idleStartedAt
        });
      }
      scheduleRuntimeTimeout(tickIdle, intervalMs);
    };
    scheduleRuntimeTimeout(tickIdle, intervalMs);
  }

  if (runtimeHasCondition("hoverDuration")) {
    // Use a fixed check interval (every 500ms)
    const intervalMs = 500;
    const tickHover = () => {
      if (interactionsPaused) {
        debugRulesLog("hover:paused");
      } else if (
        hoverStartedAt &&
        pointerHitsOpaquePixel &&
        !dragStartedAt &&
        animationController &&
        animationController.getCurrentState() === "default"
      ) {
        const now = Date.now();
        const pointer = lastPixelPointer;
        const mediaBounds = getRenderedMediaScreenRect();
        const baseContext = lastGlobalMouseMoveContext || {};
        const fired = hoverDurationLatch.run(() => evaluateRuntimeEvent({
          ...baseContext,
          type: "hoverDuration",
          timestamp: now,
          eventSource: "timer",
          elapsedMs: now - hoverStartedAt,
          petPosition: mediaBounds || baseContext.petPosition,
          screenPosition: pointer || baseContext.screenPosition,
          mousePosition: pointer || baseContext.mousePosition,
          isInsidePet: true
        }));
        if (fired) {
          debugRulesLog("duration-event:latched", {
            type: "hoverDuration",
            elapsedMs: now - hoverStartedAt
          });
        }
      }
      scheduleRuntimeTimeout(tickHover, intervalMs);
    };
    scheduleRuntimeTimeout(tickHover, intervalMs);
  }

  const timerEntries = getScheduledConditionEntries("timer");
  timerEntries.forEach(({ rule, condition }) => {
    const intervalMs = Math.max(500, Number(condition.intervalMs) || 5000);
    debugRulesLog("timer:schedule", { ruleId: rule.id, intervalMs });
    const tickTimer = () => {
      const now = new Date();
      evaluateRuntimeEvent({
        type: "timer",
        timerRuleId: rule.id,
        timestamp: now.getTime(),
        eventSource: "timer",
        currentTime: now.toISOString(),
        currentHour: now.getHours(),
        dayOfWeek: now.getDay()
      });
      scheduleRuntimeTimeout(tickTimer, intervalMs);
    };
    scheduleRuntimeTimeout(tickTimer, intervalMs);
  });

  const randomTimerEntries = getScheduledConditionEntries("randomTimer");
  randomTimerEntries.forEach(({ rule, condition }) => {
    const minMs = Math.max(500, Number(condition.minMs) || 5000);
    const maxMs = Math.max(minMs, Number(condition.maxMs) || minMs * 2);
    const getDelayMs = () => minMs + Math.random() * (maxMs - minMs);
    debugRulesLog("randomTimer:schedule", { ruleId: rule.id, minMs, maxMs });
    const tickRandom = () => {
      const now = new Date();
      evaluateRuntimeEvent({
        type: "randomTimer",
        timerRuleId: rule.id,
        timestamp: now.getTime(),
        eventSource: "timer",
        currentTime: now.toISOString(),
        currentHour: now.getHours(),
        dayOfWeek: now.getDay()
      });
      scheduleRuntimeTimeout(tickRandom, getDelayMs());
    };
    scheduleRuntimeTimeout(tickRandom, getDelayMs());
  });
}

function formatPomodoroTime(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(Number(remainingMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function updatePomodoroOverlay(state) {
  if (!pomodoroOverlay) return;
  if (!state || state.status !== "running") {
    pomodoroOverlay.hidden = true;
    pomodoroOverlay.textContent = "";
    pushRuntimeState();
    return;
  }

  const label = state.label ? `${state.label} ` : "";
  pomodoroOverlay.textContent = `${label}${formatPomodoroTime(state.remainingMs)}`;
  pomodoroOverlay.hidden = false;
  pushRuntimeState();
}

function initializePomodoroRuntime() {
  if (pomodoroRuntime) {
    pomodoroRuntime.destroy("reinitialize");
  }
  pomodoroRuntime = createPomodoroRuntime({
    now: () => Date.now(),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    onTick: updatePomodoroOverlay,
    onComplete: ({ label, durationMs, elapsedMs }) => {
      evaluateRuntimeEvent({
        type: "pomodoroComplete",
        timestamp: Date.now(),
        eventSource: "pomodoro",
        durationMs,
        elapsedMs,
        label
      });
    },
    logger
  });
}

function initializeActionExecutor() {
  initializePomodoroRuntime();
  userTriggerManager = new UserTriggerManager({
    playAnimation: (animId, options) => {
      if (animationController && animationController.hasClip(animId)) {
        // 由 AnimationController 内部排队/定时推进决定何时回默认，
        // 不再用外部 scheduleIdle 强制回 idle（会与队列打架）。
        const beforeState = animationController.getCurrentState();
        const beforeClip = animationController.getCurrentClip();
        const beforePending = animationController.pending;
        animationController.playAnimation(animId, options);
        const afterClip = animationController.getCurrentClip();
        const afterPending = animationController.pending;
        debugRulesLog("action:playAnimation:queued", {
          animId,
          durationMs: options.durationMs,
          beforeState,
          beforeClip: beforeClip && beforeClip.id,
          beforePending: beforePending && beforePending.clipId,
          afterState: animationController.getCurrentState(),
          afterClip: afterClip && afterClip.id,
          afterPending: afterPending && afterPending.clipId,
          outcome: afterClip && afterClip.id === animId ? "immediate" : "queued"
        });
        // Clip-bound movement is driven by the controller's onClipStart callback,
        // so it runs whether the clip plays immediately or is promoted from the
        // pending slot later (advanceToPending).
      } else {
        debugRulesLog("action:playAnimation:missingClip", { animId });
      }
    },
    isKeyframeAnimation: (animId) => {
      const clip = runtimeModel && runtimeModel.clipById ? runtimeModel.clipById.get(animId) : null;
      return Boolean(clip && clip.type === "keyframe");
    },
    mapKeyframeProgress: (animId, progress) => {
      const clip = runtimeModel && runtimeModel.clipById ? runtimeModel.clipById.get(animId) : null;
      return mapProgressThroughKeyframes(progress, clip && clip.keyframes);
    },
    setKeyframeProgress: (animId, progress, options) => {
      const hasClip = Boolean(animationController && animationController.hasClip(animId));
      debugRulesLog("action:setKeyframeProgress", {
        animId,
        progress,
        hasClip,
        eventAction: options
      });
      if (animationController && animationController.hasClip(animId)) {
        const applied = animationController.setKeyframeProgress(animId, progress ?? 0);
        debugRulesLog("action:setKeyframeProgress:applied", { animId, progress, applied });
      } else {
        debugRulesLog("action:setKeyframeProgress:missingClip", { animId, progress });
      }
    },
    stopAnimation: () => {
      if (animationController) {
        animationController.stopAnimation();
      }
    },
    showMessage: (text, options) => {
      const messages = currentConfig?.interactions?.clickMessages || [];
      const displayText = text || (messages.length > 0 ? messages[Math.floor(Math.random() * messages.length)] : "");
      const duration = options?.durationMs || currentConfig?.interactions?.bubble?.durationMs || 1800;
      showMessage(displayText, duration, options);
    },
    changeDisplay: (action) => {
      if (action.scale) {
        applyDisplay({ scale: action.scale });
      } else if (action.opacity) {
        applyDisplay({ opacity: action.opacity });
      }
    },
    setVisibility: (visible, options) => {
      setPetHidden(!visible, {
        actionType: options?.sourceActionType || "setVisibility",
        eventType: options?.eventType
      });
    },
    movePet,
    pomodoroTimer: (action, eventContext) => {
      if (!pomodoroRuntime) {
        initializePomodoroRuntime();
      }
      debugRulesLog("action:pomodoroTimer", {
        action,
        eventType: eventContext && eventContext.type,
        eventSource: eventContext && eventContext.eventSource
      });
      pomodoroRuntime.dispatch(action);
    },
    setInteractionsPaused: (paused, options) => {
      const nextPaused = Boolean(paused);
      // Update local state synchronously so subsequent actions in the same
      // sequence are not suppressed by canExecuteActionWhilePaused.
      interactionsPaused = nextPaused;
      debugRulesLog("action:setInteractionsPaused", {
        paused: nextPaused,
        sourceActionType: options?.sourceActionType,
        eventType: options?.eventType
      });
      if (window.desktopPet && window.desktopPet.pet && window.desktopPet.pet.setInteractionsPaused) {
        window.desktopPet.pet.setInteractionsPaused(nextPaused);
      }
    },
    resetPosition: () => {
      if (!window.desktopPet || !window.desktopPet.pet) return;
      cancelMovePetAnimation();
      clearDragVisualOffset("reset-position");
      const display = currentConfig?.display || {};
      window.desktopPet.pet.resetPosition({
        x: display.x || 80,
        y: display.y || 160
      });
    },
    openPanel: () => {
      if (window.desktopPet && window.desktopPet.panel) {
        window.desktopPet.panel.show();
      }
    }
  }, { logger });
}

function initializeAnimationController() {
  const animationConfig = runtimeModel.animationConfig || { default: { id: "idle", asset: "" }, clips: [] };
  animationMovementRunner = createAnimationMovementRunner({
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (frameId) => window.cancelAnimationFrame(frameId),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) => window.clearTimeout(timeoutId),
    now: () => performance.now(),
    getPosition: () => ({ x: window.screenX, y: window.screenY }),
    getSize: () => ({ width: window.outerWidth, height: window.outerHeight }),
    refreshWorkArea: refreshDesktopWorkArea,
    clearDragVisualOffset,
    resolveMoveDirection,
    resolveMoveSpeed,
    wrapBoundsToScreen,
    boundsScheduler,
    logger,
    pushRuntimeState
  });

  animationController = new AnimationController(
    animationConfig,
    {
      renderClip: (asset, options) => {
        invalidatePixelHit("clip-render");
        mediaRenderer.render(asset, {
          state: options.clipId || "playing",
          loop: Boolean(options.loop),
          keyframe: Boolean(options.keyframe),
          progress: options.progress || 0,
          greenScreen: options.greenScreen
        });
      },
      onClipStart: (clip) => {
        // A clip became active (immediate play, queue-advance, or return-to-default).
        // Drive clip-bound movement here so it runs no matter how the clip was reached.
        if (clip && clip.movement && clip.movement.direction) {
          animationMovementRunner.start(clip).catch((error) =>
            logger.error("Failed to start animation movement", error)
          );
        } else {
          cancelAnimationMovement();
        }
      },
      setProgress: (progress) => {
        mediaRenderer.setProgress(progress);
      }
    },
    { logger }
  );
}

function applyRuntime(runtime) {
  resetDurationSessions({
    resumeHover: true,
    reason: runtime && runtime.updateReason ? runtime.updateReason : "initial-load"
  });
  currentConfig = runtime && runtime.config ? runtime.config : currentConfig;
  // 调试日志开关跟随系统设置里的日志开关和日志等级。
  setDebugRulesEnabled(
    currentConfig?.system?.logging?.enabled !== false,
    currentConfig?.system?.logging?.level || "info"
  );
  runtimeModel = buildRuntimeModel({
    config: currentConfig || {},
    activePackage: runtime && runtime.package ? runtime.package : null
  });
  debugRulesLog("applyRuntime", {
    packageId: currentConfig && currentConfig.currentPackageId,
    ruleCount: runtimeModel.rules.length,
    rules: runtimeModel.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      continuous: rule.continuous,
      conditions: rule.conditions,
      actions: rule.actions,
      state: rule.state
    })),
    clips: runtimeModel.animationConfig && runtimeModel.animationConfig.clips
  });
  if (ruleRuntime && typeof ruleRuntime.destroy === "function") {
    ruleRuntime.destroy();
  }
  ruleRuntime = createRuleRuntime({
    rules: runtimeModel.rules,
    onTimerActions: (actions, eventContext) => {
      if (actions.length > 0) {
        executeRuntimeActions(actions, eventContext);
      }
    }
  });

  // Initialize or update animation controller
  if (animationController) {
    animationController.updateConfig(runtimeModel.animationConfig || { default: { id: "idle", asset: "" }, clips: [] });
  }

  applyDisplay((currentConfig && currentConfig.display) || {});
  applyInteractionConfig((currentConfig && currentConfig.interactions) || {});
  interactionsPaused = Boolean(currentConfig && currentConfig.system && currentConfig.system.interactionsPaused);
  scheduleRuntimeEvents();
}

async function loadInitialConfig() {
  if (!window.desktopPet) return;

  try {
    initializeActionExecutor();

    if (window.desktopPet.pet && window.desktopPet.pet.loadRuntime) {
      applyRuntime(await window.desktopPet.pet.loadRuntime());
    } else if (window.desktopPet.config) {
      currentConfig = await window.desktopPet.config.load();

      // Initialize locale from config
      if (currentConfig.system?.language) {
        setLocale(currentConfig.system.language);
      }

      applyRuntime({ config: currentConfig, package: null });
    }

    // Initialize animation controller after runtime is loaded
    initializeAnimationController();

    // Update window title
    document.title = t("pet.title");

    playDefaultThenDispatchLifecycleEvents({
      playDefault: playDefaultAnimation,
      evaluateEvent: evaluateRuntimeEvent,
      defaultReason: "initialLoad",
      eventTypes: ["appLaunch"]
    });
  } catch (error) {
    logger.error("Failed to load pet config", error);
  }
}

function getPetPosition() {
  return {
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight
  };
}

function getScreenPosition(event) {
  return {
    x: event && Number.isFinite(event.screenX) ? event.screenX : window.screenX,
    y: event && Number.isFinite(event.screenY) ? event.screenY : window.screenY
  };
}

function getPointerContext(type, event) {
  const petPosition = getPetPosition();
  const screenPosition = getScreenPosition(event);
  const isInsidePet = isPointInsideRect(screenPosition, petPosition);

  return {
    type,
    timestamp: Date.now(),
    eventSource: "petRenderer",
    petPosition,
    screenPosition,
    mousePosition: screenPosition,
    mouseLocalPosition: {
      x: screenPosition.x - petPosition.x,
      y: screenPosition.y - petPosition.y
    },
    isInsidePet,
    distanceToPetCenter: Math.hypot(
      screenPosition.x - (petPosition.x + petPosition.width / 2),
      screenPosition.y - (petPosition.y + petPosition.height / 2)
    ),
    distanceToPetBounds: getDistanceToRect(screenPosition, petPosition)
  };
}

function getMouseMoveContext(event) {
  const timestamp = Date.now();
  const petPosition = getPetPosition();
  const mousePosition = getScreenPosition(event);
  const context = {
    ...createMouseMoveContext({
      timestamp,
      previous: lastMouseMoveContext,
      mousePosition,
      petPosition
    }),
    eventSource: "petRenderer"
  };
  lastMouseMoveContext = context;
  return context;
}

function getDragContext(type, event) {
  const context = getPointerContext(type, event);
  const currentPosition = getScreenPosition(event);
  const startPosition = dragStartPosition || currentPosition;

  return {
    ...context,
    dragStartPosition: startPosition,
    currentPosition,
    dragDeltaX: currentPosition.x - startPosition.x,
    dragDeltaY: currentPosition.y - startPosition.y,
    dragDistance: Math.hypot(currentPosition.x - startPosition.x, currentPosition.y - startPosition.y),
    dragDurationMs: dragStartedAt ? Math.max(0, context.timestamp - dragStartedAt) : 0
  };
}

function canExecuteActionWhilePaused(action) {
  return !interactionsPaused || (action && action.type === "enableInteractions");
}

function executeRuntimeActions(actions, eventContext = {}) {
  clearActionSequenceTimers("new-action-sequence");

  scheduleActionSequence(actions, {
    setTimeout: window.setTimeout.bind(window),
    runAction: (action, index) => {
      if (!userTriggerManager) return;
      if (!canExecuteActionWhilePaused(action)) {
        debugRulesLog("action:suppressed-paused", {
          index,
          actionType: action.type,
          eventType: eventContext && eventContext.type
        });
        return;
      }
      debugRulesLog("execute-action", {
        index,
        action,
        eventType: eventContext && eventContext.type,
        eventSource: eventContext && eventContext.eventSource,
        angleToPetProgress: eventContext && eventContext.angleToPetProgress
      });
      userTriggerManager.executeAction(action, eventContext);
    },
    onScheduled: ({ timerId, action, index, delayMs }) => {
      debugRulesLog("action-sequence:schedule", {
        index,
        actionType: action.type,
        delayMs
      });
      actionSequenceTimers.push(timerId);
    },
    afterRun: ({ timerId }) => {
      actionSequenceTimers = actionSequenceTimers.filter((item) => item !== timerId);
      pushRuntimeState();
    }
  });

  pushRuntimeState();
  return actions.length > 0;
}

// Discrete interaction events whose animation should not be interrupted by
// competing mouseMove rules. Drag events are handled via dragStartedAt instead.
const DISCRETE_INTERACTION_EVENT_TYPES = new Set([
  "click",
  "doubleClick",
  "rightClick",
  "mouseEnter",
  "mouseLeave"
]);

function evaluateRuntimeEvent(eventContext) {
  if (!ruleRuntime || !userTriggerManager) return false;

  if (interactionsPaused && eventContext) {
    if (!LIFECYCLE_EVENT_TYPES.has(eventContext.type)) {
      debugRulesLog("event:suppressed-paused", {
        type: eventContext.type,
        eventSource: eventContext.eventSource
      });
      return false;
    }
    debugRulesLog("event:evaluate-paused-lifecycle", {
      type: eventContext.type
    });
  }

  // While dragging the pet, suppress competing mouseMove events so the drag
  // animation isn't interrupted by "enter range" style mouseMove rules.
  // Drag, dragStart and dragEnd events themselves are still evaluated.
  if (dragStartedAt && eventContext && eventContext.type === "mouseMove") {
    debugRulesLog("event:suppressed-drag", {
      eventSource: eventContext.eventSource,
      distanceToPetCenter: eventContext.distanceToPetCenter
    });
    return false;
  }

  if (dragStartedAt && eventContext && eventContext.type === "hoverDuration") {
    debugRulesLog("event:suppressed-hover-drag", {
      elapsedMs: eventContext.elapsedMs,
      eventSource: eventContext.eventSource
    });
    return false;
  }

  if (shouldSuppressRuntimeEventDuringDrag({ dragStartedAt, event: eventContext })) {
    debugRulesLog("event:suppressed-drag-active", {
      type: eventContext.type,
      eventSource: eventContext.eventSource
    });
    return false;
  }

  if (shouldSuppressRuntimeEventWhileAsleep({ sleepActive: isSleepStateActive(), event: eventContext })) {
    debugRulesLog("event:suppressed-asleep", {
      type: eventContext.type,
      eventSource: eventContext.eventSource
    });
    return false;
  }

  // After a discrete interaction (click/enter/etc.) fires its animation, keep
  // suppressing mouseMove for the animation window so it isn't overridden.
  if (
    eventContext &&
    eventContext.type === "mouseMove" &&
    !isGlobalKeyframeMouseMove(eventContext) &&
    Date.now() < mouseMoveSuppressedUntil
  ) {
    debugRulesLog("event:suppressed-discrete", {
      eventSource: eventContext.eventSource,
      distanceToPetCenter: eventContext.distanceToPetCenter,
      until: mouseMoveSuppressedUntil,
      now: Date.now()
    });
    return false;
  }

  debugRulesLog("event:evaluate", {
    type: eventContext && eventContext.type,
    eventSource: eventContext && eventContext.eventSource,
    distanceToPetCenter: eventContext && eventContext.distanceToPetCenter,
    distanceToPetBounds: eventContext && eventContext.distanceToPetBounds,
    angleToPetProgress: eventContext && eventContext.angleToPetProgress,
    isInsidePet: eventContext && eventContext.isInsidePet
  });

  const actions = ruleRuntime.evaluateEvent(eventContext);
  debugRulesLog("event:actions", { actions });
  const fired = actions.length > 0 && executeRuntimeActions(actions, eventContext);

  // When a discrete interaction matches a rule, arm the mouseMove suppress
  // window for the duration of the actions it ran.
  if (
    fired &&
    eventContext &&
    DISCRETE_INTERACTION_EVENT_TYPES.has(eventContext.type)
  ) {
    if (typeof ruleRuntime.resetPendingMouseMoveEnters === "function") {
      ruleRuntime.resetPendingMouseMoveEnters(eventContext);
    }
    const sequenceDurationMs = getActionSequenceDurationMs(actions);
    mouseMoveSuppressedUntil = Date.now() + Math.max(MOUSE_MOVE_SUPPRESS_DEFAULT_MS, sequenceDurationMs);
  }

  return fired;
}

function handlePointerDown(event) {
  markInteraction();
  if (interactionsPaused || currentDisplay.locked) {
    return;
  }
  if (event.button !== 0) return;

  cancelMovePetAnimation();
  activePointerId = event.pointerId;
  syncHoverDurationWithPixelHit(false, "pointer-down");
  refreshPixelMouseInteraction("pointer-down", getPointerContext("pointerDown", event));
  petController.startDrag(event);
}

function finishPointerInteraction(event, method) {
  const pointerId = event && event.pointerId;
  method(event);
  if (activePointerId === pointerId) {
    activePointerId = null;
    refreshPixelMouseInteraction("pointer-finished", getPointerContext("pointerFinished", event));
  }
}

function handleLostPointerCapture(event) {
  petController.lostPointerCapture(event);
  if (activePointerId === null || !event || activePointerId === event.pointerId) {
    activePointerId = null;
    refreshPixelMouseInteraction("pointer-capture-lost");
  }
}

function handlePetClick(event) {
  markInteraction();
  if (interactionsPaused) {
    cancelPendingSingleClick("interactions-paused");
    stopPetEvent(event);
    return;
  }

  if (!runtimeHasCondition("doubleClick")) {
    petController.click(event);
    return;
  }

  cancelPendingSingleClick("new-click");
  pendingSingleClickTimer = window.setTimeout(() => {
    pendingSingleClickTimer = 0;
    debugRulesLog("single-click:confirmed");
    petController.click(event);
  }, SINGLE_CLICK_CONFIRM_DELAY_MS);
  debugRulesLog("single-click:pending", { delayMs: SINGLE_CLICK_CONFIRM_DELAY_MS });
}

function handleContextMenu(event) {
  event.preventDefault();
  stopPetEvent(event);
  markInteraction();
  const context = getPointerContext("rightClick", event);

  // Right-click behavior is configured by trigger rules, including the default open-panel rule.
  evaluateRuntimeEvent(context);
}

const boundsScheduler = createBoundsScheduler({
  setBounds: (bounds) => {
    if (!window.desktopPet || !window.desktopPet.pet) return undefined;
    return window.desktopPet.pet.setBounds(bounds);
  },
  logger,
  onError: (...args) => logger.error(...args)
});

const petController = createPetController({
  clearIdle: () => window.clearTimeout(stateTimer),
  movePetWindow: (bounds) => boundsScheduler.request(bounds),
  getWindowPosition: () => ({ x: window.screenX, y: window.screenY }),
  getWindowSize: () => ({ width: window.outerWidth, height: window.outerHeight }),
  getDragTopBoundary,
  setDraggingClass: (enabled) => sprite.classList.toggle("dragging", enabled),
  setDragVisualOffset,
  setPointerCapture: (pointerId) => sprite.setPointerCapture(pointerId),
  releasePointerCapture: (pointerId) => sprite.releasePointerCapture(pointerId),
  hasPointerCapture: (pointerId) => sprite.hasPointerCapture(pointerId),
  onClick: (event) => {
    const context = getPointerContext("click", event);
    return evaluateRuntimeEvent(context);
  },
  onDragStart: (event) => {
    dragStartedAt = Date.now();
    dragStartPosition = getScreenPosition(event);
    const context = getDragContext("dragStart", event);
    debugRulesLog("drag:start", {
      animState: animationController && animationController.getCurrentState(),
      animClip: animationController && animationController.getCurrentClip() && animationController.getCurrentClip().id
    });
    pauseHoverForDrag(context);
    refreshPixelMouseInteraction("drag-start", context);
    return evaluateRuntimeEvent(context);
  },
  onDragging: (event) => {
    const context = getDragContext("dragging", event);
    return evaluateRuntimeEvent(context);
  },
  onDragEnd: (event) => {
    const context = getDragContext("dragEnd", event);
    debugRulesLog("drag:end", {
      animState: animationController && animationController.getCurrentState(),
      animClip: animationController && animationController.getCurrentClip() && animationController.getCurrentClip().id,
      animPending: animationController && animationController.pending && animationController.pending.clipId
    });
    const handled = evaluateRuntimeEvent(context);
    dragStartedAt = 0;
    dragStartPosition = null;
    markInteraction();
    resumeHoverAfterDrag(event);
    return handled;
  },
  onDragCancel: (event) => {
    debugRulesLog("drag:cancel", {
      pointerId: event && event.pointerId,
      dragStartedAt
    });
    dragStartedAt = 0;
    dragStartPosition = null;
    markInteraction();
    resumeHoverAfterDrag(event);
  }
});

sprite.addEventListener("pointerdown", handlePointerDown);
sprite.addEventListener("pointermove", petController.continueDrag);
sprite.addEventListener("pointerup", (event) => finishPointerInteraction(event, petController.endDrag));
sprite.addEventListener("pointercancel", (event) => finishPointerInteraction(event, petController.endDrag));
sprite.addEventListener("lostpointercapture", handleLostPointerCapture);

sprite.addEventListener("click", handlePetClick);
sprite.addEventListener("dblclick", (event) => {
  markInteraction();
  cancelPendingSingleClick("double-click");
  if (interactionsPaused) {
    stopPetEvent(event);
    return;
  }
  const context = getPointerContext("doubleClick", event);
  evaluateRuntimeEvent(context);
});
sprite.addEventListener("mouseenter", (event) => {
  if (petHidden) {
    debugRulesLog("event:suppressed-hidden-enter");
    return;
  }
  if (interactionsPaused) {
    hoverStartedAt = 0;
    debugRulesLog("event:suppressed-paused-enter");
    return;
  }
  const context = getPointerContext("mouseEnter", event);
  refreshPixelMouseInteraction("mouse-enter", context);
  if (!pointerHitsOpaquePixel) return;
  markInteraction();
  evaluateRuntimeEvent(context);
});
sprite.addEventListener("mouseleave", (event) => {
  const wasOpaque = pointerHitsOpaquePixel;
  const context = getPointerContext("mouseLeave", event);
  const pointer = context.screenPosition || context.mousePosition;
  if (pointer) lastPixelPointer = { x: pointer.x, y: pointer.y };
  cancelPixelConfirmation();
  pixelAlphaHitState = createAlphaHitState();
  syncHoverDurationWithPixelHit(false, "mouse-leave", { resetLatch: true });
  setSpriteMousePassthrough(resolvePixelMousePassthrough({
    hidden: petHidden,
    forcePassthrough: Boolean(currentDisplay.mousePassthrough),
    dragging: activePointerId !== null || Boolean(dragStartedAt),
    pointerInsideContent: false,
    alphaState: pixelAlphaHitState
  }).mousePassthrough);
  if (interactionsPaused) {
    debugRulesLog("event:suppressed-paused-leave");
    return;
  }
  if (petHidden) {
    debugRulesLog("event:suppressed-hidden-leave", {
      screenPosition: context.screenPosition,
      hiddenPetBounds
    });
    return;
  }
  if (!wasOpaque) return;
  markInteraction();
  evaluateRuntimeEvent(context);
});

// Throttle mousemove to 100ms to avoid excessive event processing
const throttledMouseMove = throttle((event) => {
  if (!interactionsPaused) {
    const context = getMouseMoveContext(event);
    refreshPixelMouseInteraction("local-mouse-move", context);
    if (!pointerHitsOpaquePixel) return;
    markInteraction();
    evaluateRuntimeEvent(context);
  }
}, 100);

sprite.addEventListener("mousemove", throttledMouseMove);
root.addEventListener("contextmenu", handleContextMenu);

loadInitialConfig();

if (window.desktopPet && window.desktopPet.pet) {
  window.desktopPet.pet.onPlayAnimation((animationId) => {
    if (animationController && animationController.hasClip(animationId)) {
      animationController.playAnimation(animationId);
    }
  });
  window.desktopPet.pet.onDisplayUpdated(applyDisplay);
  window.desktopPet.pet.onRuntimeUpdated((runtime) => {
    applyRuntime(runtime);

    const updateReason = runtime && runtime.updateReason;
    if (shouldReturnToDefaultForRuntimeUpdate(updateReason)) {
      playDefaultThenDispatchLifecycleEvents({
        playDefault: playDefaultAnimation,
        evaluateEvent: evaluateRuntimeEvent,
        defaultReason: "runtimeUpdated",
        eventTypes: getRuntimeUpdateLifecycleEvents(updateReason)
      });
    }
  });
  window.desktopPet.pet.onInteractionsPaused((enabled) => {
    interactionsPaused = enabled;
    if (interactionsPaused) {
      syncHoverDurationWithPixelHit(false, "interactions-paused", { resetLatch: true });
      debugRulesLog("interactions:paused", { hoverStartedAt });
    } else {
      resetDurationSessions({ resumeHover: true, reason: "interactions-resumed" });
      refreshPixelMouseInteraction("interactions-resumed");
      debugRulesLog("interactions:resumed");
    }
  });
  window.desktopPet.pet.onGlobalMouseMove((context) => {
    lastGlobalMouseMoveContext = context;
    refreshPixelMouseInteraction("global-pointer", context);
    if (context && context.pointerMoved !== false) {
      if (pointerHitsOpaquePixel) {
        scheduleMouseStillEvents(context);
      } else {
        clearMouseStillTimers();
      }
    }
    debugRulesLog("global-mouse", {
      distanceToPetCenter: context && context.distanceToPetCenter,
      distanceToPetBounds: context && context.distanceToPetBounds,
      angleToPetProgress: context && context.angleToPetProgress,
      isInsidePet: context && context.isInsidePet,
      mousePosition: context && context.mousePosition
    });
    if (context && context.pointerMoved === false) {
      handleHiddenGlobalMouseLeave(context);
      debugRulesLog("global-mouse:bounds-only", {
        boundsChanged: context.boundsChanged,
        isInsidePet: context.isInsidePet
      });
      return;
    }
    if (interactionsPaused) {
      debugRulesLog("global-mouse:paused");
      return;
    }
    if (shouldSkipRuntimeEventWhileHidden({ hidden: petHidden, event: context })) {
      handleHiddenGlobalMouseLeave(context);
      debugRulesLog("global-mouse:hidden-runtime-skipped", {
        distanceToPetCenter: context && context.distanceToPetCenter,
        isInsidePet: context && context.isInsidePet
      });
      return;
    }
    if (pointerHitsOpaquePixel || Boolean(context && context.isInsidePet === false)) {
      evaluateRuntimeEvent(context);
    }
  });
}

// The pinned Electron delivery verifier uses the same media sampler as normal
// pointer hit-testing to locate a real opaque pixel before sending native input.
// This diagnostic surface is read-only and does not mutate hit-test state or
// dispatch runtime events; the input event is still checked again by the normal
// pointer path.
Object.defineProperty(window, "__samplePetPixelsForVerification", {
  configurable: false,
  enumerable: false,
  writable: false,
  value(points) {
    if (!Array.isArray(points) || points.length > 4096) return [];
    const geometry = getVisibleMediaGeometry();
    if (!geometry || !geometry.intrinsic) return [];
    return points.map((point) => {
      const clientX = Number(point && point.x);
      const clientY = Number(point && point.y);
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
        return { status: "invalid", alpha: null };
      }
      const mapping = mapPointToObjectContain({
        point: { x: window.screenX + clientX, y: window.screenY + clientY },
        elementRect: geometry.elementRect,
        intrinsicSize: geometry.intrinsic
      });
      return {
        status: mapping.status,
        alpha: mapping.status === "mapped"
          ? mediaRenderer.sampleAlphaAt({ x: mapping.sourceX, y: mapping.sourceY })
          : null
      };
    });
  }
});

// Expose runtime state for panel queries
window.__getPetRuntimeState = function () {
  if (!runtimeModel || !ruleRuntime) {
    return null;
  }

  const currentClip = animationController && typeof animationController.getCurrentClip === "function"
    ? animationController.getCurrentClip()
    : null;
  const currentState = (currentClip && currentClip.id) || sprite.dataset.state || "idle";
  const currentSprite = mediaRenderer.getCurrentAsset() || (currentClip && currentClip.asset) || "";

  return {
    currentState: {
      animation: currentState,
      animationState: animationController && typeof animationController.getCurrentState === "function" ? animationController.getCurrentState() : sprite.dataset.state || "idle",
      sprite: currentSprite,
      position: { x: window.screenX, y: window.screenY },
      display: {
        scale: currentDisplay.scale || 1,
        opacity: currentDisplay.opacity || 1,
        alwaysOnTop: true
      }
    },
    recentEvents: ruleRuntime.getRecentEvents().slice(-10),
    ruleStates: ruleRuntime.getLastTriggeredAtByRuleId(),
    statefulStates: typeof ruleRuntime.getRuleState === "function" ? ruleRuntime.getRuleState() : {},
    timers: {
      idleStartedAt,
      hoverStartedAt,
      dragStartedAt
    },
    interactionsPaused
  };
};

// Push runtime state with throttling
function pushRuntimeState() {
  if (!window.desktopPet || !window.desktopPet.pet || !window.desktopPet.pet.pushRuntimeState) {
    return;
  }

  const now = Date.now();
  if (now - lastPushTime < PUSH_THROTTLE_MS) {
    return;
  }

  lastPushTime = now;

  const state = window.__getPetRuntimeState();
  if (state) {
    window.desktopPet.pet.pushRuntimeState(state);
  }
}
