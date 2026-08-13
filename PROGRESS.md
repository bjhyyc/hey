# PROGRESS

## Recovery and baseline

- 2026-08-13：原 D 盘误删后的完整分区镜像已保存为 `E:\D_DRIVE_RECOVERY_20260812\D_partition_before_recovery.raw`，813,012,348,928 字节，已设为只读。
- 2026-08-13：已从镜像 NTFS MFT 生成目录清单，位于 `C:\testdisk\D盘目录清单_20260813`；个人媒体恢复已按用户决定暂停，可未来继续。
- 2026-08-13：D 盘未格式化；仅解除人为只读状态，未删除旧文件。
- 2026-08-13：从 `desktop-pet-0.1.1.zip` 建立干净骨架 `D:\PetPackStudio-Rebuild-20260813`，182 个文件与 C 盘来源逐项 SHA-256 一致。
- 2026-08-13：Git 初始提交 `4de9b8e57bf5517be26896d80f8355730d2b2a68`。
- 2026-08-13：完整 Git bundle 备份：`C:\testdisk\petpack-rebuild-git-backups\petpack-rebuild-baseline-4de9b8e.bundle`；SHA-256 `4C43A9572CF8DE906777DB5B04748168A0A1482CFFE452DA55380AB3F3CF1721`。
- 2026-08-13：已将原任务源与后续用户裁定合并到 `PRODUCT_CONTRACT.md`。
- 2026-08-13：用户最终指定支付服务商为 Kaipay，并已完成支付申请；后续以 `https://app.kaipay.cn/api-debugger` 的正式接入参数为准，不再开发直连支付宝。
- 2026-08-13：已从 Codex 原始会话工具输出精确恢复 2026-08-02 版 `7个动作视频提示词.txt` 正文，保存于 `docs/prompts/7个动作视频提示词.original-20260802.txt`；该版实际含 6 段，最终七段老版稳定版继续追溯。
- 2026-08-13：已从 2026-08-06 原始 `apply_patch` 工具调用逐字符恢复七段 `动作提示词·原版动作感稳定对比版.txt`；正文与原调用完全相等，规范化 SHA-256 为 `461A63041D4D45B249E4DD563A997D8281559B9F6546F1EAAB4A7A9FA7BBD879`。
- 2026-08-13：已从双母图混合版 V4 的原始读取输出恢复正面、45°与睡姿三张母图的完整正向/反向提示词，规范化 SHA-256 为 `2786D3D16ADE784648D9E7167DCA464C1DC33C987CD321CD8E7AD986DC13831A`。
- 2026-08-13：客户端运行时第一阶段完成：IPC 明确区分 PetPack 切换、素材更新和普通配置更新；仅真实切包触发 `packageLoaded`；默认动画在生命周期动作前就绪；热更新复用同一动画控制器并立即刷新变化后的待机素材。
- 2026-08-13：空闲阈值改为 22 秒，悬停/空闲事件按一次交互会话只触发一次；拖拽、暂停恢复和实际交互会重建计时会话；循环 timer 使用有界集合，不再长期积累已执行的 timeout ID。
- 2026-08-13：不同事件类型不再互相共享 cooldown 屏障，悬停动作的冷却不会阻挡单击、双击、右键或 22 秒入睡。Windows 测试夹具已改为不依赖 Unix shell，符号链接拒绝测试在无开发者模式时使用 junction 继续验证。
- 2026-08-13：上述客户端改动全量单元回归 48 个测试文件、642 项全部通过；Vite 生产构建成功（65 modules）。Electron 31.7.7 与 FFmpeg 6.1.1 已从本机校验过的缓存恢复到依赖目录，未重新下载不可信二进制。
- 2026-08-13：建立 `hey-petpack-behavior/v1` canonical PetPack 契约和生成器：固定 7 个语义动作、6 条触发规则、22 秒入睡、2 秒悬停、20 秒同事件冷却、无随机计时/移动/消息/道具/掉落；生产打包必须传入后处理后 7 个 WebM 的实测时长。
- 2026-08-13：契约已证明入睡规则无需人工 delay：`sleep-transition` 播放时 `sleep-loop` 进入单槽 pending，过渡结束直接进入循环；睡眠中单击、双击、右键均通过 `interrupt` 立即唤醒并执行喷嚏、打滚、伸懒腰。
- 2026-08-13：新增显式 `cooldownScope: eventType`，只用于 Hey 悬停与默认空闲规则；旧 PetPack 未声明时继续沿用全局 cooldown。面板隐藏设置编辑会保留该字段，通用 validator 也限制 eventType scope 只能绑定一种条件类型。
- 2026-08-13：canonical 契约与兼容性改动全量单元回归 49 个测试文件、659 项全部通过；Vite 生产构建再次成功（65 modules）。

## In progress

- 从干净骨架重新开发，不进行旧仓库逐补丁复原。
- 继续实现首页显著导入入口、设置折叠菜单与逐像素透明区域鼠标穿透。

## Next

1. 重建最新版网站首页、手机号登录和 3–4 张照片上传/两母图确认流程。
2. 重建模拟支付后的七视频并行生成、后处理、质检、PetPack 打包下载闭环。
3. 恢复客户端七动作状态机、显著导入入口、22 秒睡眠和透明区域鼠标穿透。
4. 接回 PostgreSQL、Redis/BullMQ、COS、ModelArk 与 Kaipay 的生产适配器；生产参数或外部能力未完成时全部 fail-closed。
5. 完整本地验收、构建、部署和真实 API 小额/限额测试。

## Working rules

- 每完成一个里程碑立即更新本文档并提交 Git。
- 每个里程碑生成一个新的 C 盘只读 Git bundle，不覆盖旧 bundle。
- 大型视频、模型输出、Docker 数据和用户媒体不提交 Git。
- 不写入或修改 E 盘 RAW；不删除旧 D 盘目录。
- 新代码仅位于 `D:\PetPackStudio-Rebuild-20260813`。
