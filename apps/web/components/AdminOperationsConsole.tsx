"use client";

import { useCallback, useEffect, useState } from "react";
import {
  studioAdminApi,
  type AdminOperationItem,
  type AdminOrderDetail,
  type AdminRescueStage,
} from "@/lib/studio-admin-api";
import { StudioGatewayError } from "@/lib/studio-gateway-core";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTION_LABELS: Record<string, string> = {
  idle: "待机",
  sneeze: "打喷嚏",
  roll: "打滚",
  "sleep-transition": "入睡",
  "sleep-loop": "睡眠循环",
  stretch: "伸懒腰",
  "hover-attention": "悬停关注",
};

const STAGE_LABELS: Record<string, string> = {
  front_master: "正面母图",
  side_master: "45° 母图",
  sleep_master: "睡姿母图",
};

const RUN_STATE_LABELS: Record<string, string> = {
  awaiting_photos: "等待照片",
  awake_generating: "母图生成中",
  awaiting_character_confirmation: "等待客户确认形象",
  sleep_generating: "睡姿生成中",
  awaiting_prompt_gate: "等待提示词门",
  video_generating: "视频生成中",
  media_processing: "媒体处理中",
  packaging: "打包中",
  validating: "验证中",
  deliverable: "可交付",
  failed: "已失败",
};

const ATTENTION_LABELS: Record<string, string> = {
  payment_attention: "支付需人工",
  run_failed: "生产失败",
  run_failure_recorded: "有失败记录",
  action_failed: "动作失败",
  outbox_retrying: "队列重试中",
  outbox_dead: "队列死信",
};

function stageLabel(stage: string): string {
  if (stage.startsWith("action:")) {
    const actionId = stage.slice("action:".length);
    return `动作「${ACTION_LABELS[actionId] || actionId}」`;
  }
  return STAGE_LABELS[stage] || stage;
}

function runStateLabel(state?: string | null): string {
  if (!state) return "无生产运行";
  return RUN_STATE_LABELS[state] || state;
}

