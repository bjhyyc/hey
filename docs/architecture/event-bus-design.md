# 事件总线架构设计

## 概述

> 当前实现说明：本文最初描述的是“EventBus + 订阅模式”的触发器设计。当前 pet runtime 已调整为 `ruleRuntime` 负责规则匹配、`UserTriggerManager` 负责动作执行。下方 EventBus 订阅设计保留为历史设计和测试/扩展参考，不再代表用户规则的主运行路径。

历史设计采用事件总线（Event Bus）+ 订阅模式重构触发器系统，实现：
- 性能优化：按事件类型分发，避免全局扫描
- 优先级管理：系统事件 > 用户高优先级 > 用户普通
- 解耦：事件源、规则引擎、动画控制器独立
- 扩展性：轻松添加新事件类型

## 当前运行时实现

当前用户规则执行链路如下：

```text
DOM / global mouse / timer / lifecycle event
→ pet.js builds eventContext
→ ruleRuntime.evaluateEvent(eventContext)
→ UserTriggerManager.executeAction(action, eventContext)
→ AnimationController / MediaRenderer / display / message bubble
```

职责边界：

- `ruleRuntime`：维护运行时事件历史，负责规则匹配、AND 顺序匹配、filters、priority、cooldown、`continuous`、`actionStrategy`，并返回待执行 actions。
- `UserTriggerManager`：不再在 pet runtime 中订阅用户规则；它作为动作执行器，负责解释 action 参数并调用动画、消息、显示、窗口等副作用接口。
- `pet.js`：负责将事件转换为上下文、调用 `ruleRuntime`、按 `durationMs` 串行动作，并把 action 交给 `UserTriggerManager`。
- `EventBus`：不再是 pet runtime 的用户规则执行入口。`UserTriggerManager.loadTriggers()` 和 EventBus 订阅路径仍存在于类和测试中，用作兼容/历史能力。

关键帧动画相关约定：

- `setKeyframeProgress` 和 keyframe 类型的 `playAnimation` 由 `UserTriggerManager` 执行。
- `progressFrom`（例如 `angleToPetProgress`）在动作执行阶段从 `eventContext` 读取，并应用 `scale` / `offset`。
- 读取到的 progress 会通过 clip 的 `keyframes` 做 `input -> output` 映射，再传给 `AnimationController`。
- 关键帧进度只接受 `eventSource: "globalMouse"`，避免鼠标进入宠物窗口后，本地 DOM mousemove 与全局鼠标追踪同时驱动进度。

## 核心类设计

### EventBus (事件总线)

