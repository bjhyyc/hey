const { DEFAULT_CONFIG } = require("../shared/defaults");

const SCALE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5];
const OPACITY_OPTIONS = [0.5, 0.75, 0.9, 1];
const PET_BASE_WINDOW_SIZE = 320;

function noop() {}

function getDisplay(config) {
  return {
    ...DEFAULT_CONFIG.display,
    ...((config && config.display) || {})
  };
}

function call(actions, name, ...args) {
  const action = actions && actions[name];
  if (typeof action === "function") {
    return action(...args);
  }

  return undefined;
}

function sendToPetWindow(petWindow, channel, ...args) {
  const webContents = petWindow && petWindow.webContents;
  if (
    !webContents ||
    (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) ||
    (typeof webContents.isCrashed === "function" && webContents.isCrashed()) ||
    typeof webContents.send !== "function"
  ) {
    return false;
  }

  try {
    webContents.send(channel, ...args);
    return true;
  } catch (_error) {
    return false;
  }
}

function resizePetWindowForScale(petWindow, scale) {
  if (!petWindow || typeof petWindow.getBounds !== "function" || typeof petWindow.setBounds !== "function") return;
  const numericScale = Number(scale);
  if (!Number.isFinite(numericScale) || numericScale <= 0) return;

  const currentBounds = petWindow.getBounds();
  const size = Math.max(1, Math.round(PET_BASE_WINDOW_SIZE * numericScale));
  if (currentBounds.width === size && currentBounds.height === size) return;

  const centerX = currentBounds.x + currentBounds.width / 2;
  const centerY = currentBounds.y + currentBounds.height / 2;
  petWindow.setBounds({
    x: Math.round(centerX - size / 2),
    y: Math.round(centerY - size / 2),
    width: size,
    height: size
  });
}

function buildDesktopPetMenuTemplate({
  config = DEFAULT_CONFIG,
  petVisible = true,
  interactionsPaused = false,
  actions = {}
} = {}) {
  const display = getDisplay(config);
  const currentPackageId = config.currentPackageId || DEFAULT_CONFIG.currentPackageId;

  return [
    { label: "打开控制面板", click: () => call(actions, "openPanel") },
    {
      label: "素材包",
      submenu: [
        { label: `当前素材包：${currentPackageId}`, enabled: false },
        { label: "导入素材包", click: () => call(actions, "importPetpack") }
      ]
    },
    { type: "separator" },
    {
      label: "显示桌宠",
      type: "checkbox",
      checked: Boolean(petVisible),
      click: () => call(actions, "setPetVisible", !petVisible)
    },
    {
      label: "锁定拖拽",
      type: "checkbox",
      checked: Boolean(display.locked),
      click: () => call(actions, "setDisplayFlag", "locked", !display.locked)
    },
    {
      label: "鼠标穿透",
      type: "checkbox",
      checked: Boolean(display.mousePassthrough),
      click: () => call(actions, "setDisplayFlag", "mousePassthrough", !display.mousePassthrough)
    },
    {
      label: "置顶显示",
      type: "checkbox",
      checked: Boolean(display.alwaysOnTop),
      click: () => call(actions, "setDisplayFlag", "alwaysOnTop", !display.alwaysOnTop)
    },
    {
      label: "暂停交互",
      type: "checkbox",
      checked: Boolean(interactionsPaused),
      click: () => call(actions, "setInteractionsPaused", !interactionsPaused)
    },
    {
      label: "缩放",
      submenu: SCALE_OPTIONS.map((scale) => ({
        label: `${Math.round(scale * 100)}%`,
        type: "radio",
        checked: Math.abs(display.scale - scale) < 0.001,
        click: () => call(actions, "setDisplayFlag", "scale", scale)
      }))
    },
    {
      label: "不透明度",
      submenu: OPACITY_OPTIONS.map((opacity) => ({
        label: `${Math.round(opacity * 100)}%`,
        type: "radio",
        checked: Math.abs(display.opacity - opacity) < 0.001,
        click: () => call(actions, "setDisplayFlag", "opacity", opacity)
      }))
    },
    { label: "重置位置", click: () => call(actions, "resetPosition") },
    { type: "separator" },
    { label: "查看日志", click: () => call(actions, "viewLogs") },
    { label: "关于", click: () => call(actions, "showAbout") },
    { type: "separator" },
    { label: "退出", click: () => call(actions, "quit") }
  ].map((item) => {
    if (!item.click && !item.submenu && item.type !== "separator") {
      return { ...item, click: noop };
    }

    return item;
  });
}

