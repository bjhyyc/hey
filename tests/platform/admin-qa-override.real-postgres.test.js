import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

import databaseModule from "../../platform/src/persistence/postgres-database.js";
import repositoryModule from "../../platform/src/persistence/postgres-petpack-studio-repository.js";
import storeModule from "../../platform/src/persistence/postgres-transactional-workflow-store.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";
import adminOrdersModule from "../../platform/src/api/admin-orders-service.js";
import stateMachineModule from "../../platform/src/domain/production-state-machine.js";

// The support-console disposals were unit-tested against a scripted database,
// which is how a QA override that inserted a second image report for the same
// subject asset passed every test and then died on
// qa_report_image_subject_unique_idx the first time an administrator clicked it
// in production (2026-09-02). This suite drives the SAME object graph the API
// process composes - repository, workflow store, workflow, admin service -
// against a real PostgreSQL loaded with the production schema and a failed run
// shaped like that order, so every constraint the schema enforces is enforced
// here too.
//
// It only runs when PETPACK_TEST_POSTGRES_URL points at such a database;
// PETPACK_TEST_POSTGRES_RESET_COMMAND, when set, is executed before each case
// to reload the seed (each case commits real transactions).

const { createPostgresDatabase } = databaseModule;
const { PostgresPetPackStudioRepository } = repositoryModule;
const { PostgresTransactionalWorkflowStore } = storeModule;
const { ProductionWorkflow, JOB_NAMES } = workflowModule;
const { AdminOrdersService } = adminOrdersModule;
const { PRODUCTION_STATES } = stateMachineModule;

const databaseUrl = process.env.PETPACK_TEST_POSTGRES_URL || "";
const resetCommand = process.env.PETPACK_TEST_POSTGRES_RESET_COMMAND || "";
const quiet = { info() {}, warn() {}, error() {} };

const modelRegistry = Object.freeze({
  version: "seedream-seedance-480p-v1",
  modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
});

