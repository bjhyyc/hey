const { requireAdmin } = require("../auth/authorization");
const { RETENTION_PLAN_MODE, normalizeRetentionPolicy } = require("../retention/retention-policy-contract");

function requirePlanner(planner) {
  if (!planner || typeof planner.plan !== "function") throw new Error("An administrator cleanup planner is required");
  return planner;
}

class AdminRetentionService {
  constructor({ planner, policy, logger = console } = {}) {
    this.planner = requirePlanner(planner);
    this.policy = normalizeRetentionPolicy(policy);
    this.logger = logger;
  }

  async planCleanup({ actor, mode, cursor, limit } = {}) {
    requireAdmin(actor);
    if (mode !== RETENTION_PLAN_MODE) throw new Error("Cleanup planning accepts only mode=dry-run");
    const result = await this.planner.plan({
      actor,
      mode: RETENTION_PLAN_MODE,
      policy: this.policy,
      cursor,
      limit
    });
    this.logger.info?.("petpack.admin.cleanup_plan_viewed", {
      policyVersion: result.policyVersion,
      inspected: result.summary.inspected,
      candidates: result.summary.candidates,
      blocked: result.summary.blocked
    });
    return result;
  }
}

module.exports = { AdminRetentionService };
