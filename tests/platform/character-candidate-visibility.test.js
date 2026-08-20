import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

// After a regeneration failed quality three times the run's attempt counter
// pointed at a version that never existed, so the character page showed no
// master at all and the customer's good first version became invisible. The
// master on show is the newest version that passed, not the newest attempted.

const require = createRequire(import.meta.url);
const { PostgresPetPackStudioRepository } = require("../../platform/src/persistence/postgres-petpack-studio-repository");

const PROJECT_ID = "30000000-0000-4000-8000-000000000001";

function repositoryFor(rows) {
  const query = vi.fn(async () => ({ rows }));
  const repository = new PostgresPetPackStudioRepository({
    database: { transaction: vi.fn(async (callback) => callback({ query })) },
    idFactory: vi.fn()
  });
  return { repository, query };
}

const passedRow = {
  id: "30000000-0000-4000-8000-000000000002",
  project_id: PROJECT_ID,
  qa_status: "passed",
  confirmed_at: null,
  kind: "front",
  object_key: "private/projects/p/awake-master/one.png"
};

describe("character candidate visibility", () => {
  it("selects the newest passing version rather than the newest attempt", async () => {
    const { repository, query } = repositoryFor([passedRow]);

    const candidate = await repository.getCharacterCandidate(PROJECT_ID, "front");

    expect(candidate.id).toBe(passedRow.id);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("candidate.generation_attempt <= run.front_generation_attempts");
    expect(sql).not.toMatch(/candidate\.generation_attempt = run\./);
    expect(sql).toContain("generation.generation_attempt = candidate.generation_attempt");
    expect(sql).toContain("ORDER BY candidate.generation_attempt DESC, candidate.created_at DESC");
  });

  it("keeps the quality bar on whichever version it shows", async () => {
    const { repository, query } = repositoryFor([passedRow]);

    await repository.getCharacterCandidate(PROJECT_ID, "side");

    const sql = query.mock.calls[0][0];
    expect(sql).toContain("candidate.qa_status = 'passed'");
    expect(sql).toContain("generation.status = 'qa_passed'");
    expect(sql).toContain("qa.status = 'passed'");
    expect(sql).toContain("candidate.generation_attempt <= run.side_generation_attempts");
  });

  it("returns nothing when no version of the view has passed", async () => {
    const { repository } = repositoryFor([]);

    await expect(repository.getCharacterCandidate(PROJECT_ID, "front")).resolves.toBeNull();
  });
});
