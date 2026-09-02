const { DEFAULT_PET_SPECIES, REQUIRED_ACTION_IDS, assertPetSpecies, assertPublishedPromptSet } = require("./action-catalog");

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

const CHARACTER_MASTER_VIEWS = Object.freeze(["front", "side"]);
const MAX_USER_REGENERATIONS_PER_VIEW = 2;

function assertCharacterMasterView(value) {
  if (!CHARACTER_MASTER_VIEWS.includes(value)) throw new Error("Character master view must be front or side");
  return value;
}

function characterField(view, suffix) {
  return `${assertCharacterMasterView(view)}${suffix}`;
}

function regenerationLimitError(view) {
  const error = new Error(`The ${view} character master self-service regeneration limit has been reached`);
  error.code = "character_regeneration_limit_reached";
  return error;
}

function adminRerunStageError(message) {
  const error = new Error(message);
  error.code = "admin_rerun_stage_unavailable";
  return error;
}

// The state a run resumes in for each administrator rerun stage, which must
// equal the state it failed from (production_run_event.previous_state of the
// latest failed transition). This is stage validation by where the run died,
// not by failure code: workers fail runs with many codes (QA exhaustion,
// provider errors, budget exhaustion) and all of them deserve the same rescue.
const ADMIN_RERUN_RESUME_STATES = Object.freeze({
  front_master: PRODUCTION_STATES.AWAKE_GENERATING,
  side_master: PRODUCTION_STATES.AWAKE_GENERATING,
  sleep_master: PRODUCTION_STATES.SLEEP_GENERATING,
  action: PRODUCTION_STATES.VIDEO_GENERATING,
  // The seven-action media gate: a run refused there still holds every
  // master and video it needs, so the resume queues packaging again.
  package: PRODUCTION_STATES.MEDIA_PROCESSING
});

/**
 * An administrator authorizes exactly one extra generation for the stage a
 * failed run died in. No retry budgets are raised: if the granted generation
 * fails quality again, the existing exhaustion checks return the run to
 * `failed` and a further grant needs a further explicit authorization.
 */
function adminRerunProductionRun(run, { stage, failedFromState } = {}) {
  if (!run || run.state !== PRODUCTION_STATES.FAILED) {
    throw adminRerunStageError("Only a failed production run can be rerun by an administrator");
  }
  const resumeState = ADMIN_RERUN_RESUME_STATES[stage];
  if (!resumeState) throw adminRerunStageError(`Administrator rerun does not support stage: ${stage}`);
  if (failedFromState !== resumeState) {
    throw adminRerunStageError(`The run failed from ${failedFromState || "an unknown state"}, not from the ${stage} stage`);
  }
  if (stage === "front_master" || stage === "side_master") {
    const view = stage === "front_master" ? "front" : "side";
    return {
      ...run,
      state: resumeState,
      // Attempts stay monotonic so the rerun's job revision and its
      // master_image_generation row can never collide with earlier attempts.
      [characterField(view, "GenerationAttempts")]: Number(run[characterField(view, "GenerationAttempts")] || 0) + 1,
      failureCode: null
    };
  }
  if (stage === "sleep_master") {
    if (!run.characterRevisionId) {
      throw adminRerunStageError("Sleeping-master rerun requires a confirmed character revision");
    }
    return {
      ...run,
      state: resumeState,
      sleepGenerationAttempts: Number(run.sleepGenerationAttempts || 0) + 1,
      failureCode: null
    };
  }
  // stage === "action": the generation_action reset (queued state, cleared
  // provider fields, retry_count increment) is committed by the workflow store
  // in the same transaction as this run transition. stage === "package": the
  // dead media-gate execution is retargeted there too.
  return { ...run, state: resumeState, failureCode: null };
}

