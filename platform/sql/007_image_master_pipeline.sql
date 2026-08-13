-- PetPack Studio Seedream master-image pipeline (requires migrations 001 through 006)
--
-- Image prompt text is deliberately not seeded. Production can generate an
-- image only after an administrator-owned awake/sleep prompt version is
-- explicitly published and selected by its template.

CREATE TABLE image_prompt_template (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL UNIQUE CHECK (kind IN ('awake', 'sleep')),
  current_published_version_id UUID,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE image_prompt_version (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES image_prompt_template(id),
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
  status prompt_status NOT NULL DEFAULT 'draft',
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 20000),
  negative_prompt TEXT NOT NULL DEFAULT '' CHECK (length(negative_prompt) <= 20000),
  immutable_constraints_version TEXT NOT NULL CHECK (length(immutable_constraints_version) BETWEEN 1 AND 128),
  content_policy_version TEXT NOT NULL CHECK (length(content_policy_version) BETWEEN 1 AND 128),
  content_policy_approved_at TIMESTAMPTZ,
  content_policy_approved_by UUID REFERENCES app_user(id),
  created_by UUID NOT NULL REFERENCES app_user(id),
  published_at TIMESTAMPTZ,
  published_by UUID REFERENCES app_user(id),
  disabled_at TIMESTAMPTZ,
  disabled_by UUID REFERENCES app_user(id),
  supersedes_version_id UUID REFERENCES image_prompt_version(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version),
  CHECK (
    (status = 'published' AND published_at IS NOT NULL AND published_by IS NOT NULL
      AND content_policy_approved_at IS NOT NULL AND content_policy_approved_by IS NOT NULL
      AND disabled_at IS NULL)
    OR status <> 'published'
  )
);

ALTER TABLE image_prompt_template
  ADD CONSTRAINT image_prompt_template_current_version_fk
  FOREIGN KEY (current_published_version_id) REFERENCES image_prompt_version(id);

CREATE UNIQUE INDEX image_prompt_version_one_live_published_idx
  ON image_prompt_version (template_id)
  WHERE status = 'published' AND disabled_at IS NULL;

ALTER TABLE image_candidate
  ADD COLUMN run_id UUID REFERENCES production_run(id),
  ADD COLUMN order_id UUID REFERENCES customer_order(id),
  ADD COLUMN generation_attempt INTEGER CHECK (generation_attempt IS NULL OR generation_attempt >= 0);

