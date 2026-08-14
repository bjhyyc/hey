import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { JOB_NAMES } = require("../../platform/src/workflow/production-workflow");
const {
  HARD_KILL_TARGET_JOB,
  POST_ENQUEUE_TARGET_ENV,
  POST_ENQUEUE_TARGET_JOBS,
  createPostEnqueuePause,
  resolvePostEnqueueTargetJob
} = require("../../platform/src/development/start-zero-cost-outbox");

describe("zero-cost outbox post-enqueue target", () => {
  it("keeps the existing front-master crash target as the default", () => {
    expect(HARD_KILL_TARGET_JOB).toBe(JOB_NAMES.GENERATE_FRONT);
    expect(resolvePostEnqueueTargetJob({})).toBe(JOB_NAMES.GENERATE_FRONT);
  });

  it("allowlists only the front generator and sleeping-master finalizer", () => {
    expect(POST_ENQUEUE_TARGET_JOBS).toEqual([
      JOB_NAMES.GENERATE_FRONT,
      JOB_NAMES.FINALIZE_SLEEP
    ]);
    expect(resolvePostEnqueueTargetJob({
      [POST_ENQUEUE_TARGET_ENV]: JOB_NAMES.FINALIZE_SLEEP
    })).toBe(JOB_NAMES.FINALIZE_SLEEP);
    expect(() => resolvePostEnqueueTargetJob({
      [POST_ENQUEUE_TARGET_ENV]: JOB_NAMES.GENERATE_VIDEO
    })).toThrow(/not allowlisted/i);
    expect(() => resolvePostEnqueueTargetJob({
      [POST_ENQUEUE_TARGET_ENV]: ` ${JOB_NAMES.FINALIZE_SLEEP}`
    })).toThrow(/not allowlisted/i);
  });

  it("rejects an orphan target and forbids the hook in production", () => {
    expect(() => createPostEnqueuePause({
      [POST_ENQUEUE_TARGET_ENV]: JOB_NAMES.FINALIZE_SLEEP
    })).toThrow(/requires its explicit development hook/i);
    expect(() => createPostEnqueuePause({
      NODE_ENV: "production",
      PETPACK_REHEARSAL_OUTBOX_POST_ENQUEUE_HARD_KILL: "true",
      [POST_ENQUEUE_TARGET_ENV]: JOB_NAMES.FINALIZE_SLEEP
    })).toThrow(/forbidden in production/i);
  });
});
