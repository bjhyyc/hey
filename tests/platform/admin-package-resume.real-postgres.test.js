import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

import databaseModule from "../../platform/src/persistence/postgres-database.js";
import repositoryModule from "../../platform/src/persistence/postgres-petpack-studio-repository.js";
import workerRepositoryModule from "../../platform/src/persistence/postgres-petpack-worker-repository.js";
import storeModule from "../../platform/src/persistence/postgres-transactional-workflow-store.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";
import adminOrdersModule from "../../platform/src/api/admin-orders-service.js";
import stateMachineModule from "../../platform/src/domain/production-state-machine.js";
import pipelineWorkerModule from "../../platform/src/workers/petpack-pipeline-worker.js";
import productionComponentsModule from "../../platform/src/runtime/production-worker-components.js";

// A run that reached the seven-action media gate with every master and video
// passed, and was refused there (2026-09-02: the confirmed side master's report
// had been overridden into a shape without top-level kind/provenance). The
// seed is that run, copied from production; the disposal under test queues
// packaging again without spending a single provider call, and the final
// assertion is the worker's own media-gate claim and evidence check - the
// exact gate that refused the run - accepting it.
//
// Runs only with PETPACK_TEST_POSTGRES_URL; PETPACK_TEST_POSTGRES_RESET_COMMAND
// reloads the seed before each case.

const { createPostgresDatabase } = databaseModule;
const { PostgresPetPackStudioRepository } = repositoryModule;
const { PostgresPetpackWorkerRepository } = workerRepositoryModule;
const { PostgresTransactionalWorkflowStore } = storeModule;
const { ProductionWorkflow, JOB_NAMES } = workflowModule;
const { AdminOrdersService } = adminOrdersModule;
const { PRODUCTION_STATES } = stateMachineModule;
const { assertProductionMediaSnapshotEvidence } = pipelineWorkerModule;
// The worker judges the seven videos under the pinned production policy - its
// per-action motion and chroma envelopes - not the default ceiling; the gate
// under test must see the same policy or fluffy takes that legitimately
// passed the action gate are refused here for the wrong reason.
const { PRODUCTION_QA_POLICY } = productionComponentsModule;

const databaseUrl = process.env.PETPACK_TEST_POSTGRES_URL || "";
const resetCommand = process.env.PETPACK_TEST_POSTGRES_RESET_COMMAND || "";
const quiet = { info() {}, warn() {}, error() {} };
const modelRegistry = Object.freeze({
  version: "seedream-seedance-480p-v1",
  modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
});

// The one-off repair applied to the production report that the old override
// had reshaped: lift the worker's report back to the top level and keep only
// the verdict keys overlaid - the shape the fixed override now writes.
const REPAIR_SQL = `
  UPDATE qa_report
     SET report = (report->'overriddenVerdict') || jsonb_build_object(
           'ok', true,
           'errors', '[]'::jsonb,
           'adminOverride', report->'adminOverride',
           'overriddenVerdict', jsonb_build_object(
             'ok', report->'overriddenVerdict'->'ok',
             'errors', COALESCE(report->'overriddenVerdict'->'errors', '[]'::jsonb),
             'warnings', COALESCE(report->'overriddenVerdict'->'warnings', '[]'::jsonb)
           )
         )
   WHERE id = $1
     AND status = 'passed'
     AND (report->'overriddenVerdict') ? 'provenance'
     AND NOT (report ? 'provenance')
  RETURNING id`;

