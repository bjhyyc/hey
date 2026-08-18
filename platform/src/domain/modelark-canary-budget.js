const crypto = require("node:crypto");

const { formatDecimalUnits, parseDecimal } = require("./provider-cost-accounting");

const CONTRACT_VERSION = "modelark-canary-budget/v1";
const CURRENCY = "CNY";
const HARD_BUDGET_CNY = "30";
const RESERVED_BUDGET_PERCENT = 20;
const RESERVED_BUDGET_CNY = "6";
const CALLABLE_SPEND_CAP_CNY = "24";
const TOKENS_PER_MILLION = 1_000_000n;

const IMAGE_KINDS = Object.freeze(["front", "side", "sleep"]);
const REPRESENTATIVE_VIDEO_ACTIONS = Object.freeze([
  "idle",
  "sleep-transition",
  "sleep-loop",
  "stretch"
]);
const REMAINING_VIDEO_ACTIONS = Object.freeze([
  "sneeze",
  "roll",
  "hover-attention"
]);
const VIDEO_ACTIONS = Object.freeze([
  ...REPRESENTATIVE_VIDEO_ACTIONS,
  ...REMAINING_VIDEO_ACTIONS
]);

const VIDEO_ENDPOINTS = Object.freeze({
  idle: Object.freeze({ firstMaster: "front", lastMaster: "front" }),
  "sleep-transition": Object.freeze({ firstMaster: "front", lastMaster: "sleep" }),
  "sleep-loop": Object.freeze({ firstMaster: "sleep", lastMaster: "sleep" }),
  stretch: Object.freeze({ firstMaster: "sleep", lastMaster: "front" }),
  sneeze: Object.freeze({ firstMaster: "front", lastMaster: "front" }),
  roll: Object.freeze({ firstMaster: "front", lastMaster: "front" }),
  "hover-attention": Object.freeze({ firstMaster: "front", lastMaster: "front" })
});

const STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({ stageId: "front", callIds: Object.freeze(["front"]) }),
  Object.freeze({ stageId: "side", callIds: Object.freeze(["side"]) }),
  Object.freeze({ stageId: "sleep", callIds: Object.freeze(["sleep"]) }),
  Object.freeze({ stageId: "representative-videos", callIds: REPRESENTATIVE_VIDEO_ACTIONS }),
  Object.freeze({ stageId: "remaining-videos", callIds: REMAINING_VIDEO_ACTIONS })
]);

const FIXED_CALL_ORDER = Object.freeze(STAGE_DEFINITIONS.flatMap((stage) => stage.callIds));
const HARD_BUDGET_UNITS = parseDecimal(HARD_BUDGET_CNY, { label: "Canary hard budget" }).units;
const CALLABLE_SPEND_CAP_UNITS = parseDecimal(CALLABLE_SPEND_CAP_CNY, { label: "Canary callable spend cap" }).units;

