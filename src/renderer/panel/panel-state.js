const DISCRETE_POINTER_FIELDS = [
  "distanceToPetCenter"
];

const DRAG_PROGRESS_FIELDS = [
  "isInsidePet",
  "distanceToPetCenter",
  "distanceToPetBounds",
  "dragDeltaX",
  "dragDeltaY",
  "dragDistance",
  "dragDurationMs"
];

const TIME_FIELDS = ["elapsedMs"];
const MOUSE_STILL_FIELDS = ["isInsidePet", "distanceToPetCenter", "distanceToPetBounds", "durationMs"];
const CLOCK_FIELDS = ["currentHour", "dayOfWeek"];
const POMODORO_COMPLETE_FIELDS = ["durationMs", "elapsedMs", "label"];

export const SUPPORTED_ACTION_TYPES = [
  "blank",
  "delay",
  "playAnimation",
  "setKeyframeProgress",
  "showMessage",
  "randomMessage",
  "changeScale",
  "changeOpacity",
  "movePet",
  "pomodoroTimer",
  "hidePet",
  "showPet",
  "disableInteractions",
  "enableInteractions",
  "resetPosition",
  "openPanel"
];
export const SUPPORTED_OPERATORS = ["=", "!=", ">", ">=", "<", "<=", "between", "in", "notIn"];
export const TRIGGER_PARAMETER_FIELDS = {
  click: DISCRETE_POINTER_FIELDS,
  doubleClick: DISCRETE_POINTER_FIELDS,
  rightClick: DISCRETE_POINTER_FIELDS,
  dragStart: DISCRETE_POINTER_FIELDS,
  dragging: DRAG_PROGRESS_FIELDS,
  dragEnd: DRAG_PROGRESS_FIELDS,
  mouseEnter: DISCRETE_POINTER_FIELDS,
  mouseLeave: DISCRETE_POINTER_FIELDS,
  mouseMove: [
    "isInsidePet",
    "distanceToPetCenter",
    "distanceToPetBounds",
    "deltaX",
    "deltaY",
    "speed",
    "direction",
    "angleToPet",
    "angleToPetDegrees",
    "angleToPetProgress",
    "isMovingTowardPet",
    "isMovingAwayFromPet"
  ],
  mouseStill: MOUSE_STILL_FIELDS,
  hoverDuration: TIME_FIELDS,
  idleDuration: TIME_FIELDS,
  timer: CLOCK_FIELDS,
  randomTimer: CLOCK_FIELDS,
  pomodoroComplete: POMODORO_COMPLETE_FIELDS,
  appLaunch: [],
  packageLoaded: []
};

export const FIELD_INPUT_TYPES = {
  timestamp: "number",
  petPosition: "object",
  mousePosition: "object",
  mouseLocalPosition: "object",
  isInsidePet: "boolean",
  distanceToPetCenter: "number",
  distanceToPetBounds: "number",
  screenPosition: "object",
  dragStartPosition: "object",
  currentPosition: "object",
  dragDeltaX: "number",
  dragDeltaY: "number",
  dragDistance: "number",
  dragDurationMs: "number",
  deltaX: "number",
  deltaY: "number",
  speed: "number",
  direction: "select",
  angleToPet: "number",
  angleToPetDegrees: "number",
  angleToPetProgress: "number",
  isMovingTowardPet: "boolean",
  isMovingAwayFromPet: "boolean",
  durationMs: "number",
  elapsedMs: "number",
  currentTime: "text",
  currentHour: "number",
  dayOfWeek: "select",
  label: "text"
};

const FILTER_OPERATORS_BY_INPUT_TYPE = {
  boolean: ["="],
  number: ["=", "!=", ">", ">=", "<", "<=", "between", "in", "notIn"],
  select: ["=", "!=", "in", "notIn"],
  text: ["=", "!=", "in", "notIn"]
};

function getFieldInputType(field) {
  return FIELD_INPUT_TYPES[field] || "text";
}

function isFilterableRuleField(field) {
  return Boolean(field) && getFieldInputType(field) !== "object";
}

function getFilterOperatorsForField(field) {
  if (!isFilterableRuleField(field)) return [];
  return FILTER_OPERATORS_BY_INPUT_TYPE[getFieldInputType(field)] || FILTER_OPERATORS_BY_INPUT_TYPE.text;
}

function normalizeFilterOperator(field, operator) {
  const operators = getFilterOperatorsForField(field);
  return operators.includes(operator) ? operator : (operators[0] || "=");
}

