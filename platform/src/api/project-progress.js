const { PRODUCTION_STATES } = require("../domain/production-state-machine");

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

function createUserProjectView({ project, order, run, awakeCandidate, delivery } = {}) {
  return {
    project: project ? { id: project.id, displayName: project.displayName, state: project.state } : null,
    order: order ? { id: order.id, status: order.status, paymentMethod: order.paymentMethod, amountFen: order.amountFen } : null,
    awakeCandidate: awakeCandidate ? {
      id: awakeCandidate.id,
      previewUrl: awakeCandidate.previewUrl,
      canRegenerate: order && order.status === "paid" && run && run.state === PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION,
      canConfirm: order && order.status === "paid" && run && run.state === PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION
    } : null,
    progress: getProgressStepState(run && run.state),
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
