# 用户手册：制作桌面宠物包

本指南说明如何制作当前版本可导入的 `.petpack`。`.petpack` 本质是 ZIP 文件，包含 `manifest.json` 和素材文件。

## 目录

1. [宠物包结构](#宠物包结构)
2. [支持格式和限制](#支持格式和限制)
3. [创建步骤](#创建步骤)
4. [manifest.json](#manifestjson)
5. [动画剪辑](#动画剪辑)
6. [规则和行为](#规则和行为)
7. [状态型规则](#状态型规则)
8. [导入和分享](#导入和分享)
9. [常见问题](#常见问题)

## 宠物包结构

推荐结构：

```text
my-cute-pet/
├── manifest.json
└── assets/
    ├── idle.svg
    ├── click.gif
    ├── drag.webp
    └── follow.webm
```

打包后：

```text
my-cute-pet.petpack
├── manifest.json
└── assets/
    ├── idle.svg
    ├── click.gif
    ├── drag.webp
    └── follow.webm
```

素材路径必须是相对路径，例如 `assets/idle.svg`。不要使用绝对路径、反斜杠、URL、`.` 或 `..`。

## 支持格式和限制

支持的素材格式：

- `.gif`
- `.webp`
- `.webm`
- `.mp4`
- `.mov`
- `.png`
- `.svg`

限制：

- 不允许符号链接。
- manifest 中引用的素材必须真实存在。
- 导入会根据当前机器可用内存和磁盘余量中止异常占用资源的 petpack。

## 创建步骤

1. 准备素材。至少准备一个默认待机素材。
2. 创建项目目录和 `assets/` 目录。
3. 编写 `manifest.json`。
4. 压缩目录内容为 ZIP。
5. 把扩展名改成 `.petpack`。
6. 在控制面板 Assets 标签页导入。

macOS/Linux 打包示例：

```bash
cd my-cute-pet
zip -r ../my-cute-pet.petpack .
```

Windows PowerShell 示例：

```powershell
Compress-Archive -Path * -DestinationPath ..\my-cute-pet.petpack
```

## manifest.json

最小可用示例：

```json
{
  "schemaVersion": 1,
  "packageId": "my-cute-pet",
  "name": "My Cute Pet",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "A tiny desktop companion.",
  "animations": {
    "default": {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Idle",
      "asset": "assets/idle.svg",
      "type": "default"
    },
    "clips": []
  },
  "triggerRules": []
}
```

必填字段：

- `schemaVersion`：当前为 `1`。
- `packageId`：包 ID，建议 kebab-case。
- `name`：显示名称。
- `version`：版本号。
- `animations.default`：默认动画。
- `animations.clips`：动画剪辑数组，可为空。

可选字段：

- `author`
- `description`
- `homepage`
- `license`
- `preview`
- `triggerRules`

动画 ID 必须是 UUID。规则动作通过动画 ID 引用剪辑。

## 动画剪辑

当前动画结构：

```json
{
  "animations": {
    "default": {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Idle",
      "asset": "assets/idle.svg",
      "type": "default"
    },
    "clips": [
      {
        "id": "22222222-2222-4222-8222-222222222222",
        "name": "Click",
        "asset": "assets/click.gif",
        "type": "oneshot",
        "durationMs": 900
      },
      {
        "id": "33333333-3333-4333-8333-333333333333",
        "name": "Drag",
        "asset": "assets/drag.webp",
        "type": "loop"
      },
      {
        "id": "44444444-4444-4444-8444-444444444444",
        "name": "Follow Cursor",
        "asset": "assets/follow.webm",
        "type": "keyframe",
        "keyframes": [
          { "input": 0, "output": 0 },
          { "input": 0.25, "output": 0.25 },
          { "input": 0.5, "output": 0.5 },
          { "input": 0.75, "output": 0.75 }
        ]
      }
    ]
  }
}
```

类型说明：

- `default`：默认动画，只用于 `animations.default`。
- `oneshot`：一次性动画，通常配置 `durationMs`，播完后自动切走（播放排队中的下一个动画，或回到默认动画）。
- `loop`：循环动画，不会依赖动作的 `durationMs` 自动停止；`durationMs` 表示单次循环时长，用于在循环边界切换。通常由其他规则或退出动作切走。
- `keyframe`：通过 progress 控制播放进度，可用于“鼠标从哪个方向靠近，宠物看向哪里”的效果。

**动画排队（不打断）**：`playAnimation` 不会打断正在播放的受保护动画（未播完的 `oneshot`、或任意 `loop`）。新的播放请求会进入一个**单槽等待区**：当前动画播完后再播放等待区里的那个。若等待期间又来了新请求，会**覆盖**旧的等待项（中间的被丢弃，最新者胜）；请求与当前动画相同则忽略。`loop` 会等到下一个循环边界（按 `durationMs`）再切换。唯一的即时例外是 `keyframe` 的连续 scrub（`setKeyframeProgress`），它会立即生效并清空等待区，以保证宠物实时跟随鼠标。

视频素材可配置 green screen：

```json
{
  "id": "55555555-5555-4555-8555-555555555555",
  "name": "Video",
  "asset": "assets/video.webm",
  "type": "loop",
  "greenScreen": {
    "enabled": true,
    "color": "#00ff00",
    "tolerance": 0.35,
    "softness": 0.08
  }
}
```

## 规则和行为

规则格式：

```json
{
  "id": "click-greeting",
  "name": "Click greeting",
  "enabled": true,
  "conditions": [
    {
      "type": "click",
      "filters": [
        { "field": "isInsidePet", "operator": "=", "value": true }
      ]
    }
  ],
  "priority": 50,
  "cooldownMs": 1000,
  "actionStrategy": "sequence",
  "stopOnMatch": true,
  "actions": [
    {
      "type": "playAnimation",
      "animation": "22222222-2222-4222-8222-222222222222",
      "durationMs": 900
    },
    {
      "type": "showMessage",
      "text": "Hi there!",
      "durationMs": 1800
    }
  ]
}
```

常用条件类型：

- `click`
- `doubleClick`
- `rightClick`
- `dragStart`
- `dragging`
- `dragEnd`
- `mouseEnter`
- `mouseLeave`
- `mouseMove`
- `mouseStill`
- `hoverDuration`
- `idleDuration`
- `timer`
- `randomTimer`
- `pomodoroComplete`
- `appLaunch`
- `packageLoaded`

常用过滤字段：

- `isInsidePet`
- `distanceToPetCenter`
- `distanceToPetBounds`
- `speed`
- `direction`
- `angleToPetProgress`
- `isMovingTowardPet`
- `isMovingAwayFromPet`
- `dragDistance`
- `dragDurationMs`
- `elapsedMs`
- `currentHour`

过滤运算符：

- `=`
- `!=`
- `>`
- `>=`
- `<`
- `<=`
- `between`
- `in`
- `notIn`

动作类型：

- `blank`
- `playAnimation`
- `setKeyframeProgress`
- `showMessage`
- `randomMessage`
- `changeScale`
- `changeOpacity`
- `movePet`
- `pomodoroTimer`
- `hidePet`
- `showPet`
- `resetPosition`
- `openPanel`

多个动作默认按顺序执行。`actionStrategy: "random"` 会从动作列表中随机选一个执行。

## 状态型规则

状态型规则适合持续条件：例如鼠标靠近 3 秒后播放问候动画，远离 3 秒后回到默认动画。

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
  "continuous": true,
  "actions": [
    {
      "type": "setKeyframeProgress",
      "animation": "44444444-4444-4444-8444-444444444444",
      "progressFrom": "angleToPetProgress"
    }
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
      {
        "type": "playAnimation",
        "animation": "11111111-1111-4111-8111-111111111111"
      }
    ]
  }
}
```

`angleToPetProgress` 的方向约定：

- 上方：`0`
- 右侧：`0.25`
- 下方：`0.5`
- 左侧：`0.75`

## 导入和分享

导入：

1. 打开控制面板。
2. 进入 Assets。
3. 选择导入 petpack。
4. 选择 `.petpack` 文件。
5. 导入成功后，应用会切换到该包。

分享：

1. 在 Assets 中确认当前包素材和配置。
2. 使用导出 petpack。
3. 把生成的 `.petpack` 发给其他用户。

## 常见问题

### 为什么导入失败？

常见原因：

- `manifest.json` 不在 ZIP 根目录。
- 缺少 `schemaVersion`、`packageId`、`animations.default` 等必填字段。
- 动画 ID 不是 UUID。
- manifest 引用了不存在的素材。
- 素材路径包含 `..`、绝对路径或反斜杠。
- 文件格式不在支持列表中。
- 当前机器可用内存或磁盘余量不足以安全完成导入。

### 为什么动画不播放？

检查：

- 动画 `asset` 是否指向真实文件。
- 规则动作的 `animation` 是否是正确 UUID。
- `enabled` 是否为 `true`。
- 条件过滤是否过窄，例如 `isInsidePet` 或距离阈值不满足。
- 是否被排队机制延后：受保护的动画（未播完的 `oneshot`、或 `loop`）不会被打断，新动画要等它播完才播。等待期间若又触发新动画，中间那个会被丢弃（最新者胜）。

### 如何做透明背景？

推荐使用带透明通道的 PNG、WebP、GIF 或 WebM。MP4/MOV 透明能力依赖编码和平台支持，不如 WebM 稳定。

### 可以包含脚本吗？

不可以。Petpack 只包含 manifest 和素材文件，不执行任意脚本。

### 可以有多个宠物包吗？

可以导入多个包，但当前配置中只有一个 `currentPackageId` 处于激活状态。
