# 客服/管理处置台设计（Admin Support Console）

状态：P1（2026-08-20）、P2 人工放行（2026-08-21）、P3 退款/封禁/节流
（2026-08-21）均已实现，未部署。

## 0c. P3 实现要点（2026-08-21）

1. **退款单端点、暗启动**：`POST /api/admin/orders/:orderId/refund`，行为随
   订单状态：`paid` + 必填 reason = 发起全额退款；`refund_pending`（reason
   可省）= 主动查单并在渠道确认 REFUNDED 时收敛到 `refunded`——普通支付对账
   **刻意冻结**退款状态（`markOrderPaymentState`），这个轮询是唯一前进路径；
   `refunded` = 报告已完成。退款行 ID 即渠道 `refundRequestNo`（幂等键
   `admin-refund:<orderId>` 保证每单只有一行），重试重复同一渠道请求而非开新
   退款。发起成功副作用（单事务）：订单 `paid→refund_pending`、delivery 全部
   `revoked`、在途 run 置 `failed(order_refunded)` 停止烧钱（deliverable 保留
   为历史）。**默认关闭**：`PETPACK_ADMIN_REFUND_ENABLED=true` 才启用，未开
   时接口 503 `admin_refund_disabled`——对应 BLOCKED.md 的受控真实退款验收门。
2. **账号处置**：`GET /api/admin/users/:userId`（状态、订单数、活跃会话、
   24h 预检次数、近 10 单）；`POST /api/admin/users/:userId/disable|enable`
   （必填 reason）。封禁 = `app_user.status='disabled'`（会话解析层既有拦截）
   + 同事务吊销全部活跃会话立即生效 + audit_event。`role='user'` 写死在
   UPDATE 的 WHERE：管理员账号在仓储层就不可封禁；服务层另拒自我处置。
   入口 = 订单详情的 userId（无手机号检索，见 §0 第 3 条）。
3. **应用层节流**：`request-rate-limiter.js` 每 IP 固定 60s 窗口两档——
   全 API 默认 300 req/min，付款前可滥用面（`POST /api/auth/*`、
   `/api/photo-precheck` 免费视觉模型调用、`/api/checkout`）默认 12 req/min；
   超限 429 + retry-after。健康探针与 Kaipay 回调豁免（限流支付渠道通知
   只会伤害支付收敛）。客户端 IP 仅在生产（Caddy 为唯一入口的内网）信任
   `x-forwarded-for` 首项。开关与阈值：`PETPACK_HTTP_RATE_LIMIT_ENABLED`
   （默认开）、`PETPACK_HTTP_RATE_LIMIT_RPM`、
   `PETPACK_HTTP_RATE_LIMIT_SENSITIVE_RPM`。
4. **边缘**：Caddyfile 补 stock 指令 `request_body max_size 16MB`（合同测试
   锁定）。真正的容量型 DDoS 防护仍需 xcaddy rate-limit 插件构建或前置
   腾讯云 CDN/WAF——stock Caddy 没有限速指令，此项保持在 §5.3 作为部署侧
   待办，不阻塞本阶段。

## 0b. P2 人工放行实现要点（2026-08-21）

`POST /api/admin/orders/:orderId/qa-override`，body `{stage, candidateId, reason}`。
`candidateId`：母图/睡姿 = `master_image_generation.id`；视频 = 被拒 provider
视频的 `media_asset.id`。详情接口新增 `rejectedActionVideos`（每条被拒视频的
签名预览 + 拒绝原因），母图未通过尝试沿用原有 `masters` 列表。

1. **母图（front/side）= 纯数据晋升，零重处理**。QA 失败时
   `saveMasterResult` 本来就把归一化资产、`image_candidate(qa_status='failed')`
   与失败报告全部落库。放行 = 写一条**新的** passed `qa_report`（report 含
   `adminOverride{actorId, reason, overriddenQaReportId}`，绑定字段逐项复制
   generation 行，因为客户确认 claim 会重新校验全链一致）→ 候选与 generation
   同步晋升 → run `failed → awaiting_character_confirmation`。**客户自己确认**。
   特例：front 放行发生在 side 从未生成时，镜像 `characterMasterGenerated`：
   run 回 `awake_generating` 并入队 side 生成。
