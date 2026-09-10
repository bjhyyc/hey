/**
 * The links the About panel offers, and the release feed the update check reads.
 *
 * This client derives from an upstream desktop-pet project, and both used to
 * point there. That was not only another project's repository sitting in our
 * product's About panel - it was another project's version line: the check
 * compared this build against that project's releases, so the first time it
 * tagged a version above ours, every customer would have been told an update
 * was available and sent to download a different application.
 */

/**
 * A URL returning `{"version": "1.0.0"}` - a GitHub-style `{"tag_name": ...}`
 * is accepted too, so a releases API can be used directly. Empty while this
 * product publishes no feed, which the check reports as "cannot tell" rather
 * than as "up to date": the latter is a claim there would be nothing to back.
 * Natural home is next to the installers, e.g. <download bucket>/client/latest.json.
 */
const RELEASE_FEED_URL = "";

const OFFICIAL_LINKS = Object.freeze({
  website: "https://heyirmy.com",
  // Where a new version actually comes from. There is no repository link: the
  // sources this client is built from are offered from the site, under the
  // terms the upstream licence requires, not from a third party's repository.
  update: "https://heyirmy.com/download-client"
});

function normalizeVersion(value) {
  const normalized = String(value || "").trim().replace(/^v/i, "").split(/[+-]/)[0];
  if (!/^\d+(?:\.\d+){0,2}$/.test(normalized)) return "";
  return normalized.split(".").map((part) => String(Number(part))).concat(["0", "0"]).slice(0, 3).join(".");
}

function compareVersions(left, right) {
  const leftVersion = normalizeVersion(left);
  const rightVersion = normalizeVersion(right);
  if (!leftVersion || !rightVersion) {
    throw new TypeError("Invalid application version");
  }

  const leftParts = leftVersion.split(".").map(Number);
  const rightParts = rightVersion.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function getOfficialLink(target) {
  return Object.prototype.hasOwnProperty.call(OFFICIAL_LINKS, target)
    ? OFFICIAL_LINKS[target]
    : "";
}

async function checkForUpdates({ fetchImpl, currentVersion, feedUrl = RELEASE_FEED_URL, timeoutMs = 15000 }) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Update checker is unavailable");
  }

  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  if (!normalizedCurrentVersion) {
    throw new TypeError("Current application version is invalid");
  }

  // No feed to read. Say so: reporting "up to date" would be asserting
  // something about releases nobody has looked at.
  if (!feedUrl) {
    return {
      ok: true,
      unavailable: true,
      currentVersion: normalizedCurrentVersion,
      latestVersion: "",
      updateAvailable: false,
      releaseName: "",
      releaseUrl: OFFICIAL_LINKS.update
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timeout.unref === "function") timeout.unref();

  try {
    const response = await fetchImpl(feedUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Hey"
      },
      signal: controller.signal
    });
    if (!response || response.ok !== true) {
      const status = response && Number.isFinite(Number(response.status)) ? ` (${response.status})` : "";
      throw new Error(`Update check failed${status}`);
    }

    const release = await response.json();
    // `version` for a plain manifest, `tag_name` so a releases API also works.
    const latestVersion = normalizeVersion(release && (release.version || release.tag_name));
    if (!latestVersion) {
      throw new Error("Latest release version is invalid");
    }

    return {
      ok: true,
      unavailable: false,
      currentVersion: normalizedCurrentVersion,
      latestVersion,
      updateAvailable: compareVersions(normalizedCurrentVersion, latestVersion) < 0,
      releaseName: String(release.name || release.tag_name || `v${latestVersion}`),
      releaseUrl: OFFICIAL_LINKS.update
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  RELEASE_FEED_URL,
  OFFICIAL_LINKS,
  checkForUpdates,
  compareVersions,
  getOfficialLink,
  normalizeVersion
};
