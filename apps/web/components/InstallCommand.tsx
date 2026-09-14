"use client";

import { useState } from "react";

/**
 * One line the customer pastes into Terminal. Block-shaped rather than the
 * inline CopyableValue, because a command is read left to right as a whole and
 * must never wrap into something that looks like two commands. The clipboard
 * fallback is the same: several mobile browsers refuse programmatic copies, so
 * the button says so instead of pretending.
 */
export function InstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");

  const copy = () => {
    const finish = (state: "done" | "manual") => {
      setCopied(state);
      window.setTimeout(() => setCopied("idle"), 2500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(command).then(() => finish("done")).catch(() => finish("manual"));
      return;
    }
    finish("manual");
  };

  return (
    <div className="install-command">
      <code>{command}</code>
      <button className="ghost-button" onClick={copy} type="button">
        {copied === "done" ? "已复制" : copied === "manual" ? "请长按复制" : "复制命令"}
      </button>
    </div>
  );
}
