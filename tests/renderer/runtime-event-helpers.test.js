import { describe, expect, it, vi } from "vitest";
import {
  createOneShotEventLatch,
  getRuntimeUpdateLifecycleEvents,
  playDefaultThenDispatchLifecycleEvents,
  shouldReturnToDefaultForRuntimeUpdate
} from "../../src/renderer/pet/runtime-event-helpers.js";

describe("runtime event helpers", () => {
  it("plays the default animation before dispatching the single startup event", () => {
    const calls = [];
    const now = vi.fn().mockReturnValue(1000);

    playDefaultThenDispatchLifecycleEvents({
      playDefault: (reason) => calls.push(["default", reason]),
      evaluateEvent: (event) => calls.push(["event", event]),
      defaultReason: "initialLoad",
      eventTypes: ["appLaunch"],
      now
    });

    expect(calls).toEqual([
      ["default", "initialLoad"],
      ["event", { type: "appLaunch", timestamp: 1000, eventSource: "petRenderer" }]
    ]);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("dispatches packageLoaded separately after a runtime switch", () => {
    const calls = [];

    playDefaultThenDispatchLifecycleEvents({
      playDefault: (reason) => calls.push(["default", reason]),
      evaluateEvent: (event) => calls.push(["event", event.type]),
      defaultReason: "runtimeUpdated",
      eventTypes: ["packageLoaded"],
      now: () => 1001
    });

    expect(calls).toEqual([
      ["default", "runtimeUpdated"],
      ["event", "packageLoaded"]
    ]);
  });

  it("dispatches packageLoaded only for an actual package change", () => {
    expect(getRuntimeUpdateLifecycleEvents("packageChanged")).toEqual(["packageLoaded"]);
    expect(getRuntimeUpdateLifecycleEvents("configChanged")).toEqual([]);
    expect(getRuntimeUpdateLifecycleEvents("assetsChanged")).toEqual([]);
    expect(getRuntimeUpdateLifecycleEvents()).toEqual([]);
  });

  it("returns to default only when the package or its media changed", () => {
    expect(shouldReturnToDefaultForRuntimeUpdate("packageChanged")).toBe(true);
    expect(shouldReturnToDefaultForRuntimeUpdate("assetsChanged")).toBe(true);
    expect(shouldReturnToDefaultForRuntimeUpdate("configChanged")).toBe(false);
    expect(shouldReturnToDefaultForRuntimeUpdate()).toBe(false);
  });

  it("latches only after a duration event actually fires", () => {
    const latch = createOneShotEventLatch();
    const evaluate = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    expect(latch.run(evaluate)).toBe(false);
    expect(latch.isLatched()).toBe(false);
    expect(latch.run(evaluate)).toBe(true);
    expect(latch.isLatched()).toBe(true);
    expect(latch.run(evaluate)).toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("allows one new duration event after its session is reset", () => {
    const latch = createOneShotEventLatch();
    const evaluate = vi.fn(() => true);

    expect(latch.run(evaluate)).toBe(true);
    expect(latch.reset()).toBe(true);
    expect(latch.run(evaluate)).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
