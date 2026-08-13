function getActionDurationMs(action) {
  const durationMs = Number(action && action.durationMs);
  return Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
}

function getActionWaitMs(action) {
  return action && action.type === "delay" ? getActionDurationMs(action) : 0;
}

function getActionSequenceDurationMs(actions = []) {
  return Array.isArray(actions)
    ? actions.reduce((total, action) => total + getActionDurationMs(action), 0)
    : 0;
}

function scheduleActionSequence(actions = [], {
  runAction,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  afterRun,
  onScheduled
} = {}) {
  if (!Array.isArray(actions) || typeof runAction !== "function") return [];

  const timers = [];
  let delayMs = 0;

  actions.forEach((action, index) => {
    if (!action) return;

    if (delayMs > 0) {
      let timerId;
      timerId = scheduleTimeout(() => {
        runAction(action, index);
        if (typeof afterRun === "function") {
          afterRun({ timerId, action, index, delayMs });
        }
      }, delayMs);
      timers.push(timerId);
      if (typeof onScheduled === "function") {
        onScheduled({ timerId, action, index, delayMs });
      }
    } else {
      runAction(action, index);
    }

    delayMs += getActionWaitMs(action);
  });

  return timers;
}

export {
  getActionDurationMs,
  getActionSequenceDurationMs,
  getActionWaitMs,
  scheduleActionSequence
};

export default {
  getActionDurationMs,
  getActionSequenceDurationMs,
  getActionWaitMs,
  scheduleActionSequence
};
