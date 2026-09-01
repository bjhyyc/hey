import Link from "next/link";
import { AccountControl } from "./AccountControl";

/**
 * The top-right slot carries the strongest visual weight on the page, so it
 * holds one action, and only where that action is a real destination.
 *
 * It used to hold `购买`, which pointed at `/#start` - the home page's photo
 * upload section, not a purchase - duplicating the `开始制作` link two
 * positions to its left, and on the home page scrolling to a section already
 * on screen. Replacing it with `开始制作` removed the duplicate but kept the
 * weaker half of the idea: an inner-page button whose destination is the home
 * page, which the brand mark already reaches.
 *
 * So the slot now belongs to 下载客户端 on the home page: a page of its own,
 * the thing a customer needs after their PetPack is built, and the one
 * destination in this header that nothing else duplicates. Inner pages keep it
 * as a nav link and leave the slot to the account.
 *
 * `sales={false}` suppresses it for working surfaces - the support console is
 * not a place to sell.
 */
export function SiteHeader({ home = false, sales = true }: { home?: boolean; sales?: boolean }) {
  if (home) {
    // The home page is the upload entry, so there is no "start" to offer. The
    // client download is the destination this page cannot otherwise reach.
    return (
      <header className="site-header home-site-header">
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
          </nav>
        </div>
      </div>
    </header>
  );
}
