/**
 * Animations tab
 */

import { checked, escapeHtml, getPathFilename, getPathExtension, renderFieldHelp, selected } from "../ui/utils.js";
import { renderHeader } from "../ui/header.js";
import { t } from "../../../shared/i18n.js";
import { renderKeyframeEditor } from "../components/keyframe-editor.js";
import { normalizeKeyframes } from "../panel-state.js";

const VIDEO_ASSET_EXTENSIONS = new Set([".webm", ".mp4", ".mov"]);
const DEFAULT_GREEN_SCREEN = {
  color: "#00ff00",
  tolerance: 0.35,
  softness: 0.08
};

/**
 * Get animations from config
 * @param {object} config - Configuration object
 * @returns {object} Animations object with default and clips
 */
function getConfigAnimations(config) {
  const animations = config?.animations || {};
  return {
    default: animations.default || { id: "", name: "", asset: "" },
    clips: animations.clips || []
  };
}

function getAnimationName(clip, fallback = "") {
  return clip?.name || fallback || clip?.id || "";
}

/**
 * Render animation type selector
 * @param {string} currentType - Current animation type
 * @returns {string} HTML for type selector
 */
function renderTypeSelector(currentType) {
  const types = [
    { value: "oneshot", label: t("panel.animations.type.oneshot") },
    { value: "loop", label: t("panel.animations.type.loop") },
    { value: "keyframe", label: t("panel.animations.type.keyframe") }
  ];

  return `
    <div class="form-group">
      <label for="anim-type">${t("panel.animations.form.type")}</label>
      <select id="anim-type" name="type" required>
        ${types.map(type => `
          <option value="${escapeHtml(type.value)}" ${selected(currentType, type.value)}>
            ${escapeHtml(type.label)}
          </option>
        `).join("")}
      </select>
    </div>
  `;
}

function getPackageAssets(state) {
  return Array.isArray(state.packageAssets) ? state.packageAssets : [];
}

function getPositiveDurationMs(value) {
  const durationMs = Number(value);
  return Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
}

function getAssetDurationMs(asset) {
  return getPositiveDurationMs(asset && asset.durationMs);
}

function isVideoAssetPath(assetPath, assetMeta) {
  const ext = (assetMeta && assetMeta.ext) || getPathExtension(assetPath);
  return VIDEO_ASSET_EXTENSIONS.has(String(ext || "").toLowerCase());
}

function getBoundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeGreenScreenConfig(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    color: typeof config.color === "string" && /^#[0-9a-f]{6}$/i.test(config.color)
      ? config.color
      : DEFAULT_GREEN_SCREEN.color,
    tolerance: getBoundedNumber(config.tolerance, DEFAULT_GREEN_SCREEN.tolerance, 0, 1),
    softness: getBoundedNumber(config.softness, DEFAULT_GREEN_SCREEN.softness, 0, 1)
  };
}

function getAssetOptionDataAttributes(asset) {
  const attrs = [];
  if (asset.ext) attrs.push(`data-ext="${escapeHtml(asset.ext)}"`);
  if (asset.url) attrs.push(`data-url="${escapeHtml(asset.url)}"`);
  const durationMs = getAssetDurationMs(asset);
  if (durationMs) attrs.push(`data-duration-ms="${durationMs}"`);
  return attrs.join(" ");
}

function renderAssetSelector(currentAsset, packageAssets) {
  const hasCurrentAsset = currentAsset && !packageAssets.some((asset) => asset.asset === currentAsset);
  const options = [
    `<option value="">${t("panel.animations.form.assetPlaceholder")}</option>`,
    ...(hasCurrentAsset ? [`<option value="${escapeHtml(currentAsset)}" selected>${escapeHtml(currentAsset)}</option>`] : []),
    ...packageAssets.map((asset) => {
      const assetPath = asset.asset || "";
      const label = asset.name || getPathFilename(assetPath) || assetPath;
      return `
        <option value="${escapeHtml(assetPath)}" ${selected(currentAsset, assetPath)} ${getAssetOptionDataAttributes(asset)}>
          ${escapeHtml(label)} (${escapeHtml(assetPath)})
        </option>
      `;
    })
  ];

  return `
    <select id="anim-asset" name="asset" required>
      ${options.join("")}
    </select>
  `;
}

