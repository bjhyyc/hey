/**
 * Assets tab
 */

import { escapeHtml, disabled as disabledHelper, getPathFilename, getPathExtension, toFilePreviewUrl } from "../ui/utils.js";
import { renderHeader } from "../ui/header.js";
import { t } from "../../../shared/i18n.js";

const IMAGE_ASSET_EXTENSIONS = [".gif", ".webp", ".png", ".svg"];
const VIDEO_ASSET_EXTENSIONS = [".webm", ".mp4", ".mov"];

export function getAssetPackageId(selectedPackageId, config) {
  return selectedPackageId || (config && config.currentPackageId) || "default-pet";
}

function getConfigAnimations(config) {
  const animations = config?.animations || {};
  return {
    default: animations.default || { id: "idle", asset: "" },
    clips: Array.isArray(animations.clips) ? animations.clips : []
  };
}

function getAnimationAssetMap(config) {
  const animations = getConfigAnimations(config);
  const entries = [];
  if (animations.default.asset) {
    entries.push({ id: animations.default.id, name: animations.default.name, asset: animations.default.asset, isDefault: true });
  }
  animations.clips.forEach((clip) => {
    if (clip && clip.id && clip.asset) {
      entries.push({ id: clip.id, name: clip.name, asset: clip.asset, isDefault: false });
    }
  });
  return entries;
}

export function getAssetReferences(assetPath, config) {
  const references = [];
  const animations = getAnimationAssetMap(config);
  const animationNamesById = new Map();

  animations.forEach((animation) => {
    if (animation.asset !== assetPath) return;
    const animationName = animation.name || animation.id;
    animationNamesById.set(animation.id, animationName);
    references.push(t("assets.references.animation", {
      name: animationName,
      defaultLabel: animation.isDefault ? t("assets.references.defaultLabel") : ""
    }));
  });

  const rules = Array.isArray(config?.triggerRules) ? config.triggerRules : [];
  rules.forEach((rule) => {
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    actions.forEach((action) => {
      if (action && action.type === "playAnimation" && animationNamesById.has(action.animation)) {
        references.push(t("assets.references.rule", {
          name: rule.name || rule.id || t("assets.references.unnamed"),
          animation: animationNamesById.get(action.animation)
        }));
      }
    });
  });

  return references;
}

function getPreviewUrl(asset) {
  return asset && (asset.url || (asset.sourcePath ? toFilePreviewUrl(asset.sourcePath) : ""));
}

function renderAssetPreview(assetOrPath, ext, options = {}) {
  const sourcePath = typeof assetOrPath === "string" ? assetOrPath : "";
  const asset = typeof assetOrPath === "object" && assetOrPath ? assetOrPath : null;
  const src = asset ? getPreviewUrl(asset) : (sourcePath ? toFilePreviewUrl(sourcePath) : "");
  const assetExt = ext || asset?.ext || getPathExtension(sourcePath || asset?.asset || "");
  const name = asset?.name || getPathFilename(sourcePath || asset?.asset || "");
  const showControls = options.controls !== false;

  if (!src) {
    return `<div class="empty-state compact">${t("assets.preview.empty")}</div>`;
  }

  if (IMAGE_ASSET_EXTENSIONS.includes(assetExt)) {
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(name)}">`;
  }
  if (VIDEO_ASSET_EXTENSIONS.includes(assetExt)) {
    return `<video src="${escapeHtml(src)}" ${showControls ? "controls " : ""}muted loop autoplay playsinline preload="auto"></video>`;
  }
  return `<div class="empty-state compact">${t("assets.preview.unavailable")}</div>`;
}

function renderAssetResult(result) {
  const ok = result && result.ok;
  const message = ok
    ? t("assets.import.success", { asset: result.asset })
    : (result && result.error) || t("assets.import.error");

  return `<div class="asset-result ${ok ? "success" : "error"}">${escapeHtml(message)}</div>`;
}

