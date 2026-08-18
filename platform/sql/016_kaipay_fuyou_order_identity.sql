-- Extend the immutable Kaipay Pay API V3 route identity with the wire-level
-- pay method returned by Kaipay. Migration 015 rows intentionally retain a
-- NULL pay_method; no historical payment record is rewritten by this change.

ALTER TABLE payment_attempt
  ADD COLUMN pay_method TEXT,
  DROP CONSTRAINT payment_attempt_provider_code_check,
  DROP CONSTRAINT payment_attempt_v3_identity_check,
  ADD CONSTRAINT payment_attempt_pay_method_check
    CHECK (pay_method IS NULL OR pay_method IN ('alipay', 'wechat')),
  ADD CONSTRAINT payment_attempt_provider_code_check
    CHECK (provider_code IS NULL OR provider_code IN ('alipay', 'wechat', 'fuyou')),
  ADD CONSTRAINT payment_attempt_v3_identity_check
    CHECK (
      adapter_version IS NULL OR
      adapter_version NOT LIKE 'kaipay-pay-api-v3-%' OR
      (
        credential_version IS NOT NULL AND
        (
          -- Rows written through migration 015 have no pay_method. Keep only
          -- the exact route identities that 015 already accepted.
          (
            pay_method IS NULL AND
            (
              (payment_channel = 'ALIPAY' AND provider_code = 'alipay' AND payment_scene IN ('web', 'native')) OR
              (payment_channel = 'WXPAY' AND provider_code = 'wechat' AND payment_scene = 'native')
            )
          ) OR
          -- Current Fuyou-routed orders must freeze all four wire identity
          -- values together. Legacy provider routes remain valid when Kaipay
          -- returns an explicit pay_method on a retry.
          (
            payment_channel = 'ALIPAY' AND pay_method = 'alipay' AND
            (
              (provider_code = 'alipay' AND payment_scene IN ('web', 'native')) OR
              (
                provider_code = 'fuyou' AND payment_scene = 'native' AND
                adapter_version = 'kaipay-pay-api-v3-hmac-sha256/1'
              )
            )
          ) OR
          (
            payment_channel = 'WXPAY' AND pay_method = 'wechat' AND
            payment_scene = 'native' AND
            (
              provider_code = 'wechat' OR
              (
                provider_code = 'fuyou' AND
                adapter_version = 'kaipay-pay-api-v3-hmac-sha256/1'
              )
            )
          )
        )
      ) IS TRUE
    );
