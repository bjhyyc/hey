/**
 * Desktop Pet Control Panel
 * Main entry point and orchestration
 */

import { t, setLocale, initLocale } from "../../shared/i18n.js";
import { createRendererLogger } from "../shared/logger.js";
import { state } from "./state.js";
import { normalizeKeyframes } from "./panel-state.js";
import { initBanner, showBanner, hideBanner } from "./ui/banner.js";
import { renderTabs } from "./ui/tabs.js";
import { renderOverview, updateRuntimeStatus } from "./tabs/overview.js";
import { renderAssets } from "./tabs/assets.js";
import { renderAnimations } from "./tabs/animations.js";
import { renderRules } from "./tabs/rules.js";
import { renderDisplay } from "./tabs/display.js";
import { renderSystem } from "./tabs/system.js";
import { handleFormSubmit } from "./handlers/form-handlers.js";
import {
  handleTabClick,
  handleInput,
  handleChange,
  handleClickAction,
  handleInlineActionDragStart,
  handleInlineActionDragOver,
  handleInlineActionDrop,
  handleInlineActionDragEnd
} from "./handlers/event-handlers.js";
import { importAssetFromForm, replaceSelectedPackageAssetFromDrop, selectAssetFromDrop } from "./handlers/asset-handlers.js";
import { createGreenScreenRenderer } from "../pet/green-screen-renderer.js";

// Initialize locale from config or browser
initLocale();

const logger = createRendererLogger("panel");

// API and DOM references
const api = window.desktopPetPanel;
const tabsEl = document.querySelector("#tabs");
const rootEl = document.querySelector("#panel-root");
const bannerEl = document.querySelector("#banner");
const versionEl = document.querySelector("#panel-version");

// Initialize banner
initBanner(bannerEl);

// Set version
versionEl.textContent = api && api.version ? `v${api.version}` : "preload unavailable";

// Runtime state management
let pollingInterval = null;
let currentRuntimeState = null;

/**
 * Fetch and update runtime state
 */
async function fetchRuntimeState() {
  if (!api || !api.petState || !api.petState.getRuntimeState) {
    return;
  }

  try {
    const result = await api.petState.getRuntimeState();
    if (result && result.ok && result.state) {
      currentRuntimeState = result.state;
      if (state.activeTab === "overview") {
        updateRuntimeStatus(currentRuntimeState, state.config);
      }
    }
  } catch (error) {
    logger.error("Failed to fetch runtime state", error);
  }
}

/**
 * Start polling runtime state
 */
function startRuntimePolling() {
  if (pollingInterval) return;

  // Initial fetch
  fetchRuntimeState();

  // Poll every 2 seconds
  pollingInterval = setInterval(() => {
    fetchRuntimeState();
  }, 2000);
}

/**
 * Stop polling runtime state
 */
function stopRuntimePolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

/**
 * Handle runtime state updates from pet
 */
function handleRuntimeStateUpdate(state) {
  currentRuntimeState = state;
  if (state.activeTab === "overview") {
    updateRuntimeStatus(currentRuntimeState, state.config);
  }
}

// Subscribe to runtime state updates
if (api && api.petState && api.petState.onRuntimeStateUpdated) {
  api.petState.onRuntimeStateUpdated(handleRuntimeStateUpdate);
}

if (api && api.assets && api.assets.onProgress) {
  api.assets.onProgress((progress) => {
    if (!progress || !state.assetProgress || progress.operationId !== state.assetProgress.operationId) return;
    state.assetProgress = {
      ...state.assetProgress,
      ...progress
    };
    // Green-screen baking shows an indeterminate progress bar inside the
    // animations form. ffmpeg's percent is unreliable for VP9 (it jumps 0→100
    // at the end), and re-rendering the whole panel per tick makes the UI
    // flicker — so just swallow bake ticks here; the inline bar animates on its
    // own and the final render() happens when baking resolves.
    if (state.assetProgress.stage === "baking" && rootEl.querySelector('[data-role="bake-progress"]')) {
      return;
    }
    render();
  });
}

/**
 * Load configuration from API
 * @returns {Promise<void>}
 */
