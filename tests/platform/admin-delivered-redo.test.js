import { describe, expect, it, vi } from "vitest";

import stateMachineModule from "../../platform/src/domain/production-state-machine.js";
import storeModule from "../../platform/src/persistence/postgres-transactional-workflow-store.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";
import adminOrdersModule from "../../platform/src/api/admin-orders-service.js";

// A customer can dislike a clip the quality gates passed - the belly of a
// sleeping pet that heaves too much is the case this exists for. Every other
// disposal starts from a failed run; this one starts from a delivered pack, so
// it has to supersede that pack without breaking the download the customer
// already has.

const { PRODUCTION_STATES, adminRedoDeliveredAction } = stateMachineModule;
const { PostgresTransactionalWorkflowStore } = storeModule;
const { ProductionWorkflow, JOB_NAMES } = workflowModule;
const { AdminOrdersService, availableRescueStages } = adminOrdersModule;

const modelRegistry = Object.freeze({
  version: "seedream-seedance-480p-v1",
  modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
});

const deliveredRun = Object.freeze({
  id: "run-1",
  projectId: "project-1",
  orderId: "order-1",
  species: "dog",
  modelRegistryVersion: modelRegistry.version,
  characterRevisionId: "revision-9",
  state: PRODUCTION_STATES.DELIVERABLE,
  failureCode: null,
  frontGenerationAttempts: 1,
  sideGenerationAttempts: 1,
  frontUserRegenerationsUsed: 0,
  sideUserRegenerationsUsed: 0,
  frontQaRetries: 0,
  sideQaRetries: 0,
  sleepGenerationAttempts: 1,
  version: 18
});

function scriptedStore(script) {
  const executed = [];
  const database = {
    transaction: async (callback) => callback({
      query: async (sql, params) => {
        executed.push({ sql, params });
        for (const [pattern, result] of script) {
          if (sql.includes(pattern)) return typeof result === "function" ? result(sql, params) : result;
        }
        throw new Error(`Unscripted SQL: ${sql.trim().slice(0, 80)}`);
      }
    })
  };
  const store = new PostgresTransactionalWorkflowStore({
    database,
    idFactory: () => "00000000-0000-4000-8000-000000000001",
    logger: { info() {}, warn() {}, error() {} }
  });
  return { store, executed };
}

const updatedRunRow = (sql, params) => ({
  rows: [{
    id: "run-1", project_id: "project-1", order_id: "order-1", character_revision_id: "revision-9",
    state: params[1], model_registry_version: modelRegistry.version, version: 19, updated_at: "now"
  }]
});

function redoScript(overrides = {}) {
  return [
    ["INSERT INTO production_run_event", { rows: [] }],
    ["UPDATE production_run", updatedRunRow],
    ["UPDATE petpack_build", overrides.build ?? { rows: [{ id: "build-1", input_snapshot_id: null }] }],
    ["DELETE FROM petpack_input_action", { rows: [] }],
    ["DELETE FROM petpack_input_snapshot", { rows: [] }],
    ["DELETE FROM production_job_execution", { rows: [] }],
    ["UPDATE generation_action", overrides.action ?? { rows: [{ retry_count: 1 }] }],
    ["UPDATE pet_project", { rows: [] }],
    ["INSERT INTO outbox_job", { rows: [] }]
  ];
}

const redoJob = {
  name: JOB_NAMES.GENERATE_VIDEO,
  data: { runId: "run-1", actionId: "sleep-loop" },
  options: { jobId: "petpack:redo-1", attempts: 3 },
  dedupeKey: "petpack:redo-1"
};

describe("delivered-pack redo state machine", () => {
  it("sends a delivered run back to video generation", () => {
    const next = adminRedoDeliveredAction(deliveredRun, { actionId: "sleep-loop" });
    expect(next.state).toBe(PRODUCTION_STATES.VIDEO_GENERATING);
    expect(next.failureCode).toBeNull();
  });

  it("refuses a run that has not been delivered, and an unknown clip", () => {
    expect(() => adminRedoDeliveredAction({ ...deliveredRun, state: PRODUCTION_STATES.FAILED }, { actionId: "sleep-loop" }))
      .toThrowError(/Only a delivered production run/);
    expect(() => adminRedoDeliveredAction(deliveredRun, { actionId: "moonwalk" }))
      .toThrowError(/does not support action/);
  });
});

