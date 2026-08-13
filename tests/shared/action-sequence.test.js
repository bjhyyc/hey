import { describe, expect, it, vi } from "vitest";
import {
  getActionSequenceDurationMs,
  getActionWaitMs,
  scheduleActionSequence
} from "../../src/shared/action-sequence";

describe("action sequence scheduling", () => {
  it("does not wait for ordinary action duration before running the next action", () => {
    const runAction = vi.fn();
    const scheduleTimeout = vi.fn();

    scheduleActionSequence([
      { type: "playAnimation", durationMs: 900 },
      { type: "showMessage", text: "hi", durationMs: 1800 }
    ], {
      runAction,
      setTimeout: scheduleTimeout
    });

    expect(runAction).toHaveBeenCalledTimes(2);
    expect(runAction).toHaveBeenNthCalledWith(1, { type: "playAnimation", durationMs: 900 }, 0);
    expect(runAction).toHaveBeenNthCalledWith(2, { type: "showMessage", text: "hi", durationMs: 1800 }, 1);
    expect(scheduleTimeout).not.toHaveBeenCalled();
  });

  it("uses delay actions as explicit waits before later actions", () => {
    const runAction = vi.fn();
    const callbacks = [];
    const scheduleTimeout = vi.fn((callback, delayMs) => {
      callbacks.push({ callback, delayMs });
      return `timer-${callbacks.length}`;
    });
    const afterRun = vi.fn();
    const onScheduled = vi.fn();

    scheduleActionSequence([
      { type: "delay", durationMs: 1200 },
      { type: "showMessage", text: "hi", durationMs: 1800 }
    ], {
      runAction,
      setTimeout: scheduleTimeout,
      afterRun,
      onScheduled
    });

    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenNthCalledWith(1, { type: "delay", durationMs: 1200 }, 0);
    expect(scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 1200);
    expect(onScheduled).toHaveBeenCalledWith({
      timerId: "timer-1",
      action: { type: "showMessage", text: "hi", durationMs: 1800 },
      index: 1,
      delayMs: 1200
    });

    callbacks[0].callback();

    expect(runAction).toHaveBeenCalledTimes(2);
    expect(runAction).toHaveBeenNthCalledWith(2, { type: "showMessage", text: "hi", durationMs: 1800 }, 1);
    expect(afterRun).toHaveBeenCalledWith({
      timerId: "timer-1",
      action: { type: "showMessage", text: "hi", durationMs: 1800 },
      index: 1,
      delayMs: 1200
    });
  });

  it("keeps blank actions as no-op probability placeholders, not waits", () => {
    const runAction = vi.fn();
    const scheduleTimeout = vi.fn();

    scheduleActionSequence([
      { type: "blank", durationMs: 1200 },
      { type: "showMessage", text: "hi", durationMs: 1800 }
    ], {
      runAction,
      setTimeout: scheduleTimeout
    });

    expect(runAction).toHaveBeenCalledTimes(2);
    expect(runAction).toHaveBeenNthCalledWith(1, { type: "blank", durationMs: 1200 }, 0);
    expect(runAction).toHaveBeenNthCalledWith(2, { type: "showMessage", text: "hi", durationMs: 1800 }, 1);
    expect(scheduleTimeout).not.toHaveBeenCalled();
  });

  it("keeps action duration available for runtime suppression windows", () => {
    expect(getActionWaitMs({ type: "playAnimation", durationMs: 900 })).toBe(0);
    expect(getActionWaitMs({ type: "blank", durationMs: 1200 })).toBe(0);
    expect(getActionWaitMs({ type: "delay", durationMs: 1200 })).toBe(1200);
    expect(getActionSequenceDurationMs([
      { type: "playAnimation", durationMs: 900 },
      { type: "showMessage", durationMs: 1800 }
    ])).toBe(2700);
  });
});
