import { describe, expect, it } from "vitest";

import stateMachineModule from "../../platform/src/domain/production-state-machine.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";
import storeModule from "../../platform/src/persistence/postgres-transactional-workflow-store.js";

// A run that died on its way to a finished pack still holds every master and
// video it needs. The administrator's disposal for it is a resume: back to the
// state it fell out of, a fresh job for that step, and its dead execution row
// retargeted at that job - no provider call, no regeneration.
//
// There are two such states, because the work after the last video is two
// steps. A run refused at the seven-action media gate has to freeze its
// snapshot again. A run that died building the archive - which is how the first
// real delivered-pack redo ended, on petpack_build_commit_failed - keeps the
// snapshot the gate froze, so it resumes at the build and reuses those frozen
// inputs rather than being dragged back through work that succeeded.

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

function resumeJob(jobId = "petpack:resume-1", name = JOB_NAMES.PROCESS_MEDIA) {
  return {
    name,
    data: { runId: "run-1" },
    options: { jobId, attempts: 3 },
    dedupeKey: jobId
  };
}

// The same run one step later: the media gate passed and froze the snapshot,
// then the build died. This is order 4a0aefd3's redo.
const buildFailedRun = Object.freeze({
  ...refusedRun,
  failureCode: "petpack_build_commit_failed",
  version: 18
});

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

  it("returns a run that died building the archive to packaging", () => {
    const next = adminRerunProductionRun(buildFailedRun, {
      stage: "package",
      failedFromState: PRODUCTION_STATES.PACKAGING
    });
    // Not media_processing: the snapshot the gate froze is still valid and the
    // build reads it from the database, so redoing the gate would be work for
    // nothing - and would have to delete and rewrite rows that are correct.
    expect(next.state).toBe(PRODUCTION_STATES.PACKAGING);
    expect(next.failureCode).toBeNull();
    expect(next.sideGenerationAttempts).toBe(buildFailedRun.sideGenerationAttempts);
  });

  it("refuses the package stage for a run that died elsewhere", () => {
    expect(() => adminRerunProductionRun(refusedRun, {
      stage: "package",
      failedFromState: PRODUCTION_STATES.VIDEO_GENERATING
    })).toThrowError(/not from the package stage/);
    expect(() => adminRerunProductionRun(refusedRun, {
      stage: "package",
      failedFromState: PRODUCTION_STATES.VALIDATING
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

  it("retargets the dead build execution when the run resumes at packaging", async () => {
    const { store, executed } = scriptedStore([
      ["INSERT INTO production_run_event", { rows: [] }],
      ["UPDATE production_run", updatedRunRow],
      ["UPDATE production_job_execution", { rows: [{ id: "execution-dead-build" }] }],
      ["UPDATE pet_project", { rows: [] }],
      ["INSERT INTO outbox_job", { rows: [] }]
    ]);
    const next = { ...buildFailedRun, state: PRODUCTION_STATES.PACKAGING, failureCode: null };
    const job = resumeJob("petpack:resume-build-1", JOB_NAMES.BUILD_PACKAGE);
    const committed = await store.commitAdminMediaProcessingResume({ previousRun: buildFailedRun, run: next, job });
    expect(committed.state).toBe(PRODUCTION_STATES.PACKAGING);
    // The dead row it revives is the build's, not the gate's - reviving the
    // gate's would leave the build with nothing to claim.
    const execution = executed.find((entry) => entry.sql.includes("UPDATE production_job_execution"));
    expect(execution.params).toEqual(["run-1", "petpack:resume-build-1", JOB_NAMES.BUILD_PACKAGE]);
    const outbox = executed.find((entry) => entry.sql.includes("INSERT INTO outbox_job"));
    expect(outbox.params[2]).toBe(JOB_NAMES.BUILD_PACKAGE);
  });

  it("refuses when the run has no dead execution to resume", async () => {
    const { store } = scriptedStore([
      ["INSERT INTO production_run_event", { rows: [] }],
      ["UPDATE production_run", updatedRunRow],
      ["UPDATE production_job_execution", { rows: [] }]
    ]);
    const next = { ...refusedRun, state: PRODUCTION_STATES.MEDIA_PROCESSING, failureCode: null };
    await expect(store.commitAdminMediaProcessingResume({ previousRun: refusedRun, run: next, job: resumeJob() }))
      .rejects.toThrowError(/no dead petpack\.process-media execution/);
  });

  it("queues the job belonging to the state the run is going back to", async () => {
    const { store } = scriptedStore([]);
    // Resuming at the gate may only queue process-media...
    const atGate = { ...refusedRun, state: PRODUCTION_STATES.MEDIA_PROCESSING, failureCode: null };
    await expect(store.commitAdminMediaProcessingResume({
      previousRun: refusedRun,
      run: atGate,
      job: resumeJob("petpack:resume-1", JOB_NAMES.BUILD_PACKAGE)
    })).rejects.toThrowError(/petpack\.process-media job/);
    await expect(store.commitAdminMediaProcessingResume({
      previousRun: refusedRun,
      run: atGate,
      job: { ...resumeJob(), data: { runId: "run-2" } }
    })).rejects.toThrowError(/petpack\.process-media job/);
    // ...and resuming at the build may only queue build-package.
    const atBuild = { ...buildFailedRun, state: PRODUCTION_STATES.PACKAGING, failureCode: null };
    await expect(store.commitAdminMediaProcessingResume({
      previousRun: buildFailedRun,
      run: atBuild,
      job: resumeJob("petpack:resume-build-1", JOB_NAMES.PROCESS_MEDIA)
    })).rejects.toThrowError(/petpack\.build-package job/);
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

  it("queues the build again for a run that died building the archive", async () => {
    const calls = [];
    const runStore = {
      commitTransition: async ({ run }) => ({ ...run, version: 19 }),
      commitAdminMediaProcessingResume: async (input) => { calls.push(input); return { ...input.run, version: 19 }; }
    };
    const workflow = new ProductionWorkflow({
      runStore,
      queue: { enqueue: async () => {} },
      promptStore: { listPublishedMetadata: async () => [] },
      modelRegistry,
      logger: { info() {}, warn() {}, error() {} }
    });
    const committed = await workflow.adminResumeMediaProcessing({
      run: buildFailedRun,
      failedFromState: PRODUCTION_STATES.PACKAGING
    });
    expect(committed.state).toBe(PRODUCTION_STATES.PACKAGING);
    expect(calls[0].job.name).toBe(JOB_NAMES.BUILD_PACKAGE);
    expect(calls[0].run.state).toBe(PRODUCTION_STATES.PACKAGING);
  });
});
