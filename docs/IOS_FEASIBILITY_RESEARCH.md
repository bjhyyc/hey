# iPhone 端「桌宠」可行性调研

日期：2026-08-27 · 结论：**可行，但形态必须重构**。生成工作流约 95% 原样复用，工程增量 = 一个 iOS 交付 profile + 一个 Swift 客户端 + APNs 推送服务。

## 结论先行

1. 一比一复刻「悬浮在所有界面之上的桌宠」在 iOS 上**做不到**——iOS 没有跨应用悬浮窗 API；唯一变通（滥用画中画）做不出透明贴屏，且有下架风险。
2. 「宠物常驻手机屏幕」在 iOS 有一套被市场验证的合法形态：**灵动岛宠物（Live Activity）+ 锁屏/桌面小组件 + App 内完整互动**。先例：Pixel Pals（灵动岛宠物鼻祖，Apollo 作者 Christian Selig 出品，运营 3 年+）、Widgetable（2023 年美区下载榜曾到 #5，第三方估算月流水 $100k 量级）。
3. 现有生成管线（照片预检 → Seedream 母图 → Seedance 七动作 → 抠像/QA → 打包）**全部平台无关，原样复用**。七动作语义（idle / sneeze / roll / sleep-transition / sleep-loop / stretch / hover-attention）在 iOS 各载体全部用得上。
4. 差异化成立：市面所有岛宠都是预制像素/卡通宠物；Hey Pet 能做「你家宠物照片生成的真宠上岛」。生成管线正是竞品没有的壁垒。
5. 若战略目标是「手机上 1:1 复刻悬浮桌宠」，那个平台是 Android（有系统悬浮窗权限），不是 iOS。

## 一、为什么「悬浮桌宠」这条路在 iOS 不存在

- 桌面端形态 = Electron 透明+置顶+无边框窗口（320×320）+ 全局鼠标事件。iOS 没有任何等价物：无跨应用悬浮窗 API，App 退后台即挂起，不能持续绘制。
- 画中画（PiP）变通的三个否决点：① PiP 是不透明矩形视频窗，视频层无 alpha，透明贴屏效果不存在；② 审核指南要求 PiP 用于真实视频播放，滥用属灰区（中国区有悬浮测速类 App 存活，但随时可能被下架）；③ 常驻后台播放耗电。**判定：不做。**

## 二、宠物在 iPhone 上能住哪（载体盘点）

| 载体 | 能做什么 | 关键限制 | 对应现有素材 |
|---|---|---|---|
| 灵动岛 / Live Activity（iOS 16.1+） | 宠物趴在岛边缘，任何 App 内 + 锁屏 + 常显屏全程可见；长按展开喂食/互动 | 单次最长 8h 活跃 + 4h 停留；动画 ≤2s 且系统控制；推送更新限流、payload ≤4KB；iOS 17.2+ 可 push-to-start 远程重开 | idle / sleep-loop 帧序列 → 动画字体（见三） |
| 桌面/锁屏小组件（WidgetKit） | 宠物状态卡（睡觉/伸懒腰/等你回来）；iOS 17 起按钮互动（App Intents 喂食/摸摸）；iOS 27 特大全屏组件、对应 App 活跃时实时刷新 | 静态快照 + 时间线，每日约 40–70 次刷新预算；无视频 | 三张母图 + 各动作关键帧切片 |
| StandBy 充电横屏（iOS 17） | 床头「宠物窝」，播睡觉状态 | 本质是 widget，限制同上 | sleep 母图 / sleep-loop 帧 |
| App 内 | 完整互动宠物：戳/摸/拖/陀螺仪；AR 摆到真桌面；番茄钟 | 唯一能 1:1 播放 480p 透明视频的地方；仅打开 App 时可见 | 全部七动作视频 |
| 外围 | iMessage 贴纸包、推送通知（宠物「来找你」）、Apple Watch Smart Stack 显示 Live Activity | — | 母图/帧导出 |

加分项：iOS 26 起 Live Activity 自动出现在 Mac 菜单栏（iPhone 镜像）与 Apple Watch，一份岛宠三端可见；iOS 27 增加横屏灵动岛。

