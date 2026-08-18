import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  PRODUCTION_WORKER_COMPONENT_MANIFEST_CONTRACT_VERSION,
  checksumProductionWorkerComponentManifest,
  normalizeProductionWorkerComponentManifest,
  verifyProductionWorkerComponentManifest
} = require("../../platform/src/runtime/production-worker-component-manifest");

const DIGESTS = Object.freeze({
  masterImageProcessor: "1".repeat(64),
  mattingService: "2".repeat(64),
  qaPolicyProvider: "3".repeat(64),
  deliveryValidator: "4".repeat(64)
});

function metadata(id) {
  return {
    version: `${id}/1.0.0`,
    contractVersion: `${id}-contract/v1`,
    calibrationDigest: DIGESTS[id]
  };
}

function manifest(overrides = {}) {
  return {
    contractVersion: PRODUCTION_WORKER_COMPONENT_MANIFEST_CONTRACT_VERSION,
    evidenceClass: "production",
    components: Object.fromEntries(
      Object.keys(DIGESTS).map((id) => [id, metadata(id)])
    ),
    ...overrides
  };
}

function frozenComponent(id, overrides = {}, metadataOverrides = {}) {
  const component = { run() {}, ...overrides };
  Object.defineProperty(component, "productionMetadata", {
    value: Object.freeze({ ...metadata(id), ...metadataOverrides }),
    enumerable: true,
    writable: false,
    configurable: false
  });
  return Object.freeze(component);
}

function components(overrides = {}) {
  return {
    masterImageProcessor: frozenComponent("masterImageProcessor"),
    mattingService: frozenComponent("mattingService"),
    qaPolicyProvider: frozenComponent("qaPolicyProvider"),
    deliveryValidator: frozenComponent("deliveryValidator"),
    mediaProcessorVersion: metadata("mattingService").version,
    ...overrides
  };
}

describe("production Worker component manifest", () => {
  it("normalizes and verifies one exact production manifest against frozen live components", () => {
    const input = manifest();
    const sha256 = checksumProductionWorkerComponentManifest(input);
    const result = verifyProductionWorkerComponentManifest({
      manifest: input,
      components: components(),
      expectedSha256: sha256
    });
    expect(result).toEqual({
      sha256,
      manifest: normalizeProductionWorkerComponentManifest(input)
    });
    expect(Object.isFrozen(result.manifest.components)).toBe(true);
  });

  it("rejects development evidence, unknown fields, and missing component identities", () => {
    expect(() => normalizeProductionWorkerComponentManifest({
      ...manifest(),
      evidenceClass: "development"
    })).toThrow(/must be production/);
    expect(() => normalizeProductionWorkerComponentManifest({
      ...manifest(),
      extra: true
    })).toThrow(/unknown field/);
    const missing = manifest();
    delete missing.components.deliveryValidator;
    expect(() => normalizeProductionWorkerComponentManifest(missing)).toThrow(/missing required field/);
  });

  it("rejects a changed manifest digest or live metadata mismatch", () => {
    const input = manifest();
    expect(() => verifyProductionWorkerComponentManifest({
      manifest: input,
      components: components(),
      expectedSha256: "f".repeat(64)
    })).toThrow(/pinned SHA-256/);
    expect(() => verifyProductionWorkerComponentManifest({
      manifest: input,
      components: components({
        qaPolicyProvider: frozenComponent("qaPolicyProvider", {}, {
          calibrationDigest: "9".repeat(64)
        })
      }),
      expectedSha256: checksumProductionWorkerComponentManifest(input)
    })).toThrow(/calibrationDigest does not match/);
  });

  it("rejects mutable components, accessor metadata, and a divergent media processor version", () => {
    const input = manifest();
    const sha256 = checksumProductionWorkerComponentManifest(input);
    const mutable = { run() {} };
    Object.defineProperty(mutable, "productionMetadata", {
      value: Object.freeze(metadata("masterImageProcessor")),
      enumerable: true,
      writable: false,
      configurable: false
    });
    expect(() => verifyProductionWorkerComponentManifest({
      manifest: input,
      components: components({ masterImageProcessor: mutable }),
      expectedSha256: sha256
    })).toThrow(/must be frozen/);

    const accessor = Object.freeze(Object.defineProperty({}, "productionMetadata", {
      get: () => Object.freeze(metadata("masterImageProcessor")),
      enumerable: true,
      configurable: false
    }));
    expect(() => verifyProductionWorkerComponentManifest({
      manifest: input,
      components: components({ masterImageProcessor: accessor }),
      expectedSha256: sha256
    })).toThrow(/immutable own data property/);

    expect(() => verifyProductionWorkerComponentManifest({
      manifest: input,
      components: components({ mediaProcessorVersion: "other/v1" }),
      expectedSha256: sha256
    })).toThrow(/does not match mattingService/);
  });
});
