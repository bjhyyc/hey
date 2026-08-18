const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");

const { DEFAULT_MODELARK_BASE_URL } = require("../config/model-registry");
const {
  assertNextModelArkCanaryCallAllowed,
  createModelArkCanaryBudgetPlan
} = require("../domain/modelark-canary-budget");
const { formatDecimalUnits, parseDecimal } = require("../domain/provider-cost-accounting");
const { ACTION_ENDPOINTS } = require("../domain/action-catalog");
const { CHARACTER_CANVAS_V1 } = require("../qa/character-canvas-v1");
const {
  formatServerOnlyImageInstruction
} = require("../providers/modelark-client");
const {
  parsePetPackPromptFileFromPath,
  replacePromptTokens
} = require("../prompts/prompt-file");

const CONTRACT_VERSION = "controlled-real-modelark-canary/v1";
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const CONTROLLED_ROOT = path.join(PROJECT_ROOT, ".tmp", "controlled-real-canary");
// v2 replaces only the sleep-transition positive prompt with the recovered
// original override (docs/prompts/sleep-transition-original-override-v1.txt);
// the other nine sections parse byte-identically to v1.
const PROMPT_FILE = path.join(PROJECT_ROOT, "docs", "prompts", "正式发布候选·三母图七动作·480p-v2.txt");
const MAX_JPEG_BYTES = 20 * 1024 * 1024;
const MAX_NORMALIZED_MASTER_BYTES = 48 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FIXED_BUDGET_CNY = "30";
const CONTINGENCY_PERCENT = 20n;
const BUDGET_SAFETY_PERCENT = 80n;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_POLLS = 120;
const IMAGE_STAGE_IDS = Object.freeze(["front", "side", "sleep"]);
const REPRESENTATIVE_VIDEO_IDS = Object.freeze([
  "idle",
  "sleep-transition",
  "sleep-loop",
  "stretch"
]);
const REMAINING_VIDEO_IDS = Object.freeze(["sneeze", "roll", "hover-attention"]);
const VIDEO_STAGE_IDS = Object.freeze([...REPRESENTATIVE_VIDEO_IDS, ...REMAINING_VIDEO_IDS]);
const STAGE_IDS = Object.freeze([...IMAGE_STAGE_IDS, ...VIDEO_STAGE_IDS]);

class ControlledCanaryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ControlledCanaryError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ControlledCanaryError(code, message, options);
}

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    fail("invalid_argument", `${label} is required`);
  }
  return value.trim();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizePetType(value) {
  const normalized = requiredString(value, "petType", 16).toLowerCase();
  if (normalized === "dog" || normalized === "狗") return Object.freeze({ id: "dog", promptValue: "狗" });
  if (normalized === "cat" || normalized === "猫") return Object.freeze({ id: "cat", promptValue: "猫" });
  fail("invalid_pet_type", "petType must be dog/cat or 狗/猫");
}

function windowsDrive(value) {
  const root = path.parse(path.resolve(value)).root;
  return /^[A-Za-z]:[\\/]$/.test(root) ? root.slice(0, 1).toUpperCase() : "";
}

function isStrictDescendant(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNotForbiddenDrive(filePath, label) {
  if (windowsDrive(filePath) === "E") fail("forbidden_drive", `${label} must not use the E: drive`);
}

function normalizeOutputRoot(value) {
  const raw = requiredString(value, "outputRoot", 2048);
  if (!path.isAbsolute(raw)) fail("unsafe_output_root", "outputRoot must be absolute");
  const resolved = path.resolve(raw);
  assertNotForbiddenDrive(resolved, "outputRoot");
  if (!isStrictDescendant(CONTROLLED_ROOT, resolved)) {
    fail("unsafe_output_root", `outputRoot must be a strict child of ${CONTROLLED_ROOT}`);
  }
  if (path.resolve(resolved) === path.resolve(PROJECT_ROOT)) {
    fail("unsafe_output_root", "The project root cannot be used as outputRoot");
  }
  return resolved;
}

async function lstatIfExists(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoLinksBelow(base, candidate) {
  const safeBase = path.resolve(base);
  const safeCandidate = path.resolve(candidate);
  if (safeCandidate !== safeBase && !isStrictDescendant(safeBase, safeCandidate)) {
    fail("unsafe_path", "Path escapes the controlled canary root");
  }
  const relative = path.relative(safeBase, safeCandidate);
  let current = safeBase;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const stat = await lstatIfExists(current);
    if (stat?.isSymbolicLink()) fail("unsafe_path", `Path traverses a symbolic link: ${current}`);
  }
}

async function prepareOutputRoot(outputRoot) {
  const safeOutputRoot = normalizeOutputRoot(outputRoot);
  await fsp.mkdir(CONTROLLED_ROOT, { recursive: true });
  const controlledStat = await fsp.lstat(CONTROLLED_ROOT);
  if (!controlledStat.isDirectory() || controlledStat.isSymbolicLink()) {
    fail("unsafe_output_root", "Controlled canary root must be a real directory");
  }
  await assertNoLinksBelow(CONTROLLED_ROOT, safeOutputRoot);
  await fsp.mkdir(safeOutputRoot, { recursive: true });
  await assertNoLinksBelow(CONTROLLED_ROOT, safeOutputRoot);
  const stat = await fsp.lstat(safeOutputRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_output_root", "outputRoot must be a real directory");
  const [realControlled, realOutput] = await Promise.all([
    fsp.realpath(CONTROLLED_ROOT),
    fsp.realpath(safeOutputRoot)
  ]);
  if (!isStrictDescendant(realControlled, realOutput)) {
    fail("unsafe_output_root", "Resolved outputRoot escapes the controlled canary root");
  }
  return realOutput;
}

async function inspectJpeg(filePath, role) {
  const raw = requiredString(filePath, `${role} JPEG path`, 2048);
  if (!path.isAbsolute(raw)) fail("invalid_input_path", `${role} JPEG path must be absolute`);
  const resolved = path.resolve(raw);
  assertNotForbiddenDrive(resolved, `${role} JPEG`);
  if (![".jpg", ".jpeg"].includes(path.extname(resolved).toLowerCase())) {
    fail("invalid_jpeg", `${role} must use a .jpg or .jpeg extension`);
  }
  const stat = await fsp.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("invalid_jpeg", `${role} must be a regular non-symbolic file`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 4 || stat.size > MAX_JPEG_BYTES) {
    fail("invalid_jpeg", `${role} JPEG must be between 4 bytes and ${MAX_JPEG_BYTES} bytes`);
  }
  const bytes = await fsp.readFile(resolved);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    fail("invalid_jpeg", `${role} is not a JPEG file`);
  }
  return Object.freeze({
    role,
    path: resolved,
    byteSize: bytes.length,
    sha256: sha256(bytes)
  });
}

function normalizeModelConfig(value = {}) {
  const resolution = requiredString(value.videoResolution, "MODELARK_VIDEO_RESOLUTION", 16);
  if (resolution !== "480p") fail("invalid_model_config", "Controlled canary video resolution must be 480p");
  const baseUrl = requiredString(value.baseUrl || DEFAULT_MODELARK_BASE_URL, "MODELARK_BASE_URL", 1024);
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail("invalid_model_config", "MODELARK_BASE_URL is invalid");
  }
  const expected = new URL(DEFAULT_MODELARK_BASE_URL);
  if (parsed.toString().replace(/\/$/, "") !== expected.toString().replace(/\/$/, "")) {
    fail("invalid_model_config", "Controlled real canary only permits the pinned ModelArk production base URL");
  }
  if (!Array.isArray(value.artifactHosts) || value.artifactHosts.length < 1 || value.artifactHosts.length > 8) {
    fail("invalid_model_config", "One to eight explicit ModelArk artifact hosts are required");
  }
  const artifactHosts = [...new Set(value.artifactHosts.map((host) => requiredString(host, "ModelArk artifact host", 253).toLowerCase()))];
  for (const host of artifactHosts) {
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) ||
        host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || net.isIP(host)) {
      fail("invalid_model_config", "ModelArk artifact hosts must be explicit public DNS hostnames");
    }
  }
  return Object.freeze({
    baseUrl: parsed.toString().replace(/\/$/, ""),
    registryVersion: requiredString(value.registryVersion, "MODEL_REGISTRY_VERSION", 128),
    region: requiredString(value.region, "MODELARK_REGION", 128),
    seedreamEndpointId: requiredString(value.seedreamEndpointId, "MODELARK_SEEDREAM_ENDPOINT_ID", 256),
    seedanceEndpointId: requiredString(value.seedanceEndpointId, "MODELARK_SEEDANCE_ENDPOINT_ID", 256),
    seedreamOutputSize: requiredString(value.seedreamOutputSize, "MODELARK_SEEDREAM_OUTPUT_SIZE", 128),
    videoResolution: resolution,
    artifactHosts: Object.freeze(artifactHosts.sort())
  });
}

