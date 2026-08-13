/**
 * Rules tab
 */

import { escapeHtml, selected, checked, disabled as disabledHelper, renderFieldHelp } from "../ui/utils.js";
import { renderHeader } from "../ui/header.js";
import { t } from "../../../shared/i18n.js";
import { createId } from "../panel-state.js";
import { renderRuleConditionEditor, normalizeConditionForEditor } from "../components/rule-condition-editor.js";
import { renderInlineActionEditor } from "../components/inline-action-editor.js";
import { renderConditionBrowser } from "../components/condition-browser.js";
import { detectRuleConflicts } from "../../../shared/rule-conflict-detector.js";

const MAX_VISIBLE_CONFLICTS = 5;

/**
 * Get rules from config
 * @param {object} config - Configuration object
 * @returns {Array} Rules array
 */
function getRules(config) {
  return Array.isArray(config && config.triggerRules) ? config.triggerRules : [];
}

/**
 * Get animations from config
 * @param {object} config - Configuration object
 * @returns {object} Animations object
 */
function getAnimations(config) {
  return config?.animations || { default: { id: "idle", asset: "" }, clips: [] };
}

/**
 * Get rule conditions for editor
 * @param {object} rule - Rule object
 * @returns {Array} Conditions array
 */
function getRuleConditionsForEditor(rule) {
  if (rule && Array.isArray(rule.conditions) && rule.conditions.length > 0) {
    return rule.conditions.map(normalizeConditionForEditor);
  }
  return [{ type: "click", filters: [] }];
}

function getConditionTypeLabel(conditionType) {
  const key = `rules.conditionTypes.${conditionType}`;
  const label = t(key);
  return label === key ? conditionType : label;
}

function getActionTypeLabel(actionType) {
  const key = `rules.actionTypes.${actionType}`;
  const label = t(key);
  return label === key ? actionType : label;
}

function getConflictMessage(conflict) {
  const params = { ...(conflict.params || {}) };

  if (params.actionType) {
    params.actionTypeLabel = params.actionType.includes("/")
      ? params.actionType.split("/").map(getActionTypeLabel).join(" / ")
      : getActionTypeLabel(params.actionType);
  }
  if (params.leftActionType) params.leftActionLabel = getActionTypeLabel(params.leftActionType);
  if (params.rightActionType) params.rightActionLabel = getActionTypeLabel(params.rightActionType);

  return t(conflict.messageKey, params);
}

function renderRuleConflictAlert(conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) return "";

  const visibleConflicts = conflicts.slice(0, MAX_VISIBLE_CONFLICTS);
  const remainingCount = conflicts.length - visibleConflicts.length;

  return `
    <section class="rule-conflict-alert" aria-live="polite">
      <div class="rule-conflict-alert-header">
        <strong>${t("rules.conflicts.title", { count: conflicts.length })}</strong>
      </div>
      <ul>
        ${visibleConflicts.map((conflict) => `
          <li>
            <span class="rule-conflict-rules">${escapeHtml((conflict.ruleNames || []).join(" / "))}</span>
            <span>${escapeHtml(getConflictMessage(conflict))}</span>
          </li>
        `).join("")}
      </ul>
      ${remainingCount > 0 ? `<p>${t("rules.conflicts.more", { count: remainingCount })}</p>` : ""}
    </section>
  `;
}

function disabledAttribute(isDisabled) {
  return isDisabled ? "disabled" : "";
}

