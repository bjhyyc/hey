"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { studioBrowserApi } from "@/lib/studio-browser-api";

export function NewProjectForm() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [paymentChannel, setPaymentChannel] = useState<"ALIPAY" | "WXPAY">("ALIPAY");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit() {
    if (!displayName.trim()) return setMessage("请填写宠物名字");
    setBusy(true);
    setMessage("");
    try {
      const result = await studioBrowserApi.createCheckout({
        planCode: "petpack-seven-action-v1",
        displayName: displayName.trim(),
        paymentMethod: "KAIPAY",
        paymentChannel,
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.checkout.checkoutUrl) {
        window.location.assign(result.checkout.checkoutUrl);
        return;
      }
      router.push(`/projects/${encodeURIComponent(result.project.id)}/photos`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "暂时无法创建项目");
      setBusy(false);
    }
  }

  return <section className="workflow-card">
    <label className="field-label">宠物名字<input
      maxLength={40}
      onChange={(event) => setDisplayName(event.target.value)}
      placeholder="例如：淘淘"
      value={displayName}
    /></label>
    <fieldset className="payment-channel-picker">
      <legend>付款方式</legend>
      <button aria-pressed={paymentChannel === "ALIPAY"} className={paymentChannel === "ALIPAY" ? "is-selected" : ""} disabled={busy} onClick={() => setPaymentChannel("ALIPAY")} type="button">支付宝</button>
      <button aria-pressed={paymentChannel === "WXPAY"} className={paymentChannel === "WXPAY" ? "is-selected" : ""} disabled={busy} onClick={() => setPaymentChannel("WXPAY")} type="button">微信支付</button>
    </fieldset>
    <div className="plan-summary"><span>PetPack</span><strong>7 个视频</strong><small>正面与 45° 母图 · 自动睡姿 · 自动打包</small></div>
    <button className="primary-button form-submit" disabled={busy} onClick={() => void submit()} type="button">
      {busy ? "正在创建…" : "购买并开始制作"}
    </button>
    <p className="form-message" aria-live="polite">{message || "付款成功后才会上传照片和调用生成模型"}</p>
  </section>;
}
