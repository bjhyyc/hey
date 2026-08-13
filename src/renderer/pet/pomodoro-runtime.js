const DEFAULT_POMODORO_DURATION_MS = 25 * 60 * 1000;
const POMODORO_TICK_MS = 1000;

function createIdleState() {
  return {
    status: "idle",
    label: "",
    durationMs: 0,
    remainingMs: 0,
    startedAt: 0,
    endsAt: 0
  };
}

function normalizeDurationMs(durationMs, logger) {
  const normalized = Number(durationMs);
  if (Number.isFinite(normalized) && normalized > 0) return Math.round(normalized);
  if (logger && logger.warn) {
    logger.warn("pomodoro invalid duration fallback", { durationMs });
  }
  return DEFAULT_POMODORO_DURATION_MS;
}

export function createPomodoroRuntime({
  now = () => Date.now(),
  setTimeout: scheduleTimeout = globalThis.setTimeout.bind(globalThis),
  clearTimeout: cancelTimeout = globalThis.clearTimeout.bind(globalThis),
  onTick = () => {},
  onComplete = () => {},
  logger = console
} = {}) {
  let state = createIdleState();
  let tickTimer = 0;

  function clearTickTimer() {
    if (!tickTimer) return;
    cancelTimeout(tickTimer);
    tickTimer = 0;
  }

  function emitTick() {
    onTick({ ...state });
  }

  function finish() {
    if (state.status !== "running") return;
    const completed = {
      label: state.label,
      durationMs: state.durationMs,
      elapsedMs: Math.max(0, now() - state.startedAt)
    };
    logger.debug("pomodoro complete", completed);
    clearTickTimer();
    state = createIdleState();
    emitTick();
    onComplete(completed);
  }

  function scheduleTick() {
    clearTickTimer();
    if (state.status !== "running") return;
    tickTimer = scheduleTimeout(() => {
      tickTimer = 0;
      if (state.status !== "running") return;
      const remainingMs = Math.max(0, state.endsAt - now());
      state = { ...state, remainingMs };
      emitTick();
      if (remainingMs <= 0) {
        finish();
        return;
      }
      scheduleTick();
    }, Math.min(POMODORO_TICK_MS, Math.max(0, state.endsAt - now())));
  }

  function start(action = {}) {
    clearTickTimer();
    const durationMs = normalizeDurationMs(action.durationMs, logger);
    const startedAt = now();
    state = {
      status: "running",
      label: String(action.label || "").trim(),
      durationMs,
      remainingMs: durationMs,
      startedAt,
      endsAt: startedAt + durationMs
    };
    logger.debug("pomodoro start", { durationMs: state.durationMs, label: state.label });
    emitTick();
    scheduleTick();
  }

  function cancel(reason = "cancel") {
    if (state.status !== "running") return;
    logger.debug("pomodoro cancel", {
      reason,
      durationMs: state.durationMs,
      remainingMs: state.remainingMs,
      label: state.label
    });
    clearTickTimer();
    state = createIdleState();
    emitTick();
  }

  function dispatch(action = {}) {
    if (action.command === "cancel") {
      cancel("action");
      return;
    }
    if (action.command && action.command !== "start") {
      logger.warn("pomodoro unknown command fallback", { command: action.command });
    }
    start(action);
  }

  function destroy(reason = "destroy") {
    cancel(reason);
    clearTickTimer();
  }

  return {
    start,
    cancel,
    dispatch,
    destroy,
    getState: () => ({ ...state })
  };
}
