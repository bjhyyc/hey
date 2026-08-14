const { CHARACTER_CANVAS_V1 } = require("./character-canvas-v1");

function parseFrameRate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value || "");
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const [numerator, denominator] = raw.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

function getVideoStream(probe) {
  return Array.isArray(probe && probe.streams)
    ? probe.streams.find((stream) => stream && stream.codec_type === "video")
    : null;
}

function getAudioStreams(probe) {
  return Array.isArray(probe && probe.streams)
    ? probe.streams.filter((stream) => stream && stream.codec_type === "audio")
    : [];
}

function validateActionMediaProbe(probe, {
  canvas = CHARACTER_CANVAS_V1,
  expectedFps = CHARACTER_CANVAS_V1.fps,
  allowedVideoCodecs = ["vp9", "av1", "h264"],
  allowedFormatNames,
  expectedDuration,
  maxDurationDeltaSeconds = 2 / CHARACTER_CANVAS_V1.fps,
  enforceExactFrameCount = true
} = {}) {
  const errors = [];
  const video = getVideoStream(probe);
  if (!video) {
    return { ok: false, errors: ["No video stream found"] };
  }
  if (Number(video.width) !== canvas.width || Number(video.height) !== canvas.height) {
    errors.push(`Video must be ${canvas.width}x${canvas.height}`);
  }
  const fps = parseFrameRate(video.avg_frame_rate || video.r_frame_rate);
  if (Math.abs(fps - expectedFps) > 0.01) {
    errors.push(`Video must be ${expectedFps} fps`);
  }
  if (!allowedVideoCodecs.includes(String(video.codec_name || "").toLowerCase())) {
    errors.push("Video codec is not supported by the client media profile");
  }
  if (getAudioStreams(probe).length > 0) {
    errors.push("Video must not contain audio streams");
  }
  const formatNames = String(probe?.format?.format_name || "")
    .toLowerCase()
    .split(",")
    .filter(Boolean);
  if (Array.isArray(allowedFormatNames) && !allowedFormatNames.some((name) => formatNames.includes(String(name).toLowerCase()))) {
    errors.push("Video container is not supported by the client media profile");
  }
  const duration = Number(video.duration ?? probe?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    errors.push("Video duration must be positive");
  }
  if (Number.isFinite(Number(expectedDuration)) && Number.isFinite(duration) &&
      Math.abs(duration - Number(expectedDuration)) > Number(maxDurationDeltaSeconds)) {
    errors.push("Video duration changed during media normalization");
  }
  const declaredFrameCount = Number(video.nb_frames);
  const frameCount = Number.isSafeInteger(declaredFrameCount) && declaredFrameCount > 0
    ? declaredFrameCount
    : (Number.isFinite(duration) && fps > 0 ? Math.round(duration * fps) : 0);
  if (enforceExactFrameCount && Number.isFinite(Number(expectedDuration))) {
    const expectedFrameCount = Math.round(Number(expectedDuration) * Number(expectedFps));
    if (!Number.isSafeInteger(expectedFrameCount) || expectedFrameCount < 1 || frameCount !== expectedFrameCount) {
      errors.push(`Video must contain exactly ${expectedFrameCount} frames`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    summary: {
      codec: video.codec_name || "",
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      fps,
      duration: Number.isFinite(duration) ? duration : 0,
      frameCount,
      formatNames,
      audioStreams: getAudioStreams(probe).length
    }
  };
}

module.exports = {
  getAudioStreams,
  getVideoStream,
  parseFrameRate,
  validateActionMediaProbe
};
