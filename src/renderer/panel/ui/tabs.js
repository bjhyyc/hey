/**
 * Tab rendering
 */

import { escapeHtml } from "./utils.js";
import { t } from "../../../shared/i18n.js";

export const PRIMARY_TABS = [
  ["overview", () => t("panel.tabs.overview")]
];

export const SETTINGS_TABS = [
  ["assets", () => t("panel.tabs.assets")],
  ["animations", () => t("panel.tabs.animations")],
  ["rules", () => t("panel.tabs.rules")],
  ["display", () => t("panel.tabs.display")],
  ["system", () => t("panel.tabs.system")]
];

export const TABS = [...PRIMARY_TABS, ...SETTINGS_TABS];

/**
 * Render tab navigation
 * @param {string} activeTab - Currently active tab
 * @param {HTMLElement} tabsElement - Tabs container element
 */
export function renderTabs(activeTab, tabsElement) {
  const renderButtons = (tabs) => tabs.map(([id, labelFn]) => `
    <button class="tab-button" type="button" data-tab="${id}" aria-selected="${activeTab === id}">
      ${escapeHtml(labelFn())}
    </button>
  `).join("");

  const settingsOpen = SETTINGS_TABS.some(([id]) => id === activeTab);
  tabsElement.innerHTML = `
    ${renderButtons(PRIMARY_TABS)}
    <details class="settings-menu"${settingsOpen ? " open" : ""}>
      <summary>${escapeHtml(t("panel.tabs.settings"))}</summary>
      <div class="settings-menu-items">
        ${renderButtons(SETTINGS_TABS)}
      </div>
    </details>
  `;
}
