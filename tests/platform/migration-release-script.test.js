import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const script = fs.readFileSync(
  path.join(root, "ops", "lighthouse", "data", "verify-migration-release.sh"),
  "utf8"
);

describe("read-only migration release gate", () => {
  it("requires a real directory, 15 ordered migrations, and Kaipay V3", () => {
    expect(script).toContain("realpath -e --");
    expect(script).toContain("fewer_than_15_migrations");
    expect(script).toContain("printf '%03d'");
    expect(script).toContain("015_kaipay_v3_order_identity.sql");
  });

  it("rejects unsafe SQL entries and emits checksums without applying SQL", () => {
    expect(script).toContain("! -L");
    expect(script).toContain("sha256sum");
    expect(script).not.toMatch(/psql|docker\s+run|docker\s+compose/);
    expect(script).not.toMatch(/\brm\s+-r[fF]/);
    const withoutStderrRedirect = script.replace(/>&2/g, "");
    expect(withoutStderrRedirect).not.toMatch(/>\s*[^=]/);
  });
});
