import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { throttle } from "../../src/shared/throttle.js";

describe("throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call function immediately on first invocation", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled("arg1");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("arg1");
  });

  it("should throttle subsequent calls within delay period", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled("call1");
    throttled("call2");
    throttled("call3");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("call1");
  });

  it("should call with latest args after delay period", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled("call1");
    throttled("call2");
    throttled("call3");

    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("call3");
  });

  it("should allow calls after delay period has passed", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled("call1");
    vi.advanceTimersByTime(100);
    throttled("call2");
    vi.advanceTimersByTime(100);
    throttled("call3");

    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenNthCalledWith(1, "call1");
    expect(fn).toHaveBeenNthCalledWith(2, "call2");
    expect(fn).toHaveBeenNthCalledWith(3, "call3");
  });

  it("should preserve function context", () => {
    const obj = {
      value: 42,
      fn: vi.fn(function () {
        return this.value;
      })
    };

    obj.throttled = throttle(obj.fn, 100);
    obj.throttled();

    expect(obj.fn).toHaveBeenCalled();
  });

  it("should handle multiple arguments", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled(1, 2, 3);

    expect(fn).toHaveBeenCalledWith(1, 2, 3);
  });

  it("should schedule trailing call if invoked during throttle period", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled("first");
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    throttled("second");
    throttled("third");

    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("third");
  });

  it("should not schedule multiple trailing calls", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled("first");
    throttled("second");
    throttled("third");

    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
