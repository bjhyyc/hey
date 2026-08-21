import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const caddy = fs.readFileSync(path.resolve("ops/lighthouse/edge/Caddyfile"), "utf8");

describe("Lighthouse Studio API edge allowlist", () => {
  it("publishes only the exact Kaipay V3 POST callback provider route", () => {
    expect(caddy).toContain("@kaipay_notification {");
    expect(caddy).toContain("method POST");
    expect(caddy).toContain("^/api/payments/kaipay/notify/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
    expect(caddy).not.toMatch(/path\s+\/api\/payments\/kaipay\/notify\/\*/);
    expect(caddy).not.toContain("/api/payments/alipay");
  });

  it("routes the allowlisted Studio surface to the full API and keeps a 404 fallback", () => {
    expect(caddy.match(/reverse_proxy studio-api:8787/g)?.length).toBe(3);
    expect(caddy).toContain("@ready path /readyz");
    expect(caddy).toContain("handle @ready");
    expect(caddy).toContain("@studio path /api/auth/* /api/checkout /api/projects /api/projects/* /api/admin/*");
    expect(caddy).toMatch(/handle\s*\{\s*respond "not found" 404/s);
  });

  it("bounds request bodies at the edge before they reach the application", () => {
    expect(caddy).toMatch(/request_body\s*\{\s*max_size 16MB\s*\}/s);
  });
});
