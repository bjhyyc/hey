"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { studioBrowserApi, type KaipayNextAction } from "@/lib/studio-browser-api";

type QrPayment = { projectId: string; imageUrl: string };

function requireHttpsUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("支付跳转地址无效，请稍后重试");
  }
  return parsed.toString();
}

export function NewProjectForm() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [paymentChannel, setPaymentChannel] = useState<"ALIPAY" | "WXPAY">("ALIPAY");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [qrPayment, setQrPayment] = useState<QrPayment | null>(null);
  const showWxpay = process.env.NEXT_PUBLIC_KAIPAY_WXPAY_ENABLED === "true";

  useEffect(() => {
    if (!qrPayment) return;
    let cancelled = false;
    const check = async () => {
      try {
        const project = await studioBrowserApi.project(qrPayment.projectId);
        if (cancelled) return;
        if (project.order?.status === "paid") {
          router.push(`/projects/${encodeURIComponent(qrPayment.projectId)}/photos`);
        } else if (["payment_review", "expired"].includes(project.order?.status || "")) {
          setMessage("付款状态需要确认，请勿重复付款，可稍后在项目页查看");
        }
      } catch {
        // A transient status-poll failure must not discard the QR code. The
        // customer can keep paying and retry the explicit status check.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [qrPayment, router]);

  async function renderQrAction(action: Extract<KaipayNextAction, { type: "qr_code" }>, projectId: string) {
    let imageUrl = action.qrCodeImageUrl ? requireHttpsUrl(action.qrCodeImageUrl) : "";
    if (!imageUrl && action.qrCode) {
      const { toDataURL } = await import("qrcode");
      imageUrl = await toDataURL(action.qrCode, { errorCorrectionLevel: "M", margin: 2, width: 280 });
    }
    if (!imageUrl) throw new Error("暂时无法显示微信支付二维码，请稍后重试");
    setQrPayment({ projectId, imageUrl });
    setMessage("请使用微信扫码付款，付款成功后会自动进入上传页面");
    setBusy(false);
  }

  async function handleNextAction(action: KaipayNextAction | undefined, projectId: string) {
    if (!action) throw new Error("支付服务没有返回下一步操作，请稍后重试");
    if (action.type === "redirect") {
      window.location.assign(requireHttpsUrl(action.url));
      return;
    }
    if (action.type === "qr_code") {
      await renderQrAction(action, projectId);
      return;
    }
    if (action.type === "poll" || action.type === "none") {
      router.push(`/projects/${encodeURIComponent(projectId)}`);
      return;
    }
    setMessage(action.message || `支付入口暂未就绪，请 ${action.retryAfterSeconds} 秒后重试`);
    setBusy(false);
  }

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
      await handleNextAction(result.checkout.nextAction, result.project.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "暂时无法创建项目");
      setBusy(false);
    }
  }

  if (qrPayment) return <section className="workflow-card payment-qr-card">
    <p className="eyebrow">微信支付</p>
    <h2>扫码完成付款</h2>
    <img alt="微信支付二维码" className="payment-qr-image" height="280" src={qrPayment.imageUrl} width="280" />
    <p className="form-message" aria-live="polite">{message}</p>
    <button className="primary-button form-submit" onClick={() => void studioBrowserApi.refreshPaymentStatus(qrPayment.projectId).then((result) => {
      if (result.order?.status === "paid") router.push(`/projects/${encodeURIComponent(qrPayment.projectId)}/photos`);
      else setMessage("暂未确认到账，请勿重复付款，稍后再试");
    }).catch(() => setMessage("暂时无法查询付款状态，请稍后再试"))} type="button">我已完成付款</button>
  </section>;

  return <section aria-labelledby="payment-title" className="payment-picker">
    <div><h2 id="payment-title">选择支付方式</h2></div>
    <label className="payment-name-field">宠物名字<input
      maxLength={120}
      onChange={(event) => setDisplayName(event.target.value)}
      placeholder="例如：团团"
      value={displayName}
    /></label>
    <div aria-label="支付方式" className={`payment-methods${showWxpay ? " has-wechat" : ""}`} role="radiogroup">
      <label className={`payment-method${paymentChannel === "ALIPAY" ? " is-selected" : ""}`}>
        <input checked={paymentChannel === "ALIPAY"} disabled={busy} name="payment-method" onChange={() => setPaymentChannel("ALIPAY")} type="radio" value="ALIPAY" />
        <span><strong>支付宝</strong><small>支付宝收银台</small></span>
      </label>
      {showWxpay ? <label className={`payment-method${paymentChannel === "WXPAY" ? " is-selected" : ""}`}>
        <input checked={paymentChannel === "WXPAY"} disabled={busy} name="payment-method" onChange={() => setPaymentChannel("WXPAY")} type="radio" value="WXPAY" />
        <span><strong>微信支付</strong><small>微信扫码支付</small></span>
      </label> : null}
    </div>
    <button className="button button-primary" disabled={busy} onClick={() => void submit()} type="button">
      {busy ? "正在创建…" : "创建订单并前往付款"}
    </button>
    <p className="form-message" aria-live="polite">{message}</p>
  </section>;
}