async function loadConfig() {
  if (!api || !api.config || !api.config.load) {
    showBanner(t("message.panelPreloadUnavailable"));
    return;
  }

  try {
    state.config = await api.config.load();
    await refreshPackagesAndAssets();

    // Initialize locale from config
    if (state.config.system?.language) {
      setLocale(state.config.system.language);
    }

    // Update page title
    const titleEl = document.querySelector("#page-title");
    if (titleEl) {
      titleEl.textContent = t("panel.title");
    }

    if (api.system && api.system.getLaunchAtLogin) {
      state.systemLaunchAtLogin = await api.system.getLaunchAtLogin();
    } else {
      state.systemLaunchAtLogin = Boolean(state.config.system && state.config.system.launchAtLogin);
    }
    if (api.system?.about?.getInfo) {
      try {
        const aboutInfo = await api.system.about.getInfo();
        state.aboutInfo = aboutInfo && aboutInfo.ok !== false ? aboutInfo : null;
      } catch (error) {
        logger.warn("Could not load application information", { error: error.message || String(error) });
        state.aboutInfo = null;
      }
    }
    hideBanner();
  } catch (error) {
    logger.error("Could not load config", error);
    showBanner(t("message.loadConfigFailed", { reason: error.message || error }));
  } finally {
    render();
  }
}

async function refreshPackagesAndAssets() {
  if (!api || !state.config) return;
  const packageId = state.config.currentPackageId || "default-pet";
  if (api.packages && api.packages.list) {
    const result = await api.packages.list();
    state.packageList = result && result.ok ? result.packages : [];
  }
  if (api.assets && api.assets.list) {
    const result = await api.assets.list(packageId);
    state.packageAssets = result && result.ok ? result.assets : [];
    if (!state.selectedPackageAsset || !state.packageAssets.some((asset) => asset.asset === state.selectedPackageAsset)) {
      state.selectedPackageAsset = state.packageAssets[0]?.asset || "";
    }
  }
}

async function refreshLogs({ preserveSelection = true } = {}) {
  if (!api || !api.system || !api.system.logs) return;

  state.logLoading = true;
  if (state.activeTab === "system") render();

  try {
    const [settings, listResult] = await Promise.all([
      api.system.logs.getSettings ? api.system.logs.getSettings() : null,
      api.system.logs.list ? api.system.logs.list() : null
    ]);
    state.logSettings = settings || null;
    state.logFiles = listResult && listResult.ok && Array.isArray(listResult.files)
      ? listResult.files
      : [];

    const currentSelection = preserveSelection ? state.selectedLogFile : "";
    state.selectedLogFile = currentSelection && state.logFiles.some((file) => file.name === currentSelection)
      ? currentSelection
      : (state.logFiles[0]?.name || "");

    if (state.selectedLogFile && api.system.logs.read) {
      const readResult = await api.system.logs.read(state.selectedLogFile, 256 * 1024);
      if (readResult && readResult.ok) {
        state.logContent = readResult.content || "";
        state.logTruncated = Boolean(readResult.truncated);
      } else {
        state.logContent = readResult?.error || t("system.logs.readFailed");
        state.logTruncated = false;
      }
    } else {
      state.logContent = "";
      state.logTruncated = false;
    }
  } catch (error) {
    state.logContent = t("system.logs.refreshFailed", { reason: error.message || error });
    state.logTruncated = false;
  } finally {
    state.logLoading = false;
    if (state.activeTab === "system") render();
  }
}

async function refreshAfterPackageChange(payload = {}) {
  if (!api || !api.config || !api.config.load) return;

  try {
    if (payload.packageId && api.packages && api.packages.switch) {
      const nextConfig = await api.packages.switch(payload.packageId);
      if (nextConfig && nextConfig.ok === false) {
        showBanner(nextConfig.error || t("assets.package.switchFailed"));
        return;
      }
      state.config = nextConfig;
    } else {
      state.config = await api.config.load();
    }
    await refreshPackagesAndAssets();
    render();
  } catch (error) {
    logger.error("Package refresh failed", error);
    showBanner(t("assets.package.refreshFailed", { reason: error.message || error }));
  }
}

