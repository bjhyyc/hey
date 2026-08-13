-- PetPack Studio package build, validation, and delivery provenance
-- (requires migrations 001 through 005).
--
-- A final_petpack object is the immutable byte-for-byte package candidate. It
-- is not deliverable merely because it exists: the petpack_build status and
-- both QA bindings below must be validated before a delivery row may be made
-- ready. This avoids copying the same archive into a second storage key after
-- validation while keeping the release gate explicit.

CREATE TABLE petpack_input_snapshot (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES production_run(id),
  revision_sha256 TEXT NOT NULL UNIQUE CHECK (revision_sha256 ~ '^[a-f0-9]{64}$'),
  package_name TEXT NOT NULL CHECK (length(package_name) BETWEEN 1 AND 256),
  action_count SMALLINT NOT NULL CHECK (action_count = 7),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, run_id)
);

CREATE TABLE petpack_input_action (
  snapshot_id UUID NOT NULL REFERENCES petpack_input_snapshot(id),
  action_id TEXT NOT NULL CHECK (
    action_id IN ('idle', 'sneeze', 'roll', 'sleep-transition', 'sleep-loop', 'stretch', 'hover-attention')
  ),
  generation_action_id UUID NOT NULL UNIQUE REFERENCES generation_action(id),
  media_asset_id UUID NOT NULL UNIQUE REFERENCES media_asset(id),
  qa_report_id UUID NOT NULL UNIQUE REFERENCES qa_report(id),
  prompt_version_id UUID NOT NULL REFERENCES prompt_version(id),
  prompt_version_label TEXT NOT NULL,
  media_sha256 TEXT NOT NULL CHECK (media_sha256 ~ '^[a-f0-9]{64}$'),
  processing_policy_version TEXT NOT NULL CHECK (length(processing_policy_version) BETWEEN 1 AND 128),
  processor_version TEXT NOT NULL CHECK (length(processor_version) BETWEEN 1 AND 128),
  PRIMARY KEY (snapshot_id, action_id)
);

CREATE INDEX petpack_input_action_snapshot_idx
  ON petpack_input_action (snapshot_id, action_id);

ALTER TABLE petpack_build
  ADD COLUMN project_id UUID,
  ADD COLUMN order_id UUID,
  ADD COLUMN input_snapshot_id UUID UNIQUE REFERENCES petpack_input_snapshot(id),
  ADD COLUMN status TEXT NOT NULL DEFAULT 'legacy_unverified' CHECK (
    status IN ('legacy_unverified', 'built', 'validating', 'validated', 'validation_failed')
  ),
  ADD COLUMN builder_version TEXT,
  ADD COLUMN build_report JSONB,
  ADD COLUMN package_qa_report_id UUID UNIQUE REFERENCES qa_report(id),
  ADD COLUMN import_qa_report_id UUID UNIQUE REFERENCES qa_report(id),
  ADD COLUMN validator_identity TEXT,
  ADD COLUMN validator_version TEXT,
  ADD COLUMN validation_policy_version TEXT,
  ADD COLUMN failure_code TEXT,
  ADD COLUMN validated_at TIMESTAMPTZ,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE petpack_build build
   SET project_id = run.project_id,
       order_id = run.order_id
  FROM production_run run
 WHERE run.id = build.run_id;

ALTER TABLE petpack_build
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN order_id SET NOT NULL,
  ADD CONSTRAINT petpack_build_project_fk FOREIGN KEY (project_id) REFERENCES pet_project(id),
  ADD CONSTRAINT petpack_build_order_fk FOREIGN KEY (order_id) REFERENCES customer_order(id),
  ADD CONSTRAINT petpack_build_id_order_unique UNIQUE (id, order_id);

ALTER TABLE production_run
  ADD CONSTRAINT production_run_id_project_order_unique UNIQUE (id, project_id, order_id);

ALTER TABLE customer_order
  ADD CONSTRAINT customer_order_id_project_unique UNIQUE (id, project_id);

ALTER TABLE production_run
  ADD CONSTRAINT production_run_order_project_fk
    FOREIGN KEY (order_id, project_id) REFERENCES customer_order(id, project_id) NOT VALID;