function renderHelpSection() {
  return `
    <section class="panel-section help-section">
      <div class="section-header"><h3>${t("panel.animations.help.title")}</h3></div>
      <div class="section-body help-content">
        <p><strong>${t("panel.animations.help.defaultTitle")}:</strong> ${t("panel.animations.help.defaultDesc")}</p>
        <p><strong>${t("panel.animations.help.oneshotTitle")}:</strong> ${t("panel.animations.help.oneshotDesc")}</p>
        <p><strong>${t("panel.animations.help.loopTitle")}:</strong> ${t("panel.animations.help.loopDesc")}</p>
        <p><strong>${t("panel.animations.help.keyframeTitle")}:</strong> ${t("panel.animations.help.keyframeDesc")}</p>
        <p><strong>${t("panel.animations.help.assetTitle")}:</strong> ${t("panel.animations.help.assetDesc")}</p>
      </div>
    </section>
  `;
}

/**
 * Render animation card component
 * @param {object} clip - Animation clip
 * @param {boolean} isDefault - Whether this is the default animation
 * @param {boolean} isSelected - Whether this clip is selected
 * @returns {string} Animation card HTML
 */
function renderAnimationCard(clip, isDefault, isSelected) {
  const typeLabels = {
    default: t("panel.animations.type.default"),
    oneshot: t("panel.animations.type.oneshot"),
    loop: t("panel.animations.type.loop"),
    keyframe: t("panel.animations.type.keyframe")
  };

  const typeLabel = typeLabels[clip.type] || clip.type;
  const title = isDefault
    ? `${getAnimationName(clip, t("panel.animations.defaultAnimation"))} (${t("panel.animations.defaultAnimation")})`
    : getAnimationName(clip, t("panel.animations.unnamed"));

  return `
    <button
      class="item-row asset-row"
      type="button"
      data-action="select-animation"
      data-clip-id="${escapeHtml(clip.id)}"
      aria-selected="${isSelected}"
      ${isDefault ? 'data-is-default="true"' : ''}
    >
      <span>
        <strong>${escapeHtml(title)}</strong>
        <code>${clip.asset ? escapeHtml(clip.asset) : t("panel.animations.noAsset")}</code>
      </span>
      <span class="muted">${escapeHtml(typeLabel)}${clip.durationMs ? ` · ${clip.durationMs}ms` : ""}</span>
    </button>
  `;
}

function renderAddAnimationRow() {
  return `
    <button class="item-row asset-row" type="button" data-action="add-animation">
      <span>
        <strong>+ ${t("panel.animations.addClip")}</strong>
        <code>${t("panel.animations.addClipDesc")}</code>
      </span>
    </button>
  `;
}

function renderSelectedSummary(formClip, isDefault) {
  const typeLabels = {
    default: t("panel.animations.type.default"),
    oneshot: t("panel.animations.type.oneshot"),
    loop: t("panel.animations.type.loop"),
    keyframe: t("panel.animations.type.keyframe")
  };

  return `
    <div class="item-row">
      <div>
        <strong>${escapeHtml(getAnimationName(formClip, t("panel.animations.addClip")))}</strong>
        <code>${formClip.asset ? escapeHtml(formClip.asset) : t("panel.animations.noAsset")}</code>
      </div>
      <span class="muted">${escapeHtml(typeLabels[isDefault ? "default" : formClip.type] || formClip.type || "")}</span>
    </div>
  `;
}

