const MAX_DEVICE_PIXEL_RATIO = 2;
const MAX_RGB_DISTANCE = Math.sqrt(3);
export const WEBGL_MIN_TARGET_PIXELS = 512 * 512;

function getElementSize(element) {
  if (!element) return null;
  const rect = typeof element.getBoundingClientRect === "function"
    ? element.getBoundingClientRect()
    : null;
  const width = Number(rect?.width) || Number(element.clientWidth) || 0;
  const height = Number(rect?.height) || Number(element.clientHeight) || 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

export function getGreenScreenRenderSize(video, canvas, container, devicePixelRatio = globalThis.devicePixelRatio) {
  const sourceWidth = Math.max(1, Math.round(Number(video?.videoWidth || video?.width) || 1));
  const sourceHeight = Math.max(1, Math.round(Number(video?.videoHeight || video?.height) || 1));
  const displaySize = getElementSize(container) || getElementSize(canvas);
  const dpr = Math.min(MAX_DEVICE_PIXEL_RATIO, Math.max(1, Number(devicePixelRatio) || 1));
  const width = Math.max(1, Math.round((displaySize?.width || sourceWidth) * dpr));
  const height = Math.max(1, Math.round((displaySize?.height || sourceHeight) * dpr));
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));

  return {
    width,
    height,
    drawX: Math.round((width - drawWidth) / 2),
    drawY: Math.round((height - drawHeight) / 2),
    drawWidth,
    drawHeight,
    sourceWidth,
    sourceHeight,
    devicePixelRatio: dpr
  };
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createWebGLBackend(canvas) {
  if (!canvas || typeof canvas.getContext !== "function") return null;
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false
  });
  if (!gl || typeof gl.createShader !== "function") return null;

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texCoord = a_texCoord;
    }
  `);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform vec3 u_keyColor;
    uniform float u_tolerance;
    uniform float u_softness;
    uniform float u_keyEnabled;
    varying vec2 v_texCoord;
    void main() {
      vec4 pixel = texture2D(u_texture, v_texCoord);
      if (u_keyEnabled < 0.5) {
        gl_FragColor = pixel;
        return;
      }
      float colorDistance = distance(pixel.rgb, u_keyColor) / ${MAX_RGB_DISTANCE.toFixed(12)};
      float alpha = pixel.a;
      if (colorDistance <= u_tolerance) {
        alpha = 0.0;
      } else if (u_softness > 0.0 && colorDistance < min(1.0, u_tolerance + u_softness)) {
        alpha *= (colorDistance - u_tolerance) / max(0.0001, min(1.0, u_tolerance + u_softness) - u_tolerance);
      }
      gl_FragColor = vec4(pixel.rgb, alpha);
    }
  `);
  if (!vertexShader || !fragmentShader) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  if (!buffer || !texture) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 0, 0,
    1, -1, 1, 0,
    -1, 1, 0, 1,
    -1, 1, 0, 1,
    1, -1, 1, 0,
    1, 1, 1, 1
  ]), gl.STATIC_DRAW);

  gl.useProgram(program);
  const positionLocation = gl.getAttribLocation(program, "a_position");
  const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(texCoordLocation);
  gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 16, 8);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const textureLocation = gl.getUniformLocation(program, "u_texture");
  const keyColorLocation = gl.getUniformLocation(program, "u_keyColor");
  const toleranceLocation = gl.getUniformLocation(program, "u_tolerance");
  const softnessLocation = gl.getUniformLocation(program, "u_softness");
  const keyEnabledLocation = gl.getUniformLocation(program, "u_keyEnabled");
  gl.uniform1i(textureLocation, 0);

  function drawTexture(video, size, greenScreen) {
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    gl.viewport(0, 0, size.width, size.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(size.drawX, size.drawY, size.drawWidth, size.drawHeight);
    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.uniform1f(keyEnabledLocation, greenScreen ? 1 : 0);
    if (greenScreen) {
      gl.uniform3f(
        keyColorLocation,
        greenScreen.color.r / 255,
        greenScreen.color.g / 255,
        greenScreen.color.b / 255
      );
      gl.uniform1f(toleranceLocation, greenScreen.tolerance);
      gl.uniform1f(softnessLocation, greenScreen.softness);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  return {
    name: "webgl",
    clear() {
      gl.viewport(0, 0, canvas.width || 1, canvas.height || 1);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    draw(video, size, greenScreen) {
      drawTexture(video, size, greenScreen);
    },
    drawRaw(video, size) {
      drawTexture(video, size, null);
    }
  };
}

function createCanvas2DBackend(canvas) {
  if (!canvas || typeof canvas.getContext !== "function") return null;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || typeof context.getImageData !== "function") return null;

  return {
    name: "canvas-2d",
    clear() {
      context.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
    },
    draw(video, size, greenScreen) {
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.clearRect(0, 0, size.width, size.height);
      context.drawImage(video, size.drawX, size.drawY, size.drawWidth, size.drawHeight);
      const frame = context.getImageData(size.drawX, size.drawY, size.drawWidth, size.drawHeight);
      const data = frame.data;
      const fadeEnd = Math.min(1, greenScreen.tolerance + greenScreen.softness);

      for (let index = 0; index < data.length; index += 4) {
        const distance = Math.hypot(
          data[index] - greenScreen.color.r,
          data[index + 1] - greenScreen.color.g,
          data[index + 2] - greenScreen.color.b
        ) / Math.sqrt(255 * 255 * 3);
        if (distance <= greenScreen.tolerance) {
          data[index + 3] = 0;
        } else if (greenScreen.softness > 0 && distance < fadeEnd) {
          const alphaScale = (distance - greenScreen.tolerance) / Math.max(0.0001, fadeEnd - greenScreen.tolerance);
          data[index + 3] = Math.round(data[index + 3] * alphaScale);
        }
      }
      context.putImageData(frame, size.drawX, size.drawY);
    },
    drawRaw(video, size) {
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.clearRect(0, 0, size.width, size.height);
      context.drawImage(video, size.drawX, size.drawY, size.drawWidth, size.drawHeight);
    }
  };
}

export function selectGreenScreenBackendKind({ width, height }, minPixels = WEBGL_MIN_TARGET_PIXELS) {
  const targetPixels = Math.max(1, Math.round(Number(width) || 1))
    * Math.max(1, Math.round(Number(height) || 1));
  return targetPixels >= minPixels ? "webgl" : "canvas-2d";
}

export function createGreenScreenRenderer({
  canvas,
  container,
  logger = console,
  backendPreference = "adaptive"
} = {}) {
  const initialSize = getGreenScreenRenderSize(null, canvas, container);
  const preferredBackend = backendPreference === "webgl"
    ? "webgl"
    : (backendPreference === "canvas-2d" ? "canvas-2d" : selectGreenScreenBackendKind(initialSize));
  const backend = preferredBackend === "webgl"
    ? (createWebGLBackend(canvas) || createCanvas2DBackend(canvas))
    : createCanvas2DBackend(canvas);
  if (!backend) return null;
  let lastSizeKey = "";
  const targetPixels = initialSize.width * initialSize.height;
  logger.debug("green screen backend selected", {
    backend: backend.name,
    preferredBackend,
    targetWidth: initialSize.width,
    targetHeight: initialSize.height,
    targetPixels,
    webglMinTargetPixels: WEBGL_MIN_TARGET_PIXELS,
    backendPreference,
    reason: backendPreference === "webgl"
      ? (backend.name === "webgl" ? "runtime-webgl-preference" : "runtime-webgl-unavailable")
      : (preferredBackend === "webgl"
        ? (backend.name === "webgl" ? "target-large-enough" : "webgl-unavailable")
        : (backendPreference === "canvas-2d" ? "canvas-2d-preference" : "target-too-small"))
  });

  return {
    backend: backend.name,
    clear() {
      backend.clear();
    },
    draw(video, greenScreen) {
      const size = getGreenScreenRenderSize(video, canvas, container);
      backend.draw(video, size, greenScreen);
      const sizeKey = `${size.width}x${size.height}:${size.sourceWidth}x${size.sourceHeight}:${size.devicePixelRatio}`;
      if (sizeKey !== lastSizeKey) {
        lastSizeKey = sizeKey;
        logger.debug("green screen render target updated", {
          backend: backend.name,
          targetWidth: size.width,
          targetHeight: size.height,
          sourceWidth: size.sourceWidth,
          sourceHeight: size.sourceHeight,
          targetPixels: size.width * size.height,
          devicePixelRatio: size.devicePixelRatio
        });
      }
      return size;
    },
    drawRaw(video) {
      const size = getGreenScreenRenderSize(video, canvas, container);
      backend.drawRaw(video, size);
      return size;
    }
  };
}
