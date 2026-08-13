const {
  BILLING_UNITS,
  CURRENCY,
  PROVIDER,
  calculateBillingCharge,
  createUsageDedupeKey,
  parseDecimal
} = require("../domain/provider-cost-accounting");

function rows(result) {
  return Array.isArray(result && result.rows) ? result.rows : [];
}

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`${label} is required`);
  return value.trim();
}

function nullableString(value, label, maxLength = 256) {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, label, maxLength);
}

function safePositiveInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error(`${label} must be a positive safe integer`);
  return numeric;
}

function normalizeUsageAttempt(value) {
  if (!value || typeof value !== "object") throw new Error("Provider usage attempt is required");
  const modelReference = typeof value.modelReference === "string" ? JSON.parse(value.modelReference) : value.modelReference;
  if (!modelReference || typeof modelReference !== "object" || Array.isArray(modelReference)) {
    throw new Error("Provider model reference is required for usage accounting");
  }
  return {
    internalRequestId: requiredString(value.internalRequestId, "Internal provider request ID"),
    projectId: requiredString(value.projectId, "Usage project ID", 128),
    orderId: requiredString(value.orderId, "Usage order ID", 128),
    runId: requiredString(value.runId, "Usage run ID", 128),
    masterImageGenerationId: nullableString(value.masterImageGenerationId, "Master generation ID", 128),
    generationActionId: nullableString(value.generationActionId, "Generation action ID", 128),
    actionId: nullableString(value.actionId, "Usage action ID", 64),
    operation: requiredString(value.operation, "Usage operation", 64),
    workerAttempt: safePositiveInteger(value.workerAttempt, "Usage worker attempt"),
    modelRegistryVersion: requiredString(modelReference.registryVersion, "Usage model registry version", 128),
    endpointId: requiredString(modelReference.endpointId, "Usage provider endpoint ID", 256),
    resolution: nullableString(value.resolution, "Usage resolution", 128),
    outputSize: nullableString(value.outputSize, "Usage output size", 128),
    requestedDurationSeconds: value.requestedDurationSeconds === null || value.requestedDurationSeconds === undefined
      ? null
      : parseDecimal(String(value.requestedDurationSeconds), {
        label: "Requested duration",
        allowZero: false,
        maxScale: 4
      }).value,
    requestedOutputCount: safePositiveInteger(value.requestedOutputCount || 1, "Requested output count")
  };
}

function sameNullable(left, right) {
  return (left === null || left === undefined ? null : String(left)) ===
    (right === null || right === undefined ? null : String(right));
}

function sameNullableDecimal(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left === null || left === undefined) && (right === null || right === undefined);
  }
  try {
    return parseDecimal(String(left), { label: "Immutable usage decimal", allowZero: false, maxScale: 4 }).value ===
      parseDecimal(String(right), { label: "Immutable usage decimal", allowZero: false, maxScale: 4 }).value;
  } catch (_error) {
    return false;
  }
}

function assertAttemptBinding(row, attempt) {
  const comparisons = [
    [row.project_id, attempt.projectId], [row.order_id, attempt.orderId], [row.run_id, attempt.runId],
    [row.master_image_generation_id, attempt.masterImageGenerationId],
    [row.generation_action_id, attempt.generationActionId], [row.action_id, attempt.actionId],
    [row.operation, attempt.operation], [row.model_registry_version, attempt.modelRegistryVersion],
    [row.endpoint_id, attempt.endpointId], [row.resolution, attempt.resolution],
    [row.output_size, attempt.outputSize]
  ];
  if (comparisons.some(([left, right]) => !sameNullable(left, right)) ||
      !sameNullableDecimal(row.requested_duration_seconds, attempt.requestedDurationSeconds) ||
      Number(row.worker_attempt) !== attempt.workerAttempt ||
      Number(row.requested_output_count) !== attempt.requestedOutputCount) {
    throw new Error("Internal provider request ID is already bound to different immutable usage");
  }
}

