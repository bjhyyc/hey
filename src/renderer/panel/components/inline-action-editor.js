/**
 * Inline action editor component
 */

import { escapeHtml, selected, renderFieldHelp } from "../ui/utils.js";
import { t } from "../../../shared/i18n.js";
import { SUPPORTED_ACTION_TYPES } from "../panel-state.js";

const ACTION_TYPES = SUPPORTED_ACTION_TYPES.filter(type => type !== "delay");

/**
 * Render action type selector
 * @param {string} selectedType - Selected action type
 * @returns {string} HTML for action type selector
 */
function renderActionTypeSelector(selectedType) {
  if (selectedType === "delay") {
    return `
      <input type="hidden" name="actionType" value="delay">
      <span class="action-type-static">${escapeHtml(t("rules.actionTypes.delay"))}</span>
    `;
  }

  return `
    <select name="actionType" class="action-type-selector">
      ${ACTION_TYPES.map(type => `
        <option value="${escapeHtml(type)}" ${selected(selectedType, type)}>
          ${escapeHtml(t(`rules.actionTypes.${type}`))}
        </option>
      `).join("")}
    </select>
  `;
}

/**
 * Render action parameters based on type
 * @param {object} action - Action object
 * @param {object} animations - Animations config
 * @returns {string} HTML for action parameters
 */
