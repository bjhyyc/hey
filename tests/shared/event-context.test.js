import { describe, expect, it } from "vitest";
import eventContext from "../../src/shared/event-context";

const { createMouseMoveContext, createMouseStillContext } = eventContext;

describe("createMouseMoveContext", () => {
  const petPosition = { x: 100, y: 100, width: 80, height: 60 };

  it("computes inside, distance, speed, direction, and moving toward", () => {
    const context = createMouseMoveContext({
      timestamp: 2000,
      previous: {
        timestamp: 1000,
        mousePosition: { x: 80, y: 130 }
      },
      mousePosition: { x: 120, y: 130 },
      petPosition
    });

    expect(context).toMatchObject({
      type: "mouseMove",
      timestamp: 2000,
      eventSource: "globalMouse",
      petPosition,
      mousePosition: { x: 120, y: 130 },
      mouseLocalPosition: { x: 20, y: 30 },
      isInsidePet: true,
      distanceToPetBounds: 0,
      deltaX: 40,
      deltaY: 0,
      speed: 40,
      direction: "right",
      isMovingTowardPet: true,
      isMovingAwayFromPet: false
    });
    expect(context.distanceToPetCenter).toBe(20);
    expect(context.angleToPetDegrees).toBe(270);
    expect(context.angleToPetProgress).toBe(0.75);
  });

  it("handles outside-pet distanceToPetBounds reasonably", () => {
    const context = createMouseMoveContext({
      timestamp: 1000,
      previous: null,
      mousePosition: { x: 70, y: 80 },
      petPosition
    });

    expect(context.isInsidePet).toBe(false);
    expect(context.distanceToPetBounds).toBe(36.06);
    expect(context.distanceToPetCenter).toBe(86.02);
  });

  it("handles missing previous without NaN", () => {
    const context = createMouseMoveContext({
      timestamp: 1000,
      mousePosition: { x: 190, y: 130 },
      petPosition
    });

    expect(context.deltaX).toBe(0);
    expect(context.deltaY).toBe(0);
    expect(context.speed).toBe(0);
    expect(context.direction).toBe("none");
    expect(context.isMovingTowardPet).toBe(false);
    expect(context.isMovingAwayFromPet).toBe(false);
    expect(Number.isNaN(context.distanceToPetCenter)).toBe(false);
    expect(Number.isNaN(context.distanceToPetBounds)).toBe(false);
    expect(Number.isNaN(context.speed)).toBe(false);
  });

  it("snapshots nested position objects", () => {
    const mutablePetPosition = { x: 100, y: 100, width: 80, height: 60 };
    const mutableMousePosition = { x: 120, y: 130 };

    const context = createMouseMoveContext({
      timestamp: 1000,
      mousePosition: mutableMousePosition,
      petPosition: mutablePetPosition
    });

    mutablePetPosition.x = 999;
    mutablePetPosition.width = 1;
    mutableMousePosition.x = 888;

    expect(context.petPosition).toEqual({ x: 100, y: 100, width: 80, height: 60 });
    expect(context.mousePosition).toEqual({ x: 120, y: 130 });
  });
});

describe("createMouseStillContext", () => {
  it("copies the last mouse context and records still duration", () => {
    const previous = {
      type: "mouseMove",
      timestamp: 1000,
      eventSource: "globalMouse",
      petPosition: { x: 100, y: 100, width: 80, height: 60 },
      mousePosition: { x: 120, y: 130 },
      screenPosition: { x: 120, y: 130 },
      distanceToPetCenter: 20
    };

    const context = createMouseStillContext({
      timestamp: 2500,
      previous,
      durationMs: 1500
    });

    expect(context).toMatchObject({
      type: "mouseStill",
      timestamp: 2500,
      eventSource: "globalMouse",
      petPosition: { x: 100, y: 100, width: 80, height: 60 },
      mousePosition: { x: 120, y: 130 },
      screenPosition: { x: 120, y: 130 },
      distanceToPetCenter: 20,
      durationMs: 1500
    });
  });
});
