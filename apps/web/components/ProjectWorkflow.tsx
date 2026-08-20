"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { studioBrowserApi, type ProjectView } from "@/lib/studio-browser-api";

/**
 * The master is what the customer is being asked to approve, and the card shows
 * it at a size chosen for the page rather than for judging a face. Opening it
 * full screen - and again at double size - is how they check the markings
 * before spending a regeneration or committing the order.
 */
function MasterLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [magnified, setMagnified] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const previousOverflow = document.body.style.overflow;
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div aria-label={alt} aria-modal="true" className="master-lightbox" onClick={onClose} role="dialog">
      <div
        className={magnified ? "master-lightbox-frame is-magnified" : "master-lightbox-frame"}
        onClick={(event) => event.stopPropagation()}
      >
        <img alt={alt} onClick={() => setMagnified((value) => !value)} src={src} />
      </div>
      <button aria-label="关闭" className="master-lightbox-close" onClick={onClose} type="button">✕</button>
      <p className="master-lightbox-hint">{magnified ? "点击图片缩小 · Esc 关闭" : "点击图片放大 · Esc 关闭"}</p>
    </div>
  );
}

function Candidate({ candidate, label, onRegenerate, busy, selectedId, onSelect }: {
  candidate: ProjectView["characterCandidates"]["front"];
  label: string;
  onRegenerate: () => void;
  busy: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const attempts = candidate?.attempts ?? [];
  const chosen = attempts.find((attempt) => attempt.id === selectedId) ?? null;
  const previewUrl = chosen?.previewUrl ?? candidate?.previewUrl;
  return <article className="candidate-card">
    <div className="candidate-preview">
      {previewUrl ? (
        <button
          aria-label={`放大查看${label}母图`}
          className="candidate-preview-open"
          onClick={() => setZoomed(true)}
          type="button"
        >
          <img alt={`${label}母图`} src={previewUrl} />
        </button>
      ) : <span>正在生成 {label}</span>}
    </div>
    {zoomed && previewUrl
      ? <MasterLightbox alt={`${label}母图`} onClose={() => setZoomed(false)} src={previewUrl} />
      : null}
    {/* Regenerating replaces the picture on screen but keeps every earlier
        version on record, so once there is more than one, let the customer
        keep whichever is best rather than whichever came last. */}
    {attempts.length > 1 ? (
      <div className="candidate-attempts" role="radiogroup" aria-label={`选择${label}母图版本`}>
        {attempts.map((attempt) => {
          const active = (selectedId ?? candidate?.id) === attempt.id;
          return (
            <button
              aria-checked={active}
              className={active ? "is-active" : undefined}
              disabled={busy}
              key={attempt.id}
              onClick={() => onSelect(attempt.id)}
              role="radio"
              type="button"
            >
              <img alt={`${label}第 ${attempt.generationAttempt} 版`} src={attempt.previewUrl} />
              <span>第 {attempt.generationAttempt} 版</span>
            </button>
          );
        })}
      </div>
    ) : null}
    <footer><span><strong>{label}</strong><small>{candidate ? `还可重生成 ${candidate.remainingRegenerations} 次` : "请稍候"}</small></span>
      <button disabled={!candidate?.canRegenerate || busy} onClick={onRegenerate} type="button">重新生成</button></footer>
  </article>;
}

export function ProjectWorkflow({ projectId, mode }: { projectId: string; mode: "character" | "progress" | "delivery" }) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [message, setMessage] = useState("正在读取项目…");
  const [busy, setBusy] = useState(false);
  // Which version of each master the customer wants; null means the latest.
  const [chosenFront, setChosenFront] = useState<string | null>(null);
  const [chosenSide, setChosenSide] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await studioBrowserApi.project(projectId);
      setView(result);
      setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法读取项目"); }
  }, [projectId]);

  // The character page also waits on the worker: it opens while the masters are
  // still generating, so it has to refresh until both candidates arrive or the
  // run gives up. Without this it showed "正在生成 正面" forever, including
  // after the run had already failed.
  // Polling used to stop as soon as both candidates existed, but a regeneration
  // leaves the previous pair in place while the run goes back to generating -
  // so the page froze with a disabled confirm button until someone reloaded by
  // hand. Stop only once the customer can actually act.
  const settled = Boolean(view && (view.failed
    || (mode === "character" && view.characterCandidates.canConfirm)));

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (mode === "delivery" || settled) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load, mode, settled]);

  if (!view) return <p className="empty-state">{message}</p>;
  if (view.failed) {
    // The only way out of a failed project, so it reads as a control rather
    // than as one more line of the explanation around it.
    return <section className="workflow-card failed-card">
      <h3>制作没有完成</h3>
      <p>这个项目在生成阶段中断了，照片和订单都已保留。请联系我们处理，不要重复下单。</p>
      <Link className="ghost-button" href="/projects">返回项目列表</Link>
    </section>;
  }
  if (mode === "character") {
    const { front, side, canConfirm } = view.characterCandidates;
    return <section className="workflow-card">
      {/* At this step the photographs are already in; advice about how to
          shoot them only creates doubt the customer cannot act on. Tell them
          what to look at, and what each control does. */}
      <div className="workflow-notice">
        <p><strong>看这两张像不像你的宠物</strong>：五官、毛色、花色位置。七个动作都会照着它们生成。</p>
        <p>AI 是依据你的照片重新绘制，会尽量贴近，但不是照片复刻。不满意可以单独重新生成某一张。</p>
      </div>
      {front && side && !canConfirm
        ? <p className="regenerating-note">正在重新生成，通常 1~2 分钟；完成后这里会自动更新。</p>
        : null}
      <div className="candidate-grid">
        <Candidate candidate={front} label="正面" busy={busy} selectedId={chosenFront} onSelect={setChosenFront} onRegenerate={() => void (async () => {
          setBusy(true); setChosenFront(null); try { await studioBrowserApi.regenerateCharacter(projectId, "front"); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : "重生成失败"); } finally { setBusy(false); }
        })()} />
        <Candidate candidate={side} label="侧面" busy={busy} selectedId={chosenSide} onSelect={setChosenSide} onRegenerate={() => void (async () => {
          setBusy(true); setChosenSide(null); try { await studioBrowserApi.regenerateCharacter(projectId, "side"); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : "重生成失败"); } finally { setBusy(false); }
        })()} />
      </div>
      <button className="primary-button form-submit" disabled={!canConfirm || !front || !side || busy} onClick={() => void (async () => {
        if (!front || !side) return;
        setBusy(true);
        try {
          await studioBrowserApi.confirmCharacter(projectId, chosenFront ?? front.id, chosenSide ?? side.id);
          window.location.assign(`/projects/${encodeURIComponent(projectId)}/progress`);
        } catch (error) { setMessage(error instanceof Error ? error.message : "确认失败"); setBusy(false); }
      })()} type="button">{busy ? "正在确认…" : "就用这个形象，开始制作"}</button>
      <p className="form-message">{message || "点击即表示你认可这个形象；七个动作将照此生成，中途无法更换"}</p>
    </section>;
  }
  if (mode === "delivery") {
    return <section className="workflow-card delivery-card">
      {view.downloadReady ? <>
      <ol className="instruction-list compact-list">
        <li><span>1</span>下载 <code>.petpack</code> 文件</li>
        <li><span>2</span>安装并打开桌宠客户端</li>
        <li><span>3</span>点击「导入我的 PetPack」，选择刚下载的文件</li>
      </ol>
      <div className="workflow-notice">
        <p>下载链接短时有效，过期后回到本页重新点击即可，不会额外收费。</p>
      </div>
      <p>PetPack 已完成兼容验证，可以下载。</p>
      {/* Both downloads sit on one line: the client is needed before the pack
          is of any use, so it comes first, at a quieter weight. */}
      <div className="action-row">
        <Link className="ghost-button" href="/download-client" target="_blank">下载客户端</Link>
        <button className="primary-button" disabled={busy} onClick={() => void (async () => {
          setBusy(true); try { const result = await studioBrowserApi.createDownload(projectId); window.location.assign(result.downloadUrl); } catch (e) { setMessage(e instanceof Error ? e.message : "下载暂不可用"); setBusy(false); }
        })()} type="button">{busy ? "正在准备…" : "下载 PetPack"}</button>
      </div></> : <p>素材包尚未完成。</p>}
      <p className="form-message">{message}</p>
    </section>;
  }
  return <section className="workflow-card">
    <ol className="progress-list">{view.progress.map((step, index) => <li className={`progress-${step.state || "pending"}`} key={step.id || index}>
      <i>{step.state === "completed" ? "✓" : index + 1}</i><span>{step.label || "处理中"}</span>
      {step.state === "active" ? <em aria-hidden="true" className="progress-live" /> : null}
    </li>)}</ol>
    {view.actions.length > 0 ? (() => {
      const doneCount = view.actions.filter((action) => action.complete).length;
      // The API sends fixed Chinese state labels; colour and motion key off
      // them so a working step reads as alive, a finished one as settled and a
      // redo as attention-worthy rather than broken.
      const stateTone = (action: ProjectView["actions"][number]) => {
        if (action.complete) return "done";
        if (action.stateLabel.includes("生成中") || action.stateLabel.includes("抠像中")) return "working";
        if (action.stateLabel.includes("未通过")) return "redo";
        return "queued";
      };
      return <div className="action-progress">
        <div className="action-progress-heading">
          <p>七个动作　<strong>{doneCount}/{view.actions.length}</strong></p>
          <div aria-hidden="true" className="action-progress-bar"><i style={{ width: `${Math.round((doneCount / view.actions.length) * 100)}%` }} /></div>
        </div>
        <ul>{view.actions.map((action) => {
          const tone = stateTone(action);
          return <li className={`tone-${tone}`} key={action.actionId}>
            <span><i aria-hidden="true" className={`action-dot dot-${tone}`} />{action.label}</span>
            <small>{action.regenerated && !action.complete ? `${action.stateLabel}（质量不达标，正在重做）` : action.stateLabel}</small>
          </li>;
        })}</ul>
      </div>;
    })() : null}
    {view.failed ? <p className="error-state">制作遇到问题，已转入内部处理，不需要重新付款。</p> : null}
    {view.downloadReady ? <Link className="primary-button inline-button" href={`/projects/${encodeURIComponent(projectId)}/delivery`}>下载 PetPack</Link> : <p className="form-message">页面会自动更新，关闭后稍后回来也不会丢失进度。</p>}
  </section>;
}