function normalizePriceCard(value = {}) {
  const budget = parseDecimal(requiredString(value.budgetCny, "budgetCny", 64), {
    label: "Canary budget",
    allowZero: false
  });
  if (budget.value !== FIXED_BUDGET_CNY) {
    fail("invalid_budget", `Controlled canary budget must be exactly CNY ${FIXED_BUDGET_CNY}`);
  }
  const prices = {
    front: parseDecimal(requiredString(value.frontImageCny, "frontImageCny", 64), { label: "Front image price" }),
    side: parseDecimal(requiredString(value.sideImageCny, "sideImageCny", 64), { label: "Side image price" }),
    sleep: parseDecimal(requiredString(value.sleepImageCny, "sleepImageCny", 64), { label: "Sleep image price" }),
    videoSecond: parseDecimal(requiredString(value.videoSecondCny, "videoSecondCny", 64), { label: "Video requested-second price" })
  };
  const tokenMillion = value.tokenMillionCny === undefined || value.tokenMillionCny === null || value.tokenMillionCny === ""
    ? null
    : parseDecimal(requiredString(value.tokenMillionCny, "tokenMillionCny", 64), {
      label: "Observed token price",
      allowZero: false
    });
  return Object.freeze({
    version: requiredString(value.version, "priceCardVersion", 128),
    sourceReference: requiredString(value.sourceReference, "priceSourceReference", 512),
    currency: "CNY",
    budgetCny: budget.value,
    budgetUnits: budget.units,
    prices,
    tokenMillion
  });
}

function promptDigest(prompt, negativePrompt) {
  return sha256(canonicalJson({ prompt, negativePrompt }));
}

function buildPromptBundle(petType) {
  const parsed = parsePetPackPromptFileFromPath(PROMPT_FILE);
  const images = Object.fromEntries(parsed.images.map((item) => {
    const prompt = replacePromptTokens(item.prompt, { petType: petType.promptValue });
    const negativePrompt = replacePromptTokens(item.negativePrompt, { petType: petType.promptValue });
    return [item.kind, Object.freeze({ ...item, prompt, negativePrompt, digest: promptDigest(prompt, negativePrompt) })];
  }));
  const videos = Object.fromEntries(parsed.videos.map((item) => {
    const prompt = replacePromptTokens(item.prompt, { petType: petType.promptValue });
    const negativePrompt = replacePromptTokens(item.negativePrompt, { petType: petType.promptValue });
    return [item.actionId, Object.freeze({ ...item, prompt, negativePrompt, digest: promptDigest(prompt, negativePrompt) })];
  }));
  const bundleHash = sha256(canonicalJson({
    images: Object.fromEntries(Object.entries(images).map(([id, item]) => [id, item.digest])),
    videos: Object.fromEntries(Object.entries(videos).map(([id, item]) => [id, item.digest]))
  }));
  return Object.freeze({ images: Object.freeze(images), videos: Object.freeze(videos), bundleHash });
}

function stageRequestId(planSeed, stageId) {
  return `petpack-canary-${sha256(`${planSeed}|${stageId}`).slice(0, 48)}`;
}

async function createCanaryPlan(options = {}) {
  const outputRoot = normalizeOutputRoot(options.outputRoot);
  const petType = normalizePetType(options.petType);
  const model = normalizeModelConfig(options.model);
  const priceCard = normalizePriceCard(options.priceCard);
  const inputPaths = options.inputPaths || {};
  const inputs = await Promise.all([
    inspectJpeg(inputPaths.front1, "front-1"),
    inspectJpeg(inputPaths.front2, "front-2"),
    inspectJpeg(inputPaths.angle1, "angle-1")
  ]);
  if (new Set(inputs.map((item) => item.sha256)).size !== inputs.length) {
    fail("duplicate_input", "All three JPEG inputs must be different");
  }
  const prompts = buildPromptBundle(petType);
  const videoDurations = Object.fromEntries(Object.entries(prompts.videos).map(([id, item]) => [id, Number(item.duration)]));
  if (VIDEO_STAGE_IDS.some((id) => !Number.isInteger(videoDurations[id]) || videoDurations[id] < 4 || videoDurations[id] > 15)) {
    fail("invalid_prompt_bundle", "Prompt bundle contains an invalid video duration");
  }
  const providerBudgetPlan = createModelArkCanaryBudgetPlan({
    images: Object.fromEntries(IMAGE_STAGE_IDS.map((id) => [id, {
      currency: "CNY",
      pricePerImageCny: priceCard.prices[id].value
    }])),
    videos: Object.fromEntries(VIDEO_STAGE_IDS.map((id) => [id, {
      currency: "CNY",
      durationSeconds: videoDurations[id],
      pricePerSecondCny: priceCard.prices.videoSecond.value
    }]))
  });
  const rawStages = [
    ...IMAGE_STAGE_IDS.map((id) => ({
      id,
      type: "image",
      cohort: "masters",
      costUnits: priceCard.prices[id].units,
      costCny: priceCard.prices[id].value,
      promptDigest: prompts.images[id].digest
    })),
    ...VIDEO_STAGE_IDS.map((id) => {
      const duration = videoDurations[id];
      const costUnits = priceCard.prices.videoSecond.units * BigInt(duration);
      const endpoint = ACTION_ENDPOINTS[id];
      if (!endpoint) fail("invalid_prompt_bundle", `Missing action endpoint for ${id}`);
      return {
        id,
        actionId: id,
        type: "video",
        cohort: REPRESENTATIVE_VIDEO_IDS.includes(id) ? "representative" : "remaining",
        duration,
        firstMaster: endpoint.firstMaster,
        lastMaster: endpoint.lastMaster,
        costUnits,
        costCny: formatDecimalUnits(costUnits),
        promptDigest: prompts.videos[id].digest
      };
    })
  ];
  const projectedUnits = rawStages.reduce((sum, stage) => sum + stage.costUnits, 0n);
  if (providerBudgetPlan.baselineCostCny !== formatDecimalUnits(projectedUnits) ||
      canonicalJson(providerBudgetPlan.callOrder) !== canonicalJson(STAGE_IDS)) {
    fail("invalid_budget_plan", "Provider budget plan and canary stage plan disagree");
  }
  if (projectedUnits > priceCard.budgetUnits) {
    fail(
      "budget_exceeded",
      `Projected CNY ${formatDecimalUnits(projectedUnits)} exceeds the fixed CNY ${priceCard.budgetCny} budget`
    );
  }
  const bufferedProjectedUnits = (projectedUnits * (100n + CONTINGENCY_PERCENT)) / 100n;
  const safetyThresholdUnits = (priceCard.budgetUnits * BUDGET_SAFETY_PERCENT) / 100n;
  if (bufferedProjectedUnits > safetyThresholdUnits) {
    fail(
      "budget_safety_threshold_exceeded",
      `Projected cost plus ${CONTINGENCY_PERCENT}% contingency is CNY ${formatDecimalUnits(bufferedProjectedUnits)}, above the CNY ${formatDecimalUnits(safetyThresholdUnits)} safety threshold`
    );
  }
  if (!providerBudgetPlan.withinCallableSpendCap || !providerBudgetPlan.withinHardBudgetWith20PercentContingency) {
    fail("budget_safety_threshold_exceeded", "Provider budget plan is outside the controlled canary safety limits");
  }
  const planMaterial = {
    contractVersion: CONTRACT_VERSION,
    outputRoot,
    petType: petType.id,
    inputs: inputs.map(({ role, path: inputPath, byteSize, sha256: digest }) => ({ role, path: inputPath, byteSize, sha256: digest })),
    model,
    priceCard: {
      version: priceCard.version,
      sourceReference: priceCard.sourceReference,
      currency: priceCard.currency,
      budgetCny: priceCard.budgetCny,
      frontImageCny: priceCard.prices.front.value,
      sideImageCny: priceCard.prices.side.value,
      sleepImageCny: priceCard.prices.sleep.value,
      videoSecondCny: priceCard.prices.videoSecond.value,
      tokenMillionCny: priceCard.tokenMillion?.value || null,
      tokenCostAccounting: priceCard.tokenMillion
        ? "observed_usage_only_not_added_to_preflight_reservation"
        : "disabled"
    },
    promptFile: path.relative(PROJECT_ROOT, PROMPT_FILE).split(path.sep).join("/"),
    promptBundleHash: prompts.bundleHash,
    projectedCostCny: formatDecimalUnits(projectedUnits),
    contingencyPercent: String(CONTINGENCY_PERCENT),
    bufferedProjectedCostCny: formatDecimalUnits(bufferedProjectedUnits),
    budgetSafetyThresholdCny: formatDecimalUnits(safetyThresholdUnits),
    providerBudgetPlan,
    executionPolicy: {
      explicitExecuteRequired: true,
      defaultMaximumStagesPerInvocation: 1,
      explicitThroughRequiredForMultipleStages: true,
      noAutomaticPostResubmission: true,
      unknownSubmissionDisposition: "reconciliation_required",
      stageOrder: STAGE_IDS,
      representativeVideoGate: REPRESENTATIVE_VIDEO_IDS,
      remainingVideoGate: REMAINING_VIDEO_IDS,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      maxPollsPerVideo: DEFAULT_MAX_POLLS
    },
    stages: rawStages.map(({ costUnits, ...stage }) => stage)
  };
  const planHash = sha256(canonicalJson(planMaterial));
  const stages = planMaterial.stages.map((stage) => ({
    ...stage,
    requestId: stageRequestId(planHash, stage.id)
  }));
  const plan = Object.freeze({
    ...planMaterial,
    planHash,
    stages
  });
  return Object.freeze({ plan, prompts });
}