function renderGreenScreenSettings(formClip, isVideoAsset, isKeyframe, bakeProgress) {
  if (!isVideoAsset) return "";

  const greenScreen = normalizeGreenScreenConfig(formClip.greenScreen);
  const tolerancePercent = Math.round(greenScreen.tolerance * 100);
  const softnessPercent = Math.round(greenScreen.softness * 100);
  const isBaking = Boolean(bakeProgress);

  if (isKeyframe) {
    const greenScreenBakeEnabled = Object.prototype.hasOwnProperty.call(formClip, "greenScreenBakeEnabled")
      ? Boolean(formClip.greenScreenBakeEnabled)
      : Boolean(formClip.greenScreen?.enabled);
    return `
      <fieldset class="form-group" data-role="green-screen-settings">
        <legend>${t("panel.animations.greenScreen.bakeTitle")}</legend>
        <p class="muted">${t("panel.animations.greenScreen.bakeHint")}</p>
        <label class="checkbox-label">
          <input
            type="checkbox"
            name="greenScreenBakeEnabled"
            ${checked(greenScreenBakeEnabled)}
          >
          ${t("panel.animations.greenScreen.hasGreenBackground")}
        </label>
        ${greenScreenBakeEnabled ? `
        <div class="green-screen-bake" data-role="green-screen-bake">
          <div class="form-grid compact">
            <label>
              ${t("panel.animations.greenScreen.color")}
              <input type="color" name="greenScreenColor" value="${escapeHtml(greenScreen.color)}">
            </label>
            <label>
              ${t("panel.animations.greenScreen.tolerance")}
              <input type="range" name="greenScreenTolerance" value="${tolerancePercent}" min="0" max="100" step="1">
            </label>
            <label>
              ${t("panel.animations.greenScreen.softness")}
              <input type="range" name="greenScreenSoftness" value="${softnessPercent}" min="0" max="100" step="1">
            </label>
          </div>
          <div class="button-row">
            <button type="button" class="button-primary" data-action="bake-green-screen" data-clip-id="${escapeHtml(formClip.id || "")}" ${isBaking ? "disabled" : ""}>
              ${t("panel.animations.greenScreen.bakeButton")}
            </button>
          </div>
          <div class="asset-progress" data-role="bake-progress" ${isBaking ? "" : "hidden"}>
            <div class="asset-progress-label">
              <span data-role="bake-progress-label">${t("panel.animations.greenScreen.bakingBusy")}</span>
            </div>
            <progress data-role="bake-progress-bar" max="100"></progress>
          </div>
        </div>
        ` : `<p class="muted">${t("panel.animations.greenScreen.noBakeNeeded")}</p>`}
      </fieldset>
    `;
  }

  return `
    <fieldset class="form-group" data-role="green-screen-settings">
      <legend>${t("panel.animations.greenScreen.title")}</legend>
      <label class="checkbox-label">
        <input
          type="checkbox"
          name="greenScreenEnabled"
          ${checked(greenScreen.enabled)}
        >
        ${t("panel.animations.greenScreen.enabled")}
      </label>
      <div class="form-grid compact">
        <label>
          ${t("panel.animations.greenScreen.color")}
          <input type="color" name="greenScreenColor" value="${escapeHtml(greenScreen.color)}">
        </label>
        <label>
          ${t("panel.animations.greenScreen.tolerance")}
          <input type="range" name="greenScreenTolerance" value="${tolerancePercent}" min="0" max="100" step="1">
        </label>
        <label>
          ${t("panel.animations.greenScreen.softness")}
          <input type="range" name="greenScreenSoftness" value="${softnessPercent}" min="0" max="100" step="1">
        </label>
      </div>
      <p class="muted">${t("panel.animations.greenScreen.help")}</p>
      <aside
        class="green-screen-performance-notice"
        data-role="green-screen-bake-reminder"
        ${greenScreen.enabled ? "" : "hidden"}
      >
        <strong>${t("panel.animations.greenScreen.performanceTitle")}</strong>
        <p>${t("panel.animations.greenScreen.performanceHint")}</p>
        <div class="button-row">
          <button type="button" class="button-primary" data-action="bake-green-screen" data-clip-id="${escapeHtml(formClip.id || "")}" ${isBaking ? "disabled" : ""}>
            ${t("panel.animations.greenScreen.bakeButton")}
          </button>
        </div>
        <div class="asset-progress" data-role="bake-progress" ${isBaking ? "" : "hidden"}>
          <div class="asset-progress-label">
            <span data-role="bake-progress-label">${t("panel.animations.greenScreen.bakingBusy")}</span>
          </div>
          <progress data-role="bake-progress-bar" max="100"></progress>
        </div>
      </aside>
    </fieldset>
  `;
}

