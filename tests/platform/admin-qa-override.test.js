import { describe, expect, it, vi } from "vitest";

import stateMachineModule from "../../platform/src/domain/production-state-machine.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";
import storeModule from "../../platform/src/persistence/postgres-transactional-workflow-store.js";
import mediaWorkerModule from "../../platform/src/media/media-worker.js";
import adminOrdersModule from "../../platform/src/api/admin-orders-service.js";
import httpApiModule from "../../platform/src/http/petpack-studio-http-api.js";

// P2 of the support console: an administrator watches the rejected candidates
// and force-passes the best one. Masters were fully persisted at rejection, so
// their override is pure promotion; a rejected video has no processed artifact,
// so its override re-enters media processing with a durable marker under which
// QA measures and records everything but does not block. The rejection report
// is never edited - the override is always a NEW passed report that names its
// authorizer and what it overrode.

const { PRODUCTION_STATES, adminQaOverrideProductionRun } = stateMachineModule;
const { ProductionWorkflow, JOB_NAMES } = workflowModule;
const { PostgresTransactionalWorkflowStore } = storeModule;
const { applyAdminQaOverride } = mediaWorkerModule;
const { AdminOrdersService } = adminOrdersModule;
const { createPetPackStudioHttpApi } = httpApiModule;

const modelRegistry = Object.freeze({
  version: "seedream-seedance-480p-v1",
  modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
});

const failedRun = Object.freeze({
  id: "run-1",
  projectId: "project-1",
  orderId: "order-1",
  species: "cat",
  modelRegistryVersion: modelRegistry.version,
  characterRevisionId: "revision-9",
  state: PRODUCTION_STATES.FAILED,
  failureCode: "action_qa_failed",
  frontGenerationAttempts: 1,
  sideGenerationAttempts: 1,
  frontUserRegenerationsUsed: 0,
  sideUserRegenerationsUsed: 0,
  frontQaRetries: 0,
  sideQaRetries: 0,
  sleepGenerationAttempts: 1,
  version: 7
});

describe("admin QA override state machine", () => {
  it("returns a front override to customer confirmation, never confirming for them", () => {
    const { run, needsSideGeneration } = adminQaOverrideProductionRun(
      { ...failedRun, failureCode: "front_master_qa_failed" },
      { stage: "front_master", failedFromState: PRODUCTION_STATES.AWAKE_GENERATING }
    );
    expect(run.state).toBe(PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION);
    expect(needsSideGeneration).toBe(false);
    expect(run.failureCode).toBeNull();
  });

  it("starts the side generation when a front override lands before side ever ran", () => {
    const { run, needsSideGeneration } = adminQaOverrideProductionRun(
      { ...failedRun, sideGenerationAttempts: 0 },
      { stage: "front_master", failedFromState: PRODUCTION_STATES.AWAKE_GENERATING }
    );
    expect(run.state).toBe(PRODUCTION_STATES.AWAKE_GENERATING);
    expect(run.sideGenerationAttempts).toBe(1);
    expect(needsSideGeneration).toBe(true);
  });

  it("advances a sleep override straight to the prompt gate", () => {
    const { run } = adminQaOverrideProductionRun(
      failedRun,
      { stage: "sleep_master", failedFromState: PRODUCTION_STATES.SLEEP_GENERATING }
    );
    expect(run.state).toBe(PRODUCTION_STATES.AWAITING_PROMPT_GATE);
  });

  it("refuses a sleep override without a confirmed character revision", () => {
    expect(() => adminQaOverrideProductionRun(
      { ...failedRun, characterRevisionId: null },
      { stage: "sleep_master", failedFromState: PRODUCTION_STATES.SLEEP_GENERATING }
    )).toThrowError(/confirmed character revision/);
  });

  it("refuses a stage that does not match where the run died", () => {
    try {
      adminQaOverrideProductionRun(failedRun, {
        stage: "action",
        failedFromState: PRODUCTION_STATES.SLEEP_GENERATING
      });
      throw new Error("expected a stage refusal");
    } catch (error) {
      expect(error.code).toBe("admin_rerun_stage_unavailable");
    }
  });
});