function renderMovNotice(sourcePath) {
  if (getPathExtension(sourcePath) !== ".mov") return "";
  return `
    <div class="asset-result warning">
      ${t("assets.import.movNotice")}
    </div>
  `;
}

function renderAssetProgress(progress) {
  if (!progress) return "";
  const percent = Number(progress.percent);
  const hasPercent = Number.isFinite(percent);
  const label = progress.stage === "converting"
    ? t("assets.progress.convertingMov")
    : t("assets.progress.importingAsset");
  return `
    <div class="asset-progress">
      <div class="asset-progress-label">
        <span>${escapeHtml(label)}</span>
        <span>${hasPercent ? `${Math.round(percent)}%` : ""}</span>
      </div>
      <progress max="100" ${hasPercent ? `value="${Math.max(0, Math.min(100, Math.round(percent)))}"` : ""}></progress>
    </div>
  `;
}

function renderPackageList(state, config) {
  const currentPackageId = getAssetPackageId("", config);
  const packages = Array.isArray(state.packageList) && state.packageList.length
    ? state.packageList
    : [{ packageId: currentPackageId, isCurrent: true, source: "user" }];

  return `
    <section class="panel-section">
      <div class="section-header">
        <h3>${t("assets.package.title")}</h3>
        <div class="form-actions flush">
          <button type="button" data-action="toggle-package-edit">${state.packageEditMode ? t("common.cancel") : t("common.edit")}</button>
          <button type="button" data-action="import-petpack" ${disabledHelper("petpack-import", state.savingKey)}>${state.savingKey === "petpack-import" ? t("common.importing") : t("assets.petpack.import")}</button>
          <button type="button" data-action="start-new-package">${t("assets.package.new")}</button>
        </div>
      </div>
      <div class="section-body">
        ${state.isCreatingPackage ? `
          <div class="item-row package-row">
            <div class="field">
              <label for="new-package-id">${t("assets.package.newPrompt")}</label>
              <input id="new-package-id" type="text" data-role="new-package-id" placeholder="my-pet">
            </div>
            <div class="form-actions flush">
              <button type="button" class="button-primary" data-action="create-package">${t("common.add")}</button>
              <button type="button" data-action="cancel-new-package">${t("common.cancel")}</button>
            </div>
          </div>
        ` : ""}
        <div class="item-list">
          ${packages.map((item) => `
            <div class="item-row package-row">
              <div>
                <strong>${escapeHtml(item.packageId)}</strong>
                ${item.isCurrent ? `<span class="muted">${t("assets.package.current")}</span>` : ""}
              </div>
              <div class="form-actions flush">
                <button type="button" data-action="switch-package" data-package-id="${escapeHtml(item.packageId)}" ${item.isCurrent ? "disabled" : ""}>${t("assets.package.switch")}</button>
                <button type="button" data-action="export-package" data-package-id="${escapeHtml(item.packageId)}">${t("assets.package.export")}</button>
                ${state.packageEditMode && item.packageId !== "default-pet"
                  ? `<button type="button" class="button-danger" data-action="delete-package" data-package-id="${escapeHtml(item.packageId)}">${t("common.delete")}</button>`
                  : ""}
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderImportSection(state, config) {
  const sourcePath = state.selectedAssetPath;
  const sourceName = getPathFilename(sourcePath);
  const ext = getPathExtension(sourcePath);
  const disabled = (key) => disabledHelper(key, state.savingKey);

  return `
    <section class="panel-section">
      <div class="section-header"><h3>${t("assets.import.title")}</h3></div>
      <div class="section-body">
        <form id="asset-import-form" data-drop-target="import-asset">
          <div class="asset-grid">
            <div class="asset-preview" data-drop-target="import-asset">
              ${renderAssetPreview(sourcePath, ext)}
            </div>
            <div class="asset-controls">
              <div class="form-actions flush">
                <button type="button" data-action="pick-asset">${t("assets.import.chooseFile")}</button>
                <button class="button-primary" type="submit" ${sourcePath ? "" : "disabled"} ${disabled("asset")}>${state.savingKey === "asset" ? t("common.importing") : t("assets.import.button")}</button>
              </div>
              <div class="field">
                <span class="field-label">${t("assets.import.selectedFile")}</span>
                ${sourcePath ? `
                  <strong>${escapeHtml(sourceName)}</strong>
                  <code class="code-line breakable">${escapeHtml(sourcePath)}</code>
                ` : `<span class="muted">${t("assets.import.noFileSelected")}</span>`}
              </div>
              <div class="field">
                <label for="asset-import-name">${t("assets.import.name")}</label>
                <input id="asset-import-name" name="importName" type="text" value="${escapeHtml(sourceName ? sourceName.replace(/\.[^.]+$/, "") : "")}" placeholder="wave">
              </div>
              ${renderMovNotice(sourcePath)}
              ${renderAssetProgress(state.assetProgress)}
              ${state.selectedAssetResult ? renderAssetResult(state.selectedAssetResult) : ""}
            </div>
          </div>
        </form>
      </div>
    </section>
  `;
}

export function renderPackageAssetDetail(selected, config) {
  const references = selected ? getAssetReferences(selected.asset, config) : [];

  return `
    <div class="asset-detail" data-drop-target="replace-package-asset" data-asset="${escapeHtml(selected?.asset || "")}">
      <div class="asset-preview large">${selected ? renderAssetPreview(selected) : ""}</div>
      <div class="asset-drop-hint">
        ${selected ? t("assets.replaceDropHint") : t("assets.replaceDropNoSelection")}
      </div>
      <div class="field">
        <span class="field-label">${t("assets.references.title")}</span>
        ${references.length ? `<ul>${references.map((reference) => `<li>${escapeHtml(reference)}</li>`).join("")}</ul>` : `<span class="muted">${t("assets.references.empty")}</span>`}
      </div>
    </div>
  `;
}

function renderPackageAssets(state, config) {
  const assets = Array.isArray(state.packageAssets) ? state.packageAssets : [];
  const selected = assets.find((asset) => asset.asset === state.selectedPackageAsset) || assets[0] || null;

  return `
    <section class="panel-section">
      <div class="section-header">
        <h3>${t("assets.packageAssets.title")}</h3>
        <span class="muted">${t("assets.referenced.countPlural", { count: assets.length })}</span>
        <button type="button" data-action="toggle-asset-edit">${state.assetEditMode ? t("common.cancel") : t("common.edit")}</button>
      </div>
      <div class="section-body">
        ${assets.length ? `
          <div class="asset-browser">
            <div class="item-list">
              ${assets.map((asset) => `
                <div
                  class="item-row package-asset-row clickable-row"
                  aria-selected="${asset.asset === selected?.asset}"
                  data-action="select-package-asset"
                  data-asset="${escapeHtml(asset.asset)}"
                >
                  <span class="asset-thumb">${renderAssetPreview(asset, undefined, { controls: false })}</span>
                  <span>
                    <strong>${escapeHtml(asset.name || getPathFilename(asset.asset))}</strong>
                    <code>${escapeHtml(asset.asset)}</code>
                  </span>
                  ${state.assetEditMode ? `<button type="button" class="button-danger" data-action="delete-package-asset" data-asset="${escapeHtml(asset.asset)}">${t("common.delete")}</button>` : ""}
                </div>
              `).join("")}
            </div>
            ${renderPackageAssetDetail(selected, config)}
          </div>
        ` : `<div class="empty-state">${t("assets.packageAssets.empty")}</div>`}
      </div>
    </section>
  `;
}

export function renderAssets(state, config) {
  return `
    ${renderHeader(t("assets.title"), t("assets.description"))}
    ${renderPackageList(state, config)}
    ${renderImportSection(state, config)}
    ${renderPackageAssets(state, config)}
  `;
}
