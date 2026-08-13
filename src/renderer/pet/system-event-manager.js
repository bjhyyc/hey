/**
 * System Event Manager - Handles built-in, non-removable system events
 *
 * System events have the highest priority and handle core functionality
 * like window dragging and lifecycle events.
 */

/**
 * SystemEventManager class
 * Registers and manages system-level event handlers
 */
class SystemEventManager {
  /**
   * @param {EventBus} eventBus - Event bus instance
   * @param {object} handlers - Handler functions for system events
   * @param {function} handlers.startWindowDrag - Start window drag handler
   * @param {function} handlers.updateWindowPosition - Update window position handler
   * @param {function} handlers.endWindowDrag - End window drag handler
   * @param {function} handlers.onAppLaunch - App launch callback (optional)
   * @param {function} handlers.onPackageLoaded - Package loaded callback (optional)
   */
  constructor(eventBus, handlers) {
    if (!eventBus) {
      throw new Error('EventBus instance is required');
    }

    if (!handlers || typeof handlers !== 'object') {
      throw new Error('Handlers object is required');
    }

    this.eventBus = eventBus;
    this.handlers = handlers;
    this.listenerIds = [];
    this.isDragging = false;

    this.registerSystemEvents();
  }

  /**
   * Register all system event handlers
   * @private
   */
  registerSystemEvents() {
    this.registerWindowDrag();
    this.registerLifecycleEvents();
  }

  /**
   * Register window dragging handlers
   * System-level but doesn't block user rules (allows drag animations)
   * @private
   */
  registerWindowDrag() {
    // Drag start
    const dragStartId = this.eventBus.subscribe('dragStart', (event) => {
      this.isDragging = true;
      if (typeof this.handlers.startWindowDrag === 'function') {
        this.handlers.startWindowDrag(event);
      }
      // Don't block propagation - allow user drag animations
      return false;
    }, {
      system: true,
      priority: 100,
      id: 'system-window-drag-start'
    });

    // Dragging
    const draggingId = this.eventBus.subscribe('dragging', (event) => {
      if (this.isDragging && typeof this.handlers.updateWindowPosition === 'function') {
        this.handlers.updateWindowPosition(event);
      }
      // Don't block propagation
      return false;
    }, {
      system: true,
      priority: 100,
      id: 'system-window-dragging'
    });

    // Drag end
    const dragEndId = this.eventBus.subscribe('dragEnd', (event) => {
      if (this.isDragging && typeof this.handlers.endWindowDrag === 'function') {
        this.handlers.endWindowDrag(event);
      }
      this.isDragging = false;
      // Don't block propagation
      return false;
    }, {
      system: true,
      priority: 100,
      id: 'system-window-drag-end'
    });

    this.listenerIds.push(dragStartId, draggingId, dragEndId);
  }

  /**
   * Register lifecycle event handlers
   * @private
   */
  registerLifecycleEvents() {
    // App launch
    const launchId = this.eventBus.subscribe('appLaunch', (event) => {
      if (typeof this.handlers.onAppLaunch === 'function') {
        this.handlers.onAppLaunch(event);
      }
      // Don't block propagation - allow user rules to respond to app launch
      return false;
    }, {
      system: true,
      priority: 100,
      id: 'system-app-launch'
    });

    // Package loaded
    const packageId = this.eventBus.subscribe('packageLoaded', (event) => {
      if (typeof this.handlers.onPackageLoaded === 'function') {
        this.handlers.onPackageLoaded(event);
      }
      // Don't block propagation
      return false;
    }, {
      system: true,
      priority: 100,
      id: 'system-package-loaded'
    });

    this.listenerIds.push(launchId, packageId);
  }

  /**
   * Unregister all system event handlers
   * Should be called when cleaning up the manager
   */
  unregisterAll() {
    this.listenerIds.forEach(id => {
      this.eventBus.unsubscribe(id);
    });
    this.listenerIds = [];
    this.isDragging = false;
  }

  /**
   * Get list of registered system event listener IDs
   * @returns {Array<string>} Listener IDs
   */
  getListenerIds() {
    return [...this.listenerIds];
  }

  /**
   * Check if currently dragging
   * @returns {boolean}
   */
  isDraggingWindow() {
    return this.isDragging;
  }
}

// ES module export (primary)
export { SystemEventManager };

// Export for CommonJS (for tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SystemEventManager };
}
