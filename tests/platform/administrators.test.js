import { describe, expect, it, vi } from "vitest";

import administratorsModule from "../../platform/src/runtime/administrators.js";
import fixtureModule from "../../platform/src/development/start-admin-console-fixture.js";

// Nothing on the network can grant the admin role - phone signup always writes
// role='user' and no endpoint changes a role - so the console owner is decided
// entirely by whoever holds the database credentials. These tests pin the two
// properties that makes safe: an appointment leaves exactly one administrator,
// and it cannot happen by accident.

const { appointAdministrator, listAdministrators, revokeAdministrator } = administratorsModule;
const { assertLocalOnly } = fixtureModule;

const ADMIN_ID = "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f";
const OTHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function scriptedDatabase(script) {
  const executed = [];
  return {
    executed,
    async transaction(callback) {
      return callback({
        query: async (sql, params) => {
          executed.push({ sql, params });
          for (const [pattern, result] of script) {
            if (sql.includes(pattern)) return typeof result === "function" ? result(sql, params) : result;
          }
          return { rows: [] };
        }
      });
    }
  };
}

describe("appointAdministrator", () => {
  it("promotes an active account and records the grant", async () => {
    const database = scriptedDatabase([
      ["SELECT id, role, status FROM app_user", { rows: [{ id: ADMIN_ID, role: "user", status: "active" }] }],
      ["WHERE role = 'admin' AND id <>", { rows: [] }],
      ["UPDATE app_user SET role = 'admin'", { rows: [{ id: ADMIN_ID, role: "admin" }] }],
      ["INSERT INTO audit_event", { rows: [] }]
    ]);
    const result = await appointAdministrator({ database, userId: ADMIN_ID, idFactory: () => OTHER_ID });
    expect(result).toMatchObject({ id: ADMIN_ID, role: "admin", demoted: 0 });
    const audit = database.executed.find((entry) => entry.sql.includes("INSERT INTO audit_event"));
    expect(audit.sql).toContain("admin_role_granted");
  });

  it("refuses a second administrator unless the replacement is explicit", async () => {
    const script = [
      ["SELECT id, role, status FROM app_user", { rows: [{ id: ADMIN_ID, role: "user", status: "active" }] }],
      ["WHERE role = 'admin' AND id <>", { rows: [{ id: OTHER_ID }] }],
      ["UPDATE app_user SET role = 'admin'", { rows: [{ id: ADMIN_ID, role: "admin" }] }],
      ["INSERT INTO audit_event", { rows: [] }],
      ["UPDATE app_user SET role = 'user'", { rows: [] }]
    ];
    await expect(appointAdministrator({ database: scriptedDatabase(script), userId: ADMIN_ID }))
      .rejects.toThrowError(/--replace/);

    const replacing = scriptedDatabase(script);
    const result = await appointAdministrator({
      database: replacing,
      userId: ADMIN_ID,
      replaceExisting: true,
      idFactory: () => OTHER_ID
    });
    // The invariant is "exactly one": the other holder is demoted in the same
    // transaction that grants the role.
    expect(result.demoted).toBe(1);
    const demotion = replacing.executed.find((entry) => entry.sql.includes("UPDATE app_user SET role = 'user'"));
    expect(demotion.params).toEqual([OTHER_ID]);
    expect(replacing.executed.some((entry) => entry.sql.includes("admin_role_revoked"))).toBe(true);
  });

  it("refuses an unknown account, a disabled one, and a malformed ID", async () => {
    await expect(appointAdministrator({
      database: scriptedDatabase([["SELECT id, role, status FROM app_user", { rows: [] }]]),
      userId: ADMIN_ID
    })).rejects.toThrowError(/sign in once on the site first/);

    await expect(appointAdministrator({
      database: scriptedDatabase([["SELECT id, role, status FROM app_user", { rows: [{ id: ADMIN_ID, role: "user", status: "disabled" }] }]]),
      userId: ADMIN_ID
    })).rejects.toThrowError(/disabled account/);

    await expect(appointAdministrator({ database: scriptedDatabase([]), userId: "13577380832" }))
      .rejects.toThrowError(/must be a UUID/);
  });
});

describe("listAdministrators", () => {
  it("truncates the opaque provider subject and never selects a phone number", async () => {
    const database = scriptedDatabase([
      ["WHERE app_user.role = 'admin'", { rows: [{
        id: ADMIN_ID, status: "active", created_at: "2026-08-01T00:00:00.000Z",
        provider: "TENCENT_CLOUDBASE", provider_subject: "sub_abcdefghijklmnop", last_login_at: "2026-08-21T00:00:00.000Z"
      }] }],
      ["ORDER BY identity.last_login_at DESC", { rows: [{ id: OTHER_ID, role: "user", status: "active", last_login_at: "2026-08-21T01:00:00.000Z" }] }]
    ]);
    const result = await listAdministrators({ database });
    expect(result.administrators[0].providerSubject).toBe("sub_abcd…");
    expect(result.recentLogins[0].id).toBe(OTHER_ID);
    for (const entry of database.executed) {
      expect(entry.sql.toLowerCase()).not.toContain("phone");
    }
  });
});

describe("revokeAdministrator", () => {
  it("demotes a current administrator and refuses anyone else", async () => {
    const database = scriptedDatabase([
      ["UPDATE app_user SET role = 'user'", { rows: [{ id: ADMIN_ID }] }],
      ["INSERT INTO audit_event", { rows: [] }]
    ]);
    await expect(revokeAdministrator({ database, userId: ADMIN_ID, idFactory: () => OTHER_ID }))
      .resolves.toMatchObject({ id: ADMIN_ID, role: "user" });

    await expect(revokeAdministrator({
      database: scriptedDatabase([["UPDATE app_user SET role = 'user'", { rows: [] }]]),
      userId: ADMIN_ID
    })).rejects.toThrowError(/not an administrator/);
  });
});

describe("the console fixture refuses to run anywhere real", () => {
  it("stops on a production marker or any real credential", () => {
    for (const environment of [
      { PETPACK_PLATFORM_MODE: "production" },
      { NODE_ENV: "production" },
      { PETPACK_POSTGRES_URL: "postgres://user@host/db" },
      { MODELARK_API_KEY: "secret" }
    ]) {
      expect(() => assertLocalOnly(environment)).toThrowError();
    }
    expect(() => assertLocalOnly({ NODE_ENV: "development" })).not.toThrow();
  });
});
