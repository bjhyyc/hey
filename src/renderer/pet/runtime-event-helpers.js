export function createOneShotEventLatch() {
  let latched = false;

  return {
    run(callback) {
      if (latched || typeof callback !== "function") return false;

      const fired = Boolean(callback());
      if (fired) latched = true;
      return fired;
    },

    reset() {
      const wasLatched = latched;
      latched = false;
      return wasLatched;
    },

    isLatched() {
      return latched;
    }
  };
}

export function playDefaultThenDispatchLifecycleEvents({
  playDefault,
  evaluateEvent,
  defaultReason,
  eventTypes = [],
  now = Date.now,
  eventSource = "petRenderer"
} = {}) {
  if (typeof playDefault === "function") {
    playDefault(defaultReason);
  }

  if (typeof evaluateEvent !== "function") return;

  eventTypes.forEach((type) => {
    if (typeof type !== "string" || !type) return;
    evaluateEvent({
      type,
      timestamp: now(),
      eventSource
    });
  });
}

export function getRuntimeUpdateLifecycleEvents(updateReason) {
  return updateReason === "packageChanged" ? ["packageLoaded"] : [];
}

export function shouldReturnToDefaultForRuntimeUpdate(updateReason) {
  return updateReason === "packageChanged" || updateReason === "assetsChanged";
}
