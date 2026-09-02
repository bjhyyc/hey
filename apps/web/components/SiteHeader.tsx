import Link from "next/link";
import { AccountControl } from "./AccountControl";

/**
 * One header everywhere.
 *
 * The top-right slot used to differ by surface: the home page carried the
 * account pills plus 下载客户端 as the amber action, while inner pages spelled
 * 我的项目 and 下载客户端 as plain nav text and left the slot to the account.
 * Two vocabularies for the same three destinations - and 我的项目 appeared
 * twice on inner pages, once as nav text and once inside the account control.
 *
 * So every surface now renders the home arrangement: the account control (which
 * already carries 我的项目 for a signed-in customer) and 下载客户端 as the one
 * action, the destination nothing else in the header reaches.
 *
 * `sales={false}` suppresses that action for working surfaces - the support
 * console is not a place to sell.
 */
export function SiteHeader({ home = false, sales = true }: { home?: boolean; sales?: boolean }) {
  return (
    <header className={home ? "site-header home-site-header" : "site-header"}>
      <div className="shell header-inner">
        <Link className="brand brand-hey" href="/" aria-label="Hey 首页">
          Hey
        </Link>
        <nav className="header-actions" aria-label="账户操作">
          <AccountControl showProjectsWhenAuthenticated />
          {sales ? (
            <Link className="header-purchase" href="/download-client" target="_blank">
              下载客户端
            </Link>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
