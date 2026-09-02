import { describe, expect, it } from "vitest";

import stateMachineModule from "../../platform/src/domain/production-state-machine.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";
import storeModule from "../../platform/src/persistence/postgres-transactional-workflow-store.js";

// A run refused at the seven-action media gate still holds every master and
// video it needs. The administrator's disposal for it is a resume: back to
// media_processing, a fresh process-media job, and the gate's dead execution
// row retargeted at that job - no provider call, no regeneration.

const { PRODUCTION_STATES, adminRerunProductionRun, adminQaOverrideProductionRun } = stateMachineModule;
const { ProductionWorkflow, JOB_NAMES } = workflowModule;
const { PostgresTransactionalWorkflowStore } = storeModule;

const modelRegistry = Object.freeze({
  version: "seedream-seedance-480p-v1",
  modelArk: { image: { maxRetries: 2 }, video: { maxRetries: 2 } }
});

const refusedRun = Object.freeze({
  id: "run-1",
  projectId: "project-1",
  orderId: "order-1",
  species: "dog",
  modelRegistryVersion: modelRegistry.version,
  characterRevisionId: "revision-9",
  state: PRODUCTION_STATES.FAILED,
  failureCode: "production_evidence_provenance_invalid",
  frontGenerationAttempts: 1,
  sideGenerationAttempts: 5,
  frontUserRegenerationsUsed: 0,
  sideUserRegenerationsUsed: 1,
  frontQaRetries: 0,
  sideQaRetries: 2,
  sleepGenerationAttempts: 1,
  version: 14
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
    state: params[1], model_registry_version: modelRegistry.version, version: 15, updated_at: "now"
  }]
});

function resumeJob(jobId = "petpack:resume-1") {
  return {
    name: JOB_NAMES.PROCESS_MEDIA,
    data: { runId: "run-1" },
    options: { jobId, attempts: 3 },
    dedupeKey: jobId
  };
}

describe("package resume state machine", () => {
  it("returns a run refused at the media gate to media_processing", () => {
    const next = adminRerunProductionRun(refusedRun, {
      stage: "package",
      failedFromState: PRODUCTION_STATES.MEDIA_PROCESSING
    });
    expect(next.state).toBe(PRODUCTION_STATES.MEDIA_PROCESSING);
    expect(next.failureCode).toBeNull();
    // No generation budget moves: nothing is regenerated.
    expect(next.sideGenerationAttempts).toBe(refusedRun.sideGenerationAttempts);
    expect(next.sleepGenerationAttempts).toBe(refusedRun.sleepGenerationAttempts);
  });

  it("refuses the package stage for a run that died elsewhere", () => {
    expect(() => adminRerunProductionRun(refusedRun, {
      stage: "package",
      failedFromState: PRODUCTION_STATES.VIDEO_GENERATING
    })).toThrowError(/not from the package stage/);
  });

  it("has no QA verdict to override at the package stage", () => {
    expect(() => adminQaOverrideProductionRun(refusedRun, {
      stage: "package",
      failedFromState: PRODUCTION_STATES.MEDIA_PROCESSING
    })).toThrowError(/does not support stage: package/);
  });
});

