import Module from "node:module";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const originalLoad = Module._load;

const createFromDataURL = vi.fn();
const createFromPath = vi.fn();
const Tray = vi.fn();

const electronMock = {
  nativeImage: {
    createFromDataURL,
    createFromPath
  },
  Tray
};

function loadTrayModule() {
  const trayPath = require.resolve("../../src/main/tray");
  delete require.cache[trayPath];
  return require("../../src/main/tray");
}

function createIcon() {
  return {
    isEmpty: vi.fn(() => false),
    resize: vi.fn(() => createIcon()),
    setTemplateImage: vi.fn()
  };
}

function createNativeTray(overrides = {}) {
  return {
    setTitle: vi.fn(),
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    popUpContextMenu: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
    ...overrides
  };
}

describe("createTray", () => {
  beforeAll(() => {
    Module._load = (request, parent, isMain) => {
      if (request === "electron") {
        return electronMock;
      }

      return originalLoad(request, parent, isMain);
    };
  });

  afterAll(() => {
    Module._load = originalLoad;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    createFromPath.mockReturnValue({ isEmpty: vi.fn(() => true) });
    createFromDataURL.mockReturnValue(createIcon());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when creating the native tray throws", () => {
    const error = new Error("tray unsupported");
    Tray.mockImplementation(() => {
      throw error;
    });
    const { createTray } = loadTrayModule();

    expect(createTray({ createMenu: vi.fn() })).toBeNull();
  });

  it("keeps the tray controller usable when refreshing the context menu throws", () => {
    const error = new Error("menu failed");
    const nativeTray = createNativeTray({
      setContextMenu: vi.fn(() => {
        throw error;
      })
    });
    Tray.mockImplementation(() => nativeTray);
    const { createTray } = loadTrayModule();

    const controller = createTray({ createMenu: vi.fn(() => ({ id: "menu" })) });

    expect(controller).not.toBeNull();
    expect(() => controller.refresh()).not.toThrow();
  });

  it("opens the control panel on a left click and the menu on a right click", () => {
    const nativeTray = createNativeTray();
    const createMenu = vi.fn(() => ({ id: "menu" }));
    const onOpenPanel = vi.fn();
    Tray.mockImplementation(() => nativeTray);
    const { createTray } = loadTrayModule();

    createTray({ createMenu, onOpenPanel });
    const handlerFor = (name) => nativeTray.on.mock.calls.find(([eventName]) => eventName === name)?.[1];

    handlerFor("click")();
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    expect(nativeTray.popUpContextMenu).not.toHaveBeenCalled();

    handlerFor("right-click")();
    expect(nativeTray.popUpContextMenu).toHaveBeenCalledTimes(1);
    expect(nativeTray.setContextMenu).toHaveBeenLastCalledWith({ id: "menu" });
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
  });

  it("falls back to the menu when opening the panel is unavailable or throws", () => {
    const nativeTray = createNativeTray();
    const createMenu = vi.fn(() => ({ id: "menu" }));
    Tray.mockImplementation(() => nativeTray);
    const { createTray } = loadTrayModule();

    createTray({ createMenu });
    nativeTray.on.mock.calls.find(([eventName]) => eventName === "click")?.[1]();
    expect(nativeTray.popUpContextMenu).toHaveBeenCalledTimes(1);

    Tray.mockImplementation(() => nativeTray);
    const failing = createTray({
      createMenu,
      onOpenPanel: () => { throw new Error("panel unavailable"); }
    });
    expect(failing).not.toBeNull();
    nativeTray.on.mock.calls.filter(([eventName]) => eventName === "click").at(-1)[1]();
    expect(nativeTray.popUpContextMenu).toHaveBeenCalledTimes(2);
  });

  it("uses an icon-only macOS status item", () => {
    const nativeTray = createNativeTray();
    const originalPlatform = process.platform;
    Tray.mockImplementation(() => nativeTray);
    const { createTray } = loadTrayModule();

    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      createTray({ createMenu: vi.fn(() => ({ id: "menu" })) });

      expect(nativeTray.setTitle).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("loads the macOS template tray icon on darwin", () => {
    const originalPlatform = process.platform;
    Tray.mockImplementation(() => createNativeTray());
    const { createTray } = loadTrayModule();

    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      createTray({ createMenu: vi.fn(() => ({ id: "menu" })) });

      expect(createFromPath).toHaveBeenCalledWith(expect.stringContaining("tray-iconTemplate.png"));
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("loads the template tray icon path on non-macOS platforms", () => {
    const originalPlatform = process.platform;
    Tray.mockImplementation(() => createNativeTray());
    const { createTray } = loadTrayModule();

    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      createTray({ createMenu: vi.fn(() => ({ id: "menu" })) });

      expect(createFromPath).toHaveBeenCalledWith(expect.stringContaining("tray-iconTemplate.png"));
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("normalizes the macOS status icon to the standard menu bar size", () => {
    const icon = createIcon();
    const nativeTray = createNativeTray();
    const originalPlatform = process.platform;
    createFromDataURL.mockReturnValue(icon);
    Tray.mockImplementation(() => nativeTray);
    const { createTray } = loadTrayModule();

    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      createTray({ createMenu: vi.fn(() => ({ id: "menu" })) });

      expect(icon.resize).toHaveBeenCalledWith({ width: 22, height: 22 });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("marks the tray icon as a template image only on macOS", () => {
    const nativeTray = createNativeTray();
    const originalPlatform = process.platform;
    const icon = createIcon();
    const resizedIcon = createIcon();
    icon.resize.mockReturnValue(resizedIcon);
    createFromPath.mockReturnValue(icon);
    Tray.mockImplementation(() => nativeTray);
    const { createTray } = loadTrayModule();

    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      createTray({ createMenu: vi.fn(() => ({ id: "menu" })) });

      expect(resizedIcon.setTemplateImage).toHaveBeenCalledWith(true);

      vi.clearAllMocks();
      Object.defineProperty(process, "platform", { value: "win32" });
      createTray({ createMenu: vi.fn(() => ({ id: "menu" })) });

      expect(icon.setTemplateImage).toHaveBeenCalledWith(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("clears the tray controller when destroying the native tray throws", () => {
    const error = new Error("destroy failed");
    const nativeTray = createNativeTray({
      destroy: vi.fn(() => {
        throw error;
      })
    });
    Tray.mockImplementation(() => nativeTray);
    const { createTray } = loadTrayModule();
    const controller = createTray({ createMenu: vi.fn(() => ({ id: "menu" })) });

    expect(() => controller.destroy()).not.toThrow();
    expect(() => controller.refresh()).not.toThrow();
  });
});
