const crypto = require("node:crypto");

const { createModelReference } = require("../config/model-registry");
const { CHARACTER_CANVAS_V1 } = require("../qa/character-canvas-v1");

const IMAGE_CONSTRAINTS_VERSION = "petpack-studio-image-constraints/v2";
const IMAGE_PROMPT_CONTENT_POLICY_VERSION = "brand-neutral-image-prompt/v1";
const IMMUTABLE_IMAGE_CONSTRAINTS = Object.freeze([
  "friendly high-quality consistent 3D animated pet style without imitating or naming another brand",
  "exactly one pet and no people or other animals",
  "full body visible with ears tail and paws uncropped",
  "preserve the exact pet-specific face, breed traits, coat colors, and asymmetric marking topology by anatomical region",
  "never average, mirror, move, simplify, invent, duplicate, recolor, or erase a distinguishing marking",
  "stylize rendering only and never redesign identity or coat pattern",
  "fixed camera with no text watermark or props",
  "plain removable background",
  `compose for ${CHARACTER_CANVAS_V1.width}x${CHARACTER_CANVAS_V1.height} ${CHARACTER_CANVAS_V1.aspectRatio}`,
  `center the torso at x=${CHARACTER_CANVAS_V1.width / 2} and ground contact at y=${CHARACTER_CANVAS_V1.groundBaselineY}`
]);
const VIDEO_CONSTRAINTS_VERSION = "petpack-studio-video-constraints/v2";
const IMMUTABLE_VIDEO_CONSTRAINTS = Object.freeze([
  "fixed camera",
  "no camera motion or zoom",
  "no text",
  "no props",
  "no people or other animals",
  "consistent pet identity and scale",
  "approved first and last master images are immutable identity and appearance references",
  "preserve pet species, face identity, primary coat colors, and distinguishing markings; minor transient marking deformation during motion is acceptable",
  "the approved first and last frames must return exactly to their corresponding master image",
  "pet remains fully visible",
  "no growth, shrinkage, or deformation",
  "plain removable background"
]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function resolveApiUrl(baseUrl, path) {
  return new URL(path.replace(/^\/+/, ""), `${requiredString(baseUrl, "ModelArk base URL").replace(/\/+$/, "")}/`).toString();
}

function assertPrivateInput(asset, label, { allowDataUrl = false } = {}) {
  if (!asset || typeof asset !== "object") {
    throw new Error(`${label} private asset reference is required`);
  }
  requiredString(asset.objectKey, `${label}.objectKey`);
  const signedReadUrl = requiredString(asset.signedReadUrl, `${label}.signedReadUrl`);
  let parsed;
  try {
    parsed = new URL(signedReadUrl);
  } catch {
    throw new Error(`${label}.signedReadUrl must be an absolute URL`);
  }
  if (!["https:", "http:"].includes(parsed.protocol) && !(allowDataUrl && parsed.protocol === "data:")) {
    throw new Error(`${label}.signedReadUrl must use HTTP(S)`);
  }
  if (parsed.protocol === "data:" && !/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(signedReadUrl)) {
    throw new Error(`${label}.signedReadUrl data URL must be a base64 image`);
  }
  return signedReadUrl;
}

function assertCanvasAsset(asset, label, options) {
  if (!asset || asset.canvasId !== CHARACTER_CANVAS_V1.id) {
    throw new Error(`${label} must be normalized to ${CHARACTER_CANVAS_V1.id}`);
  }
  return assertPrivateInput(asset, label, options);
}

function createSeedreamPayload({ modelReference, prompt, sourceImages, outputSize, allowDataUrls = false }) {
  if (!modelReference || !modelReference.endpointId) {
    throw new Error("A configured Seedream model reference is required");
  }
  if (!Array.isArray(sourceImages) || sourceImages.length === 0) {
    throw new Error("At least one private source image is required");
  }
  const payload = {
    model: modelReference.endpointId,
    prompt: requiredString(prompt, "Seedream server prompt"),
    image: sourceImages.map((asset, index) => assertPrivateInput(asset, `sourceImages[${index}]`, { allowDataUrl: allowDataUrls })),
    response_format: "url",
    watermark: false
  };
  if (typeof outputSize === "string" && outputSize.trim()) {
    payload.size = outputSize.trim();
  }
  return payload;
}

function formatServerOnlyImageInstruction({ kind, prompt, negativePrompt }) {
  if (!['front', 'side', 'sleep'].includes(kind)) {
    throw new Error("Seedream master kind must be front, side, or sleep");
  }
  const positive = requiredString(prompt, "Published image prompt");
  const poseConstraint = {
    front: "awake neutral front-facing full-body pose suitable as the canonical front identity reference",
    side: "awake full-body side or three-quarter pose suitable as the canonical lateral identity reference, using the approved front master as the identity anchor",
    sleep: "natural sleeping pose while preserving both approved front and side identity masters, anatomical scale, and ground anchor"
  }[kind];
  const prohibited = typeof negativePrompt === "string" && negativePrompt.trim()
    ? ` Avoid: ${negativePrompt.trim()}.`
    : "";
  return `${positive}\n\nMandatory delivery constraints (${IMAGE_CONSTRAINTS_VERSION}): ${IMMUTABLE_IMAGE_CONSTRAINTS.join("; ")}; ${poseConstraint}.${prohibited}`;
}

function formatServerOnlyVideoInstruction({ prompt, negativePrompt, resolution = "480p", actionId }) {
  const positive = requiredString(prompt, "Published video prompt");
  const prohibited = typeof negativePrompt === "string" && negativePrompt.trim()
    ? ` Avoid: ${negativePrompt.trim()}.`
    : "";
  const loopConstraint = actionId === "sleep-loop"
    ? " For the sleep loop, perform exactly one complete low-amplitude inhale-exhale cycle; start and end at the same end-exhale rest pose; remain completely motionless for at least the final 0.75 seconds; never start the next inhale before the clip ends."
    : "";
  return `${positive}\n\nMandatory delivery constraints (${VIDEO_CONSTRAINTS_VERSION}): ${IMMUTABLE_VIDEO_CONSTRAINTS.join("; ")}; ${requiredString(resolution, "video resolution")} 16:9 output.${loopConstraint}${prohibited}`;
}

function createSeedancePayload({ modelReference, prompt, negativePrompt, actionId, duration, firstFrame, lastFrame, callbackUrl, allowDataUrls = false, allowExperimentalResolution = false }) {
  const resolution = modelReference && modelReference.resolution;
  const allowedResolution = resolution === "720p" || resolution === "480p";
  if (!modelReference || !allowedResolution || !modelReference.endpointId) {
    throw new Error("A configured 480p or 720p Seedance model reference is required");
  }
  if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) {
    throw new Error("Published video duration must be a positive number");
  }

  const firstFrameUrl = assertCanvasAsset(firstFrame, "firstFrame", { allowDataUrl: allowDataUrls });
  const lastFrameUrl = assertCanvasAsset(lastFrame, "lastFrame", { allowDataUrl: allowDataUrls });
  const serverInstruction = `${formatServerOnlyVideoInstruction({ prompt, negativePrompt, resolution, actionId })}\n\nThe first image is the first frame and the second image is the last frame.`;
  const payload = {
    model: modelReference.endpointId,
    content: [
      { type: "text", text: serverInstruction },
      { type: "image_url", image_url: { url: firstFrameUrl } },
      { type: "image_url", image_url: { url: lastFrameUrl } }
    ],
    return_last_frame: true,
    resolution,
    ratio: CHARACTER_CANVAS_V1.aspectRatio,
    duration: Number(duration),
    generate_audio: false,
    watermark: false
  };
  if (callbackUrl) payload.callback_url = requiredString(callbackUrl, "ModelArk callback URL");
  return payload;
}

