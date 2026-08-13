import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPetMediaRenderer,
  getAssetExtension,
  isVideoAsset
} from "../../src/renderer/pet/media-renderer";
import {
  createGreenScreenRenderer,
  getGreenScreenRenderSize,
  selectGreenScreenBackendKind,
  WEBGL_MIN_TARGET_PIXELS
} from "../../src/renderer/pet/green-screen-renderer";

vi.mock("gifuct-js", () => ({
  parseGIF: vi.fn(() => ({ lsd: { width: 2, height: 1 } })),
  decompressFrames: vi.fn(() => ([{
    patch: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]),
    dims: { left: 0, top: 0, width: 2, height: 1 },
    disposalType: 0,
    delay: 20
  }]))
}));

function createMediaElements() {
  const container = { dataset: {} };
  const image = {
    hidden: false,
    src: "",
    removeAttribute: vi.fn((name) => {
      if (name === "src") image.src = "";
    })
  };
  const video = {
    dataset: {},
    hidden: true,
    muted: false,
    playsInline: false,
    loop: false,
    src: "",
    readyState: 2,
    duration: 4,
    currentTime: 0,
    videoWidth: 2,
    videoHeight: 1,
    onloadedmetadata: null,
    onloadeddata: null,
    onseeked: null,
    pause: vi.fn(),
    load: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    removeAttribute: vi.fn((name) => {
      if (name === "src") video.src = "";
    })
  };
  return { container, image, video };
}

