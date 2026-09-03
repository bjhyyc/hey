/**
 * Runs one support-console disposal from inside the deployed API container,
 * for the moments the console itself cannot reach the disposal yet - a web
 * build that has not been deployed, or an administrator locked out of the
 * browser. It composes the exact object graph the HTTP API composes
 * (repository, workflow store, workflow, AdminOrdersService), so every
 * validation, transaction and audit row is the same as a click in the console.
 *
 *   node src/runtime/admin-rescue.js --order <orderId> --stage <stage> --reason "<why>"
 *
 * Stages are the console's: front_master | side_master | sleep_master |
 * package | action:<actionId>. The acting administrator is the single active
 * admin account; the script refuses to run when there is not exactly one.
 * Credentials arrive as mounted secret files, the way the runtime reads them.
 */

const { AdminOrdersService } = require("../api/admin-orders-service");
const { loadKaipayConfig } = require("../providers/kaipay-payment-provider");
const { createPaymentProvider } = require("../providers/payment-provider-factory");
const { loadModelRegistry } = require("../config/model-registry");
const { PostgresPetPackStudioRepository } = require("../persistence/postgres-petpack-studio-repository");
const { createPostgresDatabase } = require("../persistence/postgres-database");
const { PostgresTransactionalWorkflowStore } = require("../persistence/postgres-transactional-workflow-store");
const { ProductionWorkflow } = require("../workflow/production-workflow");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

function usage() {
  return [
    "usage: admin-rescue.js --order <orderId> --stage <front_master|side_master|sleep_master|package|action:<id>> --reason \"<why>\"",
    "       admin-rescue.js --order <orderId> --refund --reason \"<why>\"",
    "The refund form composes the real Kaipay provider; the request is idempotent",
    "(refund row ID = refundRequestNo), so retrying a refund the console already",
    "initiated repeats the same provider request rather than starting a second one."
  ].join("\n");
}

function argument(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) return null;
  const value = String(argv[index + 1]).trim();
  return value ? value : null;
}

async function resolveAdministrator(database) {
  const result = await database.query(
    "SELECT id FROM app_user WHERE role = 'admin' AND status = 'active'"
  );
  const rows = Array.isArray(result && result.rows) ? result.rows : [];
  if (rows.length !== 1) {
    throw new Error(`Exactly one active administrator is required; found ${rows.length}`);
  }
  return { id: rows[0].id, role: "admin" };
}

async function runRescue({ database, environment, orderId, stage, reason, refund = false, logger }) {
  const repository = new PostgresPetPackStudioRepository({
    database,
    paymentNotificationEncryptionKey: environment.PETPACK_PAYMENT_NOTIFICATION_ENCRYPTION_KEY,
    logger
  });
  const runStore = new PostgresTransactionalWorkflowStore({ database, logger });
  const workflow = new ProductionWorkflow({
    runStore,
    promptStore: repository,
    modelRegistry: loadModelRegistry(environment),
    logger
  });
  // The real payment provider is composed only for the refund form, so a
  // plain rerun cannot touch Kaipay even by accident.
  const paymentProvider = refund
    ? createPaymentProvider({
        config: loadKaipayConfig(environment),
        fetchImpl: globalThis.fetch,
        eventStore: repository,
        orderStore: repository,
        logger
      })
    : null;
  const adminOrders = new AdminOrdersService({
    repository,
    workflow,
    // Reruns never sign a preview; the store is required by the service's
    // constructor, so this stub says so loudly if a code path ever asks.
    objectStore: {
      createDownloadGrant: async () => {
        throw new Error("admin-rescue does not sign previews");
      }
    },
    paymentProvider,
    refundEnabled: refund,
    logger
  });
  const actor = await resolveAdministrator(database);
  if (refund) return adminOrders.refundOrder({ actor, orderId, reason });
  return adminOrders.rerunStage({ actor, orderId, stage, reason });
}

async function main({ argv = process.argv.slice(2), environment = process.env, logger = console } = {}) {
  const orderId = argument(argv, "--order");
  const stage = argument(argv, "--stage");
  const reason = argument(argv, "--reason");
  const refund = argv.includes("--refund");
  if (!orderId || !reason || (refund ? stage !== null : !stage)) {
    logger.info?.(usage());
    return null;
  }
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  const database = createPostgresDatabase({ environment: hydrated, logger });
  try {
    const result = await runRescue({ database, environment: hydrated, orderId, stage, reason, refund, logger });
    logger.info?.(JSON.stringify(result));
    return result;
  } finally {
    if (typeof database.close === "function") await database.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : "admin rescue failed"}\n`);
    process.exit(1);
  });
}

module.exports = { main, runRescue, resolveAdministrator, usage };
