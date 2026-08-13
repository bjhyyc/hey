/**
 * Asset and petpack handlers
 */

import { showBanner, hideBanner } from "../ui/banner.js";
import { getAssetPackageId } from "../tabs/assets.js";
import { removeConfigAssetReferences, applyBakedTransparentAsset, isAssetReferenced } from "../panel-state.js";
import { t } from "../../../shared/i18n.js";
import { createRendererLogger } from "../../shared/logger.js";

const logger = createRendererLogger("panel-asset-handler");

function createOperationId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getPathExtension(filePath) {
  const filename = String(filePath || "").split(/[\\/]/).filter(Boolean).pop() || "";
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

function isMovAsset(filePath) {
  return getPathExtension(filePath) === ".mov";
}

function setMovNotice(sourcePath, state) {
  state.assetProgress = isMovAsset(sourcePath)
    ? { stage: "notice", percent: null }
    : null;
}

/**
 * Pick asset file
 * @param {object} api - API object
 * @param {object} state - Panel state
 * @param {Function} render - Render function
 * @returns {Promise<void>}
 */
export async function pickAsset(api, state, render) {
  if (!api || !api.assets || !api.assets.pick) {
    showBanner(t("assets.import.pickerApiUnavailable"));
    return;
  }

  try {
    const sourcePath = await api.assets.pick();
    if (!sourcePath) return;

    state.selectedAssetPath = sourcePath;
    state.selectedAssetResult = null;
    setMovNotice(sourcePath, state);
    hideBanner();
    render();
  } catch (error) {
    showBanner(t("assets.import.pickerFailed", { reason: error.message || error }));
  }
}

/**
 * Import asset from form
 * @param {HTMLFormElement} form - Asset import form
 * @param {object} api - API object
 * @param {object} state - Panel state
 * @param {Function} render - Render function
 * @returns {Promise<void>}
 */
export async function importAssetFromForm(form, api, state, render, refreshPackagesAndAssets) {
  if (!api || !api.assets || !api.assets.import) {
    showBanner(t("assets.import.apiUnavailable"));
    return;
  }

  const formData = new FormData(form);
  const sourcePath = state.selectedAssetPath;
  const packageId = (state.config && state.config.currentPackageId) || "default-pet";
  const importName = String(formData.get("importName") || "").trim();

  state.selectedAssetPackageId = packageId;

  if (!sourcePath) {
    showBanner(t("assets.import.chooseFileFirst"));
    return;
  }

  state.savingKey = "asset";
  state.assetProgress = {
    operationId: createOperationId("asset-import"),
    stage: isMovAsset(sourcePath) ? "converting" : "copying",
    percent: 0
  };
  render();

  try {
    const result = await api.assets.import(sourcePath, packageId, importName, state.assetProgress.operationId);
    state.selectedAssetResult = result;

    if (!result || !result.ok) {
      showBanner((result && result.error) || t("assets.import.error"));
      setMovNotice(sourcePath, state);
      render();
      return;
    }

    state.selectedPackageAsset = result.asset;
    if (refreshPackagesAndAssets) {
      await refreshPackagesAndAssets();
    }
    state.selectedAssetPath = "";
    state.selectedAssetResult = null;
    state.assetProgress = null;
    const conversionMessage = result.convertedFrom === ".mov"
      ? t("assets.import.movConverted")
      : "";
    showBanner(t("assets.import.successConfigure", { asset: result.asset, conversion: conversionMessage }), "success");
  } catch (error) {
    state.selectedAssetResult = { ok: false, error: error.message || String(error) };
    setMovNotice(sourcePath, state);
    showBanner(t("assets.import.failedWithReason", { reason: error.message || error }));
  } finally {
    state.savingKey = "";
    render();
  }
}

export async function selectAssetFromDrop(event, api, state, render) {
  const dropTarget = event.target && event.target.closest
    ? event.target.closest('[data-drop-target="import-asset"]')
    : null;
  if (!dropTarget) return false;

  event.preventDefault();
  event.stopPropagation();
  dropTarget.classList.remove("drag-over");

  if (!api || !api.assets || !api.assets.getDroppedFilePath) {
    showBanner(t("assets.drop.apiUnavailable"));
    return true;
  }

  const files = event.dataTransfer && event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
  const file = files[0];
  if (!file) return true;

  const sourcePath = api.assets.getDroppedFilePath(file);
  if (!sourcePath) {
    showBanner(t("assets.drop.pathFailed"));
    return true;
  }

  state.selectedAssetPath = sourcePath;
  state.selectedAssetResult = null;
  setMovNotice(sourcePath, state);
  if (isMovAsset(sourcePath)) {
    showBanner(t("assets.import.movWillConvert"), "success");
  } else {
    hideBanner();
  }
  render();
  return true;
}

export async function replaceSelectedPackageAssetFromDrop(event, api, state, render, refreshPackagesAndAssets) {
  const dropTarget = event.target && event.target.closest
    ? event.target.closest('[data-drop-target="replace-package-asset"]')
    : null;
  if (!dropTarget) return false;

  event.preventDefault();
  event.stopPropagation();
  dropTarget.classList.remove("drag-over");

  if (!api || !api.assets || !api.assets.replace || !api.assets.getDroppedFilePath) {
    showBanner(t("assets.replace.apiUnavailable"));
    return true;
  }

  const targetAssetPath = state.selectedPackageAsset || dropTarget.dataset.asset;
  if (!targetAssetPath) {
    showBanner(t("assets.replace.selectFirst"));
    return true;
  }

  const files = event.dataTransfer && event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
  const file = files[0];
  if (!file) {
    showBanner(t("assets.replace.dropOne"));
    return true;
  }

  const sourcePath = api.assets.getDroppedFilePath(file);
  if (!sourcePath) {
    showBanner(t("assets.drop.pathFailed"));
    return true;
  }

  const packageId = getAssetPackageId("", state.config);
  state.savingKey = "asset-replace";
  state.assetProgress = {
    operationId: createOperationId("asset-replace"),
    stage: isMovAsset(sourcePath) ? "converting" : "copying",
    percent: 0
  };
  render();

  try {
    const result = await api.assets.replace(sourcePath, packageId, targetAssetPath, state.assetProgress.operationId);
    if (!result || !result.ok) {
      showBanner((result && result.error) || t("assets.replace.failed"));
      return true;
    }

    if (refreshPackagesAndAssets) {
      await refreshPackagesAndAssets();
    }
    state.selectedPackageAsset = result.asset || targetAssetPath;
    const conversionMessage = result.convertedFrom === ".mov"
      ? t("assets.import.movConverted")
      : "";
    showBanner(t("assets.replace.success", { asset: state.selectedPackageAsset, conversion: conversionMessage }), "success");
  } catch (error) {
    showBanner(t("assets.replace.failedWithReason", { reason: error.message || error }));
  } finally {
    state.savingKey = "";
    state.assetProgress = null;
    render();
  }

  return true;
}

/**
 * Delete referenced asset
 * @param {string} assetPath - Asset path to delete
 * @param {object} api - API object
 * @param {object} state - Panel state
 * @param {Function} render - Render function
 * @returns {Promise<void>}
 */
export async function deleteReferencedAsset(assetPath, api, state, render) {
  if (!api || !api.assets || !api.assets.delete) {
    showBanner(t("assets.delete.apiUnavailable"));
    return;
  }

  state.savingKey = "asset-delete";
  render();

  try {
    const result = await api.assets.delete(assetPath, getAssetPackageId("", state.config));
    if (!result || !result.ok) {
      showBanner((result && result.error) || t("assets.delete.failed"));
      return;
    }

    await api.config.save(removeConfigAssetReferences(state.config, assetPath));
    state.config = await api.config.load();
    showBanner(t("assets.delete.success", { asset: assetPath }), "success");
  } catch (error) {
    showBanner(t("assets.delete.failedWithReason", { reason: error.message || error }));
  } finally {
    state.savingKey = "";
    render();
  }
}

function readGreenScreenParamsFromForm(form) {
  if (!form || !form.elements) return { color: "#00ff00", tolerance: 0.22, softness: 0.08 };
  const rawColor = String(form.elements.greenScreenColor?.value || "#00ff00");
  const color = /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : "#00ff00";
  const clampUnit = (value, fallback) => {
    const n = Number(value) / 100;
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
  };
  return {
    color,
    tolerance: clampUnit(form.elements.greenScreenTolerance?.value, 0.22),
    softness: clampUnit(form.elements.greenScreenSoftness?.value, 0.08)
  };
}

/**
 * Bake green-screen video into a transparent webm. Keyframe editors update
 * their unsaved draft so the user can save afterward; persisted real-time
 * clips keep the existing one-click repoint-and-save flow.
 *
 * @param {string} clipId - Clip id whose asset should be baked
 * @param {HTMLFormElement} form - Animation form holding the key params
 * @param {object} api - API object
 * @param {object} state - Panel state
 * @param {Function} render - Render function
 * @param {Function} [refreshPackagesAndAssets] - Refresh callback
 */
export async function handleBakeGreenScreen(clipId, form, api, state, render, refreshPackagesAndAssets) {
  if (!api || !api.assets || !api.assets.bakeGreenScreen) {
    showBanner(t("assets.delete.apiUnavailable"));
    return;
  }

  const animations = state.config?.animations || { default: {}, clips: [] };
  const clip = clipId === animations.default?.id
    ? animations.default
    : (animations.clips || []).find((item) => item && item.id === clipId);
  const draft = state.animationDraft?.clip;
  const isKeyframeDraftBake = Boolean(
    draft
    && draft.type === "keyframe"
    && draft.greenScreenBakeEnabled === true
    && draft.asset
  );

  if (!isKeyframeDraftBake && (!clip || !clip.asset)) {
    showBanner(t("panel.animations.greenScreen.bakeNeedsSave"));
    return;
  }

  const sourceAssetPath = isKeyframeDraftBake ? draft.asset : clip.asset;
  const params = readGreenScreenParamsFromForm(form);
  const packageId = getAssetPackageId("", state.config);
  const operationId = createOperationId("asset-bake");

  state.savingKey = "asset-bake";
  state.assetProgress = { operationId, stage: "baking", percent: 0 };
  logger.info("green screen bake started", {
    clipId: clipId || draft?.id || "",
    sourceAssetPath,
    mode: isKeyframeDraftBake ? "keyframe-draft" : "persisted-clip",
    operationId
  });
  render();

  try {
    const result = await api.assets.bakeGreenScreen(packageId, sourceAssetPath, params, operationId);
    if (!result || !result.ok) {
      logger.warn("green screen bake rejected", {
        clipId: clipId || draft?.id || "",
        sourceAssetPath,
        operationId,
        error: (result && result.error) || "unknown"
      });
      showBanner(t("panel.animations.greenScreen.bakeFailed", { reason: (result && result.error) || "unknown" }));
      return;
    }

    if (isKeyframeDraftBake) {
      const { greenScreen: _greenScreen, greenScreenBakeEnabled: _bakeEnabled, ...draftWithoutGreenScreen } = draft;
      state.animationDraft = {
        ...state.animationDraft,
        clip: {
          ...draftWithoutGreenScreen,
          asset: result.asset,
          greenScreenBakeEnabled: false
        }
      };
      state.keyframeEditorAssetPath = result.asset;
      state.keyframeEditorGreenScreen = null;
      if (refreshPackagesAndAssets) {
        await refreshPackagesAndAssets();
      }
      const bakedAsset = Array.isArray(state.packageAssets)
        ? state.packageAssets.find((asset) => asset?.asset === result.asset)
        : null;
      state.keyframeEditorAssetUrl = bakedAsset?.url || "";
      logger.info("green screen bake completed for keyframe draft", {
        clipId: clipId || draft.id || "",
        sourceAssetPath,
        bakedAssetPath: result.asset,
        operationId
      });
      showBanner(t("panel.animations.greenScreen.bakeDraftSuccess", { asset: result.asset }), "success");
      return;
    }

    // Non-keyframe real-time clips retain the existing one-click bake flow:
    // re-point the saved clip, drop runtime keying, then reload config.
    await api.config.save(applyBakedTransparentAsset(state.config, clipId, result.asset));
    state.config = await api.config.load();
    state.animationDraft = null;
    if (refreshPackagesAndAssets) {
      await refreshPackagesAndAssets();
    }
    logger.info("green screen bake completed for persisted clip", {
      clipId,
      sourceAssetPath,
      bakedAssetPath: result.asset,
      operationId
    });
    showBanner(t("panel.animations.greenScreen.bakeSuccess", { asset: result.asset }), "success");

    // Offer to delete the original source if nothing references it anymore.
    if (!isAssetReferenced(state.config, sourceAssetPath)) {
      const confirmed = typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(t("panel.animations.greenScreen.sourceUnusedDeletePrompt", { asset: sourceAssetPath }))
        : false;
      if (confirmed) {
        const deleteResult = await api.assets.delete(sourceAssetPath, packageId);
        if (deleteResult && deleteResult.ok) {
          state.config = await api.config.load();
          if (refreshPackagesAndAssets) {
            await refreshPackagesAndAssets();
          }
          showBanner(t("panel.animations.greenScreen.sourceDeleted", { asset: sourceAssetPath }), "success");
        } else {
          showBanner((deleteResult && deleteResult.error) || t("assets.delete.failed"));
        }
      }
    }
  } catch (error) {
    logger.error("green screen bake failed", {
      clipId: clipId || draft?.id || "",
      sourceAssetPath,
      operationId,
      error: error.message || String(error)
    });
    showBanner(t("panel.animations.greenScreen.bakeFailed", { reason: error.message || error }));
  } finally {
    state.savingKey = "";
    state.assetProgress = null;
    render();
  }
}

/**
 * Import petpack from picker
 * @param {object} api - API object
 * @param {object} state - Panel state
 * @param {Function} render - Render function
 * @returns {Promise<void>}
 */
export async function importPetpackFromPicker(api, state, render, refreshPackagesAndAssets) {
  if (!api || !api.petpack || !api.petpack.import) {
    showBanner(t("assets.petpack.importApiUnavailable"));
    return;
  }

  state.savingKey = "petpack-import";
  state.petpackResult = null;
  render();

  try {
    const result = await api.petpack.import();
    if (!result) {
      state.petpackResult = null;
      return;
    }

    state.petpackResult = result;
    if (!result.ok) {
      showBanner(result.error || t("assets.petpack.importFailed"));
      return result;
    }

    if (result.packageId) {
      const nextConfig = api.packages && api.packages.switch
        ? await api.packages.switch(result.packageId)
        : await api.config.save({
          ...state.config,
          currentPackageId: result.packageId
        });
      if (nextConfig && nextConfig.ok === false) {
        showBanner(nextConfig.error || t("assets.package.switchFailed"));
        return nextConfig;
      }
      state.config = nextConfig;
      state.selectedAssetPackageId = result.packageId;
    }

    if (refreshPackagesAndAssets) {
      await refreshPackagesAndAssets();
    }

    showBanner(t("assets.petpack.importSuccess", { packageId: result.packageId }), "success");
    logger.info("Petpack import completed", { packageId: result.packageId || "" });
    return result;
  } catch (error) {
    state.petpackResult = { ok: false, error: error.message || String(error) };
    showBanner(t("assets.petpack.importFailedWithReason", { reason: error.message || error }));
    return state.petpackResult;
  } finally {
    state.savingKey = "";
    render();
  }
}

/**
 * Export current petpack
 * @param {object} api - API object
 * @param {object} state - Panel state
 * @param {Function} render - Render function
 * @returns {Promise<void>}
 */
export async function exportCurrentPetpack(api, state, render, packageIdOverride = "") {
  if (!api || !api.petpack || !api.petpack.export) {
    showBanner(t("assets.petpack.exportApiUnavailable"));
    return;
  }

  const packageId = packageIdOverride || (state.config && state.config.currentPackageId) || "default-pet";
  state.savingKey = "petpack-export";
  state.petpackResult = null;
  render();

  try {
    const result = await api.petpack.export(packageId);
    if (!result) {
      state.petpackResult = null;
      return;
    }

    state.petpackResult = result;
    if (!result.ok) {
      showBanner(result.error || t("assets.petpack.exportFailed"));
      return;
    }

    showBanner(result.targetPath
      ? t("assets.petpack.exportSuccess", { packageId: result.packageId, targetPath: result.targetPath })
      : t("assets.petpack.exportSuccessSimple", { packageId: result.packageId }), "success");
  } catch (error) {
    state.petpackResult = { ok: false, error: error.message || String(error) };
    showBanner(t("assets.petpack.exportFailedWithReason", { reason: error.message || error }));
  } finally {
    state.savingKey = "";
    render();
  }
}