function stateFilePaths(outputRoot) {
  return Object.freeze({
    plan: path.join(outputRoot, "plan.json"),
    state: path.join(outputRoot, "state.json"),
    audit: path.join(outputRoot, "audit.json"),
    artifacts: path.join(outputRoot, "artifacts")
  });
}

async function atomicWriteFile(filePath, bytes) {
  const parent = path.dirname(filePath);
  await assertNoLinksBelow(CONTROLLED_ROOT, parent);
  const parentStat = await fsp.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail("unsafe_path", "Atomic write parent is unsafe");
  const existing = await lstatIfExists(filePath);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail("unsafe_path", "Atomic write target is unsafe");
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle = null;
  let created = false;
  try {
    handle = await fsp.open(temporaryPath, "wx", 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporaryPath, filePath);
    created = false;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (created) await fsp.unlink(temporaryPath).catch(() => undefined);
  }
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function readJsonFile(filePath, label) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("unsafe_state", `${label} must be a regular non-symbolic file`);
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (cause) {
    fail("invalid_state", `${label} is invalid JSON`, { cause });
  }
}

function auditEntryHash(entry) {
  const { hash, ...unsigned } = entry;
  return sha256(canonicalJson(unsigned));
}

function appendAudit(state, event, now) {
  const previousHash = state.audit.length ? state.audit[state.audit.length - 1].hash : null;
  const entry = {
    sequence: state.audit.length + 1,
    timestamp: new Date(now()).toISOString(),
    previousHash,
    ...event
  };
  entry.hash = auditEntryHash(entry);
  state.audit.push(entry);
  state.lastAuditHash = entry.hash;
  state.updatedAt = entry.timestamp;
  return entry;
}

function verifyAudit(audit) {
  if (!Array.isArray(audit) || audit.length < 1) fail("invalid_state", "Canary audit is missing");
  let previousHash = null;
  for (let index = 0; index < audit.length; index += 1) {
    const entry = audit[index];
    if (!entry || entry.sequence !== index + 1 || entry.previousHash !== previousHash || entry.hash !== auditEntryHash(entry)) {
      fail("invalid_state", "Canary audit hash chain is invalid");
    }
    previousHash = entry.hash;
  }
  return previousHash;
}

async function persistState(paths, state) {
  verifyAudit(state.audit);
  if (state.lastAuditHash !== state.audit[state.audit.length - 1].hash) fail("invalid_state", "Canary audit head is inconsistent");
  // The state contains the canonical audit. The standalone audit snapshot is
  // written before any external POST; a crash between the two writes remains
  // conservative because a prepared state is never automatically resubmitted.
  await atomicWriteJson(paths.state, state);
  await atomicWriteJson(paths.audit, {
    contractVersion: CONTRACT_VERSION,
    planHash: state.planHash,
    lastAuditHash: state.lastAuditHash,
    entries: state.audit
  });
}

function createInitialState(plan, now) {
  const timestamp = new Date(now()).toISOString();
  const state = {
    contractVersion: CONTRACT_VERSION,
    planHash: plan.planHash,
    runStatus: "planned",
    committedCostCny: "0",
    completedStages: [],
    stages: Object.fromEntries(plan.stages.map((stage) => [stage.id, {
      id: stage.id,
      status: "planned",
      requestId: stage.requestId,
      pollCount: 0
    }])),
    createdAt: timestamp,
    updatedAt: timestamp,
    lastAuditHash: null,
    audit: []
  };
  appendAudit(state, {
    type: "plan_persisted",
    projectedCostCny: plan.projectedCostCny,
    budgetCny: plan.priceCard.budgetCny
  }, now);
  return state;
}

function stageById(plan, id) {
  const stage = plan.stages.find((item) => item.id === id);
  if (!stage) fail("invalid_plan", `Plan stage is missing: ${id}`);
  return stage;
}

function parseStateCost(value) {
  return parseDecimal(requiredString(value, "committedCostCny", 64), {
    label: "Committed canary cost"
  });
}

async function verifyInputSnapshot(plan) {
  for (const expected of plan.inputs) {
    const current = await inspectJpeg(expected.path, expected.role);
    if (current.sha256 !== expected.sha256 || current.byteSize !== expected.byteSize) {
      fail("input_changed", `${expected.role} JPEG changed after the plan was created`);
    }
  }
}

async function loadExistingRun(paths, expectedPlan) {
  const [storedPlan, state, auditSnapshot] = await Promise.all([
    readJsonFile(paths.plan, "Canary plan"),
    readJsonFile(paths.state, "Canary state"),
    readJsonFile(paths.audit, "Canary audit")
  ]);
  if (storedPlan.planHash !== expectedPlan.planHash || canonicalJson(storedPlan) !== canonicalJson(expectedPlan)) {
    fail("plan_mismatch", "Existing canary plan does not match the supplied immutable inputs and prices");
  }
  if (state.contractVersion !== CONTRACT_VERSION || state.planHash !== storedPlan.planHash) {
    fail("invalid_state", "Canary state is bound to a different plan");
  }
  const lastAuditHash = verifyAudit(state.audit);
  if (state.lastAuditHash !== lastAuditHash || auditSnapshot.planHash !== state.planHash ||
      auditSnapshot.lastAuditHash !== lastAuditHash || canonicalJson(auditSnapshot.entries) !== canonicalJson(state.audit)) {
    fail("invalid_state", "Canary state and audit snapshot do not match");
  }
  const completed = state.completedStages || [];
  if (!Array.isArray(completed) || completed.some((id, index) => id !== STAGE_IDS[index])) {
    fail("invalid_state", "Completed canary stages are out of order");
  }
  return { plan: storedPlan, state };
}

function contentTypeExtension(contentType, stageType) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  const extensions = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm"
  };
  const extension = extensions[normalized];
  if (!extension || (stageType === "image" && !normalized.startsWith("image/")) ||
      (stageType === "video" && !normalized.startsWith("video/"))) {
    fail("invalid_provider_artifact", `Provider returned an unsupported ${stageType} content type`);
  }
  return { contentType: normalized, extension };
}

function decodeDataUrl(url) {
  const match = typeof url === "string" && url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  return { contentType: match[1].toLowerCase(), bytes: Buffer.from(match[2], "base64") };
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      octets[0] >= 224;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
  }
  return true;
}

