/**
 * Keyframe editor modal component
 * Click on empty track to add keyframes.
 * Click a keyframe to select; press Delete to remove.
 * Drag keyframe handles to reposition.
 * Live preview scrubs the asset below.
 */

import { escapeHtml } from "../ui/utils.js";
import { t } from "../../../shared/i18n.js";
import { DEFAULT_KEYFRAMES, normalizeKeyframes } from "../panel-state.js";

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function isVideoAsset(assetPath) {
  const ext = assetPath.split(".").pop().toLowerCase();
  return ["webm", "mp4", "mov"].includes(ext);
}

function isGifAsset(assetPath) {
  return assetPath.split(".").pop().toLowerCase() === "gif";
}

export function renderKeyframeEditor(state) {
  const keyframes = normalizeKeyframes(state.keyframeEditorKeyframes);
  const clipId = state.keyframeEditorClipId || "";
  const selectedIndex = state.keyframeEditorSelectedIndex;
  const assetUrl = state.keyframeEditorAssetUrl || "";
  const assetPath = state.keyframeEditorAssetPath || "";
  const isVideo = isVideoAsset(assetPath);
  const isGif = isGifAsset(assetPath);
  const greenScreenEnabled = isVideo && state.keyframeEditorGreenScreen?.enabled === true;

  return `
    <div class="modal-backdrop">
      <section class="modal-panel keyframe-editor-modal" role="dialog" aria-modal="true" aria-labelledby="keyframe-editor-title">
        <div class="modal-header">
          <div>
            <h3 id="keyframe-editor-title">${t("panel.animations.keyframeEditor.title")}</h3>
            <p>${t("panel.animations.keyframeEditor.description")}</p>
          </div>
          <button class="button-icon" type="button" data-action="close-keyframe-editor" aria-label="${t("common.close")}">&times;</button>
        </div>
        <div class="keyframe-editor-body">
          <input type="hidden" name="keyframeClipId" value="${escapeHtml(clipId)}">

          <div class="keyframe-track-wrapper">
            <div class="keyframe-track-labels" data-role="keyframe-labels">
              ${keyframes.map((value, index) => `
                <span class="keyframe-label${index === selectedIndex ? " selected" : ""}" data-keyframe-index="${index}" style="left: ${formatPercent(value.output)}">${formatPercent(value.input)}</span>
              `).join("")}
            </div>
            <div class="keyframe-track" data-role="keyframe-track" tabindex="0">
              <div class="keyframe-track-line"></div>
              ${keyframes.map((value, index) => `
                <button
                  type="button"
                  class="keyframe-handle${index === selectedIndex ? " selected" : ""}"
                  data-keyframe-index="${index}"
                  data-keyframe-input="${value.input}"
                  data-keyframe-output="${value.output}"
                  style="left: ${formatPercent(value.output)}"
                  title="${formatPercent(value.input)}"
                  aria-label="${t("panel.animations.keyframeEditor.keyframeAt", { value: formatPercent(value.input) })}"
                ></button>
              `).join("")}
            </div>
            <div class="keyframe-track-hint">${t("panel.animations.keyframeEditor.trackHint")}</div>
          </div>

          <div class="keyframe-preview-section">
            <div class="keyframe-preview-header">
              <span>${t("panel.animations.keyframeEditor.preview")}</span>
              <span class="muted">${escapeHtml(assetPath || t("panel.animations.noAsset"))}</span>
            </div>
            <div class="keyframe-preview-container">
              ${isVideo && greenScreenEnabled ? `
                <video id="keyframe-preview-video" class="keyframe-preview-source" muted playsinline preload="auto" src="${escapeHtml(assetUrl)}"></video>
                <canvas id="keyframe-preview-green-screen" class="keyframe-preview-media"></canvas>
              ` : isVideo ? `
                <video id="keyframe-preview-video" class="keyframe-preview-media" muted playsinline preload="auto" src="${escapeHtml(assetUrl)}"></video>
              ` : isGif ? `
                <canvas id="keyframe-preview-canvas" class="keyframe-preview-media"></canvas>
              ` : assetUrl ? `
                <img id="keyframe-preview-image" class="keyframe-preview-media" src="${escapeHtml(assetUrl)}" alt="">
              ` : `
                <div class="keyframe-preview-empty">${t("panel.animations.noAsset")}</div>
              `}
            </div>
          </div>
        </div>

        <div class="form-actions modal-actions">
          <button type="button" class="button-secondary" data-action="reset-keyframes-default">
            ${t("panel.animations.keyframeEditor.resetDefault")}
          </button>
          <button type="button" data-action="close-keyframe-editor">
            ${t("common.done")}
          </button>
        </div>
      </section>
    </div>
  `;
}

export { DEFAULT_KEYFRAMES };
