# Hey Pet 上线任务清单

更新时间：2026-08-18

## 当前结论

尚未达到公开收费上线条件。线上 API、Outbox、Worker 当前均为 healthy，公网 `/readyz` 返回 200；但 Worker/Outbox 使用 `controlled-real` 镜像，不能作为 production-assured 视觉生产链路。

production-assured Worker 组件包（`platform/src/runtime/production-worker-components.js`）已完成并通过组件合同与 manifest 固定验证。候选 Worker 镜像 `production-qa-20260818-r4` 已打入干净上游客户端树、Electron 31.7.7、xvfb 与 FFmpeg 7.0.2，并移除运行时 npm/Corepack/Yarn；本地加固 smoke、临时根可写探针和 Critical/High CVE 门已通过。该镜像尚未推送到生产镜像仓库，也尚未替换线上 Worker。

本地最近一次回归：108 个测试文件通过，2 个按设计跳过；1089 个测试通过，2 个跳过。桌宠 Vite、落地页 Vite、网站 Next.js 三项生产构建通过。

最近一次免费生产 QA 校准（不调用 ModelArk，复用已生成的 controlled-real 媒体）报告：
`.tmp/production-qa-calibration/calibration-2026-08-18T0611/report.json`。
三张母图通过（3/3），七个动作通过 5/7：`idle`、`sneeze`、`roll`、`sleep-loop`、`hover-attention`；`sleep-transition` 因逐帧形变/抠图边缘稳定性失败，`stretch` 因多主体/抠图完整性失败。该报告只能证明生产门正确拒绝当前旧媒体，不能替代下一次真实七动作批次。

2026-08-18 线上只读部署前快照：Studio API、Outbox、Worker 均 healthy 且重启数为 0；当前 Worker 仍为 `controlled-real-20260817-r5`。Seedream/Seedance endpoint 和 model registry 均已配置且不含 fixture/test 标识；`/work` 属于 UID/GID 10001 并可写。数据库无进行中工作：101 个 outbox 全部 sent，99 个 execution succeeded、1 个 dead，1 个历史 run failed；没有 pending/leased/retryable execution，也没有 pending/leased/failed outbox。

## P0：必须完成

- [x] 保存单独的 `sleep-transition` 原始提示词覆盖；其他六个动作提示词不变。
- [x] 将可信 FFmpeg 首尾帧解码检查接入 `MediaWorker`。
- [x] 提供 production-assured 的母图处理器、抠图/去绿处理器、动作 QA 和交付验证器（`platform/src/runtime/production-worker-components.js`：全部证据从解码字节实测，无 fixture 值；照片/母图参照分别用背景分离与 chroma 掩膜测量；逐帧覆盖 + worst-frame chroma 完整性 + 外观最小分 + sleep-loop 呼吸循环计数；交付验证器绑定 pinned 干净上游导入与 pinned Electron 交互 runner）。
- [x] 生产 manifest 固定组件版本、合同版本、校准摘要和引擎摘要（`productionComponentManifest` canonical SHA-256 必须等于 `PETPACK_WORKER_COMPONENTS_MANIFEST_SHA256`；校准摘要 = 冻结校准数据的 canonical SHA-256，交付验证器摘要绑定上游树/Electron/runner 校验和；`print-production-worker-manifest.js` 供运维在镜像内输出待固定 SHA）。
- [ ] 下一次真实生成按完整七动作批次执行；只替换 `sleep-transition` 提示词，不单独重复生成。
- [ ] 真实七动作媒体通过逐帧 QA、首尾帧绑定、sleep-loop 接缝、打包和原版客户端导入。（当前免费校准为 5/7；旧 `sleep-transition` 和 `stretch` 仍拒绝，不能放行。）
- [x] 将线上 controlled-real Worker 替换为 production-assured Worker 镜像（2026-08-18 完成，经用户确认切换）。镜像 `petpack-studio-worker:production-qa-20260818-r4` 以 gzip tar + SHA-256（`b6e1544e…`）校验传输，服务器 `docker load` 后 ID digest 与本地候选逐字节一致（`sha256:9252edd6b15f1ac53430ef4ec01b4a0a9d5bf5b04be4cd7d83ac805129822825`）；发布目录 `/opt/petpack/releases/production-worker-r1-20260818/`（当前版 compose，无 controlled-real 覆盖，`.env` 固定 `PETPACK_WORKER_COMPONENTS_MANIFEST_SHA256=18677e33…`）。启动日志 `mode: production, evidenceMode: production, concurrency: 7`，健康检查 healthy；切换后 Outbox 零积压、队列 0 等待/0 失败、公网 `/readyz` 200。SBOM/CVE Critical/High=0（`.tmp/release-audit/production-qa-20260818-r4/`）。回滚路径：r5 发布目录原样可重启 controlled-real Worker。遗留：`execution_dead=1` 为切换前历史死执行，待对账清理；正式 registry 化（当前为既定 tar+SHA 传输模式）列入 P1 基础设施项。

## P1：生产闭环

- [x] 真实 ModelArk Seedream/Seedance endpoint 与 model registry 已配置到当前线上 Worker；只读检查确认值存在且不含 fixture/test 标识（不在文档或日志中记录实际 ID）。
- [ ] 真实 ModelArk 成本、并发、超时、重试和幂等证据。
- [ ] 3–4 张来源照→3 张母图→7 个动作→后处理→QA→PetPack→下载导入全链路报告。
- [ ] 生产 COS 上传、私有读取、归档、下载和最小权限验证。
- [ ] PostgreSQL/Redis 备份恢复、Outbox 重放、API/Outbox/Worker 硬中断恢复报告。
- [ ] Kaipay V3：下单→支付→Webhook 验签→主动查单→订单 paid→工作流只启动一次→受控退款。
- [ ] 队列积压、死信、过期租约、成本超限、容器 OOM 和磁盘告警。
- [ ] 隐私政策、服务协议、AI 生成说明、保留期限、删除和退款补救规则。

## 用户需要提供

1. 确认是否上传并部署 r4 production-assured Worker 候选；该步骤只替换空闲 Worker，不创建生成任务。
2. r4 部署健康后，确认下一次完整七动作真实批次的费用上限和是否允许真实 ModelArk 调用。

## 禁止事项

- 不单独重复生成已完成的动作。
- 不用 controlled-real fixture 作为生产视觉证据。
- 不把 `/readyz=200` 当作媒体生产链路已放行。
- 不在日志、报告或测试输出中写出 API key、支付密钥、签名原文或私有 URL。