function createMenuActions({
  app,
  shell,
  configStore,
  getWindows,
  createPanelWindow,
  importPetpack,
  userDataDir,
  refreshMenus = noop
}) {
  function getPetWindow() {
    const { pet } = getWindows();
    return pet && !pet.isDestroyed() ? pet : null;
  }

  function getPanelWindow() {
    const { panel } = getWindows();
    return panel && !panel.isDestroyed() ? panel : null;
  }

  function loadConfig() {
    return configStore.load();
  }

  function saveDisplayFlag(key, value) {
    const config = loadConfig();
    const display = {
      ...getDisplay(config),
      [key]: value
    };
    const savedConfig = configStore.save({ ...config, display });
    const petWindow = getPetWindow();

    if (petWindow) {
      if (key === "alwaysOnTop") {
        petWindow.setAlwaysOnTop(Boolean(value));
      }
      if (key === "mousePassthrough") {
        petWindow.setIgnoreMouseEvents(Boolean(value), { forward: true });
      }
      if (key === "opacity") {
        petWindow.setOpacity(Number(value));
      }
      if (key === "scale") {
        resizePetWindowForScale(petWindow, value);
      }
      sendToPetWindow(petWindow, "pet:display-updated", display);
    }

    refreshMenus();
    return savedConfig;
  }

  return {
    async openPanel() {
      const panelWindow = getPanelWindow() || await createPanelWindow({ show: true });
      panelWindow.show();
      panelWindow.focus();
    },
    async importPetpack() {
      if (typeof importPetpack !== "function") return;
      await importPetpack();
      refreshMenus();
    },
    setPetVisible(visible) {
      const petWindow = getPetWindow();
      if (!petWindow) return;
      if (visible) {
        petWindow.show();
      } else {
        petWindow.hide();
      }
      refreshMenus();
    },
    setDisplayFlag: saveDisplayFlag,
    setInteractionsPaused(enabled) {
      const config = loadConfig();
      configStore.save({
        ...config,
        system: {
          ...DEFAULT_CONFIG.system,
          ...(config.system || {}),
          interactionsPaused: Boolean(enabled)
        }
      });
      const petWindow = getPetWindow();
      if (petWindow) {
        sendToPetWindow(petWindow, "pet:interactions-paused", Boolean(enabled));
      }
      refreshMenus();
    },
    resetPosition() {
      const config = loadConfig();
      const nextDisplay = {
        ...getDisplay(config),
        x: DEFAULT_CONFIG.display.x,
        y: DEFAULT_CONFIG.display.y
      };
      configStore.save({ ...config, display: nextDisplay });

      const petWindow = getPetWindow();
      if (petWindow) {
        const bounds = petWindow.getBounds();
        petWindow.setBounds({
          ...bounds,
          x: DEFAULT_CONFIG.display.x,
          y: DEFAULT_CONFIG.display.y
        });
      }
      refreshMenus();
    },
    viewLogs() {
      if (shell && typeof shell.openPath === "function") {
        shell.openPath(userDataDir);
      }
    },
    showAbout() {
      if (app && typeof app.showAboutPanel === "function") {
        app.showAboutPanel();
      }
    },
    quit() {
      app.quit();
    }
  };
}

function createDesktopPetMenu({ Menu, configStore, getWindows, actions }) {
  const { pet } = getWindows();
  const config = configStore.load();
  const system = {
    ...DEFAULT_CONFIG.system,
    ...(config.system || {})
  };
  const template = buildDesktopPetMenuTemplate({
    config,
    petVisible: !pet || pet.isDestroyed() ? false : pet.isVisible(),
    interactionsPaused: Boolean(system.interactionsPaused),
    actions
  });

  return Menu.buildFromTemplate(template);
}

module.exports = {
  buildDesktopPetMenuTemplate,
  createDesktopPetMenu,
  createMenuActions
};
