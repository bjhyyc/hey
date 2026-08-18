import { describe, expect, it } from "vitest";
import {
  shouldSuppressRuntimeEventDuringDrag,
  shouldSuppressRuntimeEventWhileAsleep
} from "../../src/renderer/pet/event-suppression.js";

describe("runtime event suppression", () => {
  it("suppresses competing runtime events while dragging", () => {
    expect(shouldSuppressRuntimeEventDuringDrag({
      dragStartedAt: 1000,
      event: { type: "randomTimer", eventSource: "timer" }
    })).toBe(true);

    expect(shouldSuppressRuntimeEventDuringDrag({
      dragStartedAt: 1000,
      event: { type: "click", eventSource: "petRenderer" }
    })).toBe(true);
  });

  it("allows drag and lifecycle events while dragging", () => {
    expect(shouldSuppressRuntimeEventDuringDrag({
      dragStartedAt: 1000,
      event: { type: "dragging", eventSource: "petRenderer" }
    })).toBe(false);

    expect(shouldSuppressRuntimeEventDuringDrag({
      dragStartedAt: 1000,
      event: { type: "dragEnd", eventSource: "petRenderer" }
    })).toBe(false);

    expect(shouldSuppressRuntimeEventDuringDrag({
      dragStartedAt: 1000,
      event: { type: "packageLoaded", eventSource: "petRenderer" }
    })).toBe(false);
  });

  it("does not suppress events when dragging is inactive", () => {
    expect(shouldSuppressRuntimeEventDuringDrag({
      dragStartedAt: 0,
      event: { type: "randomTimer", eventSource: "timer" }
    })).toBe(false);
  });
});

// The customer's rule for the sleep loop: only a right click wakes the pet;
// every other interaction is ignored until then. Lifecycle events still pass
// so a package reload never waits for a sleeping pet.
describe("shouldSuppressRuntimeEventWhileAsleep", () => {
  it("suppresses every ordinary interaction while a sleep clip holds", () => {
    for (const type of ["click", "doubleClick", "hoverDuration", "mouseEnter", "mouseLeave", "mouseMove", "idleDuration", "dragStart"]) {
      expect(shouldSuppressRuntimeEventWhileAsleep({
        sleepActive: true,
        event: { type }
      })).toBe(true);
    }
  });

  it("lets the right-click wake through", () => {
    expect(shouldSuppressRuntimeEventWhileAsleep({
      sleepActive: true,
      event: { type: "rightClick" }
    })).toBe(false);
  });

  it("lets lifecycle events through so reloads are never blocked", () => {
    for (const type of ["appLaunch", "packageLoaded"]) {
      expect(shouldSuppressRuntimeEventWhileAsleep({
        sleepActive: true,
        event: { type }
      })).toBe(false);
    }
  });

  it("suppresses nothing while the pet is awake", () => {
    for (const type of ["click", "doubleClick", "hoverDuration", "rightClick"]) {
      expect(shouldSuppressRuntimeEventWhileAsleep({
        sleepActive: false,
        event: { type }
      })).toBe(false);
    }
  });

  it("ignores malformed events", () => {
    expect(shouldSuppressRuntimeEventWhileAsleep({ sleepActive: true, event: null })).toBe(false);
    expect(shouldSuppressRuntimeEventWhileAsleep({ sleepActive: true, event: {} })).toBe(false);
    expect(shouldSuppressRuntimeEventWhileAsleep()).toBe(false);
  });
});
