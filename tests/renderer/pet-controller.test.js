import { describe, expect, it, vi } from "vitest";
import {
  createBoundsScheduler,
  createPetController,
  resolveDragVisualOffset,
  stopPetEvent
} from "../../src/renderer/pet/pet-controller";

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createController(overrides = {}) {
  const calls = {
    returnToDefault: [],
    messages: [],
    scheduledIdle: 0,
    clearedIdle: 0,
    movedBounds: [],
    dragging: [],
    captured: [],
    released: []
  };

  const controller = createPetController({
    returnToDefault: () => calls.returnToDefault.push("idle"),
    showMessage: (text) => calls.messages.push(text),
    scheduleIdle: () => {
      calls.scheduledIdle += 1;
    },
    clearIdle: () => {
      calls.clearedIdle += 1;
    },
    movePetWindow: (bounds) => calls.movedBounds.push(bounds),
    getWindowPosition: () => ({ x: 10, y: 20 }),
    getWindowSize: () => ({ width: 320, height: 320 }),
    setDraggingClass: (enabled) => calls.dragging.push(enabled),
    setPointerCapture: (pointerId) => calls.captured.push(pointerId),
    releasePointerCapture: (pointerId) => calls.released.push(pointerId),
    hasPointerCapture: () => true,
    ...overrides
  });

  return { controller, calls };
}

describe("createBoundsScheduler", () => {
  it("coalesces moves to the latest bounds and avoids concurrent setBounds calls", async () => {
    const frames = [];
    const firstMove = createDeferred();
    const setBounds = vi.fn(() => firstMove.promise);
    const scheduler = createBoundsScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      setBounds
    });

    scheduler.request({ x: 1, y: 1, width: 320, height: 320 });
    scheduler.request({ x: 2, y: 2, width: 320, height: 320 });
    frames.shift()();

    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(setBounds).toHaveBeenLastCalledWith({ x: 2, y: 2, width: 320, height: 320 });

    scheduler.request({ x: 3, y: 3, width: 320, height: 320 });
    scheduler.request({ x: 4, y: 4, width: 320, height: 320 });

    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);

    firstMove.resolve();
    await firstMove.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(frames).toHaveLength(1);
    frames.shift()();
    expect(setBounds).toHaveBeenCalledTimes(2);
    expect(setBounds).toHaveBeenLastCalledWith({ x: 4, y: 4, width: 320, height: 320 });
  });

  it("logs native bounds update timing and pending coalesced movement", async () => {
    const frames = [];
    const firstMove = createDeferred();
    const setBounds = vi.fn(() => firstMove.promise);
    let clock = 100;
    const logger = {
      debug: vi.fn(),
      warn: vi.fn()
    };
    const scheduler = createBoundsScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      setBounds,
      now: () => clock,
      logger,
      slowSetBoundsMs: 20
    });

    scheduler.request({ x: 10, y: 20, width: 320, height: 320 });
    frames.shift()();
    scheduler.request({ x: 30, y: 40, width: 320, height: 320 });

    clock = 135;
    firstMove.resolve();
    await firstMove.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.warn).toHaveBeenCalledWith("pet window setBounds completed slowly", {
      durationMs: 35,
      bounds: { x: 10, y: 20, width: 320, height: 320 },
      hasPendingBounds: true
    });
    expect(logger.debug).not.toHaveBeenCalledWith("pet window setBounds completed", expect.anything());
  });
});

describe("resolveDragVisualOffset", () => {
  it("keeps top overflow as a visual offset when the native window is clamped", () => {
    expect(resolveDragVisualOffset({
      requestedBounds: { x: 10, y: -120, width: 320, height: 320 },
      actualPosition: { x: 10, y: 24 },
      topBoundary: 24
    })).toEqual({ x: 0, y: -144 });
  });

  it("does not offset content while the requested top is inside the actual window top", () => {
    expect(resolveDragVisualOffset({
      requestedBounds: { x: 10, y: 80, width: 320, height: 320 },
      actualPosition: { x: 10, y: 24 },
      topBoundary: 24
    })).toEqual({ x: 0, y: 0 });
  });

  it("does not offset ordinary upward motion above the previous async window position", () => {
    expect(resolveDragVisualOffset({
      requestedBounds: { x: 10, y: 90, width: 320, height: 320 },
      actualPosition: { x: 10, y: 100 },
      topBoundary: 24
    })).toEqual({ x: 0, y: 0 });
  });
});

