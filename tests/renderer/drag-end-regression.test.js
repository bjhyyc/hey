import { describe, it, expect, vi } from "vitest";
import { createPetController } from "../../src/renderer/pet/pet-controller.js";
import { AnimationController } from "../../src/renderer/pet/animation-controller.js";

// 复现真实拖拽配置的端到端时序，验证 dragEnd 不再绕过队列强制回默认。
describe("drag-end regression (real config sequence)", () => {
  it("does not force return-to-default on drag end; fall plays after grab finishes", () => {
    vi.useFakeTimers();

    const renderCalls = [];
    const controller = new AnimationController(
      {
        default: { id: "default", asset: "idle.webm" },
        clips: [
          { id: "grab", asset: "grab.webm", type: "oneshot", durationMs: 4042 },
          { id: "hover", asset: "hover.webm", type: "loop" },
          { id: "fall", asset: "fall.webm", type: "oneshot", durationMs: 2333 }
        ]
      },
      { renderClip: (asset) => renderCalls.push(asset) }
    );

    let returnToDefaultCalls = 0;
    const pet = createPetController({
      clearIdle: () => {},
      movePetWindow: () => {},
      getWindowPosition: () => ({ x: 0, y: 0 }),
      getWindowSize: () => ({ width: 320, height: 320 }),
      setDraggingClass: () => {},
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => true,
      // dragStart 规则：抓取 + 悬空
      onDragStart: () => {
        controller.playAnimation("grab");
        controller.playAnimation("hover");
        return true;
      },
      onDragging: () => true,
      // dragEnd 规则：下落
      onDragEnd: () => {
        controller.playAnimation("fall");
        return true;
      }
    });

    // 若 pet-controller 仍强制回默认，这里会被调用（旧 bug）。
    const origReturn = controller.returnToDefault.bind(controller);
    controller.returnToDefault = (...args) => { returnToDefaultCalls += 1; return origReturn(...args); };

    // 拖拽序列
    pet.startDrag({ button: 0, pointerId: 1, screenX: 100, screenY: 100 });
    pet.continueDrag({ pointerId: 1, screenX: 140, screenY: 100 }); // 越过阈值 -> dragStart
    // 松手（抓取 4042ms 还没播完，约拖了一瞬）
    pet.endDrag({ pointerId: 1 });

    // dragEnd 后：抓取仍在播（受保护），下落在等待区，且没有被强制回默认
    expect(controller.getCurrentClip().id).toBe("grab");
    expect(controller.pending && controller.pending.clipId).toBe("fall");
    const returnCallsAtEnd = returnToDefaultCalls;

    // 抓取 4042ms 播完 -> 应播下落（而不是回默认）
    vi.advanceTimersByTime(4042);
    expect(controller.getCurrentClip().id).toBe("fall");

    // 关键断言：整个过程中 pet-controller 没有绕过队列强制回默认
    // （唯一允许的 returnToDefault 是 controller 内部在等待区空时，此处等待区非空）
    expect(returnCallsAtEnd).toBe(0);

    vi.useRealTimers();
  });
});
