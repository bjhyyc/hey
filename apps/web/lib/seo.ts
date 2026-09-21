import type { Metadata } from "next";

/**
 * One place for what search engines and link previews see. Titles lead with
 * what a customer would actually type - making a desktop pet of their OWN pet
 * from photos - rather than the category word alone; the brand's line about
 * missing a pet stays in descriptions, where it reads as a reason to click and
 * not as a keyword. Nothing here names a model or a pipeline stage.
 */

export const SITE_URL = "https://www.heyirmy.com";
export const SITE_NAME = "Hey";
export const PRICE_YUAN = 78;

export const HOME_TITLE = "Hey — 桌面宠物制作";
export const HOME_DESCRIPTION =
  "上传 3–4 张宠物照片，约 20 分钟做出一只会打喷嚏、打滚、伸懒腰、舔脚、睡觉的桌面宠物，一次买断，Windows 和 macOS 都能用。把思念带回桌面。";

/** Metadata shared by every page; pages override title, description and path. */
export function pageMetadata({
  title,
  description,
  path,
  noIndex = false
}: {
  title: string;
  description: string;
  path: string;
  noIndex?: boolean;
}): Metadata {
  const url = `${SITE_URL}${path}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      locale: "zh_CN",
      type: "website"
    },
    twitter: { card: "summary_large_image", title, description },
    robots: noIndex ? { index: false, follow: false } : { index: true, follow: true }
  };
}

/** Serialises structured data for a <script type="application/ld+json">. */
export function jsonLd(data: Record<string, unknown>): string {
  // "<" cannot appear in a JSON script block unescaped.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export const ORGANIZATION_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/opengraph-image`
};

export const WEBSITE_LD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE_NAME,
  url: SITE_URL,
  inLanguage: "zh-CN"
};

export const PRODUCT_LD = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Hey 桌面宠物素材包",
  description: "用你自己宠物的照片生成的桌面宠物素材包，含七个动作，导入 Hey 桌宠客户端即可使用。",
  brand: { "@type": "Brand", name: SITE_NAME },
  offers: {
    "@type": "Offer",
    price: String(PRICE_YUAN),
    priceCurrency: "CNY",
    availability: "https://schema.org/InStock",
    url: `${SITE_URL}/`
  }
};

export const SOFTWARE_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Hey 桌宠客户端",
  applicationCategory: "DesktopEnhancementApplication",
  operatingSystem: "Windows 10/11, macOS",
  offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
  url: `${SITE_URL}/download-client`
};
