/**
 * Interaction tab
 */

import { escapeHtml, checked, disabled as disabledHelper } from "../ui/utils.js";
import { renderHeader } from "../ui/header.js";
import { t } from "../../../shared/i18n.js";

/**
 * Get bubble settings from config
 * @param {object} config - Configuration object
 * @returns {object} Bubble settings
 */
function getBubbleSettings(config) {
  const interactions = config && config.interactions && typeof config.interactions === "object"
    ? config.interactions
    : {};
  const bubble = interactions.bubble && typeof interactions.bubble === "object" ? interactions.bubble : {};

  return {
    maxWidth: Number.isFinite(Number(bubble.maxWidth)) ? Number(bubble.maxWidth) : 220,
    durationMs: Number.isFinite(Number(bubble.durationMs)) ? Number(bubble.durationMs) : 1800,
    showCloseButton: Boolean(bubble.showCloseButton)
  };
}

/**
 * Render interaction tab
 * @param {object} state - Panel state
 * @param {object} config - Configuration object
 * @returns {string} Interaction HTML
 */
export function renderInteraction(state, config) {
  const bubble = getBubbleSettings(config);
  const disabled = (key) => disabledHelper(key, state.savingKey);

  return `
    ${renderHeader(t("interaction.title"), t("interaction.description"))}
    <section class="panel-section">
      <div class="section-header"><h3>${t("interaction.bubbleSettings")}</h3></div>
      <div class="section-body">
        <form id="interaction-form">
          <div class="field">
            <label class="checkbox-row">
              <input name="bubbleShowCloseButton" type="checkbox" ${checked(bubble.showCloseButton)}>
              <span>${t("interaction.showBubbleCloseButton")}</span>
            </label>
          </div>
          <div class="form-actions">
            <button class="button-primary" type="submit" ${disabled("interaction")}>${state.savingKey === "interaction" ? t("common.saving") : t("common.save")}</button>
          </div>
        </form>
      </div>
    </section>
    <section class="panel-section">
      <div class="section-header"><h3>${t("interaction.messagesHelp.title")}</h3></div>
      <div class="section-body">
        <p>${t("interaction.messagesHelp.desc")}</p>
        <ul class="help-list">
          <li><strong>${t("interaction.messagesHelp.click")}</strong>: ${t("interaction.messagesHelp.clickDesc")}</li>
          <li><strong>${t("interaction.messagesHelp.random")}</strong>: ${t("interaction.messagesHelp.randomDesc")}</li>
          <li><strong>${t("interaction.messagesHelp.timed")}</strong>: ${t("interaction.messagesHelp.timedDesc")}</li>
        </ul>
        <p><strong>${t("interaction.messagesHelp.bubbleSettings")}</strong>: ${t("interaction.messagesHelp.bubbleSettingsDesc")}</p>
      </div>
    </section>
  `;
}
