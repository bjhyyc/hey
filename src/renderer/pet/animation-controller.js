/**
 * Animation Controller - Unity-style animation state machine
 *
 * Manages animation playback with three types:
 * - default: Always loops, fallback animation
 * - oneshot: Plays once, automatically returns to default
 * - loop: Loops continuously until manually stopped
 * - keyframe: Paused media that is scrubbed by an explicit progress value
 */

function normalizeClip(clip, fallbackType = "oneshot") {
  return {
    id: clip.id,
    name: clip.name || clip.id,
    asset: clip.asset,
    type: clip.type || fallbackType,
    loop: clip.type === "loop",
    durationMs: clip.durationMs,
    keyframes: clip.keyframes,
    greenScreen: clip.greenScreen,
    interrupt: Boolean(clip.interrupt),
    movement: clip.movement || undefined
  };
}

/**
 * AnimationController class
 * Manages animation clips and state transitions
 */
class AnimationController {
  /**
   * @param {object} config - Animation configuration
   * @param {object} config.default - Default animation (required)
   * @param {string} config.default.id - Animation ID
   * @param {string} config.default.asset - Asset path or URL
   * @param {Array} config.clips - Animation clips array
   * @param {object} renderer - Rendering callbacks
   * @param {function} renderer.renderClip - Function to render a clip: (asset, options) => void
   * @param {function} renderer.onClipEnd - Register clip end callback: (callback) => void
   */
  constructor(config = {}, renderer = {}, { logger = console } = {}) {
    if (!config.default || !config.default.asset) {
      throw new Error('Default animation is required');
    }

    if (typeof renderer.renderClip !== 'function') {
      throw new Error('renderer.renderClip function is required');
    }

    this.defaultClip = {
      id: config.default.id || 'default',
      name: config.default.name || config.default.id || 'default',
      asset: config.default.asset,
      type: 'default',
      loop: true,
      greenScreen: config.default.greenScreen
    };

    // Build clips map
    this.clips = new Map();
    this.clips.set(this.defaultClip.id, this.defaultClip);

    if (Array.isArray(config.clips)) {
      config.clips.forEach(clip => {
        if (clip && clip.id && clip.asset) {
          this.clips.set(clip.id, normalizeClip(clip));
        }
      });
    }

    this.renderer = renderer;
    this.logger = logger;
    this.currentState = 'default';
    this.currentClip = this.defaultClip;
    this.clipEndTimer = null;
    this.pending = null;
    this.loopStartedAt = 0;
    this.loopBoundaryTimer = null;
  }

  /**
   * 请求播放一个动画。若当前 active 受保护，则进入单槽等待区（最新者胜）。
   * @param {string} clipId
   * @param {object} options
   * @returns {boolean} 找到 clip 并已播放或已入队时为 true
   */
  playAnimation(clipId, options = {}) {
    if (!clipId) {
      this.logger.warn('playAnimation: clipId is required');
      return false;
    }
    if (!this.clips.has(clipId)) {
      this.logger.warn(`playAnimation: clip not found: ${clipId}`);
      return false;
    }

    const clip = this.clips.get(clipId);
    if (this._isProtected()) {
      if (clipId === this.currentClip.id) {
        this.logger.debug('animation:pending:ignored-duplicate', { clipId });
        return true;
      }
      // Interrupt clips bypass protection and play immediately, except for an
      // already-active duplicate which was handled above.
      if (clip.interrupt) {
        this.logger.debug('animation:interrupt:immediate', { clipId });
        this.clearClipEndTimer();
        this.pending = null;
        return this._playImmediate(clipId, options);
      }
      if (this.pending) {
        this.logger.debug('animation:pending:replaced', {
          from: this.pending.clipId,
          to: clipId
        });
      }
      this.pending = { clipId, options };
      this.logger.debug('animation:queue:pending', { clipId });
      this._scheduleLoopBoundary();
      return true;
    }

    this.logger.debug('animation:queue:immediate', { clipId });
    return this._playImmediate(clipId, options);
  }

  /**
   * 立即播放一个 clip（跳过排队判定）。
   * @private
   */
  _playImmediate(clipId, options = {}) {
    const clip = this.clips.get(clipId);
    if (!clip) {
      return false;
    }

    this.clearClipEndTimer();

    const playOptions = {
      loop: options.loop !== undefined ? options.loop : clip.loop,
      durationMs: options.durationMs || clip.durationMs
    };
    if (clip.greenScreen) {
      playOptions.greenScreen = clip.greenScreen;
    }

    if (clip.type === 'oneshot') {
      this.currentState = 'playing-oneshot';
    } else if (clip.type === 'loop') {
      this.currentState = 'playing-loop';
      this.loopStartedAt = Date.now();
    } else if (clip.type === 'keyframe') {
      this.currentState = 'playing-keyframe';
    } else {
      this.currentState = 'default';
    }

    this.currentClip = clip;

    if (clip.type === 'keyframe') {
      this.renderer.renderClip(clip.asset, {
        ...playOptions,
        keyframe: true,
        progress: options.progress || 0,
        clipId
      });
    } else {
      this.renderer.renderClip(clip.asset, playOptions);
    }

    // Notify that a clip became active. Fires for both immediate playback and
    // queue-advance (advanceToPending -> _playImmediate), so clip-bound side
    // effects (e.g. movement) run regardless of how the clip was reached.
    if (typeof this.renderer.onClipStart === 'function') {
      this.renderer.onClipStart(clip);
    }

    if (clip.type === 'oneshot') {
      const duration = playOptions.durationMs || 1000;
      this.clipEndTimer = setTimeout(() => {
        this.clipEndTimer = null;
        this.advanceToPending();
      }, duration);
    }

    return true;
  }

