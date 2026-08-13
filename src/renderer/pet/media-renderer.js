import { createGreenScreenRenderer } from "./green-screen-renderer.js";

const VIDEO_ASSET_EXTENSIONS = new Set([".webm", ".mp4", ".mov"]);
const GIF_ASSET_EXTENSION = ".gif";
const DEFAULT_GREEN_SCREEN = {
  color: "#00ff00",
  tolerance: 0.35,
  softness: 0.08
};

export function getAssetExtension(asset) {
  const rawValue = String(asset || "");
  let pathname = rawValue;
  try {
    pathname = new URL(rawValue).pathname;
  } catch (_error) {
    pathname = rawValue.split(/[?#]/)[0];
  }

  const filename = pathname.split(/[\\/]/).filter(Boolean).pop() || "";
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

export function isVideoAsset(asset) {
  return VIDEO_ASSET_EXTENSIONS.has(getAssetExtension(asset));
}

export function isGifAsset(asset) {
  return getAssetExtension(asset) === GIF_ASSET_EXTENSION;
}

function clearImage(image) {
  if (!image) return;
  if (typeof image.removeAttribute === "function") {
    image.removeAttribute("src");
  } else {
    image.src = "";
  }
}

function stopVideo(video) {
  if (!video) return;
  if (typeof video.pause === "function") video.pause();
  video.onloadedmetadata = null;
  video.onloadeddata = null;
  video.onseeked = null;
  if (typeof video.removeAttribute === "function") {
    video.removeAttribute("src");
  } else {
    video.src = "";
  }
  video.loop = false;
  video.hidden = true;
  if (typeof video.load === "function") video.load();
}

function clearCanvas(canvas) {
  if (!canvas) return;
  const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (context && canvas.width && canvas.height) {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
  canvas.hidden = true;
}

function snapshotVideoToCanvas(video, canvas, logger = console) {
  if (!video || !canvas || video.hidden) return false;
  const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  const width = Math.round(Number(video.videoWidth) || 0);
  const height = Math.round(Number(video.videoHeight) || 0);
  if (!context || width <= 0 || height <= 0) return false;

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  try {
    context.clearRect(0, 0, width, height);
    context.drawImage(video, 0, 0, width, height);
    canvas.hidden = false;
    video.hidden = true;
    return true;
  } catch (error) {
    logger.debug("snapshotVideoToCanvas failed", { error: error && error.message ? error.message : String(error) });
    return false;
  }
}

function hasRenderableVideoFrame(video) {
  return Boolean(video && Number(video.readyState) >= 2);
}

function playVideo(video) {
  if (!video || typeof video.play !== "function") return;
  const playPromise = video.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(() => {});
  }
}

function requestFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(callback, 16);
}

function cancelFrame(frameId) {
  if (!frameId) return;
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(frameId);
  } else {
    globalThis.clearTimeout(frameId);
  }
}

function requestVideoFrame(video, callback) {
  if (video && typeof video.requestVideoFrameCallback === "function") {
    return { type: "video", id: video.requestVideoFrameCallback(callback) };
  }
  return { type: "animation", id: requestFrame(callback) };
}

function cancelVideoFrame(video, handle) {
  if (!handle) return;
  if (handle.type === "video" && video && typeof video.cancelVideoFrameCallback === "function") {
    video.cancelVideoFrameCallback(handle.id);
    return;
  }
  cancelFrame(handle.id);
}

function clampUnit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function parseHexColor(color) {
  const rawColor = typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)
    ? color
    : DEFAULT_GREEN_SCREEN.color;
  return {
    r: parseInt(rawColor.slice(1, 3), 16),
    g: parseInt(rawColor.slice(3, 5), 16),
    b: parseInt(rawColor.slice(5, 7), 16),
    hex: rawColor.toLowerCase()
  };
}

function normalizeGreenScreenConfig(greenScreen) {
  if (!greenScreen || greenScreen.enabled !== true) return null;
  return {
    enabled: true,
    color: parseHexColor(greenScreen.color),
    tolerance: clampUnit(greenScreen.tolerance, DEFAULT_GREEN_SCREEN.tolerance),
    softness: clampUnit(greenScreen.softness, DEFAULT_GREEN_SCREEN.softness)
  };
}