2. **睡姿 = 管理员终审**。同样晋升 + `character_revision.sleep_candidate_id`
   绑定 + 存 prompt-gate 三张 master frame，run `failed → awaiting_prompt_gate`
   单事务提交；随后走既有 `resumeAwaitingPromptGate` 放七个视频动作。若有
   提示词未发布，run 停在 prompt gate 可恢复，接口返回的 state 说明这一点。
3. **视频 = 带标记重入处理**。被拒视频没有处理产物（QA 在上传前抛错），
   放行把选中 provider 原片重设为 action 的 source（迁移 021 新列
   `generation_action.admin_qa_override JSONB` 持久化授权），重新入队
   `process-video-action`。抠图/归一化/QA 全程照跑、证据与 provenance 全真，
   仅门禁判定被翻转：`applyAdminQaOverride` 保留全部测量字段与 provenance，
   `ok` 翻 true，`adminOverride.measuredOk=false + measuredErrors` 记录实测。
   标记被恰好一次处理消费：完成、QA-retry 重置、admin rerun 重置三处都清空。
   改动全在平台层（media-worker.js / worker 仓储 / claim），**四个生产组件
   未动，manifest SHA 不变**，但需要重建 Worker 镜像部署。
4. **候选归属校验**：视频候选必须有该 action 的 failed `qa_report`
   （source_media_asset_id 指向它）才可选，防止放行别的 run/action 的素材。
5. **已知边界**：放行后的视频仍要过打包与交付验证层（chroma parity、
   evidence 门）。一条画质确实不行的视频可能在 `validating` 再次失败——
   该阶段无重跑入口，届时走退款。原拒绝报告永不改写。

## 0. P1 实现与设计稿的偏差（以代码为准）

1. **重跑不加预算列，零迁移**：`extraAttempts` 概念取消。授权重跑 =
   精确补发一次生成（`adminRerunProductionRun`，attempts 计数 +1 保证
   revision/dedupe 唯一，QA retry 计数不动）。granted 生成再失败经既有
   耗尽路径回到 `failed`，再救需再次授权；每单上限 6 次（service 内常量，
   以 `audit_event` 计数实施），§4.1 的 grants 列方案作废。
2. **环节校验依据失败前状态**：不按失败码枚举，而查
   `production_run_event.previous_state`（最近一次 `next_state='failed'`），
   所以 `master_image_attempts_exhausted`、provider 错误等失败码同样可救。
3. **手机号检索不做**（迁移 010：手机号连哈希都不落库，CloudBase 只回
   opaque subject）。检索入口 = 客户从前端读出的订单/项目 ID。§3.1 相应作废；
   如未来要做，需反转该隐私决策并让存量用户重新登录一次，单独立项。
4. **软卡补发与重跑共用一个端点**：`POST …/rerun` 携带 `front_master|side_master`
   且 run 处于 `awaiting_character_confirmation` 时自动分流为
   `adminGrantCharacterRegeneration`（used 计数减一，`characterRegenerationAbandoned`
   同款机制），不入队任何 job。
5. **action 重跑事务**：store 新增 `commitAdminActionRerun`，run 转移 +
   generation_action 重置（镜像 `requeueVideoActionAfterQaFailure` 的字段清单，
   retry_count+1 供 dedupe）+ outbox 作业同事务提交。
6. 交付重开固定 72 小时、fail-closed（包体资产出保留期即拒绝）；
   审计事件名为 `admin_rerun_granted` / `admin_regeneration_granted` /
   `admin_delivery_reissued`（下划线风格，对齐既有 `petpack_download_granted`）。

## 1. 要解决的问题

生产链路各环节的重试预算耗尽后订单会终止在 `production_run.state='failed'`，
客户即使联系到客服，客服也没有任何工具定位订单、查看卡点、放行或补救。
本设计覆盖：订单检索与详情、管理员授权补救（重跑 / 人工放行 / 补发）、退款、
用户处置（封禁）与防滥用。原则：**退款是最后手段，先救单**。

### 1.1 卡单的全部形态（以现有代码为准）

