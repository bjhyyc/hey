const { createStudioApiRuntime } = require("./create-studio-api");

// The runtime defaults an absent PETPACK_PLATFORM_MODE to development, which
// is right for a developer's shell and wrong for a container: development
// mode relaxes TLS, cookie and token checks. A container has to say which
// mode it means.
function requireExplicitMode(environment) {
  const mode = typeof environment.PETPACK_PLATFORM_MODE === "string" ? environment.PETPACK_PLATFORM_MODE.trim() : "";
  if (!mode) throw new Error("PETPACK_PLATFORM_MODE must be set explicitly for a container entrypoint");
  return environment;
}

async function main({ environment = process.env, logger = console } = {}) {
  const runtime = await createStudioApiRuntime({ environment: requireExplicitMode(environment), logger });
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info?.("petpack.studio_api.stopping", { signal });
    await runtime.close();
  };
  process.once("SIGTERM", () => close("SIGTERM").catch((error) => {
    logger.error?.("petpack.studio_api.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  process.once("SIGINT", () => close("SIGINT").catch((error) => {
    logger.error?.("petpack.studio_api.stop_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  }));
  const address = await runtime.start();
  return { runtime, address };
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.studio_api.start_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  });
}

module.exports = { main };
