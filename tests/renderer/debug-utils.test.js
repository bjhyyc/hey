import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDebugLogger,
  debugRulesEnabled,
  setDebugRulesEnabled
} from "../../src/renderer/pet/debug-utils";

describe("pet debug utils", () => {
  afterEach(() => {
    delete globalThis.desktopPet;
    setDebugRulesEnabled(false, "info");
    vi.useRealTimers();
  });

  it("only enables rule debug logging for debug and trace levels", () => {
    setDebugRulesEnabled(true, "info");
    expect(debugRulesEnabled()).toBe(false);

    setDebugRulesEnabled(true, "debug");
    expect(debugRulesEnabled()).toBe(true);

    setDebugRulesEnabled(true, "trace");
    expect(debugRulesEnabled()).toBe(true);

    setDebugRulesEnabled(false, "debug");
    expect(debugRulesEnabled()).toBe(false);
  });

  it("throttles selected high-frequency debug messages", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    globalThis.desktopPet = { logs: { write } };
    setDebugRulesEnabled(true, "debug");

    const log = createDebugLogger("[desktop-pet:test]", {
      throttleMsByMessage: { "global-mouse": 500 },
      now: () => Date.now()
    });

    log("global-mouse", { x: 1 });
    vi.advanceTimersByTime(100);
    log("global-mouse", { x: 2 });
    vi.advanceTimersByTime(400);
    log("global-mouse", { x: 3 });
    log("state-change", { active: true });

    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls[0][3]).toEqual(["global-mouse", "{\"x\":1}"]);
    expect(write.mock.calls[1][3]).toEqual(["global-mouse", "{\"x\":3}"]);
    expect(write.mock.calls[2][3]).toEqual(["state-change", "{\"active\":true}"]);
  });
});
