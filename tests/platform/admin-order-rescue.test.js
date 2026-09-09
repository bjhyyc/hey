import { describe, expect, it, vi } from "vitest";

import stateMachineModule from "../../platform/src/domain/production-state-machine.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";
import adminOperationsModule from "../../platform/src/api/admin-operations-service.js";
import adminOrdersModule from "../../platform/src/api/admin-orders-service.js";
import httpApiModule from "../../platform/src/http/petpack-studio-http-api.js";

// Orders whose regeneration budgets are spent used to be dead ends: the run
// sat in `failed`, the customer had a support contact, and support had no tool
// to see the order, no way to authorize another generation, and no way to
// reopen a download. These are the P1 rescue paths: exactly one extra
// generation per authorization, reason-stamped audit rows, and no raised retry
// ceilings - a granted generation that fails QA again lands back in `failed`.

const {
  PRODUCTION_STATES,
  adminGrantCharacterRegeneration,
  adminRerunProductionRun
} = stateMachineModule;
const { ProductionWorkflow, JOB_NAMES } = workflowModule;
const { AdminOrdersService, availableRescueStages, parseStage, summarizeQaReport } = adminOrdersModule;
const { createAdminOperationsView } = adminOperationsModule;
const { createPetPackStudioHttpApi } = httpApiModule;

const modelRegistry = Object.freeze({
  version: "seedream-seedance-480p-v1",
  modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
});

const failedAwakeRun = Object.freeze({
  id: "run-1",
  projectId: "project-1",
  orderId: "order-1",
  species: "cat",
  modelRegistryVersion: modelRegistry.version,
  characterRevisionId: null,
  state: PRODUCTION_STATES.FAILED,
  failureCode: "front_master_qa_failed",
  frontGenerationAttempts: 3,
  sideGenerationAttempts: 0,
  frontUserRegenerationsUsed: 0,
  sideUserRegenerationsUsed: 0,
  frontQaRetries: 2,
  sideQaRetries: 0,
  sleepGenerationAttempts: 0,
  version: 7
});

describe("admin rerun state machine", () => {
  it("resumes a failed awake run for one more front-master generation", () => {
    const next = adminRerunProductionRun(failedAwakeRun, {
      stage: "front_master",
      failedFromState: PRODUCTION_STATES.AWAKE_GENERATING
    });
    expect(next.state).toBe(PRODUCTION_STATES.AWAKE_GENERATING);
    expect(next.frontGenerationAttempts).toBe(4);
    // Retry ceilings stay spent: another QA failure returns the run to failed.
    expect(next.frontQaRetries).toBe(2);
    expect(next.failureCode).toBeNull();
  });

  it("refuses a stage that does not match where the run died", () => {
    expect(() => adminRerunProductionRun(failedAwakeRun, {
      stage: "sleep_master",
      failedFromState: PRODUCTION_STATES.AWAKE_GENERATING
    })).toThrowError(/failed from awake_generating/);
    try {
      adminRerunProductionRun(failedAwakeRun, { stage: "sleep_master", failedFromState: PRODUCTION_STATES.AWAKE_GENERATING });
    } catch (error) {
      expect(error.code).toBe("admin_rerun_stage_unavailable");
    }
  });

  it("refuses to rerun a run that is not failed", () => {
    expect(() => adminRerunProductionRun(
      { ...failedAwakeRun, state: PRODUCTION_STATES.VIDEO_GENERATING },
      { stage: "front_master", failedFromState: PRODUCTION_STATES.AWAKE_GENERATING }
    )).toThrowError(/Only a failed production run/);
  });

  it("requires a confirmed character revision before a sleep rerun", () => {
    expect(() => adminRerunProductionRun(
      { ...failedAwakeRun, failureCode: "sleep_master_qa_failed" },
      { stage: "sleep_master", failedFromState: PRODUCTION_STATES.SLEEP_GENERATING }
    )).toThrowError(/confirmed character revision/);
  });

  it("hands one spent self-service regeneration back", () => {
    const run = {
      ...failedAwakeRun,
      state: PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION,
      failureCode: null,
      frontUserRegenerationsUsed: 2
    };
    const next = adminGrantCharacterRegeneration(run, { view: "front" });
    expect(next.frontUserRegenerationsUsed).toBe(1);
    expect(next.state).toBe(PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION);
  });

  it("refuses a grant when the customer still has regenerations", () => {
    const run = { ...failedAwakeRun, state: PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION, frontUserRegenerationsUsed: 0 };
    try {
      adminGrantCharacterRegeneration(run, { view: "front" });
      throw new Error("expected a grant refusal");
    } catch (error) {
      expect(error.code).toBe("admin_regeneration_grant_unavailable");
    }
  });
});

