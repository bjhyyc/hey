import type { ReactNode } from "react";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

export function PageShell({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main className={`shell page-main page-space${compact ? " narrow-page compact-page" : ""}`}>{children}</main>
      <SiteFooter />
    </div>
  );
}
