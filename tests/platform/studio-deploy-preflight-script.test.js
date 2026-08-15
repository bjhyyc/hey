import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const script = fs.readFileSync(
  path.join(root, "ops", "lighthouse", "app", "verify-studio-production.sh"),
  "utf8"
);

describe("read-only Studio production preflight", () => {
  it("requires immutable images, production mode, 480p, and disabled simulation", () => {
    expect(script).toContain('"${PETPACK_PLATFORM_MODE:-}" == "production"');
    expect(script).toContain('"${KAIPAY_ALLOW_SIMULATED_PAYMENTS:-false}" != "true"');
    expect(script).toContain('"${MODELARK_VIDEO_RESOLUTION:-}" == "480p"');
    expect(script).toContain('"${PETPACK_RUNTIME_IMAGE:-}" == *@sha256:*');
    expect(script).toContain('"${PETPACK_WORKER_IMAGE:-}" == *@sha256:*');
  });

  it("checks every external secret without reading or printing its contents", () => {
    for (const name of [
      "postgres_url",
      "postgres_ca.pem",
      "redis_url",
      "redis_ca.pem",
      "cos_access_key_id",
      "cos_secret_access_key",
      "modelark_api_key",
      "modelark_callback_secret",
      "session_signing_key",
      "studio_internal_token",
      "payment_notification_encryption_key",
      "kaipay_credentials_json"
    ]) {
      expect(script).toContain(`  ${name}`);
    }
    expect(script).toContain("stat -c '%a'");
    expect(script).toContain("realpath -e --");
    expect(script).not.toMatch(/cat\s+.*secret|<\s*\"?\$\{?file/);
  });

  it("is read-only and cannot run destructive compose operations", () => {
    expect(script).toContain("config --quiet");
    expect(script).not.toMatch(/docker\s+compose[^\n]*(up|down|rm|pull|prune)/);
    expect(script).not.toMatch(/\brm\s+-r[fF]/);
    expect(script).not.toMatch(/docker\s+system\s+prune/);
  });
});
