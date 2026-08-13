# PROGRESS

## Recovery and baseline

- 2026-08-13：原 D 盘误删后的完整分区镜像已保存为 `E:\D_DRIVE_RECOVERY_20260812\D_partition_before_recovery.raw`，813,012,348,928 字节，已设为只读。
- 2026-08-13：已从镜像 NTFS MFT 生成目录清单，位于 `C:\testdisk\D盘目录清单_20260813`；个人媒体恢复已按用户决定暂停，可未来继续。
- 2026-08-13：D 盘未格式化；仅解除人为只读状态，未删除旧文件。
- 2026-08-13：从 `desktop-pet-0.1.1.zip` 建立干净骨架 `D:\PetPackStudio-Rebuild-20260813`，182 个文件与 C 盘来源逐项 SHA-256 一致。
- 2026-08-13：Git 初始提交 `4de9b8e57bf5517be26896d80f8355730d2b2a68`。
- 2026-08-13：完整 Git bundle 备份：`C:\testdisk\petpack-rebuild-git-backups\petpack-rebuild-baseline-4de9b8e.bundle`；SHA-256 `4C43A9572CF8DE906777DB5B04748168A0A1482CFFE452DA55380AB3F3CF1721`。
- 2026-08-13：已将原任务源与后续用户裁定合并到 `PRODUCT_CONTRACT.md`。

## In progress

- 安装原版客户端依赖并运行基线测试/构建。
- 审计可恢复的已部署网站源码与客户端改造差距。
- 从干净骨架重新开发，不进行旧仓库逐补丁复原。

## Next

1. 重建最新版网站首页、手机号登录和 3–4 张照片上传/两母图确认流程。
2. 重建模拟支付后的七视频并行生成、后处理、质检、PetPack 打包下载闭环。
3. 恢复客户端七动作状态机、显著导入入口、22 秒睡眠和透明区域鼠标穿透。
4. 接回 PostgreSQL、Redis/BullMQ、COS、ModelArk 与支付宝的生产适配器；外部审批未完成时全部 fail-closed。
5. 完整本地验收、构建、部署和真实 API 小额/限额测试。

## Working rules

- 每完成一个里程碑立即更新本文档并提交 Git。
- 每个里程碑生成一个新的 C 盘只读 Git bundle，不覆盖旧 bundle。
- 大型视频、模型输出、Docker 数据和用户媒体不提交 Git。
- 不写入或修改 E 盘 RAW；不删除旧 D 盘目录。
- 新代码仅位于 `D:\PetPackStudio-Rebuild-20260813`。

