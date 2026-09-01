import Link from "next/link";
import { AccountControl } from "./AccountControl";

/**
 * The top-right slot carries the strongest visual weight on every page, so it
 * holds one action: the most useful thing to do from here.
 *
 * It used to hold two. `购买` and `开始制作` pointed at the identical address
 * (`/#start`), two positions apart in the same header - and that address is
 * the photo upload section, not a purchase: payment happens later, at
 * /projects/new/pay, after the pre-check. On the home page the amber button
 * scrolled to a section already on screen. Meanwhile the navigation a
 * returning customer actually needs was hidden below 780px, so on a phone the
 * strongest control was a duplicate anchor while 我的项目 was unreachable.
 *
 * `sales={false}` suppresses the call to action for working surfaces - the
 * support console is not a place to sell.
 */
export function SiteHeader({ home = false, sales = true }: { home?: boolean; sales?: boolean }) {
  if (home) {
    // The home page is the upload entry. A button pointing at it would scroll
    // the page to itself, so the slot holds only the account.
    return (
      <header className="site-header home-site-header">
        <div className="shell header-inner">
          <Link className="brand brand-hey" href="/" aria-label="Hey 首页">
            Hey
          </Link>
          <nav className="header-actions" aria-label="账户操作">
            <AccountControl showProjectsWhenAuthenticated />
          </nav>
        </div>
      </header>
    );
  }

  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link className="brand brand-hey" href="/" aria-label="Hey 首页">
          Hey
        </Link>
        <div className="secondary-header-right">
          <nav className="primary-nav" aria-label="主导航">
            {/* Kept visible on narrow screens: it is where a returning
                customer's work lives, and it was the casualty of hiding the
                whole nav on a phone. */}
            <Link className="primary-nav-projects" href="/projects">我的项目</Link>
            <Link className="primary-nav-client" href="/download-client" target="_blank">
              下载客户端
            </Link>
          </nav>
          <nav className="header-actions" aria-label="账户操作">
            <AccountControl />
            {sales ? (
              <Link className="header-purchase" href="/#start">
                开始制作
              </Link>
            ) : null}
          </nav>
        </div>
      </div>
    </header>
  );
}
