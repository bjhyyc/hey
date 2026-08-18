"use strict";

// Operator helper: constructs the production Worker component bundle inside
// the reviewed image environment and prints the canonical component-manifest
// SHA-256 that must be pinned as PETPACK_WORKER_COMPONENTS_MANIFEST_SHA256.
// Read-only: it starts no queue worker and opens no database connection.

const { createWorkerComponents } = require("./production-worker-components");
const { checksumProductionWorkerComponentManifest } = require("./production-worker-component-manifest");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

async function main() {
  const environment = hydrateEnvironmentFromSecretFiles({ environment: process.env });
  const components = await createWorkerComponents({ environment, logger: console });
  try {
    const sha256 = checksumProductionWorkerComponentManifest(components.productionComponentManifest);
    process.stdout.write(`${JSON.stringify({
      manifestSha256: sha256,
      manifest: components.productionComponentManifest
    }, null, 2)}\n`);
  } finally {
    await components.close?.();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});
