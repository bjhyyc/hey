const { contextBridge, ipcRenderer, webUtils } = require("electron");

const VERSION_ARGUMENT_PREFIX = "--desktop-pet-version=";
const versionArgument = process.argv.find((argument) => argument.startsWith(VERSION_ARGUMENT_PREFIX));
const version = versionArgument ? versionArgument.slice(VERSION_ARGUMENT_PREFIX.length) : "";

contextBridge.exposeInMainWorld("desktopPetPanel", {
  version,
  config: {
    load: () => ipcRenderer.invoke("config:load"),
    save: (config) => ipcRenderer.invoke("config:save", config)
  },
  assets: {
    list: (packageId) => ipcRenderer.invoke("asset:list", packageId),
    pick: () => ipcRenderer.invoke("asset:pick"),
    import: (sourcePath, packageId, importName, operationId) => ipcRenderer.invoke("asset:import", { sourcePath, packageId, importName, operationId }),
    replace: (sourcePath, packageId, targetAssetPath, operationId) => ipcRenderer.invoke("asset:replace", { sourcePath, packageId, targetAssetPath, operationId }),
    bakeGreenScreen: (packageId, sourceAssetPath, params, operationId) => ipcRenderer.invoke("asset:bake-green-screen", {
      packageId,
      sourceAssetPath,
      color: params && params.color,
      tolerance: params && params.tolerance,
      softness: params && params.softness,
      operationId
    }),
    onProgress: (callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("asset:progress", listener);
      return () => ipcRenderer.removeListener("asset:progress", listener);
    },
    getDroppedFilePath: (file) => {
      if (!file) return "";
      let filePath = "";
      if (webUtils && typeof webUtils.getPathForFile === "function") {
        filePath = webUtils.getPathForFile(file);
      } else {
        filePath = typeof file.path === "string" ? file.path : "";
      }
      if (filePath) ipcRenderer.send("asset:approve-dropped", filePath);
      return filePath;
    },
    delete: (assetPath, packageId) => ipcRenderer.invoke("asset:delete", { assetPath, packageId })
  },
  packages: {
    create: (packageId) => ipcRenderer.invoke("package:create", packageId),
    delete: (packageId) => ipcRenderer.invoke("package:delete", packageId),
    list: () => ipcRenderer.invoke("package:list"),
    switch: (packageId) => ipcRenderer.invoke("package:switch", packageId)
  },
  petpack: {
    import: () => ipcRenderer.invoke("petpack:import"),
    export: (packageId) => ipcRenderer.invoke("petpack:export", packageId),
    installSample: () => ipcRenderer.invoke("petpack:install-sample")
  },
  rules: {
    import: (payload) => ipcRenderer.invoke("rules:import", payload),
    export: (payload) => ipcRenderer.invoke("rules:export", payload)
  },
  events: {
    onPackageChanged: (callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("package:changed", listener);
      return () => ipcRenderer.removeListener("package:changed", listener);
    }
  },
  logs: {
    write: (level, scope, message, data) => ipcRenderer.send("log:write", { level, scope, message, data })
  },
  pet: {
    applyDisplay: (display) => ipcRenderer.invoke("pet:apply-display", display),
    resetPosition: (position) => ipcRenderer.invoke("pet:reset-position", position),
    setMousePassthrough: (enabled) => ipcRenderer.invoke("pet:set-mouse-passthrough", enabled),
    setAlwaysOnTop: (enabled) => ipcRenderer.invoke("pet:set-always-on-top", enabled)
  },
  system: {
    getLaunchAtLogin: () => ipcRenderer.invoke("system:get-launch-at-login"),
    setLaunchAtLogin: (enabled) => ipcRenderer.invoke("system:set-launch-at-login", enabled),
    about: {
      getInfo: () => ipcRenderer.invoke("system:about:get-info"),
      openLink: (target) => ipcRenderer.invoke("system:about:open-link", target),
      checkForUpdates: () => ipcRenderer.invoke("system:about:check-updates")
    },
    logs: {
      getSettings: () => ipcRenderer.invoke("system:logs:get-settings"),
      list: () => ipcRenderer.invoke("system:logs:list"),
      read: (fileName, maxBytes) => ipcRenderer.invoke("system:logs:read", { fileName, maxBytes }),
      clear: () => ipcRenderer.invoke("system:logs:clear"),
      openDirectory: () => ipcRenderer.invoke("system:logs:open-directory")
    }
  },
  app: {
    quit: () => ipcRenderer.invoke("app:quit")
  },
  petState: {
    getRuntimeState: () => ipcRenderer.invoke("pet:get-runtime-state"),
    onRuntimeStateUpdated: (callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("pet:runtime-state-updated", listener);
      return () => ipcRenderer.removeListener("pet:runtime-state-updated", listener);
    }
  }
});
