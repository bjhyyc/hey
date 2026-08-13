const DEFAULT_MODELARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

function getOptionalString(env, name) {
  const value = env && env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function getPositiveInteger(env, name, fallback) {
  const value = Number(getOptionalString(env, name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function assertConfigured(value, label, errors) {
  if (!value) errors.push(`${label} is required`);
}

function assertProductionRegistryVersion(value, errors) {
  if (!value || value === "unconfigured") {
    errors.push("MODEL_REGISTRY_VERSION is required");
  }
}

/**
 * Server-only registry. Model names/endpoints, quota, region, and retry policy
 * are deployment configuration rather than product-code constants.
 */
function loadModelRegistry(env = process.env) {
  const mode = getOptionalString(env, "PETPACK_PLATFORM_MODE") || "development";
  const registry = {
    version: getOptionalString(env, "MODEL_REGISTRY_VERSION") || "unconfigured",
    mode,
    modelArk: {
      baseUrl: getOptionalString(env, "MODELARK_BASE_URL") || DEFAULT_MODELARK_BASE_URL,
      region: getOptionalString(env, "MODELARK_REGION"),
      apiKey: getOptionalString(env, "MODELARK_API_KEY"),
      image: {
        endpointId: getOptionalString(env, "MODELARK_SEEDREAM_ENDPOINT_ID"),
        // Supported Seedream dimensions vary by enabled endpoint. Omit `size`
        // until an account-specific value is configured, then normalize every
        // output to character_canvas_v1 before it becomes a master.
        outputSize: getOptionalString(env, "MODELARK_SEEDREAM_OUTPUT_SIZE"),
        maxConcurrent: getPositiveInteger(env, "MODELARK_IMAGE_MAX_CONCURRENT", 1),
        maxRetries: getPositiveInteger(env, "MODELARK_IMAGE_MAX_RETRIES", 2)
      },
      video: {
        endpointId: getOptionalString(env, "MODELARK_SEEDANCE_ENDPOINT_ID"),
        resolution: getOptionalString(env, "MODELARK_VIDEO_RESOLUTION") || "720p",
        maxConcurrent: getPositiveInteger(env, "MODELARK_VIDEO_MAX_CONCURRENT", 1),
        maxRetries: getPositiveInteger(env, "MODELARK_VIDEO_MAX_RETRIES", 2),
        callbackBaseUrl: getOptionalString(env, "MODELARK_VIDEO_CALLBACK_BASE_URL"),
        callbackSecret: getOptionalString(env, "MODELARK_VIDEO_CALLBACK_SECRET")
      }
    }
  };

  if (registry.modelArk.video.resolution !== "720p") {
    throw new Error("PetPack Studio supports only 720p Seedance output");
  }

  if (mode === "production") {
    const errors = [];
    assertProductionRegistryVersion(registry.version, errors);
    assertConfigured(registry.modelArk.region, "MODELARK_REGION", errors);
    assertConfigured(registry.modelArk.apiKey, "MODELARK_API_KEY", errors);
    assertConfigured(registry.modelArk.image.endpointId, "MODELARK_SEEDREAM_ENDPOINT_ID", errors);
    assertConfigured(registry.modelArk.video.endpointId, "MODELARK_SEEDANCE_ENDPOINT_ID", errors);
    assertConfigured(registry.modelArk.video.callbackBaseUrl, "MODELARK_VIDEO_CALLBACK_BASE_URL", errors);
    assertConfigured(registry.modelArk.video.callbackSecret, "MODELARK_VIDEO_CALLBACK_SECRET", errors);
    if (errors.length > 0) {
      throw new Error(`Model registry is not production-ready: ${errors.join("; ")}`);
    }
  }

  return registry;
}

function createModelReference(registry, kind) {
  const definition = registry && registry.modelArk && registry.modelArk[kind];
  if (!definition || !definition.endpointId) {
    throw new Error(`ModelArk ${kind} endpoint is not configured`);
  }
  return {
    registryVersion: registry.version,
    region: registry.modelArk.region,
    endpointId: definition.endpointId,
    ...(kind === "video" ? { resolution: definition.resolution } : {})
  };
}

module.exports = {
  DEFAULT_MODELARK_BASE_URL,
  createModelReference,
  loadModelRegistry
};
