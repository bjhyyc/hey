# 当前架构

本文是项目的长期架构入口，整合了此前根目录中的架构总结和实施总结，并按当前代码实现校准。过期的一次性总结文档已不再作为事实来源。

## 总览

Desktop Pet 是三进程 Electron 应用：

- Main process：创建窗口、托盘、菜单、全局鼠标追踪，处理 IPC、配置、素材和 petpack 导入导出。
- Preload：通过 `contextBridge` 暴露 `window.desktopPet` 和 `window.desktopPetPanel`，renderer 没有直接 Node.js 权限。
- Renderer：`pet` 窗口负责动画、媒体渲染和规则执行；`panel` 窗口负责配置 UI。

核心数据模型已经从旧的 “states + actions” 简化为：

```text
assets -> animations -> triggerRules -> inline actions
```

素材只作为文件存在；动画剪辑绑定素材；规则在命中后直接执行内联动作。旧的独立 States 标签页和 Actions 标签页已经不是当前产品结构。

## 关键目录

```text
src/main/
├── main.js
├── windows.js
├── ipc.js
├── global-mouse-tracker.js
├── tray.js
├── menu.js
└── services/
    ├── config-store.js
    ├── asset-store.js
    ├── petpack.js
    └── logger.js

src/preload/
├── pet-preload.js
└── panel-preload.js

src/renderer/
├── pet/
│   ├── pet.js
│   ├── pet-runtime.js
│   ├── user-trigger-manager.js
│   ├── animation-controller.js
│   ├── media-renderer.js
│   ├── pet-controller.js
│   ├── pet-visibility.js
│   └── pomodoro-runtime.js
└── panel/
    ├── panel.js
    ├── panel-state.js
    ├── ui/
    ├── tabs/
    ├── components/
    └── handlers/

src/shared/
├── schema.js
├── defaults.js
├── manifest-validator.js
├── rule-engine.js
├── rule-utils.js
├── rule-conflict-detector.js
├── path-safety.js
└── i18n.js
```

## Petpack 和配置

Petpack 是 ZIP 格式，入口文件是 `manifest.json`。当前 manifest 需要：

- `schemaVersion`
- `packageId`
- `name`
- `version`
- `animations.default`
- `animations.clips`
- 可选 `triggerRules`

`animations.default` 是兜底动画。`animations.clips` 支持 `oneshot`、`loop`、`keyframe`。视频剪辑可以配置 green screen 参数；keyframe 剪辑可以配置 `keyframes`，把输入 progress 映射到实际输出 progress。

用户配置保存在 `config.json`，主要段落：

- `currentPackageId`
- `display`
- `system`
- `animations`
- `interactions`
- `triggerRules`

导入包时，主进程校验 ZIP 结构、路径安全、文件数量、文件大小和 manifest 引用，然后解压到用户数据目录。导出时，主进程合并当前配置和包资源，生成新的 `.petpack`。

## 运行时数据流

```text
DOM / global mouse / timer / lifecycle / pomodoro event
-> pet.js builds event context
-> ruleRuntime.evaluateEvent(context)
-> matched actions returned
-> pet.js sequences actions by durationMs when needed
-> UserTriggerManager.executeAction(action, context)
-> AnimationController（playAnimation 走单槽排队，最新者胜）/ MediaRenderer / display / message / window helpers
```

`pet.js` 负责把输入事件转换成统一上下文，包括鼠标位置、桌宠位置、距离、方向、角度进度、拖拽状态、定时参数等。`pet-runtime.js` 维护最近 40 条事件、规则冷却、状态型规则状态和退出计时器。`rule-engine.js` 保持纯匹配逻辑，处理条件、过滤器、时间窗口、优先级和普通规则命中。

`EventBus` 仍在代码和测试中保留，但当前用户规则主路径不是 EventBus 订阅模型。当前事实来源是 `ruleRuntime.evaluateEvent()` 加 `UserTriggerManager.executeAction()`。

## 规则模型

规则核心字段：