function createWorkflow() {
  const committed = [];
  const actionReruns = [];
  const runStore = {
    commitTransition: vi.fn(async (transition) => {
      committed.push(transition);
      return { ...transition.run, version: (transition.previousRun?.version ?? 0) + 1 };
    }),
    commitAdminActionRerun: vi.fn(async ({ previousRun, run, actionId, jobFactory }) => {
      const job = jobFactory(3);
      actionReruns.push({ previousRun, run, actionId, job });
      return { ...run, version: previousRun.version + 1 };
    })
  };
  const workflow = new ProductionWorkflow({
    runStore,
    queue: { enqueue: vi.fn() },
    promptStore: { listPublishedMetadata: vi.fn(async () => []) },
    modelRegistry,
    logger: { info() {}, warn() {}, error() {} }
  });
  return { workflow, committed, actionReruns, runStore };
}

describe("admin rerun workflow", () => {
  it("queues exactly one front-master job on an awake rerun", async () => {
    const { workflow, committed } = createWorkflow();
    await workflow.adminRerunCharacterMaster({
      run: failedAwakeRun,
      view: "front",
      failedFromState: PRODUCTION_STATES.AWAKE_GENERATING
    });
    expect(committed).toHaveLength(1);
    expect(committed[0].jobs).toHaveLength(1);
    const job = committed[0].jobs[0];
    expect(job.name).toBe(JOB_NAMES.GENERATE_FRONT);
    expect(job.data).toEqual({ runId: "run-1" });
  });

  it("queues a sleep job bound to the confirmed character revision", async () => {
    const { workflow, committed } = createWorkflow();
    const run = {
      ...failedAwakeRun,
      failureCode: "sleep_master_qa_failed",
      characterRevisionId: "revision-9",
      sleepGenerationAttempts: 3
    };
    await workflow.adminRerunSleepMaster({ run, failedFromState: PRODUCTION_STATES.SLEEP_GENERATING });
    expect(committed[0].jobs[0].name).toBe(JOB_NAMES.GENERATE_SLEEP);
    expect(committed[0].run.sleepGenerationAttempts).toBe(4);
  });

  it("commits an action rerun through the store with a per-retry dedupe key", async () => {
    const { workflow, actionReruns } = createWorkflow();
    const run = { ...failedAwakeRun, failureCode: "action_qa_failed" };
    await workflow.adminRerunVideoAction({
      run,
      actionId: "roll",
      failedFromState: PRODUCTION_STATES.VIDEO_GENERATING
    });
    expect(actionReruns).toHaveLength(1);
    expect(actionReruns[0].run.state).toBe(PRODUCTION_STATES.VIDEO_GENERATING);
    expect(actionReruns[0].job.name).toBe(JOB_NAMES.GENERATE_VIDEO);
    expect(actionReruns[0].job.data).toEqual({ runId: "run-1", actionId: "roll" });
  });

  it("commits a regeneration grant without queueing any job", async () => {
    const { workflow, committed } = createWorkflow();
    const run = {
      ...failedAwakeRun,
      state: PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION,
      failureCode: null,
      sideUserRegenerationsUsed: 2
    };
    await workflow.adminGrantCharacterRegeneration({ run, view: "side" });
    expect(committed).toHaveLength(1);
    expect(committed[0].jobs).toEqual([]);
    expect(committed[0].run.sideUserRegenerationsUsed).toBe(1);
  });
});