```javascript
/**
 * 事件总线 - 核心调度器
 */
class EventBus {
  constructor() {
    // 按事件类型分组的监听器
    // Map<eventType, Listener[]>
    this.listeners = new Map();
    
    // 事件历史（仅用于 AND 条件）
    this.eventHistory = [];
    this.maxHistorySize = 40;
  }
  
  /**
   * 订阅事件
   * @param {string} eventType - 事件类型 (click, dragStart, etc.)
   * @param {function} callback - 回调函数 (event) => boolean
   * @param {object} options - 选项
   * @param {number} options.priority - 优先级 (0-100，数字越大越先执行)
   * @param {string} options.id - 监听器 ID（用于取消订阅）
   * @param {boolean} options.system - 是否为系统事件（系统事件优先级最高）
   * @returns {string} listenerId
   */
  subscribe(eventType, callback, options = {}) {
    const listener = {
      id: options.id || this.generateId(),
      callback,
      priority: options.priority || 0,
      system: options.system || false
    };
    
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    
    this.listeners.get(eventType).push(listener);
    this.sortListeners(eventType);
    
    return listener.id;
  }
  
  /**
   * 取消订阅
   * @param {string} listenerId
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
   * 发布事件
   * @param {string} eventType - 事件类型
   * @param {object} eventContext - 事件上下文数据
   * @returns {boolean} 是否有监听器处理了事件
   */
  emit(eventType, eventContext) {
    // 添加到历史
    this.eventHistory.push({
      ...eventContext,
      type: eventType,
      timestamp: Date.now()
    });
    
    // 限制历史大小
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }
    
    // 获取监听器
    const listeners = this.listeners.get(eventType);
    if (!listeners || listeners.length === 0) {
      return false;
    }
    
    // 按优先级执行（已排序）
    let handled = false;
    for (const listener of listeners) {
      try {
        const shouldStop = listener.callback(eventContext);
        handled = true;
        
        // 如果回调返回 true，停止传播
        if (shouldStop === true) {
          break;
        }
      } catch (error) {
        console.error(`Error in event listener ${listener.id}:`, error);
      }
    }
    
    return handled;
  }
  
  /**
   * 按优先级排序监听器
   * 系统事件优先级最高，然后按数字优先级排序
   */
  sortListeners(eventType) {
    const listeners = this.listeners.get(eventType);
    if (!listeners) return;
    
    listeners.sort((a, b) => {
      // 系统事件优先
      if (a.system && !b.system) return -1;
      if (!a.system && b.system) return 1;
      
      // 按优先级数字排序（降序）
      return b.priority - a.priority;
    });
  }
  
  /**
   * 获取事件历史（用于 AND 条件）
   * @param {number} windowMs - 时间窗口（毫秒）
   * @returns {Array} 时间窗口内的事件
   */
  getRecentEvents(windowMs = 3000) {
    const now = Date.now();
    return this.eventHistory.filter(e => now - e.timestamp <= windowMs);
  }
  
  /**
   * 清空事件历史
   */
  clearHistory() {
    this.eventHistory = [];
  }
  
  /**
   * 生成唯一 ID
   */
  generateId() {
    return `listener-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
```

### SystemEventManager (系统事件管理器)

```javascript
/**
 * 系统事件管理器 - 处理内置的不可删除事件
 */
class SystemEventManager {
  constructor(eventBus, handlers) {
    this.eventBus = eventBus;
    this.handlers = handlers;
    this.listenerIds = [];
    
    this.registerSystemEvents();
  }
  
  registerSystemEvents() {
    // 右键菜单（最高优先级，阻止传播）
    this.listenerIds.push(
      this.eventBus.subscribe('rightClick', (event) => {
        this.handlers.showContextMenu(event);
        return true;  // 阻止传播到用户规则
      }, {
        system: true,
        priority: 100,
        id: 'system-context-menu'
      })
    );
    
    // 拖拽窗口（系统级）
    this.listenerIds.push(
      this.eventBus.subscribe('dragStart', (event) => {
        // 启动窗口拖拽
        this.handlers.startWindowDrag(event);
        // 不阻止传播，允许用户规则也响应
        return false;
      }, {
        system: true,
        priority: 100,
        id: 'system-window-drag'
      })
    );
    
    this.listenerIds.push(
      this.eventBus.subscribe('dragging', (event) => {
        this.handlers.updateWindowPosition(event);
        return false;
      }, {
        system: true,
        priority: 100,
        id: 'system-window-dragging'
      })
    );
    
    this.listenerIds.push(
      this.eventBus.subscribe('dragEnd', (event) => {
        this.handlers.endWindowDrag(event);
        return false;
      }, {
        system: true,
        priority: 100,
        id: 'system-window-drag-end'
      })
    );
    
    // 设置按钮（系统级，但不阻止用户规则）
    this.listenerIds.push(
      this.eventBus.subscribe('click', (event) => {
        // 检查是否点击了设置按钮
        if (event.target && event.target.id === 'settings-button') {
          this.handlers.openPanel();
          return true;  // 阻止传播
        }
        return false;  // 继续传播到用户规则
      }, {
        system: true,
        priority: 100,
        id: 'system-settings-button'
      })
    );
    
    // 应用启动（系统级，不阻止传播）
    this.listenerIds.push(
      this.eventBus.subscribe('appLaunch', (event) => {
        console.log('App launched');
        return false;
      }, {
        system: true,
        priority: 100,
        id: 'system-app-launch'
      })
    );
  }
  
