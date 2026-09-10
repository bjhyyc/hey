/**
 * Click and change event handlers
 */

import { t } from "../../../shared/i18n.js";
import { setLocale } from "../../../shared/i18n.js";
import {
  deleteConfigRule,
  updateConfigRule,
  updateConfigSystem,
  updateConfigDisplay,
  DEFAULT_KEYFRAMES,
  normalizeKeyframes,
  updateConfigAnimationKeyframes,
  createId,
  isOnboardingPending,
  completeOnboarding
} from "../panel-state.js";
import {
  getDefaultOperatorForFilterField,
  renderFilterFieldOptions,
  renderFilterOperatorControl,
  renderFilterValueControl,
  renderRuleConditionEditor
} from "../components/rule-condition-editor.js";
import { renderConditionDetails } from "../components/condition-browser.js";
import { renderSingleInlineAction } from "../components/inline-action-editor.js";
import { showBanner } from "../ui/banner.js";
import { getAssetReferences, renderPackageAssetDetail } from "../tabs/assets.js";
import { updateConfigSystem as updateSysConfig } from "../panel-state.js";
import {
  pickAsset,
  deleteReferencedAsset,
  handleBakeGreenScreen,
  importPetpackFromPicker,
  exportCurrentPetpack
} from "./asset-handlers.js";
import { resetPosition, deleteAnimation } from "./form-handlers.js";
import { createRendererLogger } from "../../shared/logger.js";

const logger = createRendererLogger("panel-onboarding");

async function finishOnboarding(state, saveConfig, render, { showSuccess = false } = {}) {
  if (!isOnboardingPending(state.config)) {
    state.onboardingJustCompleted = showSuccess;
    render();
    return true;
  }

  state.onboardingJustCompleted = showSuccess;
  const savedConfig = await saveConfig(completeOnboarding(state.config), "onboarding", { silent: true });
  if (!savedConfig) {
    state.onboardingJustCompleted = false;
    render();
    return false;
  }

  logger.info("First-run onboarding completed", { reason: showSuccess ? "petpack-imported" : "skipped" });
  return true;
}

/**
 * Set launch at login
 * @param {boolean} enabled - Enable launch at login
 * @param {object} api - API object
 * @param {object} state - Panel state
 * @param {Function} render - Render function
 * @returns {Promise<void>}
 */
async function setLaunchAtLogin(enabled, api, state, render) {
  if (!api || !api.system || !api.system.setLaunchAtLogin) {
    showBanner(t("system.startupApiUnavailable"));
    render();
    return;
  }

  state.savingKey = "system";
  render();

  try {
    state.systemLaunchAtLogin = await api.system.setLaunchAtLogin(enabled);
    if (state.config) {
      state.config = updateSysConfig(state.config, { launchAtLogin: state.systemLaunchAtLogin });
    }
    showBanner(t("message.saved"), "success");
  } catch (error) {
    showBanner(t("system.startupSettingFailed", { reason: error.message || error }));
  } finally {
    state.savingKey = "";
    render();
  }
}

const VIDEO_ASSET_EXTENSIONS = new Set([".webm", ".mp4", ".mov"]);
const DEFAULT_GREEN_SCREEN = {
  color: "#00ff00",
  tolerance: 0.35,
  softness: 0.08
};

function getDatasetDurationMs(element) {
  const durationMs = Number(element?.dataset?.durationMs);
  return Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
}

function getAssetExtension(asset) {
  const filename = String(asset || "").split(/[\\/]/).filter(Boolean).pop() || "";
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

function isVideoAsset(asset) {
  return VIDEO_ASSET_EXTENSIONS.has(getAssetExtension(asset));
}

function clampUnit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function readGreenScreenDraft(form, existingGreenScreen, asset, enabledOverride) {
  if (!isVideoAsset(asset)) return undefined;
  const enabledInput = form.elements.greenScreenEnabled;
  const colorInput = form.elements.greenScreenColor;
  const toleranceInput = form.elements.greenScreenTolerance;
  const softnessInput = form.elements.greenScreenSoftness;
  if (!enabledInput && enabledOverride === undefined && existingGreenScreen) return existingGreenScreen;

  const rawColor = String(colorInput?.value || existingGreenScreen?.color || DEFAULT_GREEN_SCREEN.color);
  return {
    enabled: enabledOverride === undefined
      ? (enabledInput ? Boolean(enabledInput.checked) : Boolean(existingGreenScreen?.enabled))
      : Boolean(enabledOverride),
    color: /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : DEFAULT_GREEN_SCREEN.color,
    tolerance: clampUnit(Number(toleranceInput?.value) / 100, existingGreenScreen?.tolerance ?? DEFAULT_GREEN_SCREEN.tolerance),
    softness: clampUnit(Number(softnessInput?.value) / 100, existingGreenScreen?.softness ?? DEFAULT_GREEN_SCREEN.softness)
  };
}

function isGreenScreenControl(target) {
  return [
    "greenScreenEnabled",
    "greenScreenBakeEnabled",
    "greenScreenColor",
    "greenScreenTolerance",
    "greenScreenSoftness"
  ].includes(target?.name);
}

function updateGreenScreenBakeReminder(form) {
  const reminder = form?.querySelector?.('[data-role="green-screen-bake-reminder"]');
  if (!reminder) return;
  reminder.hidden = !form.elements.greenScreenEnabled?.checked;
}

function renumberInlineActionRows(container, scope) {
  if (!container) return;
  container.querySelectorAll(`[data-inline-action][data-scope="${scope}"]`).forEach((actionRow, index) => {
    actionRow.dataset.index = String(index);
    const numberSpan = actionRow.querySelector(".action-number");
    if (numberSpan) numberSpan.textContent = `${index + 1}.`;
  });
}

function getInlineActionDropTarget(container, clientY, draggedRow) {
  const rows = Array.from(container.querySelectorAll("[data-inline-action]"))
    .filter((row) => row !== draggedRow);

  return rows.reduce((closest, row) => {
    const box = row.getBoundingClientRect();
    const offset = clientY - box.top - (box.height / 2);
    if (offset < 0 && offset > closest.offset) {
      return { offset, row };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, row: null }).row;
}

export function handleInlineActionDragStart(event) {
  const row = event.target.closest && event.target.closest("[data-inline-action]");
  if (!row || !event.dataTransfer) return false;

  const interactiveTarget = event.target.closest && event.target.closest("input, select, textarea, button, option");
  if (interactiveTarget) return false;

  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", `${row.dataset.scope || "actions"}:${row.dataset.index || "0"}`);
  return true;
}

export function handleInlineActionDragOver(event) {
  const container = event.target.closest && event.target.closest(".inline-actions-list");
  const draggedRow = container && container.querySelector(".inline-action-row.dragging");
  if (!container || !draggedRow || draggedRow.dataset.scope !== container.dataset.scope) return false;

  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const beforeRow = getInlineActionDropTarget(container, event.clientY, draggedRow);
  if (beforeRow) {
    container.insertBefore(draggedRow, beforeRow);
  } else {
    container.appendChild(draggedRow);
  }
  return true;
}

export function handleInlineActionDrop(event) {
  const container = event.target.closest && event.target.closest(".inline-actions-list");
  const draggedRow = container && container.querySelector(".inline-action-row.dragging");
  if (!container || !draggedRow) return false;

  event.preventDefault();
  draggedRow.classList.remove("dragging");
  renumberInlineActionRows(container, container.dataset.scope || draggedRow.dataset.scope || "actions");
  return true;
}

export function handleInlineActionDragEnd(event) {
  const row = event.target.closest && event.target.closest("[data-inline-action]");
  const container = row && row.closest(".inline-actions-list");
  if (!row || !container) return false;

  row.classList.remove("dragging");
  renumberInlineActionRows(container, container.dataset.scope || row.dataset.scope || "actions");
  return true;
}

function readVideoDurationMs(url) {
  if (!url || typeof document === "undefined") return Promise.resolve(0);

  return new Promise((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
    };
    const finish = (durationMs = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanup();
      resolve(durationMs);
    };
    const timeoutId = setTimeout(() => finish(0), 5000);

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const durationMs = Number.isFinite(video.duration) && video.duration > 0
        ? Math.round(video.duration * 1000)
        : 0;
      finish(durationMs);
    };
    video.onerror = () => finish(0);
    video.src = url;
    video.load();
  });
}

