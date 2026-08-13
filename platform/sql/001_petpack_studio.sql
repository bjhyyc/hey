-- PetPack Studio core schema (PostgreSQL 15+)
-- This migration deliberately contains no administrator prompt text, SKU price,
-- provider key, public media URL, or customer asset.

CREATE TYPE user_role AS ENUM ('user', 'admin');
CREATE TYPE order_status AS ENUM ('draft', 'pending_payment', 'paid', 'payment_review', 'expired', 'refund_pending', 'refunded');
CREATE TYPE payment_method AS ENUM ('ALIPAY');
CREATE TYPE payment_attempt_status AS ENUM ('created', 'processing', 'success', 'failed', 'closed', 'timed_out');
CREATE TYPE refund_status AS ENUM ('requested', 'processing', 'success', 'failed');
CREATE TYPE prompt_status AS ENUM ('draft', 'published', 'disabled');
CREATE TYPE production_state AS ENUM (
  'awaiting_photos', 'awake_generating', 'awaiting_character_confirmation',
  'sleep_generating', 'awaiting_prompt_gate', 'video_generating',
  'media_processing', 'packaging', 'validating', 'deliverable', 'failed'
);
CREATE TYPE media_kind AS ENUM (
  'source_photo', 'awake_master', 'sleep_master', 'provider_input',
  'provider_output', 'processing_intermediate', 'action_video',
  'validation_pack', 'final_petpack'
);
CREATE TYPE qa_status AS ENUM ('pending', 'passed', 'failed');
CREATE TYPE delivery_status AS ENUM ('pending', 'ready', 'downloaded', 'expired', 'revoked');

