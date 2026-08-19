"use client";

import { notFound } from "next/navigation";
import { useEffect, useState } from "react";
import { PhotoSlots } from "@/components/PhotoSlots";
import { PhotoUploadWorkflow } from "@/components/PhotoUploadWorkflow";
import { ProjectList } from "@/components/ProjectList";
import { ProjectWorkflow } from "@/components/ProjectWorkflow";
import { emptyPhotoSlots, type PhotoFileSlots } from "@/lib/photo-slots";
import type { ProjectView } from "@/lib/studio-browser-api";

// Development-only state gallery. Most workflow states cannot be reached with a
// real project - a finished run never shows "generating", a healthy run never
// shows "redo" - so the components are fed fixtures here instead. Delete or
// ignore in production; the route is excluded from the production build below.

const ACTION_LABELS: Array<[string, string]> = [
  ["idle", "待机"],
  ["sneeze", "打喷嚏"],
  ["roll", "打滚"],
  ["sleep-transition", "入睡"],
  ["sleep-loop", "睡眠循环"],
  ["stretch", "伸懒腰"],
  ["hover-attention", "悬停回应"],
];

function actions(states: string[]): ProjectView["actions"] {
  return ACTION_LABELS.map(([actionId, label], index) => {
    const stateLabel = states[index] ?? "排队中";
    return {
      actionId,
      label,
      stateLabel,
      regenerated: stateLabel === "未通过",
      complete: stateLabel === "已完成",
    };
  });
}

const LIST_ITEMS = [
  { project: { id: "a", displayName: "团团", state: "deliverable", updatedAt: "2026-08-19T04:29:00Z" },
    order: { status: "paid" }, productionState: "deliverable", downloadReady: true, failed: false, nextStep: "delivery" },
  { project: { id: "b", displayName: "毛毛", state: "video_generating", updatedAt: "2026-08-19T03:10:00Z" },
    order: { status: "paid" }, productionState: "video_generating", downloadReady: false, failed: false, nextStep: "progress" },
  { project: { id: "c", displayName: "橘子", state: "awaiting_photos", updatedAt: "2026-08-18T21:02:00Z" },
    order: { status: "paid" }, productionState: "awaiting_photos", downloadReady: false, failed: false, nextStep: "photos" },
  { project: { id: "d", displayName: "小黑", state: "awaiting_confirmation", updatedAt: "2026-08-18T20:41:00Z" },
    order: { status: "paid" }, productionState: "awaiting_confirmation", downloadReady: false, failed: false, nextStep: "character" },
  { project: { id: "e", displayName: "豆豆", state: "failed", updatedAt: "2026-08-18T19:15:00Z" },
    order: { status: "paid" }, productionState: "failed", downloadReady: false, failed: true, nextStep: "progress" },
];

const MASTER_PREVIEW = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='420' height='300'><rect width='420' height='300' fill='%23dfe6e1'/><ellipse cx='210' cy='205' rx='72' ry='58' fill='%23b9c6bd'/><circle cx='210' cy='128' r='46' fill='%23b9c6bd'/><text x='210' y='285' font-family='sans-serif' font-size='15' fill='%230d0d0d59' text-anchor='middle'>母图预览</text></svg>";

