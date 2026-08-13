/**
 * Event Bus - Core event dispatching system
 *
 * Implements pub-sub pattern with priority-based execution
 * and propagation control.
 */

/**
 * EventBus class - Central event dispatcher
 */
class EventBus {
  constructor({ logger = console } = {}) {
    // Map<eventType: string, Listener[]>
    this.listeners = new Map();
    this.logger = logger;

    // Event history for debugging and diagnostics
    this.eventHistory = [];
    this.maxHistorySize = 40;

    // ID counter for generating unique listener IDs
    this.listenerCounter = 0;
  }

  /**
   * Subscribe to an event type
   * @param {string} eventType - Event type to listen for (e.g., 'click', 'dragStart')
   * @param {function} callback - Callback function (eventContext) => boolean
   * @param {object} options - Subscription options
   * @param {number} options.priority - Priority (0-100, higher executes first)
   * @param {string} options.id - Listener ID (auto-generated if not provided)
   * @param {boolean} options.system - Whether this is a system listener (highest priority)
   * @returns {string} Listener ID (for unsubscribing)
   */
  subscribe(eventType, callback, options = {}) {
    if (typeof eventType !== 'string' || !eventType) {
      throw new Error('eventType must be a non-empty string');
    }

    if (typeof callback !== 'function') {
      throw new Error('callback must be a function');
    }

    const listener = {
      id: options.id || this.generateId(),
      callback,
      priority: typeof options.priority === 'number' ? options.priority : 0,
      system: Boolean(options.system)
    };

    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }

    this.listeners.get(eventType).push(listener);
    this.sortListeners(eventType);

    return listener.id;
  }

  /**
   * Unsubscribe a listener
   * @param {string} listenerId - Listener ID returned by subscribe()
   * @returns {boolean} true if listener was found and removed
   */
  unsubscribe(listenerId) {
    for (const [eventType, listeners] of this.listeners.entries()) {
      const index = listeners.findIndex(l => l.id === listenerId);
      if (index !== -1) {
        listeners.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Unsubscribe all listeners for an event type
   * @param {string} eventType - Event type
   * @returns {number} Number of listeners removed
   */
  unsubscribeAll(eventType) {
    const listeners = this.listeners.get(eventType);
    if (!listeners) return 0;

    const count = listeners.length;
    this.listeners.delete(eventType);
    return count;
  }

  /**
   * Emit an event
   * @param {string} eventType - Event type
   * @param {object} eventContext - Event context data
   * @returns {boolean} true if at least one listener handled the event
   */
  emit(eventType, eventContext = {}) {
    if (typeof eventType !== 'string' || !eventType) {
      throw new Error('eventType must be a non-empty string');
    }

    // Add to event history
    const enrichedEvent = {
      ...eventContext,
      type: eventType,
      timestamp: eventContext.timestamp || Date.now()
    };

    this.eventHistory.push(enrichedEvent);

    // Limit history size (circular buffer)
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Get listeners for this event type
    const listeners = this.listeners.get(eventType);
    if (!listeners || listeners.length === 0) {
      return false;
    }

    // Execute listeners in priority order (already sorted)
    let handled = false;
    for (const listener of listeners) {
      try {
        const shouldStop = listener.callback(enrichedEvent);
        handled = true;

        // If callback returns true, stop propagation
        if (shouldStop === true) {
          break;
        }
      } catch (error) {
        this.logger.error(`Error in event listener ${listener.id} for ${eventType}:`, error);
      }
    }

    return handled;
  }

  /**
   * Clear event history
   */
  clearHistory() {
    this.eventHistory = [];
  }

  /**
   * Get all listeners for an event type (for debugging)
   * @param {string} eventType - Event type
   * @returns {Array} Array of listener info objects
   */
  getListeners(eventType) {
    const listeners = this.listeners.get(eventType);
    if (!listeners) return [];

    return listeners.map(l => ({
      id: l.id,
      priority: l.priority,
      system: l.system
    }));
  }

  /**
   * Get all registered event types
   * @returns {Array<string>} Array of event type names
   */
  getEventTypes() {
    return Array.from(this.listeners.keys());
  }

  /**
   * Sort listeners by priority
   * System listeners always execute first, then by priority number
   * @private
   */
  sortListeners(eventType) {
    const listeners = this.listeners.get(eventType);
    if (!listeners) return;

    listeners.sort((a, b) => {
      // System listeners have highest priority
      if (a.system && !b.system) return -1;
      if (!a.system && b.system) return 1;

      // Then sort by priority number (descending)
      return b.priority - a.priority;
    });
  }

  /**
   * Generate unique listener ID
   * @private
   */
  generateId() {
    this.listenerCounter += 1;
    return `listener-${this.listenerCounter}-${Date.now()}`;
  }
}

// ES module export (primary)
export { EventBus };

// Export for CommonJS (for tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EventBus };
}
