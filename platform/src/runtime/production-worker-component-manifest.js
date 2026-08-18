"use strict";

const crypto = require("node:crypto");

const PRODUCTION_WORKER_COMPONENT_MANIFEST_CONTRACT_VERSION =
  "petpack-production-worker-component-manifest/v1";
const PRODUCTION_WORKER_COMPONENT_EVIDENCE_CLASS = "production";
const REQUIRED_PRODUCTION_WORKER_COMPONENT_IDS = Object.freeze([
  "masterImageProcessor",
  "mattingService",
  "qaPolicyProvider",
  "deliveryValidator"
]);
const MANIFEST_KEYS = Object.freeze(["contractVersion", "evidenceClass", "components"]);
const COMPONENT_METADATA_KEYS = Object.freeze(["version", "contractVersion", "calibrationDigest"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactDataShape(value, expectedKeys, label) {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} contains unknown symbol fields`);
  }
  const actualKeys = Object.getOwnPropertyNames(value);
  const unknown = actualKeys.filter((key) => !expectedKeys.includes(key));
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field: ${unknown[0]}`);
  if (missing.length > 0) throw new Error(`${label} is missing required field: ${missing[0]}`);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
  }
}

function requiredVersion(value, label) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(`${label} must be a versioned component identity`);
  }
  return value;
}

function requiredSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireProductionWorkerComponentManifestSha256(value) {
  return requiredSha256(value, "PETPACK_WORKER_COMPONENTS_MANIFEST_SHA256");
}

function normalizeComponentMetadata(value, label) {
  assertExactDataShape(value, COMPONENT_METADATA_KEYS, label);
  return Object.freeze({
    version: requiredVersion(value.version, `${label}.version`),
    contractVersion: requiredVersion(value.contractVersion, `${label}.contractVersion`),
    calibrationDigest: requiredSha256(value.calibrationDigest, `${label}.calibrationDigest`)
  });
}

function normalizeProductionWorkerComponentManifest(manifest) {
  assertExactDataShape(manifest, MANIFEST_KEYS, "Production Worker component manifest");
  if (manifest.contractVersion !== PRODUCTION_WORKER_COMPONENT_MANIFEST_CONTRACT_VERSION) {
    throw new Error("Production Worker component manifest contractVersion is unsupported");
  }
  if (manifest.evidenceClass !== PRODUCTION_WORKER_COMPONENT_EVIDENCE_CLASS) {
    throw new Error("Production Worker component manifest evidenceClass must be production");
  }
  assertExactDataShape(
    manifest.components,
    REQUIRED_PRODUCTION_WORKER_COMPONENT_IDS,
    "Production Worker component manifest.components"
  );
  const normalizedComponents = Object.fromEntries(
    REQUIRED_PRODUCTION_WORKER_COMPONENT_IDS.map((componentId) => [
      componentId,
      normalizeComponentMetadata(
        manifest.components[componentId],
        `Production Worker component manifest.components.${componentId}`
      )
    ])
  );
  return Object.freeze({
    contractVersion: PRODUCTION_WORKER_COMPONENT_MANIFEST_CONTRACT_VERSION,
    evidenceClass: PRODUCTION_WORKER_COMPONENT_EVIDENCE_CLASS,
    components: Object.freeze(normalizedComponents)
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function checksumProductionWorkerComponentManifest(manifest) {
  const normalized = normalizeProductionWorkerComponentManifest(manifest);
  return crypto.createHash("sha256").update(canonicalJson(normalized), "utf8").digest("hex");
}

function readFrozenProductionMetadata(component, componentId) {
  if (!component || typeof component !== "object" || Array.isArray(component)) {
    throw new Error(`Production Worker component ${componentId} is required`);
  }
  if (!Object.isFrozen(component)) {
    throw new Error(`Production Worker component ${componentId} must be frozen before verification`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(component, "productionMetadata");
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true ||
      descriptor.writable !== false || descriptor.configurable !== false) {
    throw new Error(
      `Production Worker component ${componentId}.productionMetadata must be an immutable own data property`
    );
  }
  if (!Object.isFrozen(descriptor.value)) {
    throw new Error(`Production Worker component ${componentId}.productionMetadata must be frozen`);
  }
  return normalizeComponentMetadata(
    descriptor.value,
    `Production Worker component ${componentId}.productionMetadata`
  );
}

function verifyProductionWorkerComponentManifest({ manifest, components, expectedSha256 } = {}) {
  const normalizedManifest = normalizeProductionWorkerComponentManifest(manifest);
  const pinnedSha256 = requireProductionWorkerComponentManifestSha256(expectedSha256);
  const actualSha256 = crypto.createHash("sha256")
    .update(canonicalJson(normalizedManifest), "utf8")
    .digest("hex");
  if (actualSha256 !== pinnedSha256) {
    throw new Error("Production Worker component manifest does not match its pinned SHA-256 digest");
  }
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    throw new Error("Production Worker components are required for manifest verification");
  }
  for (const componentId of REQUIRED_PRODUCTION_WORKER_COMPONENT_IDS) {
    const componentDescriptor = Object.getOwnPropertyDescriptor(components, componentId);
    if (!componentDescriptor || !("value" in componentDescriptor)) {
      throw new Error(`Production Worker component ${componentId} must be an own data property`);
    }
    const actualMetadata = readFrozenProductionMetadata(componentDescriptor.value, componentId);
    const expectedMetadata = normalizedManifest.components[componentId];
    for (const field of COMPONENT_METADATA_KEYS) {
      if (actualMetadata[field] !== expectedMetadata[field]) {
        throw new Error(
          `Production Worker component ${componentId}.${field} does not match the pinned manifest`
        );
      }
    }
  }
  const mediaProcessorVersionDescriptor = Object.getOwnPropertyDescriptor(
    components,
    "mediaProcessorVersion"
  );
  if (!mediaProcessorVersionDescriptor || !("value" in mediaProcessorVersionDescriptor)) {
    throw new Error("Production Worker components.mediaProcessorVersion must be an own data property");
  }
  if (mediaProcessorVersionDescriptor.value !== normalizedManifest.components.mattingService.version) {
    throw new Error(
      "Production Worker components.mediaProcessorVersion does not match mattingService.version"
    );
  }
  return Object.freeze({
    sha256: actualSha256,
    manifest: normalizedManifest
  });
}

module.exports = {
  COMPONENT_METADATA_KEYS,
  PRODUCTION_WORKER_COMPONENT_EVIDENCE_CLASS,
  PRODUCTION_WORKER_COMPONENT_MANIFEST_CONTRACT_VERSION,
  REQUIRED_PRODUCTION_WORKER_COMPONENT_IDS,
  canonicalJson,
  checksumProductionWorkerComponentManifest,
  normalizeProductionWorkerComponentManifest,
  requireProductionWorkerComponentManifestSha256,
  verifyProductionWorkerComponentManifest
};
