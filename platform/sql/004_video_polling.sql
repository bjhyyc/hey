-- PetPack Studio Seedance polling state (requires migrations 001 through 003)

ALTER TABLE generation_action
  ADD COLUMN provider_poll_count INTEGER NOT NULL DEFAULT 0
  CHECK (provider_poll_count >= 0);

CREATE INDEX generation_action_provider_poll_idx
  ON generation_action (state, provider_poll_count, updated_at)
  WHERE provider_task_id IS NOT NULL AND state = 'running';
