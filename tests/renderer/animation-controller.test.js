import { describe, it, expect, beforeEach, vi } from "vitest";
import { AnimationController } from "../../src/renderer/pet/animation-controller.js";

describe("AnimationController", () => {
  let renderer;
  let controller;

  beforeEach(() => {
    renderer = {
      renderClip: vi.fn(),
      onClipEnd: vi.fn()
    };
  });

  describe("constructor", () => {
    it("should create instance with default animation", () => {
      const config = {
        default: {
          id: "idle",
          asset: "idle.gif"
        }
      };

      controller = new AnimationController(config, renderer);

      expect(controller).toBeDefined();
      expect(controller.getCurrentState()).toBe("default");
      expect(controller.getCurrentClip().id).toBe("idle");
    });

    it("should throw error if default animation missing", () => {
      expect(() => {
        new AnimationController({}, renderer);
      }).toThrow("Default animation is required");
    });

    it("should throw error if renderer.renderClip missing", () => {
      const config = {
        default: { id: "idle", asset: "idle.gif" }
      };

      expect(() => {
        new AnimationController(config, {});
      }).toThrow("renderer.renderClip function is required");
    });

    it("should load animation clips from config", () => {
      const config = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "jump", asset: "jump.webm", type: "oneshot" },
          { id: "run", asset: "run.webm", type: "loop" }
        ]
      };

      controller = new AnimationController(config, renderer);

      expect(controller.hasClip("idle")).toBe(true);
      expect(controller.hasClip("jump")).toBe(true);
      expect(controller.hasClip("run")).toBe(true);
    });

    it("should default clip type to oneshot", () => {
      const config = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "wave", asset: "wave.webm" } // No type specified
        ]
      };

      controller = new AnimationController(config, renderer);

      const clip = controller.getClip("wave");
      expect(clip.type).toBe("oneshot");
    });

    it("should scrub keyframe clips through renderer progress", () => {
      const config = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "look", asset: "look.mp4", type: "keyframe" }
        ]
      };
      renderer.setProgress = vi.fn(() => true);
      controller = new AnimationController(config, renderer);

      expect(controller.setKeyframeProgress("look", 0.25)).toBe(true);
      expect(renderer.renderClip).toHaveBeenCalledWith("look.mp4", {
        keyframe: true,
        progress: 0.25,
        clipId: "look"
      });
      expect(controller.getCurrentState()).toBe("playing-keyframe");

      expect(controller.setKeyframeProgress("look", 0.75)).toBe(true);
      expect(renderer.setProgress).toHaveBeenCalledWith(0.75);
    });

    it("should pass green screen settings to renderer for video clips", () => {
      const greenScreen = { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 };
      const config = {
        default: { id: "idle", asset: "idle.mp4", greenScreen },
        clips: [
          { id: "wave", asset: "wave.mp4", type: "loop", greenScreen }
        ]
      };
      controller = new AnimationController(config, renderer);

      expect(controller.playAnimation("wave")).toBe(true);
      expect(renderer.renderClip).toHaveBeenCalledWith("wave.mp4", {
        loop: true,
        durationMs: undefined,
        greenScreen
      });

      controller.returnToDefault();
      expect(renderer.renderClip).toHaveBeenLastCalledWith("idle.mp4", {
        loop: true,
        greenScreen
      });
    });
  });

  describe("playAnimation", () => {
    beforeEach(() => {
      const config = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "jump", asset: "jump.webm", type: "oneshot", durationMs: 500 },
          { id: "run", asset: "run.webm", type: "loop" }
        ]
      };
      controller = new AnimationController(config, renderer);
    });

    it("should play oneshot animation", () => {
      const result = controller.playAnimation("jump");

      expect(result).toBe(true);
      expect(renderer.renderClip).toHaveBeenCalledWith("jump.webm", {
        loop: false,
        durationMs: 500
      });
      expect(controller.getCurrentState()).toBe("playing-oneshot");
      expect(controller.getCurrentClip().id).toBe("jump");
    });

    it("should play loop animation", () => {
      const result = controller.playAnimation("run");

      expect(result).toBe(true);
      expect(renderer.renderClip).toHaveBeenCalledWith("run.webm", {
        loop: true,
        durationMs: undefined
      });
      expect(controller.getCurrentState()).toBe("playing-loop");
    });

    it("should return false for non-existent clip", () => {
      const result = controller.playAnimation("nonexistent");

      expect(result).toBe(false);
      expect(renderer.renderClip).not.toHaveBeenCalled();
    });

    it("should return false for empty clipId", () => {
      const result = controller.playAnimation("");

      expect(result).toBe(false);
    });

    it("should override clip options", () => {
      controller.playAnimation("jump", {
        loop: true,
        durationMs: 1000
      });

      expect(renderer.renderClip).toHaveBeenCalledWith("jump.webm", {
        loop: true,
        durationMs: 1000
      });
    });

    it("should return to default after oneshot completes", () => {
      vi.useFakeTimers();

      controller.playAnimation("jump");
      expect(controller.getCurrentState()).toBe("playing-oneshot");

      // Fast-forward time
      vi.advanceTimersByTime(500);

      expect(controller.getCurrentState()).toBe("default");
      expect(controller.getCurrentClip().id).toBe("idle");
      expect(renderer.renderClip).toHaveBeenCalledWith("idle.gif", { loop: true });

      vi.useRealTimers();
    });

    it("should not return to default for loop animation", () => {
      vi.useFakeTimers();

      controller.playAnimation("run");
      expect(controller.getCurrentState()).toBe("playing-loop");

      // Fast-forward time
      vi.advanceTimersByTime(5000);

      // Should still be playing loop
      expect(controller.getCurrentState()).toBe("playing-loop");

      vi.useRealTimers();
    });

    it("should ignore replaying the same oneshot while it is still playing", () => {
      vi.useFakeTimers();

      controller.playAnimation("jump"); // 500ms
      vi.advanceTimersByTime(200);
      controller.playAnimation("jump"); // 同 active -> 忽略，不重置计时

      vi.advanceTimersByTime(300); // 距首次 500ms
      expect(controller.getCurrentState()).toBe("default");

      vi.useRealTimers();
    });

    it("should queue a new animation while a oneshot is still playing", () => {
      vi.useFakeTimers();

      controller.playAnimation("jump"); // oneshot 500ms
      renderer.renderClip.mockClear();

      // 播放中来第二个动画 -> 进等待区，active 不变
      const result = controller.playAnimation("run");
      expect(result).toBe(true);
      expect(controller.getCurrentClip().id).toBe("jump");
      expect(controller.getCurrentState()).toBe("playing-oneshot");
      expect(renderer.renderClip).not.toHaveBeenCalled();

      // jump 播完 -> 播放等待区的 run
      vi.advanceTimersByTime(500);
      expect(controller.getCurrentClip().id).toBe("run");
      expect(controller.getCurrentState()).toBe("playing-loop");

      vi.useRealTimers();
    });

    it("should replace the pending slot so the newest queued animation wins", () => {
      vi.useFakeTimers();

      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            { id: "a", asset: "a.webm", type: "oneshot", durationMs: 500 },
            { id: "b", asset: "b.webm", type: "oneshot", durationMs: 300 },
            { id: "c", asset: "c.webm", type: "loop" }
          ]
        },
        renderer
      );

      local.playAnimation("a"); // active oneshot 500ms
      local.playAnimation("b"); // pending = b
      local.playAnimation("c"); // pending 覆盖为 c

      vi.advanceTimersByTime(500); // a 播完 -> 播 c（不是 b）
      expect(local.getCurrentClip().id).toBe("c");
      expect(local.getCurrentState()).toBe("playing-loop");

      vi.useRealTimers();
    });

    it("should ignore a queued request equal to the currently playing clip", () => {
      vi.useFakeTimers();

      controller.playAnimation("jump"); // active oneshot 500ms
      controller.playAnimation("jump"); // 与 active 相同 -> 忽略，不入队

      // 无 pending：jump 播完后回 default（而非重播 jump）
      vi.advanceTimersByTime(500);
      expect(controller.getCurrentState()).toBe("default");
      expect(controller.getCurrentClip().id).toBe("idle");

      vi.useRealTimers();
    });

    it("should switch a loop to the pending clip at the next cycle boundary", () => {
      vi.useFakeTimers();

      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            { id: "spin", asset: "spin.webm", type: "loop", durationMs: 1000 },
            { id: "hit", asset: "hit.webm", type: "oneshot", durationMs: 200 }
          ]
        },
        renderer
      );

      local.playAnimation("spin"); // loop, cycle 1000ms, loopStartedAt=0
      vi.advanceTimersByTime(300);  // 循环内 300ms

      local.playAnimation("hit");   // 入队；应在 t=1000 边界切换
      expect(local.getCurrentClip().id).toBe("spin"); // 尚未切换

      vi.advanceTimersByTime(699);  // t=999
      expect(local.getCurrentClip().id).toBe("spin"); // 仍是 spin

      vi.advanceTimersByTime(1);    // t=1000 边界
      expect(local.getCurrentClip().id).toBe("hit");
      expect(local.getCurrentState()).toBe("playing-oneshot");

      vi.useRealTimers();
    });

    it("should switch a loop immediately when it has no durationMs", () => {
      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            { id: "spin", asset: "spin.webm", type: "loop" }, // 无 durationMs
            { id: "hit", asset: "hit.webm", type: "oneshot", durationMs: 200 }
          ]
        },
        renderer
      );

      local.playAnimation("spin");
      local.playAnimation("hit"); // 无 durationMs -> 立即切换
      expect(local.getCurrentClip().id).toBe("hit");
    });
  });

  describe("interrupt clips", () => {
    let local;

    beforeEach(() => {
      local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            { id: "spin", asset: "spin.webm", type: "loop", durationMs: 1000 },
            { id: "jump", asset: "jump.webm", type: "oneshot", durationMs: 500 },
            { id: "cut", asset: "cut.webm", type: "oneshot", durationMs: 400, interrupt: true },
            { id: "cutLoop", asset: "cutloop.webm", type: "loop", interrupt: true }
          ]
        },
        renderer
      );
    });

    it("should preserve interrupt/movement/easing fields on normalized clips", () => {
      const controllerWithFields = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            {
              id: "walk",
              asset: "walk.webm",
              type: "oneshot",
              durationMs: 800,
              interrupt: true,
              movement: {
                direction: "left",
                speed: 90,
                easing: {
                  preset: "easeInOut",
                  strength: 1.4,
                  easeInMs: 180,
                  easeOutMs: 220,
                  startDelayMs: 200,
                  endDelayMs: 100
                }
              }
            }
          ]
        },
        renderer
      );

      const clip = controllerWithFields.getClip("walk");
      expect(clip.interrupt).toBe(true);
      expect(clip.movement).toEqual({
        direction: "left",
        speed: 90,
        easing: {
          preset: "easeInOut",
          strength: 1.4,
          easeInMs: 180,
          easeOutMs: 220,
          startDelayMs: 200,
          endDelayMs: 100
        }
      });
    });

    it("should bypass a protected oneshot and play immediately", () => {
      vi.useFakeTimers();

      local.playAnimation("jump"); // protected oneshot 500ms
      expect(local.getCurrentClip().id).toBe("jump");

      local.playAnimation("cut"); // interrupt -> plays immediately
      expect(local.getCurrentClip().id).toBe("cut");
      expect(local.getCurrentState()).toBe("playing-oneshot");

      vi.useRealTimers();
    });

    it("should bypass a protected loop and play immediately", () => {
      vi.useFakeTimers();

      local.playAnimation("spin"); // protected loop
      expect(local.getCurrentClip().id).toBe("spin");

      local.playAnimation("cut"); // interrupt -> plays immediately
      expect(local.getCurrentClip().id).toBe("cut");

      vi.useRealTimers();
    });

    it("should clear an existing pending slot when interrupting", () => {
      vi.useFakeTimers();

      local.playAnimation("spin"); // protected loop
      local.playAnimation("jump"); // queued to pending
      expect(local.pending && local.pending.clipId).toBe("jump");

      local.playAnimation("cut"); // interrupt clears pending, plays now
      expect(local.getCurrentClip().id).toBe("cut");
      expect(local.pending).toBeNull();

      vi.useRealTimers();
    });

    it("should ignore replaying the active interrupt clip while it is protected", () => {
      vi.useFakeTimers();

      local.playAnimation("cut"); // protected interrupt oneshot
      renderer.renderClip.mockClear();

      local.playAnimation("cut");

      expect(local.getCurrentClip().id).toBe("cut");
      expect(renderer.renderClip).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should not affect non-interrupt queue behavior", () => {
      vi.useFakeTimers();

      local.playAnimation("jump"); // protected oneshot 500ms
      local.playAnimation("spin"); // non-interrupt -> queued
      expect(local.getCurrentClip().id).toBe("jump");
      expect(local.pending && local.pending.clipId).toBe("spin");

      vi.useRealTimers();
    });
  });

  describe("onClipStart callback", () => {
    it("fires when a clip plays immediately", () => {
      const onClipStart = vi.fn();
      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [{ id: "walk", asset: "walk.webm", type: "oneshot", durationMs: 500 }]
        },
        { ...renderer, onClipStart }
      );

      local.playAnimation("walk");
      expect(onClipStart).toHaveBeenCalledWith(expect.objectContaining({ id: "walk" }));
    });

    it("fires when a queued clip is promoted from the pending slot", () => {
      // Regression: a non-interrupt clip that only becomes active via
      // advanceToPending must still notify onClipStart (drives clip-bound movement).
      vi.useFakeTimers();

      const onClipStart = vi.fn();
      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            { id: "jump", asset: "jump.webm", type: "oneshot", durationMs: 500 },
            { id: "walk", asset: "walk.webm", type: "oneshot", durationMs: 300 }
          ]
        },
        { ...renderer, onClipStart }
      );

      local.playAnimation("jump"); // active, protected
      local.playAnimation("walk"); // queued, not active yet
      onClipStart.mockClear();

      vi.advanceTimersByTime(500); // jump ends -> advance to walk
      expect(local.getCurrentClip().id).toBe("walk");
      expect(onClipStart).toHaveBeenCalledWith(expect.objectContaining({ id: "walk" }));

      vi.useRealTimers();
    });

    it("fires with the default clip when returning to default", () => {
      const onClipStart = vi.fn();
      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [{ id: "run", asset: "run.webm", type: "loop" }]
        },
        { ...renderer, onClipStart }
      );

      local.playAnimation("run");
      onClipStart.mockClear();

      local.stopAnimation(); // loop with no durationMs -> returns to default
      expect(onClipStart).toHaveBeenCalledWith(expect.objectContaining({ id: "idle" }));
    });
  });

  describe("stopAnimation", () => {
    beforeEach(() => {
      const config = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "jump", asset: "jump.webm", type: "oneshot" },
          { id: "run", asset: "run.webm", type: "loop" }
        ]
      };
      controller = new AnimationController(config, renderer);
    });

    it("should stop loop animation and return to default", () => {
      controller.playAnimation("run");
      expect(controller.getCurrentState()).toBe("playing-loop");

      controller.stopAnimation();

      expect(controller.getCurrentState()).toBe("default");
      expect(controller.getCurrentClip().id).toBe("idle");
    });

    it("should stop oneshot animation and return to default", () => {
      vi.useFakeTimers();

      controller.playAnimation("jump");
      expect(controller.getCurrentState()).toBe("playing-oneshot");

      controller.stopAnimation(); // 受保护的 oneshot -> 排队，等其播完再回 default
      expect(controller.getCurrentState()).toBe("playing-oneshot");

      // oneshot 无 durationMs -> 默认 1000ms 后回 default
      vi.advanceTimersByTime(1000);
      expect(controller.getCurrentState()).toBe("default");

      vi.useRealTimers();
    });

    it("should do nothing if already at default", () => {
      expect(controller.getCurrentState()).toBe("default");

      controller.stopAnimation();

      expect(controller.getCurrentState()).toBe("default");
    });

    it("should preserve an already-queued pending clip when stopAnimation fires on a protected oneshot", () => {
      vi.useFakeTimers();

      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            { id: "a", asset: "a.webm", type: "oneshot", durationMs: 500 },
            { id: "b", asset: "b.webm", type: "loop" }
          ]
        },
        renderer
      );

      local.playAnimation("a"); // active oneshot 500ms (protected)
      local.playAnimation("b"); // pending = b
      local.stopAnimation();    // 已有 pending -> 保留 b（最新入队者胜）

      vi.advanceTimersByTime(500); // a 播完 -> 播放保留的 b（不是 default）
      expect(local.getCurrentClip().id).toBe("b");
      expect(local.getCurrentState()).toBe("playing-loop");

      vi.useRealTimers();
    });

    it("should return to default on stopAnimation when a protected oneshot has no pending", () => {
      vi.useFakeTimers();

      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [{ id: "a", asset: "a.webm", type: "oneshot", durationMs: 500 }]
        },
        renderer
      );

      local.playAnimation("a"); // active oneshot 500ms, 无 pending
      local.stopAnimation();    // 无 pending -> 播完回 default

      vi.advanceTimersByTime(500);
      expect(local.getCurrentState()).toBe("default");
      expect(local.getCurrentClip().id).toBe("idle");

      vi.useRealTimers();
    });

    it("should stop a looping clip at its cycle boundary when it has durationMs", () => {
      vi.useFakeTimers();

      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [{ id: "spin", asset: "spin.webm", type: "loop", durationMs: 1000 }]
        },
        renderer
      );

      local.playAnimation("spin");
      vi.advanceTimersByTime(400);

      local.stopAnimation(); // 受保护的 loop -> 边界处回 default
      expect(local.getCurrentClip().id).toBe("spin"); // 尚未停

      vi.advanceTimersByTime(600); // t=1000 边界
      expect(local.getCurrentState()).toBe("default");
      expect(local.getCurrentClip().id).toBe("idle");

      vi.useRealTimers();
    });
  });

  describe("state queries", () => {
    beforeEach(() => {
      const config = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "jump", asset: "jump.webm", type: "oneshot" },
          { id: "run", asset: "run.webm", type: "loop" }
        ]
      };
      controller = new AnimationController(config, renderer);
    });

    it("should report isPlaying correctly", () => {
      vi.useFakeTimers();

      expect(controller.isPlaying()).toBe(false);

      controller.playAnimation("jump");
      expect(controller.isPlaying()).toBe(true);

      controller.stopAnimation();      // 受保护的 oneshot -> 排队
      vi.advanceTimersByTime(1000);    // jump 播完 -> default
      expect(controller.isPlaying()).toBe(false);

      vi.useRealTimers();
    });

    it("should report isPlayingOneshot correctly", () => {
      vi.useFakeTimers();
      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            { id: "jump", asset: "jump.webm", type: "oneshot", durationMs: 500 },
            { id: "run", asset: "run.webm", type: "loop" }
          ]
        },
        renderer
      );
      expect(local.isPlayingOneshot()).toBe(false);

      local.playAnimation("jump");
      expect(local.isPlayingOneshot()).toBe(true);

      local.stopAnimation();           // 排队回 default
      vi.advanceTimersByTime(500);     // jump 播完 -> default
      local.playAnimation("run");      // 现在可立即播 loop
      expect(local.isPlayingOneshot()).toBe(false);
      vi.useRealTimers();
    });

    it("should report isPlayingLoop correctly", () => {
      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            { id: "jump", asset: "jump.webm", type: "oneshot", durationMs: 500 },
            { id: "run", asset: "run.webm", type: "loop" } // 无 durationMs
          ]
        },
        renderer
      );
      expect(local.isPlayingLoop()).toBe(false);

      local.playAnimation("run");
      expect(local.isPlayingLoop()).toBe(true);

      local.stopAnimation(); // loop 无 durationMs -> 立即回 default
      expect(local.isPlayingLoop()).toBe(false);
    });
  });

  describe("clip queries", () => {
    beforeEach(() => {
      const config = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "jump", asset: "jump.webm", type: "oneshot" },
          { id: "run", asset: "run.webm", type: "loop" }
        ]
      };
      controller = new AnimationController(config, renderer);
    });

    it("should check if clip exists", () => {
      expect(controller.hasClip("idle")).toBe(true);
      expect(controller.hasClip("jump")).toBe(true);
      expect(controller.hasClip("nonexistent")).toBe(false);
    });

    it("should get clip by ID", () => {
      const clip = controller.getClip("jump");

      expect(clip).toBeDefined();
      expect(clip.id).toBe("jump");
      expect(clip.asset).toBe("jump.webm");
      expect(clip.type).toBe("oneshot");
    });

    it("should return null for non-existent clip", () => {
      const clip = controller.getClip("nonexistent");

      expect(clip).toBeNull();
    });

    it("should get all clip IDs", () => {
      const ids = controller.getClipIds();

      expect(ids).toContain("idle");
      expect(ids).toContain("jump");
      expect(ids).toContain("run");
      expect(ids.length).toBe(3);
    });

    it("should get all clips", () => {
      const clips = controller.getAllClips();

      expect(clips.length).toBe(3);
      expect(clips.find(c => c.id === "idle")).toBeDefined();
      expect(clips.find(c => c.id === "jump")).toBeDefined();
      expect(clips.find(c => c.id === "run")).toBeDefined();
    });

    it("should return copy of clip, not reference", () => {
      const clip1 = controller.getClip("jump");
      const clip2 = controller.getClip("jump");

      expect(clip1).not.toBe(clip2);
      expect(clip1).toEqual(clip2);
    });
  });

  describe("updateConfig", () => {
    beforeEach(() => {
      const config = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "jump", asset: "jump.webm", type: "oneshot" }
        ]
      };
      controller = new AnimationController(config, renderer);
    });

    it("should update clips", () => {
      const newConfig = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "wave", asset: "wave.webm", type: "oneshot" },
          { id: "spin", asset: "spin.webm", type: "loop" }
        ]
      };

      controller.updateConfig(newConfig);

      expect(controller.hasClip("jump")).toBe(false);
      expect(controller.hasClip("wave")).toBe(true);
      expect(controller.hasClip("spin")).toBe(true);
    });

    it("should update default animation", () => {
      const newConfig = {
        default: { id: "new-idle", asset: "new-idle.gif" },
        clips: []
      };

      controller.updateConfig(newConfig);

      expect(controller.getClip("new-idle")).toBeDefined();
      expect(controller.getClip("new-idle").asset).toBe("new-idle.gif");
    });

    it("renders a changed default immediately while already idle", () => {
      controller.updateConfig({
        default: { id: "new-idle", asset: "new-idle.gif" },
        clips: []
      });

      expect(controller.getCurrentState()).toBe("default");
      expect(controller.getCurrentClip()).toMatchObject({ id: "new-idle", asset: "new-idle.gif" });
      expect(renderer.renderClip).toHaveBeenCalledWith("new-idle.gif", { loop: true });
    });

    it("should return to default if current clip removed", () => {
      controller.playAnimation("jump");
      expect(controller.getCurrentClip().id).toBe("jump");

      const newConfig = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [] // Remove jump
      };

      controller.updateConfig(newConfig);

      expect(controller.getCurrentState()).toBe("default");
      expect(controller.getCurrentClip().id).toBe("idle");
    });

    it("should keep playing if current clip still exists", () => {
      controller.playAnimation("jump");

      const newConfig = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "jump", asset: "jump-updated.webm", type: "oneshot" }
        ]
      };

      controller.updateConfig(newConfig);

      // State should remain (clip ID still exists)
      expect(controller.getCurrentState()).toBe("playing-oneshot");
    });

    it("should clear a pending clip that was removed by updateConfig", () => {
      vi.useFakeTimers();

      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            { id: "a", asset: "a.webm", type: "oneshot", durationMs: 500 },
            { id: "b", asset: "b.webm", type: "loop" }
          ]
        },
        renderer
      );

      local.playAnimation("a"); // active oneshot
      local.playAnimation("b"); // pending = b

      // 删除 b（保留 a），pending 应被清空
      local.updateConfig({
        default: { id: "idle", asset: "idle.gif" },
        clips: [{ id: "a", asset: "a.webm", type: "oneshot", durationMs: 500 }]
      });

      vi.advanceTimersByTime(500); // a 播完 -> 无有效 pending -> 回 default
      expect(local.getCurrentState()).toBe("default");
      expect(local.getCurrentClip().id).toBe("idle");

      vi.useRealTimers();
    });

    it("should refresh the loop boundary timing when the active loop's durationMs is edited mid-play", () => {
      vi.useFakeTimers();

      const local = new AnimationController(
        {
          default: { id: "idle", asset: "idle.gif" },
          clips: [
            { id: "spin", asset: "spin.webm", type: "loop", durationMs: 1000 },
            { id: "hit", asset: "hit.webm", type: "oneshot", durationMs: 200 }
          ]
        },
        renderer
      );

      local.playAnimation("spin"); // loop, cycle 1000ms, loopStartedAt=0
      local.playAnimation("hit");  // pending = hit, boundary scheduled at t=1000
      vi.advanceTimersByTime(300); // t=300, 仍在 spin

      // 保留 spin 与 hit，但把 spin 的 cycle 改为 400ms
      // re-schedule: elapsed=300, 300%400=300, remaining=100 -> 新边界在 t=400
      local.updateConfig({
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "spin", asset: "spin.webm", type: "loop", durationMs: 400 },
          { id: "hit", asset: "hit.webm", type: "oneshot", durationMs: 200 }
        ]
      });

      vi.advanceTimersByTime(99);  // t=399, 仍是 spin（旧的 1000ms 边界已作废）
      expect(local.getCurrentClip().id).toBe("spin");

      vi.advanceTimersByTime(1);   // t=400, 新边界 -> 切到 hit
      expect(local.getCurrentClip().id).toBe("hit");
      expect(local.getCurrentState()).toBe("playing-oneshot");

      vi.useRealTimers();
    });
  });

  describe("destroy", () => {
    it("should cleanup resources", () => {
      vi.useFakeTimers();

      const config = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "jump", asset: "jump.webm", type: "oneshot", durationMs: 500 }
        ]
      };
      controller = new AnimationController(config, renderer);

      controller.playAnimation("jump");
      controller.destroy();

      // Timer should be cleared
      vi.advanceTimersByTime(1000);
      // No error should occur

      expect(controller.getCurrentClip()).toBeNull();

      vi.useRealTimers();
    });
  });

  describe("integration scenarios", () => {
    beforeEach(() => {
      const config = {
        default: { id: "idle", asset: "idle.gif" },
        clips: [
          { id: "click", asset: "click.webm", type: "oneshot", durationMs: 800 },
          { id: "drag", asset: "drag.webm", type: "loop" },
          { id: "wave", asset: "wave.webm", type: "oneshot", durationMs: 1200 }
        ]
      };
      controller = new AnimationController(config, renderer);
    });

    it("should queue drag while click plays, then reach default via stop", () => {
      vi.useFakeTimers();

      controller.playAnimation("click"); // oneshot 800ms
      controller.playAnimation("drag");  // 入队（不打断 click）
      expect(controller.getCurrentClip().id).toBe("click");

      vi.advanceTimersByTime(800);       // click 播完 -> drag(loop)
      expect(controller.isPlayingLoop()).toBe(true);

      controller.stopAnimation();        // drag 无 durationMs -> 立即回 default
      expect(controller.getCurrentState()).toBe("default");

      vi.useRealTimers();
    });

    it("should handle rapid animation switches via the queue (latest wins)", () => {
      vi.useFakeTimers();

      controller.playAnimation("click"); // active oneshot 800ms
      controller.playAnimation("wave");  // pending=wave
      controller.playAnimation("drag");  // pending 覆盖为 drag
      expect(controller.getCurrentClip().id).toBe("click");

      vi.advanceTimersByTime(800);       // click 播完 -> drag
      expect(controller.getCurrentClip().id).toBe("drag");
      expect(controller.isPlayingLoop()).toBe(true);

      vi.useRealTimers();
    });

    it("should handle oneshot -> queued oneshot sequence", () => {
      vi.useFakeTimers();

      controller.playAnimation("click"); // 800ms
      controller.playAnimation("wave");  // 入队 1200ms
      expect(controller.getCurrentClip().id).toBe("click");

      vi.advanceTimersByTime(800);       // click 完 -> wave 开始
      expect(controller.getCurrentClip().id).toBe("wave");
      expect(controller.getCurrentState()).toBe("playing-oneshot");

      vi.advanceTimersByTime(1200);      // wave 完 -> default
      expect(controller.getCurrentState()).toBe("default");

      vi.useRealTimers();
    });
  });
});
