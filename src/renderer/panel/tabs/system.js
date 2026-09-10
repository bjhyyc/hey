/**
 * System tab
 */

import { escapeHtml, selected, checked, disabled as disabledHelper } from "../ui/utils.js";
import { renderHeader } from "../ui/header.js";
import { t, getAvailableLocales } from "../../../shared/i18n.js";

function renderUpdateStatus(updateCheck) {
  const status = updateCheck?.status || "idle";
  if (status === "checking") {
    return `<p class="about-update-status muted">${t("system.about.checking")}</p>`;
  }
  if (status === "available") {
    return `<p class="about-update-status update-available">${escapeHtml(t("system.about.updateAvailable", { version: updateCheck.latestVersion || "" }))}</p>`;
  }
  if (status === "latest") {
    return `<p class="about-update-status update-latest">${escapeHtml(t("system.about.latest", { version: updateCheck.currentVersion || "" }))}</p>`;
  }
  // No release feed to read yet. Distinct from "latest" on purpose: claiming
  // the build is current would be asserting something nobody has checked.
  if (status === "unavailable") {
    return `<p class="about-update-status muted">${t("system.about.unavailable")}</p>`;
  }
  if (status === "error") {
    return `<p class="about-update-status update-error">${escapeHtml(t("system.about.checkFailed", { reason: updateCheck.error || t("common.error") }))}</p>`;
  }
  return `<p class="about-update-status muted">${t("system.about.checkHint")}</p>`;
}

/**
 * Render system tab
 * @param {object} state - Panel state
 * @param {object} config - Configuration object
 * @returns {string} System HTML
 */
export function renderSystem(state, config) {
  const currentLanguage = config.system?.language || "en";
  const logging = {
    enabled: true,
    level: "info",
    ...(config.system?.logging || {})
  };
  const logSettings = state.logSettings || {};
  const levels = Array.isArray(logSettings.levels) && logSettings.levels.length
    ? logSettings.levels
    : ["trace", "debug", "info", "warn", "error"];
  const logFiles = Array.isArray(state.logFiles) ? state.logFiles : [];
  const availableLanguages = getAvailableLocales();
  const disabled = (key) => disabledHelper(key, state.savingKey);
  const selectedLogFile = state.selectedLogFile || logFiles[0]?.name || "";
  const logContent = state.logLoading
    ? t("common.loading")
    : (state.logContent || t("system.logs.empty"));
  const currentVersion = state.aboutInfo?.version || "—";
  const updateCheck = state.updateCheck || { status: "idle" };
  const isCheckingUpdates = updateCheck.status === "checking";

  return `
    ${renderHeader(t("system.title"), t("system.description"))}
    <section class="panel-section">
      <div class="section-header"><h3>${t("system.app")}</h3></div>
      <div class="section-body">
        <label class="toggle">
          <span>${t("system.startAtLogin")}</span>
          <input id="launch-at-login" type="checkbox" ${checked(state.systemLaunchAtLogin)} ${disabled("system")}>
        </label>
        <div class="form-row">
          <label>
            <span>${t("system.language")}</span>
            <select id="language-select" ${disabled("system")}>
              ${availableLanguages.map(lang => `
                <option value="${lang.code}" ${selected(currentLanguage, lang.code)}>
                  ${escapeHtml(lang.name)}
                </option>
              `).join("")}
            </select>
          </label>
        </div>
        <div class="form-actions">
          <button class="button-primary" type="button" data-action="save-system" ${disabled("system")}>${state.savingKey === "system" ? t("common.saving") : t("common.save")}</button>
          <button class="button-danger" type="button" data-action="quit-app">${t("system.quitApp")}</button>
        </div>
      </div>
    </section>
    <section class="panel-section about-section">
      <div class="section-header"><h3>${t("system.about.title")}</h3></div>
      <div class="section-body">
        <div class="about-summary">
          <div>
            <span class="field-label">Hey</span>
            <strong class="about-version">v${escapeHtml(currentVersion)}</strong>
            <p class="muted">${t("system.about.description")}</p>
          </div>
          <div class="about-link-actions">
            <button type="button" data-action="open-official-link" data-target="website">${t("system.about.website")}</button>
          </div>
        </div>
        <div class="about-update-row">
          <div aria-live="polite">
            <strong>${t("system.about.updates")}</strong>
            ${renderUpdateStatus(updateCheck)}
          </div>
          <div class="about-update-actions">
            <button type="button" data-action="check-for-updates" ${isCheckingUpdates ? "disabled" : ""}>
              ${isCheckingUpdates ? t("system.about.checkingButton") : t("system.about.check")}
            </button>
            ${updateCheck.status === "available" ? `
              <button type="button" class="button-primary" data-action="open-official-link" data-target="update">
                ${escapeHtml(t("system.about.updateNow", { version: updateCheck.latestVersion || "" }))}
              </button>
            ` : ""}
          </div>
        </div>
      </div>
    </section>
    <section class="panel-section">
      <div class="section-header">
        <h3>${t("system.logs.title")}</h3>
        <div class="header-actions log-header-actions">
          <label class="toggle compact-toggle">
            <span>${t("system.logs.enabled")}</span>
            <input id="logging-enabled" type="checkbox" ${checked(logging.enabled)} ${disabled("system")}>
          </label>
          <button type="button" data-action="open-log-directory" ${disabled("logs")}>${t("system.logs.openDirectory")}</button>
        </div>
      </div>
      <div class="section-body log-viewer">
        <div class="grid-2">
          <label class="field">
            <span>${t("system.logs.level")}</span>
            <select id="logging-level" ${disabled("system")}>
              ${levels.map(level => `
                <option value="${level}" ${selected(logging.level, level)}>${escapeHtml(t(`system.logs.level.${level}`))}</option>
              `).join("")}
            </select>
          </label>
          <label class="field">
            <span>${t("system.logs.file")}</span>
            <select id="log-file-select" ${disabled("logs")} ${logFiles.length ? "" : "disabled"}>
              ${logFiles.length ? logFiles.map(file => `
                <option value="${escapeHtml(file.name)}" ${selected(selectedLogFile, file.name)}>
                  ${escapeHtml(file.name)}
                </option>
              `).join("") : `<option value="">${t("system.logs.noFiles")}</option>`}
            </select>
          </label>
        </div>
        ${logSettings.currentLogPath ? `<p class="code-line breakable">${escapeHtml(logSettings.currentLogPath)}</p>` : ""}
        <div class="form-actions">
          <button type="button" data-action="refresh-logs" ${disabled("logs")}>${t("system.logs.refresh")}</button>
          <button class="button-danger" type="button" data-action="clear-logs" ${disabled("logs")}>${t("system.logs.clear")}</button>
        </div>
        ${state.logTruncated ? `<p class="muted">${t("system.logs.truncated")}</p>` : ""}
        <pre class="log-output" aria-live="polite">${escapeHtml(logContent)}</pre>
      </div>
    </section>
  `;
}
