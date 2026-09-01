import type { ReactNode } from "react";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

/**
 * `wide` opts a page out of the shell's reading width. The customer pages are
 * measured for prose; the support console is a working surface where a failure
 * code, a QA reason or an ID must be readable in full rather than wrapped or
 * clipped to fit a column meant for sentences.
 */
export function PageShell({
  children,
  compact = false,
  wide = false,
  sales = true,
}: {
  children: ReactNode;
  compact?: boolean;
  wide?: boolean;
  sales?: boolean;
}) {
  const shell = wide ? "shell shell-wide" : "shell";
  return (
    <div className="site-shell">
      <SiteHeader sales={sales} />
      <main className={`${shell} page-main page-space${compact ? " narrow-page compact-page" : ""}`}>{children}</main>
      <SiteFooter />
    </div>
  );
}