## 三、灵动岛连续动画的实现手法（Pixel Pals 验证）

- 系统只允许 ≤2 秒的系统控制动画；TimelineView 高频重绘会被系统惩罚。
- 业界通行后门：`Text(timerInterval:)` + 自定义字体。系统每秒替你渲染「计时器文本」，把字体 glyph 换成宠物帧，即得零功耗 1fps 逐帧动画（Hackaday 2025-05 有专文；Pixel Pals 系用了三年+，含 Home Screen 动画组件）。
- 对 Hey Pet 的落地路径：QA 层本就产出逐帧 RGBA（compareRgbaFrames），打包阶段加一条 fonttools 产线把帧打进 TTF → **「每只宠物一个动画字体」全自动生成**，直接喂岛和组件。
- 风险标注：灰色手法，Apple 长期默许头部 App 使用；退路是状态帧 + 系统转场。

## 四、媒体格式：唯一的硬工程改造点

现状交付物：WebM VP9 原生 alpha（854×480 @24fps，alpha_mode=1）。iOS 现实：

- AVPlayer 完全不支持 WebM/VP9；
- iOS Safari / WKWebView 支持 VP9 但**不支持 VP9 alpha**（透明被渲染成黑底）；
- iOS 原生透明视频 = **HEVC with alpha**（iOS 13+，硬解硬编，.mov/.mp4）；
- 服务器端（Linux ffmpeg）编不出 HEVC alpha：libx265 无 alpha（ffmpeg trac #11331 仍开放，x265 的 ENABLE_ALPHA 为实验分支），ffmpeg 连 HEVC alpha 解码都不完整。

三条路线：

1. **设备端一次转码（推荐，保包格式统一）**：.petpack 不变；iOS 客户端导入时内置 libvpx 软解（480p24 对 A 系芯片毫无压力）→ `AVAssetWriter(AVVideoCodecType.hevcWithAlpha)` 硬编一次并缓存 → AVPlayer 播放。导入慢几秒，换来跨端唯一规范包。
2. **服务器出帧图集（推荐，同时喂岛和组件）**：打包追加产物：sprite atlas（WebP/HEIC）+ 帧时序表 + 动画字体 TTF。App 内用 SpriteKit/Metal 渲图集（帧级控制正好贴合现有端点连续性合同）。体积估算：7 动作 ×~5s×24fps ≈ 840 帧，WebP 有损+alpha 约 15–25MB/只（待实测）。
3. 动图格式（APNG / animated WebP / AVIF）：解码兼容性与体积均不如前两条，不做主路线。

建议 1+2 并行：包内同带 WebM（桌面端）+ atlas/字体（iOS 载体），HEVC 转码作为 App 内视频路径的运行时缓存。生成/QA 层零改动。

## 五、客户端与交付链路

- Electron 上不了 iOS，客户端需 Swift/SwiftUI 新写（SpriteKit 渲染 + ActivityKit + WidgetKit + App Intents）。
- 规则引擎：素材包永远不带 triggerRules（设计如此），行为由客户端按 `manifest.studioBehavior` 合成——iOS 用 Swift 重写这个小合成器即可（纯 JS 的 rule-engine.js 理论可跑 JavaScriptCore，无必要）。
- 交互映射：click→点按；drag→拖拽；hover 2s→长按/抚摸手势；idleDuration→无触摸计时（idle→sleep-transition→sleep-loop 原样成立）；全局鼠标角度跟随→陀螺仪或拖拽方向。
- 交付：桌面是「下载 .petpack 手动导入」；iPhone 需账号/兑换码绑定 + App 内从 COS 直拉已购包（现有 deliverable 授权模型上加一个 App 拉取端点）。
- 推送基建：Live Activity 更新与 push-to-start 需要 APNs 服务端（Lighthouse 上加一个推送服务）。

## 六、商业与合规

