import { normalizeCondition, normalizeRuleConditions } from "./rule-utils.js";

const DEFAULT_CONDITION_WINDOW_MS = 1000;

function compareValues(actual, operator, expected) {
  switch (operator) {
    case "=":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected;
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected;
    case "between":
      return Array.isArray(expected) && expected.length >= 2 && actual >= expected[0] && actual <= expected[1];
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "notIn":
      return Array.isArray(expected) && !expected.includes(actual);
    default:
      return false;
  }
}

function eventMatchesCondition(event, rawCondition) {
  const condition = normalizeCondition(rawCondition);
  if (!condition || !event || typeof event !== "object" || event.type !== condition.type) return false;

  return condition.filters.every((filter) => {
    if (!filter || typeof filter !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(event, filter.field)) return false;
    return compareValues(event[filter.field], filter.operator, filter.value);
  });
}

function getValidEvents(eventHistory) {
  return eventHistory
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event && typeof event === "object" && !Array.isArray(event))
    .sort((left, right) => {
      const leftTimestamp = typeof left.event.timestamp === "number" ? left.event.timestamp : Number.NEGATIVE_INFINITY;
      const rightTimestamp = typeof right.event.timestamp === "number" ? right.event.timestamp : Number.NEGATIVE_INFINITY;

      if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
      return left.index - right.index;
    })
    .map(({ event }) => event);
}

function getCurrentEvent(validEvents) {
  return validEvents.length > 0 ? validEvents[validEvents.length - 1] : null;
}

function isContinuousMouseMoveRule(rule) {
  return rule.continuous === true &&
    normalizeRuleConditions(rule).some((condition) => condition && condition.type === "mouseMove");
}

function getActiveGlobalCooldown(rules, now, lastTriggeredAtByRuleId) {
  const rulesById = new Map(
    rules
      .filter((rule) => rule && typeof rule === "object" && rule.id)
      .map((rule) => [rule.id, rule])
  );
  let activeCooldown = null;

  for (const [ruleId, lastTriggeredAt] of Object.entries(lastTriggeredAtByRuleId || {})) {
    if (typeof lastTriggeredAt !== "number") continue;
    const rule = rulesById.get(ruleId);
    if (!rule || rule.enabled === false || isContinuousMouseMoveRule(rule)) continue;

    const cooldownMs = Number(rule.cooldownMs);
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) continue;

    const remainingMs = cooldownMs - (now - lastTriggeredAt);
    if (remainingMs <= 0) continue;

    if (!activeCooldown || remainingMs > activeCooldown.remainingMs) {
      activeCooldown = {
        ruleId,
        cooldownMs,
        lastTriggeredAt,
        remainingMs
      };
    }
  }

  return activeCooldown;
}

function getCooldownRulesForEvent(rules, event) {
  const eventType = event && event.type;
  return rules.filter((rule) => {
    if (!rule || rule.cooldownScope !== "eventType") return true;
    return normalizeRuleConditions(rule).some((condition) => condition && condition.type === eventType);
  });
}

function isCoolingDown(rule, activeGlobalCooldown) {
  if (!activeGlobalCooldown) return false;
  if (isContinuousMouseMoveRule(rule)) return false;

  return true;
}

function matchesRule(rule, validEvents, now) {
  const conditions = normalizeRuleConditions(rule);
  const currentEvent = getCurrentEvent(validEvents);

  if (conditions.length === 0 || !currentEvent) return false;

  const windowMs = typeof rule.conditionWindowMs === "number"
    ? rule.conditionWindowMs
    : DEFAULT_CONDITION_WINDOW_MS;
  const windowAnchor = typeof currentEvent.timestamp === "number" ? currentEvent.timestamp : now;
  const cutoff = windowAnchor - windowMs;
  const recentEvents = validEvents.filter((event) => {
    return typeof event.timestamp !== "number" || event.timestamp >= cutoff;
  });
  const requiredConditions = conditions.filter((condition) => condition.required !== false);
  const optionalConditions = conditions.filter((condition) => condition.required === false);
  const currentEventAnchorsRule = conditions.some((condition) => eventMatchesCondition(currentEvent, condition));

  if (!currentEventAnchorsRule) return false;

  const requiredMatched = requiredConditions.every((condition) => {
    return recentEvents.some((event) => eventMatchesCondition(event, condition));
  });
  if (!requiredMatched) return false;

  if (optionalConditions.length === 0) return true;

  return optionalConditions.some((condition) => {
    return recentEvents.some((event) => eventMatchesCondition(event, condition));
  });
}

/**
 * Test whether a single rule's conditions are satisfied by the current event,
 * using the provided event history for multi-condition group matching.
 * Exposed so stateful rules can independently evaluate their enter/exit condition
 * without participating in the multi-rule priority sort of evaluateRules().
 *
 * @param {object} rule - Rule object
 * @param {object} event - Current event
 * @param {Array} eventHistory - Full event history (used for AND matching)
 * @param {number} now - Current timestamp
 * @returns {boolean}
 */
function eventMatchesRule(rule, event, eventHistory, now) {
  if (!rule || !event || typeof event !== "object") return false;
  const validEvents = getValidEvents([...eventHistory, event]);
  return matchesRule(rule, validEvents, now);
}

function evaluateRules({
  rules = [],
  eventHistory = [],
  now = Date.now(),
  lastTriggeredAtByRuleId = {},
  cooldownRules = rules
} = {}) {
  const validEvents = getValidEvents(eventHistory);
  const activeGlobalCooldown = getActiveGlobalCooldown(cooldownRules, now, lastTriggeredAtByRuleId);

  return rules
    .filter((rule) => {
      if (!rule || typeof rule !== "object") return false;
      if (rule.enabled === false) return false;
      // Rules with a sustained mouseMove condition are driven by their own state
      // machine in the runtime; they must not also match through the plain
      // one-shot path.
      if (Array.isArray(rule.conditions) && rule.conditions.some((condition) => {
        const normalized = normalizeCondition(condition);
        const sustainMs = Number(normalized && normalized.sustainMs);
        return normalized && normalized.type === "mouseMove" && Number.isFinite(sustainMs) && sustainMs > 0;
      })) return false;
      if (isCoolingDown(rule, activeGlobalCooldown)) return false;
      return matchesRule(rule, validEvents, now);
    })
    .sort((left, right) => (right.priority || 0) - (left.priority || 0));
}

export {
  evaluateRules,
  eventMatchesRule,
  getActiveGlobalCooldown,
  getCooldownRulesForEvent,
  isContinuousMouseMoveRule
};

export default {
  evaluateRules,
  eventMatchesRule,
  getActiveGlobalCooldown,
  getCooldownRulesForEvent,
  isContinuousMouseMoveRule
};
