const path = require("path");
const { app, BrowserWindow } = require("electron");
const { createLogger } = require("./services/logger");
const { computePetWindowSize } = require("../shared/pet-layout");

let petWindow;
let panelWindow;
const logger = createLogger("windows");
const PET_BASE_WINDOW_SIZE = 320;
const APP_VERSION_ARGUMENT_PREFIX = "--desktop-pet-version=";

function appVersionArgument() {
  return `${APP_VERSION_ARGUMENT_PREFIX}${app.getVersion()}`;
}

function rendererPath(name) {
  if (app.isPackaged) {
    return path.join(__dirname, "..", "..", "dist", "renderer", name, `${name}.html`);
  }

  return path.join(__dirname, "..", "renderer", name, `${name}.html`);
}

function attachDebugConsole(window, label) {
  if (!window || process.env.DESKTOP_PET_DEBUG_RULES !== "1") return;
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logger.debug(`renderer:${label}:console:${level}`, message, `${sourceId}:${line}`);
  });
}

function getDisplayScale(display = {}) {
  const scale = Number(display && display.scale);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function getPetWindowSize(display = {}) {
  return Math.max(1, Math.round(PET_BASE_WINDOW_SIZE * getDisplayScale(display)));
}

// The window follows the media it shows: square for the classic square
// sprites, wider for a studio pack's 854x480 canvas. The renderer reports the
// aspect once the media's metadata is known; until then the window is square.
function getPetWindowDimensions(display = {}, mediaAspect = 1) {
  return computePetWindowSize({ scale: getDisplayScale(display), aspect: mediaAspect });
}

async function createPetWindow({ display = {}, mediaAspect = 1 } = {}) {
  const size = getPetWindowDimensions(display, mediaAspect);
  logger.info("Creating pet window", { scale: display.scale, mediaAspect, size });
  petWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // macOS spends a click on activating an unfocused window, so the pet's
    // first right-click was swallowed and waking it appeared to need a double
    // right-click. The pet is an always-on-top companion that is clicked
    // without "entering" it first, so it takes the first mouse event.
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "pet-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [appVersionArgument()]
    }
  });

  attachDebugConsole(petWindow, "pet");

  petWindow.on("closed", () => {
    logger.info("Pet window closed");
    petWindow = null;
  });

  await petWindow.loadFile(rendererPath("pet"));
  logger.info("Pet window loaded");
  return petWindow;
}

async function createPanelWindow({ show = true } = {}) {
  logger.info("Creating panel window", { show });
  panelWindow = new BrowserWindow({
    width: 960,
    height: 680,
    show,
    skipTaskbar: process.platform === "win32",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "panel-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [appVersionArgument()]
    }
  });

  panelWindow.on("closed", () => {
    logger.info("Panel window closed");
    panelWindow = null;
  });

  await panelWindow.loadFile(rendererPath("panel"));
  logger.info("Panel window loaded");
  return panelWindow;
}

function getWindows() {
  return { pet: petWindow, panel: panelWindow };
}

module.exports = { createPetWindow, createPanelWindow, getWindows, getPetWindowDimensions, getPetWindowSize };
