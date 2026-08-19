import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import stateMachineModule from "../../platform/src/domain/production-state-machine.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";
import storeModule from "../../platform/src/persistence/postgres-transactional-workflow-store.js";
import workerRepositoryModule from "../../platform/src/persistence/postgres-production-worker-repository.js";

const { PRODUCTION_STATES } = stateMachineModule;
const { ProductionWorkflow } = workflowModule;
const { PostgresTransactionalWorkflowStore } = storeModule;

const modelRegistry = Object.freeze({
  version: "seedream-seedance-480p-v1",
  modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
});

function createWorkflow() {
  const committed = [];
  const runStore = {
    commitTransition: vi.fn(async (transition) => {
      committed.push(transition);
      return { ...transition.run, version: (transition.previousRun?.version ?? 0) + 1 };
    })
  };
  const workflow = new ProductionWorkflow({
    runStore,
    queue: { add: vi.fn() },
    promptStore: { listPublishedMetadata: vi.fn(async () => []) },
    modelRegistry,
    logger: { info() {}, warn() {}, error() {} }
  });
  return { workflow, committed };
}

const generatingRun = Object.freeze({
  id: "run-1",
  projectId: "project-1",
  orderId: "order-1",
  state: PRODUCTION_STATES.VIDEO_GENERATING,
  version: 4
});

// A rejected action used to leave the run in video_generating with no failure
// code and no regeneration: the customer's progress page showed generation
// forever, which reads worse than an honest failure.
describe("video action QA failure", () => {
  it("fails the run with an action-specific failure code once retries are spent", async () => {
    const { workflow, committed } = createWorkflow();

    await workflow.videoActionQaFailed({ run: generatingRun, actionId: "roll" });

    expect(committed).toHaveLength(1);
    expect(committed[0].run.state).toBe(PRODUCTION_STATES.FAILED);
    expect(committed[0].run.failureCode).toBe("action_qa_failed");
  });

  it("queues no further work for a failed run", async () => {
    const { workflow, committed } = createWorkflow();

    await workflow.videoActionQaFailed({ run: generatingRun, actionId: "roll" });

    expect(committed[0].jobs ?? []).toHaveLength(0);
  });

  it("refuses to fail an action outside video generation", async () => {
    const { workflow } = createWorkflow();

    await expect(workflow.videoActionQaFailed({
      run: { ...generatingRun, state: PRODUCTION_STATES.PACKAGING },
      actionId: "roll"
    })).rejects.toThrow(/only while a run is generating video/);
  });

  it("refuses an action outside the canonical seven", async () => {
    const { workflow } = createWorkflow();

    await expect(workflow.videoActionQaFailed({
      run: generatingRun,
      actionId: "backflip"
    })).rejects.toThrow(/Unsupported PetPack Studio action/);
  });

  it("rejects a negative regeneration budget at construction", () => {
    expect(() => new ProductionWorkflow({
      runStore: { commitTransition: vi.fn() },
      queue: { add: vi.fn() },
      promptStore: { listPublishedMetadata: vi.fn() },
      modelRegistry,
      maxVideoActionQaRetries: -1
    })).toThrow(/maxVideoActionQaRetries/);
  });
});