/**
 * An administrator force-passes one QA-rejected candidate of a failed run.
 * The run resumes at the point right after the stage's ordinary QA pass:
 *
 * - front/side master: back to customer confirmation - the override only puts
 *   the image back on the customer's candidate list, it never confirms for
 *   them. Except when the front override happens before the side view ever
 *   generated: then the run mirrors `characterMasterGenerated` and returns to
 *   awake_generating with the side generation started (`needsSideGeneration`).
 * - sleep master: the customer never picks the sleeping master, so the
 *   administrator's choice is final and the run advances to the prompt gate.
 * - action: back to video_generating; the chosen provider video re-enters
 *   media processing with the QA verdict recorded but not blocking (the
 *   generation_action reset is committed by the workflow store).
 */
function adminQaOverrideProductionRun(run, { stage, failedFromState } = {}) {
  if (!run || run.state !== PRODUCTION_STATES.FAILED) {
    throw adminRerunStageError("Only a failed production run can accept a QA override");
  }
  const resumeState = stage === "package" ? null : ADMIN_RERUN_RESUME_STATES[stage];
  if (!resumeState) throw adminRerunStageError(`QA override does not support stage: ${stage}`);
  if (failedFromState !== resumeState) {
    throw adminRerunStageError(`The run failed from ${failedFromState || "an unknown state"}, not from the ${stage} stage`);
  }
  if (stage === "front_master" || stage === "side_master") {
    const view = stage === "front_master" ? "front" : "side";
    const needsSideGeneration = view === "front" && Number(run.sideGenerationAttempts || 0) === 0;
    if (needsSideGeneration) {
      return {
        run: {
          ...run,
          state: PRODUCTION_STATES.AWAKE_GENERATING,
          sideGenerationAttempts: 1,
          sideQaRetries: 0,
          failureCode: null
        },
        needsSideGeneration: true
      };
    }
    return {
      run: { ...run, state: PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION, failureCode: null },
      needsSideGeneration: false
    };
  }
  if (stage === "sleep_master") {
    if (!run.characterRevisionId) {
      throw adminRerunStageError("Sleeping-master override requires a confirmed character revision");
    }
    return {
      run: { ...run, state: PRODUCTION_STATES.AWAITING_PROMPT_GATE, failureCode: null },
      needsSideGeneration: false
    };
  }
  return {
    run: { ...run, state: PRODUCTION_STATES.VIDEO_GENERATING, failureCode: null },
    needsSideGeneration: false
  };
}

/**
 * Hands one spent self-service regeneration back to the customer, so the
 * "重新生成" button reappears on their confirmation page. Mirrors what
 * `characterRegenerationAbandoned` already does when a regeneration produced
 * nothing usable - the counter decrement is the established mechanism.
 */
function adminGrantCharacterRegeneration(run, { view } = {}) {
  const safeView = assertCharacterMasterView(view);
  if (!run || run.state !== PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION) {
    throw adminRerunStageError("A regeneration can be granted only while the customer is confirming character masters");
  }
  const field = characterField(safeView, "UserRegenerationsUsed");
  const used = Number(run[field] || 0);
  if (used <= 0) {
    const error = new Error(`The ${safeView} view still has unused self-service regenerations`);
    error.code = "admin_regeneration_grant_unavailable";
    throw error;
  }
  return { ...run, [field]: used - 1 };
}

function canStartProduction(order) {
  return Boolean(order && order.status === ORDER_STATES.PAID && order.id);
}

function startProductionRun({ order, projectId, runId, modelRegistryVersion, species }) {
  if (!canStartProduction(order)) {
    throw new Error("Only a paid order can start PetPack production");
  }
  if (!projectId || !runId) {
    throw new Error("Production run requires projectId and runId");
  }
  if (typeof modelRegistryVersion !== "string" || !modelRegistryVersion.trim()) {
    throw new Error("Production run requires a frozen model registry version");
  }
  return {
    id: runId,
    projectId,
    orderId: order.id,
    modelRegistryVersion: modelRegistryVersion.trim(),
    // Frozen for the life of the run alongside the model registry: the prompt
    // set is chosen by species, and a run must not switch sets midway.
    species: assertPetSpecies(species === undefined ? DEFAULT_PET_SPECIES : species),
    characterRevisionId: null,
    state: PRODUCTION_STATES.AWAITING_PHOTOS,
    promptSnapshot: null,
    completedActions: [],
    failedActions: [],
    frontGenerationAttempts: 0,
    sideGenerationAttempts: 0,
    frontUserRegenerationsUsed: 0,
    sideUserRegenerationsUsed: 0,
    frontQaRetries: 0,
    sideQaRetries: 0,
    sleepGenerationAttempts: 0
  };
}

