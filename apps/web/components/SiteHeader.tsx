import Link from "next/link";
import { AccountControl } from "./AccountControl";

export function SiteHeader({ home = false }: { home?: boolean }) {
  return (
    <header className={`site-header${home ? " home-site-header" : ""}`}>
      <div className="shell header-inner">
        <Link className="brand brand-hey" href="/" aria-label="Hey 首页">
          Hey
        </Link>
        {home ? (
          <nav className="header-actions" aria-label="账户操作">
            <AccountControl />
            <Link className="header-purchase" href="/projects/new">
              购买
            </Link>
          </nav>
        ) : (
          <div className="secondary-header-right">
            <nav className="primary-nav" aria-label="主导航">
              <Link href="/projects">我的项目</Link>
              <Link href="/projects/new">开始制作</Link>
              <Link className="primary-nav-client" href="/download-client" target="_blank">
                下载客户端
              </Link>
            </nav>
            <nav className="header-actions" aria-label="账户操作">
              <AccountControl />
              <Link className="header-purchase" href="/projects/new">
                购买
              </Link>
            </nav>
          </div>
        )}
      </div>
    </header>
  );
}
