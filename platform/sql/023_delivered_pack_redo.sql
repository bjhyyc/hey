-- A delivered pack can be remade when a customer reports one bad clip.
--
-- Until now a run produced exactly one pack, permanently. petpack_build was
-- refused if the run already had one, and petpack_input_snapshot is UNIQUE per
-- run while petpack_input_action binds each clip's generation_action,
-- media_asset and qa_report with GLOBAL uniques - so a second snapshot could
-- never be written beside the first, because six of the seven clips are the
-- very same rows. That immutability is right for the pipeline: it stops a
-- half-finished second pass from overwriting a good pack. It also left a
-- customer complaint ("the sleeping belly heaves") with no remedy but a refund.
--
-- The redo steps the old pack aside instead of pretending it never happened.
-- Its build row is marked superseded and keeps everything that attests the
-- bytes already delivered - manifest, sha256, builder and validator versions,
-- both QA reports - while the input snapshot it was frozen from is deleted so
-- the run can freeze a new one. The delivery row keeps pointing at the
-- superseded build until the replacement validates, so the customer's existing
-- download never breaks part-way through the redo.
ALTER TABLE petpack_build
  DROP CONSTRAINT petpack_build_status_check,
  DROP CONSTRAINT petpack_build_new_provenance_ck;

ALTER TABLE petpack_build
  ADD CONSTRAINT petpack_build_status_check CHECK (
    status IN ('legacy_unverified', 'built', 'validating', 'validated', 'validation_failed', 'superseded')
  ),
  -- A superseded build no longer owns an input snapshot (it was deleted so the
  -- run could freeze the replacement), but every other piece of its provenance
  -- must still be there.
  ADD CONSTRAINT petpack_build_new_provenance_ck CHECK (
    status = 'legacy_unverified' OR (
      (input_snapshot_id IS NOT NULL OR status = 'superseded') AND
      builder_version IS NOT NULL AND
      build_report IS NOT NULL AND
      jsonb_typeof(build_report) = 'object' AND
      validator_identity IS NOT NULL AND
      validator_version IS NOT NULL AND
      validation_policy_version IS NOT NULL
    )
  );

-- One build in flight or current per run; superseded ones stay for provenance
-- and are stepped over by the builder's "this run already built" guard.
CREATE UNIQUE INDEX petpack_build_active_run_idx
  ON petpack_build (run_id)
  WHERE status <> 'superseded';