/**
 * Save configuration via API
 * @param {object} nextConfig - Configuration to save
 * @param {string} key - Saving key for UI state
 * @param {object} options - Save options
 * @returns {Promise<object|null>} Saved config or null
 */
async function saveConfig(nextConfig, key, options = {}) {
  if (state.savingKey) return null;
  state.savingKey = key;

  try {
    const savedConfig = await api.config.save(nextConfig);
    state.config = savedConfig;
    state.savingKey = "";
    if (!options.silent) {
      showBanner(t("message.saved"), "success");
    }
    render();
    return savedConfig;
  } catch (error) {
    logger.error("Save failed", error);
    showBanner(t("message.saveFailedWithReason", { reason: error.message || error }));
    return null;
  } finally {
    if (state.savingKey === key) {
      state.savingKey = "";
    }
  }
}

/**
 * Render current view
 */
function render() {
  stopAnimationPreview();
  renderTabs(state.activeTab, tabsEl);
  document.body.classList.toggle(
    "panel-modal-open",
    Boolean(state.ruleEditorOpen || state.conditionHelpOpen || state.keyframeEditorOpen)
  );

  if (!state.config) {
    rootEl.innerHTML = `<div class="empty-state">${t("message.loadingConfiguration")}</div>`;
    return;
  }

  const views = {
    overview: () => renderOverview(state.config, currentRuntimeState, {
      onboardingJustCompleted: state.onboardingJustCompleted,
      savingKey: state.savingKey,
      // A studio pack brings its own interaction rules; the overview teaches
      // them right where the pack was just imported.
      studioPackage: (state.packageList || []).some((entry) => entry && entry.isCurrent && entry.studio === true)
    }),
    assets: () => renderAssets(state, state.config),
    animations: () => renderAnimations(state, state.config),
    rules: () => renderRules(state, state.config),
    display: () => renderDisplay(state, state.config),
    system: () => renderSystem(state, state.config)
  };

  rootEl.innerHTML = views[state.activeTab]();

  // Start/stop polling based on active tab
  if (state.activeTab === "overview") {
    startRuntimePolling();
  } else {
    stopRuntimePolling();
  }

  if (state.activeTab === "system" && !state.logLoading && state.logSettings === null) {
    refreshLogs();
  }

  if (state.activeTab === "animations") {
    startAnimationPreview();
  }
  // After rendering keyframe editor, scrub preview to the selected or first keyframe.
  if (state.keyframeEditorOpen) {
    const kfs = normalizeKeyframes(state.keyframeEditorKeyframes);
    const selectedIndex = state.keyframeEditorSelectedIndex;
    const previewIndex = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < kfs.length
      ? selectedIndex
      : 0;
    if (previewIndex < kfs.length) {
      scrubPreview(kfs[previewIndex].output);
    }
  }
}

function closeInactiveFieldHelpPopovers(target) {
  const activeHelp = target && target.closest ? target.closest(".field-help") : null;
  document.querySelectorAll(".field-help[open]").forEach((help) => {
    if (help !== activeHelp) {
      help.removeAttribute("open");
    }
  });
}

let draggedKeyframeIndex = null;
let animationPreviewFrameHandle = null;
let animationPreviewVideo = null;
let lastAnimationPreviewMode = "";
const greenScreenPreviewRenderers = new WeakMap();

function clampUnit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function parseHexColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || ""));
  if (!match) return null;
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
}

function getPreviewGreenScreen() {
  const greenScreen = state.keyframeEditorGreenScreen;
  if (!greenScreen || greenScreen.enabled !== true) return null;
  return {
    color: parseHexColor(greenScreen.color) || { r: 0, g: 255, b: 0 },
    tolerance: clampUnit(greenScreen.tolerance, 0.35),
    softness: clampUnit(greenScreen.softness, 0.08)
  };
}

