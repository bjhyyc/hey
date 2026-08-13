-- PetPack Studio immutable provider-usage ledger and dry-run retention holds
-- (requires migrations 001 through 007).
--
-- This migration deliberately publishes no ModelArk price. A complete account
-- contract must be inserted as one immutable card plus its rates before a
-- provider attempt can be priced. Provider identifiers stay server-side and
-- must never be selected by an administrator-facing projection.

CREATE TABLE provider_price_card (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'MODELARK'),
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
  currency TEXT NOT NULL CHECK (currency = 'CNY'),
  source_contract_reference TEXT NOT NULL CHECK (length(source_contract_reference) BETWEEN 1 AND 512),
  effective_from TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES app_user(id),
  published_at TIMESTAMPTZ,
  UNIQUE (provider, version),
  UNIQUE (provider, effective_from),
  UNIQUE (id, provider)
);

CREATE TABLE provider_price_rate (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES provider_price_card(id),
  rate_code TEXT NOT NULL CHECK (length(rate_code) BETWEEN 1 AND 128),
  operation TEXT NOT NULL CHECK (
    operation IN ('seedream_awake', 'seedream_sleep', 'seedance_video')
  ),
  model_registry_version TEXT NOT NULL CHECK (length(model_registry_version) BETWEEN 1 AND 128),
  endpoint_id TEXT NOT NULL CHECK (length(endpoint_id) BETWEEN 1 AND 256),
  resolution TEXT,
  output_size TEXT,
  duration_seconds NUMERIC(12, 4) CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  billing_trigger TEXT NOT NULL CHECK (
    billing_trigger IN ('provider_accepted', 'output_succeeded', 'invoice_reconciled')
  ),
  billing_unit TEXT NOT NULL CHECK (
    billing_unit IN ('request', 'output', 'requested_second')
  ),
  unit_quantity NUMERIC(20, 8) NOT NULL CHECK (unit_quantity > 0),
  unit_price_cny NUMERIC(20, 8) NOT NULL CHECK (unit_price_cny >= 0),
  rounding_mode TEXT NOT NULL CHECK (rounding_mode IN ('exact', 'half_up_8', 'ceiling_8')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_id, rate_code)
);

-- PostgreSQL 15's NULLS NOT DISTINCT prevents two apparently different rate
-- rows from silently double-billing the same immutable request dimensions.
CREATE UNIQUE INDEX provider_price_rate_scope_unique_idx
  ON provider_price_rate (
    card_id, operation, model_registry_version, endpoint_id,
    resolution, output_size, duration_seconds, billing_trigger, billing_unit
  ) NULLS NOT DISTINCT;

CREATE TABLE provider_usage_attempt (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'MODELARK'),
  internal_request_id TEXT NOT NULL CHECK (length(internal_request_id) BETWEEN 1 AND 512),
  project_id UUID NOT NULL REFERENCES pet_project(id),
  order_id UUID NOT NULL REFERENCES customer_order(id),
  run_id UUID NOT NULL REFERENCES production_run(id),
  master_image_generation_id UUID REFERENCES master_image_generation(id),
  generation_action_id UUID REFERENCES generation_action(id),
  action_id TEXT CHECK (
    action_id IS NULL OR action_id IN (
      'idle', 'sneeze', 'roll', 'sleep-transition', 'sleep-loop', 'stretch', 'hover-attention'
    )
  ),
  operation TEXT NOT NULL CHECK (
    operation IN ('seedream_awake', 'seedream_sleep', 'seedance_video')
  ),
  worker_attempt INTEGER NOT NULL CHECK (worker_attempt > 0),
  model_registry_version TEXT NOT NULL CHECK (length(model_registry_version) BETWEEN 1 AND 128),
  endpoint_id TEXT NOT NULL CHECK (length(endpoint_id) BETWEEN 1 AND 256),
  resolution TEXT,
  output_size TEXT,
  requested_duration_seconds NUMERIC(12, 4) CHECK (
    requested_duration_seconds IS NULL OR requested_duration_seconds > 0
  ),
  requested_output_count INTEGER NOT NULL DEFAULT 1 CHECK (requested_output_count > 0),
  price_card_id UUID REFERENCES provider_price_card(id),
  expected_billable_rate_count INTEGER NOT NULL CHECK (expected_billable_rate_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, internal_request_id),
  UNIQUE (master_image_generation_id, worker_attempt),
  UNIQUE (generation_action_id, worker_attempt),
  CHECK (num_nonnulls(master_image_generation_id, generation_action_id) = 1),
  CHECK (
    (operation IN ('seedream_awake', 'seedream_sleep')
      AND master_image_generation_id IS NOT NULL AND generation_action_id IS NULL AND action_id IS NULL)
    OR
    (operation = 'seedance_video'
      AND master_image_generation_id IS NULL AND generation_action_id IS NOT NULL AND action_id IS NOT NULL)
  ),
  FOREIGN KEY (run_id, project_id, order_id)
    REFERENCES production_run(id, project_id, order_id)
);

