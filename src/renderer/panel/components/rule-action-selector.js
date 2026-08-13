/**
 * Rule action selector component
 */

import { escapeHtml, checked } from "../ui/utils.js";
import { t } from "../../../shared/i18n.js";

/**
 * Render rule action selector
 * @param {string[]} selectedActionIds - Selected action IDs
 * @param {Array} actions - Available actions
 * @returns {string} Action selector HTML
 */
export function renderRuleActionSelector(selectedActionIds, actions) {
  const selectedIds = new Set(selectedActionIds);

  if (actions.length === 0) {
    return `<div class="empty-state compact">${t("rules.noActionsWarning")}</div>`;
  }

  return `
    <div class="checkbox-list">
      ${actions.map((action) => `
        <label class="checkbox-row">
          <input name="actionIds" type="checkbox" value="${escapeHtml(action.id)}" ${checked(selectedIds.has(action.id))}>
          <span>
            <strong>${escapeHtml(action.name || action.id)}</strong>
            <code>${escapeHtml(action.id)}</code>
          </span>
        </label>
      `).join("")}
    </div>
  `;
}
