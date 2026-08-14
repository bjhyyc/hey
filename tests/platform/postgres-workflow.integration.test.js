import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import databaseModule from "../../platform/src/persistence/postgres-database.js";
import storeModule from "../../platform/src/persistence/postgres-transactional-workflow-store.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";

const platformRequire = createRequire(new URL("../../platform/package.json", import.meta.url));
const { Pool } = platformRequire("pg");
const { PostgresDatabase } = databaseModule;
const { PostgresTransactionalWorkflowStore } = storeModule;
const { ProductionWorkflow } = workflowModule;

const connectionString = process.env.PETPACK_TEST_POSTGRES_URL || "";
const integration = connectionString ? describe : describe.skip;

integration("PostgreSQL production workflow integration", () => {
  const ids = {
    user: "10000000-0000-4000-8000-000000000001",
    plan: "10000000-0000-4000-8000-000000000002",
    project: "10000000-0000-4000-8000-000000000003",
    order: "10000000-0000-4000-8000-000000000004",
    run: "10000000-0000-4000-8000-000000000005"
  };
  let pool;
  let database;

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 2 });
    database = new PostgresDatabase({ pool, logger: { debug() {}, warn() {}, error() {} } });
    await pool.query(
      `INSERT INTO app_user (id, phone_hash) VALUES ($1, 'integration-phone')
       ON CONFLICT (id) DO NOTHING`,
      [ids.user]
    );
    await pool.query(
      `INSERT INTO product_plan (id, code, name, amount_fen, enabled)
       VALUES ($1, 'integration-plan', 'Integration plan', 100, true)
       ON CONFLICT (id) DO NOTHING`,
      [ids.plan]
    );
    await pool.query(
      `INSERT INTO pet_project (id, user_id, display_name, state)
       VALUES ($1, $2, 'Integration pet', 'awaiting_photos')
       ON CONFLICT (id) DO NOTHING`,
      [ids.project, ids.user]
    );
    await pool.query(
      `INSERT INTO customer_order
        (id, user_id, project_id, plan_id, amount_fen, payment_method, status, paid_at)
       VALUES ($1, $2, $3, $4, 100, 'KAIPAY', 'paid', now())
       ON CONFLICT (id) DO NOTHING`,
      [ids.order, ids.user, ids.project, ids.plan]
    );
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  it("atomically persists the frozen model version, run state, and ID-only outbox jobs", async () => {
    const store = new PostgresTransactionalWorkflowStore({
      database,
      idFactory: (() => {
        let next = 100;
        return () => `20000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
      })(),
      logger: { info() {}, warn() {}, error() {} }
    });
    const workflow = new ProductionWorkflow({
      runStore: store,
      promptStore: { async listPublishedMetadata() { return []; } },
      modelRegistry: {
        version: "registry-480p-integration-v1",
        modelArk: {
          image: { endpointId: "seedream", maxRetries: 2 },
          video: { endpointId: "seedance", resolution: "480p", maxRetries: 2 }
        }
      },
      logger: { info() {}, warn() {}, error() {} }
    });

    const order = { id: ids.order, status: "paid" };
    const started = await workflow.startPaidOrder({ order, projectId: ids.project, runId: ids.run });
    const duplicate = await workflow.startPaidOrder({ order, projectId: ids.project, runId: ids.run });
    const photosAccepted = await workflow.photosAccepted({
      run: started,
      sourcePhotoRevisionId: "30000000-0000-4000-8000-000000000001"
    });

    expect(duplicate.id).toBe(ids.run);
    expect(photosAccepted).toMatchObject({
      id: ids.run,
      state: "awake_generating",
      version: 1,
      modelRegistryVersion: "registry-480p-integration-v1",
      frontGenerationAttempts: 1
    });

    const runRows = await pool.query(
      `SELECT state, model_registry_version, front_generation_attempts, version
         FROM production_run WHERE id = $1`,
      [ids.run]
    );
    expect(runRows.rows).toEqual([{
      state: "awake_generating",
      model_registry_version: "registry-480p-integration-v1",
      front_generation_attempts: 1,
      version: 1
    }]);

    const outbox = await pool.query(
      `SELECT job_name, payload FROM outbox_job
        WHERE aggregate_id = $1 ORDER BY created_at, job_name`,
      [ids.run]
    );
    expect(outbox.rows.map((row) => row.job_name).sort()).toEqual([
      "petpack.await-photos",
      "petpack.generate-front-master"
    ]);
    for (const row of outbox.rows) {
      expect(Object.keys(row.payload.data).sort()).toEqual(["runId"]);
      expect(row.payload.data.runId).toBe(ids.run);
    }
  });
});