async function appendUsageEvent(tx, idFactory, {
  attemptId,
  eventType,
  revision = "v1",
  providerTaskId = null,
  reasonCode = null,
  outputCount = null,
  priceRateId = null,
  quantity = null,
  costDeltaCny = null,
  currency = null
} = {}) {
  const dedupeKey = createUsageDedupeKey({ attemptId, eventType, revision });
  await tx.query(
    `INSERT INTO provider_usage_event
      (id, attempt_id, event_type, dedupe_key, provider_task_id, reason_code,
       output_count, price_rate_id, quantity, cost_delta_cny, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [idFactory(), attemptId, eventType, dedupeKey, providerTaskId, reasonCode,
      outputCount, priceRateId, quantity, costDeltaCny, currency]
  );
  return { dedupeKey };
}

async function recordUsageAttempt(tx, idFactory, input) {
  const attempt = normalizeUsageAttempt(input);
  const card = rows(await tx.query(
    `SELECT id
      FROM provider_price_card
      WHERE provider = 'MODELARK' AND published_at IS NOT NULL AND effective_from <= now()
      ORDER BY effective_from DESC, published_at DESC, id DESC
      LIMIT 1`,
    []
  ))[0] || null;
  let expectedBillableRateCount = 0;
  if (card) {
    const applicable = rows(await tx.query(
      `SELECT count(*)::integer AS applicable_rate_count
         FROM provider_price_rate rate
        WHERE rate.card_id = $1
          AND rate.operation = $2
          AND rate.model_registry_version = $3
          AND rate.endpoint_id = $4
          AND rate.resolution IS NOT DISTINCT FROM $5
          AND rate.output_size IS NOT DISTINCT FROM $6
          AND rate.duration_seconds IS NOT DISTINCT FROM $7`,
      [card.id, attempt.operation, attempt.modelRegistryVersion, attempt.endpointId,
        attempt.resolution, attempt.outputSize, attempt.requestedDurationSeconds]
    ));
    expectedBillableRateCount = Number(applicable[0]?.applicable_rate_count);
    if (!Number.isSafeInteger(expectedBillableRateCount) || expectedBillableRateCount < 0) {
      throw new Error("Applicable provider price rate count is invalid");
    }
  }
  await tx.query(
    `INSERT INTO provider_usage_attempt
      (id, provider, internal_request_id, project_id, order_id, run_id,
       master_image_generation_id, generation_action_id, action_id, operation,
       worker_attempt, model_registry_version, endpoint_id, resolution, output_size,
       requested_duration_seconds, requested_output_count, price_card_id, expected_billable_rate_count)
     VALUES ($1, 'MODELARK', $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (provider, internal_request_id) DO NOTHING`,
    [idFactory(), attempt.internalRequestId, attempt.projectId, attempt.orderId, attempt.runId,
      attempt.masterImageGenerationId, attempt.generationActionId, attempt.actionId, attempt.operation,
      attempt.workerAttempt, attempt.modelRegistryVersion, attempt.endpointId, attempt.resolution,
      attempt.outputSize, attempt.requestedDurationSeconds, attempt.requestedOutputCount, card?.id || null,
      expectedBillableRateCount]
  );
  const recorded = rows(await tx.query(
    `SELECT id, project_id, order_id, run_id, master_image_generation_id,
            generation_action_id, action_id, operation, worker_attempt,
            model_registry_version, endpoint_id, resolution, output_size,
            requested_duration_seconds, requested_output_count, price_card_id, expected_billable_rate_count
       FROM provider_usage_attempt
      WHERE provider = $1 AND internal_request_id = $2`,
    [PROVIDER, attempt.internalRequestId]
  ));
  if (recorded.length !== 1) throw new Error("Provider usage attempt could not be recorded immutably");
  assertAttemptBinding(recorded[0], attempt);
  if (!recorded[0].price_card_id || Number(recorded[0].expected_billable_rate_count) === 0) {
    await appendUsageEvent(tx, idFactory, {
      attemptId: recorded[0].id,
      eventType: "billing_unpriced",
      revision: recorded[0].price_card_id ? "rate-scope-missing" : "price-card-missing",
      reasonCode: recorded[0].price_card_id ? "rate_scope_missing" : "price_card_missing"
    });
  }
  return recorded[0];
}

async function loadUsageAttempt(tx, internalRequestId) {
  const found = rows(await tx.query(
    `SELECT id, project_id, order_id, run_id, master_image_generation_id,
            generation_action_id, action_id, operation, worker_attempt,
            model_registry_version, endpoint_id, resolution, output_size,
            requested_duration_seconds, requested_output_count, price_card_id, expected_billable_rate_count
       FROM provider_usage_attempt
      WHERE provider = $1 AND internal_request_id = $2
      FOR SHARE`,
    [PROVIDER, requiredString(internalRequestId, "Internal provider request ID")]
  ));
  if (found.length !== 1) throw new Error("Provider usage attempt is missing for the persisted request intent");
  return found[0];
}

async function applyFrozenPricing(tx, idFactory, attempt, { trigger, outputCount = null } = {}) {
  if (!attempt.price_card_id) return { applied: 0, unpriced: true };
  const rates = rows(await tx.query(
    `SELECT rate.id, rate.rate_code, rate.billing_unit, rate.unit_quantity,
            rate.unit_price_cny, rate.rounding_mode
       FROM provider_price_rate rate
      WHERE rate.card_id = $1
        AND rate.operation = $2
        AND rate.model_registry_version = $3
        AND rate.endpoint_id = $4
        AND rate.resolution IS NOT DISTINCT FROM $5
        AND rate.output_size IS NOT DISTINCT FROM $6
        AND rate.duration_seconds IS NOT DISTINCT FROM $7
        AND rate.billing_trigger = $8
      ORDER BY rate.rate_code`,
    [attempt.price_card_id, attempt.operation, attempt.model_registry_version, attempt.endpoint_id,
      attempt.resolution, attempt.output_size, attempt.requested_duration_seconds, trigger]
  ));
  if (rates.length === 0) {
    return { applied: 0, unpriced: false };
  }
  let applied = 0;
  let unpriced = false;
  for (const rate of rates) {
    let charge;
    try {
      charge = calculateBillingCharge({
        billingUnit: rate.billing_unit,
        unitQuantity: String(rate.unit_quantity),
        unitPriceCny: String(rate.unit_price_cny),
        roundingMode: rate.rounding_mode,
        requestedDurationSeconds: attempt.requested_duration_seconds === null
          ? null
          : String(attempt.requested_duration_seconds),
        requestedOutputCount: Number(attempt.requested_output_count),
        outputCount
      });
    } catch (_error) {
      unpriced = true;
      await appendUsageEvent(tx, idFactory, {
        attemptId: attempt.id,
        eventType: "billing_unpriced",
        revision: `pricing-error:${trigger}:${rate.id}`,
        reasonCode: "pricing_calculation_failed"
      });
      continue;
    }
    await appendUsageEvent(tx, idFactory, {
      attemptId: attempt.id,
      eventType: "billing_applied",
      revision: rate.id,
      priceRateId: rate.id,
      quantity: charge.quantity,
      costDeltaCny: charge.costCny,
      currency: CURRENCY
    });
    applied += 1;
  }
  return { applied, unpriced };
}

async function recordUsageOutcome(tx, idFactory, {
  internalRequestId,
  eventType,
  providerTaskId = null,
  reasonCode = null,
  outputCount = null
} = {}) {
  const attempt = await loadUsageAttempt(tx, internalRequestId);
  await appendUsageEvent(tx, idFactory, {
    attemptId: attempt.id,
    eventType,
    revision: providerTaskId || reasonCode || "v1",
    providerTaskId,
    reasonCode,
    outputCount
  });
  const billableTriggers = new Set(["provider_accepted", "output_succeeded", "invoice_reconciled"]);
  const pricing = billableTriggers.has(eventType)
    ? await applyFrozenPricing(tx, idFactory, attempt, { trigger: eventType, outputCount })
    : { applied: 0, unpriced: !attempt.price_card_id };
  return { attemptId: attempt.id, ...pricing };
}

module.exports = {
  BILLING_UNITS,
  appendUsageEvent,
  applyFrozenPricing,
  loadUsageAttempt,
  normalizeUsageAttempt,
  recordUsageAttempt,
  recordUsageOutcome
};
