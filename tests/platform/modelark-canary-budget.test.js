import { describe, expect, it } from "vitest";

import canaryBudget from "../../platform/src/domain/modelark-canary-budget.js";

const {
  CALLABLE_SPEND_CAP_CNY,
  FIXED_CALL_ORDER,
  ModelArkCanaryBudgetError,
  assertNextModelArkCanaryCallAllowed,
  createModelArkCanaryBudgetPlan,
  evaluateNextModelArkCanaryCall
} = canaryBudget;

function validPricing() {
  return {
    images: {
      front: { currency: "CNY", pricePerImageCny: "0.5" },
      side: { currency: "CNY", pricePerImageCny: "0.6" },
      sleep: { currency: "CNY", pricePerImageCny: "0.7" }
    },
    videos: {
      idle: { currency: "CNY", durationSeconds: 4, pricePerSecondCny: "0.1" },
      "sleep-transition": { currency: "CNY", durationSeconds: 6, pricePerVideoCny: "0.9" },
      "sleep-loop": { currency: "CNY", durationSeconds: 6, pricePerSecondCny: "0.1" },
      stretch: { currency: "CNY", durationSeconds: 7, pricePerVideoCny: "1.2" },
      sneeze: { currency: "CNY", durationSeconds: 4, pricePerSecondCny: "0.1" },
      roll: { currency: "CNY", durationSeconds: 6, pricePerSecondCny: "0.1" },
      "hover-attention": { currency: "CNY", durationSeconds: 7, pricePerVideoCny: "1.1" }
    }
  };
}

function realisticPerSecondPricing() {
  const input = validPricing();
  for (const image of Object.values(input.images)) image.pricePerImageCny = "0.5";
  for (const video of Object.values(input.videos)) {
    delete video.pricePerVideoCny;
    video.pricePerSecondCny = "0.45";
  }
  return input;
}

function useTokenPricing(input, actionId, { plannedMaxTokens = 40_000, unitPriceCnyPerMillionTokens = "46" } = {}) {
  delete input.videos[actionId].pricePerSecondCny;
  delete input.videos[actionId].pricePerVideoCny;
  input.videos[actionId].plannedMaxTokens = plannedMaxTokens;
  input.videos[actionId].unitPriceCnyPerMillionTokens = unitPriceCnyPerMillionTokens;
  return input;
}

function expectBudgetError(action, code) {
  let error = null;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ModelArkCanaryBudgetError);
  expect(error).toMatchObject({ code });
}

