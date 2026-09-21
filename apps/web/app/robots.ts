import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

// Everything a customer can read without logging in is crawlable. Account
// pages, the payment flow, the API gateway and the admin shells are not: they
// hold nothing a search engine should show, and the admin shells would only
// advertise that the console exists.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/admin", "/projects", "/login", "/register", "/dev"]
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL
  };
}
