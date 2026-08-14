-- Make Kaipay the only payment method accepted by the current application
-- while preserving already-recorded ALIPAY rows as immutable history.

ALTER TABLE customer_order
  DROP CONSTRAINT IF EXISTS customer_order_alipay_only_check;

ALTER TABLE customer_order
  ADD CONSTRAINT customer_order_payment_history_check
  CHECK (payment_method IN ('ALIPAY', 'KAIPAY'));

ALTER TABLE payment_attempt
  DROP CONSTRAINT IF EXISTS payment_attempt_provider_check;

ALTER TABLE payment_attempt
  DROP CONSTRAINT IF EXISTS payment_attempt_alipay_only_check;

ALTER TABLE payment_attempt
  ADD COLUMN adapter_version TEXT,
  ADD CONSTRAINT payment_attempt_adapter_version_check
    CHECK (adapter_version IS NULL OR adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$');

ALTER TABLE payment_attempt
  ADD CONSTRAINT payment_attempt_provider_method_history_check
  CHECK (
    (provider = 'ALIPAY' AND payment_method = 'ALIPAY') OR
    (provider = 'KAIPAY' AND payment_method = 'KAIPAY')
  ),
  ADD CONSTRAINT payment_attempt_kaipay_adapter_check
  CHECK (provider <> 'KAIPAY' OR adapter_version IS NOT NULL);

ALTER TABLE payment_event
  ADD COLUMN provider TEXT,
  ADD COLUMN adapter_version TEXT,
  ADD CONSTRAINT payment_event_provider_history_check
    CHECK (provider IS NULL OR provider IN ('ALIPAY', 'KAIPAY')),
  ADD CONSTRAINT payment_event_adapter_version_check
    CHECK (adapter_version IS NULL OR adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$'),
  ADD CONSTRAINT payment_event_kaipay_adapter_check
    CHECK (provider <> 'KAIPAY' OR adapter_version IS NOT NULL);
