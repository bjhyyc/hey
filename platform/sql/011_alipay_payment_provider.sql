-- Replace Yeepay with direct Alipay OpenAPI payments.
-- This migration intentionally fails closed if legacy WeChat/Yeepay payment
-- rows exist; reconcile or remove non-production test rows before applying it.

ALTER TABLE customer_order
  ADD CONSTRAINT customer_order_alipay_only_check
  CHECK (payment_method = 'ALIPAY');

ALTER TABLE payment_attempt
  DROP CONSTRAINT payment_attempt_provider_check;

ALTER TABLE payment_attempt
  ADD CONSTRAINT payment_attempt_provider_check
  CHECK (provider = 'ALIPAY');

ALTER TABLE payment_attempt
  ADD CONSTRAINT payment_attempt_alipay_only_check
  CHECK (payment_method = 'ALIPAY');
