"use client";

import { useState } from "react";

/**
 * A value the customer has to carry into another app by hand - a QQ number, a
 * group number. Clipboard access fails silently in several mobile browsers, so
 * the button reports that case instead of pretending it copied.
 */
export function CopyableValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");

  const copy = () => {
    const finish = (state: "done" | "manual") => {
      setCopied(state);
      window.setTimeout(() => setCopied("idle"), 2500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(() => finish("done")).catch(() => finish("manual"));
      return;
    }
    finish("manual");
  };

  return (
    <p className="support-value">
      <span>{label}</span>
      <code>{value}</code>
      <button className="ghost-button" onClick={copy} type="button">
        {copied === "done" ? "已复制" : copied === "manual" ? "请长按复制" : "复制"}
      </button>
    </p>
  );
}
