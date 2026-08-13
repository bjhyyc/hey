-- PetPack Studio production-worker execution state (requires migrations 001 and 002)
-- This migration stores only durable identifiers and operational state. Prompt
-- text, signed URLs, provider responses, and credentials remain server-only.

ALTER TABLE generation_action
  ADD COLUMN provider_request_id TEXT;

CREATE UNIQUE INDEX generation_action_provider_request_idx
  ON generation_action (provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE TABLE production_job_execution (
  id UUID PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE CHECK (length(job_id) BETWEEN 1 AND 512),
  job_name TEXT NOT NULL CHECK (length(job_name) BETWEEN 1 AND 128),
  run_id UUID NOT NULL REFERENCES production_run(id),
  action_id TEXT CHECK (
    action_id IS NULL OR action_id IN (
      'idle', 'sneeze', 'roll', 'sleep-transition', 'sleep-loop', 'stretch', 'hover-attention'
    )
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'leased', 'retryable', 'succeeded', 'reconciliation_required', 'dead')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  lease_token UUID,
  lease_owner TEXT,
  leased_until TIMESTAMPTZ,
  last_error_code TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX production_job_execution_ready_idx
  ON production_job_execution (status, leased_until, updated_at)
  WHERE status IN ('pending', 'leased', 'retryable');

CREATE INDEX production_job_execution_run_idx
  ON production_job_execution (run_id, action_id, created_at DESC);