async function getSelectedAssetDurationMs(option) {
  const listedDurationMs = getDatasetDurationMs(option);
  if (listedDurationMs) return listedDurationMs;

  const ext = option?.dataset?.ext || "";
  const url = option?.dataset?.url || "";
  if (!VIDEO_ASSET_EXTENSIONS.has(ext)) return 0;

  return readVideoDurationMs(url);
}

function getRules(config) {
  return Array.isArray(config?.triggerRules) ? config.triggerRules : [];
}

function getSelectedRuleExportIds(state, rules = getRules(state.config)) {
  const validIds = new Set(rules.map((rule) => rule && rule.id).filter(Boolean));
  return Array.isArray(state.selectedRuleExportIds)
    ? state.selectedRuleExportIds.filter((id) => validIds.has(id))
    : [];
}

function setSelectedRuleExportIds(state, ids) {
  state.selectedRuleExportIds = Array.from(new Set(Array.isArray(ids) ? ids.filter(Boolean) : []));
}

function cloneRuleWithUniqueId(rule, usedIds) {
  const nextRule = { ...rule };
  if (!nextRule.id || usedIds.has(nextRule.id)) {
    let nextId = createId("rule");
    while (usedIds.has(nextId)) {
      nextId = createId("rule");
    }
    nextRule.id = nextId;
  }
  usedIds.add(nextRule.id);
  return nextRule;
}

async function exportSelectedRules(api, state, render, target = "file") {
  if (!api?.rules?.export) {
    showBanner(t("rules.export.apiUnavailable"));
    return;
  }

  const rules = getRules(state.config);
  const selectedIds = getSelectedRuleExportIds(state, rules);
  const selectedRules = rules.filter((rule) => selectedIds.includes(rule.id));
  if (selectedRules.length === 0) {
    showBanner(t("rules.export.noSelection"));
    return;
  }

  state.savingKey = target === "clipboard" ? "rule-export-clipboard" : "rule-export-file";
  render();
  try {
    const result = await api.rules.export({
      target,
      packageId: state.config?.currentPackageId || "default-pet",
      rules: selectedRules
    });
    if (!result) return;
    if (result.ok === false) {
      showBanner(result.error || t("rules.export.failed"));
      return;
    }
    showBanner(t("rules.export.success", { count: selectedRules.length }), "success");
  } catch (error) {
    showBanner(t("rules.export.failedWithReason", { reason: error.message || error }));
  } finally {
    state.savingKey = "";
    render();
  }
}

async function importRules(api, state, saveConfig, render, source = "file") {
  if (!api?.rules?.import) {
    showBanner(t("rules.import.apiUnavailable"));
    return;
  }

  state.savingKey = source === "clipboard" ? "rule-import-clipboard" : "rule-import-file";
  render();
  try {
    const result = await api.rules.import({ source });
    if (!result) return;
    if (!result.ok) {
      showBanner(result.error || t("rules.import.invalidFile"));
      return;
    }

    const importedRules = Array.isArray(result.rules) ? result.rules : [];
    const existingRules = getRules(state.config);
    const usedIds = new Set(existingRules.map((rule) => rule && rule.id).filter(Boolean));
    const nextImportedRules = importedRules.map((rule) => cloneRuleWithUniqueId(rule, usedIds));
    state.savingKey = "";
    const savedConfig = await saveConfig({
      ...state.config,
      triggerRules: [...existingRules, ...nextImportedRules]
    }, "rule");
    if (savedConfig) {
      state.selectedRuleExportIds = [];
      showBanner(t("rules.import.success", { count: nextImportedRules.length }), "success");
    }
  } catch (error) {
    showBanner(t("rules.import.failedWithReason", { reason: error.message || error }));
  } finally {
    state.savingKey = "";
    render();
  }
}

async function applySelectedAssetDuration(select) {
  const form = select?.closest("form");
  const typeSelect = form && form.querySelector("#anim-type");
  if (typeSelect && typeSelect.value !== "oneshot") return;

  const input = form && form.querySelector('[data-role="animation-duration"] input[name="durationMs"]');
  if (!input) return;

  const selectedValue = select.value;
  const option = select.options[select.selectedIndex];
  const durationMs = await getSelectedAssetDurationMs(option);
  if (!durationMs || select.value !== selectedValue) return;

  input.value = String(durationMs);
}

function getConditionRowIdPrefix(row) {
  if (!row) return "condition";
  const scope = row.dataset.scope || "conditions";
  const siblings = row.parentElement
    ? Array.from(row.parentElement.querySelectorAll(`[data-rule-condition][data-scope="${scope}"]`))
    : [];
  const index = Math.max(0, siblings.indexOf(row));
  return `${scope}-${index}`;
}

function updateFilterControls(row, field, operator, value = "") {
  if (!row) return;
  const idPrefix = getConditionRowIdPrefix(row);
  const operatorContainer = row.querySelector('[data-role="filter-operator-container"]');
  const valueContainer = row.querySelector('[data-role="filter-value-container"]');
  const operatorHtml = renderFilterOperatorControl(field, operator, idPrefix);
  const valueHtml = renderFilterValueControl(field, operator, value, idPrefix);

  if (operatorContainer) {
    operatorContainer.outerHTML = operatorHtml;
  }
  if (valueContainer) {
    valueContainer.outerHTML = valueHtml;
  }
}

