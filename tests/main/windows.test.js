import Module from "node:module";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const originalLoad = Module._load;

const BrowserWindow = vi.fn();
const appMock = {
  isPackaged: false,
  getVersion: vi.fn(() => "0.1.1")
};

function loadWindowsModule() {
  const windowsPath = require.resolve("../../src/main/windows");
  delete require.cache[windowsPath];
  return require("../../src/main/windows");
}

function createWindowMock() {
  return {
    loadFile: vi.fn(async () => undefined),
    on: vi.fn(),
    isDestroyed: vi.fn(() => false)
  };
}

describe("desktop pet windows", () => {
  beforeAll(() => {
    Module._load = (request, parent, isMain) => {
      if (request === "electron") {
        return { app: appMock, BrowserWindow };
      }

      return originalLoad(request, parent, isMain);
    };
  });

  afterAll(() => {
    Module._load = originalLoad;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    BrowserWindow.mockImplementation(() => createWindowMock());
  });

  it("keeps the pet window out of the OS taskbar", async () => {
    const { createPetWindow } = loadWindowsModule();

    await createPetWindow();

    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ skipTaskbar: true }));
  });

  it("sizes the pet window from the saved display scale", async () => {
    const { createPetWindow } = loadWindowsModule();

    await createPetWindow({ display: { scale: 1.5 } });

    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      width: 480,
      height: 480
    }));
  });

  it("widens the pet window for a studio pack's 16:9 canvas instead of letterboxing it", async () => {
    const { createPetWindow, getPetWindowDimensions } = loadWindowsModule();

    await createPetWindow({ display: { scale: 1.5 }, mediaAspect: 854 / 480 });

    // 232 * (854/480) + 88 = 500.8 per unit scale -> 751 at 150%; height stays 480.
    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ width: 751, height: 480 }));
    expect(getPetWindowDimensions({ scale: 1 }, 1)).toEqual({ width: 320, height: 320 });
    expect(getPetWindowDimensions({ scale: 1 }, 0.75)).toEqual({ width: 320, height: 320 });
  });

  it("passes the package version to sandboxed preloads", async () => {
    const { createPanelWindow, createPetWindow } = loadWindowsModule();

    await createPetWindow();
    await createPanelWindow({ show: false });

    for (const [options] of BrowserWindow.mock.calls) {
      expect(options.webPreferences.additionalArguments).toEqual([
        "--desktop-pet-version=0.1.1"
      ]);
    }
    expect(appMock.getVersion).toHaveBeenCalledTimes(2);
  });

  it("keeps the Windows panel out of the taskbar while preserving macOS window behavior", async () => {
    const { createPanelWindow } = loadWindowsModule();
    const originalPlatform = process.platform;

    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      await createPanelWindow({ show: false });
      expect(BrowserWindow).toHaveBeenLastCalledWith(expect.objectContaining({ skipTaskbar: true }));

      Object.defineProperty(process, "platform", { value: "darwin" });
      await createPanelWindow({ show: false });
      expect(BrowserWindow).toHaveBeenLastCalledWith(expect.objectContaining({ skipTaskbar: false }));
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
