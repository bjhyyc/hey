import { describe, expect, it } from "vitest";
import { renderSystem } from "../../src/renderer/panel/tabs/system";

function createState(overrides = {}) {
  return {
    savingKey: "",
    systemLaunchAtLogin: false,
    aboutInfo: { version: "0.1.0" },
    updateCheck: { status: "idle" },
    logSettings: {},
    logFiles: [],
    selectedLogFile: "",
    logLoading: false,
    logContent: "",
    logTruncated: false,
    ...overrides
  };
}

const config = {
  system: {
    language: "en",
    logging: { enabled: true, level: "info" }
  }
};

describe("system tab about section", () => {
  it("shows version, the official-site link, and the update check action", () => {
    const html = renderSystem(createState(), config);

    expect(html).toContain("About");
    expect(html).toContain("v0.1.0");
    expect(html).toContain('data-target="website"');
    expect(html).toContain('data-action="check-for-updates"');
    expect(html).not.toContain('data-target="update"');
    // The About panel used to offer the upstream project this client derives
    // from - its repository, its changelog, its name - to paying customers.
    expect(html).not.toContain('data-target="github"');
    expect(html).not.toContain('data-target="changelog"');
    expect(html).not.toContain("Desktop Pet");
  });

  it("says it cannot tell when no release feed is published", () => {
    const html = renderSystem(createState({
      updateCheck: { status: "unavailable", currentVersion: "0.1.0" }
    }), config);

    expect(html).toContain("Update information is unavailable.");
    // Not the "up to date" line: that would assert something about releases
    // nobody has looked at.
    expect(html).not.toContain("is up to date.");
    expect(html).not.toContain('data-target="update"');
  });

  it("shows an update button only when a newer version is available", () => {
    const html = renderSystem(createState({
      updateCheck: {
        status: "available",
        currentVersion: "0.1.0",
        latestVersion: "0.2.0"
      }
    }), config);

    expect(html).toContain("Version 0.2.0 is available.");
    expect(html).toContain('data-target="update"');
    expect(html).toContain("Update to v0.2.0");
  });

  it("shows the latest-version message without an update button", () => {
    const html = renderSystem(createState({
      updateCheck: {
        status: "latest",
        currentVersion: "0.1.0",
        latestVersion: "0.1.0"
      }
    }), config);

    expect(html).toContain("Hey v0.1.0 is up to date.");
    expect(html).not.toContain('data-target="update"');
  });
});