describe("ModelArk canary cost plan", () => {
  it("uses exact arithmetic and exposes baseline, 20% contingency, and stage worst cases", () => {
    const plan = createModelArkCanaryBudgetPlan(validPricing());

    expect(plan.currency).toBe("CNY");
    expect(plan.baselineCostCny).toBe("7");
    expect(plan.baselineWith20PercentContingencyCny).toBe("8.4");
    expect(plan.budget).toEqual({
      hardBudgetCny: "30",
      reservedBudgetPercent: 20,
      reservedBudgetCny: "6",
      callableSpendCapCny: "24"
    });
    expect(plan.withinCallableSpendCap).toBe(true);
    expect(plan.withinHardBudgetWith20PercentContingency).toBe(true);
    expect(plan.stages).toEqual([
      {
        sequence: 1,
        stageId: "front",
        callIds: ["front"],
        worstCaseCostCny: "0.5",
        cumulativeWorstCaseCny: "0.5",
        remainingWorstCaseCny: "6.5"
      },
      {
        sequence: 2,
        stageId: "side",
        callIds: ["side"],
        worstCaseCostCny: "0.6",
        cumulativeWorstCaseCny: "1.1",
        remainingWorstCaseCny: "5.9"
      },
      {
        sequence: 3,
        stageId: "sleep",
        callIds: ["sleep"],
        worstCaseCostCny: "0.7",
        cumulativeWorstCaseCny: "1.8",
        remainingWorstCaseCny: "5.2"
      },
      {
        sequence: 4,
        stageId: "representative-videos",
        callIds: ["idle", "sleep-transition", "sleep-loop", "stretch"],
        worstCaseCostCny: "3.1",
        cumulativeWorstCaseCny: "4.9",
        remainingWorstCaseCny: "2.1"
      },
      {
        sequence: 5,
        stageId: "remaining-videos",
        callIds: ["sneeze", "roll", "hover-attention"],
        worstCaseCostCny: "2.1",
        cumulativeWorstCaseCny: "7",
        remainingWorstCaseCny: "0"
      }
    ]);
  });

  it("accepts the conservative real-run quote of CNY 0.50 per image and CNY 0.45 per video second", () => {
    const plan = createModelArkCanaryBudgetPlan(realisticPerSecondPricing());

    const firstCallGate = evaluateNextModelArkCanaryCall({
      plan,
      confirmedSpend: { currency: "CNY", amountCny: "0" },
      requestedCallId: "front"
    });

    expect(plan.baselineCostCny).toBe("19.5");
    expect(plan.baselineWith20PercentContingencyCny).toBe("23.4");
    expect(plan.withinCallableSpendCap).toBe(true);
    expect(plan.withinHardBudgetWith20PercentContingency).toBe(true);
    expect(firstCallGate).toMatchObject({
      allowed: true,
      code: "allowed",
      projectedCompletedWorkflowCostCny: "19.5",
      projectedCompletedWorkflowWith20PercentContingencyCny: "23.4",
      projectedHeadroomCny: "0.6"
    });
    expect(plan.stages.map(({ stageId, worstCaseCostCny, cumulativeWorstCaseCny }) => ({
      stageId,
      worstCaseCostCny,
      cumulativeWorstCaseCny
    }))).toEqual([
      { stageId: "front", worstCaseCostCny: "0.5", cumulativeWorstCaseCny: "0.5" },
      { stageId: "side", worstCaseCostCny: "0.5", cumulativeWorstCaseCny: "1" },
      { stageId: "sleep", worstCaseCostCny: "0.5", cumulativeWorstCaseCny: "1.5" },
      { stageId: "representative-videos", worstCaseCostCny: "10.35", cumulativeWorstCaseCny: "11.85" },
      { stageId: "remaining-videos", worstCaseCostCny: "7.65", cumulativeWorstCaseCny: "19.5" }
    ]);
  });

  it("supports per-million-token video pricing with a required planned token ceiling", () => {
    const plan = createModelArkCanaryBudgetPlan(useTokenPricing(validPricing(), "idle"));
    const idle = plan.calls.find((call) => call.callId === "idle");

    expect(idle).toMatchObject({
      pricingMode: "per_million_tokens",
      unitPriceCnyPerMillionTokens: "46",
      plannedMaxTokens: 40_000,
      costRounding: "ceiling_8",
      worstCaseCostCny: "1.84"
    });
    expect(plan.baselineCostCny).toBe("8.44");

    const roundedPlan = createModelArkCanaryBudgetPlan(useTokenPricing(validPricing(), "idle", {
      plannedMaxTokens: 1,
      unitPriceCnyPerMillionTokens: "46.12345678"
    }));
    expect(roundedPlan.calls.find((call) => call.callId === "idle").worstCaseCostCny).toBe("0.00004613");
  });

  it("fixes the image-first and representative endpoint coverage order", () => {
    const plan = createModelArkCanaryBudgetPlan(validPricing());

    expect(plan.callOrder).toEqual([
      "front",
      "side",
      "sleep",
      "idle",
      "sleep-transition",
      "sleep-loop",
      "stretch",
      "sneeze",
      "roll",
      "hover-attention"
    ]);
    expect(plan.callOrder).toEqual(FIXED_CALL_ORDER);
    expect(plan.calls.slice(3, 7).map(({ callId, firstMaster, lastMaster }) => ({
      callId,
      firstMaster,
      lastMaster
    }))).toEqual([
      { callId: "idle", firstMaster: "front", lastMaster: "front" },
      { callId: "sleep-transition", firstMaster: "front", lastMaster: "sleep" },
      { callId: "sleep-loop", firstMaster: "sleep", lastMaster: "sleep" },
      { callId: "stretch", firstMaster: "sleep", lastMaster: "front" }
    ]);
  });

  it("fails closed for missing prices and unexpected fields", () => {
    const missingImage = validPricing();
    delete missingImage.images.side;
    expectBudgetError(() => createModelArkCanaryBudgetPlan(missingImage), "invalid_shape");

    const missingAction = validPricing();
    delete missingAction.videos.roll;
    expectBudgetError(() => createModelArkCanaryBudgetPlan(missingAction), "invalid_shape");

    const missingVideoPrice = validPricing();
    delete missingVideoPrice.videos.idle.pricePerSecondCny;
    expectBudgetError(() => createModelArkCanaryBudgetPlan(missingVideoPrice), "missing_or_ambiguous_price");

    const ambiguousVideoPrice = validPricing();
    ambiguousVideoPrice.videos.idle.pricePerVideoCny = "1";
    expectBudgetError(() => createModelArkCanaryBudgetPlan(ambiguousVideoPrice), "missing_or_ambiguous_price");

    const missingPlannedTokens = validPricing();
    delete missingPlannedTokens.videos.idle.pricePerSecondCny;
    missingPlannedTokens.videos.idle.unitPriceCnyPerMillionTokens = "46";
    expectBudgetError(() => createModelArkCanaryBudgetPlan(missingPlannedTokens), "missing_planned_max_tokens");

    const tokenPriceMixedWithContractPrice = useTokenPricing(validPricing(), "idle");
    tokenPriceMixedWithContractPrice.videos.idle.pricePerVideoCny = "1";
    expectBudgetError(() => createModelArkCanaryBudgetPlan(tokenPriceMixedWithContractPrice), "missing_or_ambiguous_price");

    const unexpectedField = validPricing();
    unexpectedField.videos.idle.estimated = true;
    expectBudgetError(() => createModelArkCanaryBudgetPlan(unexpectedField), "invalid_shape");
  });

  it("fails closed for non-CNY, negative, malformed, or invalid-duration quotes", () => {
    const nonCny = validPricing();
    nonCny.images.front.currency = "USD";
    expectBudgetError(() => createModelArkCanaryBudgetPlan(nonCny), "unsupported_currency");

    const negativeImage = validPricing();
    negativeImage.images.front.pricePerImageCny = "-0.01";
    expectBudgetError(() => createModelArkCanaryBudgetPlan(negativeImage), "invalid_price");

    const negativeVideo = validPricing();
    negativeVideo.videos.idle.pricePerSecondCny = "-0.01";
    expectBudgetError(() => createModelArkCanaryBudgetPlan(negativeVideo), "invalid_price");

    const numericInsteadOfExactDecimal = validPricing();
    numericInsteadOfExactDecimal.images.front.pricePerImageCny = 0.5;
    expectBudgetError(() => createModelArkCanaryBudgetPlan(numericInsteadOfExactDecimal), "invalid_price");

    const invalidDuration = validPricing();
    invalidDuration.videos.idle.durationSeconds = 4.5;
    expectBudgetError(() => createModelArkCanaryBudgetPlan(invalidDuration), "invalid_duration");

    const invalidPlannedTokens = useTokenPricing(validPricing(), "idle", { plannedMaxTokens: -1 });
    expectBudgetError(() => createModelArkCanaryBudgetPlan(invalidPlannedTokens), "invalid_token_count");

    const zeroPlannedTokens = useTokenPricing(validPricing(), "idle", { plannedMaxTokens: 0 });
    expectBudgetError(() => createModelArkCanaryBudgetPlan(zeroPlannedTokens), "invalid_token_count");
  });

  it("rejects a baseline above the CNY 30 hard budget", () => {
    const pricing = validPricing();
    pricing.images.front.pricePerImageCny = "24";

    expectBudgetError(() => createModelArkCanaryBudgetPlan(pricing), "baseline_exceeds_hard_budget");
  });
});

