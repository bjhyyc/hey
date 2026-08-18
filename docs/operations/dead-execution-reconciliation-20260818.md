# 死执行对账记录：run 8783b68b（2026-08-18）

## 结论

线上唯一一条 `status=dead` 的执行记录属于 controlled-real 过渡 Worker 时期，**不是生产链路缺陷**，已按用户决定（方案 A）导出证据后清理，使监控回到干净基线。

## 事件档案

| 项目 | 值 |
|---|---|
| 执行 ID | `6f2421b5-b61b-43d8-a709-eb5905117de6` |
| 作业 | `petpack.validate-package` |
| run_id | `8783b68b-eabd-447f-99d9-cba49c245c91` |
| project_id | `34d6161a-90d8-4034-bf51-b3c1b3a410e6` |
| 错误码 | `petpack_validation_failed` |
| attempts | 1 / 3（确定性失败，不重试） |
| 发生时间 | 2026-08-17 16:11:34 UTC |
| 触发来源 | 客户订单 `34ca6742-3ad2-4adf-bb04-174c2b1fe6bd`，状态 `paid`，金额 1 分，支付于 2026-08-17 12:32:30 UTC |

## 成因

该 run 由当时线上运行的 **controlled-real 过渡 Worker** 执行。该镜像的交付验证器
（`controlled-real-worker-components.js` 中的 `createDeliveryValidator`）按设计恒返回
`ok: false`，并携带说明 "Electron runtime interaction smoke is deferred to the final
local client check"，同时标记 `productionAssured: false` / `releaseEligible: false`。

因此这条失败是**过渡镜像的既定行为**，而非生产视觉链路的缺陷。

## 该 run 的实际完成度

同 run 共 100 条执行记录，其中 **99 条成功**，仅最后的 `validate-package` 失败：

| 作业 | 结果 |
|---|---|
| generate/finalize front·side·sleep master | 各 1 条，全部成功 |
| generate-video-action | 7 条成功 |
| poll-video-action | 70 条成功 |
| process-video-action / finalize-video-action | 各 7 条成功 |
| process-media / build-package | 各 1 条成功 |
| validate-package | **1 条 dead** |

意义：**支付 → 生成 → 后处理 → 打包**整条链路已由这笔真实（1 分钱）订单验证跑通，
只在最终交付验证处按设计止步。Outbox 101 条记录全部 `sent`，无积压或死信。

## 为何不重跑该 run

该 run 的媒体证据等级为 `internal-controlled-real-staging`。生产 QA 门要求
`evidenceClass = production`，因此这些既有媒体在生产规则下不可复用；重跑等同于重新生成，
会产生新的供应商费用，且该订单本身是内部 1 分钱测试单，无外部客户等待交付。

## 处置

- 已导出同 run 全部 100 条执行记录：`dead-execution-run-8783b68b-executions.txt`
- 已删除该条 dead 记录，使 `check-operations-snapshot` 的 `execution_dead` 告警归零
- 保留：99 条成功执行、`production_run` 行（state=failed）、`customer_order` 行（status=paid）
  —— 历史与财务记录完整不变
