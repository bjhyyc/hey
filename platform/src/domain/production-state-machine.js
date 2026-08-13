const { REQUIRED_ACTION_IDS, assertPublishedPromptSet } = require("./action-catalog");

const ORDER_STATES = Object.freeze({
  DRAFT: "draft",
  PENDING_PAYMENT: "pending_payment",
  PAID: "paid",
  PAYMENT_REVIEW: "payment_review",
  EXPIRED: "expired",
  REFUND_PENDING: "refund_pending",
  REFUNDED: "refunded"
});

const PRODUCTION_STATES = Object.freeze({
  AWAITING_PHOTOS: "awaiting_photos",
  AWAKE_GENERATING: "awake_generating",
  AWAITING_CHARACTER_CONFIRMATION: "awaiting_character_confirmation",
  SLEEP_GENERATING: "sleep_generating",
  AWAITING_PROMPT_GATE: "awaiting_prompt_gate",
  VIDEO_GENERATING: "video_generating",
  MEDIA_PROCESSING: "media_processing",
  PACKAGING: "packaging",
  VALIDATING: "validating",
  DELIVERABLE: "deliverable",
  FAILED: "failed"
});

function canStartProduction(order) {
  return Boolean(order && order.status === ORDER_STATES.PAID && order.id);
}

function startProductionRun({ order, projectId, runId }) {
  if (!canStartProduction(order)) {
    throw new Error("Only a paid order can start PetPack production");
  }
  if (!projectId || !runId) {
    throw new Error("Production run requires projectId and runId");
  }
  return {
    id: runId,
    projectId,
    orderId: order.id,
    characterRevisionId: null,
    state: PRODUCTION_STATES.AWAITING_PHOTOS,
    promptSnapshot: null,
    completedActions: [],
    failedActions: [],
    awakeGenerationAttempts: 0,
    sleepGenerationAttempts: 0
  };
}

function transitionProductionRun(run, event, payload = {}) {
  if (!run || !run.state) throw new Error("Production run is required");
  const transitions = {
    awakeGenerated: [PRODUCTION_STATES.AWAKE_GENERATING, PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION],
    characterConfirmed: [PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION, PRODUCTION_STATES.SLEEP_GENERATING],
    sleepMasterQaPassed: [PRODUCTION_STATES.SLEEP_GENERATING, PRODUCTION_STATES.AWAITING_PROMPT_GATE],
    promptsVerified: [PRODUCTION_STATES.AWAITING_PROMPT_GATE, PRODUCTION_STATES.VIDEO_GENERATING],
    videosGenerated: [PRODUCTION_STATES.VIDEO_GENERATING, PRODUCTION_STATES.MEDIA_PROCESSING],
    mediaProcessed: [PRODUCTION_STATES.MEDIA_PROCESSING, PRODUCTION_STATES.PACKAGING],
    packageBuilt: [PRODUCTION_STATES.PACKAGING, PRODUCTION_STATES.VALIDATING],
    deliveryReady: [PRODUCTION_STATES.VALIDATING, PRODUCTION_STATES.DELIVERABLE]
  };
  if (event === "failed") {
    return { ...run, state: PRODUCTION_STATES.FAILED };
  }
  if (event === "sleepMasterQaRetry") {
    if (run.state !== PRODUCTION_STATES.SLEEP_GENERATING) {
      throw new Error(`Cannot apply ${event} while production state is ${run.state}`);
    }
    return {
      ...run,
      sleepGenerationAttempts: Number(run.sleepGenerationAttempts || 0) + 1
    };
  }
  if (event === "photosAccepted") {
    if (run.state !== PRODUCTION_STATES.AWAITING_PHOTOS) {
      throw new Error(`Cannot apply ${event} while production state is ${run.state}`);
    }
    return {
      ...run,
      state: PRODUCTION_STATES.AWAKE_GENERATING,
      awakeGenerationAttempts: Math.max(1, Number(run.awakeGenerationAttempts || 0) + 1)
    };
  }
  if (event === "awakeRegenerationRequested") {
    if (run.state !== PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION) {
      throw new Error(`Cannot apply ${event} while production state is ${run.state}`);
    }
    return {
      ...run,
      state: PRODUCTION_STATES.AWAKE_GENERATING,
      awakeGenerationAttempts: Math.max(2, Number(run.awakeGenerationAttempts || 1) + 1)
    };
  }
  const transition = transitions[event];
  if (!transition || run.state !== transition[0]) {
    throw new Error(`Cannot apply ${event} while production state is ${run.state}`);
  }
  if (event === "promptsVerified") {
    return {
      ...run,
      state: transition[1],
      promptSnapshot: assertPublishedPromptSet(payload.promptVersions)
    };
  }
  if (event === "videosGenerated" && !canAdvanceFromVideoGeneration(run)) {
    throw new Error("All seven quality-approved video actions are required before media processing");
  }
  return { ...run, state: transition[1] };
}

function completeVideoAction(run, actionId) {
  if (!run || run.state !== PRODUCTION_STATES.VIDEO_GENERATING) {
    throw new Error("Video actions can be completed only during video generation");
  }
  if (!REQUIRED_ACTION_IDS.includes(actionId)) {
    throw new Error(`Unknown video action: ${actionId}`);
  }
  const completedActions = [...new Set([...(run.completedActions || []), actionId])];
  return { ...run, completedActions };
}

function canAdvanceFromVideoGeneration(run) {
  return REQUIRED_ACTION_IDS.every((actionId) => (run.completedActions || []).includes(actionId));
}

module.exports = {
  ORDER_STATES,
  PRODUCTION_STATES,
  canAdvanceFromVideoGeneration,
  canStartProduction,
  completeVideoAction,
  startProductionRun,
  transitionProductionRun
};
