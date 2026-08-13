const { createProductionAuthApiRuntime } = require("./create-production-auth-api");

async function main() {
  const runtime = await createProductionAuthApiRuntime();
  await runtime.start();
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.info("petpack.production_auth_api.stopping", { signal });
    try {
      await runtime.close();
      process.exitCode = 0;
    } catch (error) {
      console.error("petpack.production_auth_api.stop_failed", { errorName: error?.name || "Error" });
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.production_auth_api.start_failed", { errorName: error?.name || "Error" });
    process.exitCode = 1;
  });
}

module.exports = { main };