function renderRuleTransferMenu({ kind, label, disabled = false, options = [] }) {
  return `
    <div class="rule-transfer-menu" data-transfer-menu="${escapeHtml(kind)}">
      <button type="button" class="rule-menu-trigger" aria-haspopup="menu" aria-expanded="false" ${disabledAttribute(disabled)}>
        ${escapeHtml(label)}
      </button>
      <div class="rule-menu-panel" role="menu">
        ${options.map((option) => `
          <button type="button" role="menuitem" data-action="${escapeHtml(option.action)}" ${disabledAttribute(option.disabled)}>
            ${escapeHtml(option.label)}
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

/**
 * Render rule row component
 * @param {object} rule - Rule object
 * @param {Set<string>} selectedExportIds - Selected rule ids for export
 * @returns {string} Rule row HTML
 */
function renderRuleRow(rule, selectedExportIds = new Set()) {
  const conditionSummary = Array.isArray(rule.conditions)
    ? rule.conditions
      .map((condition) => getConditionTypeLabel(condition && condition.type))
      .join(", ")
    : "";
  const requiredCount = Array.isArray(rule.conditions)
    ? rule.conditions.filter((condition) => condition && typeof condition === "object" && condition.required !== false).length
    : 0;
  const optionalCount = Array.isArray(rule.conditions)
    ? rule.conditions.filter((condition) => condition && typeof condition === "object" && condition.required === false).length
    : 0;
  const isEnabled = rule.enabled !== false;
  const isSelectedForExport = selectedExportIds.has(rule.id);

  return `
    <div class="item-row rule-row" data-action="toggle-rule-export-selection" data-id="${escapeHtml(rule.id)}" aria-selected="${isSelectedForExport ? "true" : "false"}" title="${t("rules.export.selectRule")}">
      <label class="rule-enable-checkbox" title="${t("rules.form.enabled")}">
        <input type="checkbox" data-action="toggle-rule-enabled" data-id="${escapeHtml(rule.id)}" ${checked(isEnabled)} aria-label="${t("rules.form.enabled")}">
      </label>
      <div class="rule-row-main">
        <strong>${escapeHtml(rule.name || t("rules.untitledRule"))}</strong>
        <code>${escapeHtml(rule.id)}</code>
        <div class="rule-row-meta">
          <span>${t("rules.requiredCount", { count: requiredCount })}</span>
          <span>${t("rules.optionalCount", { count: optionalCount })}</span>
          <span>${escapeHtml(conditionSummary || "-")}</span>
          <span>${t("rules.form.priority")} ${escapeHtml(rule.priority ?? 0)}</span>
        </div>
      </div>
      <div class="rule-row-actions">
        <button type="button" data-action="edit-rule" data-id="${escapeHtml(rule.id)}">${t("rules.edit")}</button>
        <button class="button-danger" type="button" data-action="delete-rule" data-id="${escapeHtml(rule.id)}">${t("common.delete")}</button>
      </div>
    </div>
  `;
}

/**
 * Render rule editor form
 * @param {object} state - Panel state
 * @param {object} formRule - Rule form model
 * @param {object} animations - Animations object
 * @param {boolean} isEditing - Whether editing an existing rule
 * @returns {string} Rule editor HTML
 */
function renderRuleEditor(state, formRule, animations, isEditing) {
  const disabled = (key) => disabledHelper(key, state.savingKey);
  const hasMouseMoveCondition = formRule.conditions.some((condition) => condition && condition.type === "mouseMove");

  return `
    <div class="modal-backdrop">
      <section class="modal-panel rule-editor-modal" role="dialog" aria-modal="true" aria-labelledby="rule-editor-title">
        <div class="modal-header">
          <div>
            <h3 id="rule-editor-title">${isEditing ? t("rules.editRule") : t("rules.createRule")}</h3>
            <p>${t("rules.editorDescription")}</p>
          </div>
          <button class="button-icon" type="button" data-action="close-rule-editor" aria-label="${t("common.close")}">&times;</button>
        </div>
        <form id="rule-form" class="rule-editor-form">
          <input type="hidden" name="id" value="${escapeHtml(formRule.id)}">

          <div class="rule-editor-grid">
            <div class="rule-editor-main">
              <section class="editor-block">
                <div class="editor-block-header">
                  <h4>${t("rules.basicInfo")}</h4>
                </div>
                <div class="grid-2">
                  <div class="field">
                    <label for="rule-name">${t("rules.form.name")} <span class="required">*</span></label>
                    <input id="rule-name" name="name" type="text" value="${escapeHtml(formRule.name)}" required placeholder="${t("rules.namePlaceholder")}">
                  </div>
                  <div class="field">
                    <div class="field-label-row">
                      <label for="rule-priority">${t("rules.form.priority")}</label>
                      ${renderFieldHelp(t("rules.priorityHint"))}
                    </div>
                    <input id="rule-priority" name="priority" type="number" step="1" value="${escapeHtml(formRule.priority)}">
                  </div>
                  <div class="field">
                    <div class="field-label-row">
                      <label for="rule-cooldown">${t("rules.cooldownTime")}</label>
                      ${renderFieldHelp(t("rules.cooldownHint"))}
                    </div>
                    <input id="rule-cooldown" name="cooldownMs" type="number" min="0" step="1" value="${escapeHtml(formRule.cooldownMs)}">
                  </div>
                  <div class="field">
                    <div class="rule-stop-on-match-row">
                      <input id="rule-stop-on-match" name="stopOnMatch" type="checkbox" ${checked(formRule.stopOnMatch !== false)}>
                      <label for="rule-stop-on-match">${t("rules.stopOnMatch")}</label>
                      ${renderFieldHelp(t("rules.stopOnMatchHint"), 'data-placement="right"')}
                    </div>
                  </div>
                </div>
              </section>

              <section class="editor-block">
                <div class="editor-block-header">
                  <h4>${t("rules.triggerConditions")}</h4>
                  <button type="button" class="button-help" data-action="show-condition-help" title="${t("rules.conditionHelp")}">?</button>
                </div>
                <p class="section-note">${t("rules.conditionRequiredSummary")}</p>
                <div id="rule-conditions" class="conditions-list" data-scope="conditions">
                  ${formRule.conditions.map((condition, index) => renderRuleConditionEditor(condition, index, "conditions")).join("")}
                </div>
                <div class="add-condition-row" data-scope="conditions">
                  <button type="button" class="button-secondary" data-action="add-rule-condition" data-scope="conditions">+ ${t("rules.addCondition")}</button>
                </div>
              </section>

              <section class="editor-block">
                <div class="editor-block-header">
                  <h4>${t("rules.executeActions")}</h4>
                </div>
                <div class="field">
                  <div class="field-label-row">
                    <label for="rule-action-strategy">${t("rules.executionStrategy")}</label>
                    ${renderFieldHelp(t(`rules.strategyHint.${formRule.actionStrategy}`))}
                  </div>
                  <select id="rule-action-strategy" name="actionStrategy">
                    <option value="sequence" ${selected(formRule.actionStrategy, "sequence")}>${t("rules.strategy.sequence")}</option>
                    <option value="random" ${selected(formRule.actionStrategy, "random")}>${t("rules.strategy.random")}</option>
                  </select>
                </div>
                ${renderInlineActionEditor(formRule.actions, animations, "actions")}
              </section>

              <section class="editor-block" data-role="exit-state-block" ${hasMouseMoveCondition ? "" : 'style="display: none;"'}>
                <div class="editor-block-header">
                  <h4>${t("rules.exitConditions")}</h4>
                  <button type="button" class="button-help" data-action="show-condition-help" title="${t("rules.conditionHelp")}">?</button>
                </div>
                <p class="section-note">${t("rules.conditionRequiredSummary")}</p>
                <div class="conditions-list" data-scope="exitConditions">
                  ${formRule.exitConditions.map((condition, index) => renderRuleConditionEditor(condition, index, "exitConditions")).join("")}
                </div>
                <div class="add-condition-row" data-scope="exitConditions">
                  <button type="button" class="button-secondary" data-action="add-rule-condition" data-scope="exitConditions">+ ${t("rules.addExitCondition")}</button>
                </div>
              </section>

              <section class="editor-block" data-role="exit-state-block" ${hasMouseMoveCondition ? "" : 'style="display: none;"'}>
                <div class="editor-block-header">
                  <h4>${t("rules.exitActions")}</h4>
                  ${renderFieldHelp(t("rules.exitActionsHint"))}
                </div>
                ${renderInlineActionEditor(formRule.exitActions, animations, "exitActions")}
              </section>
            </div>

          </div>

          <div class="form-actions modal-actions">
            <button type="button" data-action="close-rule-editor">${t("common.cancel")}</button>
            <button class="button-primary" type="submit" ${disabled("rule")}>${state.savingKey === "rule" ? t("common.saving") : t("common.save")}</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

/**
 * Render rules tab
 * @param {object} state - Panel state
 * @param {object} config - Configuration object
 * @returns {string} Rules HTML
 */
export function renderRules(state, config) {
  const rules = getRules(config);
  const animations = getAnimations(config);
  const allClips = [animations.default, ...(animations.clips || [])].filter(Boolean);
  const conflicts = detectRuleConflicts(rules, { clips: allClips });
  const selectedRule = rules.find((rule) => rule.id === state.selectedRuleId) || null;
  const formConditions = getRuleConditionsForEditor(selectedRule);
  const ruleState = selectedRule && selectedRule.state ? selectedRule.state : null;
  const formRule = selectedRule ? {
    id: selectedRule.id,
    name: selectedRule.name,
    enabled: selectedRule.enabled !== false,
    cooldownMs: selectedRule.cooldownMs ?? 0,
    priority: selectedRule.priority ?? 0,
    stopOnMatch: selectedRule.stopOnMatch !== false,
    conditions: formConditions,
    actionStrategy: selectedRule.actionStrategy || "sequence",
    actions: Array.isArray(selectedRule.actions) ? selectedRule.actions : [],
    exitConditions: Array.isArray(ruleState && ruleState.exitConditions) && ruleState.exitConditions.length > 0
      ? ruleState.exitConditions.map(normalizeConditionForEditor)
      : [{ type: "mouseMove", filters: [] }],
    exitActions: Array.isArray(ruleState && ruleState.exitActions) ? ruleState.exitActions : []
  } : {
    id: createId("rule"),
    name: "",
    enabled: true,
    cooldownMs: 0,
    priority: 0,
    stopOnMatch: true,
    conditions: formConditions,
    actionStrategy: "sequence",
    actions: [],
    exitConditions: [{ type: "mouseMove", filters: [] }],
    exitActions: []
  };
  const isEditorOpen = Boolean(state.ruleEditorOpen);
  const isConditionHelpOpen = Boolean(state.conditionHelpOpen);
  const selectedExportIds = new Set(Array.isArray(state.selectedRuleExportIds) ? state.selectedRuleExportIds : []);
  const selectedExportCount = rules.filter((rule) => selectedExportIds.has(rule.id)).length;
  const allRulesSelected = rules.length > 0 && selectedExportCount === rules.length;
  const canExportSelected = selectedExportCount > 0;
  const isImportBusy = state.savingKey === "rule-import-file" || state.savingKey === "rule-import-clipboard";
  const isExportBusy = state.savingKey === "rule-export-file" || state.savingKey === "rule-export-clipboard";

  return `
    ${renderHeader(t("rules.title"), t("rules.description"), `
      <div class="header-actions rule-header-actions">
        ${renderRuleTransferMenu({
          kind: "import",
          label: t("rules.importRules"),
          disabled: isImportBusy,
          options: [
            { action: "import-rules-clipboard", label: t("rules.import.fromClipboard"), disabled: isImportBusy },
            { action: "import-rules-file", label: t("rules.import.fromFile"), disabled: isImportBusy }
          ]
        })}
        ${renderRuleTransferMenu({
          kind: "export",
          label: t("rules.exportSelected"),
          disabled: !canExportSelected || isExportBusy,
          options: [
            { action: "export-selected-rules-clipboard", label: t("rules.export.toClipboard"), disabled: !canExportSelected || isExportBusy },
            { action: "export-selected-rules-file", label: t("rules.export.toFile"), disabled: !canExportSelected || isExportBusy }
          ]
        })}
        <button type="button" data-action="new-rule">${t("rules.addNew")}</button>
      </div>
    `)}
    ${renderRuleConflictAlert(conflicts)}
    <section class="panel-section">
      <div class="section-header">
        <h3>${t("rules.savedRules")}</h3>
        <div class="section-actions">
          <button type="button" data-action="toggle-all-rule-exports" ${rules.length > 0 ? "" : "disabled"}>
            ${allRulesSelected ? t("rules.export.clearSelection") : t("rules.export.selectAll")}
          </button>
          <span class="muted">${t("rules.export.selectedCount", { selected: selectedExportCount, total: rules.length })}</span>
          <span class="muted">${rules.length} ${t("rules.saved")}</span>
        </div>
      </div>
      <div class="section-body">
        ${rules.length ? `<div class="item-list">${rules.map((rule) => renderRuleRow(rule, selectedExportIds)).join("")}</div>` : `<div class="empty-state">${t("rules.empty")}</div>`}
      </div>
    </section>
    ${isEditorOpen ? renderRuleEditor(state, formRule, animations, Boolean(selectedRule)) : ""}
    ${isConditionHelpOpen ? renderConditionBrowser(state.selectedConditionType) : ""}
  `;
}
