import { describe, it, expect, beforeEach, vi } from "vitest";
import { UserTriggerManager } from "../../src/renderer/pet/user-trigger-manager.js";

describe("UserTriggerManager", () => {
  let actionExecutors;
  let manager;

  beforeEach(() => {
    actionExecutors = {
      playAnimation: vi.fn(),
      isKeyframeAnimation: vi.fn(() => false),
      setKeyframeProgress: vi.fn(),
      stopAnimation: vi.fn(),
      showMessage: vi.fn(),
      changeDisplay: vi.fn(),
      setVisibility: vi.fn(),
      movePet: vi.fn(),
      resetPosition: vi.fn(),
      openPanel: vi.fn(),
      setInteractionsPaused: vi.fn()
    };
  });

  describe("constructor", () => {
    it("should create instance with action executors", () => {
      manager = new UserTriggerManager(actionExecutors);

      expect(manager).toBeDefined();
      expect(manager.actionExecutors).toBe(actionExecutors);
    });

    it("should work without action executors", () => {
      manager = new UserTriggerManager();

      expect(manager).toBeDefined();
    });
  });

  describe("action execution", () => {
    beforeEach(() => {
      manager = new UserTriggerManager(actionExecutors);
    });

    it("should execute playAnimation action", () => {
      manager.executeAction({ type: "playAnimation", animation: "jump" }, {});

      expect(actionExecutors.playAnimation).toHaveBeenCalledWith("jump", expect.any(Object));
    });

    it("should execute showMessage action", () => {
      manager.executeAction({ type: "showMessage", text: "Hello!" }, {});

      expect(actionExecutors.showMessage).toHaveBeenCalledWith("Hello!", expect.any(Object));
    });

    it("should execute randomMessage action", () => {
      manager.executeAction({ type: "randomMessage", messages: ["Hi!", "Hello!", "Hey!"] }, {});

      expect(actionExecutors.showMessage).toHaveBeenCalledTimes(1);
      const calledMessage = actionExecutors.showMessage.mock.calls[0][0];
      expect(["Hi!", "Hello!", "Hey!"]).toContain(calledMessage);
    });

    it("should execute movePet action", () => {
      const action = { type: "movePet", direction: "upRight", speed: 140, durationMs: 800 };
      manager.executeAction(action, {});

      expect(actionExecutors.movePet).toHaveBeenCalledWith(action);
    });

    it("should execute hide and show actions through setVisibility", () => {
      manager.executeAction({ type: "hidePet" }, { type: "mouseEnter", eventSource: "petRenderer" });
      manager.executeAction({ type: "showPet" }, { type: "mouseEnter", eventSource: "petRenderer" });

      expect(actionExecutors.setVisibility).toHaveBeenCalledWith(false, {
        sourceActionType: "hidePet",
        eventType: "mouseEnter"
      });
      expect(actionExecutors.setVisibility).toHaveBeenCalledWith(true, {
        sourceActionType: "showPet",
        eventType: "mouseEnter"
      });
    });

    it("should execute multiple actions in sequence", () => {
      manager.executeAction({ type: "playAnimation", animation: "jump" }, {});
      manager.executeAction({ type: "showMessage", text: "Wheee!" }, {});

      expect(actionExecutors.playAnimation).toHaveBeenCalledTimes(1);
      expect(actionExecutors.showMessage).toHaveBeenCalledTimes(1);
    });

    it("should resolve keyframe progress from global mouse event context", () => {
      manager.executeAction(
        { type: "setKeyframeProgress", animation: "look", progressFrom: "angleToPetProgress", scale: 0.5, offset: 0.1 },
        { eventSource: "globalMouse", angleToPetProgress: 0.6 }
      );

      expect(actionExecutors.setKeyframeProgress).toHaveBeenCalledWith("look", 0.4, expect.any(Object));
    });

    it("should ignore keyframe progress from non-global mouse events", () => {
      manager.executeAction(
        { type: "setKeyframeProgress", animation: "look", progressFrom: "angleToPetProgress" },
        { eventSource: "petRenderer", angleToPetProgress: 0.6 }
      );

      expect(actionExecutors.setKeyframeProgress).not.toHaveBeenCalled();
    });

    it("should only play keyframe animations from global mouse events", () => {
      actionExecutors.isKeyframeAnimation.mockImplementation((animId) => animId === "look");

      manager.executeAction(
        { type: "playAnimation", animation: "look", progressFrom: "angleToPetProgress" },
        { eventSource: "petRenderer", angleToPetProgress: 0.25 }
      );
      expect(actionExecutors.playAnimation).not.toHaveBeenCalled();

      manager.executeAction(
        { type: "playAnimation", animation: "look", progressFrom: "angleToPetProgress" },
        { eventSource: "globalMouse", angleToPetProgress: 0.25 }
      );
      expect(actionExecutors.playAnimation).toHaveBeenCalledWith("look", expect.objectContaining({ progress: 0.25 }));
    });

    it("should ignore string format actions", () => {
      manager.executeAction("play:jump", {});
      manager.executeAction("message:Hi!", {});

      expect(actionExecutors.playAnimation).not.toHaveBeenCalled();
      expect(actionExecutors.showMessage).not.toHaveBeenCalled();
    });

    it("should ignore legacy action type aliases", () => {
      manager = new UserTriggerManager(actionExecutors, { logger: { warn: vi.fn(), error: vi.fn() } });

      manager.executeAction({ type: "play", param: "jump" }, {});
      manager.executeAction({ type: "message", param: "Hi!" }, {});
      manager.executeAction({ type: "stop" }, {});

      expect(actionExecutors.playAnimation).not.toHaveBeenCalled();
      expect(actionExecutors.showMessage).not.toHaveBeenCalled();
      expect(actionExecutors.stopAnimation).not.toHaveBeenCalled();
    });

    it("should execute stopAnimation action", () => {
      manager.executeAction({ type: "stopAnimation" }, {});

      expect(actionExecutors.stopAnimation).toHaveBeenCalledTimes(1);
    });

    it("should execute changeScale action", () => {
      manager.executeAction({ type: "changeScale", scale: 1.5 }, {});

      expect(actionExecutors.changeDisplay).toHaveBeenCalledWith({ type: "changeScale", scale: 1.5 });
    });

    it("should execute changeOpacity action", () => {
      manager.executeAction({ type: "changeOpacity", opacity: 0.8 }, {});

      expect(actionExecutors.changeDisplay).toHaveBeenCalledWith({ type: "changeOpacity", opacity: 0.8 });
    });

    it("should execute resetPosition action", () => {
      manager.executeAction({ type: "resetPosition" }, {});

      expect(actionExecutors.resetPosition).toHaveBeenCalledTimes(1);
    });

    it("should execute openPanel action", () => {
      manager.executeAction({ type: "openPanel" }, {});

      expect(actionExecutors.openPanel).toHaveBeenCalledTimes(1);
    });

    it("should execute interaction toggle actions", () => {
      manager.executeAction({ type: "disableInteractions" }, { type: "click" });
      manager.executeAction({ type: "enableInteractions" }, { type: "timer" });

      expect(actionExecutors.setInteractionsPaused).toHaveBeenCalledWith(true, {
        sourceActionType: "disableInteractions",
        eventType: "click"
      });
      expect(actionExecutors.setInteractionsPaused).toHaveBeenCalledWith(false, {
        sourceActionType: "enableInteractions",
        eventType: "timer"
      });
    });

    it("should accept blank actions as no-op probability placeholders", () => {
      const mockLogger = { warn: vi.fn(), error: vi.fn() };
      manager = new UserTriggerManager(actionExecutors, { logger: mockLogger });

      manager.executeAction({ type: "blank", durationMs: 1200 }, { type: "click" });

      expect(actionExecutors.playAnimation).not.toHaveBeenCalled();
      expect(actionExecutors.showMessage).not.toHaveBeenCalled();
      expect(actionExecutors.changeDisplay).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("should accept delay actions as runtime no-ops", () => {
      const mockLogger = { warn: vi.fn(), error: vi.fn() };
      manager = new UserTriggerManager(actionExecutors, { logger: mockLogger });

      manager.executeAction({ type: "delay", durationMs: 1200 }, { type: "click" });

      expect(actionExecutors.playAnimation).not.toHaveBeenCalled();
      expect(actionExecutors.showMessage).not.toHaveBeenCalled();
      expect(actionExecutors.changeDisplay).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("should dispatch pomodoro timer actions", () => {
      actionExecutors.pomodoroTimer = vi.fn();

      manager.executeAction(
        { type: "pomodoroTimer", command: "start", durationMs: 1500000, label: "Focus" },
        { type: "click" }
      );

      expect(actionExecutors.pomodoroTimer).toHaveBeenCalledWith(
        { type: "pomodoroTimer", command: "start", durationMs: 1500000, label: "Focus" },
        { type: "click" }
      );
    });

    it("should handle null or undefined actions gracefully", () => {
      expect(() => manager.executeAction(null, {})).not.toThrow();
      expect(() => manager.executeAction(undefined, {})).not.toThrow();
    });

    it("should warn on unknown action type", () => {
      const mockLogger = { warn: vi.fn(), error: vi.fn() };
      manager = new UserTriggerManager(actionExecutors, { logger: mockLogger });

      manager.executeAction({ type: "unknownAction" }, {});

      expect(mockLogger.warn).toHaveBeenCalledWith("Unknown action type: unknownAction");
    });

    it("should warn on action missing type", () => {
      const mockLogger = { warn: vi.fn(), error: vi.fn() };
      manager = new UserTriggerManager(actionExecutors, { logger: mockLogger });

      manager.executeAction({ animation: "jump" }, {});

      expect(mockLogger.warn).toHaveBeenCalledWith("Action missing type", { animation: "jump" });
    });
  });
});