function clampProgress(progress) {
  const value = Number(progress);
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function setVideoProgress(video, progress) {
  if (!video) return;
  const nextProgress = clampProgress(progress);
  if (video.dataset) {
    video.dataset.keyframeProgress = String(nextProgress);
  }

  const applySeek = () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const nextTime = Math.min(video.duration, Math.max(0, video.duration * nextProgress));
    if (!Number.isFinite(nextTime)) return;
    if (video.dataset) {
      video.dataset.pendingKeyframeTime = String(nextTime);
    }
    scheduleVideoSeek(video);
  };

  if (video.readyState >= 1) {
    applySeek();
  } else {
    video.onloadedmetadata = applySeek;
  }
}

function scheduleVideoSeek(video) {
  if (!video || !video.dataset) return;

  const seekToPending = () => {
    const nextTime = Number(video.dataset.pendingKeyframeTime);
    if (!Number.isFinite(nextTime)) return;

    const currentTime = Number(video.currentTime);
    if (Number.isFinite(currentTime) && Math.abs(currentTime - nextTime) < 0.001) {
      delete video.dataset.pendingKeyframeTime;
      return;
    }

    video.currentTime = nextTime;
  };

  if (video.seeking) {
    if (video.dataset.keyframeSeekQueued === "1") return;
    video.dataset.keyframeSeekQueued = "1";
    video.onseeked = () => {
      if (video.dataset) {
        delete video.dataset.keyframeSeekQueued;
      }
      seekToPending();
    };
    return;
  }

  seekToPending();
}

