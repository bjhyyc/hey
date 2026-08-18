"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { studioBrowserApi, type ProjectView } from "@/lib/studio-browser-api";

function Candidate({ candidate, label, onRegenerate, busy }: {
  candidate: ProjectView["characterCandidates"]["front"];
  label: string;
  onRegenerate: () => void;
  busy: boolean;
}) {
  return <article className="candidate-card">
    <div className="candidate-preview">
      {candidate?.previewUrl ? <img alt={`${label}母图`} src={candidate.previewUrl} /> : <span>正在生成 {label}</span>}
    </div>
    <footer><span><strong>{label}</strong><small>{candidate ? `还可重生成 ${candidate.remainingRegenerations} 次` : "请稍候"}</small></span>
      <button disabled={!candidate?.canRegenerate || busy} onClick={onRegenerate} type="button">重新生成</button></footer>
  </article>;
}

export function ProjectWorkflow({ projectId, mode }: { projectId: string; mode: "character" | "progress" | "delivery" }) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [message, setMessage] = useState("正在读取项目…");
  const [busy, setBusy] = useState(false);

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
  const settled = Boolean(view && (view.failed
    || (mode === "character" && view.characterCandidates.front && view.characterCandidates.side)));

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (mode === "delivery" || settled) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load, mode, settled]);

  if (!view) return <p className="empty-state">{message}</p>;
  if (view.failed) {
    return <section className="workflow-card">
      <p><strong>制作没有完成</strong></p>
      <p className="form-message">这个项目在生成阶段中断了，照片和订单都已保留。请联系我们处理，不要重复下单。</p>
      <Link className="secondary-link" href="/projects">返回项目列表</Link>
    </section>;
  }
  if (mode === "character") {
    const { front, side, canConfirm } = view.characterCandidates;
    return <section className="workflow-card">
      <div className="workflow-notice">
        <p><strong>母图决定成品质量</strong>，而母图取决于你上传的照片。七个动作和睡姿都会照着这两张母图生成，请认真确认。</p>
        <p>45° 照片尽量把花色拍全，<strong>花色左右不对称的宠物</strong>（三花、玳瑁、花斑）尤其重要，否则背对镜头的那一侧只能靠猜。</p>
      </div>
      <div className="candidate-grid">
        <Candidate candidate={front} label="正面" busy={busy} onRegenerate={() => void (async () => {
          setBusy(true); try { await studioBrowserApi.regenerateCharacter(projectId, "front"); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : "重生成失败"); } finally { setBusy(false); }
        })()} />
        <Candidate candidate={side} label="45°" busy={busy} onRegenerate={() => void (async () => {
          setBusy(true); try { await studioBrowserApi.regenerateCharacter(projectId, "side"); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : "重生成失败"); } finally { setBusy(false); }
        })()} />
      </div>
      <button className="primary-button form-submit" disabled={!canConfirm || !front || !side || busy} onClick={() => void (async () => {
        if (!front || !side) return;
        setBusy(true);
        try {
          await studioBrowserApi.confirmCharacter(projectId, front.id, side.id);
          window.location.assign(`/projects/${encodeURIComponent(projectId)}/progress`);
        } catch (error) { setMessage(error instanceof Error ? error.message : "确认失败"); setBusy(false); }
      })()} type="button">{busy ? "正在确认…" : "确认形象，开始制作"}</button>
      <p className="form-message">{message || "两张母图分别确认；睡姿和七个动作会自动生成"}</p>
    </section>;
  }
  if (mode === "delivery") {
    return <section className="workflow-card delivery-card">
      {view.downloadReady ? <>
      <div className="workflow-notice">
        <p><strong>接下来三步</strong>：① 下载 <code>.petpack</code> 文件；② 安装并打开桌宠客户端；③ 点击「导入我的 PetPack」选择该文件。</p>
        <p>下载链接短时有效，过期后回到本页重新点击下载即可，不会额外收费。</p>
      </div>
      <p>PetPack 已完成兼容验证，可以下载。</p><button className="primary-button form-submit" disabled={busy} onClick={() => void (async () => {
        setBusy(true); try { const result = await studioBrowserApi.createDownload(projectId); window.location.assign(result.downloadUrl); } catch (e) { setMessage(e instanceof Error ? e.message : "下载暂不可用"); setBusy(false); }
      })()} type="button">{busy ? "正在准备…" : "下载 PetPack"}</button></> : <p>素材包尚未完成。</p>}
      <p className="form-message">{message}</p>
      <Link className="secondary-link" href="/download-client" target="_blank">下载客户端</Link>
    </section>;
  }
  return <section className="workflow-card">
    <ol className="progress-list">{view.progress.map((step, index) => <li className={`progress-${step.state || "pending"}`} key={step.id || index}>
      <i>{step.state === "completed" ? "✓" : index + 1}</i><span>{step.label || "处理中"}</span>
    </li>)}</ol>
    {view.actions.length > 0 ? <div className="action-progress">
      <p className="action-progress-heading">
        七个动作　已完成 {view.actions.filter((action) => action.complete).length}/{view.actions.length}
      </p>
      <ul>{view.actions.map((action) => <li className={action.complete ? "is-complete" : undefined} key={action.actionId}>
        <span>{action.label}</span>
        <small>{action.regenerated && !action.complete ? `${action.stateLabel}（质量不达标，正在重做）` : action.stateLabel}</small>
      </li>)}</ul>
    </div> : null}
    {view.failed ? <p className="error-state">制作遇到问题，已转入内部处理，不需要重新付款。</p> : null}
    {view.downloadReady ? <Link className="primary-button inline-button" href={`/projects/${encodeURIComponent(projectId)}/delivery`}>下载 PetPack</Link> : <p className="form-message">页面会自动更新，关闭后稍后回来也不会丢失进度。</p>}
  </section>;
}