function renderAnimationPreview(formClip, formAsset, isVideoAsset) {
  const assetUrl = formAsset?.url || "";
  if (!assetUrl) return "";

  const assetLabel = formClip.asset || t("panel.animations.noAsset");
  if (isVideoAsset) {
    return `
      <div class="animation-preview-section">
        <div class="keyframe-preview-header">
          <span>${t("assets.referenced.preview")}</span>
          <span class="muted">${escapeHtml(assetLabel)}</span>
        </div>
        <div class="animation-preview-container">
          <video id="animation-preview-video" class="animation-preview-media keyframe-preview-source" muted loop autoplay playsinline preload="auto" src="${escapeHtml(assetUrl)}"></video>
          <canvas id="animation-preview-canvas" class="animation-preview-media" hidden></canvas>
        </div>
      </div>
    `;
  }

  return `
    <div class="animation-preview-section">
      <div class="keyframe-preview-header">
        <span>${t("assets.referenced.preview")}</span>
        <span class="muted">${escapeHtml(assetLabel)}</span>
      </div>
      <div class="animation-preview-container">
        <img class="animation-preview-media" src="${escapeHtml(assetUrl)}" alt="">
      </div>
    </div>
  `;
}

const MOVEMENT_DIRECTIONS = ["up", "down", "left", "right", "upLeft", "upRight", "downLeft", "downRight"];
const EASING_PRESETS = ["linear", "easeIn", "easeOut", "easeInOut"];

function renderAnimationBehaviorSettings(formClip) {
  return `
    <div class="form-group">
      <div class="animation-interrupt-help-row">
        <label class="checkbox-label">
          <input type="checkbox" name="interrupt" ${checked(formClip.interrupt)}>
          ${t("panel.animations.form.interrupt")}
        </label>
        ${renderFieldHelp(t("panel.animations.form.interruptHelp"))}
      </div>
    </div>
  `;
}

