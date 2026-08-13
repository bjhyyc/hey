export const DRAG_EVENT_TYPES = new Set(["dragStart", "dragging", "dragEnd"]);
export const LIFECYCLE_EVENT_TYPES = new Set(["appLaunch", "packageLoaded"]);

export function shouldSuppressRuntimeEventDuringDrag({
  dragStartedAt = 0,
  event = null
} = {}) {
  if (!dragStartedAt || !event || !event.type) return false;
  if (DRAG_EVENT_TYPES.has(event.type)) return false;
  if (LIFECYCLE_EVENT_TYPES.has(event.type)) return false;
  return true;
}