const baseContext = () => ({
  order: {
    id: "order-1", amountFen: 4900, currency: "CNY", paymentMethod: "KAIPAY", status: "paid",
    paidAt: "2026-08-19T00:00:00.000Z", deliveryStatus: "pending", planCode: "petpack-basic",
    createdAt: null, updatedAt: null
  },
  project: { id: "project-1", displayName: "豆豆", state: "producing", createdAt: null, updatedAt: null },
  run: { ...failedAwakeRun },
  failedFromState: PRODUCTION_STATES.AWAKE_GENERATING,
  adminRerunCount: 0,
  masterAttempts: [
    {
      id: "gen-1", kind: "front", generationAttempt: 1, status: "qa_failed", lastErrorCode: null,
      qaStatus: "failed", qaReport: { ok: false, reasons: ["subject colour drifted"] },
      objectKey: "private/masters/front-1.png", createdAt: null, updatedAt: null
    }
  ],
  actions: [
    {
      actionId: "roll", state: "failed", retryCount: 2, qaStatus: "failed",
      qaReport: { ok: false, reasons: ["hole punched through the pet"] },
      objectKey: "private/videos/roll-2.mp4", updatedAt: null
    }
  ],
  delivery: null,
  dispatch: { pending: 0, leased: 0, failed: 0, dead: 0 },
  timeline: []
});

function createService({ context = baseContext(), workflowOverrides = {}, maxAdminRerunsPerOrder = 6 } = {}) {
  const audits = [];
  const repository = {
    findAdminOperations: vi.fn(async () => []),
    getAdminOrderRescueContext: vi.fn(async () => context),
    recordAdminAuditEvent: vi.fn(async (event) => { audits.push(event); return { recorded: true }; }),
    extendDeliveryWindow: vi.fn(async () => ({ id: "delivery-1", status: "ready", downloadCount: 1, expiresAt: "2026-08-23T00:00:00.000Z" })),
    createAdminRefund: vi.fn(), applyAdminRefundRequested: vi.fn(), completeAdminRefund: vi.fn(),
    getAdminUserView: vi.fn(), setAdminUserStatus: vi.fn()
  };
  const workflow = {
    adminRerunCharacterMaster: vi.fn(async ({ run }) => ({ ...run, state: PRODUCTION_STATES.AWAKE_GENERATING })),
    adminRerunSleepMaster: vi.fn(async ({ run }) => ({ ...run, state: PRODUCTION_STATES.SLEEP_GENERATING })),
    adminRerunVideoAction: vi.fn(async ({ run }) => ({ ...run, state: PRODUCTION_STATES.VIDEO_GENERATING })),
    adminGrantCharacterRegeneration: vi.fn(async ({ run }) => ({ ...run })),
    adminOverrideCharacterMaster: vi.fn(),
    adminOverrideSleepMaster: vi.fn(),
    adminOverrideVideoAction: vi.fn(),
    ...workflowOverrides
  };
  const objectStore = {
    createDownloadGrant: vi.fn(async ({ objectKey }) => ({ url: `https://signed.example/${objectKey}`, expiresInSeconds: 600 }))
  };
  const service = new AdminOrdersService({
    repository,
    workflow,
    objectStore,
    maxAdminRerunsPerOrder,
    logger: { info() {}, warn() {}, error() {} }
  });
  return { service, repository, workflow, objectStore, audits };
}

const admin = Object.freeze({ id: "admin-1", role: "admin" });
const customer = Object.freeze({ id: "user-1", role: "user" });

