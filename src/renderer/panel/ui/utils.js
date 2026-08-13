/**
 * UI utility functions for panel rendering
 */

/**
 * Escape HTML special characters to prevent XSS
 * @param {*} value - Value to escape
 * @returns {string} Escaped string
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderFieldHelp(text, attributes = "") {
  return `
    <details class="field-help" ${attributes}>
      <summary aria-label="${escapeHtml(text)}">?</summary>
      <div class="field-help-popover">${escapeHtml(text)}</div>
    </details>
  `;
}

/**
 * Return "selected" attribute if current matches expected
 * @param {*} current - Current value
 * @param {*} expected - Expected value
 * @returns {string} "selected" or ""
 */
export function selected(current, expected) {
  return current === expected ? "selected" : "";
}

/**
 * Return "checked" attribute if value is truthy
 * @param {*} value - Value to check
 * @returns {string} "checked" or ""
 */
export function checked(value) {
  return value ? "checked" : "";
}

/**
 * Return "disabled" attribute based on saving state
 * @param {string} key - Key being saved
 * @param {string} savingKey - Currently saving key
 * @returns {string} "disabled" or ""
 */
export function disabled(key, savingKey) {
  return savingKey === key ? "disabled" : "";
}

/**
 * Get asset path from action object (handles both asset and assetPath)
 * @param {object} action - Action object
 * @returns {string} Asset path
 */
export function getActionAsset(action) {
  return action.asset || action.assetPath || "";
}

/**
 * Extract filename from file path
 * @param {string} filePath - File path
 * @returns {string} Filename
 */
export function getPathFilename(filePath) {
  return String(filePath || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

/**
 * Extract file extension from file path (lowercase with dot)
 * @param {string} filePath - File path
 * @returns {string} Extension (e.g., ".gif")
 */
export function getPathExtension(filePath) {
  const filename = getPathFilename(filePath);
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

/**
 * Convert file path to file:// URL for preview
 * @param {string} filePath - File path
 * @returns {string} File URL
 */
export function toFilePreviewUrl(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${normalized.split("/").map(encodeURIComponent).join("/")}`.replace("%3A", ":");
}

/**
 * Convert textarea value to array of lines
 * @param {string} text - Textarea value
 * @returns {string[]} Array of lines
 */
export function linesToArray(text) {
  return String(text || "").split("\n").filter((line) => line.trim());
}

/**
 * Convert array of lines to textarea value
 * @param {string[]} lines - Array of lines
 * @returns {string} Textarea value
 */
export function linesToTextarea(messages) {
  return Array.isArray(messages) ? messages.join("\n") : "";
}

/**
 * Set all form controls disabled/enabled state
 * @param {HTMLFormElement} form - Form element
 * @param {boolean} isSaving - Whether form is saving
 */
export function setFormSaving(form, isSaving) {
  form.querySelectorAll("button, input, select, textarea").forEach((control) => {
    control.disabled = isSaving;
  });
}