  unregisterAll() {
    this.listenerIds.forEach(id => this.eventBus.unsubscribe(id));
    this.listenerIds = [];
  }
}
```

### UserTriggerManager (用户触发器管理器)

```javascript
/**
 * 用户触发器管理器 - 处理用户配置的规则
 */
class UserTriggerManager {
  constructor(eventBus, animationController, messageHandler) {
    this.eventBus = eventBus;
    this.animationController = animationController;
    this.messageHandler = messageHandler;
    
    this.triggers = [];
    this.listenerIds = [];
    this.cooldowns = new Map();  // ruleId -> lastTriggeredTimestamp
  }
  
  /**
   * 加载用户触发器
   * @param {Array} triggers - 触发器配置
   */
  loadTriggers(triggers) {
    // 先卸载旧的
    this.unloadTriggers();
    
    this.triggers = triggers || [];
    
    // 为每个触发器注册监听器
    this.triggers.forEach(trigger => {
      if (!trigger.enabled) return;
      
      // 简单规则：一个条件对应一个监听器
      if (trigger.relation === 'single' || trigger.relation === 'or') {
        trigger.conditions.forEach(condition => {
          this.registerSimpleTrigger(trigger, condition);
        });
      } 
      // AND 规则：需要特殊处理
      else if (trigger.relation === 'and') {
        this.registerAndTrigger(trigger);
      }
    });
  }
  
  /**
   * 注册简单触发器（单个条件）
   */
  registerSimpleTrigger(trigger, condition) {
    const listenerId = this.eventBus.subscribe(
      condition.type,
      (event) => this.handleSimpleTrigger(trigger, condition, event),
      {
        priority: trigger.priority || 50,
        id: `user-${trigger.id}-${condition.type}`
      }
    );
    
    this.listenerIds.push(listenerId);
  }
  
  /**
   * 注册 AND 触发器（多个条件按顺序）
   */
  registerAndTrigger(trigger) {
    // 监听最后一个条件
    const lastCondition = trigger.conditions[trigger.conditions.length - 1];
    
    const listenerId = this.eventBus.subscribe(
      lastCondition.type,
      (event) => this.handleAndTrigger(trigger, event),
      {
        priority: trigger.priority || 50,
        id: `user-and-${trigger.id}`
      }
    );
    
    this.listenerIds.push(listenerId);
  }
  
  /**
   * 处理简单触发器
   */
  handleSimpleTrigger(trigger, condition, event) {
    // 1. 检查冷却时间
    if (this.isOnCooldown(trigger.id, trigger.cooldownMs)) {
      return false;
    }
    
    // 2. 检查过滤条件
    if (!this.matchFilters(condition.filters, event)) {
      return false;
    }
    
    // 3. 执行动作
    this.executeActions(trigger.actions);
    
    // 4. 记录触发时间
    this.cooldowns.set(trigger.id, Date.now());
    
    // 5. 是否阻止传播
    return trigger.interruptCurrent || false;
  }
  
  /**
   * 处理 AND 触发器
   */
  handleAndTrigger(trigger, event) {
    // 1. 检查冷却时间
    if (this.isOnCooldown(trigger.id, trigger.cooldownMs)) {
      return false;
    }
    
    // 2. 获取时间窗口内的事件历史
    const windowMs = trigger.andWindowMs || 3000;
    const recentEvents = this.eventBus.getRecentEvents(windowMs);
    
    // 3. 检查所有条件是否在窗口内都满足
    const allMatched = trigger.conditions.every(condition => {
      return recentEvents.some(e => 
        e.type === condition.type && 
        this.matchFilters(condition.filters, e)
      );
    });
    
    if (!allMatched) {
      return false;
    }
    
    // 4. 执行动作
    this.executeActions(trigger.actions);
    
    // 5. 记录触发时间
    this.cooldowns.set(trigger.id, Date.now());
    
    // 6. 是否阻止传播
    return trigger.interruptCurrent || false;
  }
  