CREATE TABLE app_user (
  id UUID PRIMARY KEY,
  phone_hash TEXT UNIQUE,
  email_hash TEXT UNIQUE,
  role user_role NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_session (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_session_active_user_idx ON auth_session (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE product_plan (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pet_project (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(id),
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'awaiting_payment', 'awaiting_photos', 'awaiting_confirmation', 'producing', 'deliverable', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pet_project_user_idx ON pet_project (user_id, updated_at DESC);

CREATE TABLE customer_order (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(id),
  project_id UUID NOT NULL UNIQUE REFERENCES pet_project(id),
  plan_id UUID NOT NULL REFERENCES product_plan(id),
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  payment_method payment_method NOT NULL,
  status order_status NOT NULL DEFAULT 'draft',
  provider_order_id TEXT UNIQUE,
  paid_at TIMESTAMPTZ,
  delivery_status delivery_status NOT NULL DEFAULT 'pending',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customer_order_user_idx ON customer_order (user_id, created_at DESC);
CREATE INDEX customer_order_provider_idx ON customer_order (provider_order_id) WHERE provider_order_id IS NOT NULL;

CREATE TABLE payment_attempt (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES customer_order(id),
  provider TEXT NOT NULL CHECK (provider = 'ALIPAY'),
  provider_order_id TEXT NOT NULL UNIQUE,
  payment_method payment_method NOT NULL,
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  status payment_attempt_status NOT NULL DEFAULT 'created',
  checkout_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_event (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES customer_order(id),
  provider_order_id TEXT,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  raw_notification_ciphertext BYTEA,
  raw_notification_digest TEXT,
  signature_valid BOOLEAN,
  provider_status TEXT,
  outcome order_status,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_event_order_idx ON payment_event (order_id, created_at DESC);

CREATE TABLE refund (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES customer_order(id),
  provider_refund_id TEXT UNIQUE,
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  status refund_status NOT NULL DEFAULT 'requested',
  idempotency_key TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE media_asset (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES pet_project(id),
  run_id UUID,
  kind media_kind NOT NULL,
  object_key TEXT NOT NULL UNIQUE CHECK (object_key LIKE 'private/%'),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX media_asset_project_kind_idx ON media_asset (project_id, kind, created_at DESC);

-- A source photo is reserved before its browser upload, then accepted only
-- after server-side object metadata verification. `source_photo` below records
-- accepted media, so an unfinished/expired upload cannot masquerade as input.
CREATE TABLE source_photo_upload_reservation (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES pet_project(id),
  ordinal SMALLINT NOT NULL CHECK (ordinal IN (1, 2)),
  object_key TEXT NOT NULL UNIQUE CHECK (object_key LIKE 'private/%'),
  expected_content_type TEXT NOT NULL CHECK (expected_content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  expected_sha256 TEXT NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  expected_byte_size BIGINT NOT NULL CHECK (expected_byte_size > 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'verified', 'accepted', 'expired', 'rejected')),
  source_photo_revision_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, ordinal)
);
CREATE INDEX source_photo_upload_reservation_active_idx
  ON source_photo_upload_reservation (project_id, status, expires_at)
  WHERE status IN ('reserved', 'verified');

CREATE TABLE source_photo (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES pet_project(id),
  media_asset_id UUID NOT NULL UNIQUE REFERENCES media_asset(id),
  ordinal SMALLINT NOT NULL CHECK (ordinal IN (1, 2)),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, ordinal)
);

CREATE TABLE image_candidate (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES pet_project(id),
  media_asset_id UUID NOT NULL UNIQUE REFERENCES media_asset(id),
  kind TEXT NOT NULL CHECK (kind IN ('awake', 'sleep')),
  parent_candidate_id UUID REFERENCES image_candidate(id),
  model_registry_version TEXT NOT NULL,
  provider_request_id TEXT,
  qa_status qa_status NOT NULL DEFAULT 'pending',
  qa_report_id UUID,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX image_candidate_project_kind_idx ON image_candidate (project_id, kind, created_at DESC);

CREATE TABLE character_revision (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES pet_project(id),
  awake_candidate_id UUID NOT NULL UNIQUE REFERENCES image_candidate(id),
  sleep_candidate_id UUID UNIQUE REFERENCES image_candidate(id),
  canvas_id TEXT NOT NULL CHECK (canvas_id = 'character_canvas_v1'),
  approved_by_user_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE prompt_template (
  id UUID PRIMARY KEY,
  action_id TEXT NOT NULL UNIQUE CHECK (action_id IN ('idle', 'sneeze', 'roll', 'sleep-transition', 'sleep-loop', 'stretch', 'hover-attention')),
  title TEXT NOT NULL,
  current_published_version_id UUID,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE prompt_version (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES prompt_template(id),
  version TEXT NOT NULL,
  status prompt_status NOT NULL DEFAULT 'draft',
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  negative_prompt TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution = '720p'),
  duration NUMERIC(5, 2) NOT NULL CHECK (duration > 0),
  first_frame_mode TEXT NOT NULL CHECK (first_frame_mode IN ('awake', 'sleep')),
  last_frame_mode TEXT NOT NULL CHECK (last_frame_mode IN ('awake', 'sleep')),
  immutable_constraints_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES app_user(id),
  published_at TIMESTAMPTZ,
  published_by UUID REFERENCES app_user(id),
  disabled_at TIMESTAMPTZ,
  disabled_by UUID REFERENCES app_user(id),
  supersedes_version_id UUID REFERENCES prompt_version(id),
  UNIQUE (template_id, version)
);
CREATE UNIQUE INDEX prompt_version_one_live_published_idx
  ON prompt_version (template_id)
  WHERE status = 'published' AND disabled_at IS NULL;

ALTER TABLE prompt_template
  ADD CONSTRAINT prompt_template_current_version_fk
  FOREIGN KEY (current_published_version_id) REFERENCES prompt_version(id);

CREATE TABLE prompt_publication_event (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES prompt_template(id),
  from_version_id UUID REFERENCES prompt_version(id),
  to_version_id UUID REFERENCES prompt_version(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('publish', 'disable', 'rollback', 'copy')),
  actor_id UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production_run (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES pet_project(id),
  order_id UUID NOT NULL UNIQUE REFERENCES customer_order(id),
  character_revision_id UUID REFERENCES character_revision(id),
  state production_state NOT NULL,
  model_registry_version TEXT,
  prompt_snapshot JSONB,
  sleep_generation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (sleep_generation_attempts >= 0),
  failure_code TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE generation_action (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES production_run(id),
  action_id TEXT NOT NULL CHECK (action_id IN ('idle', 'sneeze', 'roll', 'sleep-transition', 'sleep-loop', 'stretch', 'hover-attention')),
  prompt_version_id UUID NOT NULL REFERENCES prompt_version(id),
  prompt_version_label TEXT NOT NULL,
  model_reference JSONB NOT NULL,
  first_frame_object_key TEXT NOT NULL CHECK (first_frame_object_key LIKE 'private/%'),
  last_frame_object_key TEXT NOT NULL CHECK (last_frame_object_key LIKE 'private/%'),
  provider_task_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'processed', 'qa_passed')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  media_asset_id UUID REFERENCES media_asset(id),
  qa_report_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, action_id)
);

CREATE TABLE qa_report (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES pet_project(id),
  run_id UUID REFERENCES production_run(id),
  action_id TEXT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('image', 'video', 'petpack', 'desktop_import')),
  status qa_status NOT NULL,
  policy_version TEXT NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE image_candidate
  ADD CONSTRAINT image_candidate_qa_report_fk FOREIGN KEY (qa_report_id) REFERENCES qa_report(id);
ALTER TABLE generation_action
  ADD CONSTRAINT generation_action_qa_report_fk FOREIGN KEY (qa_report_id) REFERENCES qa_report(id);

CREATE TABLE petpack_build (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES production_run(id),
  media_asset_id UUID NOT NULL UNIQUE REFERENCES media_asset(id),
  package_id TEXT NOT NULL UNIQUE,
  manifest JSONB NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  original_import_verified_at TIMESTAMPTZ,
  customized_interactions_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE delivery (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL UNIQUE REFERENCES customer_order(id),
  petpack_build_id UUID NOT NULL UNIQUE REFERENCES petpack_build(id),
  status delivery_status NOT NULL DEFAULT 'pending',
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  last_downloaded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outbox_job (
  id UUID PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  job_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  leased_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_job_dispatch_idx ON outbox_job (status, available_at) WHERE status IN ('pending', 'failed');

CREATE TABLE audit_event (
  id UUID PRIMARY KEY,
  actor_id UUID REFERENCES app_user(id),
  project_id UUID REFERENCES pet_project(id),
  order_id UUID REFERENCES customer_order(id),
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_event_project_idx ON audit_event (project_id, created_at DESC);
