/**
 * Placeholder media for the local support-console harness. Development only.
 *
 * The console's whole point is that an administrator LOOKS at rejected
 * candidates before force-passing one, so the trial harness has to serve real
 * renderable images and a real playable video - a broken <img> would hide
 * exactly the layout problems this harness exists to surface. Images are
 * generated as SVG (no encoder needed); the video is encoded once with the
 * bundled static ffmpeg and cached in the OS temp directory.
 */

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const PALETTE = Object.freeze({
  front: ["#2f8f5b", "#8fd6ad"],
  side: ["#2f6f8f", "#8fc4d6"],
  sleep: ["#6f4f8f", "#c4a8d6"],
  fallback: ["#8f6f2f", "#d6c48f"]
});

function paletteFor(name) {
  if (name.startsWith("front")) return PALETTE.front;
  if (name.startsWith("side")) return PALETTE.side;
  if (name.startsWith("sleep")) return PALETTE.sleep;
  return PALETTE.fallback;
}

/**
 * A labelled placeholder card: the caption carries the file name so a
 * mis-wired preview URL is visible on the page rather than silently showing
 * the wrong candidate.
 */
function svgPlaceholder(name) {
  const [ink, wash] = paletteFor(name);
  const label = name.replace(/\.[a-z0-9]+$/i, "");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 854 480" width="854" height="480">` +
    `<rect width="854" height="480" fill="${wash}"/>` +
    `<circle cx="427" cy="205" r="118" fill="${ink}" opacity="0.85"/>` +
    `<ellipse cx="427" cy="392" rx="196" ry="52" fill="${ink}" opacity="0.28"/>` +
    `<text x="427" y="214" font-family="system-ui,sans-serif" font-size="34" fill="#ffffff" text-anchor="middle">FIXTURE</text>` +
    `<text x="427" y="452" font-family="system-ui,sans-serif" font-size="26" fill="${ink}" text-anchor="middle">${label}</text>` +
    `</svg>`,
    "utf8"
  );
}

async function encodeFixtureVideo(logger) {
  const cachePath = path.join(os.tmpdir(), "petpack-admin-console-fixture.webm");
  try {
    const cached = await fs.readFile(cachePath);
    if (cached.length > 0) return cached;
  } catch {
    // Not cached yet; encode below.
  }
  const ffmpegPath = require("ffmpeg-static");
  await execFileAsync(ffmpegPath, [
    "-y",
    "-f", "lavfi",
    "-i", "testsrc=size=854x480:rate=24:duration=2",
    "-c:v", "libvpx-vp9",
    "-b:v", "300k",
    "-pix_fmt", "yuv420p",
    cachePath
  ], { timeout: 120_000 });
  const encoded = await fs.readFile(cachePath);
  logger.info?.("fixture.media.video_encoded", { bytes: encoded.length });
  return encoded;
}

const IMAGE_NAMES = Object.freeze([
  "front-1.png", "front-2.png", "front-3.png",
  "side-1.png", "sleep-1.png", "sleep-2.png", "sleep-3.png",
  "front.png", "side.png", "sleep.png"
]);

const VIDEO_NAMES = Object.freeze(["roll-attempt-1.webm", "roll-attempt-2.webm", "roll-final.webm"]);

async function createFixtureMedia({ logger = console } = {}) {
  const media = new Map();
  for (const name of IMAGE_NAMES) {
    media.set(name, { contentType: "image/svg+xml", body: svgPlaceholder(name) });
  }
  let video = null;
  try {
    video = await encodeFixtureVideo(logger);
  } catch (error) {
    // A missing or failing encoder must not take the whole harness down; the
    // console then shows its own "素材不可用" branch, which is also worth seeing.
    logger.warn?.("fixture.media.video_unavailable", {
      errorName: error && error.name ? error.name : "Error",
      errorMessage: error && error.message ? error.message : ""
    });
  }
  if (video) {
    for (const name of VIDEO_NAMES) media.set(name, { contentType: "video/webm", body: video });
  }
  return media;
}

module.exports = { createFixtureMedia, svgPlaceholder };
