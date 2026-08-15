const { createPostgresDatabase } = require("../persistence/postgres-database");
const { BullMqWorkflowQueue, loadBullMqConfig } = require("../queue/bullmq-workflow-queue");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");
const { evaluateOperationsAlerts, readOperationsSnapshot } = require("./operations-snapshot");

function threshold(environment, name) {
  const value = environment[name];
  return value === undefined || value === "" ? undefined : Number(value);
}

async function main({ environment = process.env, logger = console } = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  const database = createPostgresDatabase({ environment: hydrated, logger });
  const queue = new BullMqWorkflowQueue({ config: loadBullMqConfig(hydrated), logger });
  try {
    await database.assertReady();
    await queue.assertReady();
    const snapshot = await readOperationsSnapshot({ database, queue });
    const alerts = evaluateOperationsAlerts(snapshot, {
      oldestReadySeconds: threshold(hydrated, "PETPACK_ALERT_OUTBOX_OLDEST_READY_SECONDS"),
      outboxDead: threshold(hydrated, "PETPACK_ALERT_OUTBOX_DEAD_COUNT"),
      executionDead: threshold(hydrated, "PETPACK_ALERT_EXECUTION_DEAD_COUNT"),
      reconciliationRequired: threshold(hydrated, "PETPACK_ALERT_RECONCILIATION_REQUIRED_COUNT"),
      queueFailed: threshold(hydrated, "PETPACK_ALERT_QUEUE_FAILED_COUNT")
    });
    const report = Object.freeze({ ok: alerts.length === 0, snapshot, alerts });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (alerts.length > 0) process.exitCode = 1;
    return report;
  } finally {
    await queue.close().catch(() => undefined);
    await database.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`petpack.operations_snapshot.failed error=${error?.code || error?.name || "Error"}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