const FIXTURES: Record<string, ProjectView> = {
  midway: {
    project: { id: "midway", displayName: "团团", state: "producing" },
    order: { id: "o1", status: "paid", amountFen: 1 },
    characterCandidates: { front: null, side: null, canConfirm: false },
    progress: [
      { id: "p1", label: "照片已接收", state: "completed" },
      { id: "p2", label: "母图已确认", state: "completed" },
      { id: "p3", label: "生成七个动作", state: "active" },
      { id: "p4", label: "抠图与打包", state: "pending" },
    ],
    actions: actions(["已完成", "已完成", "生成中", "抠像中", "未通过", "已生成", "排队中"]),
    downloadReady: false,
    failed: false,
  },
  failed: {
    project: { id: "failed", displayName: "团团", state: "failed" },
    order: { id: "o2", status: "paid", amountFen: 1 },
    characterCandidates: { front: null, side: null, canConfirm: false },
    progress: [
      { id: "p1", label: "照片已接收", state: "completed" },
      { id: "p2", label: "母图已确认", state: "completed" },
      { id: "p3", label: "生成七个动作", state: "active" },
      { id: "p4", label: "抠图与打包", state: "pending" },
    ],
    actions: actions(["已完成", "已完成", "已完成", "未通过", "排队中", "排队中", "排队中"]),
    downloadReady: false,
    failed: true,
  },
  charGenerating: {
    project: { id: "charGenerating", displayName: "团团", state: "producing" },
    order: { id: "o4", status: "paid", amountFen: 1 },
    characterCandidates: { front: null, side: null, canConfirm: false },
    progress: [],
    actions: [],
    downloadReady: false,
    failed: false,
  },
  charPartial: {
    project: { id: "charPartial", displayName: "团团", state: "producing" },
    order: { id: "o5", status: "paid", amountFen: 1 },
    characterCandidates: {
      front: { id: "f1", view: "front", previewUrl: MASTER_PREVIEW, canRegenerate: true, remainingRegenerations: 2, attempts: [] },
      side: null,
      canConfirm: false,
    },
    progress: [],
    actions: [],
    downloadReady: false,
    failed: false,
  },
  charReady: {
    project: { id: "charReady", displayName: "团团", state: "producing" },
    order: { id: "o6", status: "paid", amountFen: 1 },
    characterCandidates: {
      front: { id: "f2", view: "front", previewUrl: MASTER_PREVIEW, canRegenerate: true, remainingRegenerations: 1, attempts: [] },
      side: { id: "s2", view: "side", previewUrl: MASTER_PREVIEW, canRegenerate: false, remainingRegenerations: 0, attempts: [] },
      canConfirm: true,
    },
    progress: [],
    actions: [],
    downloadReady: false,
    failed: false,
  },
  charRegenerating: {
    // The state the confirm button used to freeze in: both candidates still
    // present from the previous round, but the run is generating again so the
    // customer cannot confirm yet.
    project: { id: "charRegenerating", displayName: "团团", state: "producing" },
    order: { id: "o8", status: "paid", amountFen: 1 },
    characterCandidates: {
      front: { id: "f3", view: "front", previewUrl: MASTER_PREVIEW, canRegenerate: false, remainingRegenerations: 1, attempts: [] },
      side: { id: "s3", view: "side", previewUrl: MASTER_PREVIEW, canRegenerate: false, remainingRegenerations: 2, attempts: [] },
      canConfirm: false,
    },
    progress: [],
    actions: [],
    downloadReady: false,
    failed: false,
  },
  charChoose: {
    // Regenerations spent, three versions on record: the customer should be
    // able to keep the best one rather than whichever came last.
    project: { id: "charChoose", displayName: "团团", state: "producing" },
    order: { id: "o9", status: "paid", amountFen: 1 },
    characterCandidates: {
      front: {
        id: "f-v3", view: "front", previewUrl: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='420' height='300'><rect width='420' height='300' fill='%23e0dee6'/><circle cx='210' cy='150' r='70' fill='%23b9c6bd'/><text x='210' y='285' font-family='sans-serif' font-size='15' fill='%230d0d0d59' text-anchor='middle'>第 3 版</text></svg>",
        canRegenerate: false, remainingRegenerations: 0,
        attempts: [
          { id: "f-v1", generationAttempt: 1, previewUrl: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='420' height='300'><rect width='420' height='300' fill='%23e6dfd6'/><circle cx='210' cy='150' r='70' fill='%23b9c6bd'/><text x='210' y='285' font-family='sans-serif' font-size='15' fill='%230d0d0d59' text-anchor='middle'>第 1 版</text></svg>", isCurrent: false },
          { id: "f-v2", generationAttempt: 2, previewUrl: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='420' height='300'><rect width='420' height='300' fill='%23dfe6e1'/><circle cx='210' cy='150' r='70' fill='%23b9c6bd'/><text x='210' y='285' font-family='sans-serif' font-size='15' fill='%230d0d0d59' text-anchor='middle'>第 2 版</text></svg>", isCurrent: false },
          { id: "f-v3", generationAttempt: 3, previewUrl: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='420' height='300'><rect width='420' height='300' fill='%23e0dee6'/><circle cx='210' cy='150' r='70' fill='%23b9c6bd'/><text x='210' y='285' font-family='sans-serif' font-size='15' fill='%230d0d0d59' text-anchor='middle'>第 3 版</text></svg>", isCurrent: true }
        ]
      },
      side: {
        id: "s-v1", view: "side", previewUrl: MASTER_PREVIEW,
        canRegenerate: true, remainingRegenerations: 2, attempts: []
      },
      canConfirm: true,
    },
    progress: [],
    actions: [],
    downloadReady: false,
    failed: false,
  },
  deliveredProgress: {
    project: { id: "deliveredProgress", displayName: "团团", state: "deliverable" },
    order: { id: "o7", status: "paid", amountFen: 1 },
    characterCandidates: { front: null, side: null, canConfirm: false },
    progress: [
      { id: "p1", label: "照片已接收", state: "completed" },
      { id: "p2", label: "母图已确认", state: "completed" },
      { id: "p3", label: "生成七个动作", state: "completed" },
      { id: "p4", label: "抠图与打包", state: "completed" },
    ],
    actions: actions(["已完成", "已完成", "已完成", "已完成", "已完成", "已完成", "已完成"]),
    downloadReady: true,
    failed: false,
  },
  ready: {
    project: { id: "ready", displayName: "团团", state: "deliverable" },
    order: { id: "o3", status: "paid", amountFen: 1 },
    characterCandidates: { front: null, side: null, canConfirm: false },
    progress: [
      { id: "p1", label: "照片已接收", state: "completed" },
      { id: "p2", label: "母图已确认", state: "completed" },
      { id: "p3", label: "生成七个动作", state: "completed" },
      { id: "p4", label: "抠图与打包", state: "completed" },
    ],
    actions: actions(["已完成", "已完成", "已完成", "已完成", "已完成", "已完成", "已完成"]),
    downloadReady: true,
    failed: false,
  },
};

declare global {
  interface Window { __galleryRealFetch?: typeof fetch }
}

if (typeof window !== "undefined") {
  // Keep one handle on the genuine fetch, but always reinstall the stub so a
  // hot reload picks up edited fixtures instead of replaying the first closure.
  window.__galleryRealFetch = window.__galleryRealFetch ?? window.fetch.bind(window);
  const real = window.__galleryRealFetch;
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/api\/studio\/projects$/.test(url)) {
      return new Response(JSON.stringify({ items: LIST_ITEMS }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const match = /\/api\/studio\/projects\/([^/?]+)$/.exec(url);
    const fixture = match ? FIXTURES[match[1]] : null;
    if (!fixture) return real(input, init);
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

// Stand-in photographs so the filled slot state is visible without real files.
async function placeholderPhoto(index: number): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = 360;
  canvas.height = 480;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = ["#cfd8d2", "#d8cfc6", "#cdd3dc", "#d6d2c4"][index % 4];
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(13,13,13,.34)";
    context.font = "600 34px sans-serif";
    context.textAlign = "center";
    context.fillText(`照片 ${index + 1}`, canvas.width / 2, canvas.height / 2);
  }
  const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.8));
  return new File([blob], `slot-${index + 1}.jpg`, { type: "image/jpeg" });
}

function FilledSlots() {
  const [photos, setPhotos] = useState<PhotoFileSlots>(emptyPhotoSlots);
  useEffect(() => {
    let live = true;
    void Promise.all([0, 1, 2].map(placeholderPhoto)).then((files) => {
      if (live) setPhotos([files[0], files[1], files[2], null]);
    });
    return () => { live = false; };
  }, []);
  return <PhotoSlots onChange={setPhotos} onMessage={() => undefined} value={photos} />;
}

export default function UiGallery() {
  // A development instrument, not a page anyone should reach in production.
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="shell" style={{ paddingBlock: "40px", display: "grid", gap: "56px" }}>
      <header>
        <h1>状态画廊</h1>
        <p>真实项目跑不出来的中间状态在这里用假数据渲染，用于统一各页样式。</p>
      </header>
      <section style={{ display: "grid", gap: "12px" }}>
        <h2>projects · 列表五态</h2>
        <ProjectList />
      </section>
      <section style={{ display: "grid", gap: "12px" }}>
        <h2>photos · 空态</h2>
        <PhotoUploadWorkflow projectId="gallery" />
      </section>
      <section style={{ display: "grid", gap: "12px" }}>
        <h2>photos · 已选三张</h2>
        <div className="workflow-card"><FilledSlots /></div>
      </section>
      {Object.keys(FIXTURES).map((key) => (
        <section key={key} style={{ display: "grid", gap: "12px" }}>
          <h2>{key}</h2>
          <ProjectWorkflow
            mode={key.startsWith("char") ? "character" : key === "ready" ? "delivery" : "progress"}
            projectId={key}
          />
        </section>
      ))}
    </div>
  );
}