function getSelectedClipId(state) {
  if (state.selectedClipId !== undefined) return state.selectedClipId;
  return state.config?.animations?.default?.id || "";
}

function findCurrentClip(state, clipId) {
  const animations = state.config?.animations || { default: { id: "idle", asset: "" }, clips: [] };
  if (clipId && clipId === animations.default?.id) return animations.default;
  return (animations.clips || []).find((clip) => clip && clip.id === clipId) || null;
}

function updateAnimationDraftFromForm(form, state) {
  if (!form) return null;
  const selectedClipId = getSelectedClipId(state);
  const currentClip = findCurrentClip(state, selectedClipId);
  const existingDraft = state.animationDraft && state.animationDraft.selectedClipId === selectedClipId
    ? state.animationDraft.clip
    : {};
  const type = form.elements.type ? form.elements.type.value : (currentClip?.type || "oneshot");
  const nextClip = {
    id: String(form.elements.id?.value || currentClip?.id || ""),
    name: String(form.elements.name?.value || ""),
    asset: String(form.elements.asset?.value || ""),
    type,
    durationMs: form.elements.durationMs?.value ? Number(form.elements.durationMs.value) : (currentClip?.durationMs || 900)
  };
  const existingGreenScreen = existingDraft.greenScreen || currentClip?.greenScreen;
  const greenScreenBakeEnabled = type === "keyframe"
    ? (form.elements.greenScreenBakeEnabled
      ? Boolean(form.elements.greenScreenBakeEnabled.checked)
      : (Object.prototype.hasOwnProperty.call(existingDraft, "greenScreenBakeEnabled")
        ? Boolean(existingDraft.greenScreenBakeEnabled)
        : Boolean(currentClip?.greenScreen?.enabled)))
    : false;
  const greenScreen = readGreenScreenDraft(
    form,
    existingGreenScreen,
    nextClip.asset,
    type === "keyframe" ? greenScreenBakeEnabled : undefined
  );
  if (greenScreen) {
    nextClip.greenScreen = greenScreen;
  }

  if (type === "keyframe") {
    nextClip.greenScreenBakeEnabled = greenScreenBakeEnabled;
    nextClip.keyframes = normalizeKeyframes(existingDraft.keyframes || currentClip?.keyframes || DEFAULT_KEYFRAMES);
  }

  // Interrupt / movement / easing behavior fields
  if (form.elements.interrupt) {
    nextClip.interrupt = Boolean(form.elements.interrupt.checked);
  }
  if (type === "oneshot") {
    const movementDirection = form.elements.movementDirection ? form.elements.movementDirection.value : "";
    if (movementDirection) {
      const speedValue = Number(form.elements.movementSpeed?.value);
      const easingPreset = form.elements.easingPreset ? form.elements.easingPreset.value : "linear";
      const easingStrength = Number(form.elements.easingStrength?.value);
      const easeInMs = Number(form.elements.easeInMs?.value);
      const easeOutMs = Number(form.elements.easeOutMs?.value);
      const startDelayMs = Number(form.elements.startDelayMs?.value);
      const endDelayMs = Number(form.elements.endDelayMs?.value);
      nextClip.movement = {
        direction: movementDirection,
        speed: Number.isFinite(speedValue) && speedValue >= 0 ? speedValue : 120,
        easing: {
          preset: ["linear", "easeIn", "easeOut", "easeInOut"].includes(easingPreset) ? easingPreset : "linear",
          strength: Number.isFinite(easingStrength) && easingStrength > 0 ? easingStrength : 1,
          easeInMs: Number.isFinite(easeInMs) && easeInMs >= 0 ? easeInMs : 0,
          easeOutMs: Number.isFinite(easeOutMs) && easeOutMs >= 0 ? easeOutMs : 0,
          startDelayMs: Number.isFinite(startDelayMs) && startDelayMs >= 0 ? startDelayMs : 0,
          endDelayMs: Number.isFinite(endDelayMs) && endDelayMs >= 0 ? endDelayMs : 0
        }
      };
    } else {
      // Explicit null so the render spread ({ ...baseFormClip, ...draft }) clears
      // any inherited movement instead of falling back to the base clip's value.
      nextClip.movement = null;
    }
  } else {
    nextClip.movement = null;
  }

  state.animationDraft = {
    selectedClipId,
    clip: nextClip
  };
  return state.animationDraft;
}

function escapeCssAttributeValue(value) {
  if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
    return globalThis.CSS.escape(value);
  }
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function updateSelectedPackageAssetView(assetPath, state) {
  if (!globalThis.document) return false;
  const selectedAsset = Array.isArray(state.packageAssets)
    ? state.packageAssets.find((asset) => asset && asset.asset === assetPath)
    : null;
  if (!selectedAsset) return false;

  const previousRow = document.querySelector('[data-action="select-package-asset"][aria-selected="true"]');
  const nextRow = document.querySelector(`[data-action="select-package-asset"][data-asset="${escapeCssAttributeValue(assetPath)}"]`);
  const detail = document.querySelector('.asset-detail[data-drop-target="replace-package-asset"]');
  if (!detail) return false;

  if (previousRow) previousRow.setAttribute("aria-selected", "false");
  if (nextRow) nextRow.setAttribute("aria-selected", "true");
  detail.outerHTML = renderPackageAssetDetail(selectedAsset, state.config);
  return true;
}

function applyLiveDisplayPatch(patch, state, api) {
  if (!state.config) return;
  state.config = updateConfigDisplay(state.config, patch);
  if (api && api.pet && typeof api.pet.applyDisplay === "function") {
    api.pet.applyDisplay(state.config.display).catch((error) => {
      showBanner(t("message.displayUpdateFailed", { reason: error.message || error }));
    });
  }
}

async function saveAppliedDisplayPatch(state, api, saveConfig, patch) {
  applyLiveDisplayPatch(patch, state, api);
  const tasks = [];
  if (api && api.pet && Object.prototype.hasOwnProperty.call(patch, "alwaysOnTop") && typeof api.pet.setAlwaysOnTop === "function") {
    tasks.push(api.pet.setAlwaysOnTop(Boolean(patch.alwaysOnTop)));
  }
  if (api && api.pet && Object.prototype.hasOwnProperty.call(patch, "mousePassthrough") && typeof api.pet.setMousePassthrough === "function") {
    tasks.push(api.pet.setMousePassthrough(Boolean(patch.mousePassthrough)));
  }
  if (typeof saveConfig === "function") {
    tasks.push(saveConfig(state.config, "display"));
  }
  await Promise.all(tasks);
}

