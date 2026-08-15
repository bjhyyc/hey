import { describe, expect, it } from "vitest";

const { loadModelRegistry } = require("../../platform/src/config/model-registry");

const productionEnvironment = Object.freeze({
  PETPACK_PLATFORM_MODE: "production",
  MODEL_REGISTRY_VERSION: "seedream-seedance-480p-v1",
  MODELARK_REGION: "cn-beijing",
  MODELARK_API_KEY: "test-only-api-key",
  MODELARK_SEEDREAM_ENDPOINT_ID: "seedream-test-endpoint",
  MODELARK_SEEDANCE_ENDPOINT_ID: "seedance-test-endpoint",
  MODELARK_VIDEO_RESOLUTION: "480p"
});

describe("production ModelArk registry callback boundary", () => {
  it("uses authoritative task polling without requiring a callback secret", () => {
    const registry = loadModelRegistry(productionEnvironment);
    expect(registry.modelArk.video.callbackBaseUrl).toBe("");
    expect(registry.modelArk.video.callbackSecret).toBe("");
  });

  it("rejects callback settings until a durable callback route exists", () => {
    expect(() => loadModelRegistry({
      ...productionEnvironment,
      MODELARK_VIDEO_CALLBACK_BASE_URL: "https://api.heyirmy.com/api/modelark/callback",
      MODELARK_VIDEO_CALLBACK_SECRET: "test-only-callback-secret"
    })).toThrow(/callback delivery is not enabled/i);
  });
});
