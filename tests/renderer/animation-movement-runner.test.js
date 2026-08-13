import { describe, expect, it, vi } from "vitest";
import { applyMovementEasing, createAnimationMovementRunner } from "../../src/renderer/pet/animation-movement-runner.js";

function createRunner(overrides = {}) {
  const scheduledBounds = [];
  let frameCallback = null;
  const requestAnimationFrame = vi.fn((callback) => {
    frameCallback = callback;
    return 7;
  });
  const cancelAnimationFrame = vi.fn();
  const timeoutIds = [];
  let timeoutCallback = null;
  const setTimeout = vi.fn((callback, delayMs) => {
    timeoutCallback = callback;
    timeoutIds.push({ id: timeoutIds.length + 1, delayMs });
    return timeoutIds[timeoutIds.length - 1].id;
  });
  const clearTimeout = vi.fn();
  const runner = createAnimationMovementRunner({
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout,
    clearTimeout,
    now: () => 1000,
    getPosition: () => ({ x: 10, y: 20 }),
    getSize: () => ({ width: 100, height: 100 }),
    refreshWorkArea: async () => ({ x: 0, y: 0, width: 800, height: 600 }),
    clearDragVisualOffset: vi.fn(),
    resolveMoveDirection: () => ({ x: 1, y: 0 }),
    resolveMoveSpeed: () => 100,
    wrapBoundsToScreen: (bounds) => bounds,
    boundsScheduler: {
      request: (bounds) => scheduledBounds.push(bounds)
    },
    logger: { debug: vi.fn() },
    pushRuntimeState: vi.fn(),
    ...overrides
  });

  return {
    runner,
    scheduledBounds,
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout,
    clearTimeout,
    get frameCallback() {
      return frameCallback;
    },
    get timeoutCallback() {
      return timeoutCallback;
    }
  };
}

describe("animation movement runner", () => {
  it("does not start delayed movement after cancellation", async () => {
    const harness = createRunner();

    await harness.runner.start({
      id: "walk",
      durationMs: 1000,
      movement: {
        direction: "right",
        speed: 100,
        easing: { startDelayMs: 500 }
      }
    });
    harness.runner.cancel();

    harness.timeoutCallback();

    expect(harness.clearTimeout).toHaveBeenCalledWith(1);
    expect(harness.requestAnimationFrame).not.toHaveBeenCalled();
    expect(harness.scheduledBounds).toEqual([]);
  });

  it("uses nested start delay when scheduling movement", async () => {
    const harness = createRunner();

    await harness.runner.start({
      id: "walk",
      durationMs: 1000,
      movement: {
        direction: "right",
        speed: 100,
        easing: { startDelayMs: 250 }
      }
    });

    expect(harness.setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
  });

  it("uses end delay to finish movement before the clip ends", async () => {
    const harness = createRunner();

    await harness.runner.start({
      id: "walk",
      durationMs: 1000,
      movement: {
        direction: "right",
        speed: 100,
        easing: { endDelayMs: 300 }
      }
    });

    harness.frameCallback(1700);

    expect(harness.scheduledBounds[harness.scheduledBounds.length - 1]).toEqual({
      x: 80,
      y: 20,
      width: 100,
      height: 100
    });
  });

  it("applies preset strength and phase durations", () => {
    const gentle = applyMovementEasing(0.15, {
      preset: "easeInOut",
      strength: 0.5,
      easeInMs: 300,
      easeOutMs: 300
    }, 1000);
    const strong = applyMovementEasing(0.15, {
      preset: "easeInOut",
      strength: 2,
      easeInMs: 300,
      easeOutMs: 300
    }, 1000);

    expect(strong).toBeLessThan(gentle);
    expect(applyMovementEasing(0.5, { preset: "linear", strength: 3 }, 1000)).toBe(0.5);
  });

  it("cancels an active movement frame", async () => {
    const harness = createRunner();

    await harness.runner.start({
      id: "walk",
      durationMs: 1000,
      movement: { direction: "right", speed: 100 }
    });
    harness.runner.cancel();

    expect(harness.cancelAnimationFrame).toHaveBeenCalledWith(7);
  });

  it("cancels the previous movement when a new movement clip cannot run", async () => {
    const harness = createRunner();

    await harness.runner.start({
      id: "walk",
      durationMs: 1000,
      movement: { direction: "right", speed: 100 }
    });

    await harness.runner.start({
      id: "broken",
      movement: { direction: "right", speed: 100 }
    });

    expect(harness.cancelAnimationFrame).toHaveBeenCalledWith(7);
  });
});