CREATE TABLE provider_usage_event (
  id UUID PRIMARY KEY,
  sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
  attempt_id UUID NOT NULL REFERENCES provider_usage_attempt(id),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'provider_accepted', 'explicitly_rejected', 'submission_unknown',
      'provider_status_unknown', 'provider_failed', 'output_succeeded',
      'invoice_reconciled', 'billing_unpriced', 'billing_applied', 'billing_adjustment'
    )
  ),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  provider_task_id TEXT,
  reason_code TEXT,
  output_count INTEGER CHECK (output_count IS NULL OR output_count > 0),
  price_rate_id UUID REFERENCES provider_price_rate(id),
  quantity NUMERIC(20, 8),
  cost_delta_cny NUMERIC(24, 8),
  currency TEXT CHECK (currency IS NULL OR currency = 'CNY'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (event_type = 'provider_accepted' AND price_rate_id IS NULL AND quantity IS NULL
      AND cost_delta_cny IS NULL AND currency IS NULL)
    OR
    (event_type IN (
        'explicitly_rejected', 'submission_unknown', 'provider_status_unknown',
        'provider_failed', 'output_succeeded', 'invoice_reconciled', 'billing_unpriced'
      )
      AND provider_task_id IS NULL AND price_rate_id IS NULL AND quantity IS NULL
      AND cost_delta_cny IS NULL AND currency IS NULL)
    OR
    (event_type = 'billing_applied' AND provider_task_id IS NULL AND price_rate_id IS NOT NULL
      AND quantity > 0 AND cost_delta_cny >= 0 AND currency = 'CNY')
    OR
    (event_type = 'billing_adjustment' AND provider_task_id IS NULL AND price_rate_id IS NOT NULL
      AND quantity IS NOT NULL AND cost_delta_cny <> 0 AND currency = 'CNY')
  )
);

CREATE UNIQUE INDEX provider_usage_event_task_unique_idx
  ON provider_usage_event (provider_task_id)
  WHERE event_type = 'provider_accepted' AND provider_task_id IS NOT NULL;

CREATE UNIQUE INDEX provider_usage_event_billing_unique_idx
  ON provider_usage_event (attempt_id, price_rate_id, event_type)
  WHERE event_type = 'billing_applied';

CREATE INDEX provider_usage_attempt_admin_summary_idx
  ON provider_usage_attempt (created_at, operation, action_id);

CREATE INDEX provider_usage_event_attempt_timeline_idx
  ON provider_usage_event (attempt_id, sequence_id);

-- Provider task identifiers must never alias two video actions, independently
-- of whether a usage summary is queried.
CREATE UNIQUE INDEX generation_action_provider_task_unique_idx
  ON generation_action (provider_task_id)
  WHERE provider_task_id IS NOT NULL;

CREATE FUNCTION reject_immutable_provider_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable provider accounting records cannot be updated or deleted';
END;
$$;

CREATE FUNCTION enforce_provider_price_card_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider price cards cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'provider price cards must be assembled before publication';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'published provider price cards are immutable';
  END IF;
  IF ROW(NEW.id, NEW.provider, NEW.version, NEW.currency, NEW.source_contract_reference,
         NEW.effective_from, NEW.created_by)
       IS DISTINCT FROM
     ROW(OLD.id, OLD.provider, OLD.version, OLD.currency, OLD.source_contract_reference,
         OLD.effective_from, OLD.created_by) OR NEW.published_at IS NULL THEN
    RAISE EXCEPTION 'provider price cards may only transition once from draft to published';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_rate_insert_into_published_card()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM provider_price_card card
   WHERE card.id = NEW.card_id AND card.published_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider price rates require an existing unpublished card';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_price_card_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON provider_price_card
  FOR EACH ROW EXECUTE FUNCTION enforce_provider_price_card_lifecycle();
