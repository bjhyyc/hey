const crypto = require("node:crypto");

const { ACTION_ENDPOINTS, REQUIRED_ACTION_IDS, VIDEO_CONSTRAINTS_VERSION } = require("../domain/action-catalog");
const { sessionTokenHash } = require("../auth/phone-auth-service");
const {
  IMAGE_CONSTRAINTS_VERSION,
  IMAGE_PROMPT_CONTENT_POLICY_VERSION
} = require("../providers/modelark-client");
const { ACTION_DURATIONS } = require("./zero-cost-worker-components");

const REHEARSAL_USER_ID = "70000000-0000-4000-8000-000000000001";
const REHEARSAL_ADMIN_ID = "70000000-0000-4000-8000-000000000002";
const REHEARSAL_PLAN_CODE = "zero-cost-rehearsal";
const REHEARSAL_PLAN_ID = "70000000-0000-4000-8000-000000000003";
const REHEARSAL_PROMPT_VERSION = "zero-cost-stable-v1";

function uuidFromLabel(label) {
  const bytes = crypto.createHash("sha256").update(`petpack-zero-cost|${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function" || typeof database.query !== "function") {
    throw new Error("Zero-cost rehearsal requires a PostgreSQL database");
  }
  return database;
}

function requireSessionSigningKey(environment) {
  const value = typeof environment.PETPACK_SESSION_SIGNING_KEY === "string"
    ? environment.PETPACK_SESSION_SIGNING_KEY
    : "";
  if (Buffer.byteLength(value, "utf8") < 32) throw new Error("Zero-cost rehearsal session signing key is invalid");
  return value;
}

async function seedVideoPrompt(tx, actionId) {
  const templateId = uuidFromLabel(`video-template:${actionId}`);
  const versionId = uuidFromLabel(`video-version:${actionId}:${REHEARSAL_PROMPT_VERSION}`);
  const title = `Zero-cost ${actionId}`;
  const template = await tx.query(
    `INSERT INTO prompt_template (id, action_id, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (action_id) DO UPDATE SET title = EXCLUDED.title
     RETURNING id`,
    [templateId, actionId, title]
  );
  const actualTemplateId = template.rows[0].id;
  const endpoint = ACTION_ENDPOINTS[actionId];
  await tx.query(
    `INSERT INTO prompt_version
      (id, template_id, version, status, title, prompt, negative_prompt, model,
       resolution, duration, first_frame_mode, last_frame_mode,
       immutable_constraints_version, created_by, published_at, published_by)
     VALUES ($1, $2, $3, 'published', $4, $5, $6, 'fixture-seedance',
             '480p', $7, $8, $9, $10, $11, now(), $11)
     ON CONFLICT (template_id, version) DO NOTHING`,
    [
      versionId,
      actualTemplateId,
      REHEARSAL_PROMPT_VERSION,
      title,
      `Development-only deterministic ${actionId} action. No external provider call.`,
      "camera movement, text, props, audio, watermark",
      ACTION_DURATIONS[actionId],
      endpoint.firstFrameMode,
      endpoint.lastFrameMode,
      VIDEO_CONSTRAINTS_VERSION,
      REHEARSAL_ADMIN_ID
    ]
  );
  const selected = await tx.query(
    `SELECT id, status, resolution, duration, first_frame_mode, last_frame_mode,
            immutable_constraints_version
       FROM prompt_version
      WHERE template_id = $1 AND version = $2`,
    [actualTemplateId, REHEARSAL_PROMPT_VERSION]
  );
  const row = selected.rows[0];
  if (!row || row.status !== "published" || row.resolution !== "480p" ||
      Number(row.duration) !== ACTION_DURATIONS[actionId] ||
      row.first_frame_mode !== endpoint.firstFrameMode || row.last_frame_mode !== endpoint.lastFrameMode ||
      row.immutable_constraints_version !== VIDEO_CONSTRAINTS_VERSION) {
    throw new Error(`Existing ${actionId} prompt is incompatible with the zero-cost rehearsal`);
  }
  await tx.query(
    `UPDATE prompt_template SET current_published_version_id = $2 WHERE id = $1`,
    [actualTemplateId, row.id]
  );
}

async function seedImagePrompt(tx, kind) {
  const templateId = uuidFromLabel(`image-template:${kind}`);
  const versionId = uuidFromLabel(`image-version:${kind}:${REHEARSAL_PROMPT_VERSION}`);
  const template = await tx.query(
    `INSERT INTO image_prompt_template (id, kind)
     VALUES ($1, $2)
     ON CONFLICT (kind) DO UPDATE SET updated_at = image_prompt_template.updated_at
     RETURNING id`,
    [templateId, kind]
  );
  const actualTemplateId = template.rows[0].id;
  await tx.query(
    `INSERT INTO image_prompt_version
      (id, template_id, version, status, prompt, negative_prompt,
       immutable_constraints_version, content_policy_version,
       content_policy_approved_at, content_policy_approved_by,
       created_by, published_at, published_by)
     VALUES ($1, $2, $3, 'published', $4, $5, $6, $7,
             now(), $8, $8, now(), $8)
     ON CONFLICT (template_id, version) DO NOTHING`,
    [
      versionId,
      actualTemplateId,
      REHEARSAL_PROMPT_VERSION,
      `Development-only deterministic ${kind} master. No external provider call.`,
      "text, watermark, props, people, extra animals",
      IMAGE_CONSTRAINTS_VERSION,
      IMAGE_PROMPT_CONTENT_POLICY_VERSION,
      REHEARSAL_ADMIN_ID
    ]
  );
  const selected = await tx.query(
    `SELECT id, status, immutable_constraints_version, content_policy_version,
            content_policy_approved_at, published_at
       FROM image_prompt_version
      WHERE template_id = $1 AND version = $2`,
    [actualTemplateId, REHEARSAL_PROMPT_VERSION]
  );
  const row = selected.rows[0];
  if (!row || row.status !== "published" || !row.content_policy_approved_at || !row.published_at ||
      row.immutable_constraints_version !== IMAGE_CONSTRAINTS_VERSION ||
      row.content_policy_version !== IMAGE_PROMPT_CONTENT_POLICY_VERSION) {
    throw new Error(`Existing ${kind} image prompt is incompatible with the zero-cost rehearsal`);
  }
  await tx.query(
    `UPDATE image_prompt_template SET current_published_version_id = $2 WHERE id = $1`,
    [actualTemplateId, row.id]
  );
}

async function assertRehearsalSchema(database) {
  const result = await database.query(
    `SELECT to_regclass('public.auth_identity') IS NOT NULL AS has_auth,
            to_regclass('public.image_prompt_version') IS NOT NULL AS has_images,
            to_regclass('public.provider_usage_attempt') IS NOT NULL AS has_usage,
            EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'payment_event'
                 AND column_name = 'adapter_version'
            ) AS has_kaipay`
  );
  const row = result.rows[0];
  if (!row || !row.has_auth || !row.has_images || !row.has_usage || !row.has_kaipay) {
    throw new Error("Zero-cost rehearsal database is not migrated through 014");
  }
}

async function seedZeroCostDatabase({ database, environment = process.env } = {}) {
  requireDatabase(database);
  const signingKey = requireSessionSigningKey(environment);
  await assertRehearsalSchema(database);
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sessionTokenHash(sessionToken, signingKey);
  const sessionId = crypto.randomUUID();
  await database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO app_user (id, role, status) VALUES ($1, 'admin', 'active')
       ON CONFLICT (id) DO UPDATE SET role = 'admin', status = 'active'`,
      [REHEARSAL_ADMIN_ID]
    );
    await tx.query(
      `INSERT INTO app_user (id, role, status) VALUES ($1, 'user', 'active')
       ON CONFLICT (id) DO UPDATE SET role = 'user', status = 'active'`,
      [REHEARSAL_USER_ID]
    );
    await tx.query(
      `INSERT INTO auth_session (id, user_id, token_hash, expires_at, auth_policy_version)
       VALUES ($1, $2, $3, now() + interval '4 hours', 'zero-cost-rehearsal/v1')`,
      [sessionId, REHEARSAL_USER_ID, tokenHash]
    );
    await tx.query(
      `INSERT INTO product_plan (id, code, name, amount_fen, enabled)
       VALUES ($1, $2, 'Zero-cost rehearsal', 1, true)
       ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name, amount_fen = EXCLUDED.amount_fen, enabled = true`,
      [REHEARSAL_PLAN_ID, REHEARSAL_PLAN_CODE]
    );
    for (const actionId of REQUIRED_ACTION_IDS) await seedVideoPrompt(tx, actionId);
    for (const kind of ["front", "side", "sleep"]) await seedImagePrompt(tx, kind);
  });
  return Object.freeze({
    actorId: REHEARSAL_USER_ID,
    planCode: REHEARSAL_PLAN_CODE,
    sessionToken,
    sessionCookieName: environment.PETPACK_STUDIO_SESSION_COOKIE_NAME
  });
}

module.exports = {
  REHEARSAL_ADMIN_ID,
  REHEARSAL_PLAN_CODE,
  REHEARSAL_PLAN_ID,
  REHEARSAL_PROMPT_VERSION,
  REHEARSAL_USER_ID,
  assertRehearsalSchema,
  seedZeroCostDatabase,
  uuidFromLabel
};
