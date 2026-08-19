-- Photo pre-check: a vision-model verdict over a candidate photo set, issued
-- BEFORE payment. Checkout and post-payment upload grants verify against these
-- rows, so garbage photo sets can no longer buy a production run.
CREATE TABLE photo_precheck (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(id),
  species TEXT NOT NULL CHECK (species IN ('cat', 'dog')),
  -- SHA-256 over "<species>:" + comma-joined sorted original-photo digests.
  -- Globally unique: the verdict is derived from photo content alone, so a
  -- repeat submission of the same set is a cache hit, not a new model call.
  fingerprint TEXT NOT NULL UNIQUE CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  photo_sha256s JSONB NOT NULL,
  verdicts JSONB NOT NULL,
  passed BOOLEAN NOT NULL,
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  prompt_version TEXT NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX photo_precheck_user_recent_idx ON photo_precheck (user_id, created_at DESC);
