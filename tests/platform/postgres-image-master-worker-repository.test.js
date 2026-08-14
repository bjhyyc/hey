import { describe, expect, it, vi } from "vitest";

import repositoryModule from "../../platform/src/persistence/postgres-image-master-worker-repository.js";

const { PostgresImageMasterWorkerRepository } = repositoryModule;

describe("Postgres image-master worker repository", () => {
  it("returns the frozen model registry version needed by finalizer workflow transitions", async () => {
    const runId = "10000000-0000-4000-8000-000000000001";
    const jobId = "petpack:front-finalizer-contract";
    const query = vi.fn(async (sql) => {
      if (sql.includes("FROM production_run run")) {
        return {
          rows: [{
            run_id: runId,
            project_id: "10000000-0000-4000-8000-000000000002",
            order_id: "10000000-0000-4000-8000-000000000003",
            character_revision_id: null,
            model_registry_version: "registry-480p-rehearsal-v1",
            run_state: "awake_generating",
            front_generation_attempts: 1,
            side_generation_attempts: 0,
            front_user_regenerations_used: 0,
            side_user_regenerations_used: 0,
            front_qa_retries: 0,
            side_qa_retries: 0,
            sleep_generation_attempts: 0,
            failure_code: null,
            run_version: 1,
            order_status: "paid"
          }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM production_job_execution") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            execution_id: "20000000-0000-4000-8000-000000000001",
            job_id: jobId,
            job_name: "petpack.finalize-front-master",
            execution_run_id: runId,
            action_id: null,
            execution_status: "pending",
            attempts: 0,
            max_attempts: 8,
            lease_token: null,
            leased_until: null,
            lease_active: false
          }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM master_image_generation generation")) {
        return {
          rows: [{
            id: "30000000-0000-4000-8000-000000000001",
            run_id: runId,
            kind: "front",
            status: "qa_passed",
            qa_status: "passed",
            generation_attempt: 1,
            image_candidate_id: "40000000-0000-4000-8000-000000000001",
            parent_front_candidate_id: null,
            parent_side_candidate_id: null,
            output_asset_id: "50000000-0000-4000-8000-000000000001",
            output_object_key: "private/rehearsal/front.png",
            output_sha256: "a".repeat(64),
            output_byte_size: 1024,
            output_content_type: "image/png"
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });
    let nextId = 1;
    const repository = new PostgresImageMasterWorkerRepository({
      database: { async transaction(callback) { return callback({ query }); } },
      idFactory: () => `60000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
      logger: { info() {}, warn() {}, error() {} }
    });

    const claim = await repository.claimMasterFinalization({
      jobId,
      jobName: "petpack.finalize-front-master",
      runId,
      maxAttempts: 8,
      leaseSeconds: 300,
      leaseOwner: "finalizer-contract-worker"
    });

    const runSelect = query.mock.calls.find(([sql]) => sql.includes("FROM production_run run"));
    expect(runSelect?.[0]).toContain("run.model_registry_version");
    expect(claim).toMatchObject({
      outcome: "claimed",
      runId,
      kind: "front",
      run: {
        id: runId,
        state: "awake_generating",
        version: 1,
        modelRegistryVersion: "registry-480p-rehearsal-v1"
      }
    });
    expect(claim.run).toMatchObject({
      id: runId,
      state: "awake_generating",
      version: 1,
      modelRegistryVersion: "registry-480p-rehearsal-v1"
    });
  });
});
