import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.resolve("platform/sql/012_dual_character_masters.sql");

describe("migration 012 legacy provider usage constraints", () => {
  it("drops auto-named seedream_awake checks before rewriting usage rows", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    const discoveryIndex = sql.indexOf("pg_get_constraintdef(oid) ILIKE '%operation%seedream_awake%'");
    const updateIndex = sql.indexOf(
      "UPDATE provider_usage_attempt SET operation = 'seedream_front' WHERE operation = 'seedream_awake'"
    );

    expect(discoveryIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(discoveryIndex);
    expect(sql).toContain(
      "ALTER TABLE provider_usage_attempt DROP CONSTRAINT %I"
    );
  });
});
