"use client";

type CloudBaseAuthError = { code?: string; category?: string; message?: string } | null;
type VerifyOtp = (input: { token: string }) => Promise<{ data?: unknown; error?: CloudBaseAuthError }>;

export type CloudBasePhoneAuth = {
  sendCode(phone: string): Promise<VerifyOtp>;
  accessToken(): Promise<string>;
  signOut(): Promise<void>;
};

function providerError(error: CloudBaseAuthError, stage: "send" | "verify") {
  const code = `${error?.code || ""} ${error?.category || ""}`.toUpperCase();
  if (code.includes("CAPTCHA")) return new Error("请完成安全验证后再试");
  if (code.includes("RATE") || code.includes("LIMIT") || code.includes("TOO_MANY")) {
    return new Error("操作过于频繁，请稍后再试");
  }
  return new Error(stage === "verify" ? "验证码错误或已过期" : "验证码暂时无法发送");
}

export async function createCloudBasePhoneAuth({ environmentId, region }: {
  environmentId: string;
  region: string;
}): Promise<CloudBasePhoneAuth> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/.test(environmentId) || region !== "ap-shanghai") {
    throw new Error("手机号登录尚未完成配置");
  }
  const cloudbase = (await import("@cloudbase/js-sdk")).default;
  const app = cloudbase.init({
    env: environmentId,
    region,
    persistence: "none",
    auth: { detectSessionInUrl: false },
  });
  const auth = app.auth({ persistence: "none" });
  return {
    async sendCode(phone) {
      const response = await auth.signInWithOtp({ phone, options: { shouldCreateUser: true } });
      if (response.error || !response.data?.verifyOtp) throw providerError(response.error, "send");
      const verifyOtp = response.data.verifyOtp;
      return async ({ token }) => {
        const result = await verifyOtp({ token });
        if (result.error) throw providerError(result.error, "verify");
        return result;
      };
    },
    async accessToken() {
      const result = await auth.getAccessToken();
      if (!result?.accessToken) throw new Error("登录状态无效，请重新获取验证码");
      return result.accessToken;
    },
    async signOut() { await auth.signOut(); },
  };
}