function extractSeedreamOutputUrls(response) {
  const candidates = Array.isArray(response && response.data)
    ? response.data
    : Array.isArray(response && response.output)
      ? response.output
      : [];
  const urls = candidates
    .map((entry) => entry && (entry.url || entry.image_url || entry.imageUrl))
    .filter((value) => typeof value === "string" && value);
  if (urls.length === 0) {
    throw new Error("ModelArk Seedream response did not contain an output URL");
  }
  return urls;
}

function extractTaskId(response) {
  const taskId = response && (
    response.id ||
    response.task_id ||
    response.taskId ||
    (response.data && (response.data.id || response.data.task_id || response.data.taskId))
  );
  return requiredString(taskId, "ModelArk task ID");
}

function createCallbackTicket({ runId, actionId, secret, now = Date.now(), ttlMs = 30 * 60 * 1000 }) {
  const normalizedSecret = requiredString(secret, "ModelArk callback secret");
  const payload = {
    actionId: requiredString(actionId, "callback actionId"),
    expiresAt: Number(now) + Number(ttlMs),
    runId: requiredString(runId, "callback runId")
  };
  if (!Number.isFinite(payload.expiresAt) || Number(ttlMs) <= 0) {
    throw new Error("Callback expiry must be positive");
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", normalizedSecret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifyCallbackTicket(ticket, { secret, now = Date.now() } = {}) {
  if (typeof ticket !== "string") return null;
  const [encodedPayload, suppliedSignature, ...extra] = ticket.split(".");
  if (!encodedPayload || !suppliedSignature || extra.length > 0) return null;
  const expectedSignature = crypto.createHmac("sha256", requiredString(secret, "ModelArk callback secret"))
    .update(encodedPayload)
    .digest("base64url");
  const expected = Buffer.from(expectedSignature);
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Number(payload.expiresAt) < Number(now)) return null;
    requiredString(payload.runId, "callback runId");
    requiredString(payload.actionId, "callback actionId");
    return payload;
  } catch {
    return null;
  }
}

