import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { requireProjectOwner, USER_ROLES } = require("../../platform/src/auth/authorization");

// Every /api/projects/:id/* route runs its project through this check. It
// used to answer differently for an id that does not exist ("Project is
// required" - a 400) and one that belongs to someone else ("Project access
// is denied" - a 403), which told anyone holding an id whether it was real.

const alice = { id: "user-alice", role: USER_ROLES.USER };
const admin = { id: "user-admin", role: USER_ROLES.ADMIN };

describe("project ownership answers the same for missing and foreign projects", () => {
  it("reports a missing project as not found", () => {
    expect(() => requireProjectOwner(alice, null)).toThrowError(/was not found/);
    expect(() => requireProjectOwner(alice, {})).toThrowError(/was not found/);
  });

  it("reports someone else's project with the very same words", () => {
    expect(() => requireProjectOwner(alice, { id: "p1", userId: "user-bob" })).toThrowError(/was not found/);
  });

  it("still admits the owner and an administrator", () => {
    const project = { id: "p1", userId: alice.id };
    expect(requireProjectOwner(alice, project)).toBe(project);
    expect(requireProjectOwner(admin, { id: "p2", userId: "user-bob" })).toEqual({ id: "p2", userId: "user-bob" });
  });
});
