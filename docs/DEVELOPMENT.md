# Desktop Pet 开发指南

本文档是 Desktop Pet 的开发者入口，介绍本地开发、项目目录、核心运行模型和相关技术文档。宠物包制作与普通使用说明请阅读 [用户手册](USER_GUIDE.md)。

## 开发环境

准备 Node.js 和 npm，克隆项目后安装依赖：

```bash
npm install
```

启动 Electron 开发环境：

```bash
npm run dev
```

## 常用命令

```bash
# Electron 应用
npm run dev              # 启动开发环境
npm run build            # 构建 renderer
npm run pack             # 打包应用目录，不生成安装器
npm run dist             # 生成可分发安装器

# 测试
npm test                 # 运行 Vitest 单元测试
npm run test:watch       # 以 watch 模式运行单元测试
npm run test:e2e         # 运行 Playwright E2E，包含 Electron smoke
npm run test:e2e:ci      # 在 CI/headless 环境运行 E2E，跳过 Electron smoke

# 官网和在线手册
npm run landing:dev      # 启动 landing 开发服务
npm run landing:build    # 构建 landing 到 dist/pages
```

## 项目结构

```text
desktop-pet/
├── src/
│   ├── main/                 # Electron 主进程、窗口、IPC、托盘和本地服务
│   ├── preload/              # 通过 contextBridge 暴露受控 renderer API
│   ├── renderer/
│   │   ├── pet/              # 宠物窗口、动画播放、规则运行时和动作执行
│   │   └── panel/            # 控制面板页面、组件、状态和事件处理
│   └── shared/               # schema、规则引擎、校验、i18n 和共享工具
├── landing/                  # 官网和在线使用手册
├── tests/                    # Vitest 与 Playwright 测试
├── docs/                     # 用户、架构、需求和发布文档
└── dist/                     # 构建产物
```

## Electron 运行模型

应用由三个安全边界明确的部分组成：

1. **Main Process**：创建窗口和托盘，处理 IPC、本地文件、Petpack、全局鼠标与系统能力。
2. **Preload Scripts**：使用 `contextBridge` 向 renderer 暴露有限 API，renderer 不直接访问 Node.js。
3. **Renderer Processes**：`pet/` 渲染和驱动宠物，`panel/` 提供配置界面。

完整模块职责和扩展点见 [当前架构](architecture/current-architecture.md)。控制面板模块说明见 [Panel Architecture](panel-architecture.md)。

## 核心数据流

### 配置更新

```text
Panel 保存表单
→ config:save IPC
→ Main 持久化配置并广播 pet:runtime-updated
→ Pet renderer 重建动画和规则运行时
```

### Petpack 导入

```text
选择 .petpack
→ Main 校验、解压并原子安装
→ 更新当前素材包
→ Pet renderer 重新加载资源和规则
```

### 规则执行

```text
DOM / 全局鼠标 / timer 事件
→ pet.js 构建事件上下文
→ ruleRuntime.evaluateEvent() 匹配规则
→ UserTriggerManager.executeAction() 执行动画、消息和窗口动作
```

规则的默认多条件匹配窗口为 1000ms；需要更长窗口时，在规则上显式设置 `conditionWindowMs`。

## 测试与构建

- 修改共享逻辑或 renderer 行为后运行 `npm test`。
- 修改窗口启动、IPC 或完整交互流程后运行 `npm run test:e2e`。
- 无法启动 Electron 的 CI/headless 环境使用 `npm run test:e2e:ci`。
- 发布前先运行 `npm run build`，再根据需要执行 `npm run pack` 或 `npm run dist`。

## 相关技术文档

- [当前架构（含动画队列）](architecture/current-architecture.md)
- [控制面板架构](panel-architecture.md)
- [状态型规则设计](stateful-rules-design.md)
- [事件总线历史设计](architecture/event-bus-design.md)
- [客户端需求文档](requirements/desktop-client-prd.md)
- [发布清单](release/client-release-checklist.md)
