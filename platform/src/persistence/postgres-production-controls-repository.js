const crypto = require("node:crypto");

const { normalizePriceCard } = require("../domain/provider-cost-accounting");

const MAX_COST_RANGE_DAYS = 366;
const COST_OPERATIONS = new Set(["seedream_front", "seedream_side", "seedream_sleep", "seedance_video"]);
const COST_ACTION_IDS = new Set([
  "idle", "sneeze", "roll", "sleep-transition", "sleep-loop", "stretch", "hover-attention"
]);

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function") {
    throw new Error("A PostgreSQL transaction runner is required for production controls");
  }
  return database;
}

function rows(result) {
  return Array.isArray(result && result.rows) ? result.rows : [];
}

function oneRow(result, message) {
  const found = rows(result);
  if (found.length !== 1) throw new Error(message);
  return found[0];
}

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`${label} is required`);
  return value.trim();
}

function parseTimestamp(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function normalizeCostSummaryQuery({ from, to, operation, actionId, bucket = "day" } = {}) {
  const start = parseTimestamp(from, "Cost range start");
  const end = parseTimestamp(to, "Cost range end");
  const milliseconds = end.getTime() - start.getTime();
  if (milliseconds <= 0 || milliseconds > MAX_COST_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error(`Cost range must be positive and no longer than ${MAX_COST_RANGE_DAYS} days`);
  }
  if (bucket !== "day") throw new Error("Cost summary accepts only the day bucket");
  const normalizedOperation = operation === null || operation === undefined || operation === ""
    ? null
    : requiredString(operation, "Cost operation", 64);
  if (normalizedOperation && !COST_OPERATIONS.has(normalizedOperation)) throw new Error("Cost operation is invalid");
  const normalizedActionId = actionId === null || actionId === undefined || actionId === ""
    ? null
    : requiredString(actionId, "Cost action ID", 64);
  if (normalizedActionId && !COST_ACTION_IDS.has(normalizedActionId)) throw new Error("Cost action ID is invalid");
  if (normalizedActionId && normalizedOperation && normalizedOperation !== "seedance_video") {
    throw new Error("Image cost operations cannot be filtered by a video action");
  }
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    operation: normalizedOperation,
    actionId: normalizedActionId,
    bucket
  };
}

