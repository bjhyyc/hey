const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/duzexu/desktop-pet/releases/latest";

const OFFICIAL_LINKS = Object.freeze({
  website: "https://duzexu.github.io/desktop-pet/",
  github: "https://github.com/duzexu/desktop-pet",
  changelog: "https://github.com/duzexu/desktop-pet/blob/master/CHANGELOG.md",
  update: "https://github.com/duzexu/desktop-pet/releases/latest"
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

async function checkForUpdates({ fetchImpl, currentVersion, timeoutMs = 15000 }) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Update checker is unavailable");
  }

  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  if (!normalizedCurrentVersion) {
    throw new TypeError("Current application version is invalid");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timeout.unref === "function") timeout.unref();

  try {
    const response = await fetchImpl(GITHUB_LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Desktop-Pet"
      },
      signal: controller.signal
    });
    if (!response || response.ok !== true) {
      const status = response && Number.isFinite(Number(response.status)) ? ` (${response.status})` : "";
      throw new Error(`Update check failed${status}`);
    }

    const release = await response.json();
    const latestVersion = normalizeVersion(release && release.tag_name);
    if (!latestVersion) {
      throw new Error("Latest release version is invalid");
    }

    return {
      ok: true,
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
  GITHUB_LATEST_RELEASE_API,
  OFFICIAL_LINKS,
  checkForUpdates,
  compareVersions,
  getOfficialLink,
  normalizeVersion
};