describe("createPetController", () => {
 it("does not drag or suppress click below the movement threshold", () => {
   const onClick = vi.fn(() => false);
   const { controller, calls } = createController({ onClick });

   controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
   controller.continueDrag({ pointerId: 7, screenX: 102, screenY: 101 });
   controller.endDrag({ pointerId: 7 });
   controller.click();

   expect(calls.movedBounds).toEqual([]);
   // 点击交互完全交给规则；无硬编码问候/回默认。
   expect(onClick).toHaveBeenCalledTimes(1);
   expect(calls.returnToDefault).toEqual([]);
   expect(calls.messages).toEqual([]);
   expect(calls.scheduledIdle).toBe(0);
 });

 it("does not fire onDragStart when pointer is pressed without moving", () => {
   const dragStart = vi.fn(() => false);
   const dragging = vi.fn(() => false);
   const dragEnd = vi.fn(() => false);
   const { controller, calls } = createController({
     onDragStart: dragStart,
     onDragging: dragging,
     onDragEnd: dragEnd
   });

   controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });

   expect(dragStart).not.toHaveBeenCalled();
   expect(dragging).not.toHaveBeenCalled();
   expect(calls.returnToDefault).toEqual([]);

   controller.endDrag({ pointerId: 7 });
   expect(dragEnd).not.toHaveBeenCalled();
 });

 it("fires onDragStart only once when threshold is crossed", () => {
   const dragStart = vi.fn(() => false);
   const dragging = vi.fn(() => false);
   const { controller } = createController({
     onDragStart: dragStart,
     onDragging: dragging
   });

   controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
   controller.continueDrag({ pointerId: 7, screenX: 130, screenY: 100 });
   controller.continueDrag({ pointerId: 7, screenX: 140, screenY: 100 });

   expect(dragStart).toHaveBeenCalledTimes(1);
   expect(dragging).toHaveBeenCalledTimes(2);
 });

 it("suppresses the accidental click after a drag", () => {
    const { controller, calls } = createController();

    controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    controller.continueDrag({ pointerId: 7, screenX: 130, screenY: 100 });
    controller.endDrag({ pointerId: 7 });
    controller.click();

    // 拖拽结束不再强制回默认（交给动画系统内部/dragEnd 规则）。
    expect(calls.returnToDefault).toEqual([]);
    expect(calls.messages).toEqual([]);
    expect(calls.scheduledIdle).toBe(0);
  });

  it("only notifies drag cancel on lost pointer capture after an actual drag", () => {
    const noDrag = createController({ onDragCancel: vi.fn() });

    noDrag.controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    noDrag.controller.lostPointerCapture();

    // 未真正拖动：不回默认、不通知取消。
    expect(noDrag.calls.returnToDefault).toEqual([]);
    expect(noDrag.calls.dragging).toEqual([true, false]);

    const onDragCancel = vi.fn();
    const dragged = createController({ onDragCancel });

    dragged.controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    dragged.controller.continueDrag({ pointerId: 7, screenX: 130, screenY: 100 });
    dragged.controller.lostPointerCapture();

    // 真正拖动后取消：通知 onDragCancel，但不再强制回默认（交给动画系统/规则）。
    expect(dragged.calls.returnToDefault).toEqual([]);
    expect(onDragCancel).toHaveBeenCalledTimes(1);
    expect(dragged.calls.dragging).toEqual([true, false]);
  });

  it("notifies runtime cleanup when pointer capture is lost during an actual drag", () => {
    const onDragCancel = vi.fn();
    const { controller } = createController({ onDragCancel });

    controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    controller.continueDrag({ pointerId: 7, screenX: 130, screenY: 125 });
    controller.lostPointerCapture();

    expect(onDragCancel).toHaveBeenCalledTimes(1);
    expect(onDragCancel).toHaveBeenCalledWith({
      pointerId: 7,
      screenX: 130,
      screenY: 125
    });
  });

  it("does not notify runtime cleanup when pointer capture is lost before dragging starts", () => {
    const onDragCancel = vi.fn();
    const { controller } = createController({ onDragCancel });

    controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    controller.lostPointerCapture();

    expect(onDragCancel).not.toHaveBeenCalled();
  });
});

describe("stopPetEvent", () => {
  it("stops propagation for settings button events", () => {
    const event = {
      stopPropagation: vi.fn()
    };

    stopPetEvent(event);

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});
