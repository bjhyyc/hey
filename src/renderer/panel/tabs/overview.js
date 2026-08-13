/**
 * Overview tab
 */

import { escapeHtml } from "../ui/utils.js";
import { renderHeader } from "../ui/header.js";
import { t } from "../../../shared/i18n.js";
import { getPanelOverviewStats, isOnboardingPending } from "../panel-state.js";
import { DEFAULT_DISPLAY } from "../panel-state.js";

/**
 * Get display settings with defaults
 * @param {object} config - Configuration object
 * @returns {object} Display settings
 */

function getAssetExtension(asset) {
  const raw = String(asset || "").split(/[?#]/)[0];
  const filename = raw.split(/[\\/]/).pop() || "";
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

function isVideoAsset(asset) {
  return [".webm", ".mp4", ".mov"].includes(getAssetExtension(asset));
}

function renderSpritePreview(src, alt) {
  if (!src) return "";
  if (isVideoAsset(src)) {
    return `<video class="sprite-preview" src="${escapeHtml(src)}" muted loop autoplay playsinline preload="auto"></video>`;
  }
  return `<img class="sprite-preview" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
}

function getDisplay(config) {
  return {
    ...DEFAULT_DISPLAY,
    ...(config && config.display ? config.display : {})
  };
}

function renderOnboarding(config, uiState = {}) {
  if (uiState.onboardingJustCompleted) {
    return `
      <section class="onboarding-card onboarding-card-success" aria-labelledby="onboarding-success-title">
        <div class="onboarding-copy">
          <span class="onboarding-kicker">${t("onboarding.successKicker")}</span>
          <h3 id="onboarding-success-title">${t("onboarding.successTitle")}</h3>
          <p>${t("onboarding.successDescription")}</p>
        </div>
        <button type="button" class="button-primary" data-action="dismiss-onboarding-success">
          ${t("onboarding.startExploring")}
        </button>
      </section>
    `;
  }

  if (!isOnboardingPending(config)) return "";

  const installing = uiState.savingKey === "onboarding-sample-install";

  return `
    <section class="onboarding-card" aria-labelledby="onboarding-title">
      <div class="onboarding-copy">
        <span class="onboarding-kicker">${t("onboarding.kicker")}</span>
        <h3 id="onboarding-title">${t("onboarding.title")}</h3>
        <p>${t("onboarding.description")}</p>
      </div>
      <div class="onboarding-actions">
        <button type="button" class="button-primary" data-action="install-sample-petpack" ${installing ? "disabled" : ""}>
          ${installing ? t("onboarding.installing") : t("onboarding.install")}
        </button>
        <button type="button" class="onboarding-skip" data-action="skip-onboarding">
          ${t("onboarding.skip")}
        </button>
      </div>
    </section>
  `;
}

/**
 * Format relative time
 * @param {number} timestamp - Timestamp in ms
 * @returns {string} Relative time string
 */
function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${hours}h`;
}

/**
 * Get event type display name
 * @param {string} type - Event type
 * @returns {string} Display name
 */
function getEventTypeName(type) {
  return t(`rules.conditionTypes.${type}`) || type;
}

function getActionTypeName(type) {
  const key = `rules.actionTypes.${type}`;
  const label = t(key);
  return label === key ? type : label;
}

function getAnimationName(animationId, animationNamesById) {
  return animationNamesById[animationId] || animationId || "";
}

function formatActionSummary(action, animationNamesById) {
  if (!action || !action.type) return "";

  const parts = [getActionTypeName(action.type)];
  if (["playAnimation", "setKeyframeProgress"].includes(action.type) && action.animation) {
    parts.push(getAnimationName(action.animation, animationNamesById));
  }
  if (action.type !== "blank" && Number.isFinite(Number(action.durationMs))) {
    parts.push(`${Math.round(Number(action.durationMs))}ms`);
  }

  return parts.filter(Boolean).join(" · ");
}

function getRuleActionSummary(rule, animationNamesById) {
  const actions = Array.isArray(rule && rule.actions) ? rule.actions : [];
  if (actions.length === 0) return "";

  const visibleActions = actions
    .map((action) => formatActionSummary(action, animationNamesById))
    .filter(Boolean)
    .slice(0, 3);
  const remainingCount = actions.length - visibleActions.length;

  return remainingCount > 0
    ? `${visibleActions.join(", ")} +${remainingCount}`
    : visibleActions.join(", ");
}

/**
 * Render runtime status section
 * @param {object|null} runtimeState - Runtime state from pet
 * @param {object} config - Config for rule names
 * @returns {string} Runtime status HTML
 */
function renderRuntimeStatus(runtimeState, config) {
  if (!runtimeState) {
    return `
      <section class="panel-section runtime-status-section">
        <div class="section-header"><h3>${t("overview.runtimeStatus")}</h3></div>
        <div class="section-body">
          <p class="hint">${t("common.loading")}</p>
        </div>
      </section>
    `;
  }

  const { currentState, recentEvents, ruleStates } = runtimeState;

  // Get rule names from config
  const rules = (config && config.triggerRules) || [];
  const rulesById = {};
  rules.forEach(rule => {
    if (rule && rule.id) {
      rulesById[rule.id] = rule;
    }
  });

  // Get animation names from config
  const animations = config?.animations || { default: { id: "idle", name: t("panel.animations.defaultAnimation") }, clips: [] };
  const animationNamesById = {};
  if (animations.default) {
    animationNamesById[animations.default.id] = animations.default.name || animations.default.id;
  }
  (animations.clips || []).forEach(clip => {
    if (clip && clip.id) {
      animationNamesById[clip.id] = clip.name || clip.id;
    }
  });

  // Get current animation name
  const currentAnimId = currentState?.animation;
  const currentAnimName = currentAnimId ? (animationNamesById[currentAnimId] || currentAnimId) : t("overview.noAnimation");

  // Recent triggered rules
  const ruleEntries = Object.entries(ruleStates || {})
    .map(([ruleId, timestamp]) => ({
      ruleId,
      ruleName: (rulesById[ruleId] && rulesById[ruleId].name) || ruleId,
      actionSummary: getRuleActionSummary(rulesById[ruleId], animationNamesById),
      timestamp
    }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 6);

  // Recent events (last 8)
  const events = (recentEvents || []).slice(-8).reverse();

  return `
    <section class="panel-section runtime-status-section">
      <div class="section-header"><h3>${t("overview.runtimeStatus")}</h3></div>
      <div class="section-body">
        <div class="status-grid">
          <!-- Current Animation -->
          <div class="status-card">
            <h4>${t("overview.currentAnimation")}</h4>
            <div
              class="animation-info"
              data-current-animation="${escapeHtml(currentAnimId || '')}"
              data-current-sprite="${escapeHtml(currentState?.sprite || '')}"
            >
              ${currentState && currentState.sprite ? renderSpritePreview(currentState.sprite, currentAnimName) : ''}
              <div class="animation-details">
                <strong>${escapeHtml(currentAnimName)}</strong>
              </div>
            </div>
          </div>

          <!-- Recent Rules -->
          <div class="status-card recent-rules-card">
            <h4>${t("overview.recentRules")}</h4>
            ${ruleEntries.length > 0 ? `
              <ul class="rule-list">
                ${ruleEntries.map(entry => `
                  <li>
                    <span class="rule-details">
                      <span class="rule-name">${escapeHtml(entry.ruleName)}</span>
                      ${entry.actionSummary ? `<span class="rule-action-summary">${escapeHtml(entry.actionSummary)}</span>` : ""}
                    </span>
                    <span class="rule-time">${formatRelativeTime(entry.timestamp)}</span>
                  </li>
                `).join('')}
              </ul>
            ` : `<p class="hint">${t("overview.noRulesTriggered")}</p>`}
          </div>

          <!-- Event History -->
          <div class="status-card event-history-card">
            <h4>${t("overview.eventHistory")}</h4>
            ${events.length > 0 ? `
              <ul class="event-list">
                ${events.map(event => `
                  <li class="event-item event-type-${escapeHtml(event.type || 'unknown')}">
                    <span class="event-name">${getEventTypeName(event.type)}</span>
                    <span class="event-time">${formatRelativeTime(event.timestamp)}</span>
                  </li>
                `).join('')}
              </ul>
            ` : `<p class="hint">${t("overview.noEventsYet")}</p>`}
          </div>

        </div>
      </div>
    </section>
  `;
}

/**
 * Render overview tab
 * @param {object} config - Configuration object
 * @param {object|null} runtimeState - Runtime state from pet (optional)
 * @returns {string} Overview HTML
 */
export function renderOverview(config, runtimeState = null, uiState = {}) {
  const display = getDisplay(config);
  const stats = getPanelOverviewStats(config);

  return `
    ${renderHeader(t("overview.title"), t("overview.description"))}
    ${renderOnboarding(config, uiState)}
    <div class="metric-grid">
      <div class="metric"><span>${t("overview.package")}</span><strong>${escapeHtml(stats.packageId)}</strong></div>
      <div class="metric"><span>${t("overview.rules")}</span><strong>${stats.ruleCount}</strong></div>
      <div class="metric"><span>${t("overview.assets")}</span><strong>${stats.assetCount}</strong></div>
    </div>
    <section class="panel-section">
      <div class="section-header"><h3>${t("overview.activeDisplay")}</h3></div>
      <div class="section-body display-settings-grid">
        <div class="field"><span class="field-label">${t("overview.display")}</span><span>${stats.displayScalePercent}%</span></div>
        <div class="field"><span class="field-label">${t("overview.opacity")}</span><span>${Math.round(display.opacity * 100)}%</span></div>
        <div class="field"><span class="field-label">${t("overview.alwaysOnTop")}</span><span>${display.alwaysOnTop ? t("overview.enabled") : t("overview.disabled")}</span></div>
        <div class="field"><span class="field-label">${t("overview.mousePassthrough")}</span><span>${display.mousePassthrough ? t("overview.enabled") : t("overview.disabled")}</span></div>
      </div>
    </section>
    ${renderRuntimeStatus(runtimeState, config)}
  `;
}

/**
 * Update runtime status section only (called when state updates)
 * @param {object|null} runtimeState - Runtime state from pet
 * @param {object} config - Config for rule names
 */
export function updateRuntimeStatus(runtimeState, config) {
  const section = document.querySelector('.runtime-status-section');
  if (!section) return;

  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = renderRuntimeStatus(runtimeState, config);
  const newSection = tempDiv.querySelector('.runtime-status-section');

  if (newSection) {
    const currentAnimation = section.querySelector('.animation-info');
    const nextAnimation = newSection.querySelector('.animation-info');
    if (
      currentAnimation &&
      nextAnimation &&
      currentAnimation.dataset.currentAnimation === nextAnimation.dataset.currentAnimation &&
      currentAnimation.dataset.currentSprite === nextAnimation.dataset.currentSprite
    ) {
      nextAnimation.replaceWith(currentAnimation);
    }
    section.replaceWith(newSection);
  }
}
