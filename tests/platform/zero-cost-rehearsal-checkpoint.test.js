import fs from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const runnerSource = fs.readFileSync(
  new URL("../../platform/src/development/run-zero-cost-rehearsal.js", import.meta.url),
  "utf8"
);
const {
  finalDatabaseContractTimeoutMs,
  hasFinalDatabaseContract,
  hasExactOutboxReplayEvidence,
  normalizeFaultPlan,
  waitForActiveVideoPollLease,
  waitForFinalDatabaseContract,
  waitForVideoSubmissions
} = require("../../platform/src/development/run-zero-cost-rehearsal");

function finalDatabaseReport(overrides = {}) {
  return {
    run: {
      confirmed_source_photos: 3,
      passed_masters: 3,
      passed_actions: 7,
      passed_qa_reports: 12,
      failed_qa_reports: 0,
      total_executions: 38,
      succeeded_executions: 38,
      incomplete_executions: 0,
      total_outbox_jobs: 39,
      sent_outbox_jobs: 39,
      unsent_outbox: 0,
      fixture_usage_attempts: 10,
      state: "deliverable",
      ...overrides
    },
    delivery: { status: "ready" }
  };
}

describe("zero-cost worker restart checkpoint", () => {
  it("waits until all seven provider task IDs are durably bound", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total_actions: 7, bound_provider_tasks: 5, reconciliation_required: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total_actions: 7, bound_provider_tasks: 7, reconciliation_required: 0 }] });

    await expect(waitForVideoSubmissions({
      database: { query },
      runId: "10000000-0000-4000-8000-000000000001",
      timeoutMs: 2_000
    })).resolves.toMatchObject({ total_actions: 7, bound_provider_tasks: 7 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of restarting across an unknown provider submission", async () => {
    const query = vi.fn(async () => ({
      rows: [{ total_actions: 7, bound_provider_tasks: 6, reconciliation_required: 1 }]
    }));

    await expect(waitForVideoSubmissions({
      database: { query },
      runId: "10000000-0000-4000-8000-000000000001",
      timeoutMs: 2_000
    })).rejects.toThrow(/reconciliation/i);
  });

  it("waits for all provider task IDs plus a live poll lease before a worker hard-kill", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        total_actions: 7,
        bound_provider_tasks: 7,
        active_poll_leases: 0,
        reconciliation_required: 0
      }] })
      .mockResolvedValueOnce({ rows: [{
        total_actions: 7,
        bound_provider_tasks: 7,
        active_poll_leases: 2,
        reconciliation_required: 0
      }] });

    await expect(waitForActiveVideoPollLease({
      database: { query },
      runId: "10000000-0000-4000-8000-000000000001",
      timeoutMs: 2_000
    })).resolves.toMatchObject({ active_poll_leases: 2 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("accepts only the three explicit boolean fault switches", () => {
    expect(normalizeFaultPlan({ apiAfterPhotos: true, outboxAfterClaim: true })).toEqual({
      apiAfterPhotos: true,
      outboxAfterClaim: true,
      outboxAfterEnqueue: false,
      workerActiveLease: false
    });
    expect(normalizeFaultPlan({ outboxAfterEnqueue: true })).toMatchObject({ outboxAfterEnqueue: true });
    expect(() => normalizeFaultPlan({ outboxAfterClaim: true, outboxAfterEnqueue: true })).toThrow(/separate/i);
    expect(() => normalizeFaultPlan({ workerActiveLease: "true" })).toThrow(/fault plan/i);
    expect(() => normalizeFaultPlan({ deleteDocker: true })).toThrow(/fault plan/i);
  });

  it("does not treat a downloadable package as drained while finalizer outbox jobs remain", () => {
    expect(hasFinalDatabaseContract(finalDatabaseReport({
      total_executions: 31,
      succeeded_executions: 31,
      sent_outbox_jobs: 32,
      unsent_outbox: 7
    }))).toBe(false);
    expect(hasFinalDatabaseContract(finalDatabaseReport())).toBe(true);
  });

  it("waits for all finalizer executions and outbox rows to drain", async () => {
    const collectReport = vi.fn()
      .mockResolvedValueOnce(finalDatabaseReport({
        total_executions: 31,
        succeeded_executions: 31,
        sent_outbox_jobs: 32,
        unsent_outbox: 7
      }))
      .mockResolvedValueOnce(finalDatabaseReport());
    const database = { query: vi.fn() };

    await expect(waitForFinalDatabaseContract({
      database,
      projectId: "10000000-0000-4000-8000-000000000001",
      timeoutMs: 100,
      intervalMs: 1,
      collectReport
    })).resolves.toEqual(finalDatabaseReport());
    expect(collectReport).toHaveBeenCalledTimes(2);
  });

  it("gives the fixed Redis AOF delay a bounded final-contract recovery margin", () => {
    expect(finalDatabaseContractTimeoutMs({ redisAof: true })).toBe(120_000);
    expect(finalDatabaseContractTimeoutMs({ workerActiveLease: true })).toBe(60_000);
    expect(finalDatabaseContractTimeoutMs()).toBe(30_000);
    expect(() => finalDatabaseContractTimeoutMs({ redisAof: "true" })).toThrow(/timeout mode/i);
    expect(runnerSource).toContain("timeoutMs: finalDatabaseContractTimeoutMs({");
    expect(runnerSource).toContain("redisAof: Boolean(redisAofConfig)");
  });

  it("pauses after the sleeping-master finalizer creates seven video rows before freezing Redis", () => {
    const targetIndex = runnerSource.indexOf(
      "PETPACK_REHEARSAL_OUTBOX_POST_ENQUEUE_TARGET_JOB: JOB_NAMES.FINALIZE_SLEEP"
    );
    const confirmIndex = runnerSource.indexOf("/character/confirm");
    const finalizerCheckpointIndex = runnerSource.indexOf(
      'waitForChildCheckpoint(\n        outboxRecord,\n        "enqueued_before_mark_sent"',
      confirmIndex
    );
    const pendingRowsIndex = runnerSource.indexOf("waitForPendingRedisAofVideoOutboxRows", finalizerCheckpointIndex);
    const stopWorkerIndex = runnerSource.indexOf(
      'stopTrackedChild(workerRecord, "Redis AOF worker after sleeping-master finalization")',
      pendingRowsIndex
    );
    const prepareIndex = runnerSource.indexOf("prepareRedisAofVideoJobs", stopWorkerIndex);
    const stopOutboxIndex = runnerSource.indexOf(
      'stopTrackedChild(outboxRecord, "Redis AOF sleeping-master checkpoint outbox")',
      prepareIndex
    );

    expect(targetIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(targetIndex);
    expect(finalizerCheckpointIndex).toBeGreaterThan(confirmIndex);
    expect(pendingRowsIndex).toBeGreaterThan(finalizerCheckpointIndex);
    expect(stopWorkerIndex).toBeGreaterThan(pendingRowsIndex);
    expect(prepareIndex).toBeGreaterThan(stopWorkerIndex);
    expect(stopOutboxIndex).toBeGreaterThan(prepareIndex);
  });

  it("requires a second outbox publish without a second business execution or provider call", () => {
    const evidence = {
      preKillStatus: "leased",
      preKillAttempts: 1,
      preKillHasLeaseToken: true,
      preKillDedupeKey: "petpack:front",
      preKillPayloadJobId: "petpack:front",
      outboxStatus: "sent",
      outboxAttempts: 2,
      executionStatus: "succeeded",
      executionAttempts: 1,
      dedupeKey: "petpack:front",
      payloadJobId: "petpack:front",
      executionJobId: "petpack:front",
      providerRequestId: "10000000-0000-4000-8000-000000000099",
      frontProviderCalls: 1
    };
    expect(hasExactOutboxReplayEvidence(evidence)).toBe(true);
    expect(hasExactOutboxReplayEvidence({ ...evidence, preKillStatus: "sent" })).toBe(false);
    expect(hasExactOutboxReplayEvidence({ ...evidence, preKillAttempts: 2 })).toBe(false);
    expect(hasExactOutboxReplayEvidence({ ...evidence, outboxAttempts: 1 })).toBe(false);
    expect(hasExactOutboxReplayEvidence({ ...evidence, executionAttempts: 2 })).toBe(false);
    expect(hasExactOutboxReplayEvidence({ ...evidence, frontProviderCalls: 2 })).toBe(false);
  });
});
