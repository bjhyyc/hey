"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { studioBrowserApi, type ProjectSummary } from "@/lib/studio-browser-api";

export function ProjectList() {
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [message, setMessage] = useState("正在加载项目…");

  useEffect(() => {
    let active = true;
    studioBrowserApi.listProjects()
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setMessage(result.items.length ? "" : "还没有项目");
      })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "无法加载项目"); });
    return () => { active = false; };
  }, []);

  if (!items.length) return <p className="empty-state">{message}</p>;
  return <div className="project-list">{items.map((item) => (
    <Link className="project-card" href={`/projects/${encodeURIComponent(item.project.id)}`} key={item.project.id}>
      <span><strong>{item.project.displayName || "我的宠物"}</strong><small>{item.project.updatedAt || ""}</small></span>
      <span className={`status-pill${item.failed ? " status-error" : ""}`}>
        {item.downloadReady ? "可下载" : item.failed ? "需要处理" : item.productionState || item.project.state || "处理中"}
      </span>
    </Link>
  ))}</div>;
}