describe("workflow store packaging resume", () => {
  it("transitions the run, retargets the dead gate execution, revives the project, queues the job", async () => {
    const { store, executed } = scriptedStore([
      ["INSERT INTO production_run_event", { rows: [] }],
      ["UPDATE production_run", updatedRunRow],
      ["UPDATE production_job_execution", { rows: [{ id: "execution-dead" }] }],
      ["UPDATE pet_project", { rows: [] }],
      ["INSERT INTO outbox_job", { rows: [] }]
    ]);
    const next = { ...refusedRun, state: PRODUCTION_STATES.MEDIA_PROCESSING, failureCode: null };
    const committed = await store.commitAdminMediaProcessingResume({ previousRun: refusedRun, run: next, job: resumeJob() });
    expect(committed.state).toBe(PRODUCTION_STATES.MEDIA_PROCESSING);

    const execution = executed.find((entry) => entry.sql.includes("UPDATE production_job_execution"));
    expect(execution.sql).toContain("status = 'pending'");
    expect(execution.sql).toContain("AND status = 'dead'");
    expect(execution.sql).toContain("action_id IS NULL");
    expect(execution.params).toEqual(["run-1", "petpack:resume-1", JOB_NAMES.PROCESS_MEDIA]);
    const project = executed.find((entry) => entry.sql.includes("UPDATE pet_project"));
    expect(project.sql).toContain("state = 'producing'");
    expect(project.sql).toContain("state = 'failed'");
    expect(project.params).toEqual(["project-1"]);
    const outbox = executed.find((entry) => entry.sql.includes("INSERT INTO outbox_job"));
    expect(outbox.params[2]).toBe(JOB_NAMES.PROCESS_MEDIA);
    expect(outbox.params[4]).toBe("petpack:resume-1");
  });

  it("refuses when the run has no dead media-gate execution to resume", async () => {
    const { store } = scriptedStore([
      ["INSERT INTO production_run_event", { rows: [] }],
      ["UPDATE production_run", updatedRunRow],
      ["UPDATE production_job_execution", { rows: [] }]
    ]);
    const next = { ...refusedRun, state: PRODUCTION_STATES.MEDIA_PROCESSING, failureCode: null };
    await expect(store.commitAdminMediaProcessingResume({ previousRun: refusedRun, run: next, job: resumeJob() }))
      .rejects.toThrowError(/no dead media-gate execution/);
  });

  it("only queues this run's process-media job", async () => {
    const { store } = scriptedStore([]);
    const next = { ...refusedRun, state: PRODUCTION_STATES.MEDIA_PROCESSING, failureCode: null };
    await expect(store.commitAdminMediaProcessingResume({
      previousRun: refusedRun,
      run: next,
      job: { ...resumeJob(), name: JOB_NAMES.BUILD_PACKAGE }
    })).rejects.toThrowError(/process-media job/);
    await expect(store.commitAdminMediaProcessingResume({
      previousRun: refusedRun,
      run: next,
      job: { ...resumeJob(), data: { runId: "run-2" } }
    })).rejects.toThrowError(/process-media job/);
  });
});

describe("workflow packaging resume", () => {
  it("queues a fresh process-media revision the earlier gate attempt never used", async () => {
    const calls = [];
    const runStore = {
      commitTransition: async ({ run }) => ({ ...run, version: 15 }),
      commitAdminMediaProcessingResume: async (input) => { calls.push(input); return { ...input.run, version: 15 }; }
    };
    const workflow = new ProductionWorkflow({
      runStore,
      queue: { enqueue: async () => {} },
      promptStore: { listPublishedMetadata: async () => [] },
      modelRegistry,
      logger: { info() {}, warn() {}, error() {} }
    });
    const committed = await workflow.adminResumeMediaProcessing({
      run: refusedRun,
      failedFromState: PRODUCTION_STATES.MEDIA_PROCESSING
    });
    expect(committed.state).toBe(PRODUCTION_STATES.MEDIA_PROCESSING);
    expect(calls).toHaveLength(1);
    const [{ previousRun, run, job }] = calls;
    expect(previousRun).toBe(refusedRun);
    expect(run.failureCode).toBeNull();
    expect(job.name).toBe(JOB_NAMES.PROCESS_MEDIA);
    expect(job.data).toEqual({ runId: "run-1" });
    expect(job.options.attempts).toBe(3);
    expect(job.options.jobId).toBe(job.dedupeKey);
    // A second resume at a later version gets a different job id.
    await workflow.adminResumeMediaProcessing({
      run: { ...refusedRun, version: 16 },
      failedFromState: PRODUCTION_STATES.MEDIA_PROCESSING
    });
    expect(calls[1].job.options.jobId).not.toBe(job.options.jobId);
  });
});
