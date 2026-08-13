/**
 * Common header component
 */

import { escapeHtml } from "./utils.js";

/**
 * Render section header with title, description, and optional action button
 * @param {string} title - Header title
 * @param {string} description - Header description
 * @param {string} action - Optional action HTML (button, etc.)
 * @returns {string} Header HTML
 */
export function renderHeader(title, description, action = "") {
  return `
    <div class="view-header">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
      ${action}
    </div>
  `;
}