async function consumeCallbackTicket(ticket, { secret, callbackTicketStore, now = Date.now() } = {}) {
  const payload = verifyCallbackTicket(ticket, { secret, now });
  if (!payload) return null;
  if (!callbackTicketStore || typeof callbackTicketStore.consumeOnce !== "function") {
    throw new Error("A one-time ModelArk callback ticket store is required");
  }
  const ticketHash = crypto.createHash("sha256").update(ticket).digest("hex");
  const consumed = await callbackTicketStore.consumeOnce({
    key: `modelark-callback:${ticketHash}`,
    expiresAt: payload.expiresAt
  });
  return consumed ? payload : null;
}

function createCallbackUrl(baseUrl, ticket) {
  const callbackUrl = new URL(requiredString(baseUrl, "ModelArk callback base URL"));
  callbackUrl.searchParams.set("ticket", requiredString(ticket, "ModelArk callback ticket"));
  return callbackUrl.toString();
}

class ModelArkClient {
  constructor({ registry, fetchImpl = globalThis.fetch, logger = console } = {}) {
    if (!registry || !registry.modelArk) throw new Error("ModelArk registry is required");
    if (typeof fetchImpl !== "function") throw new Error("A server-side fetch implementation is required");
    this.registry = registry;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  async _post(path, body, { requestId, operation }) {
    let response;
    try {
      response = await this.fetch(resolveApiUrl(this.registry.modelArk.baseUrl, path), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${requiredString(this.registry.modelArk.apiKey, "MODELARK_API_KEY")}`,
          "Content-Type": "application/json",
          ...(requestId ? { "X-Request-Id": requestId } : {})
        },
        body: JSON.stringify(body)
      });
    } catch (cause) {
      const error = new Error(`ModelArk ${operation} request transport failed`);
      error.code = "modelark_transport_error";
      error.providerSubmissionOutcome = "unknown";
      error.cause = cause;
      throw error;
    }
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 512) };
    }
    if (!response.ok) {
      this.logger.warn?.("petpack.modelark.request_failed", { operation, requestId, status: response.status });
      const error = new Error(`ModelArk ${operation} request failed with HTTP ${response.status}`);
      error.code = `modelark_http_${response.status}`;
      // A 4xx/429 response is an explicit rejection and can use the same
      // deterministic request path on queue retry. A transport/5xx failure may
      // have created a task and must be reconciled before any resubmission.
      error.providerSubmissionOutcome = response.status >= 400 && response.status < 500 ? "rejected" : "unknown";
      throw error;
    }
    this.logger.info?.("petpack.modelark.request_succeeded", { operation, requestId });
    return data;
  }

  async _get(path, { requestId, operation }) {
    const response = await this.fetch(resolveApiUrl(this.registry.modelArk.baseUrl, path), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${requiredString(this.registry.modelArk.apiKey, "MODELARK_API_KEY")}`,
        ...(requestId ? { "X-Request-Id": requestId } : {})
      }
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 512) };
    }
    if (!response.ok) {
      this.logger.warn?.("petpack.modelark.query_failed", { operation, requestId, status: response.status });
      throw new Error(`ModelArk ${operation} query failed with HTTP ${response.status}`);
    }
    return data;
  }

  async createFrontMaster({ requestId, serverPrompt, sourcePhotos, modelReference, outputSize, allowDataUrls = false }) {
    if (!Array.isArray(sourcePhotos) || sourcePhotos.length < 3 || sourcePhotos.length > 4) {
      throw new Error("Three or four private pet source photos are required for the front master");
    }
    const imageReference = modelReference || createModelReference(this.registry, "image");
    const payload = createSeedreamPayload({
      modelReference: imageReference,
      prompt: serverPrompt,
      sourceImages: sourcePhotos,
      outputSize: outputSize === undefined ? this.registry.modelArk.image.outputSize : outputSize,
      allowDataUrls
    });
    const response = await this._post("images/generations", payload, { requestId, operation: "seedream-front" });
    return {
      modelReference: imageReference,
      providerRequestId: response.id || response.request_id || null,
      outputUrls: extractSeedreamOutputUrls(response),
      raw: response
    };
  }

  async createSideMaster({ requestId, serverPrompt, sourcePhotos, frontMaster, modelReference, outputSize, allowDataUrls = false }) {
    if (!Array.isArray(sourcePhotos) || sourcePhotos.length < 3 || sourcePhotos.length > 4) {
      throw new Error("Three or four private pet source photos are required for the side master");
    }
    assertCanvasAsset(frontMaster, "frontMaster", { allowDataUrl: allowDataUrls });
    const imageReference = modelReference || createModelReference(this.registry, "image");
    const payload = createSeedreamPayload({
      modelReference: imageReference,
      prompt: serverPrompt,
      sourceImages: [...sourcePhotos, frontMaster],
      outputSize: outputSize === undefined ? this.registry.modelArk.image.outputSize : outputSize,
      allowDataUrls
    });
    const response = await this._post("images/generations", payload, { requestId, operation: "seedream-side" });
    return {
      modelReference: imageReference,
      providerRequestId: response.id || response.request_id || null,
      outputUrls: extractSeedreamOutputUrls(response),
      raw: response
    };
  }

  async createSleepingMaster({ requestId, serverPrompt, frontMaster, sideMaster, modelReference, outputSize, allowDataUrls = false }) {
    assertCanvasAsset(frontMaster, "frontMaster", { allowDataUrl: allowDataUrls });
    assertCanvasAsset(sideMaster, "sideMaster", { allowDataUrl: allowDataUrls });
    const imageReference = modelReference || createModelReference(this.registry, "image");
    const payload = createSeedreamPayload({
      modelReference: imageReference,
      prompt: serverPrompt,
      sourceImages: [frontMaster, sideMaster],
      outputSize: outputSize === undefined ? this.registry.modelArk.image.outputSize : outputSize,
      allowDataUrls
    });
    const response = await this._post("images/generations", payload, { requestId, operation: "seedream-sleep" });
    return {
      modelReference: imageReference,
      providerRequestId: response.id || response.request_id || null,
      outputUrls: extractSeedreamOutputUrls(response),
      raw: response
    };
  }

  async createVideoTask({ requestId, runId, actionId, promptVersion, firstFrame, lastFrame, duration, modelReference, allowDataUrls = false, allowExperimentalResolution = false }) {
    if (!promptVersion || (promptVersion.status !== "published" && promptVersion.frozenForRun !== true)) {
      throw new Error("A published or run-frozen server-only prompt version is required");
    }
    const videoReference = modelReference || createModelReference(this.registry, "video");
    const hasCallback = Boolean(
      this.registry.modelArk.video.callbackBaseUrl &&
      this.registry.modelArk.video.callbackSecret
    );
    const ticket = hasCallback
      ? createCallbackTicket({
        runId,
        actionId,
        secret: requiredString(this.registry.modelArk.video.callbackSecret, "MODELARK_VIDEO_CALLBACK_SECRET")
      })
      : null;
    const callbackUrl = hasCallback
      ? createCallbackUrl(this.registry.modelArk.video.callbackBaseUrl, ticket)
      : null;
    const payload = createSeedancePayload({
      modelReference: videoReference,
      prompt: promptVersion.prompt,
      negativePrompt: promptVersion.negativePrompt,
      actionId,
      duration,
      firstFrame,
      lastFrame,
      callbackUrl,
      allowDataUrls,
      allowExperimentalResolution
    });
    const response = await this._post("contents/generations/tasks", payload, { requestId, operation: "seedance-create" });
    return {
      actionId,
      callbackTicket: ticket,
      modelReference: videoReference,
      providerTaskId: extractTaskId(response),
      raw: response
    };
  }

  async getVideoTask({ requestId, providerTaskId }) {
    const taskId = requiredString(providerTaskId, "ModelArk provider task ID");
    const raw = await this._get(`contents/generations/tasks/${encodeURIComponent(taskId)}`, {
      requestId,
      operation: "seedance-status"
    });
    const data = raw && raw.data ? raw.data : raw;
    return {
      providerTaskId: taskId,
      status: String(data.status || data.state || "unknown").toLowerCase(),
      outputUrls: extractPossibleOutputUrls(data),
      lastFrameUrl: data.last_frame_url || data.lastFrameUrl || (data.content && (data.content.last_frame_url || data.content.lastFrameUrl)) || null,
      raw
    };
  }
}