  /**
   * Set a keyframe animation to a normalized progress value.
   * @param {string} clipId - Keyframe clip ID
   * @param {number} progress - Playback progress from 0 to 1
   * @returns {boolean} true if the clip was found and progress was applied
   */
  setKeyframeProgress(clipId, progress = 0) {
    const clip = this.clips.get(clipId);
    if (!clip || clip.type !== 'keyframe') {
      return false;
    }

    this.clearClipEndTimer();
    this.pending = null;
    this.currentState = 'playing-keyframe';

    if (!this.currentClip || this.currentClip.id !== clipId) {
      this.currentClip = clip;
      this.renderer.renderClip(clip.asset, {
        keyframe: true,
        progress,
        clipId,
        ...(clip.greenScreen ? { greenScreen: clip.greenScreen } : {})
      });
      return true;
    }

    if (typeof this.renderer.setProgress === 'function') {
      if (this.renderer.setProgress(progress)) {
        return true;
      }
    }

    this.renderer.renderClip(clip.asset, {
      keyframe: true,
      progress,
      clipId,
      ...(clip.greenScreen ? { greenScreen: clip.greenScreen } : {})
    });
    return true;
  }

  /**
   * 停止当前动画回到默认。受保护的 active 走排队（loop 到边界、oneshot 等播完）。
   */
  stopAnimation() {
    if (this.currentState === 'default') {
      return;
    }
    if (this._isProtected()) {
      // 已有 pending -> 保留（最新入队者胜），active 播完后由 advanceToPending 播放它。
      // 无 pending -> 保持空等待项，active 播完后回 default。
      const hasPending = this.pending !== null;
      this.logger.debug('animation:stop:queued', { from: this.currentClip.id, hasPending });
      this._scheduleLoopBoundary(); // loop 走边界（有 pending 也需推进）；oneshot 由其定时器推进
      return;
    }
    this.clearClipEndTimer();
    this.returnToDefault();
  }

  /**
   * Return to default animation
   * @private
   */
  returnToDefault() {
    this.currentState = 'default';
    this.currentClip = this.defaultClip;
    this.renderer.renderClip(this.defaultClip.asset, {
      loop: true,
      ...(this.defaultClip.greenScreen ? { greenScreen: this.defaultClip.greenScreen } : {})
    });
    if (typeof this.renderer.onClipStart === 'function') {
      this.renderer.onClipStart(this.defaultClip);
    }
  }

  /**
   * Clear clip end timer
   * @private
   */
  clearClipEndTimer() {
    if (this.clipEndTimer) {
      clearTimeout(this.clipEndTimer);
      this.clipEndTimer = null;
    }
    if (this.loopBoundaryTimer) {
      clearTimeout(this.loopBoundaryTimer);
      this.loopBoundaryTimer = null;
    }
  }

  /**
   * 当前 active 是否受保护（不可被打断）：
   * oneshot 且其结束定时器仍在跑，或任意 loop。
   * @private
   */
  _isProtected() {
    if (this.currentState === 'playing-oneshot') {
      return this.clipEndTimer !== null;
    }
    if (this.currentState === 'playing-loop') {
      return true;
    }
    return false;
  }

  /**
   * 当 active 为 loop 且有等待项时，在下一个循环边界推进到等待项。
   * loop 无 durationMs -> 立即推进。已安排过则不重复安排。
   * @private
   */
  _scheduleLoopBoundary() {
    if (this.currentState !== 'playing-loop') {
      return;
    }
    if (this.loopBoundaryTimer) {
      return; // 已在等边界
    }
    const cycleMs = this.currentClip && this.currentClip.durationMs;
    if (!cycleMs || cycleMs <= 0) {
      this.advanceToPending();
      return;
    }
    const elapsed = Date.now() - this.loopStartedAt;
    const remaining = cycleMs - (elapsed % cycleMs);
    this.logger.debug('animation:loop:boundary-scheduled', { cycleMs, remaining });
    this.loopBoundaryTimer = setTimeout(() => {
      this.loopBoundaryTimer = null;
      this.advanceToPending();
    }, remaining);
  }

