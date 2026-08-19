"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  KAIPAY_STATUS_POLL_INTERVAL_MS,
  kaipayQrPresentation,
  requireHttpsPaymentUrl,
} from "@/lib/kaipay-payment-ui";
import { loadHomePhotoDraft } from "@/lib/home-photo-draft";
import {
  loadPrecheckPass,
  precheckPassCoversPhotos,
  type PrecheckPass,
} from "@/lib/photo-precheck";
import { fingerprintPhoto, type PetSpecies } from "@/lib/photo-slots";
import {
  studioBrowserApi,
  type KaipayNextAction,
  type KaipayPaymentChannel,
} from "@/lib/studio-browser-api";

type QrPayment = { projectId: string; imageUrl: string; paymentChannel: KaipayPaymentChannel };

export function NewProjectForm() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [paymentChannel, setPaymentChannel] = useState<KaipayPaymentChannel>("ALIPAY");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [qrPayment, setQrPayment] = useState<QrPayment | null>(null);
  // The home page already asked whether this is a cat or a dog and kept the
  // answer in the draft; before this it never reached the server, so every run
  // generated against the dog prompt set.
  const [species, setSpecies] = useState<PetSpecies>("dog");
  // The consumer regulations require this to be an active choice before the
  // order is placed - never pre-ticked, never buried in a linked agreement.
  const [acknowledged, setAcknowledged] = useState(false);

  const [draftPhotoCount, setDraftPhotoCount] = useState<number | null>(null);
  // The home page issued this pass when the vision pre-check approved the
  // drafted photos; checkout sends it so the server can hold the gate.
  const [precheckPass, setPrecheckPass] = useState<PrecheckPass | null>(null);
  const [precheckCovered, setPrecheckCovered] = useState<boolean | null>(null);

  useEffect(() => {
    loadHomePhotoDraft()
      .then(async (draft) => {
        if (draft) setSpecies(draft.species);
        setDraftPhotoCount(draft ? draft.photos.filter(Boolean).length : 0);
        const pass = loadPrecheckPass();
        setPrecheckPass(pass);
        if (draft && pass) {
          const digests = await Promise.all(
            draft.photos.filter((file): file is File => Boolean(file)).map(fingerprintPhoto),
          );
          setPrecheckCovered(precheckPassCoversPhotos(pass, draft.species, digests));
        } else {
          setPrecheckCovered(false);
        }
      })
      .catch(() => {
        setDraftPhotoCount(0);
        setPrecheckCovered(false);
      });
  }, []);
  const showWxpay = process.env.NEXT_PUBLIC_KAIPAY_WXPAY_ENABLED === "true";
  const planCode = process.env.NEXT_PUBLIC_PETPACK_PLAN_CODE || "petpack-seven-action-v1";

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
    const timer = window.setInterval(() => void check(), KAIPAY_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [qrPayment, router]);

  async function renderQrAction(
    action: Extract<KaipayNextAction, { type: "qr_code" }>,
    projectId: string,
    selectedPaymentChannel: KaipayPaymentChannel,
  ) {
    const presentation = kaipayQrPresentation(selectedPaymentChannel);
    let imageUrl = action.qrCodeImageUrl ? requireHttpsPaymentUrl(action.qrCodeImageUrl) : "";
    if (!imageUrl && action.qrCode) {
      const { toDataURL } = await import("qrcode");
      imageUrl = await toDataURL(action.qrCode, { errorCorrectionLevel: "M", margin: 2, width: 280 });
    }
    if (!imageUrl) throw new Error(presentation.missingQrMessage);
    setQrPayment({ projectId, imageUrl, paymentChannel: selectedPaymentChannel });
    setMessage(presentation.scanMessage);
    setBusy(false);
  }

  async function handleNextAction(
    action: KaipayNextAction | undefined,
    projectId: string,
    selectedPaymentChannel: KaipayPaymentChannel,
  ) {
    if (!action) throw new Error("支付服务没有返回下一步操作，请稍后重试");
    if (action.type === "redirect") {
      window.location.assign(requireHttpsPaymentUrl(action.url));
      return;
    }
    if (action.type === "qr_code") {
      await renderQrAction(action, projectId, selectedPaymentChannel);
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
        planCode,
        displayName: displayName.trim(),
        paymentMethod: "KAIPAY",
        paymentChannel,
        idempotencyKey: crypto.randomUUID(),
        species,
        ...(precheckPass && precheckCovered ? { precheckId: precheckPass.precheckId } : {}),
      });
      await handleNextAction(result.checkout.nextAction, result.project.id, paymentChannel);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "暂时无法创建项目");
      setBusy(false);
    }
  }

  if (qrPayment) {
    const presentation = kaipayQrPresentation(qrPayment.paymentChannel);
    return <section className="workflow-card payment-qr-card">
      <h2>扫码完成付款</h2>
      <img alt={presentation.imageAlt} className="payment-qr-image" height="280" src={qrPayment.imageUrl} width="280" />
      <p className="form-message" aria-live="polite">{message}</p>
      <button className="primary-button form-submit" onClick={() => void studioBrowserApi.refreshPaymentStatus(qrPayment.projectId).then((result) => {
        if (result.order?.status === "paid") router.push(`/projects/${encodeURIComponent(qrPayment.projectId)}/photos`);
        else setMessage("暂未确认到账，请勿重复付款，稍后再试");
      }).catch(() => setMessage("暂时无法查询付款状态，请稍后再试"))} type="button">我已完成付款</button>
    </section>;
  }

  return <section aria-labelledby="payment-title" className="payment-picker">
    <div><h2 id="payment-title">确认信息并付款</h2></div>
    <div className="workflow-notice">
      <p><strong>一次付费包含全部制作</strong>：形象生成与确认、睡姿、七个动作视频、抠图校正和打包下载。</p>
      <p>两张形象母图各有 2 次免费重新生成机会；付款后上传照片，全程通常 10–20 分钟。付款遇到问题请勿重复下单。</p>
    </div>
    <label className="payment-name-field">宠物名字<input
      maxLength={120}
      onChange={(event) => setDisplayName(event.target.value)}
      placeholder="例如：团团"
      value={displayName}
    /></label>
    <div className="pay-species-row">
      <span className="pay-species-label">宠物是</span>
      <div aria-label="宠物种类" className="species-switch pay-species-switch" role="radiogroup">
        <button aria-checked={species === "cat"} className={species === "cat" ? "active" : undefined} onClick={() => setSpecies("cat")} role="radio" type="button">猫</button>
        <button aria-checked={species === "dog"} className={species === "dog" ? "active" : undefined} onClick={() => setSpecies("dog")} role="radio" type="button">狗</button>
      </div>
      <small>提示词会按种类定制，选错会影响生成效果</small>
    </div>
    {draftPhotoCount !== null && (draftPhotoCount > 0
      ? <p className="form-message">
          已选好 {draftPhotoCount} 张照片，付款后自动上传。
          {precheckCovered === true ? <span className="precheck-state is-pass">照片预检已通过 ✓</span> : null}
          {precheckCovered === false ? <span className="precheck-state is-miss">这组照片还没有通过预检，<a className="check-list-client-link" href="/#start">回首页完成预检</a>更稳妥</span> : null}
        </p>
      : <p className="form-message">还没有选照片——请<a className="check-list-client-link" href="/#start">回首页挑好照片并完成预检</a>后再付款。</p>)}
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
    <label className="order-ack">
      <input
        checked={acknowledged}
        disabled={busy}
        onChange={(event) => setAcknowledged(event.target.checked)}
        type="checkbox"
      />
      <span>
        我已知悉：成品由 AI 依据我的照片重新绘制，会尽量贴近毛色与神态，但不是照片复刻；
        本商品为按我提供的照片定制的数字内容，交付后不适用七天无理由退货。
        若文件损坏、无法导入或与我确认的母图明显不符，可免费重做或退款。
      </span>
    </label>
    <button className="primary-button form-submit" disabled={busy || !acknowledged} onClick={() => void submit()} type="button">
      {busy ? "正在创建…" : "创建订单并前往付款"}
    </button>
    <p className="form-message" aria-live="polite">{message}</p>
  </section>;
}
