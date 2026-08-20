import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

// One action of a paid order spent its first processing attempt on an ffmpeg
// decode failure under load, then died on the other two - stalling the run at
// six of seven with no way back. A decoder falling over says nothing about the
// video it was handed, so it now draws on its own budget.

const require = createRequire(import.meta.url);
const {
  PostgresProductionWorkerRepository
} = require("../../platform/src/persistence/postgres-production-worker-repository");
const {
  MEDIA_PROCESSING_ARTEFACT_ATTEMPTS,
  MEDIA_PROCESSING_QUEUE_ATTEMPTS,
  MEDIA_PROCESSING_TRANSIENT_ATTEMPTS
} = require("../../platform/src/workflow/production-workflow");

const JOB_ID = "petpack:process-idle";
const LEASE = "40000000-0000-4000-8000-000000000001";

function repositoryFor({ attempts, transientAttempts = 0, actionState = "succeeded" }) {
  const updates = [];
  const query = vi.fn(async (text, params) => {
    const sql = String(text);
    if (sql.includes("FROM production_job_execution execution")) {
      return {
        rows: [{
          id: "40000000-0000-4000-8000-000000000002",
          run_id: "run-1",
          action_id: "idle",
          attempts,
          max_attempts: MEDIA_PROCESSING_QUEUE_ATTEMPTS,
          transient_attempts: transientAttempts,
          action_state: actionState
        }]
      };
    }
    if (sql.includes("UPDATE production_job_execution")) updates.push({ sql, params });
    return { rows: [] };
  });
  const repository = new PostgresProductionWorkerRepository({
    database: { transaction: async (run) => run({ query }) },
    idFactory: () => "40000000-0000-4000-8000-000000000003",
    logger: { info() {}, warn() {}, error() {} }
  });
  return { repository, updates };
}

const release = (repository, errorCode) => repository.releaseVideoProcessingForRetry({
  jobId: JOB_ID, leaseToken: LEASE, errorCode
});

describe("transient media-processing budget", () => {
  it("hands the attempt back when the decoder is what failed", async () => {
    const { repository, updates } = repositoryFor({ attempts: 1 });

    const result = await release(repository, "endpoint_decoder_failed");

    expect(result).toMatchObject({ status: "retryable", exhausted: false, attemptRefunded: true });
    // attempts back to zero, transient budget up by one.
    expect(updates[0].params).toContain(0);
    expect(updates[0].params[updates[0].params.length - 1]).toBe(1);
  });

  it("keeps the attempt when the video itself is what failed", async () => {
    const { repository, updates } = repositoryFor({ attempts: 2 });

    const result = await release(repository, "action_media_processing_failed");

    expect(result).toMatchObject({ status: "retryable", exhausted: false, attemptRefunded: false });
    expect(updates[0].params).toContain(2);
    expect(updates[0].params[updates[0].params.length - 1]).toBe(0);
  });

  it("dies on the third failure of the artefact, not the ninth of the queue", async () => {
    const { repository } = repositoryFor({ attempts: MEDIA_PROCESSING_ARTEFACT_ATTEMPTS });

    await expect(release(repository, "action_media_processing_failed"))
      .resolves.toMatchObject({ status: "dead", exhausted: true });
  });

  it("stops refunding once the transient budget is spent", async () => {
    const { repository } = repositoryFor({
      attempts: MEDIA_PROCESSING_ARTEFACT_ATTEMPTS,
      transientAttempts: MEDIA_PROCESSING_TRANSIENT_ATTEMPTS
    });

    const result = await release(repository, "endpoint_decoder_failed");

    expect(result).toMatchObject({ status: "dead", exhausted: true, attemptRefunded: false });
  });

  it("leaves the queue enough redeliveries for both budgets", () => {
    expect(MEDIA_PROCESSING_QUEUE_ATTEMPTS)
      .toBe(MEDIA_PROCESSING_ARTEFACT_ATTEMPTS + MEDIA_PROCESSING_TRANSIENT_ATTEMPTS);
  });

  it("still settles an action that passed QA concurrently", async () => {
    const { repository } = repositoryFor({ attempts: 3, actionState: "qa_passed" });

    await expect(release(repository, "endpoint_decoder_failed"))
      .resolves.toMatchObject({ status: "succeeded", exhausted: false });
  });
});