describe("pet media renderer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("detects video assets from paths and file URLs", () => {
    expect(getAssetExtension("assets/wave.MP4?cache=1")).toBe(".mp4");
    expect(getAssetExtension("file:///pets/idle.svg")).toBe(".svg");
    expect(isVideoAsset("file:///pets/wave.webm")).toBe(true);
    expect(isVideoAsset("file:///pets/wave.MOV?v=1")).toBe(true);
    expect(isVideoAsset("assets/wave.gif")).toBe(false);
  });

  it("renders at the physical display size while preserving source aspect ratio", () => {
    const size = getGreenScreenRenderSize(
      { videoWidth: 1920, videoHeight: 1080 },
      {},
      { getBoundingClientRect: () => ({ width: 232, height: 232 }) },
      2
    );

    expect(size).toMatchObject({
      width: 464,
      height: 464,
      drawX: 0,
      drawY: 102,
      drawWidth: 464,
      drawHeight: 261,
      devicePixelRatio: 2
    });
  });

  it("selects canvas-2d for small green-screen targets and webgl for large targets", () => {
    expect(selectGreenScreenBackendKind({ width: 228, height: 228 })).toBe("canvas-2d");
    expect(selectGreenScreenBackendKind({ width: 512, height: 512 })).toBe("webgl");
    expect(WEBGL_MIN_TARGET_PIXELS).toBe(512 * 512);
  });

  it("tries WebGL for a small runtime target when explicitly preferred and falls back to Canvas2D", () => {
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
      putImageData: vi.fn()
    };
    const canvas = {
      width: 32,
      height: 32,
      getContext: vi.fn((type) => type === "2d" ? context : null)
    };
    const logger = { debug: vi.fn() };

    const renderer = createGreenScreenRenderer({
      canvas,
      container: { getBoundingClientRect: () => ({ width: 32, height: 32 }) },
      logger,
      backendPreference: "webgl"
    });

    expect(canvas.getContext.mock.calls[0][0]).toBe("webgl");
    expect(renderer.backend).toBe("canvas-2d");
    expect(logger.debug).toHaveBeenCalledWith("green screen backend selected", expect.objectContaining({
      backendPreference: "webgl",
      reason: "runtime-webgl-unavailable"
    }));
  });

  it("renders videos through the video element and passes loop playback", () => {
    const elements = createMediaElements();
    const renderer = createPetMediaRenderer({
      ...elements,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    expect(renderer.render("file:///pets/wave.mp4", { state: "wave", loop: true })).toBe("video");
    elements.video.onloadeddata();

    expect(elements.container.dataset).toEqual({
      state: "wave",
      asset: "file:///pets/wave.mp4"
    });
    expect(elements.image.hidden).toBe(true);
    expect(elements.image.removeAttribute).toHaveBeenCalledWith("src");
    expect(elements.video.hidden).toBe(false);
    expect(elements.video.muted).toBe(true);
    expect(elements.video.playsInline).toBe(true);
    expect(elements.video.loop).toBe(true);
    expect(elements.video.src).toBe("file:///pets/wave.mp4");
    expect(elements.video.load).toHaveBeenCalledOnce();
    expect(elements.video.play).toHaveBeenCalled();
  });

  it("keeps the previous image visible until a plain video has current frame data", () => {
    const elements = createMediaElements();
    elements.video.readyState = 1;
    elements.image.hidden = false;
    elements.image.src = "file:///pets/idle.svg";
    const renderer = createPetMediaRenderer({
      ...elements,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    expect(renderer.render("file:///pets/wave.mp4", { state: "wave", loop: true })).toBe("video");

    expect(elements.image.hidden).toBe(false);
    expect(elements.video.hidden).toBe(true);
    expect(elements.video.play).toHaveBeenCalledOnce();

    elements.video.readyState = 2;
    elements.video.onloadeddata();

    expect(elements.image.hidden).toBe(true);
    expect(elements.video.hidden).toBe(false);
  });

  it("stops video playback when switching back to an image asset", () => {
    const elements = createMediaElements();
    const renderer = createPetMediaRenderer({
      ...elements,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    renderer.render("file:///pets/wave.mp4", { state: "wave", loop: false });
    renderer.render("file:///pets/idle.svg", { state: "idle", loop: true });

    expect(elements.video.pause).toHaveBeenCalledOnce();
    expect(elements.video.removeAttribute).toHaveBeenCalledWith("src");
    expect(elements.video.hidden).toBe(true);
    expect(elements.video.loop).toBe(false);
    expect(elements.image.hidden).toBe(false);
    expect(elements.image.src).toBe("file:///pets/idle.svg");
    expect(renderer.getCurrentAsset()).toBe("file:///pets/idle.svg");
  });

  it("scrubs keyframe videos by normalized progress", () => {
    const elements = createMediaElements();
    const renderer = createPetMediaRenderer({
      ...elements,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    expect(renderer.render("file:///pets/look.mp4", {
      state: "look",
      keyframe: true,
      progress: 0.25
    })).toBe("keyframe-video");
    elements.video.onloadeddata();

    expect(elements.video.hidden).toBe(false);
    expect(elements.video.loop).toBe(false);
    expect(elements.video.pause).toHaveBeenCalledOnce();
    expect(elements.video.currentTime).toBe(1);

    expect(renderer.setProgress(0.75)).toBe(true);
    expect(elements.video.currentTime).toBe(3);
  });

  it("queues the latest keyframe video progress while a seek is already in flight", () => {
    const elements = createMediaElements();
    const renderer = createPetMediaRenderer(elements);

    renderer.render("file:///pets/look.mp4", {
      state: "look",
      keyframe: true,
      progress: 0.25
    });
    elements.video.onloadeddata();

    elements.video.seeking = true;
    expect(renderer.setProgress(0.75)).toBe(true);
    expect(elements.video.currentTime).toBe(1);
    expect(elements.video.dataset.pendingKeyframeTime).toBe("3");

    elements.video.seeking = false;
    elements.video.onseeked();
    expect(elements.video.currentTime).toBe(3);
  });

  it("renders green screen keyframe videos through canvas with transparent keyed pixels", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => {
      callback();
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const elements = createMediaElements();
    const pixels = new Uint8ClampedArray([
      0, 255, 0, 255,
      255, 0, 0, 255
    ]);
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: pixels })),
      putImageData: vi.fn()
    };
    elements.canvas = {
      hidden: true,
      width: 2,
      height: 1,
      getContext: vi.fn(() => context)
    };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const renderer = createPetMediaRenderer({ ...elements, logger });

    expect(renderer.render("file:///pets/look.mp4", {
      state: "look",
      keyframe: true,
      progress: 0.25,
      greenScreen: { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 }
    })).toBe("green-screen-keyframe-video");
    elements.video.onloadedmetadata();
    elements.video.onloadeddata();

    expect(elements.video.hidden).toBe(true);
    expect(elements.canvas.hidden).toBe(false);
    expect(elements.video.pause).toHaveBeenCalledOnce();
    expect(elements.video.currentTime).toBe(1);
    expect(context.drawImage).toHaveBeenCalledWith(elements.video, 0, 0, 2, 1);
    expect(pixels[3]).toBe(0);
    expect(pixels[7]).toBe(255);
    expect(context.putImageData).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps the previous image visible until the green screen video has a frame", () => {
    let frameCallback = null;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => {
      frameCallback = callback;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const elements = createMediaElements();
    elements.image.hidden = false;
    elements.image.src = "file:///pets/idle.svg";
    const pixels = new Uint8ClampedArray([
      0, 255, 0, 255,
      255, 0, 0, 255
    ]);
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: pixels })),
      putImageData: vi.fn()
    };
    elements.canvas = {
      hidden: true,
      width: 2,
      height: 1,
      getContext: vi.fn(() => context)
    };
    const renderer = createPetMediaRenderer({
      ...elements,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    expect(renderer.render("file:///pets/wave.mp4", {
      state: "wave",
      loop: true,
      greenScreen: { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 }
    })).toBe("green-screen-video");

    expect(elements.image.hidden).toBe(false);
    expect(elements.canvas.hidden).toBe(true);

    elements.video.onloadeddata();
    frameCallback();

    expect(elements.image.hidden).toBe(true);
    expect(elements.canvas.hidden).toBe(false);
    expect(context.putImageData).toHaveBeenCalledOnce();
  });

  it("routes green-screen output to a dedicated canvas and keeps the 2D canvas free", () => {
    let frameCallback = null;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => {
      frameCallback = callback;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const elements = createMediaElements();
    const pixels = new Uint8ClampedArray([
      0, 255, 0, 255,
      255, 0, 0, 255
    ]);
    const makeContext = () => ({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: pixels })),
      putImageData: vi.fn()
    });
    const sharedContext = makeContext();
    const greenContext = makeContext();
    elements.canvas = {
      hidden: true,
      width: 2,
      height: 1,
      getContext: vi.fn(() => sharedContext)
    };
    const greenCanvas = {
      hidden: true,
      width: 2,
      height: 1,
      getContext: vi.fn((type) => (type === "2d" ? greenContext : null))
    };
    const renderer = createPetMediaRenderer({
      ...elements,
      greenCanvas,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    renderer.render("file:///pets/wave.mp4", {
      state: "wave",
      loop: true,
      greenScreen: { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 }
    });
    elements.video.onloadeddata();
    frameCallback();

    // The keyed frame lands on the dedicated canvas; the shared 2D canvas stays hidden.
    expect(greenCanvas.getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true });
    expect(greenCanvas.getContext).not.toHaveBeenCalledWith("webgl", expect.anything());
    expect(greenCanvas.hidden).toBe(false);
    expect(elements.canvas.hidden).toBe(true);
    expect(greenContext.putImageData).toHaveBeenCalledOnce();
    expect(sharedContext.putImageData).not.toHaveBeenCalled();

    // Switching to an image hides the dedicated green-screen canvas again.
    renderer.render("file:///pets/idle.svg", { state: "idle" });
    expect(greenCanvas.hidden).toBe(true);
    expect(elements.image.hidden).toBe(false);
  });

  it("keeps the last keyed frame visible while the next green-screen video loads", () => {
    let nextFrameId = 1;
    const frameCallbacks = new Map();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => {
      const id = nextFrameId++;
      frameCallbacks.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id) => frameCallbacks.delete(id)));

    const elements = createMediaElements();
    const pixels = new Uint8ClampedArray([
      0, 255, 0, 255,
      255, 0, 0, 255
    ]);
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: pixels })),
      putImageData: vi.fn()
    };
    elements.canvas = {
      hidden: true,
      width: 2,
      height: 1,
      getContext: vi.fn((type) => type === "2d" ? context : null)
    };
    const renderer = createPetMediaRenderer({
      ...elements,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });
    const greenScreen = { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 };

    renderer.render("file:///pets/a.mp4", { state: "a", loop: true, greenScreen });
    elements.video.onloadeddata();
    const firstFrame = frameCallbacks.entries().next().value;
    frameCallbacks.delete(firstFrame[0]);
    firstFrame[1]();
    expect(elements.canvas.hidden).toBe(false);
    expect(elements.video.hidden).toBe(true);
    expect(context.putImageData).toHaveBeenCalledOnce();
    const clearCountBeforeSwitch = context.clearRect.mock.calls.length;

    renderer.render("file:///pets/b.mp4", { state: "b", loop: true, greenScreen });

    expect(elements.canvas.hidden).toBe(false);
    expect(elements.video.hidden).toBe(true);
    expect(context.clearRect).toHaveBeenCalledTimes(clearCountBeforeSwitch);
    expect(context.putImageData).toHaveBeenCalledOnce();
    expect(frameCallbacks.size).toBe(0);

    elements.video.onloadeddata();
    const nextFrame = frameCallbacks.entries().next().value;
    frameCallbacks.delete(nextFrame[0]);
    nextFrame[1]();
    expect(context.putImageData).toHaveBeenCalledTimes(2);
  });

  it("freezes a plain video frame before switching to a green-screen video", () => {
    let frameCallback = null;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => {
      frameCallback = callback;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const elements = createMediaElements();
    const pixels = new Uint8ClampedArray([
      0, 255, 0, 255,
      255, 0, 0, 255
    ]);
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: pixels })),
      putImageData: vi.fn()
    };
    elements.canvas = {
      hidden: true,
      width: 2,
      height: 1,
      getContext: vi.fn((type) => type === "2d" ? context : null)
    };
    const renderer = createPetMediaRenderer({
      ...elements,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    renderer.render("file:///pets/plain.mp4", { state: "plain", loop: true });
    elements.video.onloadeddata();
    expect(elements.video.hidden).toBe(false);

    renderer.render("file:///pets/green.mp4", {
      state: "green",
      loop: true,
      greenScreen: { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 }
    });

    expect(elements.video.hidden).toBe(true);
    expect(elements.canvas.hidden).toBe(false);
    expect(context.drawImage).toHaveBeenCalledWith(elements.video, 0, 0, 2, 1);
    expect(context.putImageData).not.toHaveBeenCalled();
    expect(frameCallback).toBeNull();

    elements.video.onloadeddata();
    frameCallback();
    expect(context.putImageData).toHaveBeenCalledOnce();
  });

  it("uses video frame callbacks instead of display refresh callbacks when available", () => {
    const videoFrameCallbacks = [];
    const animationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", animationFrame);

    const elements = createMediaElements();
    elements.video.requestVideoFrameCallback = vi.fn((callback) => {
      videoFrameCallbacks.push(callback);
      return videoFrameCallbacks.length;
    });
    elements.video.cancelVideoFrameCallback = vi.fn();
    const pixels = new Uint8ClampedArray([
      0, 255, 0, 255,
      255, 0, 0, 255
    ]);
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: pixels })),
      putImageData: vi.fn()
    };
    elements.canvas = {
      hidden: true,
      width: 2,
      height: 1,
      getContext: vi.fn((type) => type === "2d" ? context : null)
    };
    const renderer = createPetMediaRenderer({
      ...elements,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    renderer.render("file:///pets/wave.mp4", {
      state: "wave",
      loop: true,
      greenScreen: { enabled: true, color: "#00ff00", tolerance: 0.35, softness: 0.08 }
    });
    elements.video.onloadeddata();

    expect(elements.video.requestVideoFrameCallback).toHaveBeenCalledOnce();
    expect(animationFrame).not.toHaveBeenCalled();
    videoFrameCallbacks.shift()();
    expect(context.putImageData).toHaveBeenCalledOnce();
    expect(elements.video.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
  });

  it("notifies every plain video frame and ignores a superseded render callback", () => {
    const callbacks = new Map();
    let nextFrameId = 1;
    const elements = createMediaElements();
    elements.video.requestVideoFrameCallback = vi.fn((callback) => {
      const id = nextFrameId++;
      callbacks.set(id, callback);
      return id;
    });
    elements.video.cancelVideoFrameCallback = vi.fn((id) => callbacks.delete(id));
    const onFramePresented = vi.fn();
    const renderer = createPetMediaRenderer({
      ...elements,
      onFramePresented,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    renderer.render("file:///pets/a.webm", { loop: true });
    elements.video.onloadeddata();
    const staleCallback = callbacks.get(1);

    renderer.render("file:///pets/b.webm", { loop: true });
    expect(elements.video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    staleCallback();
    expect(onFramePresented).not.toHaveBeenCalled();

    elements.video.onloadeddata();
    callbacks.get(2)();
    expect(onFramePresented).toHaveBeenCalledWith(expect.objectContaining({
      asset: "file:///pets/b.webm",
      kind: "video-frame"
    }));
    expect(elements.video.requestVideoFrameCallback).toHaveBeenCalledTimes(3);
  });

  it("notifies static image and ordinary GIF presentation after load", () => {
    const elements = createMediaElements();
    const onFramePresented = vi.fn();
    const renderer = createPetMediaRenderer({
      ...elements,
      onFramePresented,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    renderer.render("file:///pets/idle.png", { state: "idle" });
    elements.image.naturalWidth = 10;
    elements.image.naturalHeight = 10;
    elements.image.onload();
    expect(onFramePresented).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "image" }));

    renderer.render("file:///pets/wave.gif", { state: "wave" });
    elements.image.onload();
    expect(onFramePresented).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "gif-image" }));
  });

  it("notifies a plain keyframe video after its requested frame is presented", () => {
    let videoFrameCallback;
    const elements = createMediaElements();
    elements.video.requestVideoFrameCallback = vi.fn((callback) => {
      videoFrameCallback = callback;
      return 31;
    });
    elements.video.cancelVideoFrameCallback = vi.fn();
    const onFramePresented = vi.fn();
    const renderer = createPetMediaRenderer({
      ...elements,
      onFramePresented,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    renderer.render("file:///pets/look.webm", { keyframe: true, progress: 0.5 });
    elements.video.onloadeddata();
    expect(onFramePresented).not.toHaveBeenCalled();
    videoFrameCallback();
    expect(onFramePresented).toHaveBeenCalledOnce();
    expect(onFramePresented).toHaveBeenCalledWith(expect.objectContaining({ kind: "keyframe-video" }));
  });

  it("samples the maximum alpha from a 3 by 3 image neighborhood", () => {
    const samplingPixels = new Uint8ClampedArray(3 * 3 * 4);
    samplingPixels[4 * 4 + 3] = 173;
    const samplingContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: samplingPixels }))
    };
    const samplingCanvas = { width: 0, height: 0, getContext: vi.fn(() => samplingContext) };
    vi.stubGlobal("document", { createElement: vi.fn(() => samplingCanvas) });

    const elements = createMediaElements();
    elements.image.naturalWidth = 10;
    elements.image.naturalHeight = 10;
    const renderer = createPetMediaRenderer({
      ...elements,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });
    renderer.render("file:///pets/idle.png");
    elements.image.onload();

    expect(renderer.sampleAlphaAt({ x: 5, y: 5 })).toBe(173);
    expect(samplingContext.drawImage).toHaveBeenCalledWith(elements.image, 4, 4, 3, 3, 0, 0, 3, 3);
    expect(renderer.sampleAlphaAt({ x: 10, y: 5 })).toBeNull();
  });

  it("samples green-screen effective alpha from the source video rather than WebGL output", () => {
    let videoFrameCallback;
    const elements = createMediaElements();
    elements.video.videoWidth = 10;
    elements.video.videoHeight = 10;
    elements.video.requestVideoFrameCallback = vi.fn((callback) => {
      videoFrameCallback = callback;
      return 1;
    });
    elements.video.cancelVideoFrameCallback = vi.fn();

    const greenPixels = new Uint8ClampedArray([0, 255, 0, 255]);
    const greenContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: greenPixels })),
      putImageData: vi.fn()
    };
    const greenCanvas = {
      hidden: true,
      width: 10,
      height: 10,
      getContext: vi.fn((type) => type === "2d" ? greenContext : null)
    };
    const samplePixels = new Uint8ClampedArray(3 * 3 * 4);
    for (let index = 0; index < samplePixels.length; index += 4) {
      samplePixels[index] = 0;
      samplePixels[index + 1] = 255;
      samplePixels[index + 2] = 0;
      samplePixels[index + 3] = 255;
    }
    const samplingContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: samplePixels }))
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ width: 0, height: 0, getContext: vi.fn(() => samplingContext) }))
    });
    const onFramePresented = vi.fn();
    const renderer = createPetMediaRenderer({
      ...elements,
      greenCanvas,
      onFramePresented,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    renderer.render("file:///pets/green.webm", {
      loop: true,
      greenScreen: { enabled: true, color: "#00ff00", tolerance: 0.05, softness: 0.05 }
    });
    elements.video.onloadeddata();
    videoFrameCallback();

    expect(renderer.sampleAlphaAt({ x: 5, y: 5 })).toBe(0);
    expect(samplingContext.drawImage.mock.calls[0][0]).toBe(elements.video);
    expect(samplingContext.drawImage.mock.calls[0][0]).not.toBe(greenCanvas);
    expect(onFramePresented).toHaveBeenCalledWith(expect.objectContaining({
      kind: "green-screen-video-frame"
    }));
  });

  it("returns null instead of throwing when alpha readback fails", () => {
    const samplingContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => {
        throw new DOMException("canvas is tainted", "SecurityError");
      })
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ width: 0, height: 0, getContext: vi.fn(() => samplingContext) }))
    });
    const elements = createMediaElements();
    elements.image.naturalWidth = 10;
    elements.image.naturalHeight = 10;
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const renderer = createPetMediaRenderer({ ...elements, logger });
    renderer.render("file:///pets/idle.png");
    elements.image.onload();

    expect(() => renderer.sampleAlphaAt({ x: 5, y: 5 })).not.toThrow();
    expect(renderer.sampleAlphaAt({ x: 5, y: 5 })).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith("media alpha sample failed", expect.any(Object));
  });

  it("cancels frame notification callbacks and detaches media handlers on destroy", () => {
    const elements = createMediaElements();
    elements.video.requestVideoFrameCallback = vi.fn(() => 77);
    elements.video.cancelVideoFrameCallback = vi.fn();
    const renderer = createPetMediaRenderer({
      ...elements,
      onFramePresented: vi.fn(),
      logger: { debug: vi.fn(), warn: vi.fn() }
    });
    renderer.render("file:///pets/wave.webm", { loop: true });
    elements.video.onloadeddata();
    renderer.destroy();

    expect(elements.video.cancelVideoFrameCallback).toHaveBeenCalledWith(77);
    expect(elements.video.onloadeddata).toBeNull();
    expect(elements.video.onloadedmetadata).toBeNull();
    expect(elements.video.onseeked).toBeNull();
    expect(elements.video.onerror).toBeNull();
    expect(elements.image.onload).toBeNull();
    expect(elements.image.onerror).toBeNull();
  });

  it("keeps the green-screen canvas visible until an uncached keyframe GIF has drawn its first frame", async () => {
    let resolveBuffer;
    const bufferPromise = new Promise((resolve) => {
      resolveBuffer = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: () => bufferPromise })));
    vi.stubGlobal("ImageData", class MockImageData {
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    });
    const workContext = {
      clearRect: vi.fn(),
      putImageData: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(8) }))
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: vi.fn(() => workContext)
      }))
    });

    const elements = createMediaElements();
    const gifContext = { putImageData: vi.fn() };
    elements.canvas = {
      hidden: true,
      width: 0,
      height: 0,
      getContext: vi.fn(() => gifContext)
    };
    const greenCanvas = {
      hidden: false,
      width: 2,
      height: 1,
      getContext: vi.fn()
    };
    elements.image.hidden = true;
    const onFramePresented = vi.fn();
    const renderer = createPetMediaRenderer({
      ...elements,
      greenCanvas,
      onFramePresented,
      logger: { debug: vi.fn(), warn: vi.fn() }
    });

    expect(renderer.render("file:///pets/look.gif", {
      state: "look",
      keyframe: true,
      progress: 0
    })).toBe("keyframe-gif");

    expect(greenCanvas.hidden).toBe(false);
    expect(elements.canvas.hidden).toBe(true);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    resolveBuffer(new ArrayBuffer(8));
    await vi.waitFor(() => expect(gifContext.putImageData).toHaveBeenCalledOnce());

    expect(elements.canvas.hidden).toBe(false);
    expect(greenCanvas.hidden).toBe(true);
    expect(onFramePresented).toHaveBeenCalledWith(expect.objectContaining({ kind: "keyframe-gif" }));
  });

  it("retains the previous surface when keyframe GIF decoding fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      arrayBuffer: vi.fn(async () => {
        throw new Error("decode unavailable");
      })
    })));

    const elements = createMediaElements();
    elements.canvas = {
      hidden: true,
      width: 0,
      height: 0,
      getContext: vi.fn()
    };
    const greenCanvas = { hidden: false, width: 2, height: 1, getContext: vi.fn() };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const renderer = createPetMediaRenderer({ ...elements, greenCanvas, logger });

    renderer.render("file:///pets/broken.gif", { keyframe: true });

    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
      "keyframe gif decode failed; retaining previous surface",
      expect.objectContaining({ asset: "file:///pets/broken.gif" })
    ));
    expect(greenCanvas.hidden).toBe(false);
    expect(elements.canvas.hidden).toBe(true);
  });
});
