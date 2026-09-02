import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell footer-inner">
        <Link href="/faq">常见问题</Link>
        <Link href="/support">联系客服</Link>
        <Link href="/terms">服务协议</Link>
        <Link href="/privacy">隐私政策</Link>
        <Link href="/ai-content">AI 生成说明</Link>
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
          蜀ICP备2026044501号
        </a>
      </div>
    </footer>
  );
}
