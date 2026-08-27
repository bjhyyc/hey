import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const caddy = fs.readFileSync(path.resolve("ops/lighthouse/edge/Caddyfile"), "utf8");

// This file is the edge. Production ran a hand-edited copy for weeks while the
// repository's version quietly diverged: it had folded /api/auth/* into the
// studio matcher (which would have sent every login to a container that does
// not serve it) and had dropped /api/photo-precheck entirely (which would have
// 404'd the pre-check flow). Deploying the repository would have broken both.
// These assertions exist so that divergence fails here instead of in front of
// customers.

describe("Lighthouse Studio API edge allowlist", () => {
  it("publishes only the exact Kaipay V3 POST callback provider route", () => {
    expect(caddy).toContain("@kaipay_notification {");
    expect(caddy).toContain("method POST");
    expect(caddy).toContain("^/api/payments/kaipay/notify/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
    expect(caddy).not.toMatch(/path\s+\/api\/payments\/kaipay\/notify\/\*/);
    expect(caddy).not.toContain("/api/payments/alipay");
  });

  it("sends authentication to the auth container and never to the studio API", () => {
    expect(caddy).toContain("@auth path /api/auth/*");
    expect(caddy).toMatch(/handle @auth \{\s*reverse_proxy auth-api:8787/s);
    const studioMatcher = caddy.match(/@studio path (.+)/)?.[1] ?? "";
    expect(studioMatcher).not.toContain("/api/auth");
  });

  it("routes every customer-facing studio path, the pre-check included", () => {
    const studioMatcher = caddy.match(/@studio path (.+)/)?.[1] ?? "";
    for (const route of ["/api/checkout", "/api/photo-precheck", "/api/projects", "/api/projects/*", "/api/admin/*"]) {
      expect(studioMatcher).toContain(route);
    }
  });

  it("keeps readiness, the root probe and a 404 fallback", () => {
    expect(caddy).toContain("@ready path /readyz");
    expect(caddy).toContain("handle @ready");
    expect(caddy).toContain("@root path /");
    expect(caddy).toMatch(/handle\s*\{\s*respond "not found" 404/s);
  });

  it("carries HSTS on both published hosts", () => {
    expect(caddy.match(/Strict-Transport-Security "max-age=31536000; includeSubDomains"/g)?.length).toBe(2);
  });

  it("bounds request bodies above the platform's own limit, so the inner layer is the one that refuses", () => {
    expect(caddy).toMatch(/request_body\s*\{\s*max_size 16MB\s*\}/s);
  });
});