  /**
   * 检查冷却时间
   */
  isOnCooldown(triggerId, cooldownMs) {
    if (!cooldownMs) return false;
    
    const lastTriggered = this.cooldowns.get(triggerId);
    if (!lastTriggered) return false;
    
    return Date.now() - lastTriggered < cooldownMs;
  }
  
  /**
   * 匹配过滤条件
   */
  matchFilters(filters, event) {
    if (!filters || filters.length === 0) return true;
    
    return filters.every(filter => {
      const value = event[filter.field];
      return this.compareValues(value, filter.operator, filter.value);
    });
  }
  
  /**
   * 比较值
   */
  compareValues(actual, operator, expected) {
    switch (operator) {
      case '=': return actual === expected;
      case '!=': return actual !== expected;
      case '>': return actual > expected;
      case '>=': return actual >= expected;
      case '<': return actual < expected;
      case '<=': return actual <= expected;
      case 'between':
        return Array.isArray(expected) && actual >= expected[0] && actual <= expected[1];
      case 'in':
        return Array.isArray(expected) && expected.includes(actual);
      case 'notIn':
        return Array.isArray(expected) && !expected.includes(actual);
      default:
        return false;
    }
  }
  
  /**
   * 执行动作序列
   */
  executeActions(actions) {
    if (!actions || actions.length === 0) return;
    
    actions.forEach(action => {
      if (typeof action === 'string') {
        // 字符串格式：'play:jump' 或 'message:hi'
        const [type, param] = action.split(':');
        this.executeAction({type, param});
      } else {
        // 对象格式
        this.executeAction(action);
      }
    });
  }
  
  /**
   * 执行单个动作
   */
  executeAction(action) {
    switch (action.type) {
      case 'play':
      case 'playAnimation':
        this.animationController.playAnimation(action.param || action.animation);
        break;
        
      case 'stop':
      case 'stopAnimation':
        this.animationController.stopAnimation();
        break;
        
      case 'message':
      case 'showMessage':
        this.messageHandler.show(action.param || action.text);
        break;
        
      case 'randomMessage':
        const messages = action.messages || [];
        if (messages.length > 0) {
          const msg = messages[Math.floor(Math.random() * messages.length)];
          this.messageHandler.show(msg);
        }
        break;
        
      // ... 其他动作类型
    }
  }
  
  /**
   * 卸载所有触发器
   */
  unloadTriggers() {
    this.listenerIds.forEach(id => this.eventBus.unsubscribe(id));
    this.listenerIds = [];
    this.cooldowns.clear();
  }
}
```

## 优先级系统

### 优先级层级

```
系统事件（system: true）
  ↓ priority: 100
  右键菜单（阻止传播）
  设置按钮（阻止传播）
  拖拽窗口（不阻止）
  
用户高优先级（priority: 70-99）
  ↓
  拖拽动画规则
  
用户普通优先级（priority: 50）
  ↓
  点击互动规则
  
用户低优先级（priority: 1-49）
  ↓
  随机动画规则
```

### 事件传播规则

1. **系统事件优先执行**
   - `system: true` 的监听器总是最先执行
   
2. **阻止传播机制**
   - 回调返回 `true` → 停止传播到后续监听器
   - 回调返回 `false` 或 `undefined` → 继续传播
   
3. **同优先级并发**
   - 相同优先级的监听器都会执行（除非被高优先级阻止）

### 示例场景

```javascript
// 场景1：用户右键点击宠物
eventBus.emit('rightClick', {...});

执行顺序：
1. system-context-menu (priority: 100, system: true) → 显示菜单 → 返回 true
2. [停止] user-custom-rule (priority: 50) → 不会执行

