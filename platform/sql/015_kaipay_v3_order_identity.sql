-- Freeze the Kaipay Pay API V3 credential and payment route used for each
-- external order. Historical EPay V1 and Alipay rows remain readable with
-- NULL V3 metadata; all new V3 attempts/events must carry immutable identity.

ALTER TABLE payment_attempt
  ADD COLUMN credential_version TEXT,
  ADD COLUMN payment_channel TEXT,
  ADD COLUMN provider_code TEXT,
  ADD COLUMN payment_scene TEXT,
  ADD CONSTRAINT payment_attempt_credential_version_check
    CHECK (credential_version IS NULL OR credential_version ~ '^kpv3-[a-f0-9]{64}$'),
  ADD CONSTRAINT payment_attempt_channel_check
    CHECK (payment_channel IS NULL OR payment_channel IN ('ALIPAY', 'WXPAY')),
  ADD CONSTRAINT payment_attempt_provider_code_check
    CHECK (provider_code IS NULL OR provider_code IN ('alipay', 'wechat')),
  ADD CONSTRAINT payment_attempt_scene_check
    CHECK (payment_scene IS NULL OR payment_scene IN ('web', 'native')),
  ADD CONSTRAINT payment_attempt_v3_identity_check
    CHECK (
      adapter_version NOT LIKE 'kaipay-pay-api-v3-%' OR
      (
        credential_version IS NOT NULL AND
        (
          (payment_channel = 'ALIPAY' AND provider_code = 'alipay' AND payment_scene IN ('web', 'native')) OR
          (payment_channel = 'WXPAY' AND provider_code = 'wechat' AND payment_scene = 'native')
        )
      )
    );

ALTER TABLE payment_event
  ADD COLUMN credential_version TEXT,
  ADD COLUMN provider_event_id TEXT,
  ADD CONSTRAINT payment_event_credential_version_check
    CHECK (credential_version IS NULL OR credential_version ~ '^kpv3-[a-f0-9]{64}$'),
  ADD CONSTRAINT payment_event_provider_event_id_check
    CHECK (provider_event_id IS NULL OR provider_event_id ~ '^[A-Za-z0-9._:/-]{1,256}$'),
  ADD CONSTRAINT payment_event_v3_credential_check
    CHECK (adapter_version NOT LIKE 'kaipay-pay-api-v3-%' OR credential_version IS NOT NULL);

CREATE UNIQUE INDEX payment_event_provider_event_unique_idx
  ON payment_event (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