```json
{
  "id": "rule-id",
  "name": "Rule name",
  "enabled": true,
  "conditions": [],
  "priority": 50,
  "cooldownMs": 1000,
  "conditionWindowMs": 3000,
  "actionStrategy": "sequence",
  "stopOnMatch": true,
  "actions": []
}
```

条件默认是 required。多个 required 条件需要在 `conditionWindowMs` 内都匹配；如果存在 `required: false` 的 optional 条件，则至少一个 optional 条件也要匹配。当前规则编辑器用 “必需/可选条件” 表达组合关系，而不是旧文档里的独立 OR/AND 字段。

规则按 `priority` 降序检查。普通规则默认第一条执行后停止继续匹配；`stopOnMatch: false` 时会继续追加后续命中规则的动作。`actionStrategy: "sequence"` 会按顺序执行动作；`"random"` 会从动作列表里选一个执行。

## 状态型规则

状态型规则用于 “条件持续成立后进入，退出条件持续成立后离开” 的场景，例如鼠标靠近桌宠 3 秒后播放动画，鼠标远离 3 秒后回到默认动画。

进入侧由 `mouseMove` 条件上的 `sustainMs` 驱动：

```json
{
  "conditions": [
    {
      "type": "mouseMove",
      "sustainMs": 3000,
      "filters": [{ "field": "distanceToPetCenter", "operator": "<=", "value": 300 }]
    }
  ],
  "actions": [{ "type": "playAnimation", "animation": "..." }]
}
```

退出侧写在 `state` 中：

```json
{
  "state": {
    "exitConditions": [
      {
        "type": "mouseMove",
        "sustainMs": 3000,
        "filters": [{ "field": "distanceToPetCenter", "operator": ">", "value": 360 }]
      }
    ],
    "exitActions": [
      { "type": "playAnimation", "animation": "..." }
    ]
  }
}
```

运行时会为状态型规则维护 `conditionTrueSince`、`active`、`exitTrueSince` 和最近匹配事件。激活中的状态型规则会压制普通规则，避免正在播放的状态被低优先级规则打断。退出计时由 500ms 后台检查兜底，即使鼠标静止、全局鼠标追踪不再发事件，也能完成退出动作。

## 动作执行

当前 manifest 支持的动作类型来自 `src/shared/schema.js`：

- `blank`：占位动作，可用于在序列中等待 `durationMs`。
- `playAnimation`：请求播放动画剪辑。不打断受保护的动画（未播完的 oneshot、或 loop），而是进入单槽等待区（最新者胜），当前动画播完后再切换。oneshot 可带 `durationMs`（总播放时长）；loop 的 `durationMs` 表示单次循环时长，不会依赖它自动停止。
- `setKeyframeProgress`：设置 keyframe 动画进度（即时，不进等待区）。
- `showMessage`：显示固定气泡文案。
- `randomMessage`：从消息数组随机显示一条。
- `changeScale` / `changeOpacity`：修改显示属性。
- `movePet`：移动窗口。
- `pomodoroTimer`：启动或控制番茄钟运行时。
- `hidePet` / `showPet`：隐藏或显示桌宠。
- `resetPosition`：回到配置位置。
- `openPanel`：打开控制面板。

### 动画队列

`AnimationController` 使用非打断、单槽位、最新请求优先的播放模型：

- 未结束的 `oneshot` 和任意 `loop` 是受保护剪辑，普通 `playAnimation` 请求不会立即打断它们。
- 受保护期间的新请求写入单个 `pending` 槽位；后续请求会覆盖旧等待项，并记录 `animation:pending:replaced`。
- 请求与当前 active clip 相同时会被忽略，并记录 `animation:pending:ignored-duplicate`。
- `oneshot` 在 `durationMs` 到期后推进到 pending；`loop` 在按 `durationMs` 计算的下一个循环边界推进。没有 pending 时返回默认动画。
- 没有有效 `durationMs` 的 `loop` 无法计算边界，因此收到切换请求后立即推进。
- `setKeyframeProgress` 是连续 scrub 的即时路径：它会清除 pending 并立即应用进度。普通 `playAnimation` 播放 `keyframe` clip 时也不受保护。
- 设置了 `interrupt: true` 的 clip 会清除当前计时器和 pending，绕过保护立即播放；它成为 active 后仍按自身类型受到保护。
- `stopAnimation` 也遵循保护规则：受保护剪辑先完成，再播放 pending 或返回默认动画。
- 配置热更新会清除已删除的 pending；active 被删除时安全返回默认动画。active 仍存在时会重新绑定更新后的字段，并按新的循环时长重新安排边界。
- `destroy()` 会清理 pending、clip 结束计时器和 loop 边界计时器。