function getAnimationPreviewGreenScreen() {
  const form = rootEl.querySelector("#animation-form");
  if (!form) return null;
  const hasEnabledToggle = Boolean(form.elements.greenScreenEnabled);
  const hasBakeIntentToggle = Boolean(form.elements.greenScreenBakeEnabled);
  return {
    enabled: hasEnabledToggle
      ? Boolean(form.elements.greenScreenEnabled?.checked)
      : (hasBakeIntentToggle ? Boolean(form.elements.greenScreenBakeEnabled?.checked) : false),
    color: parseHexColor(form.elements.greenScreenColor?.value) || { r: 0, g: 255, b: 0 },
    tolerance: clampUnit(Number(form.elements.greenScreenTolerance?.value) / 100, 0.35),
    softness: clampUnit(Number(form.elements.greenScreenSoftness?.value) / 100, 0.08)
  };
}

function getGreenScreenPreviewRenderer(canvas) {
  if (!canvas) return null;
  let renderer = greenScreenPreviewRenderers.get(canvas);
  if (!renderer) {
    renderer = createGreenScreenRenderer({
      canvas,
      container: canvas.parentElement,
      logger
    });
    if (renderer) greenScreenPreviewRenderers.set(canvas, renderer);
  }
  return renderer;
}

function drawGreenScreenPreviewFrame(video, canvas, greenScreen) {
  const renderer = getGreenScreenPreviewRenderer(canvas);
  if (!renderer || !greenScreen?.enabled) return false;
  renderer.draw(video, greenScreen);
  return true;
}

function requestPreviewVideoFrame(video, callback) {
  if (typeof video?.requestVideoFrameCallback === "function") {
    return { type: "video", id: video.requestVideoFrameCallback(callback) };
  }
  return { type: "animation", id: requestAnimationFrame(callback) };
}

function cancelPreviewVideoFrame(video, handle) {
  if (!handle) return;
  if (handle.type === "video" && typeof video?.cancelVideoFrameCallback === "function") {
    video.cancelVideoFrameCallback(handle.id);
    return;
  }
  cancelAnimationFrame(handle.id);
}

function stopAnimationPreview() {
  const video = animationPreviewVideo;
  cancelPreviewVideoFrame(animationPreviewVideo, animationPreviewFrameHandle);
  animationPreviewFrameHandle = null;
  animationPreviewVideo = null;
  if (typeof video?.pause === "function") video.pause();
}

function startAnimationPreview() {
  stopAnimationPreview();
  const video = rootEl.querySelector("#animation-preview-video");
  const canvas = rootEl.querySelector("#animation-preview-canvas");
  if (!video || !canvas) return;

  const greenScreen = getAnimationPreviewGreenScreen();
  // While a bake is running, the per-frame getImageData compositing competes
  // with ffmpeg for the main thread and makes the UI flicker. Show the raw
  // looping video instead of the keyed canvas until baking finishes.
  const greenScreenEnabled = Boolean(greenScreen && greenScreen.enabled) && state.savingKey !== "asset-bake";
  const previewMode = greenScreenEnabled ? "green-screen-canvas" : "raw-video";
  if (lastAnimationPreviewMode !== previewMode) {
    lastAnimationPreviewMode = previewMode;
    logger.debug("Animation preview mode changed", {
      mode: previewMode,
      greenScreenRequested: Boolean(greenScreen && greenScreen.enabled),
      savingKey: state.savingKey || ""
    });
  }

  // Without green screen, show the looping video element directly — no per-frame
  // compositing, no rAF loop, no getImageData churn.
  if (!greenScreenEnabled) {
    canvas.hidden = true;
    video.classList.remove("keyframe-preview-source");
    video.hidden = false;
    if (typeof video.play === "function") {
      video.play().catch(() => {});
    }
    return;
  }

  // Green screen enabled: keep the source video as the decode source and draw
  // only when Chromium reports a new video frame.
  video.classList.add("keyframe-preview-source");
  video.hidden = false;
  canvas.hidden = false;
  animationPreviewVideo = video;

  let warned = false;
  const draw = () => {
    animationPreviewFrameHandle = null;
    try {
      drawGreenScreenPreviewFrame(video, canvas, getAnimationPreviewGreenScreen());
    } catch (error) {
      if (!warned) {
        logger.warn("Animation green screen preview draw failed", { error: error.message || error });
        warned = true;
      }
    }
    animationPreviewFrameHandle = requestPreviewVideoFrame(video, draw);
  };

  const start = () => {
    if (typeof video.play === "function") {
      video.play().catch(() => {});
    }
    animationPreviewFrameHandle = requestPreviewVideoFrame(video, draw);
  };

  if (video.readyState >= 1) {
    start();
  } else {
    video.onloadedmetadata = start;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    logger.debug("Animation preview paused because panel is hidden");
    stopAnimationPreview();
  } else {
    startAnimationPreview();
  }
});