async function defaultArtifactFetcher(url, { maximumBytes = 320 * 1024 * 1024, allowedHosts = [] } = {}) {
  const data = decodeDataUrl(url);
  if (data) {
    if (data.bytes.length < 1 || data.bytes.length > maximumBytes) fail("invalid_provider_artifact", "Provider artifact size is invalid");
    return data;
  }
  let parsed;
  try {
    parsed = new URL(requiredString(url, "Provider artifact URL", 8192));
  } catch {
    fail("invalid_provider_artifact", "Provider artifact URL is invalid");
  }
  if (parsed.protocol !== "https:") fail("invalid_provider_artifact", "Provider artifacts must use HTTPS");
  if (parsed.username || parsed.password || parsed.port) fail("invalid_provider_artifact", "Provider artifact authority is invalid");
  const hostname = parsed.hostname.toLowerCase();
  if (!Array.isArray(allowedHosts) || !allowedHosts.includes(hostname)) {
    fail("invalid_provider_artifact", "Provider artifact host is not in the reviewed allowlist");
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    fail("invalid_provider_artifact", "Provider artifact host DNS lookup failed");
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    fail("invalid_provider_artifact", "Provider artifact host resolved to a forbidden address");
  }
  const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) fail("provider_artifact_download_failed", `Provider artifact download failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    fail("invalid_provider_artifact", "Provider artifact exceeds the canary byte limit");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > maximumBytes) fail("invalid_provider_artifact", "Provider artifact size is invalid");
  return { contentType: response.headers.get("content-type") || "application/octet-stream", bytes };
}

async function persistArtifact(paths, stage, fetched) {
  const type = contentTypeExtension(fetched.contentType, stage.type);
  const digest = sha256(fetched.bytes);
  const relativePath = path.join("artifacts", `${String(STAGE_IDS.indexOf(stage.id) + 1).padStart(2, "0")}-${stage.id}.${type.extension}`);
  const filePath = path.join(path.dirname(paths.plan), relativePath);
  if (!isStrictDescendant(path.dirname(paths.plan), filePath)) fail("unsafe_path", "Artifact path escaped outputRoot");
  await atomicWriteFile(filePath, fetched.bytes);
  return {
    relativePath: relativePath.split(path.sep).join("/"),
    contentType: type.contentType,
    byteSize: fetched.bytes.length,
    sha256: digest
  };
}

async function readArtifactAsDataUrl(outputRoot, artifact) {
  const filePath = path.resolve(outputRoot, artifact.relativePath);
  if (!isStrictDescendant(outputRoot, filePath)) fail("unsafe_state", "Artifact reference escapes outputRoot");
  await assertNoLinksBelow(outputRoot, filePath);
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.byteSize) fail("invalid_state", "Stored master artifact is invalid");
  const bytes = await fsp.readFile(filePath);
  if (sha256(bytes) !== artifact.sha256) fail("invalid_state", "Stored master artifact checksum changed");
  return `data:${artifact.contentType};base64,${bytes.toString("base64")}`;
}

function normalizeExpectedSha256(value) {
  const normalized = requiredString(value, "Normalized master SHA-256", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    fail("invalid_normalized_master_hash", "Normalized master SHA-256 must contain exactly 64 hexadecimal characters");
  }
  return normalized;
}

function inspectPngBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.length > MAX_NORMALIZED_MASTER_BYTES) {
    fail("invalid_normalized_master_png", "Normalized master PNG byte size is invalid");
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail("invalid_normalized_master_png", "Normalized master must have a valid PNG signature");
  }
  let offset = 8;
  let chunkIndex = 0;
  let width = null;
  let height = null;
  let sawIend = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail("invalid_normalized_master_png", "Normalized master PNG chunk is truncated");
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + chunkLength;
    if (chunkEnd > bytes.length) fail("invalid_normalized_master_png", "Normalized master PNG chunk length is invalid");
    if (chunkIndex === 0) {
      if (chunkType !== "IHDR" || chunkLength !== 13) {
        fail("invalid_normalized_master_png", "Normalized master PNG must begin with a 13-byte IHDR chunk");
      }
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
    } else if (chunkType === "IHDR") {
      fail("invalid_normalized_master_png", "Normalized master PNG contains more than one IHDR chunk");
    }
    if (chunkType === "IEND") {
      if (chunkLength !== 0 || chunkEnd !== bytes.length) {
        fail("invalid_normalized_master_png", "Normalized master PNG IEND chunk is invalid");
      }
      sawIend = true;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (!sawIend) fail("invalid_normalized_master_png", "Normalized master PNG is missing its terminal IEND chunk");
  if (width !== CHARACTER_CANVAS_V1.width || height !== CHARACTER_CANVAS_V1.height) {
    fail(
      "invalid_normalized_master_dimensions",
      `Normalized master PNG must be exactly ${CHARACTER_CANVAS_V1.width}x${CHARACTER_CANVAS_V1.height}`
    );
  }
  return { width, height };
}

async function inspectNormalizedMasterFile({ outputRoot, artifactsRoot, artifactPath, expectedSha256 }) {
  const rawPath = requiredString(artifactPath, "Normalized master artifactPath", 2048);
  if (!path.isAbsolute(rawPath)) fail("unsafe_normalized_master_path", "Normalized master artifactPath must be absolute");
  const resolved = path.resolve(rawPath);
  assertNotForbiddenDrive(resolved, "Normalized master artifactPath");
  if (!isStrictDescendant(artifactsRoot, resolved)) {
    fail("unsafe_normalized_master_path", "Normalized master must be a strict child of the run artifacts directory");
  }
  if (path.extname(resolved).toLowerCase() !== ".png") {
    fail("invalid_normalized_master_png", "Normalized master must use a .png extension");
  }
  await assertNoLinksBelow(outputRoot, resolved);
  const before = await fsp.lstat(resolved);
  if (!before.isFile() || before.isSymbolicLink()) {
    fail("unsafe_normalized_master_path", "Normalized master must be a regular non-symbolic file");
  }
  if (!Number.isSafeInteger(before.size) || before.size < 45 || before.size > MAX_NORMALIZED_MASTER_BYTES) {
    fail("invalid_normalized_master_png", "Normalized master PNG byte size is invalid");
  }
  const bytes = await fsp.readFile(resolved);
  const after = await fsp.lstat(resolved);
  if (!after.isFile() || after.isSymbolicLink() || bytes.length !== before.size || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs) {
    fail("normalized_master_changed", "Normalized master changed while it was being inspected");
  }
  const dimensions = inspectPngBytes(bytes);
  const digest = sha256(bytes);
  if (digest !== expectedSha256) {
    fail("normalized_master_hash_mismatch", "Normalized master content does not match the supplied SHA-256");
  }
  const relativePath = path.relative(outputRoot, resolved).split(path.sep).join("/");
  return {
    relativePath,
    contentType: "image/png",
    byteSize: bytes.length,
    sha256: digest,
    width: dimensions.width,
    height: dimensions.height,
    canvasId: CHARACTER_CANVAS_V1.id
  };
}

async function loadRunForNormalizedRegistration(paths) {
  const [plan, state, auditSnapshot] = await Promise.all([
    readJsonFile(paths.plan, "Canary plan"),
    readJsonFile(paths.state, "Canary state"),
    readJsonFile(paths.audit, "Canary audit")
  ]);
  if (plan.contractVersion !== CONTRACT_VERSION || state.contractVersion !== CONTRACT_VERSION ||
      typeof plan.planHash !== "string" || state.planHash !== plan.planHash) {
    fail("invalid_state", "Canary plan and state are not bound to the same contract");
  }
  const lastAuditHash = verifyAudit(state.audit);
  if (state.lastAuditHash !== lastAuditHash || auditSnapshot.planHash !== state.planHash ||
      auditSnapshot.lastAuditHash !== lastAuditHash || canonicalJson(auditSnapshot.entries) !== canonicalJson(state.audit)) {
    fail("invalid_state", "Canary state and audit snapshot do not match");
  }
  return { plan, state };
}

async function registerNormalizedMasterArtifact({ outputRoot, kind, artifactPath, sha256: expectedHash } = {}, dependencies = {}) {
  const now = dependencies.now || Date.now;
  if (typeof now !== "function") fail("invalid_dependency", "Normalized master registration clock is invalid");
  const safeOutputRoot = normalizeOutputRoot(outputRoot);
  await assertNoLinksBelow(CONTROLLED_ROOT, safeOutputRoot);
  const outputStat = await fsp.lstat(safeOutputRoot);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) fail("unsafe_output_root", "Canary outputRoot is not a real directory");
  const normalizedKind = requiredString(kind, "Normalized master kind", 16).toLowerCase();
  if (!IMAGE_STAGE_IDS.includes(normalizedKind)) {
    fail("invalid_normalized_master_kind", `Normalized master kind must be one of: ${IMAGE_STAGE_IDS.join(", ")}`);
  }
  const expectedSha256 = normalizeExpectedSha256(expectedHash);
  const paths = stateFilePaths(safeOutputRoot);
  await assertNoLinksBelow(safeOutputRoot, paths.artifacts);
  const artifactRootStat = await fsp.lstat(paths.artifacts);
  if (!artifactRootStat.isDirectory() || artifactRootStat.isSymbolicLink()) {
    fail("unsafe_normalized_master_path", "Canary artifacts directory is not a real directory");
  }
  const { state } = await loadRunForNormalizedRegistration(paths);
  const stage = state.stages[normalizedKind];
  if (!stage || stage.status !== "completed" || !stage.artifact) {
    fail("normalized_master_not_ready", `${normalizedKind} provider master must be completed before registering a normalized artifact`);
  }
  await readArtifactAsDataUrl(safeOutputRoot, stage.artifact);
  const inspected = await inspectNormalizedMasterFile({
    outputRoot: safeOutputRoot,
    artifactsRoot: paths.artifacts,
    artifactPath,
    expectedSha256
  });
  if (stage.normalizedArtifact) {
    if (canonicalJson(stage.normalizedArtifact) !== canonicalJson(inspected)) {
      const samePath = stage.normalizedArtifact.relativePath === inspected.relativePath;
      fail(
        samePath ? "normalized_master_changed" : "normalized_master_conflict",
        samePath
          ? `${normalizedKind} normalized master changed after registration`
          : `${normalizedKind} already has a different normalized master registered`
      );
    }
    return Object.freeze({ kind: normalizedKind, artifact: stage.normalizedArtifact, idempotent: true });
  }
  if (stage.artifact.relativePath === inspected.relativePath) {
    fail("normalized_master_conflict", "Normalized master must not overwrite or alias the archived provider artifact");
  }
  const kindIndex = STAGE_IDS.indexOf(normalizedKind);
  const startedDependent = STAGE_IDS.slice(kindIndex + 1).find((id) => state.stages[id]?.status !== "planned");
  if (startedDependent) {
    fail("normalized_master_registration_too_late", `Cannot register ${normalizedKind} after dependent stage ${startedDependent} has started`);
  }
  stage.normalizedArtifact = inspected;
  appendAudit(state, {
    type: "normalized_master_registered",
    stageId: normalizedKind,
    relativePath: inspected.relativePath,
    sha256: inspected.sha256,
    byteSize: inspected.byteSize,
    width: inspected.width,
    height: inspected.height,
    canvasId: inspected.canvasId,
    providerArtifactSha256: stage.artifact.sha256
  }, now);
  await persistState(paths, state);
  return Object.freeze({ kind: normalizedKind, artifact: inspected, idempotent: false });
}

async function sourcePhotoReferences(plan) {
  return Promise.all(plan.inputs.map(async (input) => {
    const bytes = await fsp.readFile(input.path);
    if (bytes.length !== input.byteSize || sha256(bytes) !== input.sha256) fail("input_changed", `${input.role} JPEG changed during execution`);
    return {
      objectKey: `controlled-canary/source/${input.role}-${input.sha256.slice(0, 16)}.jpg`,
      signedReadUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`
    };
  }));
}

