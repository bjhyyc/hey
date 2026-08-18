import type { KaipayPaymentChannel } from "./studio-browser-api";

export const KAIPAY_STATUS_POLL_INTERVAL_MS = 3_000;

type KaipayQrPresentation = {
  paymentName: string;
  imageAlt: string;
  missingQrMessage: string;
  scanMessage: string;
};

export function kaipayQrPresentation(paymentChannel: KaipayPaymentChannel): KaipayQrPresentation {
  const paymentName = paymentChannel === "ALIPAY" ? "支付宝" : "微信支付";
  const scanAppName = paymentChannel === "ALIPAY" ? "支付宝" : "微信";
  return {
    paymentName,
    imageAlt: `${paymentName}二维码`,
    missingQrMessage: `暂时无法显示${paymentName}二维码，请稍后重试`,
    scanMessage: `请使用${scanAppName}扫码付款，付款成功后会自动进入上传页面`,
  };
}

export function requireHttpsPaymentUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("支付跳转地址无效，请稍后重试");
  }
  return parsed.toString();
}