function renderAnimationMovementSettings(formClip) {
  const movement = formClip.movement || {};
  const easing = movement.easing || {};
  const hasMovement = Boolean(movement.direction);
  const movementSpeed = Number.isFinite(Number(movement.speed)) ? Number(movement.speed) : 120;
  const easingPreset = EASING_PRESETS.includes(easing.preset) ? easing.preset : "linear";
  const easingStrength = Number.isFinite(Number(easing.strength)) ? Number(easing.strength) : 1;
  const easeInMs = Number.isFinite(Number(easing.easeInMs)) ? Number(easing.easeInMs) : 0;
  const easeOutMs = Number.isFinite(Number(easing.easeOutMs)) ? Number(easing.easeOutMs) : 0;
  const startDelayMs = Number.isFinite(Number(easing.startDelayMs)) ? Number(easing.startDelayMs) : 0;
  const endDelayMs = Number.isFinite(Number(easing.endDelayMs)) ? Number(easing.endDelayMs) : 0;

  return `
    <fieldset class="form-group" data-role="animation-movement">
      <legend>${t("panel.animations.form.movementTitle")}</legend>
      <div class="animation-editor-compact-grid">
        <div class="form-group">
          <label for="anim-movement-direction">${t("panel.animations.form.movementDirection")}</label>
          <select id="anim-movement-direction" name="movementDirection">
            <option value="" ${selected(movement.direction || "", "")}>${t("panel.animations.form.movementNone")}</option>
            ${MOVEMENT_DIRECTIONS.map((dir) => `
              <option value="${dir}" ${selected(movement.direction || "", dir)}>${t(`rules.moveDirections.${dir}`)}</option>
            `).join("")}
          </select>
        </div>
        <div class="form-group">
          <label for="anim-movement-speed">${t("panel.animations.form.movementSpeed")}</label>
          <input type="number" id="anim-movement-speed" name="movementSpeed" value="${movementSpeed}" min="0" step="1">
        </div>
      </div>

      <div class="animation-movement-advanced" data-role="animation-easing" ${hasMovement ? "" : "hidden"}>
        <div class="animation-movement-advanced-title">${t("panel.animations.form.easingTitle")}</div>
        <div class="animation-editor-compact-grid">
          <div class="form-group">
            <label for="anim-easing-preset">${t("panel.animations.form.easingPreset")}</label>
            <select id="anim-easing-preset" name="easingPreset">
              ${EASING_PRESETS.map((preset) => `
                <option value="${preset}" ${selected(easingPreset, preset)}>${t(`panel.animations.form.easingPreset.${preset}`)}</option>
              `).join("")}
            </select>
          </div>
          <div class="form-group">
            <label for="anim-easing-strength">${t("panel.animations.form.easingStrength")}</label>
            <input type="number" id="anim-easing-strength" name="easingStrength" value="${easingStrength}" min="0.1" max="3" step="0.01">
          </div>
          <div class="form-group">
            <label for="anim-ease-in-ms">${t("panel.animations.form.easeInMs")}</label>
            <input type="number" id="anim-ease-in-ms" name="easeInMs" value="${easeInMs}" min="0" step="1">
          </div>
          <div class="form-group">
            <label for="anim-ease-out-ms">${t("panel.animations.form.easeOutMs")}</label>
            <input type="number" id="anim-ease-out-ms" name="easeOutMs" value="${easeOutMs}" min="0" step="1">
          </div>
          <div class="form-group">
            <label for="anim-start-delay">${t("panel.animations.form.startDelayMs")}</label>
            <input type="number" id="anim-start-delay" name="startDelayMs" value="${startDelayMs}" min="0" step="1">
          </div>
          <div class="form-group">
            <label for="anim-end-delay">${t("panel.animations.form.endDelayMs")}</label>
            <input type="number" id="anim-end-delay" name="endDelayMs" value="${endDelayMs}" min="0" step="1">
          </div>
        </div>
      </div>
    </fieldset>
  `;
}

