"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { studioBrowserApi, type ProjectSummary } from "@/lib/studio-browser-api";

// Internal state machine names never reach the customer: every state the API
// can report maps to plain language, and unknown values fall back to a generic
// in-progress label.
const STATE_LABELS: Record<string, string> = {
  awaiting_payment: "未完成付款",
  awaiting_photos: "等待上传照片",
  awake_generating: "正在生成形象",
  awaiting_character_confirmation: "等待确认形象",
  awaiting_confirmation: "等待确认形象",
  sleep_generating: "正在生成睡姿",
  awaiting_prompt_gate: "准备生成动作",
  video_generating: "正在生成动作",
  media_processing: "正在抠图校正",
  packaging: "正在打包",
  validating: "正在验证",
  deliverable: "可下载",
  producing: "制作中",
  draft: "草稿",
  failed: "需要处理"
};

const NEXT_STEP_ROUTES: Record<string, { path: string; hint: string }> = {
  photos: { path: "photos", hint: "去上传照片" },
  character: { path: "character", hint: "去确认形象" },
  progress: { path: "progress", hint: "查看制作进度" },
  delivery: { path: "delivery", hint: "去下载 PetPack" },
  failed: { path: "progress", hint: "查看处理说明" },
  payment: { path: "progress", hint: "查看订单状态" }
};

function statusLabel(item: ProjectSummary) {
  if (item.downloadReady) return "可下载";
  if (item.failed) return "需要处理";
  const state = item.productionState || item.project.state || "";
  return STATE_LABELS[state] || "制作中";
}

// Emerald means "ready for you", amber means "we need you", plain means
// "we are working"; danger stays for the states that need a human.
const WAITING_ON_CUSTOMER = new Set([
  "未完成付款", "等待上传照片", "等待确认形象", "草稿",
]);

function statusTone(label: string, failed: boolean) {
  if (failed || label === "需要处理") return "is-danger";
  if (label === "可下载") return "is-ready";
  if (WAITING_ON_CUSTOMER.has(label)) return "is-waiting";
  return "is-working";
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function updatedLabel(value?: string) {
  if (!value) return "";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.getFullYear() + "-" + pad(time.getMonth() + 1) + "-" + pad(time.getDate())
    + " " + pad(time.getHours()) + ":" + pad(time.getMinutes());
}

export function ProjectList() {
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [message, setMessage] = useState("正在加载项目…");

  useEffect(() => {
    let active = true;
    studioBrowserApi.listProjects()
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setMessage(result.items.length ? "" : "还没有项目，点击右上角开始制作。");
      })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "无法加载项目"); });
    return () => { active = false; };
  }, []);

  if (!items.length) return <p className="empty-state">{message}</p>;
  return <div className="project-list">{items.map((item) => {
    const route = NEXT_STEP_ROUTES[item.nextStep || ""] || NEXT_STEP_ROUTES.progress;
    return (
      <Link className="project-card" href={"/projects/" + encodeURIComponent(item.project.id) + "/" + route.path} key={item.project.id}>
        <span>
          <strong>{item.project.displayName || "我的宠物"}</strong>
          <small>{updatedLabel(item.project.updatedAt)}</small>
        </span>
        <span className="project-card-side">
          {(() => {
            const label = statusLabel(item);
            return <span className={"status-pill " + statusTone(label, item.failed)}>{label}</span>;
          })()}
          <small className="project-card-hint">{route.hint} →</small>
        </span>
      </Link>
    );
  })}</div>;
}
