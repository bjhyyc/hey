import { createDebugLogger } from "./debug-utils.js";

const debugRulesLog = createDebugLogger("[desktop-pet:actions]");

/**
 * UserTriggerManager - Action dispatcher for the rule runtime
 *
 * Dispatches action descriptors from the rule engine to concrete
 * executor callbacks (animation, messages, display, etc.).
 */
class UserTriggerManager {
  /**
   * @param {object} actionExecutors - Action executor functions
   * @param {function} actionExecutors.playAnimation - Play animation handler
   * @param {function} actionExecutors.stopAnimation - Stop animation handler
   * @param {function} actionExecutors.showMessage - Show message handler
   * @param {function} actionExecutors.changeDisplay - Change display properties handler
   * @param {function} actionExecutors.resetPosition - Reset position handler
   * @param {function} actionExecutors.openPanel - Open panel handler
   * @param {object} options
   * @param {object} options.logger - Logger instance
   */
  constructor(actionExecutors = {}, { logger = console } = {}) {
    this.actionExecutors = actionExecutors;
    this.logger = logger;
  }

  isGlobalMouseEvent(eventContext = {}) {
    return eventContext && eventContext.eventSource === 'globalMouse';
  }

  resolveActionProgress(action, eventContext = {}) {
    const sourceField = action.progressFrom || action.progressField;
    const rawProgress = sourceField && Object.prototype.hasOwnProperty.call(eventContext, sourceField)
      ? eventContext[sourceField]
      : action.progress;
    const scale = Number.isFinite(Number(action.scale)) ? Number(action.scale) : 1;
    const offset = Number.isFinite(Number(action.offset)) ? Number(action.offset) : 0;
    const progress = Number(rawProgress ?? 0) * scale + offset;
    if (!Number.isFinite(progress)) return 0;
    return Math.min(1, Math.max(0, progress));
  }

  mapKeyframeProgress(animId, progress) {
    return this.actionExecutors.mapKeyframeProgress
      ? this.actionExecutors.mapKeyframeProgress(animId, progress)
      : progress;
  }

  /**
   * Execute single action
   */
  executeAction(action, eventContext = {}) {
    if (!action || typeof action !== "object") return;

    const actionType = action.type;
    if (!actionType) {
      this.logger.warn('Action missing type', action);
      return;
    }

    try {
      switch (actionType) {
        case 'blank':
          debugRulesLog('blank action', { eventContext });
          break;

        case 'delay':
          debugRulesLog('delay action', { durationMs: action.durationMs, eventContext });
          break;

        case 'playAnimation':
          if (this.actionExecutors.playAnimation) {
            const animId = action.animation;
            const isKeyframeAnimation = this.actionExecutors.isKeyframeAnimation && this.actionExecutors.isKeyframeAnimation(animId);
            if (isKeyframeAnimation && !this.isGlobalMouseEvent(eventContext)) {
              debugRulesLog('blocked playAnimation keyframe non-global', { animId, eventContext });
              break;
            }
            const options = isKeyframeAnimation
              ? { ...action, progress: this.mapKeyframeProgress(animId, this.resolveActionProgress(action, eventContext)) }
              : action;
            this.actionExecutors.playAnimation(animId, options);
          }
          break;

        case 'setKeyframeProgress':
          if (this.actionExecutors.setKeyframeProgress) {
            if (!this.isGlobalMouseEvent(eventContext)) {
              debugRulesLog('blocked setKeyframeProgress non-global', { action, eventContext });
              break;
            }
            const animId = action.animation;
            const progress = this.mapKeyframeProgress(animId, this.resolveActionProgress(action, eventContext));
            debugRulesLog('setKeyframeProgress', { animId, progress, eventContext });
            this.actionExecutors.setKeyframeProgress(animId, progress, action);
          }
          break;

        case 'stopAnimation':
          if (this.actionExecutors.stopAnimation) {
            this.actionExecutors.stopAnimation();
          }
          break;

        case 'showMessage':
          if (this.actionExecutors.showMessage) {
            const text = action.text;
            this.actionExecutors.showMessage(text, action);
          }
          break;

        case 'randomMessage':
          if (this.actionExecutors.showMessage && action.messages) {
            const messages = Array.isArray(action.messages) ? action.messages : [];
            if (messages.length > 0) {
              const msg = messages[Math.floor(Math.random() * messages.length)];
              this.actionExecutors.showMessage(msg, action);
            }
          }
          break;

        case 'changeScale':
        case 'changeOpacity':
        case 'changeDisplay':
          if (this.actionExecutors.changeDisplay) {
            this.actionExecutors.changeDisplay(action);
          }
          break;

        case 'movePet':
          if (this.actionExecutors.movePet) {
            this.actionExecutors.movePet(action);
          }
          break;

        case 'pomodoroTimer':
          if (this.actionExecutors.pomodoroTimer) {
            this.actionExecutors.pomodoroTimer(action, eventContext);
          }
          break;

        case 'hidePet':
        case 'showPet':
          if (this.actionExecutors.setVisibility) {
            this.actionExecutors.setVisibility(actionType === 'showPet', {
              sourceActionType: actionType,
              eventType: eventContext && eventContext.type
            });
          }
          break;

        case 'disableInteractions':
        case 'enableInteractions':
          if (this.actionExecutors.setInteractionsPaused) {
            this.actionExecutors.setInteractionsPaused(actionType === 'disableInteractions', {
              sourceActionType: actionType,
              eventType: eventContext && eventContext.type
            });
          }
          break;

        case 'resetPosition':
          if (this.actionExecutors.resetPosition) {
            this.actionExecutors.resetPosition();
          }
          break;

        case 'openPanel':
          if (this.actionExecutors.openPanel) {
            this.actionExecutors.openPanel();
          }
          break;

        default:
          this.logger.warn(`Unknown action type: ${actionType}`);
      }
    } catch (error) {
      this.logger.error(`Error executing action ${actionType}:`, error);
    }
  }
}

// ES module export (primary)
export { UserTriggerManager };

// Export for CommonJS (for tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { UserTriggerManager };
}
