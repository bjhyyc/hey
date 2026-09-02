const fs = require("node:fs");
const path = require("node:path");
const { app, dialog, Menu, shell } = require("electron");
const { registerIpc } = require("./ipc");
const { createDesktopPetMenu, createMenuActions } = require("./menu");
const { createConfigStore } = require("./services/config-store");
const { configureLogger, createLogger, shutdownLogger } = require("./services/logger");
const { importPetpack } = require("./services/petpack");
const { createTray } = require("./tray");
const { createPanelWindow, createPetWindow, getWindows } = require("./windows");
const { createGlobalMouseTracker } = require("./global-mouse-tracker");
const { getOnboardingVersion, shouldShowOnboarding } = require("./onboarding");

let configStore;
let menuActions;
let globalMouseTracker;
let trayController;
let userDataDir;

const BUNDLED_SAMPLE_PACKAGE_ID = "default-pet";
const logger = createLogger("main");

function getPetWindow() {
  const { pet } = getWindows();
  return pet && !pet.isDestroyed() ? pet : null;
}

function getPanelWindow() {
  const { panel } = getWindows();
  return panel && !panel.isDestroyed() ? panel : null;
}

function notifyPackageChanged(payload) {
  const panelWindow = getPanelWindow();
  if (panelWindow && panelWindow.webContents) {
    panelWindow.webContents.send("package:changed", payload);
  }
}

async function importPetpackFromDialog() {
  const panelWindow = getPanelWindow();
  const dialogOptions = {
    properties: ["openFile"],
    filters: [
      { name: "Petpacks", extensions: ["petpack", "zip"] }
    ]
  };
  const result = panelWindow
    ? await dialog.showOpenDialog(panelWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return null;
  }

  const imported = await importPetpack(result.filePaths[0], userDataDir);
  if (imported && imported.ok && imported.packageId) {
    const config = configStore.load();
    configStore.save({
      ...config,
      currentPackageId: imported.packageId
    });
    notifyPackageChanged({ packageId: imported.packageId, reason: "import" });
  }

  return imported;
}

function refreshMenus() {
  if (trayController) {
    trayController.refresh();
  }
}

function createNativeMenu() {
  return createDesktopPetMenu({
    Menu,
    configStore,
    getWindows,
    actions: menuActions
  });
}

function openContextMenu() {
  const petWindow = getPetWindow();
  if (!petWindow) return;

  createNativeMenu().popup({ window: petWindow });
}

function hideDockIcon() {
  if (process.platform !== "darwin" || !app.dock || typeof app.dock.hide !== "function") {
    return;
  }

  app.dock.hide();
}

/**
 * Whether the customer has imported at least one pack of their own. The
 * bundled sample does not count: it lives in the app resources, not here.
 */
function hasImportedPackage(userDataPath) {
  try {
    const packagesDir = path.join(userDataPath, "packages");
    return fs.readdirSync(packagesDir, { withFileTypes: true })
      // The bundled sample gets materialised here the moment anything edits it,
      // so its presence says nothing about whether the customer has a pack.
      .some((entry) => entry.isDirectory() && entry.name !== BUNDLED_SAMPLE_PACKAGE_ID);
  } catch {
    return false;
  }
}

async function boot() {
  userDataDir = app.getPath("userData");
  configStore = createConfigStore(userDataDir);
  const bootConfig = configStore.load();
  const showOnboarding = shouldShowOnboarding(bootConfig);
  configureLogger({
    userDataDir,
    enabled: bootConfig.system?.logging?.enabled !== false,
    level: bootConfig.system?.logging?.level
  });
  logger.info("Application boot started", {
    onboardingVersion: getOnboardingVersion(bootConfig),
    showOnboarding
  });
  menuActions = createMenuActions({
    app,
    shell,
    configStore,
    getWindows,
    createPanelWindow,
    importPetpack: importPetpackFromDialog,
    userDataDir,
    refreshMenus
  });

  registerIpc({ getWindows, createPanelWindow, createPetWindow, configStore, openContextMenu });
  // Nothing is more off-key on first run than a stranger's cartoon pet sitting
  // on the desktop. Until the customer imports their own pack there is no pet
  // to show, so the app opens on the panel - the import screen - instead.
  const ownsPack = hasImportedPackage(userDataDir);
  if (ownsPack) {
    await createPetWindow({ display: configStore.load().display });
  }
  await createPanelWindow({ show: showOnboarding || !ownsPack });
  globalMouseTracker = createGlobalMouseTracker({ getPetWindow });
  globalMouseTracker.start();
  trayController = createTray({
    createMenu: createNativeMenu
  });
  hideDockIcon();
  logger.info("Application boot completed");
}

app.whenReady().then(boot).catch((error) => {
  logger.error("Application boot failed", error);
});

app.on("activate", async () => {
  const { pet } = getWindows();

  if (!pet || pet.isDestroyed()) {
    logger.info("Recreating pet window after activate");
    await createPetWindow();
    refreshMenus();
  }
});

app.on("before-quit", () => {
  logger.info("Application is quitting");
  if (globalMouseTracker) {
    globalMouseTracker.stop();
  }
  if (trayController) {
    trayController.destroy();
  }
  shutdownLogger();
});
