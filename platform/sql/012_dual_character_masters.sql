-- Dual confirmed character masters and 3-4 source-photo batches.
-- Requires migrations 001 through 011. No prompt, price, credential, or
-- customer media is seeded here.

ALTER TABLE source_photo_upload_reservation
  DROP CONSTRAINT IF EXISTS source_photo_upload_reservation_ordinal_check,
  ADD CONSTRAINT source_photo_upload_reservation_ordinal_check CHECK (ordinal BETWEEN 1 AND 4),
  ADD COLUMN expected_photo_count SMALLINT NOT NULL DEFAULT 3
    CHECK (expected_photo_count BETWEEN 3 AND 4);

ALTER TABLE source_photo_upload_reservation
  ALTER COLUMN expected_photo_count DROP DEFAULT;

ALTER TABLE source_photo
  DROP CONSTRAINT IF EXISTS source_photo_ordinal_check,
  ADD CONSTRAINT source_photo_ordinal_check CHECK (ordinal BETWEEN 1 AND 4);

ALTER TYPE media_kind ADD VALUE IF NOT EXISTS 'front_master';
ALTER TYPE media_kind ADD VALUE IF NOT EXISTS 'side_master';

ALTER TABLE image_candidate DROP CONSTRAINT IF EXISTS image_candidate_kind_check;
UPDATE image_candidate SET kind = 'front' WHERE kind = 'awake';
ALTER TABLE image_candidate
  ADD CONSTRAINT image_candidate_kind_check CHECK (kind IN ('front', 'side', 'sleep'));

ALTER TABLE character_revision RENAME COLUMN awake_candidate_id TO front_candidate_id;
ALTER TABLE character_revision
  ADD COLUMN side_candidate_id UUID UNIQUE REFERENCES image_candidate(id);

ALTER TABLE character_revision DROP CONSTRAINT IF EXISTS character_revision_canvas_id_check;
ALTER TABLE character_revision
  ADD CONSTRAINT character_revision_canvas_id_check
  CHECK (canvas_id IN ('character_canvas_v1', 'character_canvas_480p_v1'));

ALTER TABLE production_run RENAME COLUMN awake_generation_attempts TO front_generation_attempts;
ALTER TABLE production_run
  ADD COLUMN side_generation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (side_generation_attempts >= 0),
  ADD COLUMN front_user_regenerations_used INTEGER NOT NULL DEFAULT 0 CHECK (front_user_regenerations_used BETWEEN 0 AND 2),
  ADD COLUMN side_user_regenerations_used INTEGER NOT NULL DEFAULT 0 CHECK (side_user_regenerations_used BETWEEN 0 AND 2),
  ADD COLUMN front_qa_retries INTEGER NOT NULL DEFAULT 0 CHECK (front_qa_retries >= 0),
  ADD COLUMN side_qa_retries INTEGER NOT NULL DEFAULT 0 CHECK (side_qa_retries >= 0);

UPDATE production_run
   SET model_registry_version = 'legacy-unknown'
 WHERE model_registry_version IS NULL;
ALTER TABLE production_run
  ALTER COLUMN model_registry_version SET NOT NULL,
  ADD CONSTRAINT production_run_model_registry_version_check
    CHECK (length(model_registry_version) BETWEEN 1 AND 128);

ALTER TABLE production_run_master_frame RENAME COLUMN awake_master_object_key TO front_master_object_key;
ALTER TABLE production_run_master_frame
  ADD COLUMN side_master_object_key TEXT CHECK (side_master_object_key LIKE 'private/%');
UPDATE production_run_master_frame
   SET side_master_object_key = front_master_object_key
 WHERE side_master_object_key IS NULL;
ALTER TABLE production_run_master_frame ALTER COLUMN side_master_object_key SET NOT NULL;

ALTER TABLE prompt_version DROP CONSTRAINT IF EXISTS prompt_version_resolution_check;
ALTER TABLE prompt_version
  ADD CONSTRAINT prompt_version_resolution_check CHECK (resolution IN ('480p', '720p'));