// 场景2：用户点击宠物
eventBus.emit('click', {...});

执行顺序：
1. system-settings-button (priority: 100, system: true) → 检查目标 → 返回 false
2. user-high-priority (priority: 80) → 播放特殊动画 → 返回 false
3. user-normal (priority: 50) → 显示消息 → 返回 false

// 场景3：用户拖拽宠物
eventBus.emit('dragStart', {...});

执行顺序：
1. system-window-drag (priority: 100, system: true) → 启动拖拽 → 返回 false
2. user-drag-animation (priority: 90) → 播放拖拽动画 → 返回 false
```

## 与 Unity 风格动画系统集成

### 集成点

```javascript
class PetController {
  constructor(config) {
    // 1. 创建事件总线
    this.eventBus = new EventBus();
    
    // 2. 创建动画控制器
    this.animationController = new AnimationController(config.animations);
    
    // 3. 创建消息处理器
    this.messageHandler = new MessageHandler();
    
    // 4. 注册系统事件
    this.systemEvents = new SystemEventManager(this.eventBus, {
      showContextMenu: (e) => this.showContextMenu(e),
      startWindowDrag: (e) => this.startWindowDrag(e),
      updateWindowPosition: (e) => this.updateWindowPosition(e),
      endWindowDrag: (e) => this.endWindowDrag(e),
      openPanel: () => this.openPanel()
    });
    
    // 5. 注册用户触发器
    this.userTriggers = new UserTriggerManager(
      this.eventBus,
      this.animationController,
      this.messageHandler
    );
    this.userTriggers.loadTriggers(config.triggers);
    
    // 6. 绑定 DOM 事件到事件总线
    this.bindDOMEvents();
  }
  
  bindDOMEvents() {
    this.sprite.addEventListener('click', (e) => {
      this.eventBus.emit('click', this.buildEventContext('click', e));
    });
    
    this.sprite.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.eventBus.emit('rightClick', this.buildEventContext('rightClick', e));
    });
    
    this.sprite.addEventListener('mousedown', (e) => {
      this.eventBus.emit('dragStart', this.buildEventContext('dragStart', e));
    });
    
    // ... 其他 DOM 事件
  }
  
  buildEventContext(type, domEvent) {
    return {
      type,
      timestamp: Date.now(),
      target: domEvent.target,
      // ... 其他上下文数据
    };
  }
}
```

### 配置格式

```json
{
  "animations": {
    "default": {
      "id": "idle",
      "asset": "assets/idle.gif",
      "loop": true
    },
    "clips": [
      {
        "id": "jump",
        "name": "跳跃",
        "asset": "assets/jump.webm",
        "type": "oneshot"
      },
      {
        "id": "drag",
        "name": "拖拽",
        "asset": "assets/drag.webm",
        "type": "loop"
      }
    ]
  },
  
  "triggers": [
    {
      "id": "rule-click-jump",
      "name": "点击跳跃",
      "enabled": true,
      "relation": "single",
      "conditions": [
        {
          "type": "click",
          "filters": []
        }
      ],
      "actions": [
        {"type": "playAnimation", "animation": "jump"},
        {"type": "showMessage", "text": "哇！"}
      ],
      "priority": 50,
      "cooldownMs": 1000,
      "interruptCurrent": false
    },
    {
      "id": "rule-drag",
      "name": "拖拽动画",
      "enabled": true,
      "relation": "single",
      "conditions": [
        {"type": "dragStart"}
      ],
      "actions": [
        {"type": "playAnimation", "animation": "drag"}
      ],
      "priority": 90,
      "cooldownMs": 0,
      "interruptCurrent": true
    },
    {
      "id": "rule-drag-end",
      "name": "拖拽结束",
      "enabled": true,
      "relation": "single",
      "conditions": [
        {"type": "dragEnd"}
      ],
      "actions": [
        {"type": "stopAnimation"}
      ],
      "priority": 90,
      "cooldownMs": 0
    }
  ]
}
```

## 性能优化

### 1. 按需维护事件历史
```javascript
// 只有存在 AND 规则时才维护历史
const hasAndRules = triggers.some(t => t.relation === 'and');
if (!hasAndRules) {
  eventBus.eventHistory = null;  // 节省内存
}
```

### 2. 事件类型索引
```javascript
// EventBus 内部按类型索引，O(1) 查找
this.listeners.get('click')  // 只返回监听 click 的回调
```

### 3. 监听器排序缓存
```javascript
// 订阅时排序一次，emit 时直接使用
this.sortListeners(eventType);
```

### 4. 冷却时间优化
```javascript
// 使用 Map 存储，O(1) 查找
this.cooldowns.set(triggerId, timestamp);
```

## 扩展性

### 添加新事件类型

```javascript
// 1. 在 DOM 层绑定
sprite.addEventListener('dblclick', (e) => {
  eventBus.emit('doubleClick', {...});
});

