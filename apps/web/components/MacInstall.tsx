"use client";

import { useState } from "react";

/**
 * The macOS install, shaped like the Windows column beside it: one black
 * button, then three short steps. The button copies the Terminal command -
 * that is the one thing the customer has to do - and its label turns into the
 * next instruction, so the eye never has to leave it. The command itself stays
 * visible underneath for anyone who wants to read it or whose browser refuses
 * programmatic copies (several mobile ones do).
 */
export function MacInstall({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "done" | "manual">("idle");

  const copy = () => {
    const finish = (next: "done" | "manual") => {
      setState(next);
      window.setTimeout(() => setState("idle"), 4000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(command).then(() => finish("done")).catch(() => finish("manual"));
      return;
    }
    finish("manual");
  };

  return (
    <>
      <button className="primary-button form-submit" onClick={copy} type="button">
        {state === "done" ? "已复制，去「终端」粘贴" : state === "manual" ? "请长按下方命令复制" : "复制安装命令"}
      </button>
      <ol className="instruction-list compact-list mac-steps">
        <li><span>1</span>打开「终端」（启动台里搜“终端”）</li>
        <li><span>2</span>粘贴，按回车</li>
        <li><span>3</span>等它装完，Hey 会自己打开</li>
      </ol>
      <code className="install-command">{command}</code>
    </>
  );
}
