const profile = require("./studio-behavior-profile.json");

const STUDIO_BEHAVIOR_PROFILE = profile.profile;
const STUDIO_ACTION_KEYS = Object.freeze([...profile.actionKeys]);
const STUDIO_ONESHOT_ACTION_KEYS = new Set(profile.oneshotActionKeys);
const STUDIO_INTERRUPT_ACTION_KEYS = new Set(profile.interruptActionKeys);
const DEFAULT_STUDIO_TIMING = Object.freeze({ ...profile.defaultTiming });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getStudioBehavior(manifest) {
  if (!manifest || !isPlainObject(manifest.studioBehavior)) return null;
  return manifest.studioBehavior;
}

function getStudioBehaviorTiming(behavior) {
  const timing = isPlainObject(behavior && behavior.timing) ? behavior.timing : {};
  return {
    idleTimeoutMs: Number(timing.idleTimeoutMs ?? DEFAULT_STUDIO_TIMING.idleTimeoutMs),
    hoverDelayMs: Number(timing.hoverDelayMs ?? DEFAULT_STUDIO_TIMING.hoverDelayMs),
    hoverCooldownMs: Number(timing.hoverCooldownMs ?? DEFAULT_STUDIO_TIMING.hoverCooldownMs)
  };
}

function getAnimationById(animations) {
  const clips = [];
  if (animations && animations.default) {
    clips.push({ ...animations.default, type: "default" });
  }
  if (Array.isArray(animations && animations.clips)) {
    clips.push(...animations.clips);
  }
  return new Map(clips.filter((clip) => clip && clip.id).map((clip) => [clip.id, clip]));
}

function validateStudioBehavior(behavior, animations, triggerRules, errors) {
  if (behavior === undefined) return;
  if (!isPlainObject(behavior)) {
    errors.push("studioBehavior must be an object");
    return;
  }
  if (behavior.profile !== STUDIO_BEHAVIOR_PROFILE) {
    errors.push(`studioBehavior.profile must be ${STUDIO_BEHAVIOR_PROFILE}`);
  }

  const actionClipIds = behavior.actionClipIds;
  if (!isPlainObject(actionClipIds)) {
    errors.push("studioBehavior.actionClipIds must be an object");
    return;
  }

  const unexpectedKeys = Object.keys(actionClipIds).filter((key) => !STUDIO_ACTION_KEYS.includes(key));
  if (unexpectedKeys.length > 0) {
    errors.push(`studioBehavior.actionClipIds has unsupported actions: ${unexpectedKeys.join(", ")}`);
  }

  const animationById = getAnimationById(animations);
  const seenClipIds = new Set();
  const seenAssets = new Set();
  for (const actionKey of STUDIO_ACTION_KEYS) {
    const clipId = actionClipIds[actionKey];
    if (typeof clipId !== "string" || !clipId) {
      errors.push(`studioBehavior.actionClipIds.${actionKey} is required`);
      continue;
    }
    if (seenClipIds.has(clipId)) {
      errors.push(`studioBehavior.actionClipIds.${actionKey} must reference a unique clip`);
      continue;
    }
    seenClipIds.add(clipId);

    const clip = animationById.get(clipId);
    if (!clip) {
      errors.push(`studioBehavior.actionClipIds.${actionKey} references missing animation: ${clipId}`);
      continue;
    }
    if (!clip.asset) {
      errors.push(`studioBehavior action ${actionKey} must have an asset`);
    } else if (seenAssets.has(clip.asset)) {
      errors.push(`studioBehavior action ${actionKey} must use a unique asset`);
    } else {
      seenAssets.add(clip.asset);
    }

    if (actionKey === "idle" && clip.type !== "default") {
      errors.push("studioBehavior idle action must reference animations.default");
    }
    if (actionKey === "sleepLoop" && clip.type !== "loop") {
      errors.push("studioBehavior sleepLoop action must use a loop clip");
    }
    if (STUDIO_ONESHOT_ACTION_KEYS.has(actionKey) && clip.type !== "oneshot") {
      errors.push(`studioBehavior ${actionKey} action must use a oneshot clip`);
    }
    if (STUDIO_INTERRUPT_ACTION_KEYS.has(actionKey) && clip.interrupt !== true) {
      errors.push(`studioBehavior ${actionKey} action must be interruptible`);
    }
    if (clip.movement) {
      errors.push(`studioBehavior action ${actionKey} cannot move the pet window`);
    }
  }

  const clipCount = Array.isArray(animations && animations.clips) ? animations.clips.length : 0;
  if (clipCount !== STUDIO_ACTION_KEYS.length - 1) {
    errors.push("studioBehavior requires exactly six non-default clips");
  }

  if (Array.isArray(triggerRules) && triggerRules.length > 0) {
    errors.push("studioBehavior packages must not include generic triggerRules");
  }

  if (!isPlainObject(behavior.timing)) {
    errors.push("studioBehavior.timing must be an object");
    return;
  }
  const timing = getStudioBehaviorTiming(behavior);
  if (timing.idleTimeoutMs !== DEFAULT_STUDIO_TIMING.idleTimeoutMs) {
    errors.push(`studioBehavior.timing.idleTimeoutMs must be ${DEFAULT_STUDIO_TIMING.idleTimeoutMs}`);
  }
  if (timing.hoverDelayMs !== DEFAULT_STUDIO_TIMING.hoverDelayMs) {
    errors.push(`studioBehavior.timing.hoverDelayMs must be ${DEFAULT_STUDIO_TIMING.hoverDelayMs}`);
  }
  if (!Number.isFinite(timing.hoverCooldownMs) || timing.hoverCooldownMs < 15000 || timing.hoverCooldownMs > 30000) {
    errors.push("studioBehavior.timing.hoverCooldownMs must be between 15000 and 30000");
  }
}

module.exports = {
  DEFAULT_STUDIO_TIMING,
  STUDIO_ACTION_KEYS,
  STUDIO_BEHAVIOR_PROFILE,
  getStudioBehavior,
  getStudioBehaviorTiming,
  validateStudioBehavior
};
