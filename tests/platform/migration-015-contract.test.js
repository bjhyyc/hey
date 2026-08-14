import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.resolve("platform/sql/015_kaipay_v3_order_identity.sql");

describe("migration 015 Kaipay V3 immutable identity", () => {
  it("freezes the credential version and provider route for every V3 payment attempt", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    for (const column of ["credential_version", "payment_channel", "provider_code", "payment_scene"]) {
      expect(sql).toContain(`ADD COLUMN ${column} TEXT`);
    }
    expect(sql).toContain("adapter_version NOT LIKE 'kaipay-pay-api-v3-%'");
    expect(sql).toContain("payment_channel = 'ALIPAY' AND provider_code = 'alipay'");
    expect(sql).toContain("payment_channel = 'WXPAY' AND provider_code = 'wechat' AND payment_scene = 'native'");
  });

  it("deduplicates provider webhook event IDs while retaining historical nullable rows", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toContain("ADD COLUMN provider_event_id TEXT");
    expect(sql).toContain("CREATE UNIQUE INDEX payment_event_provider_event_unique_idx");
    expect(sql).toContain("WHERE provider_event_id IS NOT NULL");
    expect(sql).toContain("credential_version IS NULL OR credential_version ~ '^kpv3-[a-f0-9]{64}$'");
  });
});
