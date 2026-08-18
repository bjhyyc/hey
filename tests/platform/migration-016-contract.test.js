import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.resolve("platform/sql/016_kaipay_fuyou_order_identity.sql");

describe("migration 016 Kaipay Fuyou immutable identity", () => {
  it("adds the wire pay method and freezes both exact Fuyou channel routes", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toContain("ADD COLUMN pay_method TEXT");
    expect(sql).toContain("pay_method IN ('alipay', 'wechat')");
    expect(sql).toContain("provider_code IN ('alipay', 'wechat', 'fuyou')");
    expect(sql).toContain("payment_channel = 'ALIPAY' AND pay_method = 'alipay'");
    expect(sql).toContain("provider_code = 'fuyou' AND payment_scene = 'native'");
    expect(sql).toContain("payment_channel = 'WXPAY' AND pay_method = 'wechat'");
    expect(sql).toContain("adapter_version = 'kaipay-pay-api-v3-hmac-sha256/1'");
    expect(sql).toContain("adapter_version NOT LIKE 'kaipay-pay-api-v3-%'");
    expect(sql).toContain("credential_version IS NOT NULL");
    expect(sql).toContain(") IS TRUE");
  });

  it("preserves nullable migration-015 history without rewriting payment rows", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toContain("pay_method IS NULL");
    expect(sql).toContain("payment_channel = 'ALIPAY' AND provider_code = 'alipay'");
    expect(sql).toContain("payment_channel = 'WXPAY' AND provider_code = 'wechat'");
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT)\s*;/im);
  });
});
