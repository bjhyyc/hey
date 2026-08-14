const crypto = require("node:crypto");

const PROVIDER = "MODELARK";
const CURRENCY = "CNY";
const DECIMAL_SCALE = 8;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

const PROVIDER_OPERATIONS = Object.freeze({
  SEEDREAM_FRONT: "seedream_front",
  SEEDREAM_SIDE: "seedream_side",
  SEEDREAM_SLEEP: "seedream_sleep",
  SEEDANCE_VIDEO: "seedance_video"
});

const BILLING_TRIGGERS = Object.freeze({
  PROVIDER_ACCEPTED: "provider_accepted",
  OUTPUT_SUCCEEDED: "output_succeeded",
  INVOICE_RECONCILED: "invoice_reconciled"
});

const BILLING_UNITS = Object.freeze({
  REQUEST: "request",
  OUTPUT: "output",
  REQUESTED_SECOND: "requested_second"
});

const ROUNDING_MODES = Object.freeze({
  EXACT: "exact",
  HALF_UP_8: "half_up_8",
  CEILING_8: "ceiling_8"
});

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function nullableString(value, label, maxLength = 256) {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, label, maxLength);
}

function parseDecimal(value, { label, allowZero = true, allowNegative = false, maxScale = 8 } = {}) {
  if (!Number.isSafeInteger(maxScale) || maxScale < 0 || maxScale > DECIMAL_SCALE) {
    throw new Error("Decimal scale contract is invalid");
  }
  const text = value;
  const fractionLength = typeof text === "string" && text.includes(".") ? text.split(".")[1].length : 0;
  if (typeof text !== "string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text) || fractionLength > maxScale) {
    throw new Error(`${label} must be an exact decimal string with at most ${maxScale} fractional digits`);
  }
  if (!allowNegative && text.startsWith("-")) throw new Error(`${label} cannot be negative`);
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  let units = BigInt(whole) * DECIMAL_FACTOR + BigInt((fraction + "0".repeat(DECIMAL_SCALE)).slice(0, DECIMAL_SCALE));
  if (negative) units = -units;
  if (!allowZero && units === 0n) throw new Error(`${label} must be positive`);
  return { units, value: formatDecimalUnits(units) };
}

