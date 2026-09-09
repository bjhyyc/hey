import { describe, expect, it } from "vitest";

import workerRepositoryModule from "../../platform/src/persistence/postgres-petpack-worker-repository.js";

// The last step of a delivered-pack redo, and the one that broke it. The
// delivery row is the customer's download: while the replacement pack is being
// made it keeps pointing at the superseded one, so nothing they hold ever goes
// away. When the new pack passes validation, the delivery moves across.
//
// The guard in front of that move used to read "the delivery must already point
// at this build", which is true of every delivery except the only one that
// needs to move. It failed with petpack_delivery_commit_failed, one step after
// the build commit and the validation claim had failed for the same underlying
// reason: a run now has two builds, and code written when it had one does not
// say which it means.

const { deliveryMayBindToBuild } = workerRepositoryModule;

const RUN = "run-1";
const NEW_BUILD = "build-new";
const OLD_BUILD = "build-superseded";

describe("a finished build binding to the order's delivery", () => {
  it("accepts the ordinary case: the delivery already points at this build", () => {
    expect(deliveryMayBindToBuild({
      delivery: { petpack_build_id: NEW_BUILD, status: "ready", bound_build_status: "validated", bound_build_run_id: RUN },
      buildId: NEW_BUILD,
      runId: RUN
    })).toBe(true);
  });

  it("accepts the first delivery of a run, when there is no row yet", () => {
    expect(deliveryMayBindToBuild({ delivery: undefined, buildId: NEW_BUILD, runId: RUN })).toBe(true);
  });

  it("accepts the redo: the delivery points at this run's superseded pack", () => {
    expect(deliveryMayBindToBuild({
      delivery: { petpack_build_id: OLD_BUILD, status: "ready", bound_build_status: "superseded", bound_build_run_id: RUN },
      buildId: NEW_BUILD,
      runId: RUN
    })).toBe(true);
  });

  it("refuses a superseded pack belonging to a different run", () => {
    // Being superseded is not on its own a licence to rebind: the pack has to
    // be the one this run replaced.
    expect(deliveryMayBindToBuild({
      delivery: { petpack_build_id: OLD_BUILD, status: "ready", bound_build_status: "superseded", bound_build_run_id: "run-2" },
      buildId: NEW_BUILD,
      runId: RUN
    })).toBe(false);
  });

  it("refuses a delivery bound to a live build of another run", () => {
    expect(deliveryMayBindToBuild({
      delivery: { petpack_build_id: "build-elsewhere", status: "ready", bound_build_status: "validated", bound_build_run_id: "run-2" },
      buildId: NEW_BUILD,
      runId: RUN
    })).toBe(false);
  });

  it("refuses a delivery that is no longer live, redo or not", () => {
    for (const status of ["revoked", "expired"]) {
      expect(deliveryMayBindToBuild({
        delivery: { petpack_build_id: NEW_BUILD, status, bound_build_status: "validated", bound_build_run_id: RUN },
        buildId: NEW_BUILD,
        runId: RUN
      })).toBe(false);
      expect(deliveryMayBindToBuild({
        delivery: { petpack_build_id: OLD_BUILD, status, bound_build_status: "superseded", bound_build_run_id: RUN },
        buildId: NEW_BUILD,
        runId: RUN
      })).toBe(false);
    }
  });
});