class ModelArkCanaryBudgetError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ModelArkCanaryBudgetError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ModelArkCanaryBudgetError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) fail("invalid_shape", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("invalid_shape", `${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function requireCny(value, label) {
  if (value !== CURRENCY) fail("unsupported_currency", `${label} must use CNY`);
  return CURRENCY;
}

function parseCnyUnits(value, label) {
  try {
    return parseDecimal(value, { label, allowZero: true, allowNegative: false, maxScale: 8 }).units;
  } catch (cause) {
    fail("invalid_price", `${label} must be a non-negative exact CNY decimal string`, {
      cause: cause.message
    });
  }
}

function formatUnits(units) {
  return formatDecimalUnits(units);
}

function multiplyFractionCeiling(units, numerator, denominator) {
  const scaled = units * BigInt(numerator);
  const divisor = BigInt(denominator);
  const quotient = scaled / divisor;
  return scaled % divisor === 0n ? quotient : quotient + 1n;
}

function divideCeiling(numerator, denominator) {
  const quotient = numerator / denominator;
  return numerator % denominator === 0n ? quotient : quotient + 1n;
}

function parseTokenCount(value, label, { allowZero = true } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    fail("invalid_token_count", `${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return BigInt(value);
}

function calculatePerMillionTokenCostUnits(tokenCount, unitPriceUnits) {
  return divideCeiling(tokenCount * unitPriceUnits, TOKENS_PER_MILLION);
}

function normalizeImageQuote(kind, quote) {
  assertExactKeys(quote, ["currency", "pricePerImageCny"], `${kind} image price`);
  requireCny(quote.currency, `${kind} image price`);
  const priceUnits = parseCnyUnits(quote.pricePerImageCny, `${kind} image unit price`);
  return {
    callId: kind,
    kind: "image",
    operation: `seedream_${kind}`,
    stageId: kind,
    currency: CURRENCY,
    pricingMode: "per_image",
    unitPriceCny: formatUnits(priceUnits),
    worstCaseCostCny: formatUnits(priceUnits)
  };
}

function normalizeVideoQuote(actionId, quote) {
  if (!isRecord(quote)) fail("invalid_shape", `${actionId} video price must be an object`);
  const allowedKeys = new Set([
    "currency",
    "durationSeconds",
    "pricePerSecondCny",
    "pricePerVideoCny",
    "plannedMaxTokens",
    "unitPriceCnyPerMillionTokens"
  ]);
  const unknownKeys = Object.keys(quote).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    fail("invalid_shape", `${actionId} video price contains unsupported fields: ${unknownKeys.join(", ")}`);
  }
  requireCny(quote.currency, `${actionId} video price`);
  const durationSeconds = Number(quote.durationSeconds);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 15) {
    fail("invalid_duration", `${actionId} duration must be an integer from 4 to 15 seconds`);
  }

  const hasPerSecond = Object.prototype.hasOwnProperty.call(quote, "pricePerSecondCny");
  const hasPerVideo = Object.prototype.hasOwnProperty.call(quote, "pricePerVideoCny");
  const hasTokenPrice = Object.prototype.hasOwnProperty.call(quote, "unitPriceCnyPerMillionTokens");
  const hasPlannedMaxTokens = Object.prototype.hasOwnProperty.call(quote, "plannedMaxTokens");
  const declaredPricingModeCount = Number(hasPerSecond) + Number(hasPerVideo) + Number(hasTokenPrice);
  if (declaredPricingModeCount !== 1) {
    fail(
      "missing_or_ambiguous_price",
      `${actionId} must declare exactly one video price mode: per second, per video, or per million tokens`
    );
  }
  if (hasTokenPrice && !hasPlannedMaxTokens) {
    fail("missing_planned_max_tokens", `${actionId} token pricing requires plannedMaxTokens`);
  }
  if (!hasTokenPrice && hasPlannedMaxTokens) {
    fail("missing_or_ambiguous_price", `${actionId} plannedMaxTokens is valid only with token pricing`);
  }
  const priceField = hasPerSecond
    ? "pricePerSecondCny"
    : hasPerVideo
      ? "pricePerVideoCny"
      : "unitPriceCnyPerMillionTokens";
  const unitPriceUnits = parseCnyUnits(quote[priceField], `${actionId} video unit price`);
  const plannedMaxTokenUnits = hasTokenPrice
    ? parseTokenCount(quote.plannedMaxTokens, `${actionId} plannedMaxTokens`, { allowZero: false })
    : null;
  const costUnits = hasPerSecond
    ? unitPriceUnits * BigInt(durationSeconds)
    : hasPerVideo
      ? unitPriceUnits
      : calculatePerMillionTokenCostUnits(plannedMaxTokenUnits, unitPriceUnits);
  const endpoint = VIDEO_ENDPOINTS[actionId];
  const stageId = REPRESENTATIVE_VIDEO_ACTIONS.includes(actionId)
    ? "representative-videos"
    : "remaining-videos";
  return {
    callId: actionId,
    kind: "video",
    operation: "seedance_video",
    actionId,
    stageId,
    firstMaster: endpoint.firstMaster,
    lastMaster: endpoint.lastMaster,
    durationSeconds,
    currency: CURRENCY,
    pricingMode: hasPerSecond ? "per_second" : hasPerVideo ? "per_video" : "per_million_tokens",
    unitPriceCny: formatUnits(unitPriceUnits),
    unitPriceCnyPerMillionTokens: hasTokenPrice ? formatUnits(unitPriceUnits) : null,
    plannedMaxTokens: hasTokenPrice ? Number(plannedMaxTokenUnits) : null,
    costRounding: hasTokenPrice ? "ceiling_8" : "exact",
    worstCaseCostCny: formatUnits(costUnits)
  };
}