| 形态 | 识别方式 | 现状 | 代码出处 |
|---|---|---|---|
| 清醒母图 QA 耗尽 | `failure_code = front_master_qa_failed / side_master_qa_failed` | run failed，无救济 | `production-workflow.js` `characterMasterQaFailed`（内部重试上限 `maxCharacterMasterQaRetries=2`） |
| 用户重生成用完仍不满意 | run 停在 `awaiting_character_confirmation`，`*_user_regenerations_used = 2` | 接口报 `character_regeneration_limit_reached`，软卡 | `production-state-machine.js` `MAX_USER_REGENERATIONS_PER_VIEW=2` |
| 睡姿母图 QA 耗尽 | `failure_code = sleep_master_qa_failed` | run failed，客户全程无参与 | `production-workflow.js` `sleepMasterQaFailed`（`maxSleepMasterRetries`） |
| 动作视频 QA 耗尽 | `failure_code = action_qa_failed`，`generation_action.state='failed'` | run failed | `production-job-worker.js`（`maxActionQaRetries=2`） |
| 支付对不上 | 订单 `payment_review` | ops feed 有 attention 标记，无处置 | `payment-state-machine.js` |
| 队列死信 | outbox `dead` / `production_job_execution` dead | ops feed 有计数，无处置 | sql 020 |

### 1.2 已有的零件（不重造）

- 失败素材**已留存**：母图每次尝试在 `master_image_generation` 一行
  （`qa_failed` 状态 + `provider_output_asset_id`/`normalized_media_asset_id` + `qa_report_id`）；
  视频失败原片保留为 `media_asset.kind='provider_output'`，QA 报告在 `qa_report`。
- 私有对象签名 URL：`objectStore.createDownloadGrant`（用户侧候选图已在用）。
- 管理员越权读用户接口：`requireProjectOwner` 对 admin 放行（authorization.js），
  admin 可直接代客调 `getProjectView` / `createPetpackDownload`。
- 退款渠道：Kaipay V3 `refund` 已实现（`kaipay-v3.js`、`kaipay-payment-provider.js`，
  幂等 + payment_event 落库），`refund` 表、`refund_pending/refunded` 状态齐备，
  **缺业务层调用与路由**。EPay V1 无退款协议，保持 fail-closed。
- 封禁开关：`app_user.status='disabled'` 在会话解析已生效，缺写入接口。
- `audit_event` 表已建，缺写入方。
- 只读 ops feed：`GET /api/admin/operations`（attention 原因、脱敏视图）。

## 2. 权限与审计（所有模块的前置）

- 角色沿用 `user/admin` 两档。团队规模不需要单独客服角色；
  若日后引入外聘客服，再加 `support`（可看可重跑，不可退款/封号），升级路径预留：
  `authorization.js` 加 `requireSupport`，退款/封号路由继续 `requireAdmin`。
- **每个处置接口必填 `reason`（1–200 字）**，连同 actor、目标、参数写入 `audit_event`
  （`event_type` 前缀 `admin.`，如 `admin.rerun_granted`、`admin.qa_override`、
  `admin.refund_requested`、`admin.user_disabled`）。
- 所有处置接口幂等（客户端生成 `idempotencyKey`，或以目标状态自然幂等），
  写操作全部走 run 乐观锁 `version`。
- 管理员提升仍只允许直连 DB 改 `role`，不做接口（防止横向提权面）。

## 3. 模块 A：订单检索与详情（客服工作台）

### 3.1 检索 `GET /api/admin/orders`

现有 ops feed 刻意不含任何可检索标识，客服拿着客户口述的信息找不到单。新增：

- 参数（任选其一）：
  - `orderId` / `projectId`（客户可从前端项目页读出，前端补充展示短码）；
  - `phone`：服务端用与登录相同的哈希算法转 `phone_hash` 查 `app_user`，
    再列该用户全部订单。**明文手机号不落库不落日志**，仅在请求内存中存活；
  - `status`（复用 ops feed 的 attention 过滤）。
- 返回：订单 id、金额、支付状态、项目状态、run 状态与 `failure_code`、
  attention 原因、创建/更新时间。仍不返回手机号（库里本来只有 hash）。

### 3.2 详情 `GET /api/admin/orders/:orderId`

一屏看懂"卡在哪、还剩什么可救"：

- **时间线**：`payment_event` + `production_run_event` + `audit_event` 按时间合并。
- **各环节消耗**：front/side/sleep 的 `*_generation_attempts`、`*_qa_retries`、
  `*_user_regenerations_used`；七动作各自 `state` + `retry_count`。
