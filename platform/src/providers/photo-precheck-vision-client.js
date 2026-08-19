"use strict";

const PROMPT_VERSION = "pet-photo-precheck/v2";

const RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["photos", "same_animal"],
  properties: {
    photos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "ordinal", "pet_present", "species_match", "single_animal",
          "face_clear", "coat_clear", "flank_visible", "view", "sharp",
          "heavy_obstruction", "issue"
        ],
        properties: {
          ordinal: { type: "integer" },
          pet_present: { type: "boolean" },
          species_match: { type: "boolean" },
          single_animal: { type: "boolean" },
          face_clear: { type: "boolean" },
          coat_clear: { type: "boolean" },
          flank_visible: { type: "boolean" },
          view: { type: "string", enum: ["front", "side45", "back", "other"] },
          sharp: { type: "boolean" },
          heavy_obstruction: { type: "boolean" },
          issue: { type: "string" }
        }
      }
    },
    same_animal: { type: "boolean" }
  }
});

function speciesLabel(species) {
  return species === "cat" ? "猫" : "犬";
}

function buildInstruction(species, photoCount) {
  return [
    `你是宠物照片质检员。用户为一只${speciesLabel(species)}提交了 ${photoCount} 张照片，`,
    "将用于生成这只宠物的动画形象。逐张判断，并整体判断是否为同一只动物。",
    "",
    "生成只需要两样东西：正面照上的五官与毛色，侧面照上的躯干花色。",
    "姿势随意（坐卧趴均可）、尾巴或四肢不入镜、轻微出框都不影响生成，不要因此判差。",
    "",
    "对每张照片输出：",
    "- pet_present：画面里有没有真实的宠物（玩具、贴纸、图画、人都算没有）",
    `- species_match：宠物是否为${speciesLabel(species)}`,
    "- single_animal：画面里是否只有一只动物",
    "- face_clear：五官（双眼、鼻、嘴）是否清晰可辨（侧脸只见一眼、背对镜头、脸部糊掉算不可辨）",
    "- coat_clear：毛发质感与花色特征是否看得清",
    "- flank_visible：躯干侧面（肩到臀）的花色是否可见（正对镜头只见胸腹算不可见）",
    "- view：front（面朝镜头）/ side45（侧面或约45度）/ back（背面）/ other",
    "- sharp：画面是否清晰（明显模糊、噪点严重、过暗过曝算不清晰）",
    "- heavy_obstruction：主体是否被大面积遮挡（挡住脸或大半个身体；手轻搭、项圈不算）",
    "- issue：一句简短中文说明最主要的问题；没有问题填空字符串",
    "",
    "照片按提交顺序编号 ordinal=1..N。",
    "same_animal：所有照片里的宠物是否为同一只（花色、体型、品种特征一致）。",
    "严格输出 JSON。"
  ].join("\n");
}

/**
 * One chat-completions call judges the whole photo set. Data URLs come from the
 * browser (client-side downscaled copies); nothing is persisted provider-side.
 */
function createPhotoPrecheckVisionClient({ registry, fetchImpl = fetch, logger = console } = {}) {
  const baseUrl = registry?.modelArk?.baseUrl;
  const apiKey = registry?.modelArk?.apiKey;
  // Unconfigured is a valid state (development, tests, precheck rollout gap):
  // the client reports configured=false and every judge call fails closed.
  const modelId = baseUrl && apiKey ? registry?.modelArk?.vision?.modelId : "";

  async function post(body) {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  }

  return Object.freeze({
    promptVersion: PROMPT_VERSION,
    modelId: modelId || null,
    configured: Boolean(modelId),

    async judgePhotoSet({ species, photos, requestId }) {
      if (!modelId) {
        const error = new Error("Photo precheck vision model is not configured");
        error.code = "precheck_unavailable";
        throw error;
      }
      const content = [
        { type: "text", text: buildInstruction(species, photos.length) },
        ...photos.map((photo) => ({ type: "image_url", image_url: { url: photo.dataUrl, detail: "low" } }))
      ];
      const base = {
        model: modelId,
        max_tokens: 900,
        temperature: 0,
        messages: [{ role: "user", content }]
      };
      let result = await post({
        ...base,
        response_format: {
          type: "json_schema",
          json_schema: { name: "photo_precheck", strict: true, schema: RESPONSE_SCHEMA }
        }
      });
      if (result.status === 400) {
        // Some model versions accept only json_object; the instruction already
        // pins the shape, so retry once in that mode.
        result = await post({ ...base, response_format: { type: "json_object" } });
      }
      if (result.status !== 200 || !result.payload) {
        const code = result.payload?.error?.code || `http_${result.status}`;
        logger.warn?.("petpack.precheck.vision_failed", { requestId, status: result.status, code });
        const error = new Error("照片预检服务暂时不可用，请稍后重试");
        error.code = "precheck_provider_error";
        throw error;
      }
      const text = result.payload.choices?.[0]?.message?.content;
      let parsed;
      try {
        parsed = JSON.parse(typeof text === "string" ? text : "");
      } catch {
        logger.warn?.("petpack.precheck.vision_unparseable", { requestId });
        const error = new Error("照片预检结果无法解析，请稍后重试");
        error.code = "precheck_provider_error";
        throw error;
      }
      if (!Array.isArray(parsed.photos) || typeof parsed.same_animal !== "boolean") {
        const error = new Error("照片预检结果不完整，请稍后重试");
        error.code = "precheck_provider_error";
        throw error;
      }
      const usage = result.payload.usage || {};
      logger.info?.("petpack.precheck.vision_ok", {
        requestId,
        photoCount: photos.length,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens
      });
      return parsed;
    }
  });
}

module.exports = { createPhotoPrecheckVisionClient, PRECHECK_PROMPT_VERSION: PROMPT_VERSION };
