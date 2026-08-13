import {
  evaluateRules,
  eventMatchesRule,
  getActiveGlobalCooldown,
  isContinuousMouseMoveRule
} from "../../shared/rule-engine.js";
import { createDebugLogger } from "./debug-utils.js";

const debugRulesLog = createDebugLogger("[desktop-pet:rules]", {
  throttleMsByMessage: {
    "stateful-check": 500,
    "evaluate-result": 500
  }
});

function getAnimations(config = {}, manifest = null) {
  const manifestAnimations = manifest && manifest.animations ? manifest.animations : null;
  const configAnimations = config.animations || null;
  if (!manifestAnimations) {
    return configAnimations || { default: { id: "idle", asset: "" }, clips: [] };
  }
  if (!configAnimations) {
    return manifestAnimations;
  }

  const mergedClips = new Map();
  const addClip = (clip) => {
    if (!clip || !clip.id) return;
    const existing = mergedClips.get(clip.id) || {};
    const mergedGreenScreen = (existing.greenScreen || clip.greenScreen)
      ? { ...(existing.greenScreen || {}), ...(clip.greenScreen || {}) }
      : undefined;
    mergedClips.set(clip.id, {
      ...existing,
      ...clip,
      ...(mergedGreenScreen ? { greenScreen: mergedGreenScreen } : {})
    });
  };
  (Array.isArray(manifestAnimations.clips) ? manifestAnimations.clips : []).forEach(addClip);
  (Array.isArray(configAnimations.clips) ? configAnimations.clips : []).forEach(addClip);

  return {
    default: {
      ...(manifestAnimations.default || {}),
      ...(configAnimations.default || {})
    },
    clips: Array.from(mergedClips.values())
  };
}

function getAssetUrl(clip, assetsByPath) {
  return clip && clip.asset && assetsByPath[clip.asset] ? assetsByPath[clip.asset] : "";
}

function isLoadableAsset(asset) {
  if (typeof asset !== "string" || asset.trim() === "") return false;
  if (asset.startsWith("/")) return true;

  try {
    const url = new URL(asset);
    return ["file:", "data:", "blob:", "http:", "https:"].includes(url.protocol);
  } catch (_error) {
    return false;
  }
}

function mergeRulesById(manifestRules, configRules) {
  const merged = new Map();
  [...manifestRules, ...configRules].forEach((rule, index) => {
    if (!rule || typeof rule !== "object") return;
    const key = rule.id || `__index_${index}`;
    merged.set(key, rule);
  });
  return [...merged.values()];
}

export function buildRuntimeModel({
  config = {},
  activePackage = null
} = {}) {
  const manifest = activePackage && activePackage.manifest ? activePackage.manifest : null;
  const assetsByPath = activePackage && activePackage.assetsByPath ? activePackage.assetsByPath : {};
  const animations = getAnimations(config, manifest);
  const defaultClip = animations.default || { id: "idle", asset: "" };
  const clips = Array.isArray(animations.clips) ? animations.clips : [];
  const manifestRules = Array.isArray(manifest && manifest.triggerRules) ? manifest.triggerRules : [];
  const configRules = Array.isArray(config.triggerRules) ? config.triggerRules : [];

  const resolveClip = (clip) => ({
    ...clip,
    asset: getAssetUrl(clip, assetsByPath) ||
      (isLoadableAsset(clip && clip.asset) ? clip.asset : "")
  });

  // Resolve asset URLs for all clips
  const resolvedDefault = resolveClip(defaultClip);
  const resolvedClips = clips.map(resolveClip);
  const clipById = new Map([resolvedDefault, ...resolvedClips].filter(Boolean).map((clip) => [clip.id, clip]));

  return {
    config,
    activePackage,
    animationConfig: {
      default: resolvedDefault,
      clips: resolvedClips
    },
    clipById,
    rules: mergeRulesById(manifestRules, configRules)
  };
}


