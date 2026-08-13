import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPomodoroRuntime } from "../../src/renderer/pet/pomodoro-runtime.js";

describe("createPomodoroRuntime", () => {
  let now;
  let timers;
  let timerId;
  let runtime;
  let callbacks;

  beforeEach(() => {
    now = 1000;
    timers = new Map();
    timerId = 1;
    callbacks = {
      onTick: vi.fn(),
      onComplete: vi.fn(),
      logger: { debug: vi.fn(), warn: vi.fn() }
    };
    runtime = createPomodoroRuntime({
      now: () => now,
      setTimeout: (callback, delayMs) => {
        const id = timerId++;
        timers.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
      ...callbacks
    });
  });

  function runNextTimer() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.callback();
    return timer;
  }

  it("starts a countdown and reports remaining time", () => {
    runtime.start({ durationMs: 1500000, label: "Focus" });

    expect(callbacks.onTick).toHaveBeenCalledWith(expect.objectContaining({
      status: "running",
      label: "Focus",
      durationMs: 1500000,
      remainingMs: 1500000
    }));
    expect(timers.size).toBe(1);
  });

  it("completes after the duration and emits completion metadata", () => {
    runtime.start({ durationMs: 2000, label: "Focus" });

    now = 3000;
    runNextTimer();

    expect(callbacks.onComplete).toHaveBeenCalledWith({
      label: "Focus",
      durationMs: 2000,
      elapsedMs: 2000
    });
    expect(callbacks.onTick).toHaveBeenLastCalledWith(expect.objectContaining({ status: "idle", remainingMs: 0 }));
    expect(runtime.getState().status).toBe("idle");
  });

  it("replaces an active countdown when start is called again", () => {
    runtime.start({ durationMs: 5000, label: "First" });
    const firstTimerId = [...timers.keys()][0];

    runtime.start({ durationMs: 1000, label: "Second" });

    expect(timers.has(firstTimerId)).toBe(false);
    expect(timers.size).toBe(1);
    expect(runtime.getState()).toEqual(expect.objectContaining({
      status: "running",
      label: "Second",
      durationMs: 1000
    }));
  });

  it("cancels an active countdown without completing it", () => {
    runtime.start({ durationMs: 5000, label: "Focus" });

    runtime.cancel("test");

    expect(timers.size).toBe(0);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onTick).toHaveBeenLastCalledWith(expect.objectContaining({ status: "idle", remainingMs: 0 }));
  });

  it("falls back to 25 minutes for invalid durations", () => {
    runtime.start({ durationMs: -1, label: "Focus" });

    expect(runtime.getState().durationMs).toBe(25 * 60 * 1000);
    expect(callbacks.logger.warn).toHaveBeenCalledWith("pomodoro invalid duration fallback", { durationMs: -1 });
  });
});
