-- The first real delivered-pack redo died here, and the reason is worth
-- stating plainly: migration 023 gave a run a second build by superseding the
-- first, but petpack_build still carried a FULL UNIQUE (run_id). The builder
-- upserts with ON CONFLICT (run_id), so the superseded row - which still owned
-- that key - captured the conflict, the DO UPDATE guard requires status =
-- 'built', and the update matched nothing: "Production run already has a
-- different PetPack build".
--
-- The invariant that actually matters now is the one 023 introduced: a run has
-- at most one build that is not superseded. petpack_build_active_run_idx
-- enforces exactly that, so the full unique is redundant and, worse, wrong.
-- With it gone the builder infers on the partial index instead (repeating its
-- predicate, which is how PostgreSQL admits a partial index as an inference
-- target), so a redo inserts a fresh build while an ordinary retry of a live
-- build still upserts onto its own row.
ALTER TABLE petpack_build
  DROP CONSTRAINT petpack_build_run_id_key;
