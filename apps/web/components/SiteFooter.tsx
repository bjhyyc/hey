import Link from "next/link";

import { SUPPORT_QQ, SUPPORT_QQ_URL } from "@/lib/support-channel";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell footer-inner">
        <Link href="/terms">服务协议</Link>
        <Link href="/privacy">隐私政策</Link>
        <Link href="/ai-content">AI 生成说明</Link>
        {SUPPORT_QQ ? (
          <a href={SUPPORT_QQ_URL} target="_blank" rel="noopener noreferrer">
            客服 QQ：{SUPPORT_QQ}
          </a>
        ) : null}
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
          蜀ICP备2026044501号
        </a>
      </div>
    </footer>
  );
}