async function masterReference(outputRoot, state, kind) {
  const completed = state.stages[kind];
  if (!completed || completed.status !== "completed" || !completed.artifact) {
    fail("invalid_state", `${kind} master is not complete`);
  }
  const selectedArtifact = completed.normalizedArtifact || completed.artifact;
  return {
    objectKey: `controlled-canary/master/${kind}-${selectedArtifact.sha256.slice(0, 16)}`,
    signedReadUrl: await readArtifactAsDataUrl(outputRoot, selectedArtifact),
    canvasId: CHARACTER_CANVAS_V1.id
  };
}

function providerModelReference(plan, type) {
  return {
    registryVersion: plan.model.registryVersion,
    region: plan.model.region,
    endpointId: type === "image" ? plan.model.seedreamEndpointId : plan.model.seedanceEndpointId,
    ...(type === "video" ? { resolution: plan.model.videoResolution } : {})
  };
}

async function prepareSubmission({ plan, state, paths, stage, now }) {
  const committed = parseStateCost(state.committedCostCny);
  const stageCost = parseDecimal(stage.costCny, { label: `${stage.id} planned cost` });
  const budget = parseDecimal(plan.priceCard.budgetCny, { label: "Canary budget", allowZero: false });
  const nextUnits = committed.units + stageCost.units;
  if (nextUnits > budget.units) fail("budget_exceeded", "Canary committed cost would exceed its fixed budget");
  const current = state.stages[stage.id];
  if (!current || current.status !== "planned") fail("invalid_state", `${stage.id} is not ready for submission`);
  const budgetDecision = assertNextModelArkCanaryCallAllowed({
    plan: plan.providerBudgetPlan,
    completedCallIds: state.completedStages,
    confirmedSpend: { currency: "CNY", amountCny: state.committedCostCny },
    actualTokensByCallId: {},
    unpricedAttemptCount: 0,
    requestedCallId: stage.id
  });
  current.status = "submission_prepared";
  current.submissionOutcome = "unknown";
  current.preparedAt = new Date(now()).toISOString();
  current.preCallBudgetDecision = {
    code: budgetDecision.code,
    projectedCompletedWorkflowCostCny: budgetDecision.projectedCompletedWorkflowCostCny,
    projectedHeadroomCny: budgetDecision.projectedHeadroomCny,
    callableSpendCapCny: budgetDecision.callableSpendCapCny
  };
  state.runStatus = "executing";
  state.committedCostCny = formatDecimalUnits(nextUnits);
  appendAudit(state, {
    type: "before_provider_post",
    stageId: stage.id,
    requestId: stage.requestId,
    reservedCostCny: stage.costCny,
    committedCostCny: state.committedCostCny,
    projectedCompletedWorkflowCostCny: budgetDecision.projectedCompletedWorkflowCostCny,
    callableSpendCapCny: budgetDecision.callableSpendCapCny
  }, now);
  await persistState(paths, state);
}

async function markReconciliation({ state, paths, stage, code, now }) {
  const current = state.stages[stage.id];
  current.status = "reconciliation_required";
  current.errorCode = code;
  current.submissionOutcome = "unknown";
  state.runStatus = "reconciliation_required";
  appendAudit(state, {
    type: "submission_reconciliation_required",
    stageId: stage.id,
    requestId: stage.requestId,
    errorCode: code
  }, now);
  await persistState(paths, state);
}

async function markRejected({ state, paths, stage, code, now }) {
  const current = state.stages[stage.id];
  current.status = "rejected";
  current.errorCode = code;
  current.submissionOutcome = "rejected";
  state.runStatus = "stopped";
  appendAudit(state, {
    type: "submission_rejected_no_resubmit",
    stageId: stage.id,
    requestId: stage.requestId,
    errorCode: code
  }, now);
  await persistState(paths, state);
}

function safeErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(error.code)
    ? error.code.toLowerCase()
    : fallback;
}

function safeProviderIdentifier(value, label, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) fail("invalid_provider_response", `${label} is missing`);
    return null;
  }
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(normalized)) {
    fail("invalid_provider_response", `${label} is not a safe opaque identifier`);
  }
  return normalized;
}

function safeTokenInteger(value, label) {
  const normalized = typeof value === "string" && /^[0-9]+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail("invalid_provider_usage", `${label} must be a safe non-negative integer`);
  }
  return normalized;
}

function extractSafeProviderUsage(task) {
  const usage = task?.raw?.usage || task?.raw?.data?.usage;
  if (usage === undefined || usage === null) return null;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    fail("invalid_provider_usage", "ModelArk usage must be an object");
  }
  const inputValue = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens;
  const outputValue = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens;
  const totalValue = usage.total_tokens ?? usage.totalTokens;
  if (inputValue === undefined && outputValue === undefined && totalValue === undefined) return null;
  const inputTokens = inputValue === undefined ? 0 : safeTokenInteger(inputValue, "ModelArk input tokens");
  const outputTokens = outputValue === undefined ? 0 : safeTokenInteger(outputValue, "ModelArk output tokens");
  const totalTokens = safeTokenInteger(usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens, "ModelArk total tokens");
  if (totalTokens < inputTokens || totalTokens < outputTokens) {
    fail("invalid_provider_usage", "ModelArk total tokens are inconsistent");
  }
  return { inputTokens, outputTokens, totalTokens };
}

function observedTokenCost(totalTokens, tokenMillionCny) {
  if (!tokenMillionCny) return null;
  const rate = parseDecimal(tokenMillionCny, { label: "Observed token price", allowZero: false });
  const numerator = BigInt(totalTokens) * rate.units;
  const wholeUnits = numerator / 1_000_000n;
  return formatDecimalUnits(numerator % 1_000_000n === 0n ? wholeUnits : wholeUnits + 1n);
}

