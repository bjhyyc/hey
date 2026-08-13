-- PetPack Studio per-action media processing (requires migrations 001 through 004)

ALTER TABLE generation_action
  ADD COLUMN provider_output_asset_id UUID REFERENCES media_asset(id),
  ADD COLUMN processing_policy_version TEXT CHECK (
    processing_policy_version IS NULL OR length(processing_policy_version) BETWEEN 1 AND 128
  ),
  ADD COLUMN processor_version TEXT CHECK (
    processor_version IS NULL OR length(processor_version) BETWEEN 1 AND 128
  );

ALTER TABLE qa_report
  ADD COLUMN source_media_asset_id UUID REFERENCES media_asset(id),
  ADD COLUMN subject_media_asset_id UUID REFERENCES media_asset(id),
  ADD COLUMN processor_version TEXT CHECK (
    processor_version IS NULL OR length(processor_version) BETWEEN 1 AND 128
  );

CREATE UNIQUE INDEX qa_report_video_subject_unique_idx
  ON qa_report (subject_media_asset_id)
  WHERE subject_kind = 'video' AND subject_media_asset_id IS NOT NULL;

-- Preserve any provider-output relationship written by the earlier polling
-- migration before this dedicated source/final split is introduced.
UPDATE generation_action action
   SET provider_output_asset_id = action.media_asset_id
  FROM media_asset asset
 WHERE asset.id = action.media_asset_id
   AND asset.kind = 'provider_output'
   AND action.provider_output_asset_id IS NULL;

-- The legacy poller used media_asset_id for the archived provider file. From
-- this migration onward that column is reserved for the QA-passed final WebM.
UPDATE generation_action action
   SET media_asset_id = NULL
  FROM media_asset asset
 WHERE asset.id = action.media_asset_id
   AND asset.kind = 'provider_output'
   AND action.provider_output_asset_id = asset.id;

ALTER TABLE generation_action
  ADD CONSTRAINT generation_action_distinct_source_final_ck CHECK (
    provider_output_asset_id IS NULL OR media_asset_id IS NULL OR provider_output_asset_id <> media_asset_id
  ),
  ADD CONSTRAINT generation_action_source_state_ck CHECK (
    state NOT IN ('succeeded', 'processed', 'qa_passed') OR provider_output_asset_id IS NOT NULL
  ),
  ADD CONSTRAINT generation_action_processed_state_ck CHECK (
    state NOT IN ('processed', 'qa_passed') OR (
      media_asset_id IS NOT NULL AND qa_report_id IS NOT NULL AND
      processing_policy_version IS NOT NULL AND processor_version IS NOT NULL
    )
  );

CREATE UNIQUE INDEX generation_action_provider_output_asset_unique_idx
  ON generation_action (provider_output_asset_id)
  WHERE provider_output_asset_id IS NOT NULL;

CREATE UNIQUE INDEX generation_action_final_media_asset_unique_idx
  ON generation_action (media_asset_id)
  WHERE media_asset_id IS NOT NULL;

CREATE INDEX generation_action_processing_source_idx
  ON generation_action (run_id, state, action_id, provider_output_asset_id)
  WHERE state IN ('succeeded', 'processed');
