# Hey Pet

把宠物的照片变成会动的桌宠。

用户上传几张宠物照片，平台生成三张母图和七个动作视频，打包成 `.petpack` 素材包；下载导入桌宠客户端后，宠物就住在桌面上，会打招呼、打滚、伸懒腰、睡觉。

线上：[heyirmy.com](https://heyirmy.com)

## 仓库结构

这个仓库同时装着客户端和生成平台两部分：

| 目录 | 内容 |
| --- | --- |
| `src/` | Electron 桌宠客户端（主进程、预加载、渲染进程、共享逻辑） |
| `platform/` | PetPack Studio 后端：API、生成流水线 Worker、QA 判据、数据库迁移 |
| `apps/web/` | PetPack Studio 网页端（Next.js） |
| `landing/` | 官网落地页 |
| `tests/` | 全量测试（客户端、平台、渲染层、发布、端到端） |
| `docs/` | 开发说明、发布任务、用户手册、提示词 |
| `ops/`、`scripts/` | 运维与构建脚本 |

## 生成流程

```
上传照片 → 视觉预检（不合格不放行下单）→ 付款
        → Seedream 生成三张母图（正面 / 侧面 / 睡姿）→ 用户确认
        → Seedance 生成七个动作视频 → 抠像与后处理 → QA 判据
        → 打包 .petpack → 交付验证（无头 Electron 跑七项真实交互）
        → 用户下载导入
```

七个动作：`idle`、`sneeze`、`roll`、`sleep-transition`、`sleep-loop`、`stretch`、`hover-attention`。

## 开发

需要 Node.js 22。

```bash
npm install
npm run dev          # 启动桌宠客户端
npm test             # 全量测试
npm run landing:dev  # 官网落地页
```

网页端与平台服务分别在各自目录：

```bash
npm --prefix apps/web run dev        # 网页端 localhost:3000
npm --prefix platform run start:studio-api
npm --prefix platform run start:studio-worker
```

客户端打包：

```bash
npm run build && npm run dist
```

更多细节见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

## 部署

平台以容器方式部署：`platform/docker/runtime`（API 与调度）和 `platform/docker/media-worker`（生成 Worker，内含固定版本的 FFmpeg 与无头 Electron，用于交付验证）。数据库迁移在 `platform/sql/`，按编号顺序执行。

密钥一律通过 `*_FILE` 环境变量从文件注入，不写进仓库、不落日志。

## 许可与致谢

本项目基于 [duzexu/desktop-pet](https://github.com/duzexu/desktop-pet) 开发，遵循 **GNU GPL v3**，完整条款见 [`LICENSE`](LICENSE)。桌宠客户端部分为其衍生作品，分发时须一并提供对应源码并保留原作者署名。
