import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  RELEASE_FEED_URL,
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

  it("returns an available update from this product's release feed", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      version: "0.2.0",
      name: "Hey v0.2.0"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    const result = await checkForUpdates({
      fetchImpl,
      currentVersion: "0.1.0",
      feedUrl: "https://example.test/client/latest.json"
    });

    expect(result).toEqual({
      ok: true,
      unavailable: false,
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
      releaseName: "Hey v0.2.0",
      releaseUrl: OFFICIAL_LINKS.update
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/client/latest.json", expect.objectContaining({
      headers: expect.objectContaining({ Accept: "application/json" }),
      signal: expect.any(AbortSignal)
    }));
  });

  it("also reads a releases API, which reports the version as a tag", async () => {
    const result = await checkForUpdates({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ tag_name: "v0.1.0" }), { status: 200 })),
      currentVersion: "0.1.0",
      feedUrl: "https://example.test/releases/latest"
    });

    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe("0.1.0");
  });

  it("says it cannot tell when no release feed is published", async () => {
    // The shipped default. Reporting "up to date" here would assert something
    // about releases nobody has looked at, so the check refuses to.
    const fetchImpl = vi.fn();
    const result = await checkForUpdates({ fetchImpl, currentVersion: "1.0.0", feedUrl: "" });

    expect(result.ok).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps every official link on this product's own site", () => {
    // The client used to check for updates against the upstream project it
    // derives from, and to offer that project's repository, website and
    // changelog in its About panel. Nothing the customer can reach may point
    // at another project again - least of all the update check, which compared
    // this build against a different product's version line.
    for (const [name, url] of Object.entries(OFFICIAL_LINKS)) {
      expect(url, name).toMatch(/^https:\/\/(www\.)?heyirmy\.com(\/|$)/);
    }
    expect(JSON.stringify(OFFICIAL_LINKS)).not.toMatch(/duzexu|desktop-pet|github/i);
    expect(RELEASE_FEED_URL).not.toMatch(/duzexu|desktop-pet/i);
  });

  it("only returns allowlisted official links", () => {
    expect(getOfficialLink("website")).toBe(OFFICIAL_LINKS.website);
    expect(getOfficialLink("update")).toBe(OFFICIAL_LINKS.update);
    expect(getOfficialLink("https://example.com")).toBe("");
  });
});
