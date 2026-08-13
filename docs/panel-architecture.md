# Panel Architecture

控制面板是 `src/renderer/panel/` 下的模块化 renderer。当前长期标签页是 Overview、Assets、Animations、Rules、Display、System；旧的 States / Actions 标签页已经被动画剪辑和规则内联动作取代。

## 目录结构

```text
src/renderer/panel/
├── panel.js                         # 入口：初始化、配置加载、事件路由、渲染协调
├── state.js                         # 面板全局状态容器
├── panel-state.js                   # 配置更新、表单模型、ID/字段工具
├── panel.html
├── panel.css
│
├── ui/
│   ├── banner.js                    # 顶部提示
│   ├── header.js                    # 页面头部
│   ├── tabs.js                      # 标签导航
│   └── utils.js                     # HTML 转义、表单 helper、字段说明
│
├── tabs/
│   ├── overview.js                  # 概览和运行时状态
│   ├── assets.js                    # 素材和 petpack
│   ├── animations.js                # 默认动画、剪辑、关键帧、green screen
│   ├── rules.js                     # 规则列表、编辑器、冲突提示
│   ├── display.js                   # 显示设置
│   ├── system.js                    # 系统、语言、日志
│   └── interaction.js               # 历史/未注册标签，不属于当前导航
│
├── components/
│   ├── condition-browser.js
│   ├── inline-action-editor.js
│   ├── keyframe-editor.js
│   ├── rule-action-selector.js
│   └── rule-condition-editor.js
│
└── handlers/
    ├── asset-handlers.js            # 素材、替换、导入导出、拖放
    ├── event-handlers.js            # 点击、变更、拖拽排序、编辑器交互
    └── form-handlers.js             # 表单读取和保存
```

## 数据流

```text
panel.js
-> loadConfig()
-> state.config / packageAssets / packageList
-> render()
-> active tab renderer
-> delegated event handlers
-> update config through panel-state helpers
-> config:save IPC
-> pet:runtime-updated broadcast
-> panel refresh / pet runtime rebuild
```

`panel.js` 持有 DOM 引用、preload API 引用、runtime state polling 和顶层 `render()`。标签页 renderer 不直接保存配置；它们读取传入的 `state` 和 `config`，返回 HTML 字符串。表单提交统一进入 `handlers/form-handlers.js`，再调用 `panel-state.js` 中的配置更新函数。

## 标签职责

### Overview

- 展示当前包、动画数量、规则数量、素材引用数量和显示设置摘要。
- 展示运行时状态，包括当前动画、最近事件、规则冷却/状态信息。
- 使用推送 + 轮询混合策略：宠物窗口可通过 preload 事件推送状态，面板也每 2 秒拉取一次，避免漏更新。

### Assets

- 列出当前包素材。
- 导入素材、替换选中素材、删除素材引用。
- 导入 `.petpack` 并显示进度。
- 导出当前包和配置。

### Animations

- 编辑默认动画和剪辑列表。
- 剪辑类型：`oneshot`、`loop`、`keyframe`。
- 绑定素材，读取素材元数据中的时长作为默认 duration。
- 为视频素材提供 green screen 设置。
- 为 keyframe 剪辑编辑 `input -> output` 映射。

### Rules

- 展示规则列表、启用开关、优先级、必需/可选条件数量。
- 编辑条件类型、字段、运算符和值。
- 编辑执行策略：`sequence` 或 `random`。
- 使用 inline action editor 配置执行动作和退出动作。
- 鼠标移动规则可配置 `sustainMs`、`exitConditions` 和 `exitActions`。
- 调用 `detectRuleConflicts()` 展示规则冲突提示。

### Display

- 配置位置、缩放、透明度、置顶、鼠标穿透和锁定。
- 支持重置位置。

### System

- 配置语言和开机启动。
- 配置日志开关/级别，列出并读取日志文件。

## 事件流

```text
click on tab
-> handleTabClick()
-> state.activeTab
-> render()

submit form
-> handleFormSubmit()
-> read form model
-> updateConfig* helper
-> saveConfig()
-> render()

click action button
-> handleClickAction()
-> route by data-action
-> mutate panel draft or call asset handler
-> render()

change/input
-> handleChange() / handleInput()
-> update drafts, preview-only UI, language, logs or conditional editor state
```

事件绑定使用委托方式挂在根节点上，HTML 通过 `data-action`、`data-form-type`、`data-scope`、`data-index` 等属性携带路由信息。

## 表单模型

规则编辑器会把 UI 表单读取为当前规则数据：

- `conditions`：主条件列表。
- `actions`：命中时执行的动作。
- `state.exitConditions`：退出条件，仅对包含 `mouseMove` 的状态型规则显示。
- `state.exitActions`：退出动作。
- `cooldownMs`、`priority`、`stopOnMatch`、`actionStrategy`：执行控制字段。

`inline-action-editor.js` 使用 `scope` 区分普通动作和退出动作，避免两个列表在添加、删除、拖拽排序、类型切换时互相污染。

## 设计原则

- 主入口只做编排，不承载业务细节。
- 标签页只负责渲染当前视图，不直接访问 Electron 或文件系统。
- 配置修改集中在 `panel-state.js` 和 handler 中，方便测试。
- 所有用户输入展示前使用 `escapeHtml()`。
- 通过 i18n key 管理中英文文案，不在组件里硬编码长文案。

## 扩展指南

添加新标签页：

1. 在 `src/renderer/panel/tabs/` 创建 renderer。
2. 在 `panel.js` 导入并加入 `views`。
3. 在 `src/renderer/panel/ui/tabs.js` 的 `TABS` 增加导航项。
4. 在 `src/shared/i18n.js` 增加中英文标签。
5. 如果有表单，给表单增加明确的 `data-form-type`，并在 `form-handlers.js` 路由。

添加新动作字段：

1. 更新 `src/shared/schema.js`。
2. 更新 `components/inline-action-editor.js` 的渲染。
3. 更新 `handlers/form-handlers.js` 的读取逻辑。
4. 更新 `src/renderer/pet/user-trigger-manager.js` 执行逻辑。
5. 补充 i18n 和测试。

添加新条件字段：

1. 更新 `TRIGGER_PARAMETER_FIELDS` 和 `FIELD_INPUT_TYPES`。
2. 确认 `getFilterOperatorsForField()` 返回合适的运算符。
3. 更新事件上下文来源。
4. 补充规则引擎、validator 或 panel-state 测试。

## 测试策略

- `panel-state`：表单模型、配置更新、关键帧标准化。
- tab renderer：输出必要控件、数据属性和 i18n 文案。
- handlers：表单读取、动作 scope、拖拽排序和资产操作。
- e2e：应用启动、面板基础渲染、导入导出和主要交互流程。