- **失败候选清单**（放行的入口）：
  - 母图：该 run 全部 `master_image_generation` 行（含 `qa_failed`），
    每行给 `createDownloadGrant` 短时签名 URL + QA 报告摘要（失败原因字段）；
  - 视频：失败 action 的历次 `provider_output` 资产签名 URL + `qa_report.report` 摘要。
- **成本已花**：`provider_usage_attempt/event` 汇总（admin-cost-service 已有数据源）。
- **交付状态**：delivery 状态、下载次数、过期时间。

## 4. 模块 B：处置动作

### 4.1 授权重跑 `POST /api/admin/orders/:orderId/rerun`

参数：`stage`（`front_master|side_master|sleep_master|action:<actionId>`）、
`extraAttempts`（默认 1，上限 3）、`reason`、`idempotencyKey`。

- 状态机新增管理员迁移 `adminRerunAuthorized`：`failed` → 对应生成态
  （`awake_generating` / `sleep_generating` / `video_generating`），清 `failure_code`，
  重置该环节 QA retry 计数为负预算（即额外给 `extraAttempts` 次），入队对应 job
  （复用 `createWorkflowJob`，`inputRevision` 带 `admin-rerun-<n>` 保证 outbox 去重键唯一）。
- 对"软卡"（用户重生成用完）：`stage=front_master|side_master` 且 run 在
  `awaiting_character_confirmation` 时，等价于把 `*_user_regenerations_used` 减 1
  （复用 `characterRegenerationRequested` 语义），用户侧界面立即恢复"重新生成"按钮。
- **成本护栏**：每单管理员重跑走 `provider_usage_attempt` 同一记账；
  每单累计 admin 重跑次数上限（建议 6 次）写死在 service，超过必须走退款或直连 DB。

### 4.2 人工放行（QA override）`POST /api/admin/orders/:orderId/qa-override`

参数：`stage`、`candidateId`（母图为 `master_image_generation.id`，
视频为失败 attempt 的 `media_asset.id`）、`reason`、`idempotencyKey`。

三条路径，机制统一为：**不篡改原 QA 报告**，新写一条 `qa_report`
（`report` 内含 `override: {actorId, reason, overriddenReportId}`，status `passed`），
再驱动状态机走原本的 passed 路径：

1. **清醒母图**：把选中行的产物晋升为 `image_candidate`（`qa_status='passed'`，
   挂 override 报告），run `failed` → `awaiting_character_confirmation`
   （新增迁移 `adminQaOverridden`）。**客户自己确认**——放行只是让图重新出现在
   客户的候选列表，不代替客户拍板。
2. **睡姿母图**：客户本来不参与睡姿挑选，管理员选中即终审：
   晋升候选后直接走 `sleepMasterQaPassed` 进 `awaiting_prompt_gate`。
3. **动作视频**：QA 失败发生在处理阶段，处理产物未必已上传。放行 =
   以 `qaOverride` 标志重新入队该 action 的 `process-video-action`（指定选中的
   provider_output 资产），worker 照常处理、照常跑 QA 并记录结果，
   但 override 标志下 QA 不阻断，产物直接进入 `processed`。
   action 全部齐后 `videosGenerated` 正常推进。
   （worker 侧改动点：`production-job-worker.js` QA 失败分支识别 override 标志。）

### 4.3 交付补救 `POST /api/admin/orders/:orderId/delivery/reissue`

- delivery 已过期（`PetPack delivery has expired`）或客户丢链接：
  重开 delivery 窗口（重置 `expires_at`），审计落库。
  未过期时 admin 本就可代客调 `createPetpackDownload`，此接口只处理过期重开。

### 4.4 退款 `POST /api/admin/orders/:orderId/refund`（仅 admin）

- 前置：订单 `paid`；全额（`amountFen` 必须等于订单金额，不做部分退款）；
  `reason` 必填。
- 流程：写 `refund` 表（唯一 `idempotency_key` + 唯一 `refundRequestNo`）→
  调 `paymentProvider.refund`（V3 已冻结 credential version）→
  订单 → `refund_pending` → 由既有查单/webhook 收敛到 `refunded`。
- 退款成功副作用：delivery → `revoked`（枚举已有），run 若在途标记 failed，
  资产进入保留期清理（`retention_hold` 机制已有）。
- **上线前置**（BLOCKED.md 既有条目）：一笔受控真实退款验收后才开放按钮。

## 5. 模块 C：用户管理

