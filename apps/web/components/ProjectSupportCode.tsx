"use client";

import { useState } from "react";

/**
 * The one identifier a customer can hand to support. The platform stores no
 * phone number - not even hashed - so this project code is the only join
 * between "the customer on the phone" and their order in the support console.
 * It sits on every project sub-page, right where a stuck customer is looking.
 */
export function ProjectSupportCode({ projectId }: { projectId: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");

  const copy = () => {
    const finish = (state: "done" | "manual") => {
      setCopied(state);
      window.setTimeout(() => setCopied("idle"), 2500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(projectId).then(() => finish("done")).catch(() => finish("manual"));
      return;
    }
    finish("manual");
  };

  return (
    <p className="support-code">
      <span>项目编号（联系客服时请提供）</span>
      <code>{projectId}</code>
      <button className="ghost-button" onClick={copy} type="button">
        {copied === "done" ? "已复制" : copied === "manual" ? "请长按复制" : "复制"}
      </button>
    </p>
  );
}
