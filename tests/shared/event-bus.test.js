import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "../../src/shared/event-bus.js";

describe("EventBus", () => {
  let eventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe("subscribe", () => {
    it("should subscribe to an event type", () => {
      const callback = () => {};
      const id = eventBus.subscribe("click", callback);

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
    });

    it("should return unique IDs for each subscription", () => {
      const id1 = eventBus.subscribe("click", () => {});
      const id2 = eventBus.subscribe("click", () => {});

      expect(id1).not.toBe(id2);
    });

    it("should accept custom listener ID", () => {
      const customId = "my-custom-id";
      const id = eventBus.subscribe("click", () => {}, { id: customId });

      expect(id).toBe(customId);
    });

    it("should throw error if eventType is not a string", () => {
      expect(() => eventBus.subscribe(123, () => {})).toThrow();
      expect(() => eventBus.subscribe(null, () => {})).toThrow();
      expect(() => eventBus.subscribe("", () => {})).toThrow();
    });

    it("should throw error if callback is not a function", () => {
      expect(() => eventBus.subscribe("click", "not a function")).toThrow();
      expect(() => eventBus.subscribe("click", null)).toThrow();
    });

    it("should store priority option", () => {
      const id = eventBus.subscribe("click", () => {}, { priority: 75 });
      const listeners = eventBus.getListeners("click");

      expect(listeners[0].priority).toBe(75);
    });

    it("should default priority to 0", () => {
      const id = eventBus.subscribe("click", () => {});
      const listeners = eventBus.getListeners("click");

      expect(listeners[0].priority).toBe(0);
    });

    it("should store system flag", () => {
      const id = eventBus.subscribe("click", () => {}, { system: true });
      const listeners = eventBus.getListeners("click");

      expect(listeners[0].system).toBe(true);
    });
  });

  describe("unsubscribe", () => {
    it("should remove a listener by ID", () => {
      const id = eventBus.subscribe("click", () => {});
      const result = eventBus.unsubscribe(id);

      expect(result).toBe(true);
      expect(eventBus.getListeners("click").length).toBe(0);
    });

    it("should return false if listener ID not found", () => {
      const result = eventBus.unsubscribe("non-existent-id");

      expect(result).toBe(false);
    });

    it("should not affect other listeners", () => {
      const id1 = eventBus.subscribe("click", () => {});
      const id2 = eventBus.subscribe("click", () => {});

      eventBus.unsubscribe(id1);

      expect(eventBus.getListeners("click").length).toBe(1);
      expect(eventBus.getListeners("click")[0].id).toBe(id2);
    });
  });

  describe("unsubscribeAll", () => {
    it("should remove all listeners for an event type", () => {
      eventBus.subscribe("click", () => {});
      eventBus.subscribe("click", () => {});
      eventBus.subscribe("click", () => {});

      const count = eventBus.unsubscribeAll("click");

      expect(count).toBe(3);
      expect(eventBus.getListeners("click").length).toBe(0);
    });

    it("should return 0 if event type has no listeners", () => {
      const count = eventBus.unsubscribeAll("nonexistent");

      expect(count).toBe(0);
    });

    it("should not affect other event types", () => {
      eventBus.subscribe("click", () => {});
      eventBus.subscribe("drag", () => {});

      eventBus.unsubscribeAll("click");

      expect(eventBus.getListeners("click").length).toBe(0);
      expect(eventBus.getListeners("drag").length).toBe(1);
    });
  });

  describe("emit", () => {
    it("should call subscribed listeners", () => {
      let called = false;
      eventBus.subscribe("click", () => {
        called = true;
      });

      eventBus.emit("click", {});

      expect(called).toBe(true);
    });

    it("should pass event context to listeners", () => {
      let receivedContext = null;
      eventBus.subscribe("click", (context) => {
        receivedContext = context;
      });

      eventBus.emit("click", { x: 10, y: 20 });

      expect(receivedContext.x).toBe(10);
      expect(receivedContext.y).toBe(20);
    });

    it("should enrich event context with type and timestamp", () => {
      let receivedContext = null;
      eventBus.subscribe("click", (context) => {
        receivedContext = context;
      });

      eventBus.emit("click", { x: 10 });

      expect(receivedContext.type).toBe("click");
      expect(receivedContext.timestamp).toBeDefined();
      expect(typeof receivedContext.timestamp).toBe("number");
    });

    it("should preserve custom timestamp", () => {
      let receivedContext = null;
      eventBus.subscribe("click", (context) => {
        receivedContext = context;
      });

      const customTimestamp = 1234567890;
      eventBus.emit("click", { timestamp: customTimestamp });

      expect(receivedContext.timestamp).toBe(customTimestamp);
    });

    it("should return true if listeners were called", () => {
      eventBus.subscribe("click", () => {});
      const result = eventBus.emit("click", {});

      expect(result).toBe(true);
    });

    it("should return false if no listeners", () => {
      const result = eventBus.emit("click", {});

      expect(result).toBe(false);
    });

    it("should execute listeners in priority order", () => {
      const order = [];

      eventBus.subscribe("click", () => order.push("low"), { priority: 10 });
      eventBus.subscribe("click", () => order.push("high"), { priority: 90 });
      eventBus.subscribe("click", () => order.push("medium"), { priority: 50 });

      eventBus.emit("click", {});

      expect(order).toEqual(["high", "medium", "low"]);
    });

    it("should execute system listeners first", () => {
      const order = [];

      eventBus.subscribe("click", () => order.push("user-high"), { priority: 90 });
      eventBus.subscribe("click", () => order.push("system"), { system: true, priority: 50 });
      eventBus.subscribe("click", () => order.push("user-low"), { priority: 10 });

      eventBus.emit("click", {});

      expect(order).toEqual(["system", "user-high", "user-low"]);
    });

    it("should stop propagation when listener returns true", () => {
      const order = [];

      eventBus.subscribe("click", () => {
        order.push("first");
        return true; // Stop propagation
      }, { priority: 90 });
      eventBus.subscribe("click", () => order.push("second"), { priority: 50 });

      eventBus.emit("click", {});

      expect(order).toEqual(["first"]);
    });

    it("should continue propagation when listener returns false", () => {
      const order = [];

      eventBus.subscribe("click", () => {
        order.push("first");
        return false;
      }, { priority: 90 });
      eventBus.subscribe("click", () => order.push("second"), { priority: 50 });

      eventBus.emit("click", {});

      expect(order).toEqual(["first", "second"]);
    });

    it("should continue propagation when listener returns undefined", () => {
      const order = [];

      eventBus.subscribe("click", () => {
        order.push("first");
        // No return (undefined)
      }, { priority: 90 });
      eventBus.subscribe("click", () => order.push("second"), { priority: 50 });

      eventBus.emit("click", {});

      expect(order).toEqual(["first", "second"]);
    });

    it("should handle listener errors gracefully", () => {
      const order = [];

      eventBus.subscribe("click", () => {
        order.push("first");
        throw new Error("Test error");
      }, { priority: 90 });
      eventBus.subscribe("click", () => order.push("second"), { priority: 50 });

      eventBus.emit("click", {});

      // Should still execute second listener despite first one throwing
      expect(order).toEqual(["first", "second"]);
    });

    it("should throw error if eventType is invalid", () => {
      expect(() => eventBus.emit(null, {})).toThrow();
      expect(() => eventBus.emit("", {})).toThrow();
      expect(() => eventBus.emit(123, {})).toThrow();
    });
  });

  describe("event history", () => {
    it("should store emitted events in history", () => {
      eventBus.emit("click", { x: 10 });
      eventBus.emit("drag", { y: 20 });

      expect(eventBus.eventHistory.length).toBe(2);
      expect(eventBus.eventHistory[0].type).toBe("click");
      expect(eventBus.eventHistory[1].type).toBe("drag");
    });

    it("should limit history size to maxHistorySize", () => {
      eventBus.maxHistorySize = 3;

      eventBus.emit("event1", );
      eventBus.emit("event2", {});
      eventBus.emit("event3", {});
      eventBus.emit("event4", {});

      expect(eventBus.eventHistory.length).toBe(3);
      expect(eventBus.eventHistory[0].type).toBe("event2");
      expect(eventBus.eventHistory[2].type).toBe("event4");
    });

    it("should clear history", () => {
      eventBus.emit("click", {});
      eventBus.emit("drag", {});

      eventBus.clearHistory();

      expect(eventBus.eventHistory.length).toBe(0);
    });
  });

  describe("getListeners", () => {
    it("should return listener info", () => {
      eventBus.subscribe("click", () => {}, { id: "test-id", priority: 75, system: true });

      const listeners = eventBus.getListeners("click");

      expect(listeners.length).toBe(1);
      expect(listeners[0].id).toBe("test-id");
      expect(listeners[0].priority).toBe(75);
      expect(listeners[0].system).toBe(true);
    });

    it("should return empty array if no listeners", () => {
      const listeners = eventBus.getListeners("nonexistent");

      expect(listeners).toEqual([]);
    });
  });

  describe("getEventTypes", () => {
    it("should return all registered event types", () => {
      eventBus.subscribe("click", () => {});
      eventBus.subscribe("drag", () => {});
      eventBus.subscribe("click", () => {}); // Duplicate type

      const types = eventBus.getEventTypes();

      expect(types.length).toBe(2);
      expect(types).toContain("click");
      expect(types).toContain("drag");
    });

    it("should return empty array if no subscriptions", () => {
      const types = eventBus.getEventTypes();

      expect(types).toEqual([]);
    });
  });

  describe("integration scenarios", () => {
    it("should handle system event blocking user event", () => {
      const executed = [];

      // User listener
      eventBus.subscribe("click", () => {
        executed.push("user");
      }, { priority: 50 });

      // System listener that blocks
      eventBus.subscribe("click", () => {
        executed.push("system");
        return true; // Block
      }, { system: true, priority: 50 });

      eventBus.emit("click", {});

      expect(executed).toEqual(["system"]);
    });

    it("should handle multiple event types independently", () => {
      const clickCalls = [];
      const dragCalls = [];

      eventBus.subscribe("click", () => clickCalls.push(1));
      eventBus.subscribe("drag", () => dragCalls.push(1));

      eventBus.emit("click", {});
      eventBus.emit("drag", {});
      eventBus.emit("click", {});

      expect(clickCalls.length).toBe(2);
      expect(dragCalls.length).toBe(1);
    });

    it("should handle unsubscribe during iteration gracefully", () => {
      const executed = [];
      let id2;

      eventBus.subscribe("click", () => {
        executed.push("first");
        eventBus.unsubscribe(id2); // Unsubscribe second listener
      }, { priority: 90 });

      id2 = eventBus.subscribe("click", () => {
        executed.push("second");
      }, { priority: 50 });

      eventBus.emit("click", {});

      // Unsubscribe takes effect immediately, so second listener won't execute
      expect(executed).toEqual(["first"]);

      // Confirm it's still unsubscribed on next emit
      executed.length = 0;
      eventBus.emit("click", {});
      expect(executed).toEqual(["first"]);
    });
  });
});
