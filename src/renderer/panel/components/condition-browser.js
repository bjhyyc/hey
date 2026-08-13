/**
 * Condition browser component
 */

import { escapeHtml } from "../ui/utils.js";
import { t } from "../../../shared/i18n.js";
import { TRIGGER_PARAMETER_FIELDS, FIELD_INPUT_TYPES } from "../panel-state.js";
import { getConditionTypeLabel, getFieldLabel } from "./rule-condition-editor.js";

/**
 * Render selected condition field details
 * @param {string} selectedConditionType - Currently selected condition type
 * @returns {string} Condition details HTML
 */
export function renderConditionDetails(selectedConditionType) {
  const fields = TRIGGER_PARAMETER_FIELDS[selectedConditionType] || [];

  return `
    <h4>${t("rules.availableFields")}</h4>
    ${fields.length > 0 ? `
      <table class="table">
        <thead><tr><th>${t("rules.fieldName")}</th><th>${t("rules.fieldType")}</th></tr></thead>
        <tbody>
          ${fields.map((field) => `
            <tr>
              <td><code>${escapeHtml(getFieldLabel(field))}</code></td>
              <td><code>${escapeHtml(FIELD_INPUT_TYPES[field] || "text")}</code></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    ` : `<div class="empty-state compact">${t("rules.noFieldsForCondition")}</div>`}
  `;
}

/**
 * Render condition browser as help panel
 * @param {string} selectedConditionType - Currently selected condition type
 * @returns {string} Condition browser HTML
 */
export function renderConditionBrowser(selectedConditionType) {
  return `
    <div class="modal-backdrop">
      <section class="modal-panel condition-help-panel" role="dialog" aria-modal="true" aria-labelledby="condition-help-title">
        <div class="modal-header">
          <div>
            <h3 id="condition-help-title">${t("rules.conditionReference")}</h3>
            <p>${t("rules.conditionReferenceDescription")}</p>
          </div>
          <button class="button-icon" type="button" data-action="close-condition-help" aria-label="${t("common.close")}">&times;</button>
        </div>
        <div class="browser-grid">
          <div class="condition-list">
            <h4>${t("rules.conditionTypes")}</h4>
            ${Object.keys(TRIGGER_PARAMETER_FIELDS).map((type) => `
              <button class="condition-button" type="button" data-action="select-condition" data-condition="${escapeHtml(type)}" aria-selected="${selectedConditionType === type}">
                ${escapeHtml(getConditionTypeLabel(type))}
              </button>
            `).join("")}
          </div>
          <div class="condition-details" data-role="condition-details">
            ${renderConditionDetails(selectedConditionType)}
          </div>
        </div>
      </section>
    </div>
  `;
}