关键队列日志包括 `animation:queue:immediate`、`animation:queue:pending`、`animation:pending:replaced`、`animation:pending:ignored-duplicate`、`animation:interrupt:immediate`、`animation:loop:boundary-scheduled` 和 `animation:advance`。

关键帧进度可以从事件字段读取，例如：

```json
{
  "type": "setKeyframeProgress",
  "animation": "33333333-3333-4333-8333-333333333333",
  "progressFrom": "angleToPetProgress",
  "scale": 1,
  "offset": 0
}
```

为了避免本地 DOM mousemove 和全局鼠标事件重复驱动，keyframe progress 只接受 `eventSource: "globalMouse"`。角度映射约定是：上方 `0`，右侧 `0.25`，下方 `0.5`，左侧 `0.75`。

## 控制面板

当前面板入口是 `src/renderer/panel/panel.js`。它只做初始化、配置加载、事件路由和渲染协调。页面由独立 tab renderer 和 handler 组成。

长期标签页：

- Overview：展示包、动画、规则、素材统计；通过 push + 2 秒轮询展示宠物运行时状态和最近事件。
- Assets：素材导入、替换、删除、petpack 导入导出。
- Animations：默认动画、oneshot/loop/keyframe 剪辑、关键帧映射、视频 green screen。
- Rules：条件、过滤器、内联动作、退出条件、退出动作、冲突提示和拖拽排序。
- Display：位置、缩放、透明度、置顶、穿透、锁定。
- System：语言、开机启动、日志设置和日志查看。

`interaction.js`、旧 states/actions 相关概念只作为历史残留或被移除的产品形态看待，不再是当前标签导航事实。

## 配置更新流

```text
Panel form submit
-> config:save IPC
-> main config-store atomic write
-> main reloads active package
-> main broadcasts pet:runtime-updated
-> pet renderer rebuilds runtime model
-> timers/rules/animations take effect immediately
```

面板 Overview 的运行时状态采用推送和轮询混合策略：宠物窗口可主动推送 runtime state；面板也会周期性拉取，避免漏更新。

## 安全和可靠性

- 路径安全由 `src/shared/path-safety.js` 和 manifest 资源引用校验共同保证。
- Petpack 导入拒绝危险路径、符号链接、超限文件、超限 entry 和不支持扩展。
- 配置写入和包安装使用临时文件/目录加原子替换，失败时回滚或保留原状态。
- IPC 边界使用 preload 暴露的最小 API。
- 主进程和 renderer 都优先使用 logger helper，在 IPC、导入导出、规则匹配、动画播放和 fallback 路径留下结构化调试信息。

## 扩展点

添加动作类型：

1. 在 `src/shared/schema.js` 的 `SUPPORTED_ACTION_TYPES` 增加类型。
2. 在 `src/renderer/pet/user-trigger-manager.js` 执行动作。
3. 在 `src/renderer/panel/components/inline-action-editor.js` 和表单读取逻辑中增加字段。
4. 在 `src/shared/manifest-validator.js` 增加引用或参数校验。
5. 在 `src/shared/i18n.js` 增加中英文文案。

添加条件类型：

1. 在 `TRIGGER_PARAMETER_FIELDS` 增加条件和字段。
2. 在 `pet.js` 或相关运行时发出事件上下文。
3. 在面板条件编辑器中确认字段输入类型和运算符。
4. 在 manifest validator 和测试中覆盖。

添加素材类型：

1. 在 `SUPPORTED_ASSET_EXTENSIONS` 增加扩展名。
2. 更新媒体 MIME/渲染处理。
3. 补充 asset-store/petpack 校验测试。