-- Existing development rows may predate run ownership. PostgreSQL still
-- enforces these NOT VALID checks for every new/updated row while allowing a
-- separately audited legacy backfill before validation.
ALTER TABLE image_candidate
  ADD CONSTRAINT image_candidate_run_required_ck
  CHECK (run_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT image_candidate_order_required_ck
  CHECK (order_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT image_candidate_attempt_required_ck
  CHECK (generation_attempt IS NOT NULL) NOT VALID,
  ADD CONSTRAINT image_candidate_run_project_order_fk
  FOREIGN KEY (run_id, project_id, order_id)
  REFERENCES production_run(id, project_id, order_id) NOT VALID,
  ADD CONSTRAINT image_candidate_media_ownership_fk
  FOREIGN KEY (media_asset_id, project_id, run_id)
  REFERENCES media_asset(id, project_id, run_id) NOT VALID;

ALTER TABLE image_candidate
  ADD CONSTRAINT image_candidate_id_project_run_unique UNIQUE (id, project_id, run_id);

ALTER TABLE qa_report
  ADD CONSTRAINT qa_report_id_project_run_unique UNIQUE (id, project_id, run_id);

CREATE UNIQUE INDEX image_candidate_run_kind_attempt_unique_idx
  ON image_candidate (run_id, kind, generation_attempt)
  WHERE run_id IS NOT NULL AND generation_attempt IS NOT NULL;

CREATE UNIQUE INDEX qa_report_image_subject_unique_idx
  ON qa_report (subject_media_asset_id)
  WHERE subject_kind = 'image' AND subject_media_asset_id IS NOT NULL;

ALTER TABLE qa_report
  ADD CONSTRAINT qa_report_image_subject_binding_ck
  CHECK (
    subject_kind <> 'image'
    OR (
      action_id IS NULL
      AND source_media_asset_id IS NOT NULL
      AND subject_media_asset_id IS NOT NULL
      AND processor_version IS NOT NULL
    )
  ) NOT VALID;

CREATE TABLE master_image_generation (
  id UUID PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES production_job_execution(job_id),
  run_id UUID NOT NULL REFERENCES production_run(id),
  project_id UUID NOT NULL REFERENCES pet_project(id),
  order_id UUID NOT NULL REFERENCES customer_order(id),
  kind TEXT NOT NULL CHECK (kind IN ('awake', 'sleep')),
  generation_attempt INTEGER NOT NULL CHECK (generation_attempt >= 0),
  source_photo_revision_id UUID,
  parent_awake_candidate_id UUID REFERENCES image_candidate(id),
  prompt_version_id UUID NOT NULL REFERENCES image_prompt_version(id),
  prompt_version_label TEXT NOT NULL CHECK (length(prompt_version_label) BETWEEN 1 AND 128),
  model_reference JSONB NOT NULL,
  output_size TEXT,
  provider_request_id TEXT UNIQUE,
  finalizer_job_id TEXT UNIQUE,
  provider_output_asset_id UUID UNIQUE REFERENCES media_asset(id),
  normalized_media_asset_id UUID UNIQUE REFERENCES media_asset(id),
  image_candidate_id UUID UNIQUE REFERENCES image_candidate(id),
  qa_report_id UUID UNIQUE REFERENCES qa_report(id),
  processing_policy_version TEXT CHECK (
    processing_policy_version IS NULL OR length(processing_policy_version) BETWEEN 1 AND 128
  ),
  processor_version TEXT CHECK (
    processor_version IS NULL OR length(processor_version) BETWEEN 1 AND 128
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending', 'provider_calling', 'provider_archived', 'processed',
      'qa_passed', 'qa_failed', 'reconciliation_required', 'dead'
    )
  ),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, kind, generation_attempt),
  CHECK (
    (kind = 'awake' AND source_photo_revision_id IS NOT NULL AND parent_awake_candidate_id IS NULL)
    OR
    (kind = 'sleep' AND source_photo_revision_id IS NULL AND parent_awake_candidate_id IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('provider_archived', 'processed', 'qa_passed', 'qa_failed')
    OR provider_output_asset_id IS NOT NULL
  ),
  CHECK (
    status NOT IN ('processed', 'qa_passed', 'qa_failed')
    OR (
      normalized_media_asset_id IS NOT NULL
      AND image_candidate_id IS NOT NULL
      AND qa_report_id IS NOT NULL
      AND finalizer_job_id IS NOT NULL
      AND processing_policy_version IS NOT NULL
      AND processor_version IS NOT NULL
    )
  ),
  FOREIGN KEY (run_id, project_id, order_id)
    REFERENCES production_run(id, project_id, order_id),
  FOREIGN KEY (parent_awake_candidate_id, project_id, run_id)
    REFERENCES image_candidate(id, project_id, run_id),
  FOREIGN KEY (image_candidate_id, project_id, run_id)
    REFERENCES image_candidate(id, project_id, run_id),
  FOREIGN KEY (provider_output_asset_id, project_id, run_id)
    REFERENCES media_asset(id, project_id, run_id),
  FOREIGN KEY (normalized_media_asset_id, project_id, run_id)
    REFERENCES media_asset(id, project_id, run_id),
  FOREIGN KEY (qa_report_id, project_id, run_id)
    REFERENCES qa_report(id, project_id, run_id)
);

CREATE INDEX master_image_generation_run_status_idx
  ON master_image_generation (run_id, kind, generation_attempt DESC, status);

CREATE INDEX master_image_generation_reconciliation_idx
  ON master_image_generation (status, updated_at)
  WHERE status IN ('reconciliation_required', 'dead');
