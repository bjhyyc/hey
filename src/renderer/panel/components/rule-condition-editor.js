/**
 * Rule condition editor component
 */

import { checked, escapeHtml, selected, renderFieldHelp } from "../ui/utils.js";
import { t } from "../../../shared/i18n.js";
import { FIELD_INPUT_TYPES, TRIGGER_PARAMETER_FIELDS, getFieldsForCondition } from "../panel-state.js";

const OPERATOR_OPTIONS_BY_FIELD_TYPE = {
  boolean: ["="],
  number: ["=", "!=", ">", ">=", "<", "<=", "between", "in", "notIn"],
  select: ["=", "!=", "in", "notIn"],
  text: ["=", "!=", "in", "notIn"]
};

const FILTER_VALUE_OPTIONS = {
  direction: ["none", "right", "left", "up", "down"],
  dayOfWeek: ["0", "1", "2", "3", "4", "5", "6"]
};

/**
 * Get translated label for condition type
 * @param {string} type - Condition type
 * @returns {string} Translated label
 */
export function getConditionTypeLabel(type) {
  const key = `rules.conditionTypes.${type}`;
  const translated = t(key);
  return translated !== key ? translated : type;
}

/**
 * Get translated label for field
 * @param {string} field - Field name
 * @returns {string} Translated label
 */
export function getFieldLabel(field) {
  const key = `rules.fields.${field}`;
  const translated = t(key);
  return translated !== key ? translated : field;
}

function getFilterValueLabel(field, value) {
  const key = `rules.values.${field}.${value}`;
  const translated = t(key);
  return translated !== key ? translated : value;
}

function getFilterValueHelp(operator) {
  if (operator === "between") return t("rules.filterValueHint.between");
  if (operator === "in" || operator === "notIn") return t("rules.filterValueHint.list");
  return t("rules.filterValueHint");
}

function getFieldInputType(field) {
  return FIELD_INPUT_TYPES[field] || "text";
}

function isFilterableField(field) {
  return Boolean(field) && getFieldInputType(field) !== "object";
}

export function getFilterableFieldsForCondition(conditionType) {
  return getFieldsForCondition(conditionType).filter(isFilterableField);
}

export function getOperatorsForFilterField(field) {
  if (!isFilterableField(field)) return [];
  return OPERATOR_OPTIONS_BY_FIELD_TYPE[getFieldInputType(field)] || OPERATOR_OPTIONS_BY_FIELD_TYPE.text;
}

export function getDefaultOperatorForFilterField(field) {
  return getOperatorsForFilterField(field)[0] || "=";
}

function normalizeFilterOperator(field, operator) {
  const operators = getOperatorsForFilterField(field);
  return operators.includes(operator) ? operator : getDefaultOperatorForFilterField(field);
}

function normalizeFilterValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

export function renderFilterFieldOptions(conditionType, filterField = "") {
  const fields = getFilterableFieldsForCondition(conditionType);
  const selectedField = fields.includes(filterField) ? filterField : "";
  return [
    `<option value="" ${selected(selectedField, "")}>${t("rules.noFilter")}</option>`,
    ...fields.map((field) => `<option value="${escapeHtml(field)}" ${selected(selectedField, field)}>${escapeHtml(getFieldLabel(field))}</option>`)
  ].join("");
}

export function renderFilterOperatorControl(field, operator = "=", idPrefix = "condition") {
  if (!isFilterableField(field)) {
    return `
      <div class="field" data-role="filter-operator-container" style="display: none;">
        <input type="hidden" name="filterOperator" value="=">
      </div>
    `;
  }

  const inputType = getFieldInputType(field);
  const normalizedOperator = normalizeFilterOperator(field, operator);
  if (inputType === "boolean") {
    return `
      <div class="field" data-role="filter-operator-container" style="display: none;">
        <input type="hidden" name="filterOperator" value="=">
      </div>
    `;
  }

  const operators = getOperatorsForFilterField(field);
  return `
    <div class="field" data-role="filter-operator-container">
      <label for="rule-filter-operator-${escapeHtml(idPrefix)}">${t("rules.operator")}</label>
      <select id="rule-filter-operator-${escapeHtml(idPrefix)}" name="filterOperator" data-role="filter-operator">
        ${operators.map((item) => `<option value="${escapeHtml(item)}" ${selected(normalizedOperator, item)}>${escapeHtml(item)}</option>`).join("")}
      </select>
    </div>
  `;
}

function renderValueOptions(field, value) {
  const values = FILTER_VALUE_OPTIONS[field] || [];
  return values.map((item) => {
    return `<option value="${escapeHtml(item)}" ${selected(String(value), item)}>${escapeHtml(getFilterValueLabel(field, item))}</option>`;
  }).join("");
}

