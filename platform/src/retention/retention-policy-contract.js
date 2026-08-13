const RETENTION_PLAN_MODE = "dry-run";
const DEFAULT_DISABLED_POLICY_VERSION = "unconfigured";
const DEFAULT_CLEANUP_LIMIT = 50;
const MAX_CLEANUP_LIMIT = 100;

const MEDIA_KINDS = Object.freeze([
  "source_photo",
  "awake_master",
  "sleep_master",
  "provider_input",
  "provider_output",
  "processing_intermediate",
  "action_video",
  "validation_pack",
  "final_petpack"
]);

const MEDIA_KIND_TO_OBJECT_CLASS = Object.freeze({
  source_photo: "source-photo",
  awake_master: "awake-master",
  sleep_master: "sleep-master",
  provider_input: "provider-input",
  provider_output: "provider-output",
  processing_intermediate: "processing-intermediate",
  action_video: "action-video",
  validation_pack: "validation-pack",
  final_petpack: "final-petpack"
});

// These kinds exist in the schema for provenance/completeness, but no current
// production worker writes them. A generic retention sweep must never infer
// that an untracked or future writer's object is disposable.
const NON_AUTOMATIC_CANDIDATE_KINDS = Object.freeze([
  "provider_input",
  "processing_intermediate",
  "validation_pack"
]);

const NON_AUTOMATIC_CANDIDATE_KIND_SET = new Set(NON_AUTOMATIC_CANDIDATE_KINDS);
const MEDIA_KIND_SET = new Set(MEDIA_KINDS);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unsupported or missing field`);
  }
}

function normalizePolicyVersion(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(value)) {
    throw new Error("Retention policy version is invalid");
  }
  return value;
}

function assertDryRunMode(value) {
  if (value !== RETENTION_PLAN_MODE) {
    throw new Error("Cleanup planning accepts only mode=dry-run");
  }
  return RETENTION_PLAN_MODE;
}

function isKnownMediaKind(value) {
  return MEDIA_KIND_SET.has(value);
}

function objectClassForMediaKind(kind) {
  if (!isKnownMediaKind(kind)) throw new Error("Unsupported media kind");
  return MEDIA_KIND_TO_OBJECT_CLASS[kind];
}

function isAutomaticCandidateKind(kind) {
  return isKnownMediaKind(kind) && !NON_AUTOMATIC_CANDIDATE_KIND_SET.has(kind);
}

function createDisabledRules() {
  return Object.freeze(Object.fromEntries(MEDIA_KINDS.map((kind) => [
    kind,
    Object.freeze({ enabled: false })
  ])));
}

function createDisabledRetentionPolicy({ version = DEFAULT_DISABLED_POLICY_VERSION } = {}) {
  return Object.freeze({
    version: normalizePolicyVersion(version),
    mode: RETENTION_PLAN_MODE,
    rules: createDisabledRules()
  });
}

function normalizeRetentionRule(kind, value) {
  if (!isPlainObject(value) || typeof value.enabled !== "boolean") {
    throw new Error(`Retention rule for ${kind} must declare enabled`);
  }
  if (!value.enabled) {
    assertExactKeys(value, ["enabled"], `Retention rule for ${kind}`);
    return Object.freeze({ enabled: false });
  }
  if (!isAutomaticCandidateKind(kind)) {
    throw new Error(`Retention rule for ${kind} cannot enable automatic cleanup`);
  }
  assertExactKeys(value, ["enabled", "minimumAgeMs"], `Retention rule for ${kind}`);
  if (!Number.isSafeInteger(value.minimumAgeMs) || value.minimumAgeMs <= 0) {
    throw new Error(`Retention rule for ${kind} requires a positive minimumAgeMs`);
  }
  return Object.freeze({ enabled: true, minimumAgeMs: value.minimumAgeMs });
}

/**
 * Normalizes an operator-supplied retention policy. Omission intentionally
 * creates a fully disabled policy. A supplied policy must name every one of
 * the nine persisted media kinds so a newly added class cannot inherit an
 * unsafe default.
 */
function normalizeRetentionPolicy(policy) {
  if (policy === undefined) return createDisabledRetentionPolicy();
  assertExactKeys(policy, ["version", "mode", "rules"], "Retention policy");
  const version = normalizePolicyVersion(policy.version);
  const mode = assertDryRunMode(policy.mode);
  if (!isPlainObject(policy.rules)) throw new Error("Retention policy rules must be an object");
  const suppliedKinds = Object.keys(policy.rules).sort();
  const expectedKinds = [...MEDIA_KINDS].sort();
  if (suppliedKinds.length !== expectedKinds.length || suppliedKinds.some((kind, index) => kind !== expectedKinds[index])) {
    throw new Error("Retention policy rules must cover exactly the nine media kinds");
  }
  const rules = {};
  for (const kind of MEDIA_KINDS) rules[kind] = normalizeRetentionRule(kind, policy.rules[kind]);
  return Object.freeze({ version, mode, rules: Object.freeze(rules) });
}

function normalizeCleanupQuery({ cursor = null, limit = DEFAULT_CLEANUP_LIMIT } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CLEANUP_LIMIT) {
    throw new Error(`Cleanup limit must be an integer between 1 and ${MAX_CLEANUP_LIMIT}`);
  }
  if (cursor !== null && cursor !== undefined &&
    (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(cursor))) {
    throw new Error("Cleanup cursor must be an opaque base64url token");
  }
  return { cursor: cursor || null, limit };
}

function hasSafeObjectPathSegments(segments) {
  return segments.every((segment) => Boolean(segment) && segment !== "." && segment !== ".." &&
    !segment.includes("\\") && !segment.includes("\u0000"));
}

/**
 * The planner receives the key only inside the trusted process. It verifies
 * that its class and path layout agree with the media row before a row can
 * become a candidate, then never returns the key to an administrator response.
 */
function objectKeyMatchesMediaKind(objectKey, kind) {
  if (!isKnownMediaKind(kind) || typeof objectKey !== "string") return false;
  const segments = objectKey.split("/");
  if (!hasSafeObjectPathSegments(segments) || segments[0] !== "private" || segments[1] !== "projects") return false;
  const expectedClass = objectClassForMediaKind(kind);
  if (kind === "source_photo") {
    return segments.length >= 5 && segments[3] === expectedClass;
  }
  return segments.length >= 7 && segments[3] === "runs" && segments[5] === expectedClass;
}

module.exports = {
  DEFAULT_CLEANUP_LIMIT,
  DEFAULT_DISABLED_POLICY_VERSION,
  MAX_CLEANUP_LIMIT,
  MEDIA_KINDS,
  MEDIA_KIND_TO_OBJECT_CLASS,
  NON_AUTOMATIC_CANDIDATE_KINDS,
  RETENTION_PLAN_MODE,
  assertDryRunMode,
  createDisabledRetentionPolicy,
  isAutomaticCandidateKind,
  isKnownMediaKind,
  normalizeCleanupQuery,
  normalizeRetentionPolicy,
  objectClassForMediaKind,
  objectKeyMatchesMediaKind
};