describe("AdminOrdersService", () => {
  it("rejects non-administrators on every entry point", async () => {
    const { service } = createService();
    await expect(service.searchOrders({ actor: customer, orderId: "order-1" })).rejects.toThrowError(/Administrator role/);
    await expect(service.getOrderDetail({ actor: customer, orderId: "order-1" })).rejects.toThrowError(/Administrator role/);
    await expect(service.rerunStage({ actor: customer, orderId: "order-1", stage: "front_master", reason: "r" })).rejects.toThrowError(/Administrator role/);
    await expect(service.reissueDelivery({ actor: customer, orderId: "order-1", reason: "r" })).rejects.toThrowError(/Administrator role/);
  });

  it("signs previews and never exposes object keys in the detail", async () => {
    const { service } = createService();
    const detail = await service.getOrderDetail({ actor: admin, orderId: "order-1" });
    expect(detail.masters[0].previewUrl).toBe("https://signed.example/private/masters/front-1.png");
    expect(JSON.stringify(detail)).not.toContain("objectKey");
    expect(detail.masters[0].qa.reasons).toEqual(["subject colour drifted"]);
    // The failure code names the front view, so only the failed view is offered.
    expect(detail.rescue.availableStages).toEqual([{ stage: "front_master", mode: "rerun" }]);
  });

  it("authorizes a rerun with a reason and records the audit row", async () => {
    const { service, workflow, audits } = createService();
    const outcome = await service.rerunStage({ actor: admin, orderId: "order-1", stage: "front_master", reason: "客户来电" });
    expect(outcome.mode).toBe("rerun_authorized");
    expect(workflow.adminRerunCharacterMaster).toHaveBeenCalledOnce();
    expect(audits).toHaveLength(1);
    expect(audits[0].eventType).toBe("admin_rerun_granted");
    expect(audits[0].metadata.reason).toBe("客户来电");
  });

  it("refuses a rerun without a reason", async () => {
    const { service, workflow } = createService();
    await expect(service.rerunStage({ actor: admin, orderId: "order-1", stage: "front_master", reason: "  " }))
      .rejects.toThrowError(/reason is required/i);
    expect(workflow.adminRerunCharacterMaster).not.toHaveBeenCalled();
  });

  it("enforces the per-order rerun budget", async () => {
    const context = { ...baseContext(), adminRerunCount: 6 };
    const { service } = createService({ context });
    try {
      await service.rerunStage({ actor: admin, orderId: "order-1", stage: "front_master", reason: "r" });
      throw new Error("expected the budget refusal");
    } catch (error) {
      expect(error.code).toBe("admin_rerun_limit_reached");
    }
  });

  it("reruns a failed video action only when that action is failed", async () => {
    const context = { ...baseContext(), failedFromState: PRODUCTION_STATES.VIDEO_GENERATING };
    const { service, workflow } = createService({ context });
    const outcome = await service.rerunStage({ actor: admin, orderId: "order-1", stage: "action:roll", reason: "r" });
    expect(outcome.mode).toBe("rerun_authorized");
    expect(workflow.adminRerunVideoAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: "roll" }));
    await expect(service.rerunStage({ actor: admin, orderId: "order-1", stage: "action:idle", reason: "r" }))
      .rejects.toThrowError(/not in a failed state/);
  });

  it("grants a regeneration instead of queueing when the run awaits confirmation", async () => {
    const context = baseContext();
    context.run = {
      ...context.run,
      state: PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION,
      failureCode: null,
      frontUserRegenerationsUsed: 2
    };
    const { service, workflow, audits } = createService({ context });
    const outcome = await service.rerunStage({ actor: admin, orderId: "order-1", stage: "front_master", reason: "r" });
    expect(outcome.mode).toBe("regeneration_granted");
    expect(workflow.adminGrantCharacterRegeneration).toHaveBeenCalledOnce();
    expect(audits[0].eventType).toBe("admin_regeneration_granted");
  });

  it("reissues a delivery and stamps the audit trail", async () => {
    const { service, repository, audits } = createService();
    const outcome = await service.reissueDelivery({ actor: admin, orderId: "order-1", reason: "客户超时" });
    expect(outcome.mode).toBe("delivery_reissued");
    expect(repository.extendDeliveryWindow).toHaveBeenCalledOnce();
    expect(audits[0].eventType).toBe("admin_delivery_reissued");
  });

  it("still reports a committed rescue when the audit write fails", async () => {
    const { service, repository } = createService();
    repository.recordAdminAuditEvent.mockRejectedValueOnce(new Error("audit table offline"));
    const outcome = await service.rerunStage({ actor: admin, orderId: "order-1", stage: "front_master", reason: "r" });
    expect(outcome.mode).toBe("rerun_authorized");
  });
});