const USAGE_ROLLUP_CTE = `WITH filtered_attempt AS (
  SELECT attempt.id, attempt.operation, attempt.action_id, attempt.created_at,
         attempt.expected_billable_rate_count
    FROM provider_usage_attempt attempt
   WHERE attempt.created_at >= $1::timestamptz
     AND attempt.created_at < $2::timestamptz
     AND ($3::text IS NULL OR attempt.operation = $3)
     AND ($4::text IS NULL OR attempt.action_id = $4)
), event_rollup AS (
  SELECT event.attempt_id,
         bool_or(event.event_type = 'provider_accepted') AS accepted,
         bool_or(event.event_type = 'output_succeeded') AS succeeded,
         bool_or(event.event_type = 'explicitly_rejected') AS rejected,
         bool_or(event.event_type = 'provider_failed') AS failed,
         bool_or(event.event_type IN ('submission_unknown', 'provider_status_unknown')) AS unknown,
         bool_or(event.event_type = 'billing_unpriced') AS unpriced,
         bool_or(event.event_type IN ('billing_applied', 'billing_adjustment')) AS billed,
         count(DISTINCT event.price_rate_id) FILTER (WHERE event.event_type = 'billing_applied') AS billed_rate_count,
         COALESCE(sum(event.cost_delta_cny) FILTER (WHERE event.event_type = 'billing_applied'), 0::numeric) AS confirmed_cost_cny,
         COALESCE(sum(event.cost_delta_cny) FILTER (WHERE event.event_type = 'billing_adjustment'), 0::numeric) AS adjustment_cost_cny
    FROM provider_usage_event event
    JOIN filtered_attempt attempt ON attempt.id = event.attempt_id
   GROUP BY event.attempt_id
), latest_outcome AS (
  SELECT DISTINCT ON (event.attempt_id) event.attempt_id, event.event_type
    FROM provider_usage_event event
    JOIN filtered_attempt attempt ON attempt.id = event.attempt_id
   WHERE event.event_type IN (
     'provider_accepted', 'explicitly_rejected', 'submission_unknown',
     'provider_status_unknown', 'provider_failed', 'output_succeeded', 'invoice_reconciled'
   )
   ORDER BY event.attempt_id, event.sequence_id DESC
), usage AS (
  SELECT attempt.*,
         COALESCE(events.accepted, false) AS accepted,
         COALESCE(events.succeeded, false) AS succeeded,
         COALESCE(events.rejected, false) AS rejected,
         COALESCE(events.failed, false) AS failed,
         COALESCE(events.unknown, false) AS unknown,
         COALESCE(events.unpriced, false) AS unpriced,
         COALESCE(events.billed, false) AS billed,
         COALESCE(events.billed_rate_count, 0) AS billed_rate_count,
         COALESCE(events.confirmed_cost_cny, 0::numeric) AS confirmed_cost_cny,
         COALESCE(events.adjustment_cost_cny, 0::numeric) AS adjustment_cost_cny,
         (latest.event_type IS NULL
           OR latest.event_type IN ('submission_unknown', 'provider_status_unknown')
           OR (latest.event_type IN ('provider_accepted', 'output_succeeded', 'invoice_reconciled')
             AND attempt.expected_billable_rate_count > COALESCE(events.billed_rate_count, 0)
             AND NOT COALESCE(events.unpriced, false))) AS unresolved
    FROM filtered_attempt attempt
    LEFT JOIN event_rollup events ON events.attempt_id = attempt.id
    LEFT JOIN latest_outcome latest ON latest.attempt_id = attempt.id
)`;

function mapSummaryRow(row) {
  const decimal = (value) => {
    const text = String(value ?? "0");
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) throw new Error("PostgreSQL returned an invalid exact cost decimal");
    return text;
  };
  const count = (value) => {
    const numeric = Number(value || 0);
    if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error("PostgreSQL returned an invalid usage count");
    return numeric;
  };
  return {
    attempted: count(row.attempted),
    accepted: count(row.accepted),
    succeeded: count(row.succeeded),
    rejected: count(row.rejected),
    failed: count(row.failed),
    unknown: count(row.unknown),
    unpriced: count(row.unpriced),
    unresolved: count(row.unresolved),
    confirmedCostCny: decimal(row.confirmed_cost_cny),
    adjustmentCostCny: decimal(row.adjustment_cost_cny),
    totalCostCny: decimal(row.total_cost_cny)
  };
}

class PostgresProductionControlsRepository {
  constructor({ database, idFactory = crypto.randomUUID, logger = console } = {}) {
    this.database = requireDatabase(database);
    if (typeof idFactory !== "function") throw new Error("A UUID ID factory is required");
    this.idFactory = idFactory;
    this.logger = logger;
  }

