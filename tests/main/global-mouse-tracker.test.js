import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createGlobalMouseTracker } = require("../../src/main/global-mouse-tracker");

function createMockWindow(bounds) {
  return {
    isDestroyed: () => false,
    getBounds: () => bounds,
    webContents: {
      send: vi.fn()
    }
  };
}

function createMockScreen(point) {
  return {
    getCursorScreenPoint: () => point
  };
}

describe("createGlobalMouseTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits even when cursor is far outside any range limit", () => {
    const petWindow = createMockWindow({ x: 100, y: 100, width: 80, height: 80 });
    const tracker = createGlobalMouseTracker({
      getPetWindow: () => petWindow,
      intervalMs: 100,
      screenGetter: () => createMockScreen({ x: 500, y: 500 })
    });

    tracker.start();
    vi.advanceTimersByTime(150);

    expect(petWindow.webContents.send).toHaveBeenCalledTimes(1);
    const payload = petWindow.webContents.send.mock.calls[0][1];
    expect(payload).toMatchObject({ pointerMoved: true, boundsChanged: true });
    expect(payload.isInsidePet).toBe(false);
    expect(payload.distanceToPetBounds).toBe(452.55);
    tracker.stop();
  });

  it("emits global mouse-move payload with angle when cursor is within range", () => {
    const petWindow = createMockWindow({ x: 100, y: 100, width: 80, height: 80 });
    const tracker = createGlobalMouseTracker({
      getPetWindow: () => petWindow,
      rangePx: 120,
      intervalMs: 100,
      screenGetter: () => createMockScreen({ x: 40, y: 140 })
    });

    tracker.start();
    vi.advanceTimersByTime(150);

    expect(petWindow.webContents.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = petWindow.webContents.send.mock.calls[0];
    expect(channel).toBe("pet:global-mouse-move");
    expect(payload.type).toBe("mouseMove");
    expect(payload.eventSource).toBe("globalMouse");
    expect(payload.isInsidePet).toBe(false);
    expect(payload.distanceToPetBounds).toBe(60);
    expect(payload.angleToPetDegrees).toBe(270);
    expect(payload.angleToPetProgress).toBe(0.75);
    tracker.stop();
  });

  it("emits when cursor is inside pet bounds", () => {
    const petWindow = createMockWindow({ x: 100, y: 100, width: 80, height: 80 });
    const tracker = createGlobalMouseTracker({
      getPetWindow: () => petWindow,
      rangePx: 50,
      intervalMs: 100,
      screenGetter: () => createMockScreen({ x: 120, y: 120 })
    });

    tracker.start();
    vi.advanceTimersByTime(150);

    expect(petWindow.webContents.send).toHaveBeenCalledTimes(1);
    const payload = petWindow.webContents.send.mock.calls[0][1];
    expect(payload.isInsidePet).toBe(true);
    expect(payload.distanceToPetBounds).toBe(0);
    tracker.stop();
  });

  it("skips when both cursor and bounds are unchanged", () => {
    const petWindow = createMockWindow({ x: 100, y: 100, width: 80, height: 80 });
    const tracker = createGlobalMouseTracker({
      getPetWindow: () => petWindow,
      rangePx: 200,
      intervalMs: 100,
      screenGetter: () => createMockScreen({ x: 50, y: 140 })
    });

    tracker.start();
    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(150);

    expect(petWindow.webContents.send).toHaveBeenCalledTimes(1);
    tracker.stop();
  });

  it("emits a bounds-only update when the window moves under a stationary cursor", () => {
    const bounds = { x: 100, y: 100, width: 80, height: 80 };
    const petWindow = createMockWindow(bounds);
    const tracker = createGlobalMouseTracker({
      getPetWindow: () => petWindow,
      intervalMs: 100,
      screenGetter: () => createMockScreen({ x: 120, y: 120 })
    });

    tracker.start();
    vi.advanceTimersByTime(150);
    bounds.x = 300;
    vi.advanceTimersByTime(100);

    expect(petWindow.webContents.send).toHaveBeenCalledTimes(2);
    const payload = petWindow.webContents.send.mock.calls[1][1];
    expect(payload).toMatchObject({
      pointerMoved: false,
      boundsChanged: true,
      deltaX: 0,
      deltaY: 0,
      speed: 0,
      direction: "none",
      isInsidePet: false
    });
    tracker.stop();
  });

  it("marks cursor-only updates without claiming the bounds changed", () => {
    const petWindow = createMockWindow({ x: 100, y: 100, width: 80, height: 80 });
    let cursor = { x: 120, y: 120 };
    const tracker = createGlobalMouseTracker({
      getPetWindow: () => petWindow,
      intervalMs: 100,
      screenGetter: () => createMockScreen(cursor)
    });

    tracker.start();
    vi.advanceTimersByTime(150);
    cursor = { x: 130, y: 120 };
    vi.advanceTimersByTime(100);

    expect(petWindow.webContents.send.mock.calls[1][1]).toMatchObject({
      pointerMoved: true,
      boundsChanged: false
    });
    tracker.stop();
  });

  it("resets emitted snapshots after stop and restart", () => {
    const petWindow = createMockWindow({ x: 100, y: 100, width: 80, height: 80 });
    const tracker = createGlobalMouseTracker({
      getPetWindow: () => petWindow,
      intervalMs: 100,
      screenGetter: () => createMockScreen({ x: 120, y: 120 })
    });

    tracker.start();
    vi.advanceTimersByTime(150);
    tracker.stop();
    tracker.start();
    vi.advanceTimersByTime(150);

    expect(petWindow.webContents.send).toHaveBeenCalledTimes(2);
    expect(petWindow.webContents.send.mock.calls[1][1]).toMatchObject({
      pointerMoved: true,
      boundsChanged: true
    });
    tracker.stop();
  });

  it("emits a fresh baseline when the target window is replaced", () => {
    const firstWindow = createMockWindow({ x: 100, y: 100, width: 80, height: 80 });
    const secondWindow = createMockWindow({ x: 100, y: 100, width: 80, height: 80 });
    let currentWindow = firstWindow;
    const tracker = createGlobalMouseTracker({
      getPetWindow: () => currentWindow,
      intervalMs: 100,
      screenGetter: () => createMockScreen({ x: 120, y: 120 })
    });

    tracker.start();
    vi.advanceTimersByTime(150);
    currentWindow = secondWindow;
    vi.advanceTimersByTime(100);

    expect(firstWindow.webContents.send).toHaveBeenCalledTimes(1);
    expect(secondWindow.webContents.send).toHaveBeenCalledTimes(1);
    expect(secondWindow.webContents.send.mock.calls[0][1]).toMatchObject({
      pointerMoved: true,
      boundsChanged: true
    });
    tracker.stop();
  });

  it("computes speed and movement direction toward pet", () => {
    const petWindow = createMockWindow({ x: 100, y: 100, width: 80, height: 80 });
    let cursor = { x: 40, y: 140 };
    const tracker = createGlobalMouseTracker({
      getPetWindow: () => petWindow,
      intervalMs: 100,
      screenGetter: () => createMockScreen(cursor)
    });

    tracker.start();
    vi.advanceTimersByTime(150);

    cursor = { x: 80, y: 140 };
    vi.advanceTimersByTime(100);

    expect(petWindow.webContents.send).toHaveBeenCalledTimes(2);
    const payload = petWindow.webContents.send.mock.calls[1][1];
    expect(payload.deltaX).toBe(40);
    expect(payload.deltaY).toBe(0);
    expect(payload.speed).toBe(400);
    expect(payload.direction).toBe("right");
    expect(payload.isMovingTowardPet).toBe(true);
    expect(payload.isMovingAwayFromPet).toBe(false);
    tracker.stop();
  });
});