ALTER TABLE media_asset
  ADD CONSTRAINT media_asset_id_project_run_unique UNIQUE (id, project_id, run_id);

ALTER TABLE petpack_build
  ADD CONSTRAINT petpack_build_run_ownership_fk
    FOREIGN KEY (run_id, project_id, order_id) REFERENCES production_run(id, project_id, order_id) NOT VALID,
  ADD CONSTRAINT petpack_build_media_ownership_fk
    FOREIGN KEY (media_asset_id, project_id, run_id) REFERENCES media_asset(id, project_id, run_id) NOT VALID,
  ADD CONSTRAINT petpack_build_input_snapshot_ownership_fk
    FOREIGN KEY (input_snapshot_id, run_id) REFERENCES petpack_input_snapshot(id, run_id) NOT VALID,
  ADD CONSTRAINT petpack_build_id_project_run_unique UNIQUE (id, project_id, run_id);

ALTER TABLE petpack_build
  ADD CONSTRAINT petpack_build_new_provenance_ck CHECK (
    status = 'legacy_unverified' OR (
      input_snapshot_id IS NOT NULL AND
      builder_version IS NOT NULL AND
      build_report IS NOT NULL AND
      jsonb_typeof(build_report) = 'object' AND
      validator_identity IS NOT NULL AND
      validator_version IS NOT NULL AND
      validation_policy_version IS NOT NULL
    )
  ),
  ADD CONSTRAINT petpack_build_validation_evidence_ck CHECK (
    status <> 'validated' OR (
      input_snapshot_id IS NOT NULL AND
      package_qa_report_id IS NOT NULL AND
      import_qa_report_id IS NOT NULL AND
      package_qa_report_id <> import_qa_report_id AND
      validator_identity IS NOT NULL AND
      validator_version IS NOT NULL AND
      validation_policy_version IS NOT NULL AND
      original_import_verified_at IS NOT NULL AND
      customized_interactions_verified_at IS NOT NULL AND
      validated_at IS NOT NULL AND
      failure_code IS NULL
    )
  ),
  ADD CONSTRAINT petpack_build_failure_evidence_ck CHECK (
    status <> 'validation_failed' OR failure_code IS NOT NULL
  );

ALTER TABLE qa_report
  ADD COLUMN petpack_build_id UUID REFERENCES petpack_build(id),
  ADD COLUMN validator_version TEXT;

ALTER TABLE qa_report
  ADD CONSTRAINT qa_report_package_build_ownership_fk
    FOREIGN KEY (petpack_build_id, project_id, run_id)
    REFERENCES petpack_build(id, project_id, run_id) NOT VALID;

ALTER TABLE qa_report
  ADD CONSTRAINT qa_report_package_provenance_ck CHECK (
    subject_kind NOT IN ('petpack', 'desktop_import') OR (
      project_id IS NOT NULL AND
      run_id IS NOT NULL AND
      action_id IS NULL AND
      source_media_asset_id IS NULL AND
      subject_media_asset_id IS NOT NULL AND
      petpack_build_id IS NOT NULL AND
      validator_version IS NOT NULL
    )
  ) NOT VALID;

CREATE UNIQUE INDEX qa_report_package_build_kind_passed_unique_idx
  ON qa_report (petpack_build_id, subject_kind)
  WHERE status = 'passed' AND subject_kind IN ('petpack', 'desktop_import');

ALTER TABLE delivery
  ADD CONSTRAINT delivery_build_order_fk
    FOREIGN KEY (petpack_build_id, order_id) REFERENCES petpack_build(id, order_id) NOT VALID;

CREATE UNIQUE INDEX production_run_event_result_version_unique_idx
  ON production_run_event (run_id, resulting_version);

CREATE UNIQUE INDEX production_job_execution_run_package_stage_unique_idx
  ON production_job_execution (run_id, job_name)
  WHERE action_id IS NULL AND job_name IN (
    'petpack.process-media', 'petpack.build-package',
    'petpack.validate-package', 'petpack.prepare-delivery'
  );

CREATE INDEX petpack_build_release_gate_idx
  ON petpack_build (run_id, status, validated_at)
  WHERE status = 'validated';
