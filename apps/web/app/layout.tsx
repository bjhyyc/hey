import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { HOME_DESCRIPTION, HOME_TITLE, ORGANIZATION_LD, PRODUCT_LD, SITE_NAME, SITE_URL, WEBSITE_LD, jsonLd } from "@/lib/seo";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: HOME_TITLE,
    template: "%s · Hey"
  },
  description: HOME_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    siteName: SITE_NAME,
    locale: "zh_CN",
    type: "website"
  },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        {/* What the site is, as data: the organisation, the site, and the one
            product with its price. Pages add their own blocks. */}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(ORGANIZATION_LD) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(WEBSITE_LD) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(PRODUCT_LD) }} />
      </body>
    </html>
  );
}
