"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { studioBrowserApi } from "@/lib/studio-browser-api";

export function AccountControl() {
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    studioBrowserApi.session()
      .then((result) => { if (active) setAuthenticated(result.authenticated); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  if (!authenticated) {
    return <Link className="text-link header-login header-account-placeholder" href="/login">登录</Link>;
  }
  return (
    <button
      className="text-link header-login header-logout account-logout"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await studioBrowserApi.logout();
          window.location.assign("/");
        } catch {
          setBusy(false);
        }
      }}
      type="button"
    >
      {busy ? "退出中…" : "退出"}
    </button>
  );
}
