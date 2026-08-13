-- Passwordless mainland-China phone identity for PetPack Studio.
-- Tencent CloudBase owns the verified phone number and OTP lifecycle. The
-- application stores only its opaque provider subject and a local session
-- hash; plaintext phone numbers and CloudBase access/refresh tokens are not
-- persisted in PostgreSQL.

CREATE TABLE auth_identity (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(id),
  provider TEXT NOT NULL CHECK (provider = 'TENCENT_CLOUDBASE'),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 3 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider)
);
CREATE INDEX auth_identity_user_idx ON auth_identity (user_id);

ALTER TABLE auth_session
  ADD COLUMN auth_policy_version TEXT NOT NULL
  CHECK (length(auth_policy_version) BETWEEN 2 AND 128);

CREATE INDEX auth_session_expiry_idx
  ON auth_session (expires_at)
  WHERE revoked_at IS NULL;
