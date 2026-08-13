import Link from "next/link";
import { AccountControl } from "./AccountControl";

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="Hey 首页">
        Hey
      </Link>
      <nav className="header-nav" aria-label="主导航">
        <Link className="nav-link" href="/download-client" target="_blank">
          客户端
        </Link>
        <Link className="purchase-link" href="/projects/new/pay">
          购买
        </Link>
        <AccountControl />
      </nav>
    </header>
  );
}