/**
 * Handle tab clicks
 * @param {Event} event - Click event
 * @param {object} state - Panel state
 * @param {Function} render - Render function
 */
export function handleTabClick(event, state, render) {
  const button = event.target.closest("[data-tab]");
  if (!button) return;
  state.activeTab = button.dataset.tab;
  render();
}

/**
 * Handle input events (for live updates)
 * @param {Event} event - Input event
 */
export function handleInput(event, state, render, api, refreshAnimationPreview) {
  if (event.target.id === "display-scale") {
    document.querySelector("#scale-value").textContent = `${event.target.value}%`;
    applyLiveDisplayPatch({ scale: Number(event.target.value) / 100 }, state, api);
  }
  if (event.target.id === "display-opacity") {
    document.querySelector("#opacity-value").textContent = `${event.target.value}%`;
    applyLiveDisplayPatch({ opacity: Number(event.target.value) / 100 }, state, api);
  }
  if (isGreenScreenControl(event.target)) {
    const form = event.target.closest("form");
    updateAnimationDraftFromForm(form, state);
    if (event.target.name === "greenScreenBakeEnabled") {
      render();
      return;
    }
    updateGreenScreenBakeReminder(form);
    if (typeof refreshAnimationPreview === "function") {
      refreshAnimationPreview();
    }
  }
}

/**
 * Handle change events
 * @param {Event} event - Change event
 * @param {object} state - Panel state
 * @param {object} api - API object
 * @param {Function} render - Render function
 * @returns {Promise<void>}
 */
export async function handleChange(event, state, api, render, saveConfig, refreshAnimationPreview) {
  if (event.target.id === "display-scale") {
    await saveAppliedDisplayPatch(state, api, saveConfig, { scale: Number(event.target.value) / 100 });
    return;
  }

  if (event.target.id === "display-opacity") {
    await saveAppliedDisplayPatch(state, api, saveConfig, { opacity: Number(event.target.value) / 100 });
    return;
  }

  if (event.target.name === "alwaysOnTop") {
    await saveAppliedDisplayPatch(state, api, saveConfig, { alwaysOnTop: event.target.checked });
    return;
  }

  if (event.target.name === "mousePassthrough") {
    await saveAppliedDisplayPatch(state, api, saveConfig, { mousePassthrough: event.target.checked });
    return;
  }

  if (isGreenScreenControl(event.target)) {
    const form = event.target.closest("form");
    updateAnimationDraftFromForm(form, state);
    if (event.target.name === "greenScreenBakeEnabled") {
      render();
      return;
    }
    updateGreenScreenBakeReminder(form);
    if (typeof refreshAnimationPreview === "function") {
      refreshAnimationPreview();
    }
    return;
  }

  if (event.target.id === "state-type") {
    state.selectedStateType = event.target.value;
    state.selectedStateEntryId = "";
    render();
    return;
  }

  if (event.target.id === "asset-binding-target") {
    state.selectedAssetBindingTarget = event.target.value;
    render();
    return;
  }

  if (event.target.id === "asset-action-id") {
    state.selectedAssetActionId = event.target.value;
    return;
  }

  if (event.target.id === "asset-package-id") {
    state.selectedAssetPackageId = event.target.value;
    return;
  }

  if (event.target.id === "anim-type") {
    const form = event.target.closest("form");
    updateAnimationDraftFromForm(form, state);
    if (event.target.value === "oneshot") {
      const assetSelect = form && form.querySelector("#anim-asset");
      if (assetSelect) await applySelectedAssetDuration(assetSelect);
    }
    render();
    return;
  }

  if (event.target.id === "anim-asset") {
    const form = event.target.closest("form");
    updateAnimationDraftFromForm(form, state);
    await applySelectedAssetDuration(event.target);
    updateAnimationDraftFromForm(form, state);
    render();
    return;
  }

  if (event.target.id === "anim-movement-direction") {
    const form = event.target.closest("form");
    updateAnimationDraftFromForm(form, state);
    // Toggle the easing fieldset in place instead of a full re-render, which
    // would flicker the modal and reset the just-changed select.
    const easing = form && form.querySelector('[data-role="animation-easing"]');
    if (easing) easing.hidden = !event.target.value;
    return;
  }

  if (event.target.id === "launch-at-login") {
    await setLaunchAtLogin(event.target.checked, api, state, render);
    return;
  }

  // 日志开关/级别：改变即自动保存（无需点保存按钮）
  if (event.target.id === "logging-enabled" || event.target.id === "logging-level") {
    const loggingEnabled = document.querySelector("#logging-enabled");
    const loggingLevel = document.querySelector("#logging-level");
    const nextConfig = updateConfigSystem(state.config, {
      logging: {
        enabled: loggingEnabled ? loggingEnabled.checked : state.config?.system?.logging?.enabled !== false,
        level: loggingLevel ? loggingLevel.value : (state.config?.system?.logging?.level || "info")
      }
    });
    const savedConfig = await saveConfig(nextConfig, "system", { silent: true });
    if (!savedConfig) return;
    render();
    return;
  }

  // Handle inline action type change
  if (event.target.classList.contains("action-type-selector")) {
    const actionRow = event.target.closest("[data-inline-action]");
    if (actionRow) {
      const index = parseInt(actionRow.dataset.index, 10);
      const scope = actionRow.dataset.scope || "actions";
      const newType = event.target.value;
      const animations = state.config?.animations || { default: { id: "idle", asset: "" }, clips: [] };

      // Rebuild the action row with new type
      const newAction = { type: newType };
      if (newType === "playAnimation") {
        newAction.animation = animations.default.id;
        newAction.durationMs = 900;
      } else if (newType === "setKeyframeProgress") {
        const keyframeClip = (animations.clips || []).find((clip) => clip.type === "keyframe");
        newAction.animation = (keyframeClip || animations.default).id;
        newAction.progressFrom = "angleToPetProgress";
      } else if (newType === "showMessage") {
        newAction.text = "";
        newAction.durationMs = 1800;
      } else if (newType === "randomMessage") {
        newAction.messages = [];
        newAction.durationMs = 1800;
      } else if (newType === "changeScale") {
        newAction.scale = 1;
      } else if (newType === "changeOpacity") {
        newAction.opacity = 1;
      } else if (newType === "movePet") {
        newAction.direction = "right";
        newAction.speed = 120;
        newAction.durationMs = 1000;
      } else if (newType === "pomodoroTimer") {
        newAction.command = "start";
        newAction.durationMs = 1500000;
        newAction.label = "";
      }

      const newHTML = renderSingleInlineAction(newAction, index, animations, scope);
      actionRow.outerHTML = newHTML;
    }
    return;
  }

  if (event.target.classList.contains("pomodoro-command-selector")) {
    const actionRow = event.target.closest("[data-inline-action]");
    if (actionRow) {
      const index = parseInt(actionRow.dataset.index, 10);
      const scope = actionRow.dataset.scope || "actions";
      const newAction = { type: "pomodoroTimer", command: event.target.value === "cancel" ? "cancel" : "start" };
      if (newAction.command === "start") {
        newAction.durationMs = 1500000;
        newAction.label = "";
      }
      actionRow.outerHTML = renderSingleInlineAction(
        newAction,
        index,
        state.config?.animations || { default: { id: "idle", asset: "" }, clips: [] },
        scope
      );
    }
    return;
  }

  // Handle animation selector change in playAnimation action
  if (event.target.dataset.role === "animation-selector") {
    const actionRow = event.target.closest("[data-inline-action]");
    if (actionRow) {
      const index = parseInt(actionRow.dataset.index, 10);
      const scope = actionRow.dataset.scope || "actions";
      const selectedOption = event.target.options[event.target.selectedIndex];
      const animDuration = selectedOption.dataset.duration || 900;
      const animations = state.config?.animations || { default: { id: "idle", asset: "" }, clips: [] };

      actionRow.outerHTML = renderSingleInlineAction({
        type: "playAnimation",
        animation: event.target.value,
        durationMs: animDuration
      }, Number.isFinite(index) ? index : 0, animations, scope);
    }
    return;
  }

  if (event.target.dataset.role === "filter-field") {
    const row = event.target.closest("[data-rule-condition]");
    const field = event.target.value || "";
    const operator = field ? getDefaultOperatorForFilterField(field) : "=";
    updateFilterControls(row, field, operator, "");
    return;
  }

  if (event.target.dataset.role === "filter-operator") {
    const row = event.target.closest("[data-rule-condition]");
    const fieldSelect = row && row.querySelector('[data-role="filter-field"]');
    const field = fieldSelect ? fieldSelect.value : "";
    updateFilterControls(row, field, event.target.value || getDefaultOperatorForFilterField(field), "");
    return;
  }

  if (event.target.dataset.role !== "condition-type") return;

  const row = event.target.closest("[data-rule-condition]");
  const fieldSelect = row && row.querySelector('[data-role="filter-field"]');
  if (!fieldSelect) return;

  const scope = row.dataset.scope || "conditions";
  fieldSelect.innerHTML = renderFilterFieldOptions(event.target.value, "");
  fieldSelect.value = "";
  updateFilterControls(row, "", "=", "");

  const sustainField = row.querySelector('[data-role="condition-sustain"]');
  if (sustainField) {
    const showSustain = event.target.value === "mouseMove";
    sustainField.style.display = showSustain ? "" : "none";
    const sustainInput = sustainField.querySelector('[name="conditionSustainMs"]');
    if (!showSustain && sustainInput) sustainInput.value = "";
  }

  const timerSettings = row.querySelector('[data-role="timer-settings-container"]');
  if (timerSettings) {
    const showTimerSettings = event.target.value === "timer";
    timerSettings.style.display = showTimerSettings ? "" : "none";
    if (!showTimerSettings) {
      timerSettings.querySelectorAll("input").forEach((input) => {
        input.value = "";
      });
    }
  }

  const randomTimerSettings = row.querySelector('[data-role="random-timer-settings-container"]');
  if (randomTimerSettings) {
    const showRandomTimerSettings = event.target.value === "randomTimer";
    randomTimerSettings.style.display = showRandomTimerSettings ? "" : "none";
    if (!showRandomTimerSettings) {
      randomTimerSettings.querySelectorAll("input").forEach((input) => {
        input.value = "";
      });
    }
  }

  const form = event.target.closest("form");
  if (form && scope === "conditions") {
    const hasMouseMoveCondition = Array.from(form.querySelectorAll('[data-rule-condition][data-scope="conditions"] [name="conditionType"]'))
      .some((select) => select.value === "mouseMove");
    form.querySelectorAll('[data-role="exit-state-block"]').forEach((block) => {
      block.style.display = hasMouseMoveCondition ? "" : "none";
    });
  }
}