### 5.1 检索 `GET /api/admin/users`

- 按 `phone`（哈希后查）或 `userId`。返回：id、role、status、注册时间、
  订单数、近 24h precheck 次数、活跃会话数。**无手机号明文可返回**。

### 5.2 处置

- `POST /api/admin/users/:userId/disable` / `enable`：改 `app_user.status`，
  disable 同时吊销全部 `auth_session`（`revoked_at = now()`）。
  会话解析已检查 status，无需改认证代码。禁止对 admin 自身/其他 admin 操作。
- 附带审计与 `reason`。

### 5.3 防滥用边界（诚实说明）

封号解决的是**恶意消耗**（precheck 免费打视觉模型、反复上传），
不是网络层 DDoS。分三层：

1. **边缘**：Caddyfile 目前零限速。加 `rate_limit`（caddy 插件）或前置腾讯云 CDN/WAF：
   `/api/*` 每 IP 每分钟上限；`/api/auth/*` 与 precheck 更严。此为真正的 DDoS 答案。
2. **应用层**：precheck 已有全局 `precheckDailyLimit=8`/user/day；
   补 per-user 上传授权（upload-grant）与登录短信的日配额；超限返回 429 并计数。
3. **处置层**：配额超限次数进入 users 检索的排序依据，人工判断后封号。

## 6. 前端（apps/web）

- `/admin/operations` 从占位页接通：attention 列表（现有 feed）+ 检索框 →
  订单详情页（时间线、环节消耗、失败候选图/视频预览、处置按钮）。
- 处置按钮全部二次确认 + 必填 reason；退款按钮独立醒目、放最后。
- `/admin/users`：新页，检索 + disable/enable。
- 媒体预览用短时签名 URL（现有 grant 机制，TTL ≤ 10 分钟）。

## 7. 新增数据面（迁移 021）

- `production_run` 增列：`admin_rerun_count INTEGER NOT NULL DEFAULT 0`。
- `qa_report.report` JSONB 内约定 `override` 结构（不加列）。
- `refund` 表补 `requested_by UUID REFERENCES app_user(id)`。
- 复用 `audit_event`，无新表。
- （若做 per-user 配额）`user_quota_counter(user_id, kind, day, used)`。

## 8. 路由清单（挂进 petpack-studio-http-api.js）

```
GET  /api/admin/orders                     检索（admin）
GET  /api/admin/orders/:orderId            详情+失败候选（admin）
POST /api/admin/orders/:orderId/rerun      授权重跑（admin）
POST /api/admin/orders/:orderId/qa-override 人工放行（admin）
POST /api/admin/orders/:orderId/delivery/reissue 交付重开（admin）
POST /api/admin/orders/:orderId/refund     退款（admin）
GET  /api/admin/users                      用户检索（admin）
POST /api/admin/users/:userId/disable      封禁（admin）
POST /api/admin/users/:userId/enable       解封（admin）
```

Caddy `@studio` 已放行 `/api/admin/*`，边缘无需改动（限速除外）。

## 9. 分期

- **P1 客服能干活（✅ 2026-08-20 完成，见 §0 偏差说明）**：orders 检索+详情
  （含失败候选签名 URL）、rerun、软卡补重生成、delivery reissue、
  audit_event 写入、operations 前端接通。测试：
  `tests/platform/admin-order-rescue.test.js`。
- **P2 人工放行（✅ 2026-08-21 完成，见 §0b）**：qa-override 三条路径 +
  worker override 标志 + 前端候选挑选 UI。测试：
  `tests/platform/admin-qa-override.test.js`。
- **P3 退款与用户处置（✅ 2026-08-21 完成，见 §0c）**：refund service
  （暗启动待受控真实退款验收）、users 视图/封禁、应用层节流 + 边缘请求体上限。
  测试：`tests/platform/admin-refund-users-throttle.test.js`。
  部署侧仍欠：边缘容量型限速（xcaddy 插件或 WAF）、per-user 配额列。

## 10. 开放问题

1. 处置后如何通知客户？现无短信/站内信渠道；P1 先靠客户自行刷新项目页，
   通知渠道单独立项。
2. 视频 override 重处理若因非 QA 原因（解码错误）失败，是否自动降级为 rerun？
   建议是，并在审计里记录降级。
3. `support` 角色何时引入：出现非 owner 客服时。