ALTER TABLE image_prompt_template DROP CONSTRAINT IF EXISTS image_prompt_template_kind_check;
UPDATE image_prompt_template SET kind = 'front' WHERE kind = 'awake';
ALTER TABLE image_prompt_template
  ADD CONSTRAINT image_prompt_template_kind_check CHECK (kind IN ('front', 'side', 'sleep'));

ALTER TABLE master_image_generation RENAME COLUMN parent_awake_candidate_id TO parent_front_candidate_id;
ALTER TABLE master_image_generation
  ADD COLUMN parent_side_candidate_id UUID REFERENCES image_candidate(id);

DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'master_image_generation'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%kind%awake%'
  LOOP
    EXECUTE format('ALTER TABLE master_image_generation DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;

UPDATE master_image_generation SET kind = 'front' WHERE kind = 'awake';

ALTER TABLE master_image_generation
  ADD CONSTRAINT master_image_generation_kind_check CHECK (kind IN ('front', 'side', 'sleep')),
  ADD CONSTRAINT master_image_generation_reference_shape_check CHECK (
    (kind = 'front' AND source_photo_revision_id IS NOT NULL
      AND parent_front_candidate_id IS NULL AND parent_side_candidate_id IS NULL)
    OR
    (kind = 'side' AND source_photo_revision_id IS NOT NULL
      AND parent_front_candidate_id IS NOT NULL AND parent_side_candidate_id IS NULL)
    OR
    (kind = 'sleep' AND source_photo_revision_id IS NULL
      AND parent_front_candidate_id IS NOT NULL AND parent_side_candidate_id IS NOT NULL)
  ),
  ADD CONSTRAINT master_image_generation_parent_side_fk
    FOREIGN KEY (parent_side_candidate_id, project_id, run_id)
    REFERENCES image_candidate(id, project_id, run_id);

ALTER TABLE provider_price_rate DROP CONSTRAINT IF EXISTS provider_price_rate_operation_check;
ALTER TABLE provider_usage_attempt DROP CONSTRAINT IF EXISTS provider_usage_attempt_operation_check;
ALTER TABLE provider_usage_attempt DROP CONSTRAINT IF EXISTS provider_usage_attempt_check;

-- PostgreSQL may assign an implementation-dependent suffix (for example
-- provider_usage_attempt_check1) to an inline CHECK constraint.  Drop every
-- legacy operation constraint by its definition before rewriting existing
-- rows; relying only on historical names leaves fresh 001 -> 014 databases
-- unable to record seedream_front usage.
DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'provider_usage_attempt'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%operation%seedream_awake%'
  LOOP
    EXECUTE format('ALTER TABLE provider_usage_attempt DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;

UPDATE provider_price_rate SET operation = 'seedream_front' WHERE operation = 'seedream_awake';
UPDATE provider_usage_attempt SET operation = 'seedream_front' WHERE operation = 'seedream_awake';

ALTER TABLE provider_price_rate
  ADD CONSTRAINT provider_price_rate_operation_check
  CHECK (operation IN ('seedream_front', 'seedream_side', 'seedream_sleep', 'seedance_video'));

ALTER TABLE provider_usage_attempt
  ADD CONSTRAINT provider_usage_attempt_operation_check
  CHECK (operation IN ('seedream_front', 'seedream_side', 'seedream_sleep', 'seedance_video')),
  ADD CONSTRAINT provider_usage_attempt_subject_check CHECK (
    (operation IN ('seedream_front', 'seedream_side', 'seedream_sleep')
      AND master_image_generation_id IS NOT NULL AND generation_action_id IS NULL AND action_id IS NULL)
    OR
    (operation = 'seedance_video'
      AND master_image_generation_id IS NULL AND generation_action_id IS NOT NULL AND action_id IS NOT NULL)
  );