  /**
   * active 结束时推进：播放等待项，或回默认。
   * @private
   */
  advanceToPending() {
    const next = this.pending;
    this.pending = null;
    if (next && this.clips.has(next.clipId)) {
      this.logger.debug('animation:advance', { to: next.clipId });
      this._playImmediate(next.clipId, next.options);
    } else {
      this.logger.debug('animation:advance', { to: 'default' });
      this.returnToDefault();
    }
  }

  /**
   * Get current animation state
   * @returns {string} 'default' | 'playing-oneshot' | 'playing-loop' | 'playing-keyframe'
   */
  getCurrentState() {
    return this.currentState;
  }

  /**
   * Get current clip
   * @returns {object|null} Current clip object or null if destroyed
   */
  getCurrentClip() {
    return this.currentClip ? { ...this.currentClip } : null;
  }

  /**
   * Check if a clip exists
   * @param {string} clipId - Clip ID
   * @returns {boolean}
   */
  hasClip(clipId) {
    return this.clips.has(clipId);
  }

  /**
   * Get clip by ID
   * @param {string} clipId - Clip ID
   * @returns {object|null} Clip object or null
   */
  getClip(clipId) {
    const clip = this.clips.get(clipId);
    return clip ? { ...clip } : null;
  }

  /**
   * Get all clip IDs
   * @returns {Array<string>}
   */
  getClipIds() {
    return Array.from(this.clips.keys());
  }

  /**
   * Get all clips
   * @returns {Array<object>}
   */
  getAllClips() {
    return Array.from(this.clips.values()).map(clip => ({ ...clip }));
  }

  /**
   * Check if currently playing (not default)
   * @returns {boolean}
   */
  isPlaying() {
    return this.currentState !== 'default';
  }

  /**
   * Check if currently playing a oneshot animation
   * @returns {boolean}
   */
  isPlayingOneshot() {
    return this.currentState === 'playing-oneshot';
  }

  /**
   * Check if currently playing a loop animation
   * @returns {boolean}
   */
  isPlayingLoop() {
    return this.currentState === 'playing-loop';
  }

  /**
   * Check if currently showing a keyframe animation
   * @returns {boolean}
   */
  isPlayingKeyframe() {
    return this.currentState === 'playing-keyframe';
  }

  /**
   * Update configuration (reload clips)
   * @param {object} config - New animation configuration
   */
  updateConfig(config) {
    const wasShowingDefault = this.currentState === 'default';

    // Update default clip if provided
    if (config.default && config.default.asset) {
      this.defaultClip = {
        id: config.default.id || 'default',
        name: config.default.name || config.default.id || 'default',
        asset: config.default.asset,
        type: 'default',
        loop: true,
        greenScreen: config.default.greenScreen
      };
      this.clips.set(this.defaultClip.id, this.defaultClip);
    }

    // Rebuild clips map
    if (Array.isArray(config.clips)) {
      // Keep default, clear others
      const newClips = new Map();
      newClips.set(this.defaultClip.id, this.defaultClip);

      config.clips.forEach(clip => {
        if (clip && clip.id && clip.asset) {
          newClips.set(clip.id, normalizeClip(clip));
        }
      });

      this.clips = newClips;
    }

    if (wasShowingDefault) {
      this.currentClip = this.defaultClip;
      this.renderer.renderClip(this.defaultClip.asset, {
        loop: true,
        ...(this.defaultClip.greenScreen ? { greenScreen: this.defaultClip.greenScreen } : {})
      });
      if (typeof this.renderer.onClipStart === 'function') {
        this.renderer.onClipStart(this.defaultClip);
      }
    }

    // 等待项 clip 已被删除 -> 清空等待区
    if (this.pending && !this.clips.has(this.pending.clipId)) {
      this.logger.debug('animation:pending:cleared-on-config', { clipId: this.pending.clipId });
      this.pending = null;
    }

    // 当前 clip 已被删除 -> 回默认（并清理定时器）
    if (!this.clips.has(this.currentClip.id)) {
      this.clearClipEndTimer();
      this.pending = null;
      this.returnToDefault();
    } else if (this.currentState !== 'default') {
      // 当前 clip 仍存在 -> 重新指向 rebuild 后的新 clip 对象，
      // 使 durationMs 等被编辑的字段立即生效。
      this.currentClip = this.clips.get(this.currentClip.id);
      // 若 active loop 有一个待推进的边界定时器，用新的 durationMs 重排。
      if (this.loopBoundaryTimer) {
        clearTimeout(this.loopBoundaryTimer);
        this.loopBoundaryTimer = null;
        this._scheduleLoopBoundary();
      }
    }
  }

  /**
   * Destroy controller (cleanup)
   */
  destroy() {
    this.clearClipEndTimer();
    this.pending = null;
    this.clips.clear();
    this.currentClip = null;
    this.currentState = null;
  }
}

// ES module export (primary)
export { AnimationController };

// Export for CommonJS (for tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AnimationController };
}
