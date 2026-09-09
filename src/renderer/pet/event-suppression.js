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

// Sleep is a sustained state the customer expects to hold: a sleeping pet must
// not sneeze at a click, roll at a double click or look up at a hovering
// cursor. While a sleep clip is active or pending, the only interaction that
// reaches the rules is the right-click wake; app lifecycle events still pass
// so package reloads and launches are never blocked by a sleeping pet.
export function shouldSuppressRuntimeEventWhileAsleep({
  sleepActive = false,
  event = null
} = {}) {
  if (!sleepActive || !event || !event.type) return false;
  if (event.type === "rightClick") return false;
  if (LIFECYCLE_EVENT_TYPES.has(event.type)) return false;
  return true;
}

// The Hey contract reserves right-click exclusively for waking from sleep.
// Do not let the same event reach ordinary rules while the pet is awake.
export function shouldSuppressRightClickWhileAwake({ sleepActive = false, event = null } = {}) {
  return Boolean(event && event.type === "rightClick" && !sleepActive);
}
