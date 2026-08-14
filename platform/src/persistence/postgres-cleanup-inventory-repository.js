const crypto = require("node:crypto");

const { BLOCKING_REASONS } = require("../retention/cleanup-candidate-planner");
const { normalizeCleanupQuery } = require("../retention/retention-policy-contract");

const CURSOR_VERSION = 1;
const CURSOR_ALGORITHM = "aes-256-gcm";
const CURSOR_IV_BYTES = 12;
const CURSOR_TAG_BYTES = 16;

const BOOLEAN_BLOCKERS = Object.freeze({
  active_run: BLOCKING_REASONS.ACTIVE_RUN,
  active_job: BLOCKING_REASONS.ACTIVE_JOB,
  active_outbox: BLOCKING_REASONS.ACTIVE_OUTBOX,
  reconciliation_required: BLOCKING_REASONS.RECONCILIATION_REQUIRED,
  retention_hold: BLOCKING_REASONS.RETENTION_HOLD,
  source_photo_reference: BLOCKING_REASONS.SOURCE_PHOTO_REFERENCE,
  master_frame_reference: BLOCKING_REASONS.MASTER_FRAME_REFERENCE,
  action_master_frame_reference: BLOCKING_REASONS.ACTION_MASTER_FRAME_REFERENCE,
  character_revision_reference: BLOCKING_REASONS.CHARACTER_REVISION_REFERENCE,
  image_candidate_reference: BLOCKING_REASONS.IMAGE_CANDIDATE_REFERENCE,
  master_generation_reference: BLOCKING_REASONS.MASTER_GENERATION_REFERENCE,
  qa_evidence_reference: BLOCKING_REASONS.QA_EVIDENCE_REFERENCE,
  generation_action_reference: BLOCKING_REASONS.GENERATION_ACTION_REFERENCE,
  petpack_snapshot_reference: BLOCKING_REASONS.PETPACK_SNAPSHOT_REFERENCE,
  petpack_build_reference: BLOCKING_REASONS.PETPACK_BUILD_REFERENCE,
  validation_evidence_reference: BLOCKING_REASONS.VALIDATION_EVIDENCE_REFERENCE,
  live_delivery: BLOCKING_REASONS.LIVE_DELIVERY,
  payment_attention: BLOCKING_REASONS.PAYMENT_ATTENTION,
  source_reservation_reference: BLOCKING_REASONS.SOURCE_RESERVATION_REFERENCE,
  source_reservation_unsettled: BLOCKING_REASONS.SOURCE_RESERVATION_UNSETTLED
});

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function") throw new Error("A PostgreSQL transaction runner is required for cleanup inventory");
  return database;
}

function requiredSecret(value) {
  if (typeof value !== "string" || value.length < 32) throw new Error("A cleanup cursor secret of at least 32 characters is required");
  return crypto.createHash("sha256").update(value).digest();
}

function canonicalTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Cleanup cursor timestamp is invalid");
  return date.toISOString();
}

function requiredIdentifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Cleanup cursor asset identifier is invalid");
  }
  return value;
}

