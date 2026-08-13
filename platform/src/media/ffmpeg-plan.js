const { CHARACTER_CANVAS_V1 } = require("../qa/character-canvas-v1");

function assertFiniteInRange(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return number;
}

function requireWorkerPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

/**
 * Builds argv for a worker-local FFmpeg process. It never invokes a shell, so
 * object keys and user names cannot become command text. Segmentation/QA must
 * provide a bounded geometric correction before this plan is used.
 */
function createVideoNormalizationPlan({ inputPath, mattePath, outputPath, correction = {} } = {}) {
  // Do not crop to compensate for an oversized generated pet. If a frame needs
  // enlargement beyond its canvas, QA must reject/requeue it instead.
  const scale = assertFiniteInRange(correction.scale ?? 1, "correction.scale", 0.9, 1);
  const offsetX = assertFiniteInRange(correction.offsetX ?? 0, "correction.offsetX", -80, 80);
  const offsetY = assertFiniteInRange(correction.offsetY ?? 0, "correction.offsetY", -80, 80);
  const scaledWidth = Math.round(CHARACTER_CANVAS_V1.width * scale);
  const scaledHeight = Math.round(CHARACTER_CANVAS_V1.height * scale);
  const basePadX = Math.floor((CHARACTER_CANVAS_V1.width - scaledWidth) / 2);
  const basePadY = Math.floor((CHARACTER_CANVAS_V1.height - scaledHeight) / 2);
  if (Math.abs(offsetX) > basePadX || Math.abs(offsetY) > basePadY) {
    throw new Error("Geometric correction would crop the character canvas");
  }
  const padX = Math.round(basePadX + offsetX);
  const padY = Math.round(basePadY + offsetY);
  const normalize = `fps=${CHARACTER_CANVAS_V1.fps},scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=decrease,pad=${CHARACTER_CANVAS_V1.width}:${CHARACTER_CANVAS_V1.height}:${padX}:${padY}:color=black,setsar=1`;
  const filterComplex = [
    `[0:v]${normalize},format=rgba[pet]`,
    `[1:v]${normalize},format=gray[matte]`,
    "[pet][matte]alphamerge[cutout]",
    `color=c=0x00ff00:s=${CHARACTER_CANVAS_V1.width}x${CHARACTER_CANVAS_V1.height}:r=${CHARACTER_CANVAS_V1.fps}[background]`,
    "[background][cutout]overlay=shortest=1:format=auto,format=yuv420p[outv]"
  ].join(";");
  return {
    executable: "ffmpeg",
    args: [
      "-y",
      "-i", requireWorkerPath(inputPath, "Worker input path"),
      "-i", requireWorkerPath(mattePath, "Worker matte path"),
      "-filter_complex", filterComplex,
      "-map", "[outv]",
      "-an",
      "-c:v", "libvpx-vp9",
      "-pix_fmt", "yuv420p",
      "-r", String(CHARACTER_CANVAS_V1.fps),
      requireWorkerPath(outputPath, "Worker output path")
    ],
    mediaProfile: {
      width: CHARACTER_CANVAS_V1.width,
      height: CHARACTER_CANVAS_V1.height,
      fps: CHARACTER_CANVAS_V1.fps,
      codec: "vp9",
      audio: false,
      matteMode: "green-screen"
    }
  };
}

module.exports = { createVideoNormalizationPlan };
