import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildDesktopPetMenuTemplate, createMenuActions } = require("../../src/main/menu");

function flattenLabels(items) {
  return items.flatMap((item) => [
    item.label,
    ...(Array.isArray(item.submenu) ? flattenLabels(item.submenu) : [])
  ]).filter(Boolean);
}

describe("desktop pet menu builder", () => {
  it("returns the important context menu labels without animation playback controls", () => {
    const template = buildDesktopPetMenuTemplate({
      config: {
        currentPackageId: "default-pet",
        display: {
          alwaysOnTop: true,
          mousePassthrough: false,
          locked: false,
          scale: 1,
          opacity: 1
        }
      },
      petVisible: true,
      actions: {}
    });

    const labels = flattenLabels(template);

    expect(labels).toEqual(expect.arrayContaining([
      "打开控制面板",
      "素材包",
      "当前素材包：default-pet",
      "导入素材包",
      "显示桌宠",
      "锁定拖拽",
      "鼠标穿透",
      "置顶显示",
      "暂停交互",
      "缩放",
      "不透明度",
      "重置位置",
      "查看日志",
      "关于",
      "退出"
    ]));
    expect(labels).not.toEqual(expect.arrayContaining([
      "播放动画",
      "默认动画",
      "点击动画",
      "拖拽动画"
    ]));
  });

  it("wires toggle menu items to injected actions", () => {
    const setDisplayFlag = vi.fn();
    const template = buildDesktopPetMenuTemplate({
      config: {
        display: {
          alwaysOnTop: false,
          mousePassthrough: true,
          locked: false
        }
      },
      petVisible: false,
      actions: {
        setDisplayFlag
      }
    });

    template.find((item) => item.label === "锁定拖拽").click();
    template.find((item) => item.label === "鼠标穿透").click();
    template.find((item) => item.label === "置顶显示").click();

    expect(setDisplayFlag).toHaveBeenNthCalledWith(1, "locked", true);
    expect(setDisplayFlag).toHaveBeenNthCalledWith(2, "mousePassthrough", false);
    expect(setDisplayFlag).toHaveBeenNthCalledWith(3, "alwaysOnTop", true);
  });
});

describe("desktop pet menu actions", () => {
  function createActionsWithPet(petWindow) {
    const config = {
      display: {
        alwaysOnTop: false,
        mousePassthrough: false,
        locked: false,
        scale: 1,
        opacity: 1
      },
      system: {
        interactionsPaused: false
      }
    };

    return createMenuActions({
      app: { quit: vi.fn() },
      configStore: {
        load: vi.fn(() => config),
        save: vi.fn((nextConfig) => nextConfig)
      },
      getWindows: vi.fn(() => ({ pet: petWindow, panel: null })),
      createPanelWindow: vi.fn(),
      refreshMenus: vi.fn()
    });
  }

  it("skips renderer sends when the pet webContents is unavailable", () => {
    const petWindow = {
      isDestroyed: vi.fn(() => false),
      setAlwaysOnTop: vi.fn(),
      webContents: null
    };
    const actions = createActionsWithPet(petWindow);

    expect(() => actions.setDisplayFlag("alwaysOnTop", true)).not.toThrow();
    expect(() => actions.setInteractionsPaused(true)).not.toThrow();
  });

  it("skips renderer sends when the pet webContents is destroyed", () => {
    const send = vi.fn();
    const petWindow = {
      isDestroyed: vi.fn(() => false),
      setAlwaysOnTop: vi.fn(),
      webContents: {
        isDestroyed: vi.fn(() => true),
        send
      }
    };
    const actions = createActionsWithPet(petWindow);

    actions.setDisplayFlag("alwaysOnTop", true);
    actions.setInteractionsPaused(true);

    expect(send).not.toHaveBeenCalled();
  });

  it("skips renderer sends when the pet webContents is crashed", () => {
    const send = vi.fn();
    const petWindow = {
      isDestroyed: vi.fn(() => false),
      setAlwaysOnTop: vi.fn(),
      webContents: {
        isDestroyed: vi.fn(() => false),
        isCrashed: vi.fn(() => true),
        send
      }
    };
    const actions = createActionsWithPet(petWindow);

    actions.setDisplayFlag("alwaysOnTop", true);
    actions.setInteractionsPaused(true);

    expect(send).not.toHaveBeenCalled();
  });

  it("does not throw when the pet webContents send fails", () => {
    const petWindow = {
      isDestroyed: vi.fn(() => false),
      setAlwaysOnTop: vi.fn(),
      webContents: {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(() => {
          throw new Error("renderer unavailable");
        })
      }
    };
    const actions = createActionsWithPet(petWindow);

    expect(() => actions.setDisplayFlag("alwaysOnTop", true)).not.toThrow();
    expect(() => actions.setInteractionsPaused(true)).not.toThrow();
  });

  it("resizes the pet window when scale changes from the menu", () => {
    const petWindow = {
      isDestroyed: vi.fn(() => false),
      setAlwaysOnTop: vi.fn(),
      setBounds: vi.fn(),
      getBounds: vi.fn(() => ({ x: 80, y: 160, width: 320, height: 320 })),
      webContents: {
        isDestroyed: vi.fn(() => false),
        send: vi.fn()
      }
    };
    const actions = createActionsWithPet(petWindow);

    actions.setDisplayFlag("scale", 1.25);

    expect(petWindow.setBounds).toHaveBeenCalledWith({ x: 40, y: 120, width: 400, height: 400 });
    expect(petWindow.webContents.send).toHaveBeenCalledWith("pet:display-updated", expect.objectContaining({ scale: 1.25 }));
  });
});
