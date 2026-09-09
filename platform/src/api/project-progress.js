const {
  MAX_USER_REGENERATIONS_PER_VIEW,
  PRODUCTION_STATES
} = require("../domain/production-state-machine");

// What the customer is told while they wait. These are deliberately the three
// things they care about - their character is settled, the animations are being
// made, the pack is being assembled - and deliberately NOT the production
// stages behind them. The internal pipeline (which masters are drawn in what
// order, how a video is bounded, what the quality gates measure, how many
// segments make an action) is the product's own know-how, and a progress
// screen that narrates it hands a competitor the recipe for free.
const USER_PROGRESS_STEPS = Object.freeze([
  { id: "character-confirmed", label: "宠物形象已确认" },
  { id: "animations", label: "正在制作动作" },
  { id: "package", label: "正在生成素材包" }
]);

function getProgressStepState(runState) {
  const complete = new Set();
  let active = "character-confirmed";
  switch (runState) {
    case PRODUCTION_STATES.AWAITING_PHOTOS:
    case PRODUCTION_STATES.AWAKE_GENERATING:
    case PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION:
      break;
    case PRODUCTION_STATES.SLEEP_GENERATING:
    case PRODUCTION_STATES.AWAITING_PROMPT_GATE:
    case PRODUCTION_STATES.VIDEO_GENERATING:
      complete.add("character-confirmed");
      active = "animations";
      break;
    case PRODUCTION_STATES.MEDIA_PROCESSING:
    case PRODUCTION_STATES.PACKAGING:
    case PRODUCTION_STATES.VALIDATING:
      complete.add("character-confirmed");
      complete.add("animations");
      active = "package";
      break;
    case PRODUCTION_STATES.DELIVERABLE:
      USER_PROGRESS_STEPS.forEach((step) => complete.add(step.id));
      active = null;
      break;
    default:
      active = null;
  }
  return USER_PROGRESS_STEPS.map((step) => ({
    ...step,
    state: complete.has(step.id) ? "complete" : (step.id === active ? "active" : "pending")
  }));
}

/**
 * How far the animation work has got, as a single percentage.
 *
 * It used to be a per-action list: every clip named, its own state, and a "重做"
 * badge whenever a quality gate rejected a take. That told the customer nothing
 * they could act on - they wait either way - while telling anyone reading the
 * response exactly how the pack is assembled and where it tends to fail. The
 * percentage is what the customer actually wants; the composition stays ours.
 */
function createActionProgressSummary(actions) {
  const list = Array.isArray(actions) ? actions : [];
  if (list.length === 0) return null;
  const done = list.filter((action) => action.state === "qa_passed").length;
  // Rounded to a 5% step so the number cannot be used to count the segments.
  const percent = Math.min(100, Math.max(0, Math.round((done / list.length) * 20) * 5));
  return { percent };
}

function createUserProjectView({ project, order, run, characterCandidates, delivery, actions } = {}) {
  const paidAndConfirming = Boolean(order && order.status === "paid" && run && run.state === PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION);
  const candidateFor = (view) => {
    const candidate = characterCandidates && characterCandidates[view];
    if (!candidate) return null;
    const used = Number(run?.[`${view}UserRegenerationsUsed`] || 0);
    const remainingRegenerations = Math.max(0, MAX_USER_REGENERATIONS_PER_VIEW - used);
    const attempts = Array.isArray(candidate.attempts) ? candidate.attempts : [];
    return {
      id: candidate.id,
      view,
      previewUrl: candidate.previewUrl,
      canRegenerate: paidAndConfirming && remainingRegenerations > 0,
      remainingRegenerations,
      // Only worth offering a choice once there is more than one version.
      attempts: attempts.length > 1 ? attempts : []
    };
  };
  const front = candidateFor("front");
  const side = candidateFor("side");
  return {
    project: project ? { id: project.id, displayName: project.displayName, state: project.state } : null,
    order: order ? { id: order.id, status: order.status, paymentMethod: order.paymentMethod, amountFen: order.amountFen } : null,
    characterCandidates: {
      front,
      side,
      canConfirm: paidAndConfirming && Boolean(front && side)
    },
    // The character page needs one bit: is a master still being drawn (so
    // "coming shortly") or is the run long past that step (so the page should
    // move on)? Both leave canConfirm false. It used to read the run's raw
    // state, which meant shipping the whole internal stage vocabulary -
    // sleep_generating, awaiting_prompt_gate, media_processing, validating - to
    // every browser. One boolean answers the question and names nothing.
    regeneratingCharacter: Boolean(run && run.state === PRODUCTION_STATES.AWAKE_GENERATING),
    progress: getProgressStepState(run && run.state),
    actionProgress: createActionProgressSummary(actions),
    downloadReady: Boolean(delivery && delivery.status === "ready"),
    failed: Boolean(run && run.state === PRODUCTION_STATES.FAILED)
  };
}

function getProjectNextStep({ order, run, delivery } = {}) {
  if (delivery && ["ready", "downloaded"].includes(delivery.status)) return "delivery";
  if (run && run.state === PRODUCTION_STATES.FAILED) return "failed";
  if (!order || order.status !== "paid") return "payment";
  if (!run || run.state === PRODUCTION_STATES.AWAITING_PHOTOS) return "photos";
  if ([PRODUCTION_STATES.AWAKE_GENERATING, PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION].includes(run.state)) {
    return "character";
  }
  return "progress";
}

function safeIsoTimestamp(value) {
  if (!value) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function createUserProjectSummary({ project, order, run, delivery } = {}) {
  if (!project) throw new Error("Project summary requires a project");
  return {
    project: {
      id: project.id,
      displayName: project.displayName,
      state: project.state,
      updatedAt: safeIsoTimestamp(project.updatedAt)
    },
    order: order ? {
      id: order.id,
      status: order.status,
      paymentMethod: order.paymentMethod,
      amountFen: order.amountFen
    } : null,
    // `nextStep` already says what the customer should do; the run's internal
    // stage name would only narrate the pipeline in the project list.
    downloadReady: Boolean(delivery && ["ready", "downloaded"].includes(delivery.status)),
    failed: Boolean(run && run.state === PRODUCTION_STATES.FAILED),
    nextStep: getProjectNextStep({ order, run, delivery })
  };
}

module.exports = {
  USER_PROGRESS_STEPS,
  createUserProjectSummary,
  createUserProjectView,
  getProjectNextStep,
  getProgressStepState
};