describe("ModelArk canary pre-call stage gate", () => {
  it("authorizes only the next fixed call and projects that call plus the complete remainder", () => {
    const plan = createModelArkCanaryBudgetPlan(validPricing());
    const first = evaluateNextModelArkCanaryCall({
      plan,
      confirmedSpend: { currency: "CNY", amountCny: "0" }
    });

    expect(first).toMatchObject({
      allowed: true,
      code: "allowed",
      nextCall: { callId: "front" },
      projectedCompletedWorkflowCostCny: "7",
      projectedCompletedWorkflowWith20PercentContingencyCny: "8.4",
      remainingAfterNextWorstCaseCny: "6.5",
      projectedHeadroomCny: "15.6"
    });

    const second = assertNextModelArkCanaryCallAllowed({
      plan,
      completedCallIds: ["front"],
      confirmedSpend: { currency: "CNY", amountCny: "0.5" },
      requestedCallId: "side"
    });
    expect(second).toMatchObject({
      allowed: true,
      nextCall: { callId: "side" },
      conservativeConfirmedSpendCny: "0.5",
      projectedCompletedWorkflowCostCny: "7",
      remainingAfterNextWorstCaseCny: "5.9"
    });
  });

  it("allows an exact CNY 24 projection after the 20% contingency", () => {
    const pricing = validPricing();
    pricing.images.front.pricePerImageCny = "13.5";
    const plan = createModelArkCanaryBudgetPlan(pricing);

    expect(plan.baselineCostCny).toBe("20");
    expect(plan.baselineWith20PercentContingencyCny).toBe(CALLABLE_SPEND_CAP_CNY);
    expect(plan.withinCallableSpendCap).toBe(true);
    expect(evaluateNextModelArkCanaryCall({
      plan,
      confirmedSpend: { currency: "CNY", amountCny: "0" }
    })).toMatchObject({
      allowed: true,
      projectedCompletedWorkflowCostCny: "20",
      projectedCompletedWorkflowWith20PercentContingencyCny: "24",
      projectedHeadroomCny: "0"
    });
  });

  it("denies before the first call when the contingent complete-flow projection exceeds CNY 24", () => {
    const pricing = validPricing();
    pricing.images.front.pricePerImageCny = "13.51";
    const plan = createModelArkCanaryBudgetPlan(pricing);
    const decision = evaluateNextModelArkCanaryCall({
      plan,
      confirmedSpend: { currency: "CNY", amountCny: "0" }
    });

    expect(plan.baselineCostCny).toBe("20.01");
    expect(plan.baselineWith20PercentContingencyCny).toBe("24.012");
    expect(plan.baselineWithinCallableSpendCap).toBe(true);
    expect(plan.withinCallableSpendCap).toBe(false);
    expect(decision).toMatchObject({
      allowed: false,
      code: "projected_spend_cap_exceeded",
      projectedCompletedWorkflowCostCny: "20.01",
      projectedCompletedWorkflowWith20PercentContingencyCny: "24.012",
      projectedHeadroomCny: "-0.012"
    });
    expectBudgetError(() => assertNextModelArkCanaryCallAllowed({
      plan,
      confirmedSpend: { currency: "CNY", amountCny: "0" },
      requestedCallId: "front"
    }), "projected_spend_cap_exceeded");
  });

  it("denies when confirmed spend drift makes the complete-flow projection exceed CNY 24", () => {
    const plan = createModelArkCanaryBudgetPlan(validPricing());
    const decision = evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds: ["front"],
      confirmedSpend: { currency: "CNY", amountCny: "18" }
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "projected_spend_cap_exceeded",
      nextCall: { callId: "side" },
      conservativeConfirmedSpendCny: "18",
      remainingAfterNextWorstCaseCny: "5.9",
      projectedCompletedWorkflowCostCny: "24.5",
      projectedCompletedWorkflowWith20PercentContingencyCny: "25.8"
    });
  });

  it("uses planned worst case when reported completed spend is lower", () => {
    const plan = createModelArkCanaryBudgetPlan(validPricing());
    const decision = evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds: ["front"],
      confirmedSpend: { currency: "CNY", amountCny: "0" }
    });

    expect(decision.conservativeConfirmedSpendCny).toBe("0.5");
    expect(decision.projectedCompletedWorkflowCostCny).toBe("7");
  });

  it("replaces a completed token-priced action commitment with actual token usage", () => {
    const plan = createModelArkCanaryBudgetPlan(useTokenPricing(validPricing(), "idle"));
    const completedCallIds = ["front", "side", "sleep", "idle"];
    const withoutActualTokens = evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds,
      confirmedSpend: { currency: "CNY", amountCny: "0" }
    });
    const withActualTokens = evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds,
      confirmedSpend: { currency: "CNY", amountCny: "2.72" },
      actualTokensByCallId: { idle: 20_000 }
    });

    expect(withoutActualTokens).toMatchObject({
      accountedCompletedSpendCny: "3.64",
      projectedCompletedWorkflowCostCny: "8.44",
      actualTokenUsage: []
    });
    expect(withActualTokens).toMatchObject({
      allowed: true,
      nextCall: { callId: "sleep-transition" },
      accountedCompletedSpendCny: "2.72",
      conservativeConfirmedSpendCny: "2.72",
      projectedCompletedWorkflowCostCny: "7.52",
      actualTokenUsage: [{
        callId: "idle",
        actualTokens: 20_000,
        plannedMaxTokens: 40_000,
        actualCostCny: "0.92",
        exceededPlan: false
      }]
    });
  });

  it("denies every later call after actual token usage exceeds its planned ceiling", () => {
    const plan = createModelArkCanaryBudgetPlan(useTokenPricing(validPricing(), "idle"));
    const decision = evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds: ["front", "side", "sleep", "idle"],
      confirmedSpend: { currency: "CNY", amountCny: "0" },
      actualTokensByCallId: { idle: 40_001 }
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "actual_tokens_exceed_plan",
      accountedCompletedSpendCny: "3.640046",
      projectedCompletedWorkflowCostCny: "8.440046",
      actualTokenUsage: [{
        callId: "idle",
        actualTokens: 40_001,
        plannedMaxTokens: 40_000,
        exceededPlan: true
      }]
    });
  });

  it("fails closed for malformed or premature actual token reports", () => {
    const plan = createModelArkCanaryBudgetPlan(useTokenPricing(validPricing(), "idle"));
    const confirmedSpend = { currency: "CNY", amountCny: "0" };

    expectBudgetError(() => evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds: ["front", "side", "sleep"],
      confirmedSpend,
      actualTokensByCallId: { idle: 20_000 }
    }), "invalid_state");
    expectBudgetError(() => evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds: ["front"],
      confirmedSpend,
      actualTokensByCallId: { front: 20_000 }
    }), "invalid_state");
    expectBudgetError(() => evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds: ["front", "side", "sleep", "idle"],
      confirmedSpend,
      actualTokensByCallId: { idle: 1.5 }
    }), "invalid_token_count");
  });

  it("denies if any provider attempt has no confirmed price", () => {
    const plan = createModelArkCanaryBudgetPlan(validPricing());
    const decision = evaluateNextModelArkCanaryCall({
      plan,
      confirmedSpend: { currency: "CNY", amountCny: "0" },
      unpricedAttemptCount: 1
    });

    expect(decision).toMatchObject({ allowed: false, code: "unpriced_usage_present" });
  });

  it("fails closed for out-of-order state and requests", () => {
    const plan = createModelArkCanaryBudgetPlan(validPricing());
    const confirmedSpend = { currency: "CNY", amountCny: "0.5" };

    expectBudgetError(() => evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds: ["side"],
      confirmedSpend
    }), "sequence_violation");
    expectBudgetError(() => evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds: ["front"],
      confirmedSpend,
      requestedCallId: "sleep"
    }), "sequence_violation");
  });

  it("fails closed for missing, non-CNY, negative, and over-budget confirmed spend", () => {
    const plan = createModelArkCanaryBudgetPlan(validPricing());

    expectBudgetError(() => evaluateNextModelArkCanaryCall({ plan }), "invalid_state");
    expectBudgetError(() => evaluateNextModelArkCanaryCall({
      plan,
      confirmedSpend: { currency: "USD", amountCny: "0" }
    }), "unsupported_currency");
    expectBudgetError(() => evaluateNextModelArkCanaryCall({
      plan,
      confirmedSpend: { currency: "CNY", amountCny: "-0.01" }
    }), "invalid_price");
    expect(evaluateNextModelArkCanaryCall({
      plan,
      confirmedSpend: { currency: "CNY", amountCny: "30.01" }
    })).toMatchObject({ allowed: false, code: "hard_budget_exceeded" });
  });

  it("returns a terminal non-call decision after every fixed call completed", () => {
    const plan = createModelArkCanaryBudgetPlan(validPricing());
    const decision = evaluateNextModelArkCanaryCall({
      plan,
      completedCallIds: [...FIXED_CALL_ORDER],
      confirmedSpend: { currency: "CNY", amountCny: "7" }
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "complete",
      nextCall: null,
      projectedCompletedWorkflowCostCny: "7"
    });
  });
});
