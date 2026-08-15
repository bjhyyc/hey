# 真实服务接入顺序与安全配置清单

本文固定真实外部服务的接入顺序。未通过上一道门，不启用下一项，也不把真实密钥写进 Git、聊天、日志或构建产物。真实密钥只由部署操作员写入安全文件；自动化流程不会询问密钥内容。

## Gate 0：本地零费用闭环（已通过）

目标：使用 PostgreSQL、Redis、合成图片/视频、模拟 Kaipay 和本地处理器，跑通：

`登录会话 → 模拟支付 → 3–4 张照片 → 正面/45°/睡姿三母图 → 7 视频并行 → 后处理/质检 → PetPack → 下载/导入`

这一阶段不需要用户提供任何真实 API，不发送短信、不扣款、不调用 Seedream/Seedance、不写生产 COS。

通过条件：多进程运行、重复任务幂等、Worker/Redis 重启可恢复、七动作齐全、PetPack 可由原版客户端导入。

当前状态：完整零费用多进程闭环、Worker 安全点重启、空 Redis 命名空间确定性重放、PostgreSQL 18 短断恢复、原版客户端导入，以及 API、Outbox 领取前后两个边界和 Worker 活跃租约四类 hard-kill 均已通过。Redis AOF 同容器停止/启动实测也已通过：6 个 waiting 与 1 个 delayed Job 在同一数据目录恢复，重启前后完整规范化队列 SHA-256 一致，最终 39 个 Job 全部 completed，外部调用与数据删除均为 0。证据为 `D:\PetPackStudio-Rebuild-20260813\.tmp\redis-aof-rehearsals\redis-aof-20260814044430-71f00321\report.json`。

## Gate 1：Kaipay Pay API V3（代码已接入，等待真实商户验收）

到达条件：Gate 0 全部通过，支付之外的订单和生产工作流已经稳定。

用户最终选定 Pay API V3。生产适配器固定国内网关 `https://api.kaipay.cn`，使用 HMAC-SHA256 签名的 capabilities/create/query/close/refund 接口；支付宝为 `provider=alipay, scene=web`，微信为 `provider=wechat, scene=native`。Webhook 只接受原始 JSON POST 与 V3 七个签名头，验签后仍必须主动查单二次确认；历史订单冻结创建时所用的 credential version，密钥轮换不会误用新 Secret 验证旧订单。EPay V1 只保留历史隔离测试，生产工厂不能选择。

生产激活时由部署操作员在安全位置配置（不通过聊天提供）：

1. 在 Kaipay 后台创建的 **V3 API Key** 已具备 `order:create`、`order:query`、`order:refund` 权限；EPay 兼容密钥不能替代；
2. V3 API Key/Secret credential ring 已写入本机或服务器安全文件，密钥本身不要发到聊天中；
3. 授权域名验证完成，商户支付配置中支付宝与微信渠道均已批准；
4. 确认生产通知域名 `https://api.heyirmy.com` 已能公开到达 Studio API 的精确 POST 回调；
5. 明确同意各 1 笔最低金额支付宝/微信订单与 1 笔退款的总费用上限。

真实验收顺序：V3 capabilities 只读探针 → 支付渠道后台核对 → 支付宝最低金额订单 → JSON POST Webhook 验签 → 主动查单 → 同一 eventId 重放 → 微信 native QR 最低金额订单 → 一笔受控退款 → 确认每个订单只启动一次工作流。若 Webhook 尚未到达，购买页的“我已完成付款”按钮会调用服务端 `POST /api/projects/:projectId/payment-status` 做一次签名查单；它不会把浏览器轮询变成无限外部请求。

## Gate 2：火山引擎 Seedream / Seedance

到达条件：Gate 0 稳定；Kaipay 可与本门并行，但真实收费网站仍保持关闭。

生产激活时由部署操作员一次性写入安全文件和发布清单（不通过聊天提供）：

1. Seedream 与 Seedance 的 endpoint ID；
2. API key 文件路径（密钥本身不要发到聊天中）；
3. 当前账号实际支持的图片尺寸、Seedance 480p 参数、首尾帧/双参考图能力；
4. 单价、免费/已购额度、并发、QPS、日限额和失败是否计费；
5. 任务查询、回调、超时、取消与幂等语义的官方资料；
6. 本轮真实生成最高费用预算。

验收按费用逐级放行：

1. 正面与 45° 两张母图；
2. 自动睡姿母图；
3. 三个高风险视频（睡眠循环、醒来伸懒腰、打滚）；
4. 三项通过后才一次并行生成完整 7 视频。

任何阶段失败都先分析已有产物与日志，不自动无限重生成。用户支付后不要求用户追加充值；内部重试与人工补救必须受 SKU 成本上限约束。

## Gate 3：生产 COS 与保留策略

到达条件：本地媒体闭环和真实 ModelArk 小额验收通过。

届时需要：COS bucket/region/endpoint、专用最小权限 CAM 身份的密钥文件路径、生命周期规则、用户删除策略、审计保留期。先用固定测试前缀验证 PUT/HEAD/条件 GET，再验证真实工作流；不扩大到 bucket 全局删除权限。

## Gate 4：CloudBase 手机号登录生产复核

已有短信登录曾完成受控验收。重建版部署前只复核现有环境 ID、安全来源、验证码防刷/CAPTCHA、短信额度和服务端登录门。测试手机号由用户直接在网页输入，不发到聊天；只发 1 条验证码。

## Gate 5：生产发布与最低流量验收

到达条件：Gate 1–4 均通过，营业执照/经营主体、隐私政策、服务协议、退款规则和 SKU 已确定。

发布顺序：迁移备份演练 → 只读预检 → Studio API → outbox → 单 Worker → Web → 内部账号完整下单 → 监控确认 → 小比例开放。异常时先关闭购买和真实生成门，不回滚或删除用户数据。

## 安全约定

- 所有 secret 通过 `*_FILE` 或容器 secret 挂载；仓库只保留变量名和示例格式。
- 只给部署操作员“在哪里找、填到哪个安全文件、如何自检”的步骤，不询问、回显或代填 secret 内容。
- 未拿到官方协议的字段一律写入 `BLOCKED.md`，不会凭经验猜测。
- 每次真实付费调用前明确说明预计调用数、最高费用和停止条件。