describe("delivered-pack redo commit", () => {
  it("supersedes the pack, frees the snapshot, resets the clip and queues one job", async () => {
    const { store, executed } = scriptedStore(redoScript());
    const next = { ...deliveredRun, state: PRODUCTION_STATES.VIDEO_GENERATING };
    await store.commitAdminDeliveredActionRedo({
      previousRun: deliveredRun,
      run: next,
      actionId: "sleep-loop",
      override: { actorId: "admin-1", reason: "客户反映腹部起伏过大" },
      jobFactory: (retryCount) => {
        expect(retryCount).toBe(1);
        return redoJob;
      }
    });

    const build = executed.find((entry) => entry.sql.includes("UPDATE petpack_build"));
    expect(build.sql).toContain("status = 'superseded'");
    // The snapshot must be released, not kept: petpack_input_action binds the
    // same six clips with global uniques, so a second snapshot cannot coexist.
    expect(build.sql).toContain("input_snapshot_id = NULL");
    expect(build.sql).toContain("status = 'validated'");
    expect(executed.some((entry) => entry.sql.includes("DELETE FROM petpack_input_action"))).toBe(true);
    expect(executed.some((entry) => entry.sql.includes("DELETE FROM petpack_input_snapshot"))).toBe(true);

    const action = executed.find((entry) => entry.sql.includes("UPDATE generation_action"));
    expect(action.sql).toContain("state = 'queued'");
    expect(action.sql).toContain("retry_count = retry_count + 1");
    // Only a clip that is actually part of the delivered pack may be redone.
    expect(action.sql).toContain("state = 'qa_passed'");
    expect(action.params).toEqual(["run-1", "sleep-loop"]);

    const project = executed.find((entry) => entry.sql.includes("UPDATE pet_project"));
    expect(project.sql).toContain("state = 'producing'");
    const outbox = executed.find((entry) => entry.sql.includes("INSERT INTO outbox_job"));
    expect(outbox.params[2]).toBe(JOB_NAMES.GENERATE_VIDEO);
    // The delivery row itself is untouched: the customer keeps downloading the
    // superseded pack until the replacement validates. (The execution cleanup
    // names the prepare-delivery JOB, which is a different thing.)
    expect(executed.some((entry) => /(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+delivery\b/i.test(entry.sql))).toBe(false);
  });

  it("refuses when the run has no validated pack, or the clip is not in it", async () => {
    const noBuild = scriptedStore(redoScript({ build: { rows: [] } }));
    await expect(noBuild.store.commitAdminDeliveredActionRedo({
      previousRun: deliveredRun,
      run: { ...deliveredRun, state: PRODUCTION_STATES.VIDEO_GENERATING },
      actionId: "sleep-loop",
      override: { actorId: "admin-1", reason: "r" },
      jobFactory: () => redoJob
    })).rejects.toThrowError(/no validated pack/);

    const noAction = scriptedStore(redoScript({ action: { rows: [] } }));
    await expect(noAction.store.commitAdminDeliveredActionRedo({
      previousRun: deliveredRun,
      run: { ...deliveredRun, state: PRODUCTION_STATES.VIDEO_GENERATING },
      actionId: "sleep-loop",
      override: { actorId: "admin-1", reason: "r" },
      jobFactory: () => redoJob
    })).rejects.toThrowError(/could not be reset for a redo/);
  });
});

describe("delivered-pack redo disposal", () => {
  const deliveredContext = {
    order: { id: "order-1", status: "paid", amountFen: 7800 },
    run: deliveredRun,
    failedFromState: null,
    adminRerunCount: 0,
    actions: [
      { actionId: "idle", state: "qa_passed" },
      { actionId: "sleep-loop", state: "qa_passed" }
    ],
    delivery: { status: "ready" },
    dispatch: { pending: 0, leased: 0, failed: 0, dead: 0 },
    timeline: []
  };

  it("offers every delivered clip as a redo", () => {
    expect(availableRescueStages(deliveredContext)).toEqual([
      { stage: "action:idle", mode: "redo" },
      { stage: "action:sleep-loop", mode: "redo" }
    ]);
    // A refunded order gets nothing, delivered or not.
    expect(availableRescueStages({ ...deliveredContext, order: { id: "order-1", status: "refunded" } })).toEqual([]);
  });

  it("routes the redo through the workflow and audits it", async () => {
    const audits = [];
    const workflow = {
      adminRerunCharacterMaster: vi.fn(), adminRerunSleepMaster: vi.fn(), adminRerunVideoAction: vi.fn(),
      adminGrantCharacterRegeneration: vi.fn(), adminOverrideCharacterMaster: vi.fn(),
      adminOverrideSleepMaster: vi.fn(), adminOverrideVideoAction: vi.fn(),
      adminRedoDeliveredAction: vi.fn(async () => ({ id: "run-1", state: PRODUCTION_STATES.VIDEO_GENERATING }))
    };
    const service = new AdminOrdersService({
      repository: {
        findAdminOperations: vi.fn(), getAdminOrderRescueContext: vi.fn(async () => deliveredContext),
        recordAdminAuditEvent: vi.fn(async (event) => { audits.push(event); return { recorded: true }; }),
        extendDeliveryWindow: vi.fn(), createAdminRefund: vi.fn(), applyAdminRefundRequested: vi.fn(),
        completeAdminRefund: vi.fn(), getAdminUserView: vi.fn(), setAdminUserStatus: vi.fn()
      },
      workflow,
      objectStore: { createDownloadGrant: vi.fn(async () => ({ url: "https://signed.example/x" })) },
      paymentProvider: null,
      refundEnabled: false,
      logger: { info() {}, warn() {}, error() {} }
    });

    const outcome = await service.rerunStage({
      actor: { id: "admin-1", role: "admin" },
      orderId: "order-1",
      stage: "action:sleep-loop",
      reason: "客户反映睡觉时腹部起伏过大"
    });
    expect(outcome.mode).toBe("redo_authorized");
    expect(outcome.run.state).toBe(PRODUCTION_STATES.VIDEO_GENERATING);
    expect(workflow.adminRedoDeliveredAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: "sleep-loop" }));
    expect(audits[0].eventType).toBe("admin_delivered_action_redo");
    expect(audits[0].metadata.actionId).toBe("sleep-loop");

    // A delivered run has no other disposal, and a clip must belong to the pack.
    await expect(service.rerunStage({
      actor: { id: "admin-1", role: "admin" }, orderId: "order-1", stage: "package", reason: "r"
    })).rejects.toThrowError(/only have one of its actions redone/);
    await expect(service.rerunStage({
      actor: { id: "admin-1", role: "admin" }, orderId: "order-1", stage: "action:roll", reason: "r"
    })).rejects.toThrowError(/not part of the delivered pack/);
  });
});