describe.skipIf(!databaseUrl)("resuming a run refused at the media gate, against the production schema", () => {
  let database;
  let repository;
  let workerRepository;
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
    workerRepository = new PostgresPetpackWorkerRepository({ database, logger: quiet });
    const store = new PostgresTransactionalWorkflowStore({ database, logger: quiet });
    const workflow = new ProductionWorkflow({ runStore: store, promptStore: repository, modelRegistry, logger: quiet });
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
  });

  beforeEach(async () => {
    if (resetCommand) execSync(resetCommand, { stdio: "ignore" });
    const run = await one(
      `SELECT id, project_id, order_id, state, failure_code, version, character_revision_id FROM production_run
        WHERE state = 'failed' AND failure_code = 'production_evidence_provenance_invalid'`
    );
    const admin = await one(`SELECT id FROM app_user WHERE role = 'admin' AND status = 'active'`);
    const dead = await one(
      `SELECT id, job_id FROM production_job_execution
        WHERE run_id = $1 AND job_name = $2 AND action_id IS NULL AND status = 'dead'`,
      [run.id, JOB_NAMES.PROCESS_MEDIA]
    );
    const revision = await one(`SELECT side_candidate_id FROM character_revision WHERE id = $1`, [run.character_revision_id]);
    const sideReport = await one(`SELECT qa_report_id FROM image_candidate WHERE id = $1`, [revision.side_candidate_id]);
    seed = { run, admin, dead, sideReportId: sideReport.qa_report_id };
  });

  it("offers packaging resume as the only disposal for a run refused at the media gate", async () => {
    const detail = await adminOrders.getOrderDetail({ actor: { id: seed.admin.id, role: "admin" }, orderId: seed.run.order_id });
    expect(detail.rescue.availableStages).toEqual([{ stage: "package", mode: "rerun" }]);
  });

  it("refuses to treat packaging as a QA override", async () => {
    await expect(adminOrders.qaOverrideStage({
      actor: { id: seed.admin.id, role: "admin" },
      orderId: seed.run.order_id,
      stage: "package",
      candidateId: seed.sideReportId,
      reason: "错按"
    })).rejects.toThrowError(/resume it instead/);
  });

  it("repairs the overridden report, resumes packaging, and the worker's media gate accepts the run", async () => {
    const repaired = await database.query(REPAIR_SQL, [seed.sideReportId]);
    expect(repaired.rows).toHaveLength(1);
    const report = await one(`SELECT report FROM qa_report WHERE id = $1`, [seed.sideReportId]);
    expect(report.report.kind).toBe("side");
    expect(report.report.ok).toBe(true);
    expect(report.report.errors).toEqual([]);
    expect(report.report.provenance.evidenceClass).toBe("production");
    expect(report.report.overriddenVerdict.ok).toBe(false);
    expect(report.report.adminOverride.actorId).toBe(seed.admin.id);

    const outcome = await adminOrders.rerunStage({
      actor: { id: seed.admin.id, role: "admin" },
      orderId: seed.run.order_id,
      stage: "package",
      reason: "真库回归：证据修复后恢复打包"
    });
    expect(outcome.mode).toBe("rerun_authorized");
    expect(outcome.run.state).toBe(PRODUCTION_STATES.MEDIA_PROCESSING);

    const run = await one(`SELECT state, failure_code, version FROM production_run WHERE id = $1`, [seed.run.id]);
    expect(run.state).toBe(PRODUCTION_STATES.MEDIA_PROCESSING);
    expect(run.failure_code).toBeNull();
    expect(run.version).toBe(seed.run.version + 1);
    expect((await one(`SELECT state FROM pet_project WHERE id = $1`, [seed.run.project_id])).state).toBe("producing");

    // The dead gate execution is the one retargeted at the new job, so the
    // worker's claim finds exactly one run-level execution for the job name.
    const executions = await database.query(
      `SELECT id, job_id, status, attempts, last_error_code FROM production_job_execution
        WHERE run_id = $1 AND job_name = $2 AND action_id IS NULL`,
      [seed.run.id, JOB_NAMES.PROCESS_MEDIA]
    );
    expect(executions.rows).toHaveLength(1);
    const [execution] = executions.rows;
    expect(execution.id).toBe(seed.dead.id);
    expect(execution.job_id).not.toBe(seed.dead.job_id);
    expect(execution.status).toBe("pending");
    expect(execution.attempts).toBe(0);
    expect(execution.last_error_code).toBeNull();
    const job = await one(
      `SELECT payload FROM outbox_job WHERE aggregate_id = $1 AND job_name = $2 AND status = 'pending'`,
      [seed.run.id, JOB_NAMES.PROCESS_MEDIA]
    );
    expect(job.payload.options.jobId).toBe(execution.job_id);
    const audit = await database.query(
      `SELECT metadata FROM audit_event WHERE order_id = $1 AND event_type = 'admin_rerun_granted'`,
      [seed.run.order_id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.stage).toBe("package");
    expect(audit.rows[0].metadata.failedFromState).toBe(PRODUCTION_STATES.MEDIA_PROCESSING);

    // What the worker does next, verbatim: claim the gate with the queued job
    // and run the production evidence assertion that refused the run before.
    const claim = await workerRepository.claimMediaSnapshot({
      jobId: execution.job_id,
      runId: seed.run.id,
      maxAttempts: job.payload.options.attempts,
      leaseSeconds: 60,
      leaseOwner: "real-postgres-test",
      requireProductionEvidence: true
    });
    expect(claim.outcome).toBe("claimed");
    expect(Object.keys(claim.masterEvidence).sort()).toEqual(["front", "side", "sleep"]);
    expect(claim.actions).toHaveLength(7);
    let gate = null;
    try {
      assertProductionMediaSnapshotEvidence({ masterEvidence: claim.masterEvidence, actions: claim.actions, policy: PRODUCTION_QA_POLICY });
    } catch (error) {
      gate = `${error.message}: ${JSON.stringify(error.errors || null)}`;
    }
    expect(gate).toBeNull();
  });
});
