-- payment_event.provider_event_id used the regex bound {1,256}, but
-- PostgreSQL caps regex repetition counts at 255. The constraint only
-- evaluates when provider_event_id is non-NULL, which happens exclusively
-- on provider webhook notifications - so every Kaipay webhook failed with
-- "invalid regular expression" while all other payment events inserted
-- fine. Express the same 1..256-character rule with char_length instead.

ALTER TABLE payment_event
  DROP CONSTRAINT payment_event_provider_event_id_check,
  ADD CONSTRAINT payment_event_provider_event_id_check
    CHECK (provider_event_id IS NULL OR (
      char_length(provider_event_id) BETWEEN 1 AND 256
      AND provider_event_id ~ '^[A-Za-z0-9._:/-]+$'
    ));
