import { describe, expect, it } from "vitest";
import { shouldSuppressRuntimeEventDuringDrag } from "../../src/renderer/pet/event-suppression.js";

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