// The console offered - and the service executed - a rerun on an order that
// had already been refunded, which would have spent generation budget on an
// order the customer no longer held. A refund leaves the run `failed` exactly
// like any other failure, so nothing downstream could tell the difference;
// entitlement has to be judged on the order, not the run.
describe("rescues require an order that is still paid", () => {
  const refundedContext = () => {
    const context = baseContext();
    context.order = { ...context.order, status: "refund_pending" };
    return context;
  };

  it("offers no rescue stages once the order is no longer paid", () => {
    expect(availableRescueStages(refundedContext())).toEqual([]);
  });

  it("refuses a rerun, a QA override, and a delivery reissue on a refunded order", async () => {
    const { service, workflow, repository } = createService({ context: refundedContext() });
    for (const call of [
      service.rerunStage({ actor: admin, orderId: "order-1", stage: "front_master", reason: "r" }),
      service.qaOverrideStage({ actor: admin, orderId: "order-1", stage: "front_master", candidateId: "gen-1", reason: "r" }),
      service.reissueDelivery({ actor: admin, orderId: "order-1", reason: "r" })
    ]) {
      await expect(call).rejects.toMatchObject({ code: "admin_order_not_entitled" });
    }
    expect(workflow.adminRerunCharacterMaster).not.toHaveBeenCalled();
    expect(repository.extendDeliveryWindow).not.toHaveBeenCalled();
  });

  it("still allows a rescue while the order is paid", async () => {
    const { service } = createService();
    const outcome = await service.rerunStage({ actor: admin, orderId: "order-1", stage: "front_master", reason: "r" });
    expect(outcome.mode).toBe("rerun_authorized");
  });
});

// Two orders need a human without anything having failed. Neither reached the
// attention feed, so support could only find them if the customer read out an
// ID - which the customer has no reason to know they should do.
describe("attention feed covers the no-failure stuck shapes", () => {
  const baseRecord = () => ({
    activityAt: "2026-08-21T00:00:00.000Z",
    order: { id: "order-1", status: "paid", paymentMethod: "KAIPAY", amountFen: 4900 },
    project: { id: "project-1", state: "producing" },
    run: { id: "run-1", state: "video_generating", hasFailure: false, frontUserRegenerationsUsed: 0, sideUserRegenerationsUsed: 0 },
    actions: [],
    delivery: null,
    outbox: { pending: 0, leased: 0, failed: 0, dead: 0 }
  });

  it("flags a customer stuck at confirmation with their regenerations spent", () => {
    const record = baseRecord();
    record.run = { ...record.run, state: "awaiting_character_confirmation", frontUserRegenerationsUsed: 2 };
    const view = createAdminOperationsView(record);
    expect(view.attention.required).toBe(true);
    expect(view.attention.reasons).toContain("regenerations_exhausted");
  });

  it("flags a finished PetPack whose download window closed", () => {
    const record = baseRecord();
    record.delivery = { status: "ready", downloadCount: 1, expiresAt: "2020-01-01T00:00:00.000Z" };
    const view = createAdminOperationsView(record);
    expect(view.attention.reasons).toContain("delivery_expired");
  });

  it("leaves a healthy run and a live download alone", () => {
    const record = baseRecord();
    record.delivery = { status: "ready", downloadCount: 0, expiresAt: "2099-01-01T00:00:00.000Z" };
    expect(createAdminOperationsView(record).attention.required).toBe(false);
  });
});

describe("rescue helpers", () => {
  it("parses action stages against the canonical catalogue", () => {
    expect(parseStage("action:roll")).toEqual({ kind: "action", actionId: "roll", stage: "action:roll" });
    expect(() => parseStage("action:teleport")).toThrowError(/Unknown video action/);
    expect(() => parseStage("packaging")).toThrowError(/does not support stage/);
  });

  it("summarizes QA reasons without forwarding the raw report", () => {
    const summary = summarizeQaReport("failed", { ok: false, reasons: ["a", { reason: "b" }], secretKey: "private/x" });
    expect(summary).toEqual({ status: "failed", reasons: ["a", "b"] });
  });

  it("offers the package resume for a run that failed in packaging", () => {
    // This used to offer nothing, which left the first real delivered-pack redo
    // stranded: it died at petpack_build_commit_failed with a valid frozen
    // snapshot and no disposal to reach it. The resume covers both states the
    // pack-building half can die in.
    for (const failedFromState of [PRODUCTION_STATES.MEDIA_PROCESSING, PRODUCTION_STATES.PACKAGING]) {
      expect(availableRescueStages({ ...baseContext(), failedFromState }))
        .toEqual([{ stage: "package", mode: "rerun" }]);
    }
    // The steps after the build are not covered: a run that fails validation
    // has a built pack that failed its checks, which is a different question.
    expect(availableRescueStages({ ...baseContext(), failedFromState: PRODUCTION_STATES.VALIDATING })).toEqual([]);
  });
});