function formatDecimalUnits(units) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / DECIMAL_FACTOR;
  const fractional = String(absolute % DECIMAL_FACTOR).padStart(DECIMAL_SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fractional ? `.${fractional}` : ""}`;
}

function normalizePriceRate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider price rate is required");
  const operation = requiredString(value.operation, "Provider operation", 64);
  const billingTrigger = requiredString(value.billingTrigger, "Billing trigger", 64);
  const billingUnit = requiredString(value.billingUnit, "Billing unit", 64);
  const roundingMode = requiredString(value.roundingMode, "Billing rounding mode", 32);
  if (!Object.values(PROVIDER_OPERATIONS).includes(operation)) throw new Error("Provider operation is invalid");
  if (!Object.values(BILLING_TRIGGERS).includes(billingTrigger)) throw new Error("Billing trigger is invalid");
  if (!Object.values(BILLING_UNITS).includes(billingUnit)) throw new Error("Billing unit is invalid");
  if (!Object.values(ROUNDING_MODES).includes(roundingMode)) throw new Error("Billing rounding mode is invalid");
  const durationSeconds = value.durationSeconds === null || value.durationSeconds === undefined
    ? null
    : parseDecimal(value.durationSeconds, { label: "Rate duration", allowZero: false, maxScale: 4 }).value;
  const normalized = {
    rateCode: requiredString(value.rateCode, "Price rate code", 128),
    operation,
    modelRegistryVersion: requiredString(value.modelRegistryVersion, "Model registry version", 128),
    endpointId: requiredString(value.endpointId, "Provider endpoint ID", 256),
    resolution: nullableString(value.resolution, "Rate resolution", 128),
    outputSize: nullableString(value.outputSize, "Rate output size", 128),
    durationSeconds,
    billingTrigger,
    billingUnit,
    unitQuantity: parseDecimal(value.unitQuantity, { label: "Billing unit quantity", allowZero: false }).value,
    unitPriceCny: parseDecimal(value.unitPriceCny, { label: "Billing unit price" }).value,
    roundingMode
  };
  if (operation === PROVIDER_OPERATIONS.SEEDANCE_VIDEO && durationSeconds === null) {
    throw new Error("Seedance video price rates require durationSeconds");
  }
  if (operation !== PROVIDER_OPERATIONS.SEEDANCE_VIDEO && durationSeconds !== null) {
    throw new Error("Seedream image price rates cannot declare durationSeconds");
  }
  if (billingUnit === BILLING_UNITS.REQUESTED_SECOND && operation !== PROVIDER_OPERATIONS.SEEDANCE_VIDEO) {
    throw new Error("Requested-second billing is supported only for Seedance video");
  }
  calculateBillingCharge({
    billingUnit,
    unitQuantity: normalized.unitQuantity,
    unitPriceCny: normalized.unitPriceCny,
    roundingMode,
    requestedDurationSeconds: durationSeconds,
    requestedOutputCount: 1,
    outputCount: 1
  });
  return normalized;
}

function normalizePriceCard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider price card is required");
  if (value.provider !== PROVIDER) throw new Error("Provider price card must target MODELARK");
  if (value.currency !== CURRENCY) throw new Error("Provider price card must use CNY");
  const effective = new Date(value.effectiveFrom);
  if (!Number.isFinite(effective.getTime())) throw new Error("Provider price effective timestamp is invalid");
  if (!Array.isArray(value.rates) || value.rates.length < 1 || value.rates.length > 100) {
    throw new Error("Provider price card must contain one to one hundred explicit rates");
  }
  const rates = value.rates.map(normalizePriceRate);
  const codes = new Set(rates.map((rate) => rate.rateCode));
  if (codes.size !== rates.length) throw new Error("Provider price rate codes must be unique");
  return {
    provider: PROVIDER,
    currency: CURRENCY,
    version: requiredString(value.version, "Provider price card version", 128),
    sourceContractReference: requiredString(value.sourceContractReference, "Provider account contract reference", 512),
    effectiveFrom: effective.toISOString(),
    rates
  };
}

function calculateBillingCharge({ billingUnit, unitQuantity, unitPriceCny, roundingMode, requestedDurationSeconds, requestedOutputCount = 1, outputCount } = {}) {
  let quantity;
  if (billingUnit === BILLING_UNITS.REQUEST) quantity = "1";
  else if (billingUnit === BILLING_UNITS.OUTPUT) quantity = String(outputCount || requestedOutputCount || "");
  else if (billingUnit === BILLING_UNITS.REQUESTED_SECOND) quantity = requestedDurationSeconds;
  else throw new Error("Billing unit is invalid");
  const quantityDecimal = parseDecimal(quantity, { label: "Billable quantity", allowZero: false });
  const unitQuantityDecimal = parseDecimal(unitQuantity, { label: "Billing unit quantity", allowZero: false });
  const priceDecimal = parseDecimal(unitPriceCny, { label: "Billing unit price" });
  const numerator = quantityDecimal.units * priceDecimal.units;
  const denominator = unitQuantityDecimal.units;
  let costUnits = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder !== 0n) {
    if (roundingMode === ROUNDING_MODES.EXACT) throw new Error("Billing result is not exact at eight decimal places");
    if (roundingMode === ROUNDING_MODES.CEILING_8) costUnits += 1n;
    else if (roundingMode === ROUNDING_MODES.HALF_UP_8 && remainder * 2n >= denominator) costUnits += 1n;
    else if (roundingMode !== ROUNDING_MODES.HALF_UP_8) throw new Error("Billing rounding mode is invalid");
  } else if (!Object.values(ROUNDING_MODES).includes(roundingMode)) {
    throw new Error("Billing rounding mode is invalid");
  }
  return { quantity: quantityDecimal.value, costCny: formatDecimalUnits(costUnits) };
}

function createUsageDedupeKey({ attemptId, eventType, revision = "v1" } = {}) {
  const input = [
    requiredString(attemptId, "Usage attempt ID", 128),
    requiredString(eventType, "Usage event type", 64),
    requiredString(revision, "Usage event revision", 512)
  ].join("|");
  return crypto.createHash("sha256").update(input).digest("hex");
}

module.exports = {
  BILLING_TRIGGERS,
  BILLING_UNITS,
  CURRENCY,
  PROVIDER,
  PROVIDER_OPERATIONS,
  ROUNDING_MODES,
  calculateBillingCharge,
  createUsageDedupeKey,
  formatDecimalUnits,
  normalizePriceCard,
  normalizePriceRate,
  parseDecimal
};
