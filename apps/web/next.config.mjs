/** @type {import('next').NextConfig} */
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// The site is served by CloudBase's gateway, which adds nothing of its own -
// a live check on 2026-09-18 found no HSTS, no framing protection, nothing.
// So the app sets them. The Content-Security-Policy is deliberately the part
// that cannot break anything: framing, plugins and <base> hijacking. Script
// and connection sources are left open because the phone-login SDK talks to
// CloudBase endpoints that are assembled at runtime, and an allowlist that
// missed one would take login down with no error anyone could read.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
];

const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: projectRoot },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