function getTrackProgress(clientX) {
  const track = rootEl.querySelector('[data-role="keyframe-track"]');
  if (!track) return 0;
  const rect = track.getBoundingClientRect();
  return rect.width > 0
    ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    : 0;
}

function scrubPreview(progress) {
  const video = rootEl.querySelector("#keyframe-preview-video");
  if (!video) return;

  const drawGreenScreenPreview = () => {
    const canvas = rootEl.querySelector("#keyframe-preview-green-screen");
    const greenScreen = getPreviewGreenScreen();
    if (!canvas || !greenScreen) return;

    try {
      drawGreenScreenPreviewFrame(video, canvas, greenScreen);
    } catch (error) {
      logger.warn("Green screen preview draw failed", { error: error.message || error });
    }
  };

  const seek = () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      const nextTime = Math.min(video.duration, Math.max(0, video.duration * progress));
      if (Math.abs(Number(video.currentTime || 0) - nextTime) < 0.001) {
        // Already at the target frame: no 'seeked' event will fire, so draw directly.
        requestAnimationFrame(drawGreenScreenPreview);
      } else {
        // One-shot listener so a stale closure from a prior scrub can't fire on a
        // later, unrelated seek and draw the wrong frame.
        video.addEventListener("seeked", () => {
          requestAnimationFrame(drawGreenScreenPreview);
        }, { once: true });
        video.currentTime = nextTime;
      }
    } else {
      requestAnimationFrame(drawGreenScreenPreview);
    }
  };

  if (video.readyState >= 1) {
    seek();
  } else {
    video.onloadedmetadata = seek;
  }
}

function updateDraggedKeyframe(clientX) {
  if (draggedKeyframeIndex === null) return;
  const keyframes = normalizeKeyframes(state.keyframeEditorKeyframes);
  if (draggedKeyframeIndex < 0 || draggedKeyframeIndex >= keyframes.length) return;

  const output = Math.round(getTrackProgress(clientX) * 100) / 100;
  const nextKeyframe = {
    ...keyframes[draggedKeyframeIndex],
    output
  };
  keyframes[draggedKeyframeIndex] = nextKeyframe;
  state.keyframeEditorKeyframes = keyframes;

  const left = `${Math.round(output * 100)}%`;
  const handle = rootEl.querySelector(`.keyframe-handle[data-keyframe-index="${draggedKeyframeIndex}"]`);
  const label = rootEl.querySelector(`.keyframe-label[data-keyframe-index="${draggedKeyframeIndex}"]`);
  if (handle) {
    handle.style.left = left;
    handle.dataset.keyframeOutput = String(output);
  }
  if (label) {
    label.style.left = left;
  }
  scrubPreview(output);
}

function stopDraggingKeyframe() {
  draggedKeyframeIndex = null;
  document.removeEventListener("pointermove", handleKeyframePointerMove);
  document.removeEventListener("pointerup", stopDraggingKeyframe);
}

function handleKeyframePointerMove(event) {
  updateDraggedKeyframe(event.clientX);
}

function handleKeyframeTrackClick(event) {
  if (event.target.closest && event.target.closest(".keyframe-handle")) return;
  const track = event.target.closest && event.target.closest("[data-role='keyframe-track']");
  if (!track) return;

  const input = Math.round(getTrackProgress(event.clientX) * 100) / 100;
  const keyframes = normalizeKeyframes(state.keyframeEditorKeyframes);
  if (keyframes.some((kf) => Math.abs(kf.input - input) < 0.005)) return;

  keyframes.push({ input, output: input });
  state.keyframeEditorKeyframes = normalizeKeyframes(keyframes);
  scrubPreview(input);
  render();
}