function encodeCleanupCursor({ createdAt, mediaAssetId, cursorKey, randomBytes = crypto.randomBytes } = {}) {
  if (!Buffer.isBuffer(cursorKey) || cursorKey.length !== 32) throw new Error("Cleanup cursor key is invalid");
  if (typeof randomBytes !== "function") throw new Error("Cleanup cursor random source is required");
  const payload = Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    c: canonicalTimestamp(createdAt),
    i: requiredIdentifier(mediaAssetId)
  }), "utf8");
  const iv = randomBytes(CURSOR_IV_BYTES);
  if (!Buffer.isBuffer(iv) || iv.length !== CURSOR_IV_BYTES) throw new Error("Cleanup cursor IV is invalid");
  const cipher = crypto.createCipheriv(CURSOR_ALGORITHM, cursorKey, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

function decodeCleanupCursor(value, cursorKey) {
  if (typeof value !== "string" || value.length < 40 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Cleanup cursor is invalid");
  }
  if (!Buffer.isBuffer(cursorKey) || cursorKey.length !== 32) throw new Error("Cleanup cursor key is invalid");
  try {
    const encoded = Buffer.from(value, "base64url");
    if (encoded.length <= CURSOR_IV_BYTES + CURSOR_TAG_BYTES) throw new Error("short cursor");
    const iv = encoded.subarray(0, CURSOR_IV_BYTES);
    const tag = encoded.subarray(CURSOR_IV_BYTES, CURSOR_IV_BYTES + CURSOR_TAG_BYTES);
    const ciphertext = encoded.subarray(CURSOR_IV_BYTES + CURSOR_TAG_BYTES);
    const decipher = crypto.createDecipheriv(CURSOR_ALGORITHM, cursorKey, iv);
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
    if (!parsed || parsed.v !== CURSOR_VERSION || Object.keys(parsed).sort().join(",") !== "c,i,v") {
      throw new Error("unsupported cursor");
    }
    return { createdAt: canonicalTimestamp(parsed.c), mediaAssetId: requiredIdentifier(parsed.i) };
  } catch (_error) {
    throw new Error("Cleanup cursor is invalid");
  }
}

function databaseRows(result) {
  return Array.isArray(result && result.rows) ? result.rows : [];
}

function databaseByteSize(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error("Cleanup inventory byte size is invalid");
  return numeric;
}

function mapInventoryRow(row) {
  const blockers = [];
  for (const [column, reason] of Object.entries(BOOLEAN_BLOCKERS)) {
    if (row[column] === true) blockers.push(reason);
  }
  return {
    tracked: true,
    asset: {
      id: row.media_asset_id,
      kind: row.media_kind,
      objectKey: row.object_key,
      sha256: row.sha256,
      byteSize: databaseByteSize(row.byte_size),
      createdAt: canonicalTimestamp(row.created_at),
      deletedAt: row.deleted_at ? canonicalTimestamp(row.deleted_at) : null
    },
    blockers: blockers.sort()
  };
}

class PostgresCleanupInventoryRepository {
  constructor({ database, cursorSecret, randomBytes = crypto.randomBytes, logger = console } = {}) {
    this.database = requireDatabase(database);
    this.cursorKey = requiredSecret(cursorSecret);
    if (typeof randomBytes !== "function") throw new Error("Cleanup cursor random source is required");
    this.randomBytes = randomBytes;
    this.logger = logger;
  }

  async listCleanupInventory(input = {}) {
    const query = normalizeCleanupQuery(input);
    const cursor = query.cursor ? decodeCleanupCursor(query.cursor, this.cursorKey) : null;
    return this.database.transaction(async (tx) => {
      const found = databaseRows(await tx.query(
        `SELECT asset.id AS media_asset_id,
                asset.kind::text AS media_kind,
                asset.object_key,
                asset.sha256,
                asset.byte_size,
                asset.created_at,
                asset.deleted_at,
                EXISTS (
                  SELECT 1 FROM production_run active_run
                   WHERE active_run.project_id = asset.project_id
                     AND (asset.run_id IS NULL OR active_run.id = asset.run_id)
                     AND active_run.state NOT IN ('deliverable', 'failed')
                ) AS active_run,
                EXISTS (
                  SELECT 1 FROM production_job_execution execution
                   WHERE execution.run_id = asset.run_id
                     AND execution.status IN ('pending', 'leased', 'retryable', 'reconciliation_required')
                ) AS active_job,
                EXISTS (
                  SELECT 1 FROM outbox_job outbox
                   WHERE outbox.aggregate_type = 'production_run'
                     AND outbox.aggregate_id = asset.run_id
                     AND outbox.status IN ('pending', 'leased', 'failed')
                ) AS active_outbox,
                (EXISTS (
                  SELECT 1 FROM production_job_execution execution
                   WHERE execution.run_id = asset.run_id AND execution.status = 'reconciliation_required'
                ) OR EXISTS (
                  SELECT 1 FROM master_image_generation generation
                   WHERE generation.run_id = asset.run_id AND generation.status = 'reconciliation_required'
                )) AS reconciliation_required,
                EXISTS (
                  SELECT 1 FROM retention_hold hold
                  WHERE hold.released_at IS NULL AND (
                    hold.media_asset_id = asset.id OR hold.project_id = asset.project_id
                    OR hold.run_id = asset.run_id
                    OR (hold.order_id IS NOT NULL AND (
                      EXISTS (
                        SELECT 1 FROM production_run asset_run
                         WHERE asset_run.id = asset.run_id AND asset_run.order_id = hold.order_id
                      )
                      OR (asset.run_id IS NULL AND EXISTS (
                        SELECT 1 FROM customer_order held_order
                         WHERE held_order.id = hold.order_id AND held_order.project_id = asset.project_id
                      ))
                    ))
                  )
                ) AS retention_hold,
                EXISTS (
                  SELECT 1 FROM source_photo photo
                   WHERE photo.media_asset_id = asset.id
                ) AS source_photo_reference,
                EXISTS (
                  SELECT 1 FROM production_run_master_frame frame
                   WHERE frame.run_id = asset.run_id
                     AND (frame.front_master_object_key = asset.object_key
                       OR frame.side_master_object_key = asset.object_key
                       OR frame.sleep_master_object_key = asset.object_key)
                ) AS master_frame_reference,
                EXISTS (
                  SELECT 1 FROM generation_action action
                   WHERE action.run_id = asset.run_id
                     AND (action.first_frame_object_key = asset.object_key OR action.last_frame_object_key = asset.object_key)
                ) AS action_master_frame_reference,
                EXISTS (
                  SELECT 1 FROM image_candidate candidate
                  JOIN character_revision revision
                    ON revision.front_candidate_id = candidate.id
                    OR revision.side_candidate_id = candidate.id
                    OR revision.sleep_candidate_id = candidate.id
                   WHERE candidate.media_asset_id = asset.id
                ) AS character_revision_reference,
                EXISTS (SELECT 1 FROM image_candidate candidate WHERE candidate.media_asset_id = asset.id)
                  AS image_candidate_reference,
                EXISTS (
                  SELECT 1 FROM master_image_generation generation
                   WHERE generation.provider_output_asset_id = asset.id
                      OR generation.normalized_media_asset_id = asset.id
                ) AS master_generation_reference,
                EXISTS (
                  SELECT 1 FROM qa_report qa
                   WHERE qa.source_media_asset_id = asset.id OR qa.subject_media_asset_id = asset.id
                ) AS qa_evidence_reference,
                EXISTS (
                  SELECT 1 FROM generation_action action
                   WHERE action.provider_output_asset_id = asset.id OR action.media_asset_id = asset.id
                ) AS generation_action_reference,
                EXISTS (SELECT 1 FROM petpack_input_action input WHERE input.media_asset_id = asset.id)
                  AS petpack_snapshot_reference,
                EXISTS (SELECT 1 FROM petpack_build build WHERE build.media_asset_id = asset.id)
                  AS petpack_build_reference,
                EXISTS (
                  SELECT 1 FROM qa_report qa
                   WHERE (qa.source_media_asset_id = asset.id OR qa.subject_media_asset_id = asset.id)
                     AND qa.subject_kind IN ('petpack', 'desktop_import')
                ) AS validation_evidence_reference,
                EXISTS (
                  SELECT 1 FROM petpack_build build
                  JOIN delivery delivery ON delivery.petpack_build_id = build.id
                   WHERE build.media_asset_id = asset.id
                     AND delivery.status NOT IN ('expired', 'revoked')
                ) AS live_delivery,
                EXISTS (
                  SELECT 1 FROM customer_order order_record
                   WHERE order_record.project_id = asset.project_id
                     AND order_record.status IN ('payment_review', 'refund_pending')
                ) AS payment_attention,
                EXISTS (
                  SELECT 1 FROM source_photo_upload_reservation reservation
                   WHERE reservation.object_key = asset.object_key
                     AND reservation.status = 'accepted'
                ) AS source_reservation_reference,
                EXISTS (
                  SELECT 1 FROM source_photo_upload_reservation reservation
                   WHERE reservation.object_key = asset.object_key
                     AND reservation.status IN ('reserved', 'verified')
                ) AS source_reservation_unsettled
           FROM media_asset asset
          WHERE ($1::timestamptz IS NULL OR (asset.created_at, asset.id) > ($1::timestamptz, $2::uuid))
          ORDER BY asset.created_at, asset.id
          LIMIT $3`,
        [cursor?.createdAt || null, cursor?.mediaAssetId || null, query.limit + 1]
      ));
      const hasMore = found.length > query.limit;
      const pageRows = found.slice(0, query.limit);
      const items = pageRows.map(mapInventoryRow);
      const last = pageRows[pageRows.length - 1];
      const nextCursor = hasMore && last ? encodeCleanupCursor({
        createdAt: last.created_at,
        mediaAssetId: last.media_asset_id,
        cursorKey: this.cursorKey,
        randomBytes: this.randomBytes
      }) : null;
      this.logger.info?.("petpack.retention.cleanup_inventory_listed", {
        returned: items.length,
        hasNextPage: Boolean(nextCursor)
      });
      return { items, nextCursor };
    });
  }
}

module.exports = {
  BOOLEAN_BLOCKERS,
  PostgresCleanupInventoryRepository,
  decodeCleanupCursor,
  encodeCleanupCursor,
  mapInventoryRow,
  requiredSecret
};
