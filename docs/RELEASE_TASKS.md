# Hey Pet 上线任务清单

更新时间：2026-08-17

## 当前结论

尚未达到公开收费上线条件。线上 API、Outbox、Worker 当前均为 healthy，公网 `/readyz` 返回 200；但 Worker/Outbox 使用 `controlled-real` 镜像，不能作为 production-assured 视觉生产链路。

production-assured Worker 组件包（`platform/src/runtime/production-worker-components.js`）已完成并通过全部生产 QA 门与 manifest 固定验证；剩余部署阻塞是把干净上游客户端树 + 固定校验的 Electron 运行时（含 Linux 下 xvfb）打进 Worker 镜像，再按最终 digest 部署。

本地最近一次回归：108 个测试文件通过，2 个按设计跳过；1078 个测试通过，2 个跳过。桌宠 Vite、落地页 Vite、网站 Next.js 三项生产构建通过。

## P0：必须完成

- [x] 保存单独的 `sleep-transition` 原始提示词覆盖；其他六个动作提示词不变。
- [x] 将可信 FFmpeg 首尾帧解码检查接入 `MediaWorker`。
- [x] 提供 production-assured 的母图处理器、抠图/去绿处理器、动作 QA 和交付验证器（`platform/src/runtime/production-worker-components.js`：全部证据从解码字节实测，无 fixture 值；照片/母图参照分别用背景分离与 chroma 掩膜测量；逐帧覆盖 + worst-frame chroma 完整性 + 外观最小分 + sleep-loop 呼吸循环计数；交付验证器绑定 pinned 干净上游导入与 pinned Electron 交互 runner）。
- [x] 生产 manifest 固定组件版本、合同版本、校准摘要和引擎摘要（`productionComponentManifest` canonical SHA-256 必须等于 `PETPACK_WORKER_COMPONENTS_MANIFEST_SHA256`；校准摘要 = 冻结校准数据的 canonical SHA-256，交付验证器摘要绑定上游树/Electron/runner 校验和；`print-production-worker-manifest.js` 供运维在镜像内输出待固定 SHA）。
- [ ] 下一次真实生成按完整七动作批次执行；只替换 `sleep-transition` 提示词，不单独重复生成。
- [ ] 真实七动作媒体通过逐帧 QA、首尾帧绑定、sleep-loop 接缝、打包和原版客户端导入。
- [ ] 将线上 controlled-real Worker 替换为 production-assured Worker 镜像，并用最终 image digest 部署。（组件模块已就绪；镜像还需打入 pinned 干净上游客户端树、pinned Electron 运行时与 xvfb，并在 Compose/预检中补齐 `PETPACK_PRODUCTION_UPSTREAM_CLIENT_*` 与 `PETPACK_PRODUCTION_ELECTRON_*` 环境项。）

## P1：生产闭环

- [ ] 真实 ModelArk Seedance endpoint 配置到运行时；当前本机 `modelark_seedance_endpoint_id.txt` 为空。
- [ ] 真实 ModelArk 成本、并发、超时、重试和幂等证据。
- [ ] 3–4 张来源照→3 张母图→7 个动作→后处理→QA→PetPack→下载导入全链路报告。
- [ ] 生产 COS 上传、私有读取、归档、下载和最小权限验证。
- [ ] PostgreSQL/Redis 备份恢复、Outbox 重放、API/Outbox/Worker 硬中断恢复报告。
- [ ] Kaipay V3：下单→支付→Webhook 验签→主动查单→订单 paid→工作流只启动一次→受控退款。
- [ ] 队列积压、死信、过期租约、成本超限、容器 OOM 和磁盘告警。
- [ ] 隐私政策、服务协议、AI 生成说明、保留期限、删除和退款补救规则。

## 用户需要提供

1. `MODELARK_SEEDANCE_ENDPOINT_ID`（填写到 `C:\Users\86135\Desktop\modelark_seedance_endpoint_id.txt`）。
2. 确认下一次完整七动作真实批次的费用上限和是否允许真实 ModelArk 调用。

## 禁止事项

- 不单独重复生成已完成的动作。
- 不用 controlled-real fixture 作为生产视觉证据。
- 不把 `/readyz=200` 当作媒体生产链路已放行。
- 不在日志、报告或测试输出中写出 API key、支付密钥、签名原文或私有 URL。