function transitionProductionRun(run, event, payload = {}) {
  if (!run || !run.state) throw new Error("Production run is required");
  const transitions = {
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
      frontGenerationAttempts: Math.max(1, Number(run.frontGenerationAttempts || 0) + 1),
      frontQaRetries: 0
    };
  }
  if (event === "characterRegenerationRequested") {
    if (run.state !== PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION) {
      throw new Error(`Cannot apply ${event} while production state is ${run.state}`);
    }
    return {
      ...run,
      state: PRODUCTION_STATES.AWAKE_GENERATING,
      [characterField(payload.view, "GenerationAttempts")]: Math.max(1, Number(run[characterField(payload.view, "GenerationAttempts")] || 0) + 1),
      [characterField(payload.view, "UserRegenerationsUsed")]: (() => {
        const field = characterField(payload.view, "UserRegenerationsUsed");
        if (Number(run[field] || 0) >= MAX_USER_REGENERATIONS_PER_VIEW) throw regenerationLimitError(payload.view);
        return Number(run[field] || 0) + 1;
      })(),
      [characterField(payload.view, "QaRetries")]: 0
    };
  }
  if (event === "characterMasterQaRetry") {
    if (run.state !== PRODUCTION_STATES.AWAKE_GENERATING) throw new Error(`Cannot apply ${event} while production state is ${run.state}`);
    const view = assertCharacterMasterView(payload.view);
    return {
      ...run,
      [characterField(view, "GenerationAttempts")]: Number(run[characterField(view, "GenerationAttempts")] || 0) + 1,
      [characterField(view, "QaRetries")]: Number(run[characterField(view, "QaRetries")] || 0) + 1
    };
  }
  // A regeneration that cannot pass quality must not destroy a paid order that
  // already has an approved master: the run returns to confirmation with the
  // version the customer could already see, and the spent regeneration - which
  // produced nothing usable - is handed back.
  if (event === "characterRegenerationAbandoned") {
    if (run.state !== PRODUCTION_STATES.AWAKE_GENERATING) throw new Error(`Cannot apply ${event} while production state is ${run.state}`);
    const view = assertCharacterMasterView(payload.view);
    return {
      ...run,
      state: PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION,
      [characterField(view, "QaRetries")]: 0,
      [characterField(view, "UserRegenerationsUsed")]: Math.max(0, Number(run[characterField(view, "UserRegenerationsUsed")] || 0) - 1)
    };
  }
  if (event === "characterMasterGenerated") {
    if (run.state !== PRODUCTION_STATES.AWAKE_GENERATING) throw new Error(`Cannot apply ${event} while production state is ${run.state}`);
    const view = assertCharacterMasterView(payload.view);
    if (view === "front" && Number(run.sideGenerationAttempts || 0) === 0) {
      return { ...run, sideGenerationAttempts: 1, sideQaRetries: 0 };
    }
    return { ...run, state: PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION };
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
  ADMIN_RERUN_RESUME_STATES,
  CHARACTER_MASTER_VIEWS,
  MAX_USER_REGENERATIONS_PER_VIEW,
  ORDER_STATES,
  PRODUCTION_STATES,
  adminGrantCharacterRegeneration,
  adminQaOverrideProductionRun,
  adminRerunProductionRun,
  canAdvanceFromVideoGeneration,
  canStartProduction,
  completeVideoAction,
  assertCharacterMasterView,
  startProductionRun,
  transitionProductionRun
};