describe("applyAdminQaOverride", () => {
  const rejected = Object.freeze({
    ok: false,
    errors: ["hole punched through the pet", "endpoint drift"],
    provenance: { inputSha256: "a".repeat(64), evidenceClass: "production" },
    metrics: { subjectCoverage: 0.91 }
  });

  it("flips only the gate verdict and embeds the measured truth", () => {
    const overridden = applyAdminQaOverride(rejected, { actorId: "admin-1", reason: "肉眼复核可交付", authorizedAt: "2026-08-21T00:00:00.000Z" });
    expect(overridden.ok).toBe(true);
    expect(overridden.errors).toEqual([]);
    expect(overridden.provenance).toEqual(rejected.provenance);
    expect(overridden.metrics).toEqual(rejected.metrics);
    expect(overridden.adminOverride).toMatchObject({
      actorId: "admin-1",
      measuredOk: false,
      measuredErrors: ["hole punched through the pet", "endpoint drift"]
    });
  });

  it("requires the authorizing administrator and a reason", () => {
    expect(() => applyAdminQaOverride(rejected, { actorId: "admin-1", reason: "  " })).toThrowError(/reason/);
    expect(() => applyAdminQaOverride(rejected, null)).toThrowError(/administrator/);
  });
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

// Echo the transition's own target state back, the way RETURNING does.
const updatedRunRow = (sql, params) => ({
  rows: [{
    id: "run-1", project_id: "project-1", order_id: "order-1", character_revision_id: "revision-9",
    state: params[1], model_registry_version: modelRegistry.version, version: 8, updated_at: "now"
  }]
});

describe("workflow store QA override commits", () => {
  it("commits an action override: attribution check, marker set, one processing job", async () => {
    const assetId = "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f";
    const { store, executed } = scriptedStore([
      ["INSERT INTO production_run_event", { rows: [] }],
      ["UPDATE production_run", updatedRunRow],
      ["FROM media_asset asset", { rows: [{ id: assetId }] }],
      ["UPDATE generation_action", { rows: [{ retry_count: 3 }] }],
      ["INSERT INTO outbox_job", { rows: [] }]
    ]);
    const next = { ...failedRun, state: PRODUCTION_STATES.VIDEO_GENERATING, failureCode: null };
    let builtJob = null;
    await store.commitAdminActionQaOverride({
      previousRun: failedRun,
      run: next,
      actionId: "roll",
      sourceAssetId: assetId,
      override: { actorId: "admin-1", reason: "肉眼复核可交付" },
      jobFactory: (retryCount) => {
        expect(retryCount).toBe(3);
        builtJob = {
          name: JOB_NAMES.PROCESS_VIDEO_ACTION,
          data: { runId: "run-1", actionId: "roll" },
          options: { jobId: "petpack:deadbeef", attempts: 9 },
          dedupeKey: "petpack:deadbeef"
        };
        return builtJob;
      }
    });
    const actionUpdate = executed.find((entry) => entry.sql.includes("UPDATE generation_action"));
    expect(actionUpdate.sql).toContain("state = 'succeeded'");
    expect(actionUpdate.sql).toContain("admin_qa_override = $4::jsonb");
    expect(actionUpdate.sql).toContain("state = 'failed'");
    // A retry-exhausted action has provider_task_id cleared; conditioning the
    // reset on it made the override unusable for its main rescue case.
    expect(actionUpdate.sql).not.toContain("provider_task_id");
    const outbox = executed.find((entry) => entry.sql.includes("INSERT INTO outbox_job"));
    expect(outbox.params[3]).toContain("process-video-action");
  });

  it("refuses an action override for a video this action never produced", async () => {
    const { store } = scriptedStore([
      ["INSERT INTO production_run_event", { rows: [] }],
      ["UPDATE production_run", updatedRunRow],
      ["FROM media_asset asset", { rows: [] }]
    ]);
    await expect(store.commitAdminActionQaOverride({
      previousRun: failedRun,
      run: { ...failedRun, state: PRODUCTION_STATES.VIDEO_GENERATING },
      actionId: "roll",
      sourceAssetId: "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f",
      override: { actorId: "admin-1", reason: "r" },
      jobFactory: () => { throw new Error("must not build a job"); }
    })).rejects.toThrowError(/not a QA-rejected provider output/);
  });

  it("promotes a rejected front master by flipping its rejected report in place", async () => {
    const generationRow = {
      id: "gen-1", project_id: "project-1", run_id: "run-1", order_id: "order-1",
      kind: "front", generation_attempt: 1, image_candidate_id: "candidate-1",
      provider_output_asset_id: "asset-provider", normalized_media_asset_id: "asset-normalized",
      processing_policy_version: "policy-v1", processor_version: "processor-v1",
      qa_report_id: "rejected-report-1", parent_front_candidate_id: null, parent_side_candidate_id: null
    };
    const { store, executed } = scriptedStore([
      ["INSERT INTO production_run_event", { rows: [] }],
      ["UPDATE production_run", updatedRunRow],
      ["FROM master_image_generation generation", { rows: [generationRow] }],
      ["UPDATE qa_report", { rows: [{ id: "rejected-report-1" }] }],
      ["UPDATE image_candidate", { rows: [{ id: "candidate-1" }] }],
      ["UPDATE master_image_generation", { rows: [{ id: "gen-1" }] }]
    ]);
    await store.commitAdminMasterQaOverride({
      previousRun: { ...failedRun, failureCode: "front_master_qa_failed" },
      run: { ...failedRun, state: PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION, failureCode: null },
      view: "front",
      generationId: "gen-1",
      override: { actorId: "admin-1", reason: "肉眼复核" }
    });
    // One image report per subject asset is a schema invariant
    // (qa_report_image_subject_unique_idx), so the override must edit the
    // rejected report rather than insert a second one.
    expect(executed.some((entry) => entry.sql.includes("INSERT INTO qa_report"))).toBe(false);
    const reportOverride = executed.find((entry) => entry.sql.includes("UPDATE qa_report"));
    expect(reportOverride.sql).toContain("SET status = 'passed'");
    expect(reportOverride.sql).toContain("AND status = 'failed'");
    // The worker's report survives whole (kind, provenance, processing ...):
    // the packaging gate re-reads it. Only the verdict keys are overlaid.
    expect(reportOverride.sql).toContain("report = report || jsonb_build_object(");
    expect(reportOverride.sql).toContain("'errors', '[]'::jsonb");
    expect(reportOverride.sql).toContain("'overriddenVerdict', jsonb_build_object(");
    expect(reportOverride.params).toContain("run-1");
    expect(reportOverride.params).toContain("policy-v1");
    expect(reportOverride.params).toContain("processor-v1");
    expect(reportOverride.params).toContain("asset-provider");
    expect(reportOverride.params).toContain("asset-normalized");
    const authorization = JSON.parse(reportOverride.params[3]);
    expect(authorization.actorId).toBe("admin-1");
    expect(authorization.reason).toBe("肉眼复核");
    expect(authorization.overriddenQaReportId).toBe("rejected-report-1");
    const candidateUpdate = executed.find((entry) => entry.sql.includes("UPDATE image_candidate"));
    expect(candidateUpdate.sql).toContain("qa_status = 'passed'");
    expect(candidateUpdate.sql).toContain("qa_status = 'failed'");
    // The promoted rows keep pointing at the same (now passed) report id.
    expect(candidateUpdate.params).toContain("rejected-report-1");
    const generationUpdate = executed.find((entry) => entry.sql.includes("UPDATE master_image_generation"));
    expect(generationUpdate.params).toContain("rejected-report-1");
  });

  it("queues the side generation when a front override precedes any side attempt", async () => {
    const generationRow = {
      id: "gen-1", project_id: "project-1", run_id: "run-1", order_id: "order-1",
      kind: "front", generation_attempt: 1, image_candidate_id: "candidate-1",
      provider_output_asset_id: "asset-provider", normalized_media_asset_id: "asset-normalized",
      processing_policy_version: "policy-v1", processor_version: "processor-v1",
      qa_report_id: "rejected-report-1", parent_front_candidate_id: null, parent_side_candidate_id: null
    };
    const { store, executed } = scriptedStore([
      ["INSERT INTO production_run_event", { rows: [] }],
      ["UPDATE production_run", updatedRunRow],
      ["FROM master_image_generation generation", { rows: [generationRow] }],
      ["UPDATE qa_report", { rows: [{ id: "rejected-report-1" }] }],
      ["UPDATE image_candidate", { rows: [{ id: "candidate-1" }] }],
      ["UPDATE master_image_generation", { rows: [{ id: "gen-1" }] }],
      ["INSERT INTO outbox_job", { rows: [] }]
    ]);
    await store.commitAdminMasterQaOverride({
      previousRun: { ...failedRun, sideGenerationAttempts: 0, failureCode: "front_master_qa_failed" },
      run: { ...failedRun, state: PRODUCTION_STATES.AWAKE_GENERATING, sideGenerationAttempts: 1, failureCode: null },
      view: "front",
      generationId: "gen-1",
      override: { actorId: "admin-1", reason: "r" },
      sideJobFactory: (frontCandidateId) => {
        expect(frontCandidateId).toBe("candidate-1");
        return {
          name: JOB_NAMES.GENERATE_SIDE,
          data: { runId: "run-1" },
          options: { jobId: "petpack:side", attempts: 3 },
          dedupeKey: "petpack:side"
        };
      }
    });
    expect(executed.some((entry) => entry.sql.includes("INSERT INTO outbox_job"))).toBe(true);
  });
});

function createWorkflowWithFakeStore() {
  const calls = { master: [], sleep: [], action: [] };
  const runStore = {
    commitTransition: vi.fn(async ({ run }) => ({ ...run, version: 8 })),
    commitAdminMasterQaOverride: vi.fn(async (input) => { calls.master.push(input); return { ...input.run, version: 8 }; }),
    commitAdminSleepQaOverride: vi.fn(async (input) => { calls.sleep.push(input); return { ...input.run, version: 8 }; }),
    commitAdminActionQaOverride: vi.fn(async (input) => {
      calls.action.push({ ...input, job: input.jobFactory(5) });
      return { ...input.run, version: 8 };
    })
  };
  const workflow = new ProductionWorkflow({
    runStore,
    queue: { enqueue: vi.fn() },
    promptStore: { listPublishedMetadata: vi.fn(async () => []) },
    modelRegistry,
    logger: { info() {}, warn() {}, error() {} }
  });
  return { workflow, runStore, calls };
}

describe("admin QA override workflow", () => {
  it("passes a side job factory only when the side view never generated", async () => {
    const { workflow, calls } = createWorkflowWithFakeStore();
    await workflow.adminOverrideCharacterMaster({
      run: { ...failedRun, failureCode: "front_master_qa_failed" },
      view: "front",
      generationId: "gen-1",
      override: { actorId: "admin-1", reason: "r" },
      failedFromState: PRODUCTION_STATES.AWAKE_GENERATING
    });
    expect(calls.master[0].sideJobFactory).toBeNull();
    await workflow.adminOverrideCharacterMaster({
      run: { ...failedRun, sideGenerationAttempts: 0, failureCode: "front_master_qa_failed" },
      view: "front",
      generationId: "gen-1",
      override: { actorId: "admin-1", reason: "r" },
      failedFromState: PRODUCTION_STATES.AWAKE_GENERATING
    });
    const sideJob = calls.master[1].sideJobFactory("candidate-1");
    expect(sideJob.name).toBe(JOB_NAMES.GENERATE_SIDE);
  });

  it("resumes the prompt gate after a sleep override, and keeps the committed run when resume cannot release", async () => {
    const { workflow } = createWorkflowWithFakeStore();
    const released = { ...failedRun, state: PRODUCTION_STATES.VIDEO_GENERATING, version: 9 };
    const resume = vi.spyOn(workflow, "resumeAwaitingPromptGate").mockResolvedValueOnce(released);
    const outcome = await workflow.adminOverrideSleepMaster({
      run: { ...failedRun, failureCode: "sleep_master_qa_failed" },
      generationId: "gen-sleep",
      override: { actorId: "admin-1", reason: "r" },
      failedFromState: PRODUCTION_STATES.SLEEP_GENERATING
    });
    expect(outcome.state).toBe(PRODUCTION_STATES.VIDEO_GENERATING);
    resume.mockRejectedValueOnce(new Error("prompt idle is not published"));
    const holding = await workflow.adminOverrideSleepMaster({
      run: { ...failedRun, failureCode: "sleep_master_qa_failed" },
      generationId: "gen-sleep",
      override: { actorId: "admin-1", reason: "r" },
      failedFromState: PRODUCTION_STATES.SLEEP_GENERATING
    });
    expect(holding.state).toBe(PRODUCTION_STATES.AWAITING_PROMPT_GATE);
  });

  it("builds the override processing job around the chosen asset", async () => {
    const { workflow, calls } = createWorkflowWithFakeStore();
    await workflow.adminOverrideVideoAction({
      run: failedRun,
      actionId: "roll",
      sourceAssetId: "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f",
      override: { actorId: "admin-1", reason: "r" },
      failedFromState: PRODUCTION_STATES.VIDEO_GENERATING
    });
    const job = calls.action[0].job;
    expect(job.name).toBe(JOB_NAMES.PROCESS_VIDEO_ACTION);
    expect(job.data).toEqual({ runId: "run-1", actionId: "roll" });
  });
});

const overrideContext = () => ({
  order: { id: "order-1", amountFen: 4900, status: "paid" },
  project: { id: "project-1", displayName: "豆豆", state: "producing" },
  run: { ...failedRun },
  failedFromState: PRODUCTION_STATES.VIDEO_GENERATING,
  adminRerunCount: 0,
  masterAttempts: [
    {
      id: "gen-sleep", kind: "sleep", generationAttempt: 2, status: "qa_failed", lastErrorCode: null,
      qaStatus: "failed", qaReport: { ok: false, reasons: ["paw merged into blanket"] },
      objectKey: "private/masters/sleep-2.png", createdAt: null, updatedAt: null
    }
  ],
  actions: [
    { actionId: "roll", state: "failed", retryCount: 3, qaStatus: "failed", qaReport: null, objectKey: "private/videos/roll-3.mp4", updatedAt: null }
  ],
  rejectedActionVideos: [
    {
      actionId: "roll", assetId: "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f",
      qaReport: { ok: false, reasons: ["hole punched"] }, rejectedAt: null,
      objectKey: "private/videos/roll-3.mp4"
    }
  ],
  delivery: null,
  dispatch: { pending: 0, leased: 0, failed: 0, dead: 0 },
  timeline: []
});

function createService(context) {
  const audits = [];
  const repository = {
    findAdminOperations: vi.fn(async () => []),
    getAdminOrderRescueContext: vi.fn(async () => context),
    recordAdminAuditEvent: vi.fn(async (event) => { audits.push(event); return { recorded: true }; }),
    extendDeliveryWindow: vi.fn(),
    createAdminRefund: vi.fn(), applyAdminRefundRequested: vi.fn(), completeAdminRefund: vi.fn(),
    getAdminUserView: vi.fn(), setAdminUserStatus: vi.fn()
  };
  const workflow = {
    adminRerunCharacterMaster: vi.fn(), adminRerunSleepMaster: vi.fn(), adminRerunVideoAction: vi.fn(),
    adminGrantCharacterRegeneration: vi.fn(),
    adminOverrideCharacterMaster: vi.fn(async ({ run }) => ({ ...run, state: PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION })),
    adminOverrideSleepMaster: vi.fn(async ({ run }) => ({ ...run, state: PRODUCTION_STATES.VIDEO_GENERATING })),
    adminOverrideVideoAction: vi.fn(async ({ run }) => ({ ...run, state: PRODUCTION_STATES.VIDEO_GENERATING }))
  };
  const objectStore = {
    createDownloadGrant: vi.fn(async ({ objectKey }) => ({ url: `https://signed.example/${objectKey}`, expiresInSeconds: 600 }))
  };
  const service = new AdminOrdersService({ repository, workflow, objectStore, logger: { info() {}, warn() {}, error() {} } });
  return { service, workflow, audits };
}

const admin = Object.freeze({ id: "admin-1", role: "admin" });

describe("AdminOrdersService.qaOverrideStage", () => {
  it("overrides a rejected video chosen from the rejected list", async () => {
    const { service, workflow, audits } = createService(overrideContext());
    const outcome = await service.qaOverrideStage({
      actor: admin,
      orderId: "order-1",
      stage: "action:roll",
      candidateId: "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f",
      reason: "肉眼复核可交付"
    });
    expect(outcome.mode).toBe("qa_overridden");
    expect(workflow.adminOverrideVideoAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "roll",
      sourceAssetId: "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f"
    }));
    expect(audits[0].eventType).toBe("admin_qa_override_granted");
    expect(audits[0].metadata.candidateId).toBe("3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f");
  });

  it("refuses a video that is not on the action's rejected list", async () => {
    const { service } = createService(overrideContext());
    await expect(service.qaOverrideStage({
      actor: admin, orderId: "order-1", stage: "action:roll",
      candidateId: "ffffffff-ffff-4fff-8fff-ffffffffffff", reason: "r"
    })).rejects.toThrowError(/not a QA-rejected provider output/);
  });

  it("overrides a rejected sleep master by generation id", async () => {
    const context = { ...overrideContext(), failedFromState: PRODUCTION_STATES.SLEEP_GENERATING };
    const { service, workflow } = createService(context);
    const outcome = await service.qaOverrideStage({
      actor: admin, orderId: "order-1", stage: "sleep_master", candidateId: "gen-sleep", reason: "r"
    });
    expect(outcome.run.state).toBe(PRODUCTION_STATES.VIDEO_GENERATING);
    expect(workflow.adminOverrideSleepMaster).toHaveBeenCalledOnce();
  });

  it("refuses a master candidate of the wrong stage or verdict", async () => {
    const context = { ...overrideContext(), failedFromState: PRODUCTION_STATES.AWAKE_GENERATING };
    const { service } = createService(context);
    await expect(service.qaOverrideStage({
      actor: admin, orderId: "order-1", stage: "front_master", candidateId: "gen-sleep", reason: "r"
    })).rejects.toThrowError(/not a QA-rejected master attempt/);
  });

  it("refuses non-administrators", async () => {
    const { service } = createService(overrideContext());
    await expect(service.qaOverrideStage({
      actor: { id: "user-1", role: "user" }, orderId: "order-1",
      stage: "action:roll", candidateId: "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f", reason: "r"
    })).rejects.toThrowError(/Administrator role/);
  });
});

