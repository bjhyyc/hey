-- A precheck row was one-per-photo-set: `fingerprint` carried a UNIQUE
-- constraint so a repeat submission became a cache hit that returned the
-- ORIGINAL row's id. Checkout, however, requires a verdict issued to this
-- customer within the last 24 hours, so any photo set checked more than a day
-- earlier - or first checked by somebody else - passed the pre-check screen and
-- was then refused at checkout with "需要先通过照片预检才能下单".
--
-- The verdict is still derived from photo content alone, so the cache stays:
-- what changes is that a cache hit may now be re-issued as a fresh row for the
-- asking customer. That needs many rows per fingerprint, so the uniqueness goes
-- and an index takes over for the lookup, which now reads the newest row.
ALTER TABLE photo_precheck DROP CONSTRAINT photo_precheck_fingerprint_key;
CREATE INDEX photo_precheck_fingerprint_recent_idx ON photo_precheck (fingerprint, created_at DESC);
