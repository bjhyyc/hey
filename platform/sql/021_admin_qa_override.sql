-- A video action whose QA retries are spent can still hold a provider video a
-- human judges deliverable - the roll rescue of 2026-08-19 was exactly a good
-- video rejected by machinery. An administrator override authorizes ONE more
-- processing pass for a chosen rejected provider video, during which the QA
-- verdict is recorded but does not block.
--
-- The authorization must be durable on the action itself: it has to survive
-- queue redelivery, it must be visible to the processing claim, and it must be
-- consumed exactly once - a later regeneration must never silently inherit an
-- old override, so every reset path clears it.
ALTER TABLE generation_action
  ADD COLUMN admin_qa_override JSONB;
