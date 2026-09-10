const path = require("path");
const { nativeImage, Tray } = require("electron");
const { createLogger } = require("./services/logger");

const MACOS_TRAY_ICON_SIZE = 22;
const TRAY_ICON_DATA_URL = "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='18'%20height='18'%20viewBox='0%200%2018%2018'%3E%3Cpath%20fill='black'%20d='M9%202c3.3%200%206%202.5%206%205.7%200%203.9-2.6%207.3-6%207.3s-6-3.4-6-7.3C3%204.5%205.7%202%209%202Zm-2.3%205.8c.6%200%201-.5%201-1.1s-.4-1.1-1-1.1-1%20.5-1%201.1.4%201.1%201%201.1Zm4.6%200c.6%200%201-.5%201-1.1s-.4-1.1-1-1.1-1%20.5-1%201.1.4%201.1%201%201.1ZM6.6%2010c.6%201%201.4%201.5%202.4%201.5s1.8-.5%202.4-1.5H6.6Z'/%3E%3C/svg%3E";

let tray = null;
const logger = createLogger("tray");

function getTrayIconPath() {
  return path.join(__dirname, "..", "assets", "tray", "tray-iconTemplate.png");
}

function normalizeTrayIcon(icon) {
  if (process.platform !== "darwin" || !icon || typeof icon.resize !== "function") {
    return icon;
  }

  const resizedIcon = icon.resize({ width: MACOS_TRAY_ICON_SIZE, height: MACOS_TRAY_ICON_SIZE });
  return resizedIcon && !resizedIcon.isEmpty() ? resizedIcon : icon;
}

function createTrayIcon() {
  const iconPath = getTrayIconPath();
  const fileIcon = typeof nativeImage.createFromPath === "function"
    ? nativeImage.createFromPath(iconPath)
    : null;

  if (fileIcon && !fileIcon.isEmpty()) {
    logger.info("Tray icon loaded", {
      iconPath,
      source: "file",
      template: process.platform === "darwin"
    });
    return normalizeTrayIcon(fileIcon);
  }

  logger.warn("Tray icon file missing or empty, using fallback", {
    iconPath,
    template: process.platform === "darwin"
  });
  return normalizeTrayIcon(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
}

function logTrayFailure(action, error) {
  logger.warn(`Failed to ${action} tray`, error);
}

function createTray({ createMenu, onOpenPanel } = {}) {
  let localTray = null;
  try {
    const icon = createTrayIcon();
    if (icon.isEmpty()) {
      return null;
    }

    icon.setTemplateImage(process.platform === "darwin");
    localTray = new Tray(icon);
    localTray.setToolTip("Hey");
    logger.info("Tray created");
  } catch (error) {
    logTrayFailure("create", error);
    tray = null;
    return null;
  }

  tray = localTray;
  let destroyed = false;

  function refresh() {
    if (!tray || destroyed) return;
    try {
      tray.setContextMenu(createMenu());
    } catch (error) {
      logTrayFailure("refresh", error);
    }
  }

  function openMenu() {
    refresh();
    if (tray && !destroyed && typeof tray.popUpContextMenu === "function") {
      tray.popUpContextMenu();
    }
  }

  try {
    // A left click is the shortest path back to the control panel - the place
    // people go to import a pack or resize the pet. The menu stays one right
    // click away, which is where Windows users look for it anyway.
    tray.on("click", () => {
      if (typeof onOpenPanel === "function") {
        try {
          onOpenPanel();
          return;
        } catch (error) {
          logTrayFailure("open the panel from", error);
        }
      }
      openMenu();
    });
    tray.on("right-click", openMenu);
  } catch (error) {
    logTrayFailure("create", error);
    tray = null;
    return null;
  }

  refresh();

  return {
    refresh,
    destroy() {
      try {
        if (tray && !destroyed) {
          tray.destroy();
          logger.info("Tray destroyed");
        }
      } catch (error) {
        logTrayFailure("destroy", error);
      } finally {
        destroyed = true;
        tray = null;
      }
    }
  };
}

module.exports = { createTray };