function handleKeyframeKeydown(event) {
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  if (state.keyframeEditorSelectedIndex === undefined || state.keyframeEditorSelectedIndex === null) return;
  if (!state.keyframeEditorOpen) return;

  const keyframes = normalizeKeyframes(state.keyframeEditorKeyframes);
  if (keyframes.length <= 1) return;

  event.preventDefault();
  keyframes.splice(state.keyframeEditorSelectedIndex, 1);
  state.keyframeEditorKeyframes = normalizeKeyframes(keyframes);
  state.keyframeEditorSelectedIndex = null;
  render();
}

// Event listeners
document.addEventListener("click", (event) => {
  closeInactiveFieldHelpPopovers(event.target);
});

tabsEl.addEventListener("click", (event) => handleTabClick(event, state, render));

rootEl.addEventListener("input", (event) => handleInput(event, state, render, api, startAnimationPreview));

rootEl.addEventListener("change", async (event) => {
  if (event.target.id === "log-file-select") {
    state.selectedLogFile = event.target.value;
    await refreshLogs({ preserveSelection: true });
    return;
  }
  await handleChange(event, state, api, render, saveConfig, startAnimationPreview);
});

rootEl.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest && event.target.closest(".keyframe-handle");
  if (!handle) return;

  const index = Number(handle.dataset.keyframeIndex);
  if (!Number.isInteger(index)) return;

  state.keyframeEditorSelectedIndex = index;
  draggedKeyframeIndex = index;
  event.preventDefault();
  rootEl.querySelectorAll(".keyframe-handle.selected, .keyframe-label.selected").forEach((element) => {
    element.classList.remove("selected");
  });
  handle.classList.add("selected");
  const label = rootEl.querySelector(`.keyframe-label[data-keyframe-index="${index}"]`);
  if (label) label.classList.add("selected");
  const keyframes = normalizeKeyframes(state.keyframeEditorKeyframes);
  if (index >= 0 && index < keyframes.length) {
    scrubPreview(keyframes[index].output);
  }
  document.addEventListener("pointermove", handleKeyframePointerMove);
  document.addEventListener("pointerup", stopDraggingKeyframe, { once: true });
});

rootEl.addEventListener("click", handleKeyframeTrackClick);
document.addEventListener("keydown", (event) => {
  if (state.keyframeEditorOpen) handleKeyframeKeydown(event);
});

rootEl.addEventListener("click", async (event) => {
  await handleClickAction(event, state, api, saveConfig, render, refreshPackagesAndAssets, refreshLogs);
});

rootEl.addEventListener("dragstart", (event) => {
  handleInlineActionDragStart(event);
});

rootEl.addEventListener("dragover", (event) => {
  if (handleInlineActionDragOver(event)) return;
  const dropTarget = event.target.closest && event.target.closest('[data-drop-target="replace-package-asset"], [data-drop-target="import-asset"]');
  if (!dropTarget) return;
  event.preventDefault();
  dropTarget.classList.add("drag-over");
});

rootEl.addEventListener("dragleave", (event) => {
  const dropTarget = event.target.closest && event.target.closest('[data-drop-target="replace-package-asset"], [data-drop-target="import-asset"]');
  if (!dropTarget || dropTarget.contains(event.relatedTarget)) return;
  dropTarget.classList.remove("drag-over");
});

rootEl.addEventListener("dragend", (event) => {
  handleInlineActionDragEnd(event);
});

rootEl.addEventListener("drop", async (event) => {
  if (handleInlineActionDrop(event)) return;
  if (await selectAssetFromDrop(event, api, state, render)) return;
  await replaceSelectedPackageAssetFromDrop(event, api, state, render, refreshPackagesAndAssets);
});

rootEl.addEventListener("submit", async (event) => {
  await handleFormSubmit(
    event,
    state,
    state.config,
    saveConfig,
    render,
    api,
    (form) => importAssetFromForm(form, api, state, render, refreshPackagesAndAssets)
  );
});

if (api && api.events && api.events.onPackageChanged) {
  api.events.onPackageChanged(refreshAfterPackageChange);
}

// Initialize
render();
loadConfig();