describe("delivered-pack redo workflow", () => {
  it("queues one video job on a revision no earlier attempt used", async () => {
    const calls = [];
    const workflow = new ProductionWorkflow({
      runStore: {
        commitTransition: vi.fn(async ({ run }) => ({ ...run, version: 19 })),
        commitAdminDeliveredActionRedo: vi.fn(async (input) => {
          calls.push({ ...input, job: input.jobFactory(1) });
          return { ...input.run, version: 19 };
        })
      },
      queue: { enqueue: vi.fn() },
      promptStore: { listPublishedMetadata: vi.fn(async () => []) },
      modelRegistry,
      logger: { info() {}, warn() {}, error() {} }
    });
    const committed = await workflow.adminRedoDeliveredAction({
      run: deliveredRun,
      actionId: "sleep-loop",
      override: { actorId: "admin-1", reason: "客户反映腹部起伏过大" }
    });
    expect(committed.state).toBe(PRODUCTION_STATES.VIDEO_GENERATING);
    expect(calls).toHaveLength(1);
    expect(calls[0].job.name).toBe(JOB_NAMES.GENERATE_VIDEO);
    expect(calls[0].job.data).toEqual({ runId: "run-1", actionId: "sleep-loop" });
    expect(calls[0].job.dedupeKey).toBe(calls[0].job.options.jobId);
  });
});