  async publishPriceCard({ actorId, priceCard } = {}) {
    const adminId = requiredString(actorId, "Price publisher ID", 128);
    const card = normalizePriceCard(priceCard);
    return this.database.transaction(async (tx) => {
      const cardId = this.idFactory();
      const inserted = oneRow(await tx.query(
        `INSERT INTO provider_price_card
          (id, provider, version, currency, source_contract_reference, effective_from, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, provider, version, currency, effective_from`,
        [cardId, card.provider, card.version, card.currency, card.sourceContractReference,
          card.effectiveFrom, adminId]
      ), "Provider price card could not be published immutably");
      for (const rate of card.rates) {
        await tx.query(
          `INSERT INTO provider_price_rate
            (id, card_id, rate_code, operation, model_registry_version, endpoint_id,
             resolution, output_size, duration_seconds, billing_trigger, billing_unit,
             unit_quantity, unit_price_cny, rounding_mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [this.idFactory(), cardId, rate.rateCode, rate.operation, rate.modelRegistryVersion,
            rate.endpointId, rate.resolution, rate.outputSize, rate.durationSeconds,
            rate.billingTrigger, rate.billingUnit, rate.unitQuantity, rate.unitPriceCny,
            rate.roundingMode]
        );
      }
      const published = oneRow(await tx.query(
        `UPDATE provider_price_card
            SET published_at = now()
          WHERE id = $1 AND published_at IS NULL
      RETURNING id, provider, version, currency, effective_from, published_at`,
        [inserted.id]
      ), "Provider price card could not be sealed after inserting all rates");
      this.logger.info?.("petpack.admin.provider_price_card_published", {
        provider: card.provider,
        version: card.version,
        rateCount: card.rates.length,
        effectiveFrom: card.effectiveFrom
      });
      return {
        id: published.id,
        provider: published.provider,
        version: published.version,
        currency: published.currency,
        effectiveFrom: new Date(published.effective_from).toISOString(),
        publishedAt: new Date(published.published_at).toISOString(),
        rateCount: card.rates.length
      };
    });
  }

  async summarizeProviderUsage(input = {}) {
    const query = normalizeCostSummaryQuery(input);
    return this.database.transaction(async (tx) => {
      const parameters = [query.from, query.to, query.operation, query.actionId];
      const total = oneRow(await tx.query(
        `${USAGE_ROLLUP_CTE}
         SELECT count(*) AS attempted,
                count(*) FILTER (WHERE accepted) AS accepted,
                count(*) FILTER (WHERE succeeded) AS succeeded,
                count(*) FILTER (WHERE rejected) AS rejected,
                count(*) FILTER (WHERE failed) AS failed,
                count(*) FILTER (WHERE unknown) AS unknown,
                count(*) FILTER (WHERE unpriced) AS unpriced,
                count(*) FILTER (WHERE unresolved) AS unresolved,
                COALESCE(sum(confirmed_cost_cny), 0::numeric)::text AS confirmed_cost_cny,
                COALESCE(sum(adjustment_cost_cny), 0::numeric)::text AS adjustment_cost_cny,
                COALESCE(sum(confirmed_cost_cny + adjustment_cost_cny), 0::numeric)::text AS total_cost_cny
           FROM usage`,
        parameters
      ), "Provider usage total could not be summarized");
      const grouped = rows(await tx.query(
        `${USAGE_ROLLUP_CTE}
         SELECT date_trunc('day', created_at) AS bucket_start,
                operation, action_id,
                count(*) AS attempted,
                count(*) FILTER (WHERE accepted) AS accepted,
                count(*) FILTER (WHERE succeeded) AS succeeded,
                count(*) FILTER (WHERE rejected) AS rejected,
                count(*) FILTER (WHERE failed) AS failed,
                count(*) FILTER (WHERE unknown) AS unknown,
                count(*) FILTER (WHERE unpriced) AS unpriced,
                count(*) FILTER (WHERE unresolved) AS unresolved,
                COALESCE(sum(confirmed_cost_cny), 0::numeric)::text AS confirmed_cost_cny,
                COALESCE(sum(adjustment_cost_cny), 0::numeric)::text AS adjustment_cost_cny,
                COALESCE(sum(confirmed_cost_cny + adjustment_cost_cny), 0::numeric)::text AS total_cost_cny
           FROM usage
          GROUP BY date_trunc('day', created_at), operation, action_id
          ORDER BY bucket_start, operation, action_id NULLS FIRST`,
        parameters
      ));
      return {
        range: query,
        currency: "CNY",
        total: mapSummaryRow(total),
        groups: grouped.map((row) => ({
          bucketStart: new Date(row.bucket_start).toISOString(),
          operation: row.operation,
          actionId: row.action_id || null,
          ...mapSummaryRow(row)
        }))
      };
    });
  }
}

module.exports = {
  COST_OPERATIONS,
  MAX_COST_RANGE_DAYS,
  PostgresProductionControlsRepository,
  mapSummaryRow,
  normalizeCostSummaryQuery
};