function renderActionParams(action, animations) {
  const type = action.type || "playAnimation";
  const clips = animations?.clips || [];
  const defaultClip = animations?.default || { id: "", name: "" };
  const allClips = [defaultClip, ...clips];

  if (type === "blank") {
    return `<div class="action-params empty">${t("rules.actionParams.blankHelp")}</div>`;
  }

  if (type === "delay") {
    return `
      <div class="action-params">
        <div class="field">
          <div class="field-label-row">
            <label>${t("rules.actionParams.durationMs")}</label>
            ${renderFieldHelp(t("rules.actionParams.delayDurationHelp"))}
          </div>
          <input type="number" name="durationMs" value="${action.durationMs || 1000}" min="0" step="1">
        </div>
      </div>
    `;
  }

  if (type === "playAnimation") {
    // Keyframe clips are scrubbed by an explicit progress value, not played directly,
    // so they are not eligible as a "play animation" target (use setKeyframeProgress instead).
    const playableClips = allClips.filter(clip => (clip.type || "default") !== "keyframe");
    // Find selected animation to check its type
    const selectedAnimId = action.animation || defaultClip.id;
    const selectedAnim = playableClips.find(clip => clip.id === selectedAnimId);
    const isOneshotAnim = selectedAnim && selectedAnim.type === "oneshot";
    const animDuration = selectedAnim && selectedAnim.durationMs ? selectedAnim.durationMs : 900;

    return `
      <div class="action-params">
        <div class="field">
          <label>${t("rules.actionParams.animation")}</label>
          <select name="animation" required data-role="animation-selector">
            ${playableClips.map(clip => `
              <option value="${escapeHtml(clip.id)}" ${selected(action.animation, clip.id)} data-type="${escapeHtml(clip.type || 'default')}" data-duration="${escapeHtml(clip.durationMs || 900)}">
                ${escapeHtml(clip.name || clip.id)}${clip.type ? ` (${clip.type})` : ""}
              </option>
            `).join("")}
          </select>
        </div>
        ${isOneshotAnim ? `
          <div class="field" data-role="oneshot-duration-hint">
            <div class="field-label-row">
              <label>${t("rules.actionParams.durationMs")}</label>
              ${renderFieldHelp(t("rules.actionParams.durationHint"))}
            </div>
            <input type="number" name="durationMs" value="${animDuration}" disabled>
          </div>
        ` : `
          <div class="field" data-role="loop-hint">
            <small class="info-hint">${t("rules.actionParams.loopHint")}</small>
          </div>
        `}
      </div>
    `;
  }

  if (type === "setKeyframeProgress") {
    const progressFrom = action.progressFrom || "angleToPetProgress";

    return `
      <div class="action-params">
        <div class="field">
          <label>${t("rules.actionParams.animation")}</label>
          <select name="animation" required>
            ${allClips.map(clip => `
              <option value="${escapeHtml(clip.id)}" ${selected(action.animation, clip.id)}>
                ${escapeHtml(clip.name || clip.id)}${clip.type ? ` (${clip.type})` : ""}
              </option>
            `).join("")}
          </select>
        </div>
        <div class="field">
          <label>${t("rules.actionParams.progressFrom")}</label>
          <select name="progressFrom">
            <option value="angleToPetProgress" ${selected(progressFrom, "angleToPetProgress")}>${escapeHtml(t("rules.fields.angleToPetProgress"))}</option>
            <option value="distanceToPetCenter" ${selected(progressFrom, "distanceToPetCenter")}>${escapeHtml(t("rules.fields.distanceToPetCenter"))}</option>
            <option value="distanceToPetBounds" ${selected(progressFrom, "distanceToPetBounds")}>${escapeHtml(t("rules.fields.distanceToPetBounds"))}</option>
          </select>
        </div>
        <div class="field">
          <label>${t("rules.actionParams.progressOffset")}</label>
          <input type="number" name="offset" value="${action.offset || 0}" min="-1" max="1" step="0.01">
        </div>
        <div class="field">
          <label>${t("rules.actionParams.progressScale")}</label>
          <input type="number" name="scale" value="${action.scale || 1}" min="-10" max="10" step="0.01">
        </div>
      </div>
    `;
  }

  if (type === "showMessage") {
    return `
      <div class="action-params">
        <div class="field field-full">
          <label>${t("rules.actionParams.text")}</label>
          <input type="text" name="text" value="${escapeHtml(action.text || "")}" required>
        </div>
        <div class="field">
          <div class="field-label-row">
            <label>${t("rules.actionParams.durationMs")}</label>
            ${renderFieldHelp(t("rules.actionParams.messageDurationHelp"))}
          </div>
          <input type="number" name="durationMs" value="${action.durationMs || 1800}" min="100" step="1">
        </div>
        <div class="field">
          <div class="field-label-row">
            <label>${t("rules.actionParams.bubbleMaxWidth")}</label>
            ${renderFieldHelp(t("rules.actionParams.bubbleMaxWidthHelp"))}
          </div>
          <input type="number" name="bubbleMaxWidth" value="${action.bubbleMaxWidth || 220}" min="120" max="480" step="10">
        </div>
      </div>
    `;
  }

  if (type === "randomMessage") {
    const messages = Array.isArray(action.messages) ? action.messages.join("\n") : "";
    return `
      <div class="action-params">
        <div class="field field-full">
          <label>${t("rules.actionParams.messages")}</label>
          <textarea name="messages" rows="3" required>${escapeHtml(messages)}</textarea>
        </div>
        <div class="field">
          <div class="field-label-row">
            <label>${t("rules.actionParams.durationMs")}</label>
            ${renderFieldHelp(t("rules.actionParams.messageDurationHelp"))}
          </div>
          <input type="number" name="durationMs" value="${action.durationMs || 1800}" min="100" step="1">
        </div>
        <div class="field">
          <div class="field-label-row">
            <label>${t("rules.actionParams.bubbleMaxWidth")}</label>
            ${renderFieldHelp(t("rules.actionParams.bubbleMaxWidthHelp"))}
          </div>
          <input type="number" name="bubbleMaxWidth" value="${action.bubbleMaxWidth || 220}" min="120" max="480" step="10">
        </div>
      </div>
    `;
  }

  if (type === "changeScale") {
    return `
      <div class="action-params">
        <div class="field">
          <label>${t("rules.actionParams.scale")}</label>
          <input type="number" name="scale" value="${action.scale || 1}" min="0.25" max="4" step="0.25" required>
        </div>
      </div>
    `;
  }

  if (type === "changeOpacity") {
    return `
      <div class="action-params">
        <div class="field">
          <label>${t("rules.actionParams.opacity")}</label>
          <input type="number" name="opacity" value="${action.opacity || 1}" min="0" max="1" step="0.1" required>
        </div>
      </div>
    `;
  }

  if (type === "movePet") {
    const direction = action.direction || "right";
    return `
      <div class="action-params">
        <div class="field">
          <label>${t("rules.actionParams.moveDirection")}</label>
          <select name="direction" required>
            ${["up", "down", "left", "right", "upLeft", "upRight", "downLeft", "downRight"].map(value => `
              <option value="${value}" ${selected(direction, value)}>
                ${escapeHtml(t(`rules.moveDirections.${value}`))}
              </option>
            `).join("")}
          </select>
        </div>
        <div class="field">
          <div class="field-label-row">
            <label>${t("rules.actionParams.moveSpeed")}</label>
            ${renderFieldHelp(t("rules.actionParams.moveSpeedHelp"))}
          </div>
          <input type="text" name="speed" value="${action.speed || 120}" inputmode="decimal" required>
        </div>
        <div class="field">
          <div class="field-label-row">
            <label>${t("rules.actionParams.durationMs")}</label>
            ${renderFieldHelp(t("rules.actionParams.moveDurationHelp"))}
          </div>
          <input type="text" name="durationMs" value="${action.durationMs || 1000}" inputmode="decimal" required>
        </div>
      </div>
    `;
  }

  if (type === "pomodoroTimer") {
    const command = action.command || "start";
    return `
      <div class="action-params">
        <div class="field">
          <label>${t("rules.actionParams.pomodoroCommand")}</label>
          <select name="pomodoroCommand" class="pomodoro-command-selector">
            <option value="start" ${selected(command, "start")}>${escapeHtml(t("rules.actionParams.pomodoroCommand.start"))}</option>
            <option value="cancel" ${selected(command, "cancel")}>${escapeHtml(t("rules.actionParams.pomodoroCommand.cancel"))}</option>
          </select>
        </div>
        ${command === "start" ? `
          <div class="field">
            <div class="field-label-row">
              <label>${t("rules.actionParams.durationMs")}</label>
              ${renderFieldHelp(t("rules.actionParams.pomodoroDurationHelp"))}
            </div>
            <input type="number" name="durationMs" value="${action.durationMs || 1500000}" min="1000" step="1">
          </div>
          <div class="field">
            <label>${t("rules.actionParams.pomodoroLabel")}</label>
            <input type="text" name="label" value="${escapeHtml(action.label || "")}" placeholder="${escapeHtml(t("rules.actionParams.pomodoroLabelPlaceholder"))}">
          </div>
        ` : ""}
      </div>
    `;
  }

  // hidePet, showPet, disableInteractions, enableInteractions, resetPosition, openPanel - no parameters
  return `<div class="action-params empty">${t("rules.noParams")}</div>`;
}

