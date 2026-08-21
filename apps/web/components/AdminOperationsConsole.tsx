"use client";

import { useCallback, useEffect, useState } from "react";
import {
  studioAdminApi,
  type AdminOperationItem,
  type AdminOrderDetail,
  type AdminRescueStage,
  type AdminUserView,
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
  regenerations_exhausted: "重生成用完",
  delivery_expired: "下载已过期",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  pending_payment: "待支付",
  paid: "已支付",
  payment_review: "支付待核",
  expired: "已过期",
  refund_pending: "退款处理中",
  refunded: "已退款",
};

function orderStatusLabel(status?: string): string {
  if (!status) return "—";
  return ORDER_STATUS_LABELS[status] || status;
}

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

/**
 * What actually happens next differs per disposal - a rerun starts a
 * generation, a reissue only moves an expiry, a refund moves money - so the
 * confirmation has to say the right thing rather than always promising a
 * generation.
 */
function describeOutcome(mode?: string, runState?: string): string {
  if (mode === "qa_overridden" && runState === "awaiting_prompt_gate") {
    return "已放行，但七条动作提示词未全部发布；发布齐后运行会自动继续。";
  }
  switch (mode) {
    case "rerun_authorized":
      return "已授权重跑，生成需要几分钟，稍后刷新查看。";
    case "qa_overridden":
      return "已放行，该素材重新进入后续流程。";
    case "regeneration_granted":
      return "已补发一次重生成机会，客户页面上的按钮已恢复。";
    case "delivery_reissued":
      return "下载窗口已重开，可让客户重新进入项目页下载。";
    case "refund_requested":
      return "退款已提交渠道；交付已吊销、在途生成已停止，稍后点「查退款结果」确认。";
    default:
      return "已执行，稍后刷新查看最新状态。";
  }
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

/**
 * The account behind the order: read-only counters plus the disable/enable
 * lever for abusive accounts. Disabling revokes every live session, so the
 * lockout is immediate.
 */
function UserAccountPanel({ userId }: { userId: string }) {
  const [view, setView] = useState<AdminUserView | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<"disable" | "enable" | null>(null);
  const [busy, setBusy] = useState(false);

  // The reload after a disposal must not wipe the line that says what the
  // disposal did - "已封禁，吊销 N 个会话" is the only place that count appears.
  const load = useCallback((keepMessage = false) => {
    if (!keepMessage) setMessage("正在加载账号…");
    studioAdminApi.userView(userId)
      .then((result) => { setView(result); if (!keepMessage) setMessage(""); })
      .catch((error) => { setView(null); setMessage(errorMessage(error)); });
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  if (!view) {
    return <div className="console-user"><p className="form-message">{message}</p></div>;
  }
  const disabled = view.status === "disabled";
  return (
    <div className="console-user">
      <p className="form-message">
        账号 {view.id} · {disabled ? "已封禁" : "正常"} · 订单 {view.orderCount} 笔
        · 活跃会话 {view.activeSessions} · 24h 预检 {view.prechecks24h} 次
        · 注册于 {timeLabel(view.createdAt)}
      </p>
      {message ? <p className="form-message">{message}</p> : null}
      <div className="console-rescue-buttons">
        <button
          className="ghost-button console-override-button"
          disabled={busy}
          onClick={() => setPending(disabled ? "enable" : "disable")}
          type="button"
        >
          {disabled ? "解封账号" : "封禁账号（吊销全部会话）"}
        </button>
      </div>
      {pending ? (
        <DisposalForm
          busy={busy}
          onCancel={() => setPending(null)}
          onSubmit={(reason) => {
            setBusy(true);
            setMessage("");
            studioAdminApi.setUserStatus(userId, pending, reason)
              .then((result) => {
                setMessage(pending === "disable"
                  ? `已封禁，吊销 ${result.revokedSessions ?? 0} 个会话。`
                  : "已解封。");
                setPending(null);
                load(true);
              })
              .catch((error) => setMessage(errorMessage(error)))
              .finally(() => setBusy(false));
          }}
          title={pending === "disable" ? "封禁账号" : "解封账号"}
        />
      ) : null}
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
  const [showUser, setShowUser] = useState(false);

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
      .then((result) => {
        const outcomeResult = result as { mode?: string; run?: { state?: string } } | null;
        const state = outcomeResult?.run?.state;
        setOutcome(describeOutcome(outcomeResult?.mode, state));
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
  // A rejected candidate can be force-passed only for the stage the run died
  // in, and only while the order is still paid - the server re-validates both,
  // this only decides which buttons render.
  const orderEntitled = detail.order.status === "paid";
  const overridableMasterStage = (kind?: string): string | null => {
    if (!orderEntitled || run?.state !== "failed") return null;
    if ((kind === "front" || kind === "side") && detail.failedFromState === "awake_generating") return `${kind}_master`;
    if (kind === "sleep" && detail.failedFromState === "sleep_generating") return "sleep_master";
    return null;
  };
  const videoOverridesEnabled = orderEntitled && run?.state === "failed" && detail.failedFromState === "video_generating";
  const failedActionIds = new Set(detail.actions.filter((action) => action.state === "failed").map((action) => action.actionId));
  const overridableVideos = videoOverridesEnabled
    ? detail.rejectedActionVideos.filter((video) => video.actionId && failedActionIds.has(video.actionId))
    : [];
  const parseOverrideDisposal = (value: string) => {
    const rest = value.slice("override:".length);
    const separator = rest.lastIndexOf(":");
    return { stage: rest.slice(0, separator), candidateId: rest.slice(separator + 1) };
  };

  return (
    <section className="workflow-card console-detail">
      <header className="console-detail-header">
        <div>
          <h2>{detail.project.displayName || "未命名项目"}</h2>
          <p className="form-message">
            订单 {detail.order.id}（{amountLabel(detail.order.amountFen)} · {orderStatusLabel(detail.order.status)}）
            · 项目 {detail.project.id}
          </p>
        </div>
        <div className="console-rescue-buttons">
          {detail.order.userId ? (
            <button className="ghost-button" onClick={() => setShowUser((open) => !open)} type="button">
              {showUser ? "收起账号" : "查看账号"}
            </button>
          ) : null}
          <button className="ghost-button" onClick={load} type="button">刷新</button>
        </div>
      </header>
      {showUser && detail.order.userId ? <UserAccountPanel userId={detail.order.userId} /> : null}

      <div className="console-summary">
        <article>
          <small>生产状态</small>
          <strong>{runStateLabel(run?.state)}</strong>
          {run?.failureCode ? <span className="error-state">失败码：{run.failureCode}</span> : null}
          {run?.state === "failed" && detail.failedFromState
            ? <span>失败于：{runStateLabel(detail.failedFromState)}</span>
            : null}
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
                {entry.mode === "rerun" ? `重跑${stageLabel(entry.stage)}` : `补发「${stageLabel(entry.stage)}」重生成次数`}
              </button>
            ))}
          </div>
          {pendingDisposal && pendingDisposal !== "reissue" && !pendingDisposal.startsWith("override:") ? (
            <DisposalForm
              busy={busy}
              onCancel={() => setPendingDisposal(null)}
              onSubmit={runDisposal((reason) =>
                studioAdminApi.rerunStage(orderId, pendingDisposal.split(":").slice(1).join(":"), reason))}
              title={
                pendingDisposal.startsWith("rerun:")
                  ? `授权重跑：${stageLabel(pendingDisposal.slice("rerun:".length))}（补发一次生成）`
                  : `补发「${stageLabel(pendingDisposal.slice("grant:".length))}」重生成次数`
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

      {["paid", "refund_pending", "refunded"].includes(detail.order.status || "") ? (
        <div className="console-rescue console-refund">
          <h3>退款（最后手段）</h3>
          {detail.order.status === "refunded" ? (
            <p className="form-message">已全额退款。</p>
          ) : detail.order.status === "refund_pending" ? (
            <div className="console-rescue-buttons">
              <button
                className="ghost-button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setOutcome("");
                  studioAdminApi.refundOrder(orderId)
                    .then((result) => {
                      setOutcome(result.mode === "refund_confirmed"
                        ? "渠道确认退款已完成，订单已置为 refunded。"
                        : `渠道仍在处理退款（${result.providerState || "pending"}），稍后再查。`);
                      load();
                      onChanged();
                    })
                    .catch((error) => setOutcome(errorMessage(error)))
                    .finally(() => setBusy(false));
                }}
                type="button"
              >
                查退款结果
              </button>
            </div>
          ) : (
            <>
              <p className="form-message">全额退款；发起后交付立即吊销、在途生成停止，渠道确认后订单转 refunded。</p>
              <div className="console-rescue-buttons">
                <button
                  className="ghost-button console-refund-button"
                  disabled={busy}
                  onClick={() => setPendingDisposal("refund")}
                  type="button"
                >
                  申请全额退款
                </button>
              </div>
              {pendingDisposal === "refund" ? (
                <DisposalForm
                  busy={busy}
                  onCancel={() => setPendingDisposal(null)}
                  onSubmit={runDisposal((reason) => studioAdminApi.refundOrder(orderId, reason))}
                  title={`申请全额退款：${amountLabel(detail.order.amountFen)}`}
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {outcome ? <p className="form-message">{outcome}</p> : null}

      {detail.masters.length > 0 ? (
        <div className="console-media">
          <h3>母图尝试（共 {detail.masters.length} 张，未通过 {failedMasters.length} 张）</h3>
          <div className="console-media-grid">
            {detail.masters.map((attempt) => {
              const overrideStage = attempt.status === "qa_failed" ? overridableMasterStage(attempt.kind) : null;
              return (
                <figure className={attempt.status === "qa_passed" ? "" : "is-failed"} key={attempt.id}>
                  {attempt.previewUrl
                    ? <img alt={`${attempt.kind} #${attempt.generationAttempt}`} src={attempt.previewUrl} />
                    : <span className="console-media-missing">素材不可用</span>}
                  <figcaption>
                    {attempt.kind === "front" ? "正面" : attempt.kind === "side" ? "45°" : "睡姿"}
                    {" "}#{attempt.generationAttempt} · {attempt.status}
                    {attempt.qa?.reasons?.length ? <small>{attempt.qa.reasons.join("；")}</small> : null}
                  </figcaption>
                  {overrideStage && attempt.id ? (
                    <button
                      className="ghost-button console-override-button"
                      disabled={busy}
                      onClick={() => setPendingDisposal(`override:${overrideStage}:${attempt.id}`)}
                      type="button"
                    >
                      人工放行此张
                    </button>
                  ) : null}
                </figure>
              );
            })}
          </div>
        </div>
      ) : null}

      {overridableVideos.length > 0 ? (
        <div className="console-media">
          <h3>被拒视频（可人工放行）</h3>
          <p className="form-message">放行后该视频重新进入抠图与打包；质检照常测量并记录，但不再拦截。</p>
          <div className="console-rejected-videos">
            {overridableVideos.map((video) => (
              <article key={video.assetId}>
                <strong>{ACTION_LABELS[video.actionId || ""] || video.actionId} · {timeLabel(video.rejectedAt)}</strong>
                {video.previewUrl ? <video controls preload="metadata" src={video.previewUrl} /> : <span className="console-media-missing">素材不可用</span>}
                {video.qa?.reasons?.length ? <small>{video.qa.reasons.join("；")}</small> : null}
                <button
                  className="ghost-button console-override-button"
                  disabled={busy || !video.assetId}
                  onClick={() => setPendingDisposal(`override:action:${video.actionId}:${video.assetId}`)}
                  type="button"
                >
                  人工放行此条
                </button>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {pendingDisposal?.startsWith("override:") ? (
        <DisposalForm
          busy={busy}
          onCancel={() => setPendingDisposal(null)}
          onSubmit={runDisposal((reason) => {
            const { stage, candidateId } = parseOverrideDisposal(pendingDisposal);
            return studioAdminApi.qaOverride(orderId, stage, candidateId, reason);
          })}
          title={`人工放行：${stageLabel(parseOverrideDisposal(pendingDisposal).stage)}（质检记录保留，不再拦截）`}
        />
      ) : null}

      {detail.actions.length > 0 ? (
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
      ) : null}

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