/**
 * Handle click actions
 * @param {Event} event - Click event
 * @param {object} state - Panel state
 * @param {object} api - API object
 * @param {Function} saveConfig - Save config function
 * @param {Function} render - Render function
 * @returns {Promise<void>}
 */
export async function handleClickAction(event, state, api, saveConfig, render, refreshPackagesAndAssets, refreshLogs) {
  const button = event.target.closest("[data-action]");
  if (!button || state.savingKey) return;

  const action = button.dataset.action;

  if (action === "install-sample-petpack") {
    if (!api?.petpack?.installSample) {
      showBanner(t("onboarding.installFailed", { reason: "API unavailable" }));
      return;
    }

    state.savingKey = "onboarding-sample-install";
    render();

    try {
      const result = await api.petpack.installSample();
      if (!result || result.ok === false) {
        showBanner(t("onboarding.installFailed", { reason: result?.error || t("common.error") }));
        return;
      }

      if (result.packageId) {
        const nextConfig = api.packages?.switch
          ? await api.packages.switch(result.packageId)
          : await api.config.save({
            ...state.config,
            currentPackageId: result.packageId
          });
        if (nextConfig && nextConfig.ok === false) {
          showBanner(nextConfig.error || t("assets.package.switchFailed"));
          return;
        }
        state.config = nextConfig;
        state.selectedAssetPackageId = result.packageId;
      }

      if (refreshPackagesAndAssets) {
        await refreshPackagesAndAssets();
      }

      state.savingKey = "";
      logger.info("Sample petpack installed from onboarding", { packageId: result.packageId || "" });
      showBanner(t("assets.petpack.importSuccess", { packageId: result.packageId }), "success");
      await finishOnboarding(state, saveConfig, render, { showSuccess: true });
    } catch (error) {
      logger.warn("Sample petpack installation failed", { error: error.message || String(error) });
      showBanner(t("onboarding.installFailed", { reason: error.message || error }));
    } finally {
      if (state.savingKey === "onboarding-sample-install") {
        state.savingKey = "";
      }
      render();
    }
    return;
  }

  if (action === "skip-onboarding") {
    await finishOnboarding(state, saveConfig, render);
    return;
  }

  if (action === "dismiss-onboarding-success") {
    state.onboardingJustCompleted = false;
    render();
    return;
  }

  if (action === "add-animation") {
    state.selectedClipId = "";
    state.animationDraft = null;
    state.animationEditorOpen = true;
    render();
  }
  if (action === "select-animation") {
    state.selectedClipId = button.dataset.clipId;
    state.animationDraft = null;
    state.animationEditorOpen = true;
    render();
  }
  if (action === "close-animation-editor") {
    state.animationEditorOpen = false;
    state.animationDraft = null;
    render();
  }
  if (action === "delete-animation") {
    const animations = state.config?.animations || { default: { id: "idle", asset: "" }, clips: [] };
    if (state.selectedClipId && state.selectedClipId !== animations.default.id) {
      if (!window.confirm(t("panel.animations.deleteConfirm"))) return;
      await deleteAnimation(state.selectedClipId, state.config, saveConfig, state, render);
    }
  }
  if (action === "new-rule") {
    state.selectedRuleId = "";
    state.ruleEditorOpen = true;
    render();
    return;
  }
  if (action === "toggle-rule-export-selection") {
    // If the click originated from within a nested element that has its own
    // data-action (e.g. the enable checkbox label, edit/delete buttons), skip
    // the row-level toggle so the inner handler fires without side effects.
    const innerAction = event.target.closest("[data-action]");
    if (innerAction && innerAction !== button) {
      return;
    }
    // Also guard against label-synthesized clicks: if the target is inside a
    // <label> that wraps an input with its own data-action, skip.
    const parentLabel = event.target.closest("label");
    if (parentLabel && parentLabel.querySelector("[data-action]")) {
      return;
    }
    const rules = getRules(state.config);
    const selectedIds = new Set(getSelectedRuleExportIds(state, rules));
    const shouldSelect = typeof button.checked === "boolean"
      ? button.checked
      : !selectedIds.has(button.dataset.id);
    if (shouldSelect) {
      selectedIds.add(button.dataset.id);
    } else {
      selectedIds.delete(button.dataset.id);
    }
    setSelectedRuleExportIds(state, Array.from(selectedIds));
    render();
    return;
  }
  if (action === "toggle-all-rule-exports") {
    const rules = getRules(state.config);
    const selectedIds = getSelectedRuleExportIds(state, rules);
    setSelectedRuleExportIds(
      state,
      selectedIds.length === rules.length ? [] : rules.map((rule) => rule.id)
    );
    render();
    return;
  }
  if (action === "export-selected-rules" || action === "export-selected-rules-file") {
    await exportSelectedRules(api, state, render, "file");
    return;
  }
  if (action === "export-selected-rules-clipboard") {
    await exportSelectedRules(api, state, render, "clipboard");
    return;
  }
  if (action === "import-rules" || action === "import-rules-file") {
    await importRules(api, state, saveConfig, render, "file");
    return;
  }
  if (action === "import-rules-clipboard") {
    await importRules(api, state, saveConfig, render, "clipboard");
    return;
  }
  if (action === "edit-rule") {
    state.selectedRuleId = button.dataset.id;
    state.ruleEditorOpen = true;
    render();
    return;
  }
  if (action === "close-rule-editor") {
    state.ruleEditorOpen = false;
    state.selectedRuleId = "";
    render();
    return;
  }
  if (action === "delete-rule") {
    if (!window.confirm(t("rules.deleteConfirm"))) return;
    await saveConfig(deleteConfigRule(state.config, button.dataset.id), "rule");
    if (state.selectedRuleId === button.dataset.id) {
      state.selectedRuleId = "";
      state.ruleEditorOpen = false;
      render();
    }
    return;
  }
  if (action === "toggle-rule-enabled") {
    const rules = Array.isArray(state.config?.triggerRules) ? state.config.triggerRules : [];
    const rule = rules.find((item) => item && item.id === button.dataset.id);
    if (!rule) return;

    await saveConfig(updateConfigRule(state.config, {
      ...rule,
      enabled: button.checked
    }), "rule");
    return;
  }
  if (action === "show-condition-help") {
    state.conditionHelpOpen = true;
    render();
    return;
  }
  if (action === "close-condition-help") {
    state.conditionHelpOpen = false;
    render();
    return;
  }
  if (action === "toggle-condition-filter") {
    const card = button.closest("[data-rule-condition]");
    const filterPanel = card && card.querySelector(".condition-card-filter");
    const icon = button.querySelector(".filter-icon");
    if (filterPanel && icon) {
      const isHidden = filterPanel.style.display === "none";
      filterPanel.style.display = isHidden ? "" : "none";
      icon.textContent = isHidden ? "▼" : "▶";
      button.setAttribute("aria-expanded", isHidden ? "true" : "false");
    }
    return;
  }
  if (action === "select-condition") {
    state.selectedConditionType = button.dataset.condition;
    const panel = button.closest(".condition-help-panel");
    if (panel) {
      panel.querySelectorAll("[data-action=\"select-condition\"]").forEach((item) => {
        item.setAttribute("aria-selected", item === button ? "true" : "false");
      });
      const details = panel.querySelector('[data-role="condition-details"]');
      if (details) {
        details.innerHTML = renderConditionDetails(state.selectedConditionType);
        details.scrollTop = 0;
      }
    } else {
      render();
    }
    return;
  }
  if (action === "add-rule-condition") {
    const form = button.closest("form");
    const scope = button.dataset.scope || "conditions";
    const list = form.querySelector(`.conditions-list[data-scope="${scope}"]`);
    const index = list.querySelectorAll(`[data-rule-condition][data-scope="${scope}"]`).length;
    list.insertAdjacentHTML("beforeend", renderRuleConditionEditor({ type: scope === "exitConditions" ? "mouseMove" : "click", required: true, filters: [] }, index, scope));
  }
  if (action === "remove-rule-condition") {
    const row = button.closest("[data-rule-condition]");
    if (row && row.parentElement.querySelectorAll(`[data-rule-condition][data-scope="${row.dataset.scope || "conditions"}"]`).length > 1) {
      const form = button.closest("form");
      const scope = row.dataset.scope || "conditions";
      row.remove();
      const addConditionBtn = form.querySelector(`[data-action="add-rule-condition"][data-scope="${scope}"]`);
      if (addConditionBtn) addConditionBtn.disabled = false;
      if (scope === "conditions") {
        const hasMouseMoveCondition = Array.from(form.querySelectorAll('[data-rule-condition][data-scope="conditions"] [name="conditionType"]'))
          .some((select) => select.value === "mouseMove");
        form.querySelectorAll('[data-role="exit-state-block"]').forEach((block) => {
          block.style.display = hasMouseMoveCondition ? "" : "none";
        });
      }
    }
  }
  if (action === "add-inline-action") {
    const scope = button.dataset.scope || "actions";
    const container = button.closest(".inline-actions").querySelector(`.inline-actions-list[data-scope="${scope}"]`);
    const index = container.querySelectorAll(`[data-inline-action][data-scope="${scope}"]`).length;
    const animations = state.config?.animations || { default: { id: "idle", asset: "" }, clips: [] };
    container.insertAdjacentHTML("beforeend", renderSingleInlineAction({
      type: "playAnimation",
      animation: animations.default.id,
      durationMs: 900
    }, index, animations, scope));
  }
  if (action === "add-inline-delay") {
    const scope = button.dataset.scope || "actions";
    const container = button.closest(".inline-actions").querySelector(`.inline-actions-list[data-scope="${scope}"]`);
    const index = container.querySelectorAll(`[data-inline-action][data-scope="${scope}"]`).length;
    const animations = state.config?.animations || { default: { id: "idle", asset: "" }, clips: [] };
    container.insertAdjacentHTML("beforeend", renderSingleInlineAction({
      type: "delay",
      durationMs: 1000
    }, index, animations, scope));
  }
  if (action === "remove-inline-action") {
    const row = button.closest("[data-inline-action]");
    if (row) {
      const scope = row.dataset.scope || "actions";
      row.remove();
      const container = row.parentElement;
      renumberInlineActionRows(container, scope);
    }
  }
  if (action === "pick-asset") {
    await pickAsset(api, state, render);
  }
  if (action === "delete-asset") {
    if (!window.confirm(t("assets.delete.confirm", { asset: button.dataset.asset }))) return;
    await deleteReferencedAsset(button.dataset.asset, api, state, render);
    if (refreshPackagesAndAssets) {
      await refreshPackagesAndAssets();
      render();
    }
  }
  if (action === "select-package-asset") {
    state.selectedPackageAsset = button.dataset.asset;
    if (!updateSelectedPackageAssetView(button.dataset.asset, state)) {
      render();
    }
  }
  if (action === "bake-green-screen") {
    const form = button.closest("form");
    updateAnimationDraftFromForm(form, state);
    await handleBakeGreenScreen(button.dataset.clipId, form, api, state, render, refreshPackagesAndAssets);
    return;
  }
  if (action === "open-keyframe-editor") {
    const clipId = button.dataset.clipId;
    const form = button.closest("form");
    const selectedClipId = getSelectedClipId(state);
    const hasDraft = state.animationDraft && state.animationDraft.selectedClipId === selectedClipId;
    const draft = hasDraft || !clipId ? updateAnimationDraftFromForm(form, state) : null;
    const animations = state.config?.animations || { default: { id: "idle", asset: "" }, clips: [] };
    const clip = (animations.clips || []).find((c) => c.id === clipId) || {};
    const packageAssets = Array.isArray(state.packageAssets) ? state.packageAssets : [];
    const draftClip = draft?.clip || null;
    const assetPath = draftClip?.asset || clip.asset || "";
    const assetEntry = packageAssets.find((a) => a.asset === assetPath) || {};
    state.keyframeEditorClipId = clipId || "__animation-draft__";
    state.keyframeEditorIsDraft = Boolean(draft);
    state.keyframeEditorKeyframes = normalizeKeyframes(draftClip?.keyframes || clip.keyframes || DEFAULT_KEYFRAMES);
    state.keyframeEditorSelectedIndex = null;
    state.keyframeEditorAssetUrl = assetEntry.url || "";
    state.keyframeEditorAssetPath = assetPath;
    const greenScreenBakeEnabled = draftClip && Object.prototype.hasOwnProperty.call(draftClip, "greenScreenBakeEnabled")
      ? Boolean(draftClip.greenScreenBakeEnabled)
      : Boolean(clip.greenScreen?.enabled);
    state.keyframeEditorGreenScreen = greenScreenBakeEnabled
      ? (draftClip?.greenScreen || clip.greenScreen || null)
      : null;
    state.keyframeEditorOpen = true;
    render();
    // Scrub to first keyframe after video metadata loads
    setTimeout(() => {
      const video = document.querySelector("#keyframe-preview-video");
      if (video) {
        const scrub = () => {
          const kfs = normalizeKeyframes(state.keyframeEditorKeyframes);
          if (kfs.length > 0 && Number.isFinite(video.duration) && video.duration > 0) {
            video.currentTime = video.duration * kfs[0].output;
          }
        };
        if (video.readyState >= 1) scrub();
        else video.onloadedmetadata = scrub;
      }
    }, 50);
    return;
  }
  if (action === "close-keyframe-editor") {
    if (state.keyframeEditorIsDraft && state.animationDraft) {
      state.animationDraft = {
        ...state.animationDraft,
        clip: {
          ...state.animationDraft.clip,
          keyframes: normalizeKeyframes(state.keyframeEditorKeyframes)
        }
      };
    } else if (state.keyframeEditorClipId) {
      const nextConfig = updateConfigAnimationKeyframes(
        state.config,
        state.keyframeEditorClipId,
        state.keyframeEditorKeyframes
      );
      const savedConfig = await saveConfig(nextConfig, "animation");
      if (savedConfig) {
        state.config = savedConfig;
      }
    }
    state.keyframeEditorOpen = false;
    state.keyframeEditorClipId = "";
    state.keyframeEditorIsDraft = false;
    state.keyframeEditorKeyframes = [];
    state.keyframeEditorSelectedIndex = null;
    state.keyframeEditorAssetUrl = "";
    state.keyframeEditorAssetPath = "";
    state.keyframeEditorGreenScreen = null;
    render();
    return;
  }
  if (action === "reset-keyframes-default") {
    state.keyframeEditorKeyframes = DEFAULT_KEYFRAMES.map((item) => ({ ...item }));
    render();
    return;
  }
  if (action === "start-new-package") {
    state.isCreatingPackage = true;
    render();
  }
  if (action === "cancel-new-package") {
    state.isCreatingPackage = false;
    render();
  }
  if (action === "toggle-package-edit") {
    state.packageEditMode = !state.packageEditMode;
    render();
  }
  if (action === "create-package") {
    if (api.packages && api.packages.create) {
      const input = document.querySelector('[data-role="new-package-id"]');
      const packageId = input ? input.value : "";
      if (!packageId || !packageId.trim()) return;
      const nextConfig = await api.packages.create(packageId.trim());
      if (nextConfig && nextConfig.ok === false) {
        showBanner(nextConfig.error || t("assets.package.createFailed"));
        return;
      }
      state.config = nextConfig;
      state.selectedAssetPackageId = state.config.currentPackageId;
      state.selectedPackageAsset = "";
      state.isCreatingPackage = false;
      if (refreshPackagesAndAssets) await refreshPackagesAndAssets();
      render();
    }
  }
  if (action === "delete-package") {
    if (api.packages && api.packages.delete) {
      const packageId = button.dataset.packageId;
      const confirmed = window.confirm(t("assets.package.deleteConfirm", { packageId }));
      if (!confirmed) return;

      state.savingKey = "package-delete";
      render();
      try {
        const result = await api.packages.delete(packageId);
        if (!result || !result.ok) {
          showBanner((result && result.error) || t("assets.package.deleteFailed"));
          return;
        }

        if (state.config?.currentPackageId === packageId && api.config && api.config.load) {
          state.config = await api.config.load();
        } else if (result.currentPackageId && state.config) {
          state.config = {
            ...state.config,
            currentPackageId: result.currentPackageId
          };
        }
        state.selectedAssetPackageId = state.config?.currentPackageId || "default-pet";
        state.selectedPackageAsset = "";
        showBanner(t("assets.package.deleteSuccess", { packageId }), "success");
      } catch (error) {
        showBanner(t("assets.package.deleteFailedWithReason", { reason: error.message || error }));
      } finally {
        state.savingKey = "";
      }

      if (refreshPackagesAndAssets) await refreshPackagesAndAssets();
      render();
    }
  }
  if (action === "toggle-asset-edit") {
    state.assetEditMode = !state.assetEditMode;
    render();
  }
  if (action === "delete-package-asset") {
    const references = getAssetReferences(button.dataset.asset, state.config);
    if (references.length > 0) {
      const confirmed = window.confirm(t("assets.delete.referencedConfirm", {
        count: references.length,
        asset: button.dataset.asset
      }));
      if (!confirmed) return;
    } else if (!window.confirm(t("assets.delete.confirm", { asset: button.dataset.asset }))) {
      return;
    }
    await deleteReferencedAsset(button.dataset.asset, api, state, render);
    if (refreshPackagesAndAssets) {
      await refreshPackagesAndAssets();
      render();
    }
  }
  if (action === "switch-package") {
    if (api.packages && api.packages.switch) {
      const nextConfig = await api.packages.switch(button.dataset.packageId);
      if (nextConfig && nextConfig.ok === false) {
        showBanner(nextConfig.error || t("assets.package.switchFailed"));
        return;
      }
      state.config = nextConfig;
      state.selectedAssetPackageId = state.config.currentPackageId;
      if (refreshPackagesAndAssets) await refreshPackagesAndAssets();
      render();
    }
  }
  if (action === "export-package") {
    await exportCurrentPetpack(api, state, render, button.dataset.packageId || state.config.currentPackageId);
    if (refreshPackagesAndAssets) await refreshPackagesAndAssets();
  }
  if (action === "import-petpack") {
    const result = await importPetpackFromPicker(api, state, render, refreshPackagesAndAssets);
    if (result?.ok && isOnboardingPending(state.config)) {
      await finishOnboarding(state, saveConfig, render, { showSuccess: true });
    }
  }
  if (action === "export-petpack") {
    await exportCurrentPetpack(api, state, render);
  }
  if (action === "reset-position") {
    await resetPosition(state.config, saveConfig, api);
  }
  if (action === "open-official-link") {
    if (!api.system?.about?.openLink) {
      showBanner(t("system.about.openFailed"));
      return;
    }

    const result = await api.system.about.openLink(button.dataset.target || "");
    if (!result || result.ok === false) {
      showBanner(result?.error || t("system.about.openFailed"));
    }
    return;
  }
  if (action === "check-for-updates") {
    if (!api.system?.about?.checkForUpdates) {
      showBanner(t("system.about.checkFailed", { reason: "API unavailable" }));
      return;
    }

    state.savingKey = "update-check";
    state.updateCheck = { status: "checking" };
    render();

    try {
      const result = await api.system.about.checkForUpdates();
      if (!result || result.ok === false) {
        state.updateCheck = {
          status: "error",
          error: result?.error || t("common.error")
        };
        showBanner(t("system.about.checkFailed", { reason: state.updateCheck.error }));
        return;
      }

      state.aboutInfo = {
        ...(state.aboutInfo || {}),
        version: result.currentVersion
      };
      state.updateCheck = {
        status: result.unavailable ? "unavailable" : (result.updateAvailable ? "available" : "latest"),
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        releaseName: result.releaseName || ""
      };
      if (result.updateAvailable) {
        showBanner(t("system.about.updateAvailable", { version: result.latestVersion }), "success");
      } else {
        showBanner(t("system.about.latest", { version: result.currentVersion }), "success");
      }
    } catch (error) {
      state.updateCheck = { status: "error", error: error.message || String(error) };
      showBanner(t("system.about.checkFailed", { reason: error.message || error }));
    } finally {
      state.savingKey = "";
      render();
    }
    return;
  }
  if (action === "save-system") {
    const languageSelect = document.querySelector("#language-select");
    const loggingEnabled = document.querySelector("#logging-enabled");
    const loggingLevel = document.querySelector("#logging-level");

    const newLanguage = languageSelect ? languageSelect.value : (state.config?.system?.language || "en");
    const nextConfig = updateConfigSystem(state.config, {
      language: newLanguage,
      logging: {
        enabled: loggingEnabled ? loggingEnabled.checked : state.config?.system?.logging?.enabled !== false,
        level: loggingLevel ? loggingLevel.value : (state.config?.system?.logging?.level || "info")
      }
    });
    const savedConfig = await saveConfig(nextConfig, "system", { silent: true });
    if (!savedConfig) return;

    // Update locale and re-render
    setLocale(newLanguage);
    if (typeof refreshLogs === "function") await refreshLogs({ preserveSelection: true });
    render();
    showBanner(t("message.saved"), "success");
    return;
  }
  if (action === "refresh-logs") {
    if (typeof refreshLogs === "function") {
      await refreshLogs({ preserveSelection: true });
    }
    return;
  }
  if (action === "clear-logs") {
    if (!api.system?.logs?.clear) return;
    const confirmed = window.confirm(t("system.logs.clearConfirm"));
    if (!confirmed) return;

    state.savingKey = "logs";
    render();
    try {
      const result = await api.system.logs.clear();
      if (!result || result.ok === false) {
        showBanner(result?.error || t("system.logs.clearFailed"));
        return;
      }
      state.selectedLogFile = "";
      state.logContent = "";
      state.logTruncated = false;
      if (typeof refreshLogs === "function") await refreshLogs({ preserveSelection: false });
      showBanner(t("system.logs.cleared"), "success");
    } catch (error) {
      showBanner(t("system.logs.clearFailedWithReason", { reason: error.message || error }));
    } finally {
      state.savingKey = "";
      render();
    }
    return;
  }
  if (action === "open-log-directory") {
    if (!api.system?.logs?.openDirectory) return;
    const result = await api.system.logs.openDirectory();
    if (result && result.ok === false) {
      showBanner(result.error || t("system.logs.openFailed"));
    }
    return;
  }
  if (action === "quit-app") {
    await api.app.quit();
  }
}
