const { createLocalAuthApiRuntime } = require("./create-local-auth-api");

async function main() {
  const runtime = await createLocalAuthApiRuntime();
  await runtime.start();
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.info("petpack.local_auth_api.stopping", { signal });
    try {
      await runtime.close();
      process.exitCode = 0;
    } catch (error) {
      console.error("petpack.local_auth_api.stop_failed", { errorName: error && error.name ? error.name : "Error" });
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("petpack.local_auth_api.start_failed", { errorName: error && error.name ? error.name : "Error" });
    process.exitCode = 1;
  });
}

module.exports = { main };