async function persistSuccessfulQueryUsage({ plan, state, paths, stage, task, now }) {
  let usage;
  try {
    usage = extractSafeProviderUsage(task);
  } catch (error) {
    appendAudit(state, {
      type: "provider_usage_ignored",
      stageId: stage.id,
      pollCount: state.stages[stage.id].pollCount,
      errorCode: safeErrorCode(error, "invalid_provider_usage")
    }, now);
    await persistState(paths, state);
    return null;
  }
  if (!usage) return null;
  const observation = {
    pollCount: state.stages[stage.id].pollCount,
    ...usage,
    observedTokenCostCny: observedTokenCost(usage.totalTokens, plan.priceCard.tokenMillionCny)
  };
  const current = state.stages[stage.id];
  if (!Array.isArray(current.usageObservations)) current.usageObservations = [];
  current.usageObservations.push(observation);
  current.latestUsage = observation;
  appendAudit(state, {
    type: "provider_usage_observed",
    stageId: stage.id,
    pollCount: observation.pollCount,
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    totalTokens: observation.totalTokens,
    observedTokenCostCny: observation.observedTokenCostCny
  }, now);
  await persistState(paths, state);
  return observation;
}

function persistFinalUsageSummary(plan, state, current, observation) {
  if (observation) current.finalUsage = observation;
  const completedUsage = VIDEO_STAGE_IDS
    .map((id) => state.stages[id]?.finalUsage)
    .filter(Boolean);
  state.observedVideoUsage = {
    inputTokens: completedUsage.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: completedUsage.reduce((sum, item) => sum + item.outputTokens, 0),
    totalTokens: completedUsage.reduce((sum, item) => sum + item.totalTokens, 0),
    observedTokenCostCny: plan.priceCard.tokenMillionCny
      ? completedUsage.reduce((sum, item) => sum + parseDecimal(item.observedTokenCostCny, { label: "Observed token cost" }).units, 0n)
      : null
  };
  if (typeof state.observedVideoUsage.observedTokenCostCny === "bigint") {
    state.observedVideoUsage.observedTokenCostCny = formatDecimalUnits(state.observedVideoUsage.observedTokenCostCny);
  }
}

async function submitImage({ plan, prompts, state, paths, stage, modelArkClient, artifactFetcher, hooks, now }) {
  await prepareSubmission({ plan, state, paths, stage, now });
  if (hooks?.afterPreparedBeforePost) await hooks.afterPreparedBeforePost({ stage, state });
  let created;
  try {
    const serverPrompt = formatServerOnlyImageInstruction({
      kind: stage.id,
      prompt: prompts.images[stage.id].prompt,
      negativePrompt: prompts.images[stage.id].negativePrompt
    });
    if (stage.id === "front") {
      created = await modelArkClient.createFrontMaster({
        requestId: stage.requestId,
        serverPrompt,
        sourcePhotos: await sourcePhotoReferences(plan),
        modelReference: providerModelReference(plan, "image"),
        outputSize: plan.model.seedreamOutputSize,
        allowDataUrls: true
      });
    } else if (stage.id === "side") {
      created = await modelArkClient.createSideMaster({
        requestId: stage.requestId,
        serverPrompt,
        sourcePhotos: await sourcePhotoReferences(plan),
        frontMaster: await masterReference(plan.outputRoot, state, "front"),
        modelReference: providerModelReference(plan, "image"),
        outputSize: plan.model.seedreamOutputSize,
        allowDataUrls: true
      });
    } else {
      created = await modelArkClient.createSleepingMaster({
        requestId: stage.requestId,
        serverPrompt,
        frontMaster: await masterReference(plan.outputRoot, state, "front"),
        sideMaster: await masterReference(plan.outputRoot, state, "side"),
        modelReference: providerModelReference(plan, "image"),
        outputSize: plan.model.seedreamOutputSize,
        allowDataUrls: true
      });
    }
  } catch (error) {
    const code = safeErrorCode(error, "modelark_submission_unknown");
    if (error?.providerSubmissionOutcome === "rejected") {
      await markRejected({ state, paths, stage, code, now });
      throw new ControlledCanaryError("submission_rejected", `${stage.id} submission was explicitly rejected; automatic resubmission is disabled`, { cause: error });
    }
    await markReconciliation({ state, paths, stage, code, now });
    throw new ControlledCanaryError("reconciliation_required", `${stage.id} submission outcome is unknown`, { cause: error });
  }
  if (!Array.isArray(created?.outputUrls) || created.outputUrls.length !== 1) {
    await markReconciliation({ state, paths, stage, code: "provider_output_ambiguous", now });
    fail("reconciliation_required", `${stage.id} provider output is ambiguous`);
  }
  const current = state.stages[stage.id];
  current.status = "provider_succeeded";
  current.submissionOutcome = "accepted";
  try {
    current.providerRequestId = safeProviderIdentifier(created.providerRequestId, "Seedream provider request ID");
  } catch (error) {
    await markReconciliation({ state, paths, stage, code: safeErrorCode(error, "invalid_provider_request_id"), now });
    throw error;
  }
  appendAudit(state, { type: "provider_post_succeeded", stageId: stage.id, requestId: stage.requestId }, now);
  await persistState(paths, state);
  return completeArtifact({
    state,
    paths,
    stage,
    artifactFetcher,
    providerOutputUrl: created.outputUrls[0],
    now
  });
}

async function completeArtifact({ state, paths, stage, artifactFetcher, providerOutputUrl, now }) {
  const current = state.stages[stage.id];
  if (current.status !== "provider_succeeded") {
    fail("invalid_state", `${stage.id} has no provider artifact ready`);
  }
  if (!providerOutputUrl) {
    await markReconciliation({ state, paths, stage, code: "artifact_url_not_persisted", now });
    fail("reconciliation_required", `${stage.id} artifact URL was intentionally not persisted; reconcile without resubmitting`);
  }
  let fetched;
  try {
    fetched = await artifactFetcher(providerOutputUrl, { stageId: stage.id, stageType: stage.type });
  } catch (error) {
    await markReconciliation({ state, paths, stage, code: safeErrorCode(error, "artifact_fetch_failed"), now });
    throw new ControlledCanaryError("reconciliation_required", `${stage.id} artifact fetch failed after provider success`, { cause: error });
  }
  const artifact = await persistArtifact(paths, stage, fetched);
  current.artifact = artifact;
  current.status = "completed";
  current.completedAt = new Date(now()).toISOString();
  if (!state.completedStages.includes(stage.id)) state.completedStages.push(stage.id);
  appendAudit(state, {
    type: "stage_completed",
    stageId: stage.id,
    artifactSha256: artifact.sha256,
    artifactByteSize: artifact.byteSize
  }, now);
  await persistState(paths, state);
  return artifact;
}

async function submitVideo({ plan, prompts, state, paths, stage, modelArkClient, artifactFetcher, hooks, sleep, now }) {
  await prepareSubmission({ plan, state, paths, stage, now });
  if (hooks?.afterPreparedBeforePost) await hooks.afterPreparedBeforePost({ stage, state });
  let created;
  try {
    created = await createVideoTaskForStage({ plan, prompts, state, stage, modelArkClient });
  } catch (error) {
    const code = safeErrorCode(error, "modelark_submission_unknown");
    if (error?.providerSubmissionOutcome === "rejected") {
      await markRejected({ state, paths, stage, code, now });
      throw new ControlledCanaryError("submission_rejected", `${stage.id} submission was explicitly rejected; automatic resubmission is disabled`, { cause: error });
    }
    await markReconciliation({ state, paths, stage, code, now });
    throw new ControlledCanaryError("reconciliation_required", `${stage.id} submission outcome is unknown`, { cause: error });
  }
  if (typeof created?.providerTaskId !== "string" || !created.providerTaskId.trim()) {
    await markReconciliation({ state, paths, stage, code: "provider_task_id_missing", now });
    fail("reconciliation_required", `${stage.id} provider task ID is missing`);
  }
  const current = state.stages[stage.id];
  current.status = "submitted";
  current.submissionOutcome = "accepted";
  try {
    current.providerTaskId = safeProviderIdentifier(created.providerTaskId, "Seedance provider task ID", { required: true });
  } catch (error) {
    await markReconciliation({ state, paths, stage, code: safeErrorCode(error, "invalid_provider_task_id"), now });
    throw error;
  }
  appendAudit(state, { type: "provider_post_succeeded", stageId: stage.id, requestId: stage.requestId }, now);
  await persistState(paths, state);
  return pollVideo({ plan, state, paths, stage, modelArkClient, artifactFetcher, sleep, now });
}

async function createVideoTaskForStage({ plan, prompts, state, stage, modelArkClient }) {
  return modelArkClient.createVideoTask({
    requestId: stage.requestId,
    runId: plan.planHash,
    actionId: stage.actionId,
    promptVersion: {
      id: `canary-${stage.actionId}`,
      version: plan.promptBundleHash,
      status: "published",
      frozenForRun: true,
      prompt: prompts.videos[stage.actionId].prompt,
      negativePrompt: prompts.videos[stage.actionId].negativePrompt
    },
    firstFrame: await masterReference(plan.outputRoot, state, stage.firstMaster),
    lastFrame: await masterReference(plan.outputRoot, state, stage.lastMaster),
    duration: stage.duration,
    modelReference: providerModelReference(plan, "video"),
    allowDataUrls: true
  });
}

