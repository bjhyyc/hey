const { requireAdmin } = require("../auth/authorization");
const { normalizePriceCard } = require("../domain/provider-cost-accounting");
const { normalizeCostSummaryQuery } = require("../persistence/postgres-production-controls-repository");

function requireRepository(repository) {
  const methods = ["publishPriceCard", "summarizeProviderUsage"];
  const missing = methods.filter((method) => !repository || typeof repository[method] !== "function");
  if (missing.length > 0) throw new Error(`An administrator cost repository is required: ${missing.join(", ")}`);
  return repository;
}

function safeDecimal(value) {
  const text = String(value ?? "0");
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) throw new Error("Cost summary contains an invalid decimal");
  return text;
}

function nonNegativeInteger(value) {
  const numeric = Number(value || 0);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error("Cost summary contains an invalid count");
  return numeric;
}

function mapCostMetrics(value) {
  return {
    attempted: nonNegativeInteger(value?.attempted),
    accepted: nonNegativeInteger(value?.accepted),
    succeeded: nonNegativeInteger(value?.succeeded),
    rejected: nonNegativeInteger(value?.rejected),
    failed: nonNegativeInteger(value?.failed),
    unknown: nonNegativeInteger(value?.unknown),
    unpriced: nonNegativeInteger(value?.unpriced),
    unresolved: nonNegativeInteger(value?.unresolved),
    confirmedCostCny: safeDecimal(value?.confirmedCostCny),
    adjustmentCostCny: safeDecimal(value?.adjustmentCostCny),
    totalCostCny: safeDecimal(value?.totalCostCny)
  };
}

function mapCostSummary(value) {
  return {
    range: {
      from: value.range.from,
      to: value.range.to,
      operation: value.range.operation || null,
      actionId: value.range.actionId || null,
      bucket: "day"
    },
    currency: "CNY",
    total: mapCostMetrics(value.total),
    groups: Array.isArray(value.groups) ? value.groups.map((group) => ({
      bucketStart: group.bucketStart,
      operation: group.operation,
      actionId: group.actionId || null,
      ...mapCostMetrics(group)
    })) : []
  };
}

class AdminCostService {
  constructor({ repository, logger = console } = {}) {
    this.repository = requireRepository(repository);
    this.logger = logger;
  }

  async publishPriceCard({ actor, priceCard } = {}) {
    const admin = requireAdmin(actor);
    const normalized = normalizePriceCard(priceCard);
    return this.repository.publishPriceCard({ actorId: admin.id, priceCard: normalized });
  }

  async getCostSummary({ actor, ...input } = {}) {
    requireAdmin(actor);
    const query = normalizeCostSummaryQuery(input);
    const summary = mapCostSummary(await this.repository.summarizeProviderUsage(query));
    this.logger.info?.("petpack.admin.provider_cost_summary_viewed", {
      from: summary.range.from,
      to: summary.range.to,
      operation: summary.range.operation || "all",
      actionScoped: Boolean(summary.range.actionId),
      attempted: summary.total.attempted,
      unpriced: summary.total.unpriced,
      unresolved: summary.total.unresolved
    });
    return summary;
  }
}

module.exports = {
  AdminCostService,
  mapCostMetrics,
  mapCostSummary
};
