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

  useEffect(() => {
    void load();
    if (mode !== "progress") return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load, mode]);

  if (!view) return <p className="empty-state">{message}</p>;
  if (mode === "character") {
    const { front, side, canConfirm } = view.characterCandidates;
    return <section className="workflow-card">
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
      {view.downloadReady ? <><p>PetPack 已完成兼容验证，可以下载。</p><button className="primary-button form-submit" disabled={busy} onClick={() => void (async () => {
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
    {view.failed ? <p className="error-state">制作遇到问题，已转入内部处理，不需要重新付款。</p> : null}
    {view.downloadReady ? <Link className="primary-button inline-button" href={`/projects/${encodeURIComponent(projectId)}/delivery`}>下载 PetPack</Link> : <p className="form-message">页面会自动更新，关闭后稍后回来也不会丢失进度。</p>}
  </section>;
}