function timeLabel(value?: string | null): string {
  if (!value) return "—";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

function amountLabel(amountFen?: number): string {
  return Number.isSafeInteger(amountFen) ? `¥${((amountFen as number) / 100).toFixed(2)}` : "—";
}

function errorMessage(error: unknown): string {
  if (error instanceof StudioGatewayError) {
    if (error.status === 401) return "请先用管理员账号登录。";
    if (error.status === 403) return "当前账号没有管理员权限。";
    return error.message;
  }
  return "请求失败，请稍后再试。";
}

/**
 * One disposal form: every rescue action requires a written reason before the
 * confirm button does anything, and the reason lands in the audit trail.
 */
function DisposalForm({
  title,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  busy: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <div className="console-disposal">
      <strong>{title}</strong>
      <label className="field-label">
        处置原因（必填，写入审计）
        <textarea
          maxLength={200}
          onChange={(event) => setReason(event.target.value)}
          placeholder="例如：客户 8/20 来电，睡姿三次未过，人工复核后授权重跑一次"
          rows={2}
          value={reason}
        />
      </label>
      <div className="console-disposal-buttons">
        <button
          className="primary-button"
          disabled={busy || trimmed.length === 0}
          onClick={() => onSubmit(trimmed)}
          type="button"
        >
          {busy ? "执行中…" : "确认执行"}
        </button>
        <button className="ghost-button" disabled={busy} onClick={onCancel} type="button">
          取消
        </button>
      </div>
    </div>
  );
}

function OrderDetailPanel({
  orderId,
  onChanged,
}: {
  orderId: string;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [message, setMessage] = useState("正在加载订单详情…");
  const [pendingDisposal, setPendingDisposal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("");

  const load = useCallback(() => {
    setMessage("正在加载订单详情…");
    studioAdminApi.orderDetail(orderId)
      .then((result) => {
        setDetail(result);
        setMessage("");
      })
      .catch((error) => {
        setDetail(null);
        setMessage(errorMessage(error));
      });
  }, [orderId]);

  useEffect(() => {
    setOutcome("");
    setPendingDisposal(null);
    load();
  }, [load]);

  const runDisposal = (perform: (reason: string) => Promise<unknown>) => (reason: string) => {
    setBusy(true);
    setOutcome("");
    perform(reason)
      .then(() => {
        setOutcome("已执行。状态稍后刷新，生成需要几分钟。");
        setPendingDisposal(null);
        load();
        onChanged();
      })
      .catch((error) => setOutcome(errorMessage(error)))
      .finally(() => setBusy(false));
  };

  if (!detail) {
    return <section className="workflow-card"><p className="form-message">{message}</p></section>;
  }

  const run = detail.run;
  const rescue = detail.rescue;
  const failedMasters = detail.masters.filter((attempt) => attempt.status !== "qa_passed");

  return (
    <section className="workflow-card console-detail">
      <header className="console-detail-header">
        <div>
          <h2>{detail.project.displayName || "未命名项目"}</h2>
          <p className="form-message">
            订单 {detail.order.id}（{amountLabel(detail.order.amountFen)} · {detail.order.status || "—"}）
            · 项目 {detail.project.id}
          </p>
        </div>
        <button className="ghost-button" onClick={load} type="button">刷新</button>
      </header>

      <div className="console-summary">
        <article>
          <small>生产状态</small>
          <strong>{runStateLabel(run?.state)}</strong>
          {run?.failureCode ? <span className="error-state">失败码：{run.failureCode}</span> : null}
          {detail.failedFromState ? <span>失败于：{runStateLabel(detail.failedFromState)}</span> : null}
        </article>
        <article>
          <small>环节消耗</small>
          <span>正面 生成{run?.frontGenerationAttempts ?? 0}次 / 客户重生成{run?.frontUserRegenerationsUsed ?? 0}/2</span>
          <span>45° 生成{run?.sideGenerationAttempts ?? 0}次 / 客户重生成{run?.sideUserRegenerationsUsed ?? 0}/2</span>
          <span>睡姿 生成{run?.sleepGenerationAttempts ?? 0}次</span>
        </article>
        <article>
          <small>管理员重跑</small>
          <strong>{rescue.adminRerunCount} / {rescue.maxAdminRerunsPerOrder}</strong>
          {rescue.rerunBudgetExhausted ? <span className="error-state">重跑额度已用尽</span> : null}
          <span>队列：待发 {detail.dispatch.pending ?? 0} · 死信 {detail.dispatch.dead ?? 0}</span>
        </article>
      </div>

      {rescue.availableStages.length > 0 ? (
        <div className="console-rescue">
          <h3>可执行处置</h3>
          <div className="console-rescue-buttons">
            {rescue.availableStages.map((entry: AdminRescueStage) => (
              <button
                className="ghost-button"
                disabled={busy || (entry.mode === "rerun" && rescue.rerunBudgetExhausted)}
                key={entry.stage}
                onClick={() => setPendingDisposal(entry.mode === "rerun" ? `rerun:${entry.stage}` : `grant:${entry.stage}`)}
                type="button"
              >
                {entry.mode === "rerun" ? `重跑${stageLabel(entry.stage)}` : `补发${stageLabel(entry.stage)}重生成次数`}
              </button>
            ))}
          </div>
          {pendingDisposal && pendingDisposal !== "reissue" ? (
            <DisposalForm
              busy={busy}
              onCancel={() => setPendingDisposal(null)}
              onSubmit={runDisposal((reason) =>
                studioAdminApi.rerunStage(orderId, pendingDisposal.split(":").slice(1).join(":"), reason))}
              title={
                pendingDisposal.startsWith("rerun:")
                  ? `授权重跑：${stageLabel(pendingDisposal.slice("rerun:".length))}（补发一次生成）`
                  : `补发重生成次数：${stageLabel(pendingDisposal.slice("grant:".length))}`
              }
            />
          ) : null}
        </div>
      ) : null}

      {detail.delivery ? (
        <div className="console-rescue">
          <h3>交付</h3>
          <p className="form-message">
            状态 {detail.delivery.status || "—"} · 已下载 {detail.delivery.downloadCount ?? 0} 次
            · 过期时间 {timeLabel(detail.delivery.expiresAt)}
            {detail.delivery.assetRetained === true ? "" : " · 包体已不在保留期"}
          </p>
          <div className="console-rescue-buttons">
            <button
              className="ghost-button"
              disabled={busy || detail.delivery.assetRetained !== true}
              onClick={() => setPendingDisposal("reissue")}
              type="button"
            >
              重开下载窗口（72 小时）
            </button>
          </div>
          {pendingDisposal === "reissue" ? (
            <DisposalForm
              busy={busy}
              onCancel={() => setPendingDisposal(null)}
              onSubmit={runDisposal((reason) => studioAdminApi.reissueDelivery(orderId, reason))}
              title="重开下载窗口"
            />
          ) : null}
        </div>
      ) : null}

      {outcome ? <p className="form-message">{outcome}</p> : null}

      {detail.masters.length > 0 ? (
        <div className="console-media">
          <h3>母图尝试（共 {detail.masters.length} 张，未通过 {failedMasters.length} 张）</h3>
          <div className="console-media-grid">
            {detail.masters.map((attempt) => (
              <figure className={attempt.status === "qa_passed" ? "" : "is-failed"} key={attempt.id}>
                {attempt.previewUrl
                  ? <img alt={`${attempt.kind} #${attempt.generationAttempt}`} src={attempt.previewUrl} />
                  : <span className="console-media-missing">素材不可用</span>}
                <figcaption>
                  {attempt.kind === "front" ? "正面" : attempt.kind === "side" ? "45°" : "睡姿"}
                  {" "}#{attempt.generationAttempt} · {attempt.status}
                  {attempt.qa?.reasons?.length ? <small>{attempt.qa.reasons.join("；")}</small> : null}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      ) : null}

      <div className="console-actions-table">
        <h3>七个动作</h3>
        <ul>
          {detail.actions.map((action) => (
            <li className={action.state === "failed" ? "is-failed" : ""} key={action.actionId}>
              <strong>{ACTION_LABELS[action.actionId || ""] || action.actionId}</strong>
              <span>{action.state}{(action.retryCount ?? 0) > 0 ? ` · 已重试 ${action.retryCount}` : ""}</span>
              {action.qa?.reasons?.length ? <small>{action.qa.reasons.join("；")}</small> : null}
              {action.previewUrl ? (
                <video controls preload="metadata" src={action.previewUrl} />
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="console-timeline">
        <h3>时间线</h3>
        <ul>
          {detail.timeline.slice(0, 30).map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <span className="console-timeline-time">{timeLabel(entry.at)}</span>
              <span className={`console-timeline-source is-${entry.source || "run"}`}>
                {entry.source === "payment" ? "支付" : entry.source === "admin" ? "处置" : "生产"}
              </span>
              <span>{entry.label}{entry.detail ? `（${entry.detail}）` : ""}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function AdminOperationsConsole() {
  const [items, setItems] = useState<AdminOperationItem[]>([]);
  const [feedMessage, setFeedMessage] = useState("正在加载需关注订单…");
  const [query, setQuery] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const loadFeed = useCallback(() => {
    studioAdminApi.attentionFeed()
      .then((result) => {
        setItems(result.items);
        setFeedMessage(result.items.length ? "" : "当前没有需要关注的订单。");
      })
      .catch((error) => setFeedMessage(errorMessage(error)));
  }, []);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  const search = () => {
    const value = query.trim();
    if (!UUID_PATTERN.test(value)) {
      setFeedMessage("请输入完整的订单 ID 或项目 ID（UUID）。");
      return;
    }
    setFeedMessage("正在检索…");
    // An agent gets one ID read to them over the phone without knowing which
    // kind it is; try it as an order first, then as a project.
    studioAdminApi.searchByOrderId(value)
      .then((result) => (result.items.length > 0 ? result : studioAdminApi.searchByProjectId(value)))
      .then((result) => {
        setItems(result.items);
        setFeedMessage(result.items.length ? "" : "没有找到匹配的订单。");
        if (result.items.length === 1 && result.items[0].order.id) {
          setSelectedOrderId(result.items[0].order.id);
        }
      })
      .catch((error) => setFeedMessage(errorMessage(error)));
  };

  return (
    <div className="console-layout">
      <section className="workflow-card">
        <div className="console-search">
          <label className="field-label">
            订单 ID / 项目 ID
            <input
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") search(); }}
              placeholder="可让客户复制项目页网址，网址末段即项目 ID"
              value={query}
            />
          </label>
          <button className="primary-button" onClick={search} type="button">检索</button>
          <button className="ghost-button" onClick={() => { setQuery(""); setSelectedOrderId(null); loadFeed(); }} type="button">
            需关注列表
          </button>
        </div>
        {feedMessage ? <p className="form-message">{feedMessage}</p> : null}
        <ul className="console-order-list">
          {items.map((item) => (
            <li className={item.order.id === selectedOrderId ? "is-selected" : ""} key={item.order.id}>
              <button onClick={() => item.order.id && setSelectedOrderId(item.order.id)} type="button">
                <strong>{amountLabel(item.order.amountFen)} · {runStateLabel(item.run?.state)}</strong>
                <span>{item.order.id}</span>
                <span className="console-order-meta">
                  {timeLabel(item.lastActivityAt)}
                  {item.attention.reasons.map((reason) => (
                    <em key={reason}>{ATTENTION_LABELS[reason] || reason}</em>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {selectedOrderId ? (
        <OrderDetailPanel key={selectedOrderId} onChanged={loadFeed} orderId={selectedOrderId} />
      ) : (
        <section className="workflow-card">
          <p className="empty-state">从左侧选择订单，或输入 ID 检索。</p>
        </section>
      )}
    </div>
  );
}