function callFingerprintShape(call) {
  return {
    callId: call.callId,
    kind: call.kind,
    operation: call.operation,
    actionId: call.actionId || null,
    stageId: call.stageId,
    firstMaster: call.firstMaster || null,
    lastMaster: call.lastMaster || null,
    durationSeconds: call.durationSeconds || null,
    currency: call.currency,
    pricingMode: call.pricingMode,
    unitPriceCny: call.unitPriceCny,
    unitPriceCnyPerMillionTokens: call.unitPriceCnyPerMillionTokens || null,
    plannedMaxTokens: call.plannedMaxTokens ?? null,
    costRounding: call.costRounding || null,
    worstCaseCostCny: call.worstCaseCostCny
  };
}

function createPlanId(calls) {
  const material = JSON.stringify({
    contractVersion: CONTRACT_VERSION,
    hardBudgetCny: HARD_BUDGET_CNY,
    callableSpendCapCny: CALLABLE_SPEND_CAP_CNY,
    calls: calls.map(callFingerprintShape)
  });
  return crypto.createHash("sha256").update(material).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createModelArkCanaryBudgetPlan(input) {
  assertExactKeys(input, ["images", "videos"], "ModelArk canary pricing input");
  assertExactKeys(input.images, IMAGE_KINDS, "ModelArk canary image prices");
  assertExactKeys(input.videos, VIDEO_ACTIONS, "ModelArk canary video prices");

  const callsById = new Map();
  for (const kind of IMAGE_KINDS) callsById.set(kind, normalizeImageQuote(kind, input.images[kind]));
  for (const actionId of VIDEO_ACTIONS) callsById.set(actionId, normalizeVideoQuote(actionId, input.videos[actionId]));
  const calls = FIXED_CALL_ORDER.map((callId, index) => ({
    sequence: index + 1,
    ...callsById.get(callId)
  }));
  const costUnitsById = new Map(calls.map((call) => [call.callId, parseCnyUnits(call.worstCaseCostCny, `${call.callId} worst-case cost`)]));
  const baselineUnits = calls.reduce((sum, call) => sum + costUnitsById.get(call.callId), 0n);
  if (baselineUnits > HARD_BUDGET_UNITS) {
    fail("baseline_exceeds_hard_budget", "The ModelArk canary baseline exceeds the CNY 30 hard budget", {
      baselineCostCny: formatUnits(baselineUnits),
      hardBudgetCny: HARD_BUDGET_CNY
    });
  }

  let cumulativeUnits = 0n;
  const stages = STAGE_DEFINITIONS.map((definition, index) => {
    const stageUnits = definition.callIds.reduce((sum, callId) => sum + costUnitsById.get(callId), 0n);
    cumulativeUnits += stageUnits;
    return {
      sequence: index + 1,
      stageId: definition.stageId,
      callIds: [...definition.callIds],
      worstCaseCostCny: formatUnits(stageUnits),
      cumulativeWorstCaseCny: formatUnits(cumulativeUnits),
      remainingWorstCaseCny: formatUnits(baselineUnits - cumulativeUnits)
    };
  });
  const bufferedBaselineUnits = multiplyFractionCeiling(baselineUnits, 120, 100);
  const plan = {
    contractVersion: CONTRACT_VERSION,
    planId: createPlanId(calls),
    currency: CURRENCY,
    budget: {
      hardBudgetCny: HARD_BUDGET_CNY,
      reservedBudgetPercent: RESERVED_BUDGET_PERCENT,
      reservedBudgetCny: RESERVED_BUDGET_CNY,
      callableSpendCapCny: CALLABLE_SPEND_CAP_CNY
    },
    baselineCostCny: formatUnits(baselineUnits),
    baselineWith20PercentContingencyCny: formatUnits(bufferedBaselineUnits),
    baselineWithinCallableSpendCap: baselineUnits <= CALLABLE_SPEND_CAP_UNITS,
    withinCallableSpendCap: bufferedBaselineUnits <= CALLABLE_SPEND_CAP_UNITS,
    withinHardBudgetWith20PercentContingency: bufferedBaselineUnits <= HARD_BUDGET_UNITS,
    callOrder: [...FIXED_CALL_ORDER],
    calls,
    stages
  };
  return deepFreeze(plan);
}

function expectedCostUnits(call) {
  const unitPriceUnits = parseCnyUnits(call.unitPriceCny, `${call.callId} unit price`);
  if (call.kind === "image" && call.pricingMode === "per_image") return unitPriceUnits;
  if (call.kind === "video" && call.pricingMode === "per_video") return unitPriceUnits;
  if (call.kind === "video" && call.pricingMode === "per_second" && Number.isInteger(call.durationSeconds)) {
    return unitPriceUnits * BigInt(call.durationSeconds);
  }
  if (call.kind === "video" && call.pricingMode === "per_million_tokens") {
    if (call.unitPriceCnyPerMillionTokens !== call.unitPriceCny || call.costRounding !== "ceiling_8") {
      fail("invalid_plan", `The canary plan has invalid token pricing metadata for ${call.callId}`);
    }
    const plannedMaxTokens = parseTokenCount(call.plannedMaxTokens, `${call.callId} plannedMaxTokens`, { allowZero: false });
    return calculatePerMillionTokenCostUnits(plannedMaxTokens, unitPriceUnits);
  }
  fail("invalid_plan", `The canary plan has invalid pricing metadata for ${call.callId}`);
}

function assertTrustedPlan(plan) {
  if (!isRecord(plan) || plan.contractVersion !== CONTRACT_VERSION || !Array.isArray(plan.calls)) {
    fail("invalid_plan", "A compatible ModelArk canary budget plan is required");
  }
  if (plan.calls.length !== FIXED_CALL_ORDER.length) fail("invalid_plan", "The canary plan call count changed");
  let baselineUnits = 0n;
  plan.calls.forEach((call, index) => {
    if (!isRecord(call) || call.callId !== FIXED_CALL_ORDER[index] || call.sequence !== index + 1) {
      fail("invalid_plan", "The canary plan fixed call order changed");
    }
    requireCny(call.currency, `${call.callId} plan call`);
    const calculated = expectedCostUnits(call);
    const recorded = parseCnyUnits(call.worstCaseCostCny, `${call.callId} recorded worst-case cost`);
    if (calculated !== recorded) fail("invalid_plan", `The canary plan cost changed for ${call.callId}`);
    baselineUnits += calculated;
  });
  if (formatUnits(baselineUnits) !== plan.baselineCostCny || createPlanId(plan.calls) !== plan.planId) {
    fail("invalid_plan", "The canary plan fingerprint or baseline changed");
  }
  if (baselineUnits > HARD_BUDGET_UNITS) fail("baseline_exceeds_hard_budget", "The canary plan exceeds CNY 30");
  return baselineUnits;
}

function normalizeCompletedCallIds(plan, value) {
  if (!Array.isArray(value)) fail("invalid_state", "completedCallIds must be an array");
  if (new Set(value).size !== value.length) fail("invalid_state", "completedCallIds cannot contain duplicates");
  if (value.length > plan.calls.length) fail("invalid_state", "completedCallIds exceeds the canary plan");
  value.forEach((callId, index) => {
    if (callId !== plan.calls[index].callId) {
      fail("sequence_violation", `Canary calls must complete in fixed order; expected ${plan.calls[index].callId}`);
    }
  });
  return [...value];
}

function normalizeConfirmedSpend(value) {
  if (!isRecord(value)) fail("invalid_state", "confirmedSpend is required before every canary call");
  assertExactKeys(value, ["amountCny", "currency"], "confirmedSpend");
  requireCny(value.currency, "confirmedSpend");
  return parseCnyUnits(value.amountCny, "Confirmed provider spend");
}

function normalizeActualTokenUsage(plan, completedCallCount, value) {
  if (!isRecord(value)) fail("invalid_state", "actualTokensByCallId must be an object");
  const completedCallsById = new Map(
    plan.calls.slice(0, completedCallCount).map((call) => [call.callId, call])
  );
  const usage = new Map();
  let hasPlanOverrun = false;
  for (const [callId, actualTokensValue] of Object.entries(value)) {
    const call = completedCallsById.get(callId);
    if (!call) {
      fail("invalid_state", `actualTokensByCallId may reference only completed calls; ${callId} is not completed`);
    }
    if (call.kind !== "video" || call.pricingMode !== "per_million_tokens") {
      fail("invalid_state", `actualTokensByCallId may reference only token-priced videos; ${callId} is not token-priced`);
    }
    const actualTokens = parseTokenCount(actualTokensValue, `${callId} actualTokens`);
    const plannedMaxTokens = BigInt(call.plannedMaxTokens);
    const actualCostUnits = calculatePerMillionTokenCostUnits(
      actualTokens,
      parseCnyUnits(call.unitPriceCnyPerMillionTokens, `${callId} token unit price`)
    );
    const exceededPlan = actualTokens > plannedMaxTokens;
    if (exceededPlan) hasPlanOverrun = true;
    usage.set(callId, {
      callId,
      actualTokens: Number(actualTokens),
      plannedMaxTokens: call.plannedMaxTokens,
      actualCostUnits,
      actualCostCny: formatUnits(actualCostUnits),
      exceededPlan
    });
  }
  return { usage, hasPlanOverrun };
}

function createDecision({
  allowed,
  code,
  plan,
  nextCall,
  confirmedUnits,
  accountedCompletedUnits,
  conservativeConfirmedUnits,
  remainingAfterNextUnits,
  projectedUnits,
  projectedWithContingencyUnits,
  actualTokenUsage
}) {
  return deepFreeze({
    allowed,
    code,
    planId: plan.planId,
    nextCall: nextCall || null,
    confirmedSpendCny: formatUnits(confirmedUnits),
    accountedCompletedSpendCny: formatUnits(accountedCompletedUnits),
    conservativeConfirmedSpendCny: formatUnits(conservativeConfirmedUnits),
    actualTokenUsage: actualTokenUsage.map(({ actualCostUnits, ...entry }) => entry),
    remainingAfterNextWorstCaseCny: formatUnits(remainingAfterNextUnits),
    projectedCompletedWorkflowCostCny: formatUnits(projectedUnits),
    projectedCompletedWorkflowWith20PercentContingencyCny: formatUnits(projectedWithContingencyUnits),
    callableSpendCapCny: CALLABLE_SPEND_CAP_CNY,
    hardBudgetCny: HARD_BUDGET_CNY,
    projectedRawHeadroomCny: formatUnits(CALLABLE_SPEND_CAP_UNITS - projectedUnits),
    projectedHeadroomCny: formatUnits(CALLABLE_SPEND_CAP_UNITS - projectedWithContingencyUnits)
  });
}

function evaluateNextModelArkCanaryCall({
  plan,
  completedCallIds = [],
  confirmedSpend,
  actualTokensByCallId = {},
  unpricedAttemptCount = 0,
  requestedCallId = null
} = {}) {
  assertTrustedPlan(plan);
  const completed = normalizeCompletedCallIds(plan, completedCallIds);
  const confirmedUnits = normalizeConfirmedSpend(confirmedSpend);
  if (!Number.isSafeInteger(unpricedAttemptCount) || unpricedAttemptCount < 0) {
    fail("invalid_state", "unpricedAttemptCount must be a non-negative safe integer");
  }

  const actualTokens = normalizeActualTokenUsage(plan, completed.length, actualTokensByCallId);
  const accountedCompletedUnits = plan.calls.slice(0, completed.length).reduce((sum, call) => {
    const actualTokenEntry = actualTokens.usage.get(call.callId);
    return sum + (actualTokenEntry
      ? actualTokenEntry.actualCostUnits
      : parseCnyUnits(call.worstCaseCostCny, `${call.callId} worst-case cost`));
  }, 0n);
  const conservativeConfirmedUnits = confirmedUnits > accountedCompletedUnits
    ? confirmedUnits
    : accountedCompletedUnits;
  const actualTokenUsage = [...actualTokens.usage.values()];
  const nextCall = plan.calls[completed.length] || null;
  if (requestedCallId !== null && (!nextCall || requestedCallId !== nextCall.callId)) {
    fail("sequence_violation", `The next canary call must be ${nextCall ? nextCall.callId : "none"}`);
  }
  if (!nextCall) {
    return createDecision({
      allowed: false,
      code: "complete",
      plan,
      nextCall: null,
      confirmedUnits,
      accountedCompletedUnits,
      conservativeConfirmedUnits,
      remainingAfterNextUnits: 0n,
      projectedUnits: conservativeConfirmedUnits,
      projectedWithContingencyUnits: conservativeConfirmedUnits,
      actualTokenUsage
    });
  }

  const remainingCalls = plan.calls.slice(completed.length);
  const remainingUnits = remainingCalls.reduce(
    (sum, call) => sum + parseCnyUnits(call.worstCaseCostCny, `${call.callId} worst-case cost`),
    0n
  );
  const nextCallUnits = parseCnyUnits(nextCall.worstCaseCostCny, `${nextCall.callId} worst-case cost`);
  const remainingAfterNextUnits = remainingUnits - nextCallUnits;
  const projectedUnits = conservativeConfirmedUnits + remainingUnits;
  const projectedWithContingencyUnits = conservativeConfirmedUnits + multiplyFractionCeiling(remainingUnits, 120, 100);
  let allowed = true;
  let code = "allowed";
  if (unpricedAttemptCount > 0) {
    allowed = false;
    code = "unpriced_usage_present";
  } else if (actualTokens.hasPlanOverrun) {
    allowed = false;
    code = "actual_tokens_exceed_plan";
  } else if (confirmedUnits > HARD_BUDGET_UNITS) {
    allowed = false;
    code = "hard_budget_exceeded";
  } else if (projectedWithContingencyUnits > CALLABLE_SPEND_CAP_UNITS) {
    allowed = false;
    code = "projected_spend_cap_exceeded";
  }
  return createDecision({
    allowed,
    code,
    plan,
    nextCall,
    confirmedUnits,
    accountedCompletedUnits,
    conservativeConfirmedUnits,
    remainingAfterNextUnits,
    projectedUnits,
    projectedWithContingencyUnits,
    actualTokenUsage
  });
}

function assertNextModelArkCanaryCallAllowed(input = {}) {
  if (typeof input.requestedCallId !== "string" || !input.requestedCallId) {
    fail("invalid_state", "requestedCallId is required when authorizing a provider call");
  }
  const decision = evaluateNextModelArkCanaryCall(input);
  if (!decision.allowed) {
    fail(decision.code, `ModelArk canary call ${input.requestedCallId} was denied`, decision);
  }
  return decision;
}

module.exports = {
  CALLABLE_SPEND_CAP_CNY,
  CONTRACT_VERSION,
  CURRENCY,
  FIXED_CALL_ORDER,
  HARD_BUDGET_CNY,
  IMAGE_KINDS,
  ModelArkCanaryBudgetError,
  REMAINING_VIDEO_ACTIONS,
  REPRESENTATIVE_VIDEO_ACTIONS,
  RESERVED_BUDGET_CNY,
  RESERVED_BUDGET_PERCENT,
  STAGE_DEFINITIONS,
  VIDEO_ACTIONS,
  VIDEO_ENDPOINTS,
  assertNextModelArkCanaryCallAllowed,
  createModelArkCanaryBudgetPlan,
  evaluateNextModelArkCanaryCall
};
