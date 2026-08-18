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
function createVideoNormalizationPlan({ inputPath, mattePath, outputPath, expectedDuration, correction = {} } = {}) {
  // Do not crop to compensate for an oversized generated pet. If a frame needs
  // enlargement beyond its canvas, QA must reject/requeue it instead.
  const scale = assertFiniteInRange(correction.scale ?? 1, "correction.scale", 0.9, 1);
  const offsetX = assertFiniteInRange(correction.offsetX ?? 0, "correction.offsetX", -80, 80);
  const offsetY = assertFiniteInRange(correction.offsetY ?? 0, "correction.offsetY", -80, 80);
  const duration = assertFiniteInRange(expectedDuration, "expectedDuration", 1, 60);
  const exactFrameCount = duration * CHARACTER_CANVAS_V1.fps;
  if (!Number.isSafeInteger(exactFrameCount)) {
    throw new Error("expectedDuration must resolve to an exact frame count at the character canvas frame rate");
  }
  const scaledWidth = Math.round(CHARACTER_CANVAS_V1.width * scale);
  const scaledHeight = Math.round(CHARACTER_CANVAS_V1.height * scale);
  const basePadX = Math.floor((CHARACTER_CANVAS_V1.width - scaledWidth) / 2);
  const basePadY = Math.floor((CHARACTER_CANVAS_V1.height - scaledHeight) / 2);
  if (Math.abs(offsetX) > basePadX || Math.abs(offsetY) > basePadY) {
    throw new Error("Geometric correction would crop the character canvas");
  }
  const padX = Math.round(basePadX + offsetX);
  const padY = Math.round(basePadY + offsetY);
  const normalize = `trim=start=0:end=${duration},setpts=PTS-STARTPTS,fps=${CHARACTER_CANVAS_V1.fps},scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=decrease,pad=${CHARACTER_CANVAS_V1.width}:${CHARACTER_CANVAS_V1.height}:${padX}:${padY}:color=black,setsar=1`;
  // A provider frame whose aspect ratio differs from the character canvas
  // (Seedance returns 864x496 against the 854x480 canvas) is letterboxed by the
  // pad above. `color=black` fills YUV limited-range black, whose luma is 16 —
  // not 0 — so the matte's padding would merge as alpha 16 and paint a faint
  // dark band along the padded edge. Floor the matte's near-black values so
  // padded regions are exactly transparent.
  const matteBlackFloor = 16;
  const floorMatteBlack = `lut=y='if(lte(val,${matteBlackFloor}),0,val)'`;
  const greenExcess = "max(g(X,Y)-(r(X,Y)+b(X,Y))/2,0)";
  const insetAlpha = "min(alpha(X,Y),min(alpha(X-1,Y),min(alpha(X+1,Y),min(alpha(X,Y-1),alpha(X,Y+1)))))";
  const decontaminate = `geq=r='clip(r(X,Y)+(${greenExcess})*0.5,0,255)'` +
    `:g='clip(g(X,Y)-(${greenExcess})*0.5,0,255)'` +
    `:b='clip(b(X,Y)+(${greenExcess})*0.5,0,255)'` +
    `:a='${insetAlpha}'`;
  const filterComplex = [
    `[0:v]${normalize},format=rgba[pet]`,
    `[1:v]${normalize},format=gray,${floorMatteBlack}[matte]`,
    `[pet][matte]alphamerge,${decontaminate},format=yuva420p[outv]`
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
      "-pix_fmt", "yuva420p",
      "-auto-alt-ref", "0",
      "-metadata:s:v:0", "alpha_mode=1",
      "-r", String(CHARACTER_CANVAS_V1.fps),
      "-frames:v", String(exactFrameCount),
      requireWorkerPath(outputPath, "Worker output path")
    ],
    mediaProfile: {
      width: CHARACTER_CANVAS_V1.width,
      height: CHARACTER_CANVAS_V1.height,
      fps: CHARACTER_CANVAS_V1.fps,
      duration,
      frameCount: exactFrameCount,
      codec: "vp9",
      audio: false,
      matteMode: "alpha"
    }
  };
}

module.exports = { createVideoNormalizationPlan };