export function renderFilterValueControl(field, operator = "=", value = "", idPrefix = "condition") {
  if (!isFilterableField(field)) {
    return `
      <div class="field" data-role="filter-value-container" style="display: none;">
        <input type="hidden" name="filterValue" value="">
      </div>
    `;
  }

  const inputType = getFieldInputType(field);
  const normalizedOperator = normalizeFilterOperator(field, operator);
  const normalizedValue = normalizeFilterValue(value);
  const helpText = getFilterValueHelp(normalizedOperator);
  const isMultiValue = normalizedOperator === "between" || normalizedOperator === "in" || normalizedOperator === "notIn";
  const fieldLabel = `
    <div class="field-label-row">
      <label for="rule-filter-value-${escapeHtml(idPrefix)}">${t("rules.filterValue")}</label>
      ${renderFieldHelp(helpText)}
    </div>
  `;

  if (inputType === "boolean") {
    const booleanValue = normalizedValue === "" ? "true" : String(normalizedValue);
    return `
      <div class="field" data-role="filter-value-container">
        ${fieldLabel}
        <select id="rule-filter-value-${escapeHtml(idPrefix)}" name="filterValue" data-role="filter-value">
          <option value="true" ${selected(booleanValue, "true")}>${t("rules.values.boolean.true")}</option>
          <option value="false" ${selected(booleanValue, "false")}>${t("rules.values.boolean.false")}</option>
        </select>
      </div>
    `;
  }

  if (inputType === "select" && !isMultiValue && FILTER_VALUE_OPTIONS[field]) {
    return `
      <div class="field" data-role="filter-value-container">
        ${fieldLabel}
        <select id="rule-filter-value-${escapeHtml(idPrefix)}" name="filterValue" data-role="filter-value">
          ${renderValueOptions(field, normalizedValue)}
        </select>
      </div>
    `;
  }

  const isNumberSingleValue = inputType === "number" && !isMultiValue;
  const inputAttributes = isNumberSingleValue
    ? 'type="number" inputmode="decimal"'
    : `type="text" ${inputType === "number" ? 'inputmode="decimal"' : ""}`;
  const placeholder = isMultiValue ? t("rules.filterValuePlaceholder.list") : t("rules.filterValuePlaceholder");

  return `
    <div class="field" data-role="filter-value-container">
      ${fieldLabel}
      <input id="rule-filter-value-${escapeHtml(idPrefix)}" name="filterValue" data-role="filter-value" ${inputAttributes} value="${escapeHtml(normalizedValue)}" placeholder="${escapeHtml(placeholder)}">
    </div>
  `;
}

/**
 * Normalize condition for editor
 * @param {*} condition - Condition object
 * @returns {object} Normalized condition
 */
export function normalizeConditionForEditor(condition) {
  if (!condition || typeof condition !== "object") {
    return { type: "click", filters: [] };
  }
  return {
    type: condition.type || "click",
    required: condition.required !== false,
    filters: Array.isArray(condition.filters) ? condition.filters : [],
    sustainMs: condition.sustainMs,
    intervalMs: condition.intervalMs,
    minMs: condition.minMs,
    maxMs: condition.maxMs
  };
}

function getConditionSettingNumber(condition, field, fallback = "") {
  const value = Number(condition[field]);
  return Number.isFinite(value) ? value : fallback;
}

function renderRandomTimerSettings(normalizedCondition, idPrefix) {
  const minMs = getConditionSettingNumber(normalizedCondition, "minMs");
  const maxMs = getConditionSettingNumber(normalizedCondition, "maxMs");

  return `
    <div class="condition-timer-settings" data-role="random-timer-settings">
      <div class="field">
        <label for="rule-random-min-${escapeHtml(idPrefix)}">${t("rules.fields.minMs")}</label>
        <input id="rule-random-min-${escapeHtml(idPrefix)}" name="randomTimerMinMs" type="number" min="500" step="1" value="${escapeHtml(minMs)}" placeholder="5000">
      </div>
      <div class="field">
        <label for="rule-random-max-${escapeHtml(idPrefix)}">${t("rules.fields.maxMs")}</label>
        <input id="rule-random-max-${escapeHtml(idPrefix)}" name="randomTimerMaxMs" type="number" min="500" step="1" value="${escapeHtml(maxMs)}" placeholder="10000">
      </div>
    </div>
  `;
}

function renderTimerSettings(normalizedCondition, idPrefix) {
  const intervalMs = getConditionSettingNumber(normalizedCondition, "intervalMs");

  return `
    <div class="condition-timer-settings" data-role="timer-settings">
      <div class="field">
        <label for="rule-timer-interval-${escapeHtml(idPrefix)}">${t("rules.fields.intervalMs")}</label>
        <input id="rule-timer-interval-${escapeHtml(idPrefix)}" name="timerIntervalMs" type="number" min="500" step="1" value="${escapeHtml(intervalMs)}" placeholder="5000">
      </div>
    </div>
  `;
}