// The regeneration path first shipped writing the QA payload wrapper instead of
// its serialized report, so every scheduling attempt threw inside the
// repository and fell through to the generic retry - which then reported a
// media-processing failure that never happened.
describe("rejected action QA payload", () => {
  // The tests around this method read its source rather than running it, which
  // is how a regeneration that could never be enqueued survived: the enqueue
  // asked for an immediate delay of zero seconds and the delay normaliser
  // demanded a positive integer, so every rejected action fell back to the
  // generic retry, burned its attempts and stalled the run.
  it("enqueues an immediate regeneration rather than rejecting a zero delay", async () => {
    const { PostgresProductionWorkerRepository } = workerRepositoryModule;
    const inserted = [];
    const tx = {
      query: vi.fn(async (text, params) => {
        if (String(text).includes("INSERT INTO outbox_job")) inserted.push({ text, params });
        return { rows: [] };
      })
    };
    const repository = new PostgresProductionWorkerRepository({
      database: { transaction: async (run) => run(tx) },
      idFactory: () => "00000000-0000-4000-8000-000000000000",
      logger: { info() {}, warn() {}, error() {} }
    });
    const job = {
      name: "petpack.generate-video-action",
      dedupeKey: "petpack:regenerate",
      data: { runId: "run-1", actionId: "sleep-loop" },
      options: { attempts: 3 }
    };

    await expect(repository._insertDelayedOutbox(tx, job, 0)).resolves.toBeUndefined();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].params).toContain(0);
  });

  it("still refuses a delay that is negative or beyond the cap", async () => {
    const { PostgresProductionWorkerRepository } = workerRepositoryModule;
    const tx = { query: vi.fn(async () => ({ rows: [] })) };
    const repository = new PostgresProductionWorkerRepository({
      database: { transaction: async (run) => run(tx) },
      idFactory: () => "00000000-0000-4000-8000-000000000000",
      logger: { info() {}, warn() {}, error() {} }
    });
    const job = { name: "petpack.generate-video-action", dedupeKey: "k", data: { runId: "r", actionId: "a" }, options: {} };
    await expect(repository._insertDelayedOutbox(tx, job, -1)).rejects.toThrow(/between 0 and 3600/);
    await expect(repository._insertDelayedOutbox(tx, job, 3601)).rejects.toThrow(/between 0 and 3600/);
  });

  it("persists the serialized report rather than the normalizer's wrapper", async () => {
    const source = readFileSync(
      new URL("../../platform/src/persistence/postgres-production-worker-repository.js", import.meta.url),
      "utf8"
    );
    const method = source.slice(source.indexOf("async requeueVideoActionAfterQaFailure"));
    const insert = method.slice(0, method.indexOf("UPDATE generation_action"));

    expect(insert).toContain("safeQa.serialized");
    expect(insert).not.toContain("JSON.stringify(safeQa)");
  });

  it("clears every provider-owned field the claim guard checks", async () => {
    const source = readFileSync(
      new URL("../../platform/src/persistence/postgres-production-worker-repository.js", import.meta.url),
      "utf8"
    );
    const method = source.slice(source.indexOf("async requeueVideoActionAfterQaFailure"));
    const update = method.slice(method.indexOf("UPDATE generation_action"), method.indexOf("RETURNING retry_count"));

    for (const column of [
      "provider_task_id = NULL",
      "provider_request_id = NULL",
      "provider_poll_count = 0",
      "provider_output_asset_id = NULL",
      "media_asset_id = NULL",
      "qa_report_id = NULL"
    ]) {
      expect(update).toContain(column);
    }
  });
});

// Failing the run needs the claimed run's optimistic-lock version. The first
// build passed a synthesised {id, state} object, so the transition threw and
// the run stayed in video_generating with the retries already spent - the exact
// stall the recovery exists to prevent.
describe("run failure uses the claimed run", () => {
  const source = readFileSync(
    new URL("../../platform/src/workers/production-job-worker.js", import.meta.url),
    "utf8"
  );

  it("passes the claimed run into videoActionQaFailed", () => {
    const call = source.slice(source.indexOf("videoActionQaFailed("));
    const args = call.slice(0, call.indexOf("});") + 3);
    expect(args).toContain("run: claim.run");
  });

  it("never synthesises a run object for the transition", () => {
    expect(source).not.toMatch(/run:\s*\{\s*id:\s*input\.runId/);
  });

  it("cannot commit a transition for a run with no lock version", async () => {
    const store = new PostgresTransactionalWorkflowStore({
      database: { transaction: async (run) => run({ query: async () => ({ rows: [] }) }) },
      logger: { info() {}, warn() {}, error() {} }
    });

    await expect(store.commitTransition({
      previousRun: { id: "run-1", state: PRODUCTION_STATES.VIDEO_GENERATING },
      run: { id: "run-1", state: PRODUCTION_STATES.FAILED, failureCode: "action_qa_failed" }
    })).rejects.toThrow(/version/i);
  });
});

// The usage ledger is keyed by (action, delivery number) across every execution
// the action ever had, and rows are written before the provider call. A fresh
// execution that starts counting at zero collides once per historical row; the
// fourth regeneration of the first real order died without reaching the
// provider because rows 1-3 were spent and the delivery budget was three.
describe("execution attempt seeding", () => {
  const source = readFileSync(
    new URL("../../platform/src/persistence/postgres-production-worker-repository.js", import.meta.url),
    "utf8"
  );

  it("starts a fresh video execution after the highest spent ledger number", () => {
    const method = source.slice(source.indexOf("async claimVideoSubmission"));
    const insert = method.slice(0, method.indexOf("ON CONFLICT (job_id) DO NOTHING"));
    expect(insert).toContain("max(usage.worker_attempt)");
    expect(insert).toContain("provider_usage_attempt");
    expect(insert).not.toMatch(/'pending', 0,/);
  });
});