// 2. 用户即可在 UI 中使用
triggers: [
  {
    conditions: [{type: 'doubleClick'}],
    actions: [...]
  }
]
```

### 添加自定义系统事件

```javascript
// 在 SystemEventManager 中注册
this.eventBus.subscribe('batteryLow', (event) => {
  this.handlers.showBatteryWarning();
  return false;
}, {system: true, priority: 100});
```

## 迁移路径

### 阶段 1：创建新类（不破坏现有代码）
- 实现 `EventBus`、`SystemEventManager`、`UserTriggerManager`
- 与现有 `rule-engine.js` 并行存在

### 阶段 2：渐进式替换
- `pet.js` 中创建 EventBus 实例
- 先迁移简单事件（click, dragStart）
- 逐步替换复杂逻辑（AND 条件、过滤器）

### 阶段 3：移除旧代码
- 删除 `rule-engine.js`
- 删除 `pet.js` 中的旧事件处理代码
- 更新测试

## 测试策略

### 单元测试
```javascript
describe('EventBus', () => {
  it('should emit events to subscribers', () => {
    const bus = new EventBus();
    let received = null;
    
    bus.subscribe('click', (e) => { received = e; });
    bus.emit('click', {x: 10, y: 20});
    
    expect(received).toEqual({x: 10, y: 20, type: 'click', timestamp: expect.any(Number)});
  });
  
  it('should respect priority order', () => {
    const bus = new EventBus();
    const order = [];
    
    bus.subscribe('click', () => order.push('low'), {priority: 10});
    bus.subscribe('click', () => order.push('high'), {priority: 90});
    bus.emit('click', {});
    
    expect(order).toEqual(['high', 'low']);
  });
  
  it('should stop propagation on true return', () => {
    const bus = new EventBus();
    const executed = [];
    
    bus.subscribe('click', () => { executed.push('first'); return true; }, {priority: 90});
    bus.subscribe('click', () => { executed.push('second'); }, {priority: 50});
    bus.emit('click', {});
    
    expect(executed).toEqual(['first']);  // second 不会执行
  });
});
```

## 总结

### 优势
- ✅ 性能：按事件类型分发，避免全局扫描
- ✅ 解耦：事件源、规则、动画独立
- ✅ 优先级：系统事件 > 用户事件，清晰可控
- ✅ 扩展：新增事件类型无需改动核心代码
- ✅ 调试：事件流清晰，易于追踪

### 与现有系统的区别

| 维度 | 旧设计（rule-engine） | 新设计（EventBus） |
|------|---------------------|-------------------|
| 事件分发 | 全局扫描所有规则 | 按类型索引，O(1) 查找 |
| 优先级 | 排序后全部执行 | 高优先级可阻止低优先级 |
| 系统事件 | 硬编码在 pet.js | 统一管理在 SystemEventManager |
| 扩展性 | 修改 rule-engine.js | 只需 subscribe 新类型 |
| 测试性 | 耦合紧密 | 独立模块，易测试 |
