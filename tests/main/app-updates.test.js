import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  GITHUB_LATEST_RELEASE_API,
  OFFICIAL_LINKS,
  checkForUpdates,
  compareVersions,
  getOfficialLink,
  normalizeVersion
} = require("../../src/main/services/app-updates");

describe("application updates", () => {
  it("normalizes and compares semantic versions", () => {
    expect(normalizeVersion("v1.2")).toBe("1.2.0");
    expect(normalizeVersion("1.2.3-beta.1")).toBe("1.2.3");
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  it("returns an available update from the latest GitHub release", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      tag_name: "v0.2.0",
      name: "Desktop Pet v0.2.0"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    const result = await checkForUpdates({ fetchImpl, currentVersion: "0.1.0" });

    expect(result).toEqual({
      ok: true,
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
      releaseName: "Desktop Pet v0.2.0",
      releaseUrl: OFFICIAL_LINKS.update
    });
    expect(fetchImpl).toHaveBeenCalledWith(GITHUB_LATEST_RELEASE_API, expect.objectContaining({
      headers: expect.objectContaining({ Accept: "application/vnd.github+json" }),
      signal: expect.any(AbortSignal)
    }));
  });

  it("reports the current version as latest when versions match", async () => {
    const result = await checkForUpdates({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ tag_name: "v0.1.0" }), { status: 200 })),
      currentVersion: "0.1.0"
    });

    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe("0.1.0");
  });

  it("only returns allowlisted official links", () => {
    expect(getOfficialLink("website")).toBe(OFFICIAL_LINKS.website);
    expect(getOfficialLink("update")).toBe(OFFICIAL_LINKS.update);
    expect(getOfficialLink("https://example.com")).toBe("");
  });
});
