/**
 * Display tab
 */

import { checked, disabled as disabledHelper } from "../ui/utils.js";
import { renderHeader } from "../ui/header.js";
import { t } from "../../../shared/i18n.js";
import { DEFAULT_DISPLAY } from "../panel-state.js";

/**
 * Get display settings with defaults
 * @param {object} config - Configuration object
 * @returns {object} Display settings
 */
function getDisplay(config) {
  return {
    ...DEFAULT_DISPLAY,
    ...(config && config.display ? config.display : {})
  };
}

/**
 * Render display tab
 * @param {object} state - Panel state
 * @param {object} config - Configuration object
 * @returns {string} Display HTML
 */
export function renderDisplay(state, config) {
  const display = getDisplay(config);
  const disabled = (key) => disabledHelper(key, state.savingKey);

  return `
    ${renderHeader(t("display.title"), t("display.description"))}
    <section class="panel-section">
      <div class="section-header"><h3>${t("display.settings.title")}</h3></div>
      <div class="section-body">
        <form id="display-form">
          <div class="grid-2">
            <div class="field">
              <label for="display-scale">${t("display.scale")} <span id="scale-value">${Math.round(display.scale * 100)}%</span></label>
              <input id="display-scale" name="scale" type="range" min="50" max="300" step="1" value="${Math.round(display.scale * 100)}">
            </div>
            <div class="field">
              <label for="display-opacity">${t("display.opacity")} <span id="opacity-value">${Math.round(display.opacity * 100)}%</span></label>
              <input id="display-opacity" name="opacity" type="range" min="50" max="100" step="1" value="${Math.round(display.opacity * 100)}">
            </div>
            <label class="toggle">
              <span>${t("display.alwaysOnTop")}</span>
              <input name="alwaysOnTop" type="checkbox" ${checked(display.alwaysOnTop)}>
            </label>
            <label class="toggle">
              <span>${t("display.mousePassthrough")}</span>
              <input name="mousePassthrough" type="checkbox" ${checked(display.mousePassthrough)}>
            </label>
          </div>
          <div class="form-actions">
            <button type="button" data-action="reset-position" ${disabled("display")}>${t("display.resetPosition")}</button>
          </div>
        </form>
      </div>
    </section>
  `;
}
