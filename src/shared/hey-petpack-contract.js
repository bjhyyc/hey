const BEHAVIOR = require("./hey-petpack-behavior-v1.json");

const MAX_ACTION_DURATION_MS = 60_000;
const SAFE_PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_VERSION = /^\d+\.\d+\.\d+$/;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

deepFreeze(BEHAVIOR);

function requireText(value, label, maxLength = 128) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string up to ${maxLength} characters`);
  }
  return value;
}

function normalizeDurationsMs(durationsMs) {
  if (!durationsMs || typeof durationsMs !== "object" || Array.isArray(durationsMs)) {
    throw new TypeError("durationsMs must contain one measured duration for every action");
  }

  const expected = new Set(BEHAVIOR.actionOrder);
  const received = Object.keys(durationsMs);
  const unexpected = received.filter((actionId) => !expected.has(actionId));
  if (unexpected.length > 0) {
    throw new TypeError(`durationsMs contains unexpected actions: ${unexpected.join(", ")}`);
  }

  return Object.fromEntries(BEHAVIOR.actionOrder.map((actionId) => {
    const value = Number(durationsMs[actionId]);
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ACTION_DURATION_MS) {
      throw new TypeError(`durationsMs.${actionId} must be an integer between 1 and ${MAX_ACTION_DURATION_MS}`);
    }
    return [actionId, value];
  }));
}

function createCondition(rule) {
  const filters = Number.isSafeInteger(rule.elapsedMs)
    ? [{ field: "elapsedMs", operator: ">=", value: rule.elapsedMs, unit: "ms" }]
    : [];
  return { type: rule.eventType, required: true, filters };
}

function createHeyPetpackManifest({
  packageId,
  name = "Hey Pet",
  version = "1.0.0",
  preview = "preview.png",
  durationsMs
} = {}) {
  requireText(packageId, "packageId");
  if (!SAFE_PACKAGE_ID.test(packageId)) {
    throw new TypeError("packageId must be a safe single path segment");
  }
  requireText(name, "name");
  requireText(version, "version", 32);
  if (!SAFE_VERSION.test(version)) {
    throw new TypeError("version must use numeric semver, for example 1.0.0");
  }
  requireText(preview, "preview", 256);

  const measuredDurations = normalizeDurationsMs(durationsMs);
  const animationByAction = Object.fromEntries(BEHAVIOR.actionOrder.map((actionId) => {
    const definition = BEHAVIOR.animations[actionId];
    return [actionId, {
      id: definition.animationId,
      name: definition.name,
      asset: definition.asset,
      type: definition.type,
      durationMs: measuredDurations[actionId],
      ...(definition.type === "default" ? {} : { interrupt: Boolean(definition.interrupt) })
    }];
  }));

  const triggerRules = BEHAVIOR.rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    enabled: true,
    conditions: [createCondition(rule)],
    priority: rule.priority,
    cooldownMs: rule.cooldownMs,
    ...(rule.cooldownScope ? { cooldownScope: rule.cooldownScope } : {}),
    stopOnMatch: true,
    actionStrategy: "sequence",
    actions: rule.actions.map((actionId) => ({
      type: "playAnimation",
      animation: animationByAction[actionId].id
    }))
  }));

  return {
    schemaVersion: BEHAVIOR.schemaVersion,
    contractVersion: BEHAVIOR.contractVersion,
    packageId,
    name,
    version,
    preview,
    animations: {
      default: animationByAction.idle,
      clips: BEHAVIOR.actionOrder.slice(1).map((actionId) => animationByAction[actionId])
    },
    triggerRules
  };
}

function getNominalDurationsMs() {
  return Object.fromEntries(BEHAVIOR.actionOrder.map((actionId) => [
    actionId,
    BEHAVIOR.animations[actionId].nominalDurationMs
  ]));
}

module.exports = {
  ACTION_ORDER: Object.freeze([...BEHAVIOR.actionOrder]),
  BEHAVIOR,
  CONTRACT_VERSION: BEHAVIOR.contractVersion,
  createHeyPetpackManifest,
  getNominalDurationsMs,
  normalizeDurationsMs
};