function createHttpApi({ adminOrdersService }) {
  return createPetPackStudioHttpApi({
    adminOrdersService,
    resolveActor: async () => admin,
    logger: { info() {}, warn() {}, error() {} }
  });
}

describe("delivery reissue window semantics", () => {
  it("extends with GREATEST so a reissue can never shorten an open window", async () => {
    // Live test on 2026-09-03 truncated a 30-day window to 72 hours because
    // the UPDATE blindly wrote now()+extend. The SQL must keep the later of
    // the two expiries.
    const { createRequire } = await import("node:module");
    const require2 = createRequire(import.meta.url);
    const source = require2("node:fs").readFileSync(
      require2.resolve("../../platform/src/persistence/postgres-petpack-studio-repository.js"), "utf8");
    const site = source.slice(source.indexOf("async extendDeliveryWindow"), source.indexOf("async extendDeliveryWindow") + 1600);
    expect(site).toContain("GREATEST(expires_at, now() + ($2 * interval '1 second'))");
  });
});

describe("admin orders HTTP surface", () => {
  const orderId = "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f";

  it("routes search, detail, rerun, and reissue", async () => {
    const adminOrdersService = {
      searchOrders: vi.fn(async () => ({ items: [] })),
      getOrderDetail: vi.fn(async () => baseContextDetail()),
      rerunStage: vi.fn(async () => ({ mode: "rerun_authorized", stage: "front_master", run: { id: "run-1", state: "awake_generating" } })),
      reissueDelivery: vi.fn(async () => ({ mode: "delivery_reissued", delivery: { status: "ready", expiresAt: "2026-08-23T00:00:00.000Z", downloadCount: 1 } }))
    };
    const api = createHttpApi({ adminOrdersService });

    const search = await api.handle({ method: "GET", path: `/api/admin/orders?orderId=${orderId}`, headers: {} });
    expect(search.status).toBe(200);
    expect(adminOrdersService.searchOrders).toHaveBeenCalledWith(expect.objectContaining({ orderId }));

    const detail = await api.handle({ method: "GET", path: `/api/admin/orders/${orderId}`, headers: {} });
    expect(detail.status).toBe(200);

    const rerun = await api.handle({
      method: "POST",
      path: `/api/admin/orders/${orderId}/rerun`,
      headers: {},
      body: JSON.stringify({ stage: "front_master", reason: "客户来电" })
    });
    expect(rerun.status).toBe(202);
    expect(rerun.body.mode).toBe("rerun_authorized");

    const reissue = await api.handle({
      method: "POST",
      path: `/api/admin/orders/${orderId}/delivery/reissue`,
      headers: {},
      body: JSON.stringify({ reason: "客户超时" })
    });
    expect(reissue.status).toBe(200);
  });

  it("routes the packaging resume as a rerun stage but never as an override", async () => {
    // The console's 恢复打包 died at this layer with 400 on 2026-09-03: only
    // the service's stage pattern had learned `package`, and the CLI test that
    // validated the disposal called the service directly, skipping this parse.
    const adminOrdersService = {
      searchOrders: vi.fn(),
      getOrderDetail: vi.fn(),
      rerunStage: vi.fn(async () => ({ mode: "rerun_authorized", stage: "package", run: { id: "run-1", state: "media_processing" } })),
      qaOverrideStage: vi.fn(),
      reissueDelivery: vi.fn()
    };
    const api = createHttpApi({ adminOrdersService });

    const packageRerun = await api.handle({
      method: "POST",
      path: `/api/admin/orders/${orderId}/rerun`,
      headers: {},
      body: JSON.stringify({ stage: "package", reason: "打包门修复后恢复" })
    });
    expect(packageRerun.status).toBe(202);
    expect(adminOrdersService.rerunStage).toHaveBeenCalledWith(expect.objectContaining({ stage: "package" }));

    const packageOverride = await api.handle({
      method: "POST",
      path: `/api/admin/orders/${orderId}/qa-override`,
      headers: {},
      body: JSON.stringify({ stage: "package", candidateId: orderId, reason: "r" })
    });
    expect(packageOverride.status).toBe(400);
    expect(adminOrdersService.qaOverrideStage).not.toHaveBeenCalled();
  });

  it("rejects malformed search and rerun input before the service runs", async () => {
    const adminOrdersService = {
      searchOrders: vi.fn(),
      getOrderDetail: vi.fn(),
      rerunStage: vi.fn(),
      qaOverrideStage: vi.fn(),
      reissueDelivery: vi.fn()
    };
    const api = createHttpApi({ adminOrdersService });

    const both = await api.handle({ method: "GET", path: `/api/admin/orders?orderId=${orderId}&projectId=${orderId}`, headers: {} });
    expect(both.status).toBe(400);

    const notUuid = await api.handle({ method: "GET", path: "/api/admin/orders?orderId=abc", headers: {} });
    expect(notUuid.status).toBe(400);

    const badStage = await api.handle({
      method: "POST",
      path: `/api/admin/orders/${orderId}/rerun`,
      headers: {},
      body: JSON.stringify({ stage: "DROP TABLE", reason: "r" })
    });
    expect(badStage.status).toBe(400);

    const missingReason = await api.handle({
      method: "POST",
      path: `/api/admin/orders/${orderId}/rerun`,
      headers: {},
      body: JSON.stringify({ stage: "front_master" })
    });
    expect(missingReason.status).toBe(400);
    expect(adminOrdersService.rerunStage).not.toHaveBeenCalled();
  });

  it("maps rescue refusal codes to 409 responses", async () => {
    const limitError = new Error("budget spent");
    limitError.code = "admin_rerun_limit_reached";
    const adminOrdersService = {
      searchOrders: vi.fn(),
      getOrderDetail: vi.fn(),
      rerunStage: vi.fn(async () => { throw limitError; }),
      reissueDelivery: vi.fn()
    };
    const api = createHttpApi({ adminOrdersService });
    const response = await api.handle({
      method: "POST",
      path: `/api/admin/orders/${orderId}/rerun`,
      headers: {},
      body: JSON.stringify({ stage: "front_master", reason: "r" })
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("admin_rerun_limit_reached");
  });

  it("serializes the detail fail-closed", async () => {
    const detailValue = baseContextDetail();
    detailValue.masters[0].objectKey = "private/should-not-leak.png";
    detailValue.unexpected = { secret: true };
    const adminOrdersService = {
      searchOrders: vi.fn(),
      getOrderDetail: vi.fn(async () => detailValue),
      rerunStage: vi.fn(),
      reissueDelivery: vi.fn()
    };
    const api = createHttpApi({ adminOrdersService });
    const response = await api.handle({ method: "GET", path: `/api/admin/orders/${orderId}`, headers: {} });
    const body = response.body;
    expect(body.unexpected).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("should-not-leak");
    expect(body.masters[0].previewUrl).toContain("https://signed.example/");
  });
});

function baseContextDetail() {
  return {
    order: { id: "order-1", amountFen: 4900, currency: "CNY", status: "paid" },
    project: { id: "project-1", displayName: "豆豆", state: "producing" },
    run: { id: "run-1", state: "failed", failureCode: "front_master_qa_failed", version: 7 },
    failedFromState: "awake_generating",
    rescue: { adminRerunCount: 0, maxAdminRerunsPerOrder: 6, rerunBudgetExhausted: false, availableStages: [{ stage: "front_master", mode: "rerun" }] },
    masters: [{ id: "gen-1", kind: "front", generationAttempt: 1, status: "qa_failed", qa: { status: "failed", reasons: ["drift"] }, previewUrl: "https://signed.example/masters/front-1.png" }],
    actions: [{ actionId: "roll", state: "failed", retryCount: 2, qa: { status: "failed", reasons: [] }, previewUrl: null }],
    delivery: null,
    dispatch: { pending: 0, leased: 0, failed: 0, dead: 0 },
    timeline: [{ source: "run", at: "2026-08-19T00:00:00.000Z", label: "failed", detail: "awake_generating" }]
  };
}
