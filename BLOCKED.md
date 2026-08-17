# BLOCKED / 上线前待完成项

这些项目不阻塞本地模拟流程和客户端开发，但阻塞正式收费上线。

## 外部资质与账号

- 营业执照申请及最终主体信息。
- Kaipay Pay API V3 的 capabilities/create/query/close/refund、HMAC-SHA256 请求签名、JSON Webhook 原始字节验签、事件幂等、主动查单二次确认和 204 回执已完成；Lighthouse 的 V3 credential ring 与独立通知加密键已安全挂载，数据库 013–015 已应用。`heyirmy.com` 与 `api.heyirmy.com` 的归属验证均已通过，复跑无费用 V3 capabilities 返回 `ok`；已按用户确认只发起一次 0.01 元支付宝 Web 创建请求，但 Kaipay 下单业务层拒绝、未返回订单号、未扣款且未回调。需在 Kaipay 控制台确认授权域名巡检与电脑网站产品状态已对当前二级商户生效；未获明确授权前不重试。
- Lighthouse 已部署 API-only Studio API，Caddy 仅放行 `/readyz`、Kaipay 精确 POST 通知路径及既有 auth/业务白名单；公网 `/readyz` 返回 200，空回调探针到达应用并返回 400。Outbox/Worker 仍关闭；支付业务层通过后才继续重复通知、错误签名、未知状态和主动查询验收。Webhook 延迟时，网站会调用受保护的 `POST /api/projects/:projectId/payment-status` 服务端查单兜底。
- Kaipay V3 退款契约已实现；仍需部署操作员在明确费用上限内做一笔受控退款验收，证明 credential version 冻结、唯一 `refundRequestNo` 与人工审核分支符合商户实况。
- ModelArk Seedream 单图非流式多参考输入和 Seedance 2.0 首尾帧、4–15 秒、480p、无音频/水印、异步权威查询契约已实现；生产链路暂不配置未接通的回调 URL/Secret，避免把回调成功误认为业务完成。仍需部署操作员在安全文件配置生产端点和额度后复核精确价格、并发/限流与真实媒体质量，自动化流程不索要真实 API key。
- Windows 安装包代码签名证书。

## 需要重新盘点的生产基础设施

- PostgreSQL 18.4 的 TLS-only、TLS 1.2+、独立 CA、运行时证书隔离、迁移并发锁及明文拒绝已在本机真实演练通过，Lighthouse 发布代码也已完成；但正式 PostgreSQL 18 不可变镜像 digest、应用端新 CA 配置、完整备份/恢复演练和维护窗口尚未确定，因此尚未部署现网。
- Redis 8 的 TLS-only、独立 CA、最小权限前缀 ACL、越界 key/`FLUSHALL` 拒绝已在隔离容器真实通过；`sent` outbox 对账、全新空队列命名空间的确定性重放、AOF 同容器保留重启，以及 API、Outbox 两个边界和 Worker 活跃租约四个精确 hard-kill 也已通过，且未清空或删除 Redis 数据。本次 Alpine 镜像仍仅作功能验证；尚需选择并扫描正式不可变镜像、部署持久化实例，并完成死信与积压告警演练。
- COS 生产 CAM 最小权限、生命周期、删除和审计策略。
- 私有 outbox/Worker Compose、运行时心跳、非 root/read-only/资源上限及最小化 distroless 镜像已完成；镜像尚未推送生产仓库并以 registry digest 部署，队列积压/死信告警与水平扩容仍未完成。
- Debian FFmpeg 媒体镜像因 `libjxl0.7` 仍按高危阻塞正式发布；当前已接入并在本机验证 John Van Sickle `ffmpeg-7.0.2-amd64-static` 候选（归档 SHA-256 `ABDA8D77CE8309141F83AB8EDF0596834087C52467F6BADF376A6A2A4C87CF67`），候选镜像不含 libjxl、Docker Scout 为 0 项并通过 VP9/绿幕规范化烟测。仍需在发布流水线固定来源、生成 SBOM、复核许可证与代表性透明媒体后，才能解除该门禁。
- `PETPACK_WORKER_COMPONENTS_MODULE` 所需的生产来源照、母图、抠图/QA 与 delivery-validator 组件仍未实现 production-assured manifest；当前 fixture 组件只可用于零费用彩排，生产 profile 保持关闭。

## 视觉处理与真实验收

- 已恢复的老版稳定七动作与三母图提示词仍需在真实 Seedream / Seedance 小额测试后冻结正式发布版本；恢复文本本身不再是阻塞项。
- 真实来源照分类器、两母图身份/花色一致性、浅色毛发抠图、去绿、黑边检测和动作 QA 处理器仍需真实模型/校准数据。
- 需要代表性的猫狗、长短毛、白/黑/花色样本和人工标注验收集。
- 3 张输入、正面/45°/睡姿三母图、七视频并发、后处理、QA、打包、下载和原版客户端导入已用合成媒体完整通过；仍需 4 张输入、两母图单独重生成，以及真实 ModelArk 媒体的相同全链验收。

## 法务与经营策略

- 隐私政策、用户服务协议、AI 生成内容说明、退款/人工补救规则。
- 上传原图、中间产物、视频和 PetPack 的保留期限与用户删除流程。
- SKU、售价、包含的母图重生成次数、内部成本上限和人工补偿政策最终批准。