- 跨平台内容：App Store 3.1.3(b) 允许用户在 App 内使用别处购得的内容。最稳妥形态 = **App 免费 + 登录即见已购宠物（Kindle 模式）**，App 内不放购买链接、不引导网页付款。
- 若要在 App 内直接卖生成服务 → 必须走 IAP（30%，小开发者计划 15%）。美区自 2025-05 起可放外链购买（Epic 禁令后果，仅美区 storefront）。
- 中国区两件绕不开：**App 备案**（独立于网站 ICP 的手续）+ **IAP 强制**（Kaipay 只能留在网页端）。
- 隐私与 AI 生成声明（本就在 P1 遗留清单）在 App 审核同样要过。

## 七、建议路线与量级

- **P1 App 内宠物**（1 名 iOS 工程师，4–8 周量级）：Swift 客户端 + 账号拉取 + 设备端转码/图集渲染 + 七动作互动 + 触摸规则。验证「照片 → 真宠 → 手机」闭环。
- **P2 岛宠 + 小组件**（再 4–6 周）：动画字体产线（服务器）+ ActivityKit/WidgetKit/App Intents + APNs。这一步才形成「iPhone 桌宠」的心智，也是传播点（Widgetable 靠 TikTok 起量）。
- **P3 锦上添花**：AR 摆桌、StandBy 精修、iMessage 贴纸、Watch。
- 前置手续：Apple Developer 公司账号（$99/年）；国内分发需 App 备案。

## 八、风险清单

| 风险 | 等级 | 对策 |
|---|---|---|
| timer-font 动画被 Apple 收紧 | 中 | 头部 App 用了 3 年+未被处罚；退路 = 状态帧 + 系统转场 |
| Live Activity 8h 时限伤体验 | 中 | push-to-start 每晨自动重开 + 打开 App 续期；产品化为「宠物作息」 |
| 中国区备案/IAP 周期 | 中 | 先海外区 / TestFlight 验证，国内并行走备案 |
| 媒体转换质量（绿边/毛发） | 低 | 帧图集直接复用 QA 后 RGBA 帧，不引入二次抠像 |
| Swift 客户端从零开始 | 中 | 无 Electron 可复用，但 studioBehavior 行为合同清晰，范围可控 |

## 参考来源

- Pixel Pals（Live Activity 岛宠先例）：https://techcrunch.com/2023/09/22/pixepixel-pals-delivers-a-cute-and-clever-update-that-takes-advantage-of-new-ios-features/ · https://fueled.com/blog/pixel-pals/
- timer+自定义字体动画后门：https://hackaday.com/2025/05/17/animated-widgets-on-apple-devices-via-a-neat-backdoor/
- Live Activities 限制与 2026 现状：https://viktorgordienko.com/live-activities-in-2026 · https://swiftcrafted.dev/article/live-activities-dynamic-island-ios-26-swiftui-activitykit-guide
- iOS 26 Live Activities 上 Mac：https://9to5mac.com/2025/12/04/ios-26-made-live-activities-even-better-on-iphone-heres-whats-new/
- iOS 27（WWDC 2026）组件/横屏灵动岛：https://www.tomsguide.com/phones/iphones/ios-27-is-official-all-the-new-upgrades-and-features-announced-at-wwdc-2026
- 透明视频格式兼容（Safari 无 VP9 alpha，HEVC alpha 为 iOS 路线）：https://jakearchibald.com/2024/video-with-transparency/ · https://rotato.app/blog/transparent-videos-for-the-web
- ffmpeg/x265 alpha 现状：https://trac.ffmpeg.org/ticket/11331
- 设备端 HEVC alpha 编码（WWDC19 Session 506 / AVVideoCodecType.hevcWithAlpha）：https://developer.apple.com/documentation/avfoundation/avvideocodectype/hevcwithalpha · https://medium.com/@f_yuki/ios-make-video-with-alpha-channel-d83a2cefe69c
- Widgetable 市场数据：https://appfigures.com/resources/insights/20230721/amp?f=2
- App Store 外链/3.1.3 变化（2025-05，美区）：https://www.iclarified.com/97192/apple-updates-app-store-rules-to-allow-external-purchase-links-in-us
