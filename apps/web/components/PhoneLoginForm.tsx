"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { createCloudBasePhoneAuth, type CloudBasePhoneAuth } from "@/lib/cloudbase-browser-auth";
import { studioBrowserApi } from "@/lib/studio-browser-api";

export function PhoneLoginForm({ environmentId, region, enabled }: {
  environmentId?: string;
  region?: string;
  enabled: boolean;
}) {
  const configured = Boolean(enabled && environmentId && region === "ap-shanghai");
  const unavailableMessage = "手机号登录尚未完成腾讯云环境配置。";
  const authRef = useRef<Promise<CloudBasePhoneAuth> | null>(null);
  const verifyRef = useRef<((input: { token: string }) => Promise<unknown>) | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(configured ? "" : unavailableMessage);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  async function client() {
    if (!configured || !environmentId || !region) throw new Error(unavailableMessage);
    authRef.current ||= createCloudBasePhoneAuth({ environmentId, region });
    return authRef.current;
  }

  async function sendCode() {
    if (!/^1[3-9][0-9]{9}$/.test(phone)) return setMessage("请输入正确的中国大陆手机号");
    setBusy(true);
    try {
      verifyRef.current = await (await client()).sendCode(`+86${phone}`);
      setCodeSent(true);
      setCode("");
      setCountdown(60);
      setMessage("验证码已发送");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "验证码暂时无法发送");
    } finally { setBusy(false); }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    if (!/^[0-9]{6}$/.test(code)) return setMessage("请输入 6 位验证码");
    setBusy(true);
    try {
      if (!verifyRef.current) throw new Error("请重新获取验证码");
      await verifyRef.current({ token: code });
      const accessToken = await (await client()).accessToken();
      const result = await studioBrowserApi.exchangeSession(accessToken);
      await (await client()).signOut().catch(() => undefined);
      window.location.assign(result.redirectTo || "/projects");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败，请稍后再试");
    } finally { setBusy(false); }
  }

  return (
    <form className="stack-form" onSubmit={codeSent ? login : (event) => { event.preventDefault(); void sendCode(); }}>
      <label>
        手机号
        <span className="phone-field"><b>+86</b><input
          autoComplete="tel-national"
          disabled={!configured || busy || codeSent}
          inputMode="numeric"
          maxLength={11}
          onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))}
          placeholder="11 位手机号"
          value={phone}
        /></span>
      </label>
      {codeSent ? <label>短信验证码<input
        autoComplete="one-time-code"
        autoFocus
        disabled={busy}
        inputMode="numeric"
        maxLength={6}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="请输入 6 位验证码"
        value={code}
      /></label> : null}
      <button className="button button-primary form-submit" disabled={!configured || busy} type="submit">
        {busy ? "请稍候…" : codeSent ? "登录" : "获取验证码"}
      </button>
      {codeSent ? <button
        className="text-button"
        disabled={busy || countdown > 0}
        onClick={() => void sendCode()}
        type="button"
      >{countdown > 0 ? `${countdown} 秒后可重新获取` : "重新获取验证码"}</button> : null}
      <p className="form-message" aria-live="polite">{message || "未使用过的手机号验证后会自动创建账号"}</p>
    </form>
  );
}
