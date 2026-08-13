import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getLaunchAtLogin, setLaunchAtLogin } = require("../../src/main/startup");

describe("startup helpers", () => {
  it("reads launch-at-login state from Electron app settings", () => {
    const app = {
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: true }))
    };

    expect(getLaunchAtLogin(app)).toBe(true);
    expect(app.getLoginItemSettings).toHaveBeenCalledOnce();
  });

  it("writes launch-at-login state through Electron app settings", () => {
    const app = {
      setLoginItemSettings: vi.fn()
    };

    setLaunchAtLogin(app, true);
    setLaunchAtLogin(app, false);

    expect(app.setLoginItemSettings).toHaveBeenNthCalledWith(1, { openAtLogin: true });
    expect(app.setLoginItemSettings).toHaveBeenNthCalledWith(2, { openAtLogin: false });
  });
});
