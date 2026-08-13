-- PetPack Studio transactional workflow additions (requires 001_petpack_studio.sql)
-- No prompts, provider credentials, price, or customer media are seeded here.

CREATE TABLE production_run_event (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES production_run(id),
  previous_state production_state,
  next_state production_state NOT NULL,
  expected_version INTEGER,
  resulting_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX production_run_event_run_idx ON production_run_event (run_id, created_at DESC);

-- Both the initial awake render and later user-requested regeneration must
-- have distinct, durable request revisions. This prevents a legitimate retry
-- from colliding with an already-sent outbox dedupe key.
ALTER TABLE production_run
  ADD COLUMN awake_generation_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (awake_generation_attempts >= 0);

-- These object-key references make `awaiting_prompt_gate` recoverable after a
-- prompt publication fix or a process crash. They are immutable per run: a
-- new master pair is a new generation attempt, not a silent replacement.
CREATE TABLE production_run_master_frame (
  run_id UUID PRIMARY KEY REFERENCES production_run(id),
  awake_master_object_key TEXT NOT NULL CHECK (awake_master_object_key LIKE 'private/%'),
  sleep_master_object_key TEXT NOT NULL CHECK (sleep_master_object_key LIKE 'private/%'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `generation_action` is the concurrency authority for the seven independent
-- video workers. The JSON `completedActions` field used by the pure domain
-- model is deliberately not persisted as an authoritative mutable set.
CREATE INDEX generation_action_run_state_idx ON generation_action (run_id, state, action_id);

ALTER TABLE media_asset
  ADD CONSTRAINT media_asset_run_fk
  FOREIGN KEY (run_id) REFERENCES production_run(id);

-- `outbox_job` is written in the same transaction as a run transition and is
-- later leased with FOR UPDATE SKIP LOCKED by the queue dispatcher. Its unique
-- dedupe key is also passed to BullMQ as `options.jobId`.
DROP INDEX IF EXISTS outbox_job_dispatch_idx;
CREATE INDEX outbox_job_dispatch_idx
  ON outbox_job (status, available_at, leased_until)
  WHERE status IN ('pending', 'failed', 'leased');

ALTER TABLE outbox_job
  ADD COLUMN lease_token UUID,
  ADD COLUMN last_error_code TEXT;

-- A terminal `dead` state prevents a permanently failing queue message from
-- hot-looping forever. Operators can inspect it and explicitly replay only
-- after fixing the underlying condition.
ALTER TABLE outbox_job
  DROP CONSTRAINT IF EXISTS outbox_job_status_check,
  ADD CONSTRAINT outbox_job_status_check
  CHECK (status IN ('pending', 'leased', 'sent', 'failed', 'dead'));