export const DEFAULT_DISPLAY = {
  x: 80,
  y: 160,
  scale: 1,
  opacity: 1,
  alwaysOnTop: true,
  mousePassthrough: false,
  locked: false
};

export function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const DEFAULT_KEYFRAMES = [
  { input: 0, output: 0 },
  { input: 0.25, output: 0.25 },
  { input: 0.5, output: 0.5 },
  { input: 0.75, output: 0.75 }
];

function clampProgress(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number));
}

export function normalizeKeyframes(keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) {
    return DEFAULT_KEYFRAMES.map((item) => ({ ...item }));
  }

  const lastIndex = Math.max(1, keyframes.length);
  const normalized = keyframes
    .map((kf, index) => {
      if (kf && typeof kf === "object" && !Array.isArray(kf)) {
        const input = clampProgress(kf.input ?? kf.position ?? (index / lastIndex));
        const output = clampProgress(kf.output ?? kf.value ?? kf.progress ?? input);
        return input === null || output === null ? null : { input, output };
      }

      const output = clampProgress(kf);
      const input = clampProgress(index / lastIndex);
      return input === null || output === null ? null : { input, output };
    })
    .filter(Boolean)
    .sort((left, right) => left.input - right.input);

  return normalized.length > 0 ? normalized : DEFAULT_KEYFRAMES.map((item) => ({ ...item }));
}

export function updateConfigAnimationKeyframes(config, clipId, keyframes) {
  const animations = config?.animations || { default: { id: "idle", asset: "" }, clips: [] };
  const clips = Array.isArray(animations.clips) ? animations.clips : [];
  const nextClips = clips.map((clip) =>
    clip.id === clipId ? { ...clip, keyframes: normalizeKeyframes(keyframes) } : clip
  );
  return {
    ...config,
    animations: {
      ...animations,
      clips: nextClips
    }
  };
}

/**
 * Point a clip at a freshly baked transparent asset and drop its green-screen
 * config (runtime keying is no longer needed once the asset is pre-keyed).
 */
export function applyBakedTransparentAsset(config, clipId, newAssetPath) {
  const animations = config?.animations || { default: { id: "idle", asset: "" }, clips: [] };
  const clips = Array.isArray(animations.clips) ? animations.clips : [];
  const repoint = (clip) => {
    if (!clip || clip.id !== clipId) return clip;
    const { greenScreen, ...rest } = clip;
    return { ...rest, asset: newAssetPath };
  };
  return {
    ...config,
    animations: {
      ...animations,
      default: repoint(animations.default),
      clips: clips.map(repoint)
    }
  };
}

/**
 * Check whether an asset path is still referenced by the default animation or
 * any clip.
 */