/**
 * Render rule condition editor (compact card layout)
 * @param {object} condition - Condition object
 * @param {number} index - Condition index
 * @param {string} [scope="conditions"] - Condition list scope ("conditions" | "exitConditions")
 * @returns {string} Condition editor HTML
 */
export function renderRuleConditionEditor(condition, index, scope = "conditions") {
  const normalizedCondition = normalizeConditionForEditor(condition);
  const firstFilter = normalizedCondition.filters[0] || {};
  const supportedFields = getFilterableFieldsForCondition(normalizedCondition.type);
  const filterField = supportedFields.includes(firstFilter.field) ? firstFilter.field : "";
  const filterOperator = normalizeFilterOperator(filterField, firstFilter.operator || "=");
  const filterValue = normalizeFilterValue(firstFilter.value);
  const sustainMs = normalizedCondition.type === "mouseMove" && normalizedCondition.sustainMs != null
    ? normalizedCondition.sustainMs
    : "";
  const canRemove = index > 0;
  const hasFilter = Boolean(filterField);
  const showSustain = normalizedCondition.type === "mouseMove";
  const showTimerSettings = normalizedCondition.type === "timer";
  const showRandomTimerSettings = normalizedCondition.type === "randomTimer";
  const idPrefix = `${scope}-${index}`;

  return `
    <div class="condition-card" data-rule-condition data-scope="${escapeHtml(scope)}">
      <div class="condition-card-header">
        <div class="condition-card-main">
          <label for="rule-condition-type-${escapeHtml(idPrefix)}" class="condition-label">${t("rules.conditionType")}</label>
          <select id="rule-condition-type-${escapeHtml(idPrefix)}" name="conditionType" data-role="condition-type" class="condition-type-select">
            ${Object.keys(TRIGGER_PARAMETER_FIELDS).map((type) => `<option value="${escapeHtml(type)}" ${selected(normalizedCondition.type, type)}>${escapeHtml(getConditionTypeLabel(type))}</option>`).join("")}
          </select>
        </div>
        <div class="condition-card-actions">
          <label class="condition-required-toggle" title="${t("rules.conditionRequiredHint")}">
            <input type="checkbox" name="conditionRequired" ${checked(normalizedCondition.required !== false)}>
            <span>${t("rules.conditionRequired")}</span>
          </label>
          <button type="button" class="button-icon" data-action="toggle-condition-filter" title="${t("rules.advancedFilter")}" aria-expanded="${hasFilter}">
            <span class="filter-icon">${hasFilter ? "▼" : "▶"}</span>
          </button>
          <button type="button" class="button-icon button-danger" data-action="remove-rule-condition" ${canRemove ? "" : "disabled"} title="${t("rules.remove")}">×</button>
        </div>
      </div>
      <div data-role="random-timer-settings-container" ${showRandomTimerSettings ? "" : 'style="display: none;"'}>
        ${renderRandomTimerSettings(normalizedCondition, idPrefix)}
      </div>
      <div data-role="timer-settings-container" ${showTimerSettings ? "" : 'style="display: none;"'}>
        ${renderTimerSettings(normalizedCondition, idPrefix)}
      </div>
      <div class="condition-card-filter" ${hasFilter ? "" : 'style="display: none;"'}>
        <div class="filter-grid">
          <div class="field">
            <label for="rule-filter-field-${escapeHtml(idPrefix)}">${t("rules.filterField")}</label>
            <select id="rule-filter-field-${escapeHtml(idPrefix)}" name="filterField" data-role="filter-field">
              ${renderFilterFieldOptions(normalizedCondition.type, filterField)}
            </select>
          </div>
          ${renderFilterOperatorControl(filterField, filterOperator, idPrefix)}
          ${renderFilterValueControl(filterField, filterOperator, filterValue, idPrefix)}
        </div>
        <div class="field" data-role="condition-sustain" ${showSustain ? "" : 'style="display: none;"'}>
          <div class="field-label-row">
            <label for="rule-condition-sustain-${escapeHtml(idPrefix)}">${t("rules.conditionSustainMs")}</label>
            ${renderFieldHelp(t("rules.conditionSustainMsHint"))}
          </div>
          <input id="rule-condition-sustain-${escapeHtml(idPrefix)}" name="conditionSustainMs" type="number" min="0" step="1" value="${escapeHtml(sustainMs)}" placeholder="${t("rules.conditionSustainMsPlaceholder")}">
        </div>
      </div>
    </div>
  `;
}