function extractPossibleOutputUrls(response) {
  const candidates = [
    response && response.video_url,
    response && response.videoUrl,
    response && response.url,
    response && response.content && response.content.video_url,
    response && response.content && response.content.videoUrl,
    response && response.content && response.content.url,
    ...(Array.isArray(response && response.content) ? response.content.map((item) => item && (item.url || item.video_url)) : []),
    ...(Array.isArray(response && response.output) ? response.output.map((item) => item && (item.url || item.video_url)) : [])
  ];
  return [...new Set(candidates.filter((value) => typeof value === "string" && value))];
}

module.exports = {
  IMAGE_CONSTRAINTS_VERSION,
  IMAGE_PROMPT_CONTENT_POLICY_VERSION,
  IMMUTABLE_IMAGE_CONSTRAINTS,
  IMMUTABLE_VIDEO_CONSTRAINTS,
  ModelArkClient,
  VIDEO_CONSTRAINTS_VERSION,
  assertCanvasAsset,
  createCallbackTicket,
  createCallbackUrl,
  consumeCallbackTicket,
  createSeedancePayload,
  createSeedreamPayload,
  extractPossibleOutputUrls,
  extractSeedreamOutputUrls,
  extractTaskId,
  formatServerOnlyImageInstruction,
  formatServerOnlyVideoInstruction,
  verifyCallbackTicket
};
