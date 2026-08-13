const { loadTencentCloudBaseAuthConfig } = require("/app/platform/src/providers/tencent-cloudbase-identity-verifier");
const { createPostgresDatabase, loadPostgresDatabaseConfig } = require("/app/platform/src/persistence/postgres-database");
const { hydrateEnvironmentFromSecretFiles } = require("/app/platform/src/runtime/load-secret-files");
const { BullMqWorkflowQueue, loadBullMqConfig } = require("/app/platform/src/queue/bullmq-workflow-queue");

function safeMessage(error) {
  return String(error?.message || "unknown_error")
    .replace(/(?:postgres(?:ql)?|rediss?):\/\/\S+/gi, "[connection-url]")
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, "[redacted]")
    .slice(0, 300);
}

async function main() {
  let stage = "secret_files";
  let database;
  let queue;
  try {
    const environment = hydrateEnvironmentFromSecretFiles({ environment: process.env });
    console.log("secret_files=ok");
    stage = "postgres_config";
    loadPostgresDatabaseConfig(environment);
    console.log("postgres_config=ok");
    stage = "postgres_tls";
    database = createPostgresDatabase({ environment });
    await database.assertReady();
    console.log("postgres_tls=ok schema=ready");
    stage = "cloudbase_config";
    loadTencentCloudBaseAuthConfig(environment);
    console.log("cloudbase_config=ok");
    stage = "redis_queue_tls";
    queue = new BullMqWorkflowQueue({ config: loadBullMqConfig(environment) });
    await queue.assertReady();
    console.log("redis_queue_tls=ok bullmq=ready");
  } catch (error) {
    console.error(`${stage}=fail ${safeMessage(error)}`);
    process.exitCode = 1;
  } finally {
    await database?.close().catch(() => undefined);
    await queue?.close().catch(() => undefined);
  }
}

void main();
