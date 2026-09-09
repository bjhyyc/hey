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

// What the customer bought, in their words. The pack is assembled from more
// clips than this - how many, and which of them combine, is production detail -
// so the waiting screen groups them into the things the pet will actually do.
const CUSTOMER_ANIMATIONS = Object.freeze([
  { id: "sneeze", label: "打喷嚏", clips: ["sneeze"] },
  { id: "roll", label: "打滚", clips: ["roll"] },
  { id: "stretch", label: "伸懒腰", clips: ["stretch"] },
  { id: "lick", label: "舔脚", clips: ["hover-attention"] },
  { id: "sleep", label: "睡觉", clips: ["sleep-transition", "sleep-loop"] },
  { id: "idle", label: "安静待机", clips: ["idle"] }
]);

/**
 * How the animation work is going, as the customer's own list.
 *
 * Watching it happen is most of the fun of waiting, so this says which of the
 * pet's abilities are finished and which is being made right now. What it does
 * not say is how the pack is built: not how many clips there are, not which of
 * them combine into one ability, not the processing stage a clip is in, and not
 * whether a quality gate rejected a take and asked for another. A redo is
 * normal and invisible - the ability simply stays "制作中" a little longer.
 */
function createActionProgressSummary(actions) {
  const list = Array.isArray(actions) ? actions : [];
  if (list.length === 0) return null;
  const byId = new Map(list.map((action) => [action.actionId, action]));
  const items = CUSTOMER_ANIMATIONS
    .filter((animation) => animation.clips.some((clip) => byId.has(clip)))
    .map((animation) => {
      const present = animation.clips.map((clip) => byId.get(clip)).filter(Boolean);
      const done = present.every((action) => action.state === "qa_passed");
      // "Being made now" means any of its clips has left the queue: the
      // customer sees movement without learning what the stages are.
      const working = !done && present.some((action) => action.state !== "queued");
      return { id: animation.id, label: animation.label, state: done ? "done" : (working ? "working" : "waiting") };
    });
  const done = items.filter((item) => item.state === "done").length;
  const percent = items.length === 0 ? 0 : Math.round((done / items.length) * 100);
  return { percent, items };
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