CREATE TRIGGER provider_price_rate_immutable
  BEFORE UPDATE OR DELETE ON provider_price_rate
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_provider_record_mutation();
CREATE TRIGGER provider_price_rate_draft_only
  BEFORE INSERT ON provider_price_rate
  FOR EACH ROW EXECUTE FUNCTION reject_rate_insert_into_published_card();
CREATE TRIGGER provider_usage_attempt_immutable
  BEFORE UPDATE OR DELETE ON provider_usage_attempt
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_provider_record_mutation();
CREATE TRIGGER provider_usage_event_immutable
  BEFORE UPDATE OR DELETE ON provider_usage_event
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_provider_record_mutation();

-- Holds are evaluated by the Stage 7 planner. There is deliberately no object
-- deletion function, queue job, or storage DELETE permission in this schema.
CREATE TABLE retention_hold (
  id UUID PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('media_asset', 'project', 'order', 'run')),
  media_asset_id UUID REFERENCES media_asset(id),
  project_id UUID REFERENCES pet_project(id),
  order_id UUID REFERENCES customer_order(id),
  run_id UUID REFERENCES production_run(id),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  created_by UUID NOT NULL REFERENCES app_user(id),
  released_by UUID REFERENCES app_user(id),
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(media_asset_id, project_id, order_id, run_id) = 1),
  CHECK (
    (scope_kind = 'media_asset' AND media_asset_id IS NOT NULL)
    OR (scope_kind = 'project' AND project_id IS NOT NULL)
    OR (scope_kind = 'order' AND order_id IS NOT NULL)
    OR (scope_kind = 'run' AND run_id IS NOT NULL)
  ),
  CHECK ((released_at IS NULL) = (released_by IS NULL)),
  CHECK (released_at IS NULL OR released_at >= created_at)
);

CREATE INDEX retention_hold_active_scope_idx
  ON retention_hold (scope_kind, media_asset_id, project_id, order_id, run_id)
  WHERE released_at IS NULL;

CREATE TABLE retention_hold_event (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hold_id UUID NOT NULL REFERENCES retention_hold(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('placed', 'released')),
  actor_id UUID NOT NULL REFERENCES app_user(id),
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (hold_id, event_type)
);

CREATE FUNCTION enforce_retention_hold_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retention holds cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL OR NEW.released_by IS NOT NULL THEN
      RAISE EXCEPTION 'retention holds must be created active';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'released retention holds are immutable';
  END IF;
  IF ROW(NEW.id, NEW.scope_kind, NEW.media_asset_id, NEW.project_id, NEW.order_id,
         NEW.run_id, NEW.reason_code, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
     ROW(OLD.id, OLD.scope_kind, OLD.media_asset_id, OLD.project_id, OLD.order_id,
         OLD.run_id, OLD.reason_code, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'retention hold scope and provenance are immutable';
  END IF;
  IF NEW.released_at IS NULL OR NEW.released_by IS NULL THEN
    RAISE EXCEPTION 'retention holds may only transition once from active to released';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION append_retention_hold_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO retention_hold_event (hold_id, event_type, actor_id, occurred_at)
    VALUES (NEW.id, 'placed', NEW.created_by, NEW.created_at);
  ELSE
    INSERT INTO retention_hold_event (hold_id, event_type, actor_id, occurred_at)
    VALUES (NEW.id, 'released', NEW.released_by, NEW.released_at);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_retention_hold_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'retention hold events are immutable';
END;
$$;

CREATE TRIGGER retention_hold_lifecycle_guard
  BEFORE INSERT OR UPDATE OR DELETE ON retention_hold
  FOR EACH ROW EXECUTE FUNCTION enforce_retention_hold_lifecycle();
CREATE TRIGGER retention_hold_event_append
  AFTER INSERT OR UPDATE ON retention_hold
  FOR EACH ROW EXECUTE FUNCTION append_retention_hold_event();
CREATE TRIGGER retention_hold_event_immutable
  BEFORE UPDATE OR DELETE ON retention_hold_event
  FOR EACH ROW EXECUTE FUNCTION reject_retention_hold_event_mutation();