export function isAssetReferenced(config, assetPath) {
  if (!assetPath) return false;
  const animations = config?.animations || { default: {}, clips: [] };
  if (animations.default?.asset === assetPath) return true;
  const clips = Array.isArray(animations.clips) ? animations.clips : [];
  return clips.some((clip) => clip && clip.asset === assetPath);
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toOptionalNumber(value) {
  if (value === "" || value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseFilterValue(value, field, operator) {
  if (operator === "between") {
    return String(value)
      .split(",")
      .map((item) => Number(item.trim()))
      .filter(Number.isFinite);
  }

  if (operator === "in" || operator === "notIn") {
    return String(value)
      .split(",")
      .map((item) => parseSingleValue(item.trim(), field))
      .filter((item) => item !== "");
  }

  return parseSingleValue(value, field);
}

function parseSingleValue(value, field) {
  const inputType = getFieldInputType(field);
  if (inputType === "boolean") return value === true || value === "true" || value === "on";
  if (inputType === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  return String(value || "").trim();
}

function trimOptional(value) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function updateConfigDisplay(config, displayPatch) {
  return {
    ...config,
    display: {
      ...(config && config.display ? config.display : {}),
      ...displayPatch
    }
  };
}

export function updateConfigSystem(config, systemPatch) {
  return {
    ...config,
    system: {
      ...(config && config.system ? config.system : {}),
      ...systemPatch
    }
  };
}

export function isOnboardingPending(config) {
  const version = Number(config?.system?.onboardingVersion);
  return !Number.isFinite(version) || version < 1;
}

export function completeOnboarding(config) {
  return updateConfigSystem(config, { onboardingVersion: 1 });
}

export function updateConfigInteractions(config, interactionsPatch) {
  const currentInteractions = config && config.interactions && typeof config.interactions === "object"
    ? config.interactions
    : {};
  const currentBubble = currentInteractions.bubble && typeof currentInteractions.bubble === "object"
    ? currentInteractions.bubble
    : {};
  const nextBubblePatch = interactionsPatch && interactionsPatch.bubble && typeof interactionsPatch.bubble === "object"
    ? interactionsPatch.bubble
    : {};

  return {
    ...config,
    interactions: {
      ...currentInteractions,
      ...interactionsPatch,
      bubble: {
        ...currentBubble,
        ...nextBubblePatch
      }
    }
  };
}

function removeAssetFromEntry(entry, assetPath) {
  if (!entry || typeof entry !== "object") return entry;
  const nextEntry = { ...entry };
  if (nextEntry.asset === assetPath) delete nextEntry.asset;
  if (nextEntry.assetPath === assetPath) delete nextEntry.assetPath;
  return nextEntry;
}

export function removeConfigAssetReferences(config, assetPath) {
  const animations = config?.animations || { default: { id: "idle", asset: "" }, clips: [] };

  // Remove asset from default animation
  const newDefault = removeAssetFromEntry(animations.default, assetPath);

  // Remove asset from clips
  const newClips = animations.clips.map(clip => removeAssetFromEntry(clip, assetPath));

  return {
    ...config,
    animations: {
      default: newDefault,
      clips: newClips
    }
  };
}

function collectAssetsFromAnimations(assetSet, animations) {
  // Collect from default animation
  if (animations.default?.asset) {
    assetSet.add(animations.default.asset);
  }

  // Collect from clips
  if (Array.isArray(animations.clips)) {
    animations.clips.forEach(clip => {
      if (clip?.asset) {
        assetSet.add(clip.asset);
      }
    });
  }
}

export function getPanelOverviewStats(config) {
  const animations = config?.animations || { default: { id: "idle", asset: "" }, clips: [] };
  const rules = Array.isArray(config?.triggerRules) ? config.triggerRules : [];
  const assets = new Set();

  collectAssetsFromAnimations(assets, animations);

  const display = {
    ...DEFAULT_DISPLAY,
    ...(config?.display || {})
  };

  return {
    packageId: config?.currentPackageId || "None",
    animationCount: 1 + (animations.clips?.length || 0), // default + clips
    ruleCount: rules.length,
    assetCount: assets.size,
    displayScalePercent: Math.round(display.scale * 100),
    launchAtLogin: Boolean(config?.system?.launchAtLogin)
  };
}

export function getFieldsForCondition(conditionType) {
  const fields = TRIGGER_PARAMETER_FIELDS[conditionType];
  return Array.isArray(fields) ? fields : [];
}

// Timer scheduling values are dedicated settings on the condition, not filters.
// Filters participate in runtime event matching (see rule-engine.eventMatchesCondition),
// so scheduling parameters must never be stored there or the rule would fail to match.
function getConditionTimerSettings(conditionType, source = {}) {
  if (conditionType === "timer") {
    return { intervalMs: toOptionalNumber(source.intervalMs) };
  }
  if (conditionType === "randomTimer") {
    return {
      minMs: toOptionalNumber(source.minMs),
      maxMs: toOptionalNumber(source.maxMs)
    };
  }
  return {};
}

export function buildRuleConditionFromForm(form = {}) {
  const conditionType = trimOptional(form.type) || "click";
  const filterField = trimOptional(form.field);
  const supportedFields = getFieldsForCondition(conditionType);
  const hasSupportedFilter = filterField && supportedFields.includes(filterField) && isFilterableRuleField(filterField);
  const filterOperator = hasSupportedFilter
    ? normalizeFilterOperator(filterField, trimOptional(form.operator) || "=")
    : "=";
  const sustainMs = conditionType === "mouseMove" ? toOptionalNumber(form.sustainMs) : undefined;
  const required = form.required !== false && form.required !== "false";
  const filters = [];

  if (hasSupportedFilter) {
    filters.push(compactObject({
      field: filterField,
      operator: filterOperator,
      value: parseFilterValue(form.value, filterField, filterOperator)
    }));
  }

  return compactObject({
    type: conditionType,
    required,
    filters,
    sustainMs,
    ...getConditionTimerSettings(conditionType, form)
  });
}

export function validateRuleForm(form, existingActions = []) {
  const errors = [];
  const conditions = Array.isArray(form.conditions) && form.conditions.length > 0
    ? form.conditions
    : [{
      type: form.conditionType,
      filters: trimOptional(form.filterField)
        ? [{ field: form.filterField }]
        : []
    }];
  const actions = Array.isArray(form.actions) ? form.actions : [];
  const exitConditions = Array.isArray(form.exitConditions) ? form.exitConditions : [];

  const validateConditions = (items) => {
    for (const condition of items) {
      const conditionType = trimOptional(condition && condition.type) || "click";
      const supportedFields = getFieldsForCondition(conditionType);
      const filters = Array.isArray(condition && condition.filters) ? condition.filters : [];

      for (const filter of filters) {
        const filterField = trimOptional(filter && filter.field);
        if (filterField && !supportedFields.includes(filterField)) {
          errors.push(`Field ${filterField} is not supported by ${conditionType}.`);
        }
      }
    }
  };

  validateConditions(conditions);
  validateConditions(exitConditions);

  if (actions.length === 0) {
    errors.push("At least one action is required.");
  }

  return errors;
}

export function buildRuleFromForm(form) {
  const conditions = Array.isArray(form.conditions) && form.conditions.length > 0
    ? form.conditions.map((condition) => {
      const conditionType = trimOptional(condition.type) || "click";
      const filters = (Array.isArray(condition.filters) ? condition.filters : [])
        .map((filter) => buildRuleConditionFromForm({
          type: conditionType,
          field: filter.field,
          operator: filter.operator,
          value: filter.value
        }).filters[0])
        .filter(Boolean);
      return compactObject({
        type: conditionType,
        required: condition.required !== false,
        filters,
        sustainMs: conditionType === "mouseMove" ? toOptionalNumber(condition.sustainMs) : undefined,
        ...getConditionTimerSettings(conditionType, condition)
      });
    })
    : [(() => {
      return buildRuleConditionFromForm({
        type: form.conditionType,
        field: form.filterField,
        operator: form.filterOperator,
        value: form.filterValue,
        sustainMs: form.conditionSustainMs
      });
    })()];

  const actions = Array.isArray(form.actions) ? form.actions : [];
  const hasMouseMoveCondition = conditions.some((condition) => condition && condition.type === "mouseMove");
  const hasContinuousAction = hasMouseMoveCondition && actions.some((action) => action && action.type === "setKeyframeProgress");

  const exitConditions = Array.isArray(form.exitConditions) && form.exitConditions.length > 0
    ? form.exitConditions.map((condition) => {
      const conditionType = trimOptional(condition.type) || "mouseMove";
      const filters = (Array.isArray(condition.filters) ? condition.filters : [])
        .map((filter) => buildRuleConditionFromForm({
          type: conditionType,
          field: filter.field,
          operator: filter.operator,
          value: filter.value
        }).filters[0])
        .filter(Boolean);
      return compactObject({
        type: conditionType,
        required: condition.required !== false,
        filters,
        sustainMs: conditionType === "mouseMove" ? toOptionalNumber(condition.sustainMs) : undefined,
        ...getConditionTimerSettings(conditionType, condition)
      });
    })
    : [];
  const exitActions = Array.isArray(form.exitActions) ? form.exitActions : [];
  const hasExitState = hasMouseMoveCondition && (exitActions.length > 0 || exitConditions.length > 0);
  const state = hasExitState ? compactObject({
    exitConditions: exitConditions.length > 0 ? exitConditions : undefined,
    exitActions: exitActions.length > 0 ? exitActions : undefined
  }) : undefined;

  return compactObject({
    id: trimOptional(form.id) || createId("rule"),
    name: trimOptional(form.name) || "Untitled rule",
    enabled: Boolean(form.enabled),
    cooldownMs: toFiniteNumber(form.cooldownMs, 0),
    cooldownScope: form.cooldownScope === "eventType" ? "eventType" : undefined,
    priority: toFiniteNumber(form.priority, 0),
    stopOnMatch: form.stopOnMatch === false ? false : undefined,
    continuous: hasContinuousAction ? true : undefined,
    conditions,
    actionStrategy: trimOptional(form.actionStrategy) || "sequence",
    actions,
    state
  });
}

export function updateConfigRule(config, rule) {
  const rules = Array.isArray(config && config.triggerRules) ? config.triggerRules : [];
  const ruleIndex = rules.findIndex((item) => item && item.id === rule.id);
  const nextRules = ruleIndex >= 0
    ? rules.map((item, index) => (index === ruleIndex ? rule : item))
    : [...rules, rule];

  return {
    ...config,
    triggerRules: nextRules
  };
}

export function deleteConfigRule(config, ruleId) {
  const rules = Array.isArray(config && config.triggerRules) ? config.triggerRules : [];

  return {
    ...config,
    triggerRules: rules.filter((rule) => rule && rule.id !== ruleId)
  };
}
