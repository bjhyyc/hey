/**
 * Tab rendering
 */

import { escapeHtml } from "./utils.js";
import { t } from "../../../shared/i18n.js";

export const TABS = [
  ["overview", () => t("panel.tabs.overview")],
  ["assets", () => t("panel.tabs.assets")],
  ["animations", () => t("panel.tabs.animations")],
  ["rules", () => t("panel.tabs.rules")],
  ["display", () => t("panel.tabs.display")],
  ["system", () => t("panel.tabs.system")]
];

/**
 * Render tab navigation
 * @param {string} activeTab - Currently active tab
 * @param {HTMLElement} tabsElement - Tabs container element
 */
export function renderTabs(activeTab, tabsElement) {
  tabsElement.innerHTML = TABS.map(([id, labelFn]) => `
    <button class="tab-button" type="button" data-tab="${id}" aria-selected="${activeTab === id}">
      ${escapeHtml(labelFn())}
    </button>
  `).join("");
}