/**
 * Render single inline action row
 * @param {object} action - Action object
 * @param {number} index - Action index
 * @param {object} animations - Animations config
 * @param {string} [scope="actions"] - Which action list this row belongs to ("actions" | "exitActions")
 * @returns {string} HTML for action row
 */
export function renderSingleInlineAction(action, index, animations, scope = "actions") {
  return `
    <div class="inline-action-row" data-inline-action draggable="true" data-scope="${escapeHtml(scope)}" data-index="${index}">
      <div class="action-header">
        <span class="action-number">${index + 1}.</span>
        ${renderActionTypeSelector(action.type)}
        <button type="button" class="button-icon" data-action="remove-inline-action" title="${t("rules.removeAction")}">×</button>
      </div>
      ${renderActionParams(action, animations)}
    </div>
  `;
}

/**
 * Render inline action editor
 * @param {Array} actions - Array of action objects
 * @param {object} animations - Animations config
 * @param {string} [scope="actions"] - Which action list ("actions" | "exitActions")
 * @returns {string} HTML for inline action editor
 */
export function renderInlineActionEditor(actions, animations, scope = "actions") {
  const actionList = Array.isArray(actions) ? actions : [];

  return `
    <div class="inline-actions" data-scope="${escapeHtml(scope)}">
      <div class="inline-actions-list" data-scope="${escapeHtml(scope)}">
        ${actionList.map((action, index) => renderSingleInlineAction(action, index, animations, scope)).join("")}
      </div>
      <div class="inline-actions-controls">
        <button type="button" class="button-secondary" data-action="add-inline-action" data-scope="${escapeHtml(scope)}">
          ${t("rules.addAction")}
        </button>
        <button type="button" class="button-secondary" data-action="add-inline-delay" data-scope="${escapeHtml(scope)}">
          ${t("rules.addDelay")}
        </button>
      </div>
    </div>
  `;
}
