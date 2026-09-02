"use client";

import { useEffect, useState } from "react";

/**
 * Best-effort "open a QQ chat" control.
 *
 * There is no single URL that opens a QQ conversation everywhere: the desktop
 * client answers `tencent://message/`, the mobile app answers `mqqwpa://im/chat`,
 * and the browser fallback (wpa.qq.com) only works when the account may receive
 * stranger sessions - which Tencent now sells as part of 企点. So this control
 * picks the scheme that fits the device and says plainly what to do when the
 * app refuses. The channels that always work (group link, friend request) are
 * rendered above it by the page itself.
 */
export function QqChatButton({ uin, webUrl }: { uin: string; webUrl: string }) {
  const [href, setHref] = useState(webUrl);

  useEffect(() => {
    const mobile = /Android|iPhone|iPad|iPod|HarmonyOS/i.test(navigator.userAgent);
    setHref(
      mobile
        ? `mqqwpa://im/chat?chat_type=wpa&uin=${encodeURIComponent(uin)}&version=1&src_type=web`
        : `tencent://message/?uin=${encodeURIComponent(uin)}&Site=heyirmy.com&Menu=yes`
    );
  }, [uin]);

  return (
    <a className="ghost-button inline-button" href={href} rel="noopener noreferrer">
      尝试直接打开 QQ 会话
    </a>
  );
}
