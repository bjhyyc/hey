# 死执行/队列失败基线对账（2026-09-03，全面开放前）

巡检报警 `execution_dead=11`、`queue_failed=5` 逐条归类完毕：**全部属于内部测试时代的
已终局订单，无一等待处置**。处置=把这组数字定为巡检基线（cron 传
`PETPACK_ALERT_EXECUTION_DEAD_COUNT=11`、`PETPACK_ALERT_QUEUE_FAILED_COUNT=5`），
新增才报警。不删行：`master_image_generation.job_id` 等外键引用执行行，删除会破坏证据链。

| 条数 | run | 错误码 | 归类 |
|---|---|---|---|
| 6 | `b55ebc0e`(08-18 首只真猫单) | action_qa_failed×3 / action_media_processing_failed / 23505×2 | hover 假绿修复期产生；该单最终已救援并交付 |
| 2 | `39306bda` / `a6a6f983`(08-19) | master_image_processing_failed | 内部测试单，run 已 failed 终局 |
| 1 | `22c67868`(08-20) | （无码） | 卡 13 天的内部测试单，09-03 已置 `internal_test_abandoned` |
| 2 | `23992985`(08-20 柯基) | action_qa_failed / production_evidence_provenance_invalid | 该单 09-03 已退款终局 |

queue_failed=5 为同时代 BullMQ 失败作业，随上述 run 终局，不重放。
