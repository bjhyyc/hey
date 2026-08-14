# BLOCKED / 上线前待完成项

这些项目不阻塞本地模拟流程和客户端开发，但阻塞正式收费上线。

## 外部资质与账号

- 营业执照申请及最终主体信息。
- Kaipay EPay V1 下单、支付宝/微信渠道、GET 异步通知、MD5 验签、服务端主动查单、精确回执和无扣款商户探针已完成；仍需用户在安全文件中配置真实 `pid`/EPay 密钥，运行只读探针，并批准一笔最低金额且有最高费用上限的真实订单。密钥不得发送到聊天或进入 Git。
- 当前 Lighthouse 公开 API 仍是 auth-only 部署；必须先部署完整 Studio API，并让 Caddy 只放行 Kaipay 通知所需的精确路径，确认 `https://api.heyirmy.com/api/payments/kaipay/notify/<orderId>` 可达后，才能验收小额支付、重复通知、错误签名、未知状态和主动查询。
- Kaipay 公开 EPay V1 文档未定义退款接口；自动退款保持关闭。若商户后台有单独正式退款 API 文档，需要用户提供页面后再冻结、实现和做一笔受控退款验收。
- ModelArk 生产 Seedream / Seedance 端点 ID、额度、精确价格、并发/限流和回调语义复核。
- Windows 安装包代码签名证书。

## 需要重新盘点的生产基础设施

- PostgreSQL 18.4 的 TLS-only、TLS 1.2+、独立 CA、运行时证书隔离、迁移并发锁及明文拒绝已在本机真实演练通过，Lighthouse 发布代码也已完成；但正式 PostgreSQL 18 不可变镜像 digest、应用端新 CA 配置、完整备份/恢复演练和维护窗口尚未确定，因此尚未部署现网。
- Redis 8 的 TLS-only、独立 CA、最小权限前缀 ACL、越界 key/`FLUSHALL` 拒绝已在隔离容器真实通过；`sent` outbox 对账、全新空队列命名空间的确定性重放、AOF 同容器保留重启，以及 API、Outbox 两个边界和 Worker 活跃租约四个精确 hard-kill 也已通过，且未清空或删除 Redis 数据。本次 Alpine 镜像仍仅作功能验证；尚需选择并扫描正式不可变镜像、部署持久化实例，并完成死信与积压告警演练。
- COS 生产 CAM 最小权限、生命周期、删除和审计策略。
- 私有 outbox/Worker Compose、运行时心跳、非 root/read-only/资源上限及最小化 distroless 镜像已完成；镜像尚未推送生产仓库并以 registry digest 部署，队列积压/死信告警与水平扩容仍未完成。
- 当前媒体 Worker 的人工运行时清单仍包含 `libjxl0.7`；即使 Docker Scout 报告 0 项，先前识别的未修复 jpeg-xl `CVE-2025-70103` 仍按高危阻塞正式发布。必须换成不含该库的最小 FFmpeg 或验证过的已修复版本，并重新扫描、生成 SBOM、实测 VP9/alpha 后才能解除。
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
