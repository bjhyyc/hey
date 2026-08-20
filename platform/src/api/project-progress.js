const {
  MAX_USER_REGENERATIONS_PER_VIEW,
  PRODUCTION_STATES
} = require("../domain/production-state-machine");

const USER_PROGRESS_STEPS = Object.freeze([
  { id: "character-confirmed", label: "宠物形象已确认" },
  { id: "sleep-lock", label: "正在锁定睡眠姿态" },
  { id: "videos", label: "正在生成 7 个视频" },
  { id: "media-qa", label: "正在抠图与统一尺寸" },
  { id: "validate", label: "正在验证 PetPack" },
  { id: "package", label: "正在打包下载" }
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
      complete.add("character-confirmed");
      active = "sleep-lock";
      break;
    case PRODUCTION_STATES.AWAITING_PROMPT_GATE:
    case PRODUCTION_STATES.VIDEO_GENERATING:
      complete.add("character-confirmed");
      complete.add("sleep-lock");
      active = "videos";
      break;
    case PRODUCTION_STATES.MEDIA_PROCESSING:
      complete.add("character-confirmed");
      complete.add("sleep-lock");
      complete.add("videos");
      active = "media-qa";
      break;
    case PRODUCTION_STATES.PACKAGING:
      complete.add("character-confirmed");
      complete.add("sleep-lock");
      complete.add("videos");
      complete.add("media-qa");
      active = "package";
      break;
    case PRODUCTION_STATES.VALIDATING:
      complete.add("character-confirmed");
      complete.add("sleep-lock");
      complete.add("videos");
      complete.add("media-qa");
      active = "validate";
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

// The seven actions in the order the customer sees them, with the wording used
// everywhere else in the product rather than the internal action IDs.
const ACTION_LABELS = Object.freeze({
  idle: "待机",
  sneeze: "打喷嚏",
  roll: "打滚",
  stretch: "伸懒腰",
  "hover-attention": "抬头看你",
  "sleep-transition": "入睡",
  "sleep-loop": "睡眠循环"
});
const ACTION_ORDER = Object.freeze([
  "idle", "sneeze", "roll", "stretch", "hover-attention", "sleep-transition", "sleep-loop"
]);
const ACTION_STATE_LABELS = Object.freeze({
  queued: "排队中",
  running: "生成中",
  succeeded: "已生成",
  processed: "抠像中",
  qa_passed: "已完成",
  failed: "未通过"
});

function createActionProgress(actions) {
  const byId = new Map((Array.isArray(actions) ? actions : []).map((action) => [action.actionId, action]));
  return ACTION_ORDER.filter((actionId) => byId.has(actionId)).map((actionId) => {
    const action = byId.get(actionId);
    return {
      actionId,
      label: ACTION_LABELS[actionId] || actionId,
      state: action.state,
      stateLabel: ACTION_STATE_LABELS[action.state] || action.state,
      // A redo is worth showing: it is the quality gate working, not a fault.
      regenerated: Number(action.retryCount || 0) > 0,
      complete: action.state === "qa_passed"
    };
  });
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
    // The page needs to tell "a master is being regenerated" apart from "this
    // run is long past the character step": both leave canConfirm false, and
    // without the run's own state the character page told an owner whose videos
    // were already generating that a master was still coming.
    productionState: run && run.state ? run.state : null,
    progress: getProgressStepState(run && run.state),
    actions: createActionProgress(actions),
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
    productionState: run ? run.state : null,
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