async function submitParallelVideoCohort({ plan, prompts, state, paths, modelArkClient, hooks, now }) {
  if (!modelArkClient || typeof modelArkClient.createVideoTask !== "function") {
    fail("missing_modelark_client", "Parallel video submission requires a ModelArk client");
  }
  if (!IMAGE_STAGE_IDS.every((id) => state.stages[id]?.status === "completed")) {
    fail("masters_not_ready", "All three normalized masters must be completed before parallel video submission");
  }
  const terminal = VIDEO_STAGE_IDS.find((id) => ["reconciliation_required", "rejected", "provider_failed"].includes(state.stages[id]?.status));
  if (terminal) fail("run_stopped", `${terminal} is terminal and the video cohort cannot be submitted`);

  const firstPlannedIndex = VIDEO_STAGE_IDS.findIndex((id) => state.stages[id]?.status === "planned");
  if (firstPlannedIndex < 0) return state;
  const plannedIds = VIDEO_STAGE_IDS.slice(firstPlannedIndex);
  if (plannedIds.some((id) => state.stages[id]?.status !== "planned") ||
      VIDEO_STAGE_IDS.slice(0, firstPlannedIndex).some((id) => state.stages[id]?.status === "planned")) {
    fail("sequence_violation", "Parallel video cohort must be the remaining contiguous planned suffix");
  }
  const stages = plannedIds.map((id) => stageById(plan, id));
  const committed = parseStateCost(state.committedCostCny);
  const reservedStageIds = STAGE_IDS.filter((id) => state.stages[id]?.status !== "planned");
  const expectedCommittedUnits = reservedStageIds.reduce((sum, id) => {
    const stage = stageById(plan, id);
    return sum + parseDecimal(stage.costCny, { label: `${id} planned cost` }).units;
  }, 0n);
  if (committed.units !== expectedCommittedUnits) {
    fail("invalid_state", "Committed canary cost does not match the already reserved stage prefix");
  }
  const cohortUnits = stages.reduce((sum, stage) => {
    return sum + parseDecimal(stage.costCny, { label: `${stage.id} planned cost` }).units;
  }, 0n);
  const projectedUnits = committed.units + cohortUnits;
  const budgetUnits = parseDecimal(plan.priceCard.budgetCny, { label: "Canary budget", allowZero: false }).units;
  const safetyThresholdUnits = parseDecimal(plan.budgetSafetyThresholdCny, { label: "Canary safety threshold", allowZero: false }).units;
  const bufferedUnits = parseDecimal(plan.bufferedProjectedCostCny, { label: "Buffered canary cost", allowZero: false }).units;
  const plannedTotalUnits = parseDecimal(plan.projectedCostCny, { label: "Projected canary cost", allowZero: false }).units;
  if (projectedUnits !== plannedTotalUnits || projectedUnits > budgetUnits || bufferedUnits > safetyThresholdUnits) {
    fail("budget_exceeded", "Parallel video cohort would violate the reviewed canary budget");
  }

  const timestamp = new Date(now()).toISOString();
  let runningCommittedUnits = committed.units;
  for (const stage of stages) {
    runningCommittedUnits += parseDecimal(stage.costCny, { label: `${stage.id} planned cost` }).units;
    const current = state.stages[stage.id];
    current.status = "submission_prepared";
    current.submissionOutcome = "unknown";
    current.preparedAt = timestamp;
    current.preCallBudgetDecision = {
      code: "parallel_video_cohort_allowed",
      projectedCompletedWorkflowCostCny: plan.projectedCostCny,
      projectedHeadroomCny: formatDecimalUnits(safetyThresholdUnits - bufferedUnits),
      callableSpendCapCny: plan.budgetSafetyThresholdCny
    };
    state.committedCostCny = formatDecimalUnits(runningCommittedUnits);
    appendAudit(state, {
      type: "before_provider_post",
      stageId: stage.id,
      requestId: stage.requestId,
      reservedCostCny: stage.costCny,
      committedCostCny: state.committedCostCny,
      projectedCompletedWorkflowCostCny: plan.projectedCostCny,
      callableSpendCapCny: plan.budgetSafetyThresholdCny,
      parallelVideoCohort: true
    }, now);
  }
  state.runStatus = "executing";
  appendAudit(state, { type: "parallel_video_cohort_prepared", stageIds: plannedIds }, now);
  await persistState(paths, state);
  if (hooks?.afterParallelVideoCohortPrepared) {
    await hooks.afterParallelVideoCohortPrepared({ stages, state });
  }

  const settled = await Promise.allSettled(stages.map((stage) =>
    createVideoTaskForStage({ plan, prompts, state, stage, modelArkClient })
  ));
  const accepted = [];
  const rejected = [];
  const reconciliation = [];
  for (let index = 0; index < settled.length; index += 1) {
    const stage = stages[index];
    const current = state.stages[stage.id];
    const result = settled[index];
    if (result.status === "fulfilled") {
      try {
        current.providerTaskId = safeProviderIdentifier(result.value?.providerTaskId, "Seedance provider task ID", { required: true });
        current.status = "submitted";
        current.submissionOutcome = "accepted";
        appendAudit(state, { type: "provider_post_succeeded", stageId: stage.id, requestId: stage.requestId }, now);
        accepted.push(stage.id);
        continue;
      } catch (error) {
        current.status = "reconciliation_required";
        current.errorCode = safeErrorCode(error, "invalid_provider_task_id");
        current.submissionOutcome = "unknown";
      }
    } else {
      const error = result.reason;
      const code = safeErrorCode(error, "modelark_submission_unknown");
      if (error?.providerSubmissionOutcome === "rejected") {
        current.status = "rejected";
        current.errorCode = code;
        current.submissionOutcome = "rejected";
        appendAudit(state, {
          type: "submission_rejected_no_resubmit",
          stageId: stage.id,
          requestId: stage.requestId,
          errorCode: code
        }, now);
        rejected.push(stage.id);
        continue;
      }
      current.status = "reconciliation_required";
      current.errorCode = code;
      current.submissionOutcome = "unknown";
    }
    appendAudit(state, {
      type: "submission_reconciliation_required",
      stageId: stage.id,
      requestId: stage.requestId,
      errorCode: current.errorCode
    }, now);
    reconciliation.push(stage.id);
  }
  state.runStatus = reconciliation.length > 0
    ? "reconciliation_required"
    : rejected.length > 0
      ? "stopped"
      : "executing";
  appendAudit(state, {
    type: "parallel_video_cohort_submitted",
    acceptedStageIds: accepted,
    rejectedStageIds: rejected,
    reconciliationStageIds: reconciliation
  }, now);
  await persistState(paths, state);
  if (reconciliation.length > 0) {
    fail("reconciliation_required", `Parallel video submissions require reconciliation: ${reconciliation.join(", ")}`);
  }
  if (rejected.length > 0) {
    fail("submission_rejected", `Parallel video submissions were explicitly rejected: ${rejected.join(", ")}`);
  }
  return state;
}

function classifyTaskStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (["queued", "pending", "running", "processing", "in_progress", "submitted"].includes(normalized)) return "pending";
  if (["succeeded", "success", "completed", "done"].includes(normalized)) return "succeeded";
  if (["failed", "error", "cancelled", "canceled", "expired"].includes(normalized)) return "failed";
  return "unknown";
}