describe.skipIf(!databaseUrl)("support-console disposals against the production schema", () => {
  let database;
  let repository;
  let store;
  let workflow;
  let adminOrders;
  let seed;

  async function one(sql, params = []) {
    const result = await database.query(sql, params);
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  }

  beforeAll(async () => {
    database = createPostgresDatabase({
      environment: { PETPACK_POSTGRES_URL: databaseUrl, PETPACK_PLATFORM_MODE: "development" },
      logger: quiet
    });
    repository = new PostgresPetPackStudioRepository({ database, logger: quiet });
    store = new PostgresTransactionalWorkflowStore({ database, logger: quiet });
    workflow = new ProductionWorkflow({ runStore: store, promptStore: repository, modelRegistry, logger: quiet });
    adminOrders = new AdminOrdersService({
      repository,
      workflow,
      objectStore: { createDownloadGrant: async () => ({ url: "about:blank", expiresAt: new Date().toISOString() }) },
      paymentProvider: null,
      refundEnabled: false,
      logger: quiet
    });
  });

  afterAll(async () => {
    if (database && typeof database.close === "function") await database.close();
    else if (database?.pool?.end) await database.pool.end();
  });

  beforeEach(async () => {
    if (resetCommand) execSync(resetCommand, { stdio: "ignore" });
    const run = await one(
      `SELECT id, project_id, order_id, state, failure_code, version FROM production_run
        WHERE state = 'failed' AND failure_code = 'side_master_qa_failed'`
    );
    const admin = await one(`SELECT id FROM app_user WHERE role = 'admin' AND status = 'active'`);
    const sideAttemptOne = await one(
      `SELECT id, image_candidate_id, normalized_media_asset_id, qa_report_id
         FROM master_image_generation WHERE run_id = $1 AND kind = 'side' AND generation_attempt = 1`,
      [run.id]
    );
    const front = await one(
      `SELECT id FROM image_candidate WHERE run_id = $1 AND kind = 'front' AND qa_status = 'passed'`,
      [run.id]
    );
    seed = { run, admin, sideAttemptOne, frontCandidateId: front.id };
  });

  it("flips the rejected side report in place, promotes the candidate, and returns the run to confirmation", async () => {
    const outcome = await adminOrders.qaOverrideStage({
      actor: { id: seed.admin.id, role: "admin" },
      orderId: seed.run.order_id,
      stage: "side_master",
      candidateId: seed.sideAttemptOne.id,
      reason: "真库回归：蓝陨石边牧侧面 marking 门禁误拒"
    });
    expect(outcome.mode).toBe("qa_overridden");
    expect(outcome.run.state).toBe(PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION);

    const run = await one(`SELECT state, failure_code, version FROM production_run WHERE id = $1`, [seed.run.id]);
    expect(run.state).toBe(PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION);
    expect(run.failure_code).toBeNull();
    expect(run.version).toBe(seed.run.version + 1);

    // Still exactly one image report for the subject asset - the invariant the
    // old INSERT violated - and it is the rejected report, now passed, with the
    // machine verdict kept whole beside the authorization.
    const reports = await database.query(
      `SELECT id, status, report FROM qa_report WHERE subject_kind = 'image' AND subject_media_asset_id = $1`,
      [seed.sideAttemptOne.normalized_media_asset_id]
    );
    expect(reports.rows).toHaveLength(1);
    const [report] = reports.rows;
    expect(report.id).toBe(seed.sideAttemptOne.qa_report_id);
    expect(report.status).toBe("passed");
    expect(report.report.ok).toBe(true);
    expect(report.report.adminOverride.actorId).toBe(seed.admin.id);
    expect(report.report.adminOverride.overriddenQaReportId).toBe(seed.sideAttemptOne.qa_report_id);
    expect(report.report.overriddenVerdict.ok).toBe(false);
    expect(report.report.overriddenVerdict.errors.length).toBeGreaterThan(0);

    const candidate = await one(`SELECT qa_status, qa_report_id FROM image_candidate WHERE id = $1`, [seed.sideAttemptOne.image_candidate_id]);
    expect(candidate.qa_status).toBe("passed");
    expect(candidate.qa_report_id).toBe(report.id);
    const generation = await one(`SELECT status, qa_report_id FROM master_image_generation WHERE id = $1`, [seed.sideAttemptOne.id]);
    expect(generation.status).toBe("qa_passed");
    expect(generation.qa_report_id).toBe(report.id);

    // The other rejected attempts stay rejected; the disposal is audited.
    const rejected = await database.query(
      `SELECT count(*)::int AS n FROM master_image_generation WHERE run_id = $1 AND kind = 'side' AND status = 'qa_failed'`,
      [seed.run.id]
    );
    expect(rejected.rows[0].n).toBe(2);
    const audit = await database.query(
      `SELECT metadata FROM audit_event WHERE order_id = $1 AND event_type = 'admin_qa_override_granted'`,
      [seed.run.order_id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.stage).toBe("side_master");
    expect(audit.rows[0].metadata.candidateId).toBe(seed.sideAttemptOne.id);
  });

  it("lets the customer confirm the overridden side master and moves on to the sleeping master", async () => {
    await adminOrders.qaOverrideStage({
      actor: { id: seed.admin.id, role: "admin" },
      orderId: seed.run.order_id,
      stage: "side_master",
      candidateId: seed.sideAttemptOne.id,
      reason: "真库回归：先放行再确认"
    });
    // What PetPackStudioService.confirmCharacter does after its ownership and
    // payment guards: load the run and both candidates, then commit.
    const run = await repository.getRunByProject(seed.run.project_id);
    expect(run.state).toBe(PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION);
    const [front, side] = await Promise.all([
      repository.getCharacterCandidate(seed.run.project_id, "front", seed.frontCandidateId),
      repository.getCharacterCandidate(seed.run.project_id, "side", seed.sideAttemptOne.image_candidate_id)
    ]);
    expect(front.qaStatus).toBe("passed");
    expect(side.qaStatus).toBe("passed");

    const committed = await workflow.confirmCharacterMasters({
      run,
      frontMasterRevisionId: front.id,
      sideMasterRevisionId: side.id
    });
    expect(committed.state).toBe(PRODUCTION_STATES.SLEEP_GENERATING);

    const persisted = await one(`SELECT state, character_revision_id FROM production_run WHERE id = $1`, [seed.run.id]);
    expect(persisted.state).toBe(PRODUCTION_STATES.SLEEP_GENERATING);
    expect(persisted.character_revision_id).not.toBeNull();
    const revision = await one(`SELECT front_candidate_id, side_candidate_id FROM character_revision WHERE id = $1`, [persisted.character_revision_id]);
    expect(revision.front_candidate_id).toBe(seed.frontCandidateId);
    expect(revision.side_candidate_id).toBe(seed.sideAttemptOne.image_candidate_id);
    const confirmed = await database.query(
      `SELECT id FROM image_candidate WHERE id = ANY($1::uuid[]) AND confirmed_at IS NOT NULL`,
      [[seed.frontCandidateId, seed.sideAttemptOne.image_candidate_id]]
    );
    expect(confirmed.rows).toHaveLength(2);
    const job = await database.query(
      `SELECT job_name, status FROM outbox_job WHERE aggregate_id = $1 AND job_name = $2 AND status = 'pending'`,
      [seed.run.id, JOB_NAMES.GENERATE_SLEEP]
    );
    expect(job.rows).toHaveLength(1);
  });

  it("stages and requests a full refund with every side effect the schema must accept", async () => {
    const providerCalls = [];
    const refunds = new AdminOrdersService({
      repository,
      workflow,
      objectStore: { createDownloadGrant: async () => ({ url: "about:blank", expiresAt: new Date().toISOString() }) },
      paymentProvider: {
        refund: async (input) => { providerCalls.push(input); return { providerRefundId: "stub-provider-refund-1" }; },
        queryStatus: async () => ({ state: "refund_pending" })
      },
      refundEnabled: true,
      logger: quiet
    });
    const order = await one(`SELECT amount_fen FROM customer_order WHERE id = $1`, [seed.run.order_id]);
    const outcome = await refunds.refundOrder({
      actor: { id: seed.admin.id, role: "admin" },
      orderId: seed.run.order_id,
      reason: "真库回归：上线测试单全额退款"
    });
    expect(outcome.mode).toBe("refund_requested");
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].amountFen).toBe(order.amount_fen);

    const persistedOrder = await one(`SELECT status FROM customer_order WHERE id = $1`, [seed.run.order_id]);
    expect(persistedOrder.status).toBe("refund_pending");
    const refund = await one(`SELECT id, amount_fen, status, provider_refund_id FROM refund WHERE order_id = $1`, [seed.run.order_id]);
    expect(refund.amount_fen).toBe(order.amount_fen);
    expect(refund.provider_refund_id).toBe("stub-provider-refund-1");
    expect(providerCalls[0].refundId).toBe(refund.id);
    const audit = await database.query(
      `SELECT metadata FROM audit_event WHERE order_id = $1 AND event_type = 'admin_refund_requested'`,
      [seed.run.order_id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.refundId).toBe(refund.id);

    // A second click while the provider is still pending must not stage a
    // second refund row.
    const again = await refunds.refundOrder({ actor: { id: seed.admin.id, role: "admin" }, orderId: seed.run.order_id, reason: "再点一次" });
    expect(again.mode).toBe("refund_pending");
    const rows = await database.query(`SELECT count(*)::int AS n FROM refund WHERE order_id = $1`, [seed.run.order_id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("disables and re-enables a customer account, revoking sessions and refusing to touch an administrator", async () => {
    // A customer row cloned from the administrator's row shape, so no column
    // the schema requires is guessed here.
    const customer = await one(
      `INSERT INTO app_user
       SELECT (json_populate_record(a, json_build_object('id', gen_random_uuid(), 'role', 'user', 'status', 'active'))).*
         FROM app_user a WHERE a.id = $1
       RETURNING id`,
      [seed.admin.id]
    );
    const disabled = await adminOrders.setUserStatus({
      actor: { id: seed.admin.id, role: "admin" }, userId: customer.id, status: "disabled", reason: "真库回归：封禁"
    });
    expect(disabled.user.status).toBe("disabled");
    expect((await one(`SELECT status FROM app_user WHERE id = $1`, [customer.id])).status).toBe("disabled");
    const enabled = await adminOrders.setUserStatus({
      actor: { id: seed.admin.id, role: "admin" }, userId: customer.id, status: "active", reason: "真库回归：解封"
    });
    expect(enabled.user.status).toBe("active");
    await expect(adminOrders.setUserStatus({
      actor: { id: seed.admin.id, role: "admin" }, userId: seed.admin.id, status: "disabled", reason: "自我处置"
    })).rejects.toThrowError(/cannot change their own account status/);
    const audits = await database.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE actor_id = $1 AND event_type LIKE 'admin_user_%'`,
      [seed.admin.id]
    );
    expect(audits.rows[0].n).toBe(2);
  });

  it("re-runs the side master on the failed run when the administrator authorizes a rerun instead", async () => {
    const outcome = await adminOrders.rerunStage({
      actor: { id: seed.admin.id, role: "admin" },
      orderId: seed.run.order_id,
      stage: "side_master",
      reason: "真库回归：授权补发一次侧面生成"
    });
    expect(outcome.run.state).toBe(PRODUCTION_STATES.AWAKE_GENERATING);
    const run = await one(`SELECT state, failure_code, side_generation_attempts FROM production_run WHERE id = $1`, [seed.run.id]);
    expect(run.state).toBe(PRODUCTION_STATES.AWAKE_GENERATING);
    expect(run.failure_code).toBeNull();
    expect(run.side_generation_attempts).toBe(4);
    const job = await database.query(
      `SELECT job_name FROM outbox_job WHERE aggregate_id = $1 AND job_name = $2 AND status = 'pending'`,
      [seed.run.id, JOB_NAMES.GENERATE_SIDE]
    );
    expect(job.rows).toHaveLength(1);
    const audit = await database.query(
      `SELECT event_type FROM audit_event WHERE order_id = $1 AND event_type LIKE 'admin_%'`,
      [seed.run.order_id]
    );
    expect(audit.rows).toHaveLength(1);
  });
});