function createGifFrameSnapshots(frames, width, height) {
  if (typeof document === "undefined") return [];

  const workCanvas = document.createElement("canvas");
  workCanvas.width = width;
  workCanvas.height = height;
  const workContext = workCanvas.getContext("2d");
  if (!workContext) return [];

  return frames.map((frame) => {
    const previousImageData = frame.disposalType === 3
      ? workContext.getImageData(0, 0, width, height)
      : null;
    const patch = new ImageData(new Uint8ClampedArray(frame.patch), frame.dims.width, frame.dims.height);
    workContext.putImageData(patch, frame.dims.left, frame.dims.top);
    const imageData = workContext.getImageData(0, 0, width, height);

    if (frame.disposalType === 2) {
      workContext.clearRect(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
    } else if (frame.disposalType === 3 && previousImageData) {
      workContext.putImageData(previousImageData, 0, 0);
    }

    return {
      imageData,
      delayMs: Math.max(0, Number(frame.delay || 0))
    };
  });
}

async function decodeGifFrames(asset) {
  if (!asset) return null;
  const gifuct = await import("gifuct-js");
  const { parseGIF, decompressFrames } = gifuct;

  const response = await fetch(asset);
  const buffer = await response.arrayBuffer();
  const gif = parseGIF(buffer);
  const frames = decompressFrames(gif, true);
  const width = gif.lsd.width;
  const height = gif.lsd.height;

  return {
    width,
    height,
    frames: createGifFrameSnapshots(frames, width, height)
  };
}

function getFrameIndexForProgress(frameCount, progress) {
  if (frameCount <= 1) return 0;
  return Math.min(frameCount - 1, Math.floor(clampProgress(progress) * frameCount));
}

function drawGifProgress(canvas, decodedGif, progress) {
  if (!canvas || !decodedGif || decodedGif.frames.length === 0) return false;
  const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (!context) return false;

  if (canvas.width !== decodedGif.width) canvas.width = decodedGif.width;
  if (canvas.height !== decodedGif.height) canvas.height = decodedGif.height;

  const frame = decodedGif.frames[getFrameIndexForProgress(decodedGif.frames.length, progress)];
  context.putImageData(frame.imageData, 0, 0);
  return true;
}

export function createPetMediaRenderer({
  container,
  image,
  video,
  canvas,
  greenCanvas,
  greenScreenBackendPreference = "adaptive",
  logger = console
} = {}) {
  // A canvas is permanently locked to the first context type it hands out. The
  // shared `canvas` is used by 2D paths (GIF scrubbing, frame snapshots, clears),
  // so green-screen rendering gets a dedicated canvas when available. Runtime
  // callers can then force WebGL while panel previews keep adaptive selection.
  const greenScreenCanvas = greenCanvas || canvas;
  const gifCache = new Map();
  const gifDecodes = new Map();
  // Bumped on every render() call so any in-flight async GIF decode/commit from
  // a superseded render is dropped, regardless of the newer render's media type.
  let renderToken = 0;
  let greenScreenFrameHandle = null;
  let greenScreenToken = 0;
  let activeGreenScreen = null;
  let greenScreenRenderer = null;

  // Hide whichever canvas the green-screen renderer is NOT using, so the two
  // canvases never show stale frames at the same time.
  function hideOtherCanvas(shown) {
    const hidden = shown === greenScreenCanvas ? canvas : greenScreenCanvas;
    if (hidden && hidden !== shown) hidden.hidden = true;
  }

  function stopGreenScreenRendering({ clear = false } = {}) {
    greenScreenToken += 1;
    activeGreenScreen = null;
    cancelVideoFrame(video, greenScreenFrameHandle);
    greenScreenFrameHandle = null;
    if (clear) {
      if (greenScreenRenderer) greenScreenRenderer.clear();
      if (greenScreenCanvas && greenScreenCanvas !== canvas) greenScreenCanvas.hidden = true;
    }
  }

  function holdCurrentVideoFrame(reason) {
    if (!video || video.hidden || !hasRenderableVideoFrame(video)) return false;
    try {
      let heldCanvas;
      if (greenScreenRenderer) {
        if (!greenScreenRenderer.drawRaw(video)) return false;
        heldCanvas = greenScreenCanvas;
      } else {
        if (!snapshotVideoToCanvas(video, canvas, logger)) return false;
        heldCanvas = canvas;
      }
      heldCanvas.hidden = false;
      hideOtherCanvas(heldCanvas);
      video.hidden = true;
      logger.debug("video transition frame held", {
        reason,
        asset: (container && container.dataset && container.dataset.asset) || video.src || "",
        backend: greenScreenRenderer?.backend || "canvas-2d"
      });
      return true;
    } catch (error) {
      logger.warn("video transition frame hold failed", {
        reason,
        error: error && error.message ? error.message : String(error)
      });
      return false;
    }
  }

  function renderPlainVideo(asset, { loop = false, keyframe = false, progress = 0 } = {}) {
    stopGreenScreenRendering();
    if (video) {
      const assetChanged = video.src !== asset;
      if (assetChanged) {
        holdCurrentVideoFrame("plain-video-switch");
      }
      video.muted = true;
      video.playsInline = true;
      video.loop = keyframe ? false : Boolean(loop);
      video.onseeked = null;
      video.onerror = () => {
        logger.warn("video load error", { asset });
        clearCanvas(canvas);
        if (greenScreenCanvas !== canvas) greenScreenCanvas.hidden = true;
        clearImage(image);
        if (image) image.hidden = true;
        video.hidden = true;
      };
      const showVideo = () => {
        if (!hasRenderableVideoFrame(video)) {
          logger.debug("video not yet renderable", { asset, readyState: Number(video.readyState) });
          return;
        }
        clearCanvas(canvas);
        if (greenScreenCanvas !== canvas) greenScreenCanvas.hidden = true;
        clearImage(image);
        if (image) image.hidden = true;
        video.hidden = false;
        if (keyframe) {
          if (typeof video.pause === "function") video.pause();
          setVideoProgress(video, progress);
        } else {
          playVideo(video);
        }
      };
      video.onloadedmetadata = keyframe ? () => setVideoProgress(video, progress) : null;
      video.onloadeddata = showVideo;
      if (assetChanged) {
        video.src = asset;
        if (typeof video.load === "function") video.load();
      }
      if (!assetChanged && hasRenderableVideoFrame(video)) {
        showVideo();
      } else if (!assetChanged && keyframe && video.readyState >= 1) {
        setVideoProgress(video, progress);
      } else if (!keyframe) {
        playVideo(video);
      }
    }
    return keyframe ? "keyframe-video" : "video";
  }

  function renderGreenScreenVideo(asset, options = {}, greenScreen) {
    const normalizedGreenScreen = normalizeGreenScreenConfig(greenScreen);
    if (!normalizedGreenScreen) {
      return renderPlainVideo(asset, options);
    }
    if (!greenScreenRenderer) {
      greenScreenRenderer = createGreenScreenRenderer({
        canvas: greenScreenCanvas,
        container,
        logger,
        backendPreference: greenScreenBackendPreference
      });
    }
    if (!video || !greenScreenCanvas || !greenScreenRenderer) {
      logger.warn("green screen fallback: canvas video rendering unavailable", {
        hasVideo: Boolean(video),
        hasCanvas: Boolean(greenScreenCanvas),
        hasRenderer: Boolean(greenScreenRenderer)
      });
      return renderPlainVideo(asset, options);
    }

    stopGreenScreenRendering();

    const token = ++greenScreenToken;
    activeGreenScreen = {
      config: normalizedGreenScreen,
      keyframe: Boolean(options.keyframe)
    };

    const assetChanged = video.src !== asset;
    if (assetChanged) {
      holdCurrentVideoFrame("green-screen-video-switch");
    }
    video.muted = true;
    video.playsInline = true;
    video.loop = options.keyframe ? false : Boolean(options.loop);
    video.onerror = () => {
      logger.warn("green screen video load error", { asset });
      stopGreenScreenRendering({ clear: true });
      clearCanvas(canvas);
      if (greenScreenCanvas !== canvas) greenScreenCanvas.hidden = true;
      clearImage(image);
      if (image) image.hidden = true;
      video.hidden = true;
    };
    if (assetChanged) {
      video.src = asset;
      if (typeof video.load === "function") video.load();
    }

    const draw = () => {
      if (token !== greenScreenToken) return;
      if (!hasRenderableVideoFrame(video)) return;
      try {
        greenScreenRenderer.draw(video, normalizedGreenScreen);
        clearImage(image);
        if (image) image.hidden = true;
        video.hidden = true;
        greenScreenCanvas.hidden = false;
        hideOtherCanvas(greenScreenCanvas);
      } catch (error) {
        logger.warn("green screen fallback: frame processing failed", {
          asset,
          color: normalizedGreenScreen.color.hex,
          error: error && error.message ? error.message : String(error)
        });
        renderPlainVideo(asset, options);
      }
    };

    const scheduleDraw = (continuous) => {
      if (token !== greenScreenToken || !activeGreenScreen) return;
      greenScreenFrameHandle = requestVideoFrame(video, () => {
        greenScreenFrameHandle = null;
        draw();
        if (continuous && token === greenScreenToken && activeGreenScreen && !activeGreenScreen.keyframe) {
          scheduleDraw(true);
        }
      });
    };

    const startDrawing = () => {
      if (token !== greenScreenToken) return;
      if (!hasRenderableVideoFrame(video)) {
        logger.debug("green screen video not yet renderable", { asset, readyState: Number(video.readyState) });
        return;
      }
      if (options.keyframe) {
        scheduleDraw(false);
      } else if (!greenScreenFrameHandle) {
        scheduleDraw(true);
      }
    };

    video.onloadedmetadata = options.keyframe ? () => setVideoProgress(video, options.progress) : null;
    video.onloadeddata = startDrawing;

    if (options.keyframe) {
      if (typeof video.pause === "function") video.pause();
      if (!assetChanged) setVideoProgress(video, options.progress);
      if (!assetChanged && hasRenderableVideoFrame(video)) startDrawing();
      logger.debug("green screen keyframe video rendered", {
        asset,
        color: normalizedGreenScreen.color.hex,
        tolerance: normalizedGreenScreen.tolerance,
        softness: normalizedGreenScreen.softness,
        backend: greenScreenRenderer.backend
      });
      return "green-screen-keyframe-video";
    }

    playVideo(video);
    if (!assetChanged && hasRenderableVideoFrame(video)) startDrawing();
    logger.debug("green screen video rendered", {
      asset,
      loop: Boolean(options.loop),
      color: normalizedGreenScreen.color.hex,
      tolerance: normalizedGreenScreen.tolerance,
      softness: normalizedGreenScreen.softness,
      backend: greenScreenRenderer.backend
    });
    return "green-screen-video";
  }

  return {
    render(asset, { state = "", loop = false, keyframe = false, progress = 0, greenScreen = null } = {}) {
      const token = ++renderToken;
      if (container && container.dataset) {
        container.dataset.state = state;
        container.dataset.asset = asset || "";
      }

      if (keyframe && isVideoAsset(asset)) {
        return renderGreenScreenVideo(asset, { loop, keyframe, progress }, greenScreen);
      }

      if (keyframe && isGifAsset(asset)) {
        if (video && !video.hidden && hasRenderableVideoFrame(video)) {
          holdCurrentVideoFrame("keyframe-gif-decode");
        }
        stopGreenScreenRendering();
        stopVideo(video);

        const commitDecodedGif = (decodedGif, source) => {
          if (token !== renderToken) return;
          try {
            if (!drawGifProgress(canvas, decodedGif, progress)) {
              logger.warn("keyframe gif first frame unavailable", { asset });
              return;
            }
            clearImage(image);
            if (image) image.hidden = true;
            if (video) video.hidden = true;
            if (canvas) canvas.hidden = false;
            hideOtherCanvas(canvas);
            logger.debug("keyframe gif surface committed", {
              asset,
              width: decodedGif.width,
              height: decodedGif.height,
              source
            });
          } catch (error) {
            logger.warn("keyframe gif first frame draw failed; retaining previous surface", {
              asset,
              error: error && error.message ? error.message : String(error)
            });
          }
        };

        if (gifCache.has(asset)) {
          commitDecodedGif(gifCache.get(asset), "cache");
        } else {
          if (!gifDecodes.has(asset)) {
            gifDecodes.set(asset, decodeGifFrames(asset)
              .then((decodedGif) => {
                gifCache.set(asset, decodedGif);
                gifDecodes.delete(asset);
                return decodedGif;
              })
              .catch((error) => {
                gifDecodes.delete(asset);
                throw error;
              }));
          }

          gifDecodes.get(asset)
            .then((decodedGif) => {
              commitDecodedGif(decodedGif, "decode");
            })
            .catch((error) => {
              if (token !== renderToken) return;
              logger.warn("keyframe gif decode failed; retaining previous surface", {
                asset,
                error: error && error.message ? error.message : String(error)
              });
            });
        }
        return "keyframe-gif";
      }

      if (isVideoAsset(asset)) {
        return renderGreenScreenVideo(asset, { loop, keyframe, progress }, greenScreen);
      }

      stopGreenScreenRendering();
      stopVideo(video);
      clearCanvas(canvas);
      if (greenScreenCanvas !== canvas) greenScreenCanvas.hidden = true;
      if (image) {
        image.hidden = false;
        image.src = asset || "";
      }
      return "image";
    },

    setProgress(progress) {
      const asset = (container && container.dataset && container.dataset.asset) || "";
      if (isVideoAsset(asset)) {
        setVideoProgress(video, progress);
        if (activeGreenScreen) {
          cancelVideoFrame(video, greenScreenFrameHandle);
          greenScreenFrameHandle = requestVideoFrame(video, () => {
            greenScreenFrameHandle = null;
            try {
              greenScreenRenderer.draw(video, activeGreenScreen.config);
            } catch (error) {
              logger.warn("green screen keyframe draw failed", {
                asset,
                error: error && error.message ? error.message : String(error)
              });
            }
          });
        }
        return true;
      }

      if (isGifAsset(asset) && gifCache.has(asset)) {
        drawGifProgress(canvas, gifCache.get(asset), progress);
        return true;
      }

      return false;
    },

    getCurrentAsset() {
      return (container && container.dataset && container.dataset.asset) || "";
    }
  };
}