export function createRuleRuntime({
  rules = [],
  maxHistory = 40,
  now = Date.now,
  onTimerActions = null
} = {}) {
  const eventHistory = [];
  const lastTriggeredAtByRuleId = {};

  // Per-rule state for stateful (sustained) rules.
  // ruleId -> { conditionTrueSince: number|null, active: boolean, exitTrueSince: number|null }
  const ruleState = {};
  // Pending exit actions to flush before the next event returns actions.
  let pendingExitActions = [];
  let exitTimer = null;
  const EXIT_CHECK_INTERVAL_MS = 500;
  const MOUSE_MOVE_SUSTAIN_MAX_GAP_MS = 300;

  function getMouseMoveCondition(rule) {
    if (!rule || !Array.isArray(rule.conditions)) return null;
    return rule.conditions.find((condition) => condition && condition.type === "mouseMove") || null;
  }

  function hasExitState(rule) {
    const state = rule && rule.state ? rule.state : null;
    return Boolean(state && (
      (Array.isArray(state.exitConditions) && state.exitConditions.length > 0) ||
      (Array.isArray(state.exitActions) && state.exitActions.length > 0)
    ));
  }

  function isStatefulRule(rule) {
    const condition = getMouseMoveCondition(rule);
    if (!condition) return false;
    const sustainMs = Number(condition.sustainMs);
    return (Number.isFinite(sustainMs) && sustainMs > 0) || hasExitState(rule);
  }

  function buildExitRule(rule) {
    const state = rule && rule.state ? rule.state : null;
    if (!state || !Array.isArray(state.exitConditions) || state.exitConditions.length === 0) {
      return null;
    }
    return {
      conditions: state.exitConditions
    };
  }

  function getConditionSustainMs(condition) {
    const sustainMs = Number(condition && condition.sustainMs);
    return Number.isFinite(sustainMs) && sustainMs > 0 ? sustainMs : 0;
  }

  function getExitSustainMs(rule, currentEvent = null) {
    const exitRule = buildExitRule(rule);
    if (!exitRule) return 0;

    const conditions = exitRule.conditions.filter((condition) => condition && typeof condition === "object");
    const requiredConditions = conditions.filter((condition) => condition.required !== false);
    const optionalConditions = conditions.filter((condition) => condition.required === false);
    const sustainSource = requiredConditions.length > 0
      ? requiredConditions
      : optionalConditions.filter((condition) => !currentEvent || condition.type === currentEvent.type);

    return sustainSource.reduce((max, condition) => Math.max(max, getConditionSustainMs(condition)), 0);
  }

  function getState(ruleId) {
    if (!ruleState[ruleId]) {
      ruleState[ruleId] = { conditionTrueSince: null, active: false, exitTrueSince: null, lastMatchingEvent: null, lastExitEvent: null };
    }
    return ruleState[ruleId];
  }

  function defaultExitActions() {
    return [{ type: "stopAnimation" }];
  }

  function resolveExitActions(rule) {
    const exitActions = rule && rule.state && Array.isArray(rule.state.exitActions) && rule.state.exitActions.length > 0
      ? rule.state.exitActions
      : defaultExitActions();
    return exitActions.map((action) => ({ ...action }));
  }

  // Background timer ensures exit timeouts fire even when the cursor is still
  // (the global mouse tracker does not emit mouseMove when the position is
  // unchanged). Enter sustain is only advanced by matching mouseMove events, so
  // holding the cursor still does not count as sustained movement.
  function ensureExitTimer() {
    const anyPending = Object.keys(ruleState).some((id) => {
      const state = ruleState[id];
      return state && state.active;
    });
    if (anyPending && !exitTimer) {
      exitTimer = setInterval(tickStateChecks, EXIT_CHECK_INTERVAL_MS);
    } else if (!anyPending && exitTimer) {
      clearInterval(exitTimer);
      exitTimer = null;
    }
  }

  function tickStateChecks() {
    const currentNow = now();
    for (const rule of rules) {
      if (!isStatefulRule(rule)) continue;
      const state = getState(rule.id);

      if (!state.active) continue;
      const exitSustainMs = getExitSustainMs(rule, state.lastExitEvent);
      if (!Number.isFinite(exitSustainMs) || exitSustainMs <= 0) continue;
      if (state.exitTrueSince !== null && currentNow - state.exitTrueSince >= exitSustainMs) {
        debugRulesLog("timer-exit", {
          ruleId: rule.id,
          ruleName: rule.name,
          since: state.exitTrueSince,
          now: currentNow,
          threshold: exitSustainMs,
          lastEvent: state.lastExitEvent
        });
        flushExit(rule, currentNow);
      }
    }
    ensureExitTimer();
  }

  function dispatchTimerActions(actions, eventContext) {
    if (typeof onTimerActions === "function") {
      onTimerActions(actions, eventContext);
      return true;
    }
    return false;
  }

  function enterRule(rule, timestamp, eventContext, dispatchImmediately = false) {
    const state = getState(rule.id);
    if (state.active) return [];
    state.active = true;
    state.exitTrueSince = null;
    lastTriggeredAtByRuleId[rule.id] = timestamp;
    const actions = collectRuleActions(rule);
    debugRulesLog("enter", {
      ruleId: rule.id,
      ruleName: rule.name,
      timestamp,
      dispatchImmediately,
      eventSource: eventContext && eventContext.eventSource,
      distanceToPetCenter: eventContext && eventContext.distanceToPetCenter,
      angleToPetProgress: eventContext && eventContext.angleToPetProgress,
      actions
    });
    if (dispatchImmediately) {
      dispatchTimerActions(actions, {
        ...eventContext,
        timestamp,
        stateTransition: "enter",
        ruleId: rule.id
      });
      return [];
    }
    return actions;
  }


  function flushExit(rule, timestamp) {
    const state = getState(rule.id);
    if (!state.active) return;
    const eventContext = state.lastExitEvent
      ? { ...state.lastExitEvent, timestamp, stateTransition: "exit", ruleId: rule.id }
      : { type: "stateExit", ruleId: rule.id, timestamp, eventSource: "ruleRuntime" };
    state.active = false;
    state.conditionTrueSince = null;
    state.exitTrueSince = null;
    state.lastMatchingEvent = null;
    state.lastExitEvent = null;
    lastTriggeredAtByRuleId[rule.id] = timestamp;
    const exitActions = resolveExitActions(rule);
    debugRulesLog("exit", {
      ruleId: rule.id,
      ruleName: rule.name,
      timestamp,
      eventSource: eventContext && eventContext.eventSource,
      distanceToPetCenter: eventContext && eventContext.distanceToPetCenter,
      actions: exitActions
    });
    if (dispatchTimerActions(exitActions, eventContext || { type: "stateExit", ruleId: rule.id, timestamp: now(), eventSource: "ruleRuntime" })) {
      return;
    }
    pendingExitActions.push(...exitActions);
  }

  function collectRuleActions(rule) {
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    if (rule.actionStrategy === "random" && actions.length > 0) {
      return [actions[Math.floor(Math.random() * actions.length)]];
    }
    return actions.map((action) => ({ ...action }));
  }

  function ruleRequiresGlobalMouse(rule) {
    const actions = Array.isArray(rule && rule.actions) ? rule.actions : [];
    return actions.some((action) => action && (
      action.type === "setKeyframeProgress" ||
      action.progressFrom === "angleToPetProgress" ||
      action.progressField === "angleToPetProgress"
    ));
  }

  function shouldEvaluateRuleForEvent(rule, event) {
    if (
      event &&
      event.timerRuleId &&
      ["timer", "randomTimer"].includes(event.type) &&
      rule &&
      rule.id !== event.timerRuleId
    ) {
      return false;
    }
    if (!ruleRequiresGlobalMouse(rule)) return true;
    if (!event || event.type !== "mouseMove") return true;
    return event.eventSource === "globalMouse";
  }

  function getRuleConditions(rule) {
    if (Array.isArray(rule && rule.conditions)) return rule.conditions;
    return [];
  }

  function eventMatchesAnyConditionType(rule, event) {
    if (!event || !event.type) return false;
    return getRuleConditions(rule).some((condition) => condition && condition.type === event.type);
  }

  function isDragEvent(event) {
    return event && ["dragStart", "dragging", "dragEnd"].includes(event.type);
  }

  function resetPendingMouseMoveEnters(event) {
    for (const rule of rules) {
      if (!isStatefulRule(rule)) continue;
      const state = getState(rule.id);
      if (state.active || state.conditionTrueSince === null) continue;
      debugRulesLog("reset-pending-enter-during-drag", {
        ruleId: rule.id,
        ruleName: rule.name,
        eventType: event.type,
        previousSince: state.conditionTrueSince
      });
      state.conditionTrueSince = null;
      state.lastMatchingEvent = null;
    }
  }

  // Advance stateful rules against the current event. Returns enter actions
  // for any rule that just became active this tick.
  function advanceStatefulRules(currentEvent, timestamp) {
    if (isDragEvent(currentEvent)) {
      resetPendingMouseMoveEnters(currentEvent);
    }

    const justEntered = [];
    const activeGlobalCooldown = getActiveGlobalCooldown(rules, timestamp, lastTriggeredAtByRuleId);
    for (const rule of rules) {
      if (!isStatefulRule(rule)) continue;
      if (!shouldEvaluateRuleForEvent(rule, currentEvent)) {
        debugRulesLog("skip-event-source", {
          ruleId: rule.id,
          ruleName: rule.name,
          eventType: currentEvent && currentEvent.type,
          eventSource: currentEvent && currentEvent.eventSource
        });
        continue;
      }
      const state = getState(rule.id);
      if (!state.active && activeGlobalCooldown && !isContinuousMouseMoveRule(rule)) {
        debugRulesLog("skip-stateful-global-cooldown", {
          ruleId: rule.id,
          ruleName: rule.name,
          eventType: currentEvent && currentEvent.type,
          cooldownRuleId: activeGlobalCooldown.ruleId,
          cooldownMs: activeGlobalCooldown.cooldownMs,
          remainingMs: activeGlobalCooldown.remainingMs
        });
        continue;
      }
      const enterEventRelevant = eventMatchesAnyConditionType(rule, currentEvent);
      const matches = enterEventRelevant ? eventMatchesRule(rule, currentEvent, eventHistory, timestamp) : false;
      const wasActive = state.active;
      let emittedThisTick = false;
      debugRulesLog("stateful-check", {
        ruleId: rule.id,
        ruleName: rule.name,
        eventType: currentEvent && currentEvent.type,
        eventSource: currentEvent && currentEvent.eventSource,
        distanceToPetCenter: currentEvent && currentEvent.distanceToPetCenter,
        distanceToPetBounds: currentEvent && currentEvent.distanceToPetBounds,
        durationMs: currentEvent && currentEvent.durationMs,
        angleToPetProgress: currentEvent && currentEvent.angleToPetProgress,
        enterEventRelevant,
        matches,
        active: state.active,
        conditionTrueSince: state.conditionTrueSince,
        exitTrueSince: state.exitTrueSince
      });

      if (matches) {
        const previousMatchingTimestamp = state.lastMatchingEvent && typeof state.lastMatchingEvent.timestamp === "number"
          ? state.lastMatchingEvent.timestamp
          : null;
        const matchingGapMs = previousMatchingTimestamp === null ? 0 : timestamp - previousMatchingTimestamp;
        if (
          state.conditionTrueSince !== null &&
          Number.isFinite(matchingGapMs) &&
          matchingGapMs > MOUSE_MOVE_SUSTAIN_MAX_GAP_MS
        ) {
          debugRulesLog("reset-pending-enter-after-gap", {
            ruleId: rule.id,
            ruleName: rule.name,
            eventType: currentEvent && currentEvent.type,
            previousTimestamp: previousMatchingTimestamp,
            timestamp,
            gapMs: matchingGapMs
          });
          state.conditionTrueSince = timestamp;
        } else if (state.conditionTrueSince === null) {
          state.conditionTrueSince = timestamp;
        }
        state.lastMatchingEvent = currentEvent;
        const sustainedCondition = getMouseMoveCondition(rule);
        const sustainMs = Number(sustainedCondition && sustainedCondition.sustainMs);
        const threshold = Number.isFinite(sustainMs) && sustainMs > 0 ? sustainMs : 0;
        if (!state.active && timestamp - state.conditionTrueSince >= threshold) {
          justEntered.push(...enterRule(rule, timestamp, currentEvent));
          emittedThisTick = true;
        }
      } else if (enterEventRelevant) {
        state.conditionTrueSince = null;
        state.lastMatchingEvent = null;
      }

      if (state.active) {
        const exitRule = buildExitRule(rule);
        const exitEventRelevant = exitRule ? eventMatchesAnyConditionType(exitRule, currentEvent) : false;
        const exitMatches = exitEventRelevant
          ? eventMatchesRule(exitRule, currentEvent, eventHistory, timestamp)
          : false;
        if (exitEventRelevant && exitMatches) {
          if (state.exitTrueSince === null) {
            state.exitTrueSince = timestamp;
          }
          state.lastExitEvent = currentEvent;
        } else if (exitEventRelevant) {
          state.exitTrueSince = null;
          state.lastExitEvent = null;
        }

        const exitSustainMs = getExitSustainMs(rule, currentEvent);
        if (exitRule && exitMatches && (!Number.isFinite(exitSustainMs) || exitSustainMs <= 0)) {
          flushExit(rule, timestamp);
        } else if (Number.isFinite(exitSustainMs) && exitSustainMs > 0
          && state.exitTrueSince !== null
          && timestamp - state.exitTrueSince >= exitSustainMs) {
          flushExit(rule, timestamp);
        }
      }

      if (state.active && wasActive && rule.continuous === true && enterEventRelevant && !emittedThisTick) {
        // Continuous stateful rules (e.g. keyframe scrubbing driven by mouse
        // angle) keep re-emitting while active, including hysteresis bands
        // between enter and exit conditions, so the output keeps following.
        justEntered.push(...collectRuleActions(rule));
      }
    }
    return justEntered;
  }

  return {
    evaluateEvent(event) {
      const timestamp = typeof event.timestamp === "number" ? event.timestamp : now();
      const nextEvent = { ...event, timestamp };
      eventHistory.push(nextEvent);
      if (eventHistory.length > maxHistory) {
        eventHistory.splice(0, eventHistory.length - maxHistory);
      }

      // Advance stateful rules first. Enters produce actions to run this tick;
      // exits are queued into pendingExitActions.
      const enterActions = advanceStatefulRules(nextEvent, timestamp);

      // Stateful rules that are currently active suppress competing non-stateful
      // rules so their animation is not interrupted.
      const hasActiveStateful = Object.keys(ruleState).some((id) => ruleState[id] && ruleState[id].active);

      let actions = [];
      if (enterActions.length > 0) {
        actions = enterActions;
      } else if (pendingExitActions.length > 0) {
        actions = pendingExitActions;
        pendingExitActions = [];
      } else if (!hasActiveStateful) {
        const candidateRules = rules.filter((rule) => !isStatefulRule(rule) && shouldEvaluateRuleForEvent(rule, nextEvent));
        const cooldownRules = rules.filter((rule) => !isStatefulRule(rule));
        const activeGlobalCooldown = getActiveGlobalCooldown(cooldownRules, timestamp, lastTriggeredAtByRuleId);
        if (activeGlobalCooldown) {
          debugRulesLog("global-cooldown-active", {
            eventType: nextEvent.type,
            eventSource: nextEvent.eventSource,
            cooldownRuleId: activeGlobalCooldown.ruleId,
            cooldownMs: activeGlobalCooldown.cooldownMs,
            remainingMs: activeGlobalCooldown.remainingMs
          });
        }
        const matchedRules = evaluateRules({
          rules: candidateRules,
          eventHistory,
          now: timestamp,
          lastTriggeredAtByRuleId,
          cooldownRules
        });
        const executedRuleIds = [];
        let stoppedByRuleId = null;
        for (const rule of matchedRules) {
          const ruleActions = collectRuleActions(rule);
          if (ruleActions.length === 0) continue;

          lastTriggeredAtByRuleId[rule.id] = timestamp;
          executedRuleIds.push(rule.id);
          actions.push(...ruleActions);

          if (rule.stopOnMatch !== false) {
            stoppedByRuleId = rule.id;
            break;
          }
        }
        if (matchedRules.length > 0) {
          debugRulesLog("matched-rules", {
            eventType: nextEvent.type,
            eventSource: nextEvent.eventSource,
            matchedRuleIds: matchedRules.map((rule) => rule.id),
            executedRuleIds,
            stoppedByRuleId,
            actionCount: actions.length
          });
        }
      }

      ensureExitTimer();
      debugRulesLog("evaluate-result", {
        eventType: nextEvent.type,
        eventSource: nextEvent.eventSource,
        actions,
        state: Object.fromEntries(Object.entries(ruleState).map(([id, value]) => [id, {
          active: value.active,
          conditionTrueSince: value.conditionTrueSince,
          exitTrueSince: value.exitTrueSince
        }]))
      });
      return actions;
    },

    getLastTriggeredAtByRuleId() {
      return { ...lastTriggeredAtByRuleId };
    },

    getRuleState() {
      const snapshot = {};
      for (const id of Object.keys(ruleState)) {
        snapshot[id] = { ...ruleState[id] };
      }
      return snapshot;
    },

    getRecentEvents() {
      return eventHistory.slice();
    },

    resetPendingMouseMoveEnters(event) {
      resetPendingMouseMoveEnters(event || { type: "manualReset", eventSource: "ruleRuntime" });
      ensureExitTimer();
    },

    destroy() {
      if (exitTimer) {
        clearInterval(exitTimer);
        exitTimer = null;
      }
    }
  };
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function clampProgress(value) {
  const progress = clampNumber(Number(value), 0, 1);
  return progress === null ? 0 : progress;
}


function normalizeKeyframes(keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return null;
  const lastIndex = Math.max(1, keyframes.length);
  const normalized = keyframes
    .map((keyframe, index) => {
      if (keyframe && typeof keyframe === "object" && !Array.isArray(keyframe)) {
        return {
          input: clampProgress(Number(keyframe.input ?? keyframe.position ?? (index / lastIndex))),
          output: clampProgress(Number(keyframe.output ?? keyframe.value ?? keyframe.progress ?? keyframe.input ?? (index / lastIndex)))
        };
      }
      return {
        input: clampProgress(index / lastIndex),
        output: clampProgress(Number(keyframe))
      };
    })
    .filter((keyframe) => Number.isFinite(keyframe.input) && Number.isFinite(keyframe.output))
    .sort((left, right) => left.input - right.input);
  return normalized.length > 0 ? normalized : null;
}

function interpolateWrapped(left, right, t) {
  if (right < left) {
    return (left + (1 - left + right) * t) % 1;
  }
  return left + (right - left) * t;
}

export function mapProgressThroughKeyframes(progress, keyframes) {
  const normalized = normalizeKeyframes(keyframes);
  const value = clampProgress(progress);
  if (!normalized || normalized.length === 1) return value;

  for (let index = 0; index < normalized.length - 1; index += 1) {
    const left = normalized[index];
    const right = normalized[index + 1];
    if (value >= left.input && value <= right.input) {
      const span = right.input - left.input;
      const t = span > 0 ? (value - left.input) / span : 0;
      return clampProgress(interpolateWrapped(left.output, right.output, t));
    }
  }

  const last = normalized[normalized.length - 1];
  const first = normalized[0];
  const wrappedValue = value < first.input ? value + 1 : value;
  const wrappedFirstInput = first.input + 1;
  const span = wrappedFirstInput - last.input;
  const t = span > 0 ? (wrappedValue - last.input) / span : 0;
  return clampProgress(interpolateWrapped(last.output, first.output, t));
}