describe("admin QA override HTTP surface", () => {
  const orderId = "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f";
  const candidateId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  function createApi(adminOrdersService) {
    return createPetPackStudioHttpApi({
      adminOrdersService,
      resolveActor: async () => admin,
      logger: { info() {}, warn() {}, error() {} }
    });
  }

  it("routes the override and validates its body", async () => {
    const adminOrdersService = {
      searchOrders: vi.fn(), getOrderDetail: vi.fn(), rerunStage: vi.fn(), reissueDelivery: vi.fn(),
      qaOverrideStage: vi.fn(async () => ({ mode: "qa_overridden", stage: "action:roll", run: { id: "run-1", state: "video_generating" } }))
    };
    const api = createApi(adminOrdersService);
    const accepted = await api.handle({
      method: "POST",
      path: `/api/admin/orders/${orderId}/qa-override`,
      headers: {},
      body: JSON.stringify({ stage: "action:roll", candidateId, reason: "肉眼复核" })
    });
    expect(accepted.status).toBe(202);
    expect(accepted.body.mode).toBe("qa_overridden");

    const badCandidate = await api.handle({
      method: "POST",
      path: `/api/admin/orders/${orderId}/qa-override`,
      headers: {},
      body: JSON.stringify({ stage: "action:roll", candidateId: "not-a-uuid", reason: "r" })
    });
    expect(badCandidate.status).toBe(400);
    expect(adminOrdersService.qaOverrideStage).toHaveBeenCalledOnce();
  });

  it("serializes rejected videos with previews and without object keys", async () => {
    const adminOrdersService = {
      searchOrders: vi.fn(), rerunStage: vi.fn(), reissueDelivery: vi.fn(), qaOverrideStage: vi.fn(),
      getOrderDetail: vi.fn(async () => ({
        order: { id: "order-1" }, project: { id: "project-1" }, run: null, failedFromState: null,
        rescue: { adminRerunCount: 0, maxAdminRerunsPerOrder: 6, rerunBudgetExhausted: false, availableStages: [] },
        masters: [], actions: [],
        rejectedActionVideos: [{
          actionId: "roll", assetId: candidateId,
          qa: { status: "failed", reasons: ["hole punched"] },
          rejectedAt: "2026-08-21T00:00:00.000Z",
          previewUrl: "https://signed.example/videos/roll-3.mp4",
          objectKey: "private/should-not-leak.mp4"
        }],
        delivery: null, dispatch: { pending: 0, leased: 0, failed: 0, dead: 0 }, timeline: []
      }))
    };
    const api = createApi(adminOrdersService);
    const response = await api.handle({ method: "GET", path: `/api/admin/orders/${orderId}`, headers: {} });
    expect(response.status).toBe(200);
    const video = response.body.rejectedActionVideos[0];
    expect(video.previewUrl).toContain("https://signed.example/");
    expect(JSON.stringify(response.body)).not.toContain("should-not-leak");
  });
});