async function pollVideo({ plan, state, paths, stage, modelArkClient, artifactFetcher, sleep, now }) {
  const current = state.stages[stage.id];
  if (!current.providerTaskId || !["submitted", "polling"].includes(current.status)) {
    fail("invalid_state", `${stage.id} is not ready for provider polling`);
  }
  while (current.pollCount < plan.executionPolicy.maxPollsPerVideo) {
    current.status = "polling";
    current.pollCount += 1;
    appendAudit(state, { type: "before_provider_get", stageId: stage.id, pollCount: current.pollCount }, now);
    await persistState(paths, state);
    let task;
    try {
      task = await modelArkClient.getVideoTask({
        requestId: `${stage.requestId}-poll-${current.pollCount}`,
        providerTaskId: current.providerTaskId
      });
    } catch (cause) {
      current.status = "submitted";
      current.lastPollErrorCode = safeErrorCode(cause, "modelark_poll_failed");
      appendAudit(state, {
        type: "provider_get_failed_resume_safe",
        stageId: stage.id,
        pollCount: current.pollCount,
        errorCode: current.lastPollErrorCode
      }, now);
      await persistState(paths, state);
      throw new ControlledCanaryError("poll_failed_resume_safe", `${stage.id} polling failed; resume will query the same task`, { cause });
    }
    const observation = await persistSuccessfulQueryUsage({ plan, state, paths, stage, task, now });
    const classification = classifyTaskStatus(task?.status);
    if (classification === "pending") {
      appendAudit(state, { type: "provider_task_pending", stageId: stage.id, pollCount: current.pollCount }, now);
      await persistState(paths, state);
      await sleep(plan.executionPolicy.pollIntervalMs);
      continue;
    }
    if (classification === "failed") {
      current.status = "provider_failed";
      current.errorCode = "modelark_task_failed";
      state.runStatus = "stopped";
      appendAudit(state, { type: "provider_task_failed", stageId: stage.id }, now);
      await persistState(paths, state);
      fail("provider_task_failed", `${stage.id} provider task failed; no replacement task will be submitted`);
    }
    if (classification === "unknown" || !Array.isArray(task?.outputUrls) || task.outputUrls.length !== 1) {
      await markReconciliation({
        state,
        paths,
        stage,
        code: classification === "unknown" ? "modelark_task_status_unknown" : "provider_output_ambiguous",
        now
      });
      fail("reconciliation_required", `${stage.id} provider task requires reconciliation`);
    }
    current.status = "provider_succeeded";
    persistFinalUsageSummary(plan, state, current, observation);
    appendAudit(state, { type: "provider_task_succeeded", stageId: stage.id, pollCount: current.pollCount }, now);
    await persistState(paths, state);
    return completeArtifact({
      state,
      paths,
      stage,
      artifactFetcher,
      providerOutputUrl: task.outputUrls[0],
      now
    });
  }
  await markReconciliation({ state, paths, stage, code: "modelark_poll_limit_reached", now });
  fail("reconciliation_required", `${stage.id} reached the bounded provider poll limit`);
}

async function reconcilePreparedStage({ state, paths, stage, now }) {
  await markReconciliation({ state, paths, stage, code: "resume_found_prepared_submission", now });
  fail("reconciliation_required", `${stage.id} may have been submitted before interruption; automatic POST replay is forbidden`);
}

function executionTargetIndex(plan, state, through) {
  const firstIncomplete = STAGE_IDS.findIndex((id) => state.stages[id]?.status !== "completed");
  if (firstIncomplete === -1) return STAGE_IDS.length - 1;
  if (through === undefined || through === null || through === "") return firstIncomplete;
  const normalized = requiredString(through, "--through", 64);
  const target = STAGE_IDS.indexOf(normalized);
  if (target < 0) fail("invalid_execution_boundary", `--through must be one of: ${STAGE_IDS.join(", ")}`);
  if (target < firstIncomplete) {
    fail("invalid_execution_boundary", `--through ${normalized} is before the first incomplete stage ${STAGE_IDS[firstIncomplete]}`);
  }
  return target;
}

async function executeStages({ plan, prompts, state, paths, modelArkClient, artifactFetcher, hooks, sleep, now, through }) {
  if (!modelArkClient) fail("missing_modelark_client", "Execution requires a ModelArk client");
  const targetIndex = executionTargetIndex(plan, state, through);
  for (let index = 0; index <= targetIndex; index += 1) {
    const stageId = STAGE_IDS[index];
    const stage = stageById(plan, stageId);
    const current = state.stages[stageId];
    if (!current) fail("invalid_state", `State stage is missing: ${stageId}`);
    if (current.status === "completed") continue;
    if (stage.type === "video" && current.status === "reconciliation_required" &&
        current.errorCode === "invalid_provider_usage" && current.providerTaskId) {
      current.status = "submitted";
      current.submissionOutcome = "accepted";
      delete current.errorCode;
      state.runStatus = "executing";
      appendAudit(state, {
        type: "non_authoritative_usage_error_cleared",
        stageId,
        providerTaskId: current.providerTaskId
      }, now);
      await persistState(paths, state);
    }
    if (current.status === "submission_prepared") {
      await reconcilePreparedStage({ state, paths, stage, now });
    }
    if (["reconciliation_required", "rejected", "provider_failed"].includes(current.status)) {
      fail(current.status === "reconciliation_required" ? "reconciliation_required" : "run_stopped", `${stageId} is terminal and cannot be automatically resubmitted`);
    }
    if (current.status === "provider_succeeded") {
      await completeArtifact({ state, paths, stage, artifactFetcher, now });
      continue;
    }
    if (stage.type === "video" && ["submitted", "polling"].includes(current.status)) {
      await pollVideo({ plan, state, paths, stage, modelArkClient, artifactFetcher, sleep, now });
      continue;
    }
    if (current.status !== "planned") fail("invalid_state", `${stageId} has an unsupported resumable state`);
    if (stage.type === "image") {
      await submitImage({ plan, prompts, state, paths, stage, modelArkClient, artifactFetcher, hooks, now });
    } else {
      await submitVideo({ plan, prompts, state, paths, stage, modelArkClient, artifactFetcher, hooks, sleep, now });
    }
  }
  const allCompleted = STAGE_IDS.every((id) => state.stages[id].status === "completed");
  state.runStatus = allCompleted ? "completed" : "awaiting_approval";
  appendAudit(state, allCompleted
    ? { type: "canary_completed", committedCostCny: state.committedCostCny }
    : {
      type: "execution_boundary_reached",
      throughStageId: STAGE_IDS[targetIndex],
      nextStageId: STAGE_IDS.find((id) => state.stages[id].status !== "completed") || null
    }, now);
  await persistState(paths, state);
  return state;
}

async function runControlledCanary(options = {}, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const injectedArtifactFetcher = dependencies.artifactFetcher;
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (typeof now !== "function" || (injectedArtifactFetcher && typeof injectedArtifactFetcher !== "function") || typeof sleep !== "function") {
    fail("invalid_dependency", "Canary dependencies are invalid");
  }
  const outputRoot = await prepareOutputRoot(options.outputRoot);
  const { plan, prompts } = await createCanaryPlan({ ...options, outputRoot });
  const artifactFetcher = injectedArtifactFetcher || ((url, context) => defaultArtifactFetcher(url, {
    ...context,
    allowedHosts: plan.model.artifactHosts
  }));
  const paths = stateFilePaths(outputRoot);
  await fsp.mkdir(paths.artifacts, { recursive: true });
  await assertNoLinksBelow(CONTROLLED_ROOT, paths.artifacts);
  const existingPlan = await lstatIfExists(paths.plan);
  if (!options.execute) {
    if (existingPlan) {
      const existing = await loadExistingRun(paths, plan);
      await verifyInputSnapshot(existing.plan);
      return Object.freeze({ mode: "plan", plan: existing.plan, state: existing.state, paths });
    }
    const state = createInitialState(plan, now);
    await atomicWriteJson(paths.plan, plan);
    await persistState(paths, state);
    return Object.freeze({ mode: "plan", plan, state, paths });
  }
  if (!existingPlan) fail("plan_required", "Run the canary without --execute first and review plan.json");
  const existing = await loadExistingRun(paths, plan);
  await verifyInputSnapshot(existing.plan);
  if (options.submitVideoCohort) {
    const state = await submitParallelVideoCohort({
      plan: existing.plan,
      prompts,
      state: existing.state,
      paths,
      modelArkClient: dependencies.modelArkClient,
      hooks: dependencies.hooks,
      now
    });
    return Object.freeze({ mode: "execute", plan: existing.plan, state, paths });
  }
  const state = await executeStages({
    plan: existing.plan,
    prompts,
    state: existing.state,
    paths,
    modelArkClient: dependencies.modelArkClient,
    artifactFetcher,
    hooks: dependencies.hooks,
    sleep,
    now,
    through: options.through
  });
  return Object.freeze({ mode: "execute", plan: existing.plan, state, paths });
}

module.exports = {
  CONTRACT_VERSION,
  CONTROLLED_ROOT,
  FIXED_BUDGET_CNY,
  IMAGE_STAGE_IDS,
  PROJECT_ROOT,
  PROMPT_FILE,
  REMAINING_VIDEO_IDS,
  REPRESENTATIVE_VIDEO_IDS,
  STAGE_IDS,
  VIDEO_STAGE_IDS,
  ControlledCanaryError,
  canonicalJson,
  createCanaryPlan,
  defaultArtifactFetcher,
  extractSafeProviderUsage,
  isStrictDescendant,
  normalizeModelConfig,
  normalizeOutputRoot,
  normalizePetType,
  normalizePriceCard,
  registerNormalizedMasterArtifact,
  runControlledCanary,
  submitParallelVideoCohort,
  stateFilePaths
};
