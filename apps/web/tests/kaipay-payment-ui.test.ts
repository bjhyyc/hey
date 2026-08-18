import { describe, expect, it } from "vitest";
import {
  KAIPAY_STATUS_POLL_INTERVAL_MS,
  kaipayQrPresentation,
  requireHttpsPaymentUrl,
} from "@/lib/kaipay-payment-ui";

describe("Kaipay payment UI contract", () => {
  it("presents an Alipay native QR with Alipay-specific guidance", () => {
    expect(kaipayQrPresentation("ALIPAY")).toEqual({
      paymentName: "支付宝",
      imageAlt: "支付宝二维码",
      missingQrMessage: "暂时无法显示支付宝二维码，请稍后重试",
      scanMessage: "请使用支付宝扫码付款，付款成功后会自动进入上传页面",
    });
  });

  it("keeps WeChat native QR guidance", () => {
    expect(kaipayQrPresentation("WXPAY")).toEqual({
      paymentName: "微信支付",
      imageAlt: "微信支付二维码",
      missingQrMessage: "暂时无法显示微信支付二维码，请稍后重试",
      scanMessage: "请使用微信扫码付款，付款成功后会自动进入上传页面",
    });
  });

  it("polls QR payment state every three seconds", () => {
    expect(KAIPAY_STATUS_POLL_INTERVAL_MS).toBe(3_000);
  });

  it("keeps secure redirect URLs compatible", () => {
    expect(requireHttpsPaymentUrl("https://pay.example.com/cashier?order=123")).toBe(
      "https://pay.example.com/cashier?order=123",
    );
    expect(() => requireHttpsPaymentUrl("http://pay.example.com/cashier")).toThrow(
      "支付跳转地址无效，请稍后重试",
    );
  });
});