function renderAnimationEditor(state, formClip, formAsset, formDurationMs, isDefault, isVideoAsset) {
  return `
    <div class="modal-backdrop">
      <section class="modal-panel animation-editor-modal" role="dialog" aria-modal="true" aria-labelledby="animation-editor-title">
        <div class="modal-header">
          <div>
            <h3 id="animation-editor-title">${isDefault ? t("panel.animations.defaultAnimation") : getAnimationName(formClip, t("panel.animations.addClip"))}</h3>
            <p>${formClip.asset ? escapeHtml(formClip.asset) : t("panel.animations.noAsset")}</p>
          </div>
          <button class="button-icon" type="button" data-action="close-animation-editor" aria-label="${t("common.close")}">&times;</button>
        </div>

        <div class="animation-editor-body">
          ${renderAnimationPreview(formClip, formAsset, isVideoAsset)}
          <form id="animation-form" data-form-type="animation">
            <input type="hidden" name="clipId" value="${escapeHtml(formClip.id || "")}">
            <input type="hidden" name="id" value="${escapeHtml(formClip.id || "")}">
            <input type="hidden" name="isDefault" value="${isDefault}">

            <div class="animation-editor-compact-grid">
              <div class="form-group">
                <label for="anim-name">${t("panel.animations.form.name")}</label>
                <input
                  type="text"
                  id="anim-name"
                  name="name"
                  value="${escapeHtml(formClip.name || "")}"
                  required
                >
              </div>

              <div class="form-group">
                <label for="anim-asset">${t("panel.animations.form.asset")}</label>
                ${renderAssetSelector(formClip.asset || "", getPackageAssets(state))}
              </div>

              ${isDefault ? '' : renderTypeSelector(formClip.type || "oneshot")}

              ${isDefault ? '' : `
                <div class="form-group" data-role="animation-duration" ${formClip.type !== "oneshot" ? "hidden" : ""}>
                  <label for="anim-duration">${t("panel.animations.form.duration")}</label>
                  <input
                    type="number"
                    id="anim-duration"
                    name="durationMs"
                    value="${formDurationMs}"
                    min="100"
                    step="1"
                  >
                </div>
              `}
            </div>

            ${isDefault ? '' : renderAnimationBehaviorSettings(formClip)}

            ${renderGreenScreenSettings(
              formClip,
              isVideoAsset,
              !isDefault && formClip.type === "keyframe",
              state.assetProgress && state.assetProgress.stage === "baking" ? state.assetProgress : null
            )}

            ${(!isDefault && formClip.type === "oneshot") ? renderAnimationMovementSettings(formClip) : ''}

            ${(!isDefault && formClip.type === "keyframe") ? `
              <div class="form-group">
                <button type="button" class="button-secondary" data-action="open-keyframe-editor" data-clip-id="${escapeHtml(formClip.id || "")}">
                  ${t("panel.animations.keyframeSettings")}
                </button>
              </div>
            ` : ''}

            <div class="button-row">
              <button type="button" data-action="close-animation-editor">
                ${t("common.cancel")}
              </button>
              <button type="submit" class="button-primary">
                ${t("common.save")}
              </button>
              ${isDefault || !formClip.id ? '' : `
                <button type="button" class="button-danger" data-action="delete-animation">
                  ${t("common.delete")}
                </button>
              `}
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

/**
 * Render animations tab
 * @param {object} state - Panel state
 * @param {object} config - Configuration object
 * @returns {string} Animations HTML
 */
export function renderAnimations(state, config) {
  const animations = getConfigAnimations(config);
  const selectedClipId = state.selectedClipId === undefined ? animations.default.id : state.selectedClipId;

  // Find selected clip
  let selectedClip;
  if (selectedClipId === "") {
    selectedClip = null;
  } else if (selectedClipId === animations.default.id) {
    selectedClip = { ...animations.default, type: "default" };
  } else {
    selectedClip = animations.clips.find(c => c.id === selectedClipId) || animations.clips[0];
  }

  // If no clip selected, default to default animation
  if (!selectedClip && selectedClipId !== "") {
    selectedClip = { ...animations.default, type: "default" };
  }

  const isDefault = Boolean(selectedClip && selectedClip.id === animations.default.id);
  const baseFormClip = selectedClip || {
    id: "",
    name: "",
    asset: "",
    type: "oneshot",
    durationMs: 900
  };
  const draft = state.animationDraft && state.animationDraft.selectedClipId === selectedClipId
    ? state.animationDraft.clip
    : null;
  const formClip = draft ? { ...baseFormClip, ...draft } : baseFormClip;

  // Build clip list (default + clips)
  const allClips = [
    { ...animations.default, type: "default" },
    ...animations.clips
  ];
  const packageAssets = getPackageAssets(state);
  const formAsset = packageAssets.find((asset) => asset.asset === formClip.asset);
  const formDurationMs = getPositiveDurationMs(formClip.durationMs) || getAssetDurationMs(formAsset) || 900;
  const isVideoAsset = isVideoAssetPath(formClip.asset, formAsset);

  return `
    ${renderHeader(t("panel.animations.title"))}
    ${renderHelpSection()}

    <section class="panel-section">
      <div class="section-header">
        <h3>${t("panel.animations.title")}</h3>
        <span class="muted">${allClips.length}</span>
      </div>
      <div class="section-body">
        <div class="item-list animation-list" role="list">
          ${allClips.map(clip =>
            renderAnimationCard(
              clip,
              clip.id === animations.default.id,
              clip.id === selectedClipId
            )
          ).join("")}
          ${renderAddAnimationRow()}
        </div>
      </div>
    </section>

    ${state.animationEditorOpen ? renderAnimationEditor(state, formClip, formAsset, formDurationMs, isDefault, isVideoAsset) : ""}
    ${(state.keyframeEditorOpen && state.keyframeEditorClipId) ? renderKeyframeEditor(state) : ""}
  `;
}
