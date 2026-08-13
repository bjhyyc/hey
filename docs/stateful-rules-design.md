# 状态型规则设计文档

状态型规则用于描述 “进入条件持续成立后触发，退出条件持续成立后执行退出动作” 的行为。典型场景：鼠标靠近桌宠 3 秒后播放跟随/问候动画，鼠标远离 3 秒后回到默认动画。

## 当前能力边界

普通规则是一次性触发模型：

```text
event -> match rule -> return actions -> execute actions
```

这类规则适合点击、拖拽开始、定时提醒等瞬时事件。它不适合表达 “某个条件连续成立一段时间” 和 “激活后等退出条件持续成立再回退”。

状态型规则在 `pet-runtime.js` 中维护 per-rule 状态：

```js
{
  conditionTrueSince: number | null,
  active: boolean,
  exitTrueSince: number | null,
  lastMatchingEvent: object | null,
  lastExitEvent: object | null
}
```

## 数据结构

进入条件使用 `mouseMove` condition 上的 `sustainMs`：

```json
{
  "id": "near-pet-greeting",
  "name": "Near pet greeting",
  "enabled": true,
  "conditions": [
    {
      "type": "mouseMove",
      "sustainMs": 3000,
      "filters": [
        { "field": "distanceToPetCenter", "operator": "<=", "value": 300 }
      ]
    }
  ],
  "priority": 80,
  "actions": [
    { "type": "playAnimation", "animation": "..." }
  ],
  "state": {
    "exitConditions": [
      {
        "type": "mouseMove",
        "sustainMs": 3000,
        "filters": [
          { "field": "distanceToPetCenter", "operator": ">", "value": 360 }
        ]
      }
    ],
    "exitActions": [
      { "type": "playAnimation", "animation": "..." }
    ]
  }
}
```

说明：

- `conditions[*].sustainMs`：进入条件持续匹配多长时间后触发进入动作。
- `state.exitConditions`：激活后用于判断何时退出的条件列表。
- `state.exitConditions[*].sustainMs`：退出条件持续匹配多长时间后退出。
- `state.exitActions`：退出时执行的动作。建议显式配置为播放默认动画或其他回退动作。
- `continuous: true`：适合 keyframe scrubbing 这类激活期间需要持续重发动作的规则。

## 运行时流程

每次 `ruleRuntime.evaluateEvent(event)`：

1. 把事件加入最近 40 条事件历史。
2. 先推进状态型规则。
3. 如果进入条件匹配，设置或延续 `conditionTrueSince`。
4. 如果进入条件持续时间达到 `sustainMs` 且规则未激活，执行进入动作并置 `active = true`。
5. 激活后检查 `state.exitConditions`。
6. 如果退出条件持续时间达到其 `sustainMs`，执行 `exitActions`，清理状态。
7. 如果有状态型规则处于激活态，压制普通规则，避免低优先级规则打断当前动画。
8. 没有状态型规则激活时，普通规则按优先级、冷却和 `stopOnMatch` 正常匹配。

鼠标静止时，全局鼠标追踪不会持续发送 `mouseMove`。因此 runtime 内部有 500ms 退出检查定时器，确保已经开始的退出计时能够完成。

## 与普通规则的关系

- 带正数 `sustainMs` 的 `mouseMove` 规则不会走普通 `evaluateRules()` 一次性路径，避免重复触发。
- 激活中的状态型规则会压制普通规则。
- 状态型规则自身如果设置 `continuous: true`，激活期间会持续重发动作，用于 keyframe 进度跟随。
- 普通规则的 `cooldownMs` 仍然适用；状态型规则以 active 状态为主，不靠冷却表达保持期。

## 面板实现

涉及文件：

- `src/renderer/panel/components/rule-condition-editor.js`：在 `mouseMove` 条件高级设置中显示 `sustainMs`。
- `src/renderer/panel/tabs/rules.js`：当规则包含 `mouseMove` 条件时显示退出条件和退出动作区域。
- `src/renderer/panel/components/inline-action-editor.js`：用 `scope` 区分 `actions` 和 `exitActions`。
- `src/renderer/panel/handlers/form-handlers.js`：分别读取主条件、退出条件、主动作和退出动作。
- `src/renderer/panel/panel-state.js`：构建规则对象并写入 `state.exitConditions` / `state.exitActions`。
- `src/shared/i18n.js`：中英文文案。

## 校验和测试

Manifest validator 当前校验：

- condition 类型和字段是否受支持。
- action 类型是否受支持。
- action 引用的动画 ID 是否存在。
- `state.exitConditions` 和 `state.exitActions` 的内部结构。

主要测试：

- `tests/renderer/pet-runtime.test.js`：进入 sustain、退出 sustain、静止退出兜底、active 压制普通规则、continuous 行为。
- `tests/renderer/panel-state.test.js`：表单到规则对象的转换。
- `tests/renderer/rules-tab.test.js`：退出条件/退出动作 UI。
- `tests/shared/rule-engine.test.js`：sustained 规则不走普通一次性路径。
- `tests/shared/rule-conflict-detector.test.js`：状态型 mouseMove 规则的冲突处理。

## 已知限制

- 当前状态型规则主要围绕 `mouseMove` 进入条件设计。
- 多个状态型规则同时满足时，需要通过优先级和规则设计避免语义冲突。
- 退出动作应显式配置；不要依赖旧文档中的隐式回默认语义。
