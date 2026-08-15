const SNAPSHOT_SCHEMA_VERSION = "petpack-operations-snapshot/v1";

const QUEUE_COUNT_NAMES = Object.freeze([
  "waiting", "active", "completed", "failed", "delayed", "paused",
  "prioritized", "waiting-children"
]);

function nonNegativeInteger(value, label) {
  const numeric = Number(value ?? 0);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return numeric;
}

function safeIso(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp)) throw new Error("Operations snapshot clock is invalid");
  return new Date(timestamp).toISOString();
}

function normalizeQueueCounts(counts = {}) {
  return Object.freeze(Object.fromEntries(
    QUEUE_COUNT_NAMES.map((name) => {
      const key = name.replaceAll("-", "_");
      const value = counts[name] ?? (name === "waiting" ? counts.wait : undefined);
      return [key, nonNegativeInteger(value, `Queue ${name} count`)];
    })
  ));
}

function normalizeRow(row = {}) {
  return Object.freeze({
    outbox: Object.freeze({
      pending: nonNegativeInteger(row.outbox_pending, "Outbox pending count"),
      leased: nonNegativeInteger(row.outbox_leased, "Outbox leased count"),
      failed: nonNegativeInteger(row.outbox_failed, "Outbox failed count"),
      dead: nonNegativeInteger(row.outbox_dead, "Outbox dead count"),
      ready: nonNegativeInteger(row.outbox_ready, "Outbox ready count"),
      expiredLeases: nonNegativeInteger(row.outbox_expired_leases, "Outbox expired lease count"),
      oldestReadySeconds: nonNegativeInteger(row.outbox_oldest_ready_seconds, "Outbox oldest ready age")
    }),
    executions: Object.freeze({
      pending: nonNegativeInteger(row.execution_pending, "Execution pending count"),
      leased: nonNegativeInteger(row.execution_leased, "Execution leased count"),
      retryable: nonNegativeInteger(row.execution_retryable, "Execution retryable count"),
      succeeded: nonNegativeInteger(row.execution_succeeded, "Execution succeeded count"),
      reconciliationRequired: nonNegativeInteger(row.execution_reconciliation_required, "Execution reconciliation count"),
      dead: nonNegativeInteger(row.execution_dead, "Execution dead count"),
      expiredLeases: nonNegativeInteger(row.execution_expired_leases, "Execution expired lease count")
    })
  });
}

async function readOperationsSnapshot({ database, queue, now = Date.now } = {}) {
  if (!database || typeof database.query !== "function") throw new Error("Operations snapshot database is required");
  if (!queue || typeof queue.getJobCounts !== "function") throw new Error("Operations snapshot queue is required");
  const result = await database.query(`
    WITH outbox AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS outbox_pending,
        COUNT(*) FILTER (WHERE status = 'leased') AS outbox_leased,
        COUNT(*) FILTER (WHERE status = 'failed') AS outbox_failed,
        COUNT(*) FILTER (WHERE status = 'dead') AS outbox_dead,
        COUNT(*) FILTER (WHERE status IN ('pending', 'failed') AND available_at <= now()) AS outbox_ready,
        COUNT(*) FILTER (WHERE status = 'leased' AND leased_until <= now()) AS outbox_expired_leases,
        COALESCE(EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (
          WHERE status IN ('pending', 'failed') AND available_at <= now()
        )))::bigint, 0) AS outbox_oldest_ready_seconds
      FROM outbox_job
    ), executions AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS execution_pending,
        COUNT(*) FILTER (WHERE status = 'leased') AS execution_leased,
        COUNT(*) FILTER (WHERE status = 'retryable') AS execution_retryable,
        COUNT(*) FILTER (WHERE status = 'succeeded') AS execution_succeeded,
        COUNT(*) FILTER (WHERE status = 'reconciliation_required') AS execution_reconciliation_required,
        COUNT(*) FILTER (WHERE status = 'dead') AS execution_dead,
        COUNT(*) FILTER (WHERE status = 'leased' AND leased_until <= now()) AS execution_expired_leases
      FROM production_job_execution
    )
    SELECT outbox.*, executions.* FROM outbox CROSS JOIN executions
  `);
  const row = Array.isArray(result?.rows) ? result.rows[0] : null;
  if (!row) throw new Error("Operations snapshot query returned no row");
  const normalized = normalizeRow(row);
  const queueCounts = normalizeQueueCounts(await queue.getJobCounts());
  return Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: safeIso(typeof now === "function" ? now() : now),
    ...normalized,
    queue: queueCounts
  });
}

function boundedThreshold(value, fallback, label) {
  const numeric = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 2_147_483_647) {
    throw new Error(`${label} must be a non-negative bounded integer`);
  }
  return numeric;
}

function evaluateOperationsAlerts(snapshot, thresholds = {}) {
  if (!snapshot || snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Operations snapshot schema is invalid");
  }
  const limits = {
    oldestReadySeconds: boundedThreshold(thresholds.oldestReadySeconds, 60, "Oldest outbox age threshold"),
    outboxDead: boundedThreshold(thresholds.outboxDead, 0, "Outbox dead threshold"),
    executionDead: boundedThreshold(thresholds.executionDead, 0, "Execution dead threshold"),
    reconciliationRequired: boundedThreshold(thresholds.reconciliationRequired, 0, "Reconciliation threshold"),
    queueFailed: boundedThreshold(thresholds.queueFailed, 0, "Queue failed threshold")
  };
  const alerts = [];
  if (snapshot.outbox.oldestReadySeconds > limits.oldestReadySeconds) {
    alerts.push(Object.freeze({ code: "outbox_oldest_ready", value: snapshot.outbox.oldestReadySeconds, threshold: limits.oldestReadySeconds }));
  }
  if (snapshot.outbox.dead > limits.outboxDead) {
    alerts.push(Object.freeze({ code: "outbox_dead", value: snapshot.outbox.dead, threshold: limits.outboxDead }));
  }
  if (snapshot.executions.dead > limits.executionDead) {
    alerts.push(Object.freeze({ code: "execution_dead", value: snapshot.executions.dead, threshold: limits.executionDead }));
  }
  if (snapshot.executions.reconciliationRequired > limits.reconciliationRequired) {
    alerts.push(Object.freeze({ code: "execution_reconciliation_required", value: snapshot.executions.reconciliationRequired, threshold: limits.reconciliationRequired }));
  }
  if (snapshot.queue.failed > limits.queueFailed) {
    alerts.push(Object.freeze({ code: "queue_failed", value: snapshot.queue.failed, threshold: limits.queueFailed }));
  }
  return Object.freeze(alerts);
}

module.exports = {
  QUEUE_COUNT_NAMES,
  SNAPSHOT_SCHEMA_VERSION,
  evaluateOperationsAlerts,
  normalizeQueueCounts,
  normalizeRow,
  readOperationsSnapshot
};
