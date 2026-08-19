import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

// The master picker lets an owner keep any version they generated, but the
// confirmation write path used to claim only the run's newest attempt: picking
// version 1 of 3 threw inside the transaction and surfaced as a 500. The rule
// lives entirely in SQL, so the predicates are asserted directly here.

const require = createRequire(import.meta.url);
const {
  PostgresTransactionalWorkflowStore
} = require("../../platform/src/persistence/postgres-transactional-workflow-store");

const RUN_ID = "20000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const FRONT_ID = "20000000-0000-4000-8000-000000000003";
const SIDE_ID = "20000000-0000-4000-8000-000000000004";

function runAt(state, version) {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    orderId: "20000000-0000-4000-8000-000000000005",
    state,
    version,
    modelRegistryVersion: "registry-2026-08-01",
    frontGenerationAttempts: 3,
    sideGenerationAttempts: 1
  };
}

const sleepJob = {
  name: "petpack.generate-sleep-master",
  data: { runId: RUN_ID },
  dedupeKey: "petpack-sleep-one",
  options: { jobId: "petpack-sleep-one", attempts: 3 }
};

function buildStore({ claimRows = 1 } = {}) {
  const statements = [];
  const query = vi.fn(async (sql) => {
    statements.push(sql);
    if (sql.includes("FROM production_run\n         JOIN image_candidate")) {
      const rows = claimRows === 1 ? [{ id: FRONT_ID, project_id: PROJECT_ID }] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO character_revision")) {
      return { rows: [{ id: "20000000-0000-4000-8000-000000000006" }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE production_run")) {
      return {
        rows: [{
          id: RUN_ID, project_id: PROJECT_ID, order_id: "20000000-0000-4000-8000-000000000005",
          character_revision_id: "20000000-0000-4000-8000-000000000006",
          state: "sleep_generating", model_registry_version: "registry-2026-08-01",
          version: 8, updated_at: new Date("2026-08-19T17:30:00.000Z")
        }],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const database = { query, transaction: vi.fn(async (callback) => callback({ query })) };
  const store = new PostgresTransactionalWorkflowStore({
    database,
    idFactory: () => "20000000-0000-4000-8000-000000000006",
    logger: { info() {}, warn() {}, error() {} }
  });
  return { store, statements };
}

const confirm = (store) => store.confirmCharacterCandidatesAndCommitTransition({
  previousRun: runAt("awaiting_character_confirmation", 7),
  run: { ...runAt("sleep_generating", 7) },
  frontCandidateId: FRONT_ID,
  sideCandidateId: SIDE_ID,
  jobs: [sleepJob]
});

describe("character confirmation candidate claim", () => {
  it("claims any attempt up to the run's current count, not only the newest", async () => {
    const { store, statements } = buildStore();
    await confirm(store);
    const claims = statements.filter((sql) => sql.includes("FROM production_run\n         JOIN image_candidate"));
    expect(claims).toHaveLength(2);
    for (const sql of claims) {
      expect(sql).toMatch(/candidate\.generation_attempt <= production_run\.(front|side)_generation_attempts/);
      expect(sql).not.toMatch(/candidate\.generation_attempt = production_run\./);
      // The generation and QA rows belong to the chosen version, so they are
      // keyed on the candidate rather than on whatever the run generated last.
      expect(sql).toContain("generation.generation_attempt = candidate.generation_attempt");
      expect(sql).not.toMatch(/generation\.generation_attempt = production_run\./);
    }
  });

  it("still refuses a candidate that is not quality-approved for the run", async () => {
    const { store } = buildStore({ claimRows: 0 });
    await expect(confirm(store)).rejects.toThrow(/front character is not a quality-approved candidate/);
  });
});
