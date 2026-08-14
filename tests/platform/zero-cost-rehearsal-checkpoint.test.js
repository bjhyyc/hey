import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { waitForVideoSubmissions } = require("../../platform/src/development/run-zero-cost-rehearsal");

describe("zero-cost worker restart checkpoint", () => {
  it("waits until all seven provider task IDs are durably bound", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total_actions: 7, bound_provider_tasks: 5, reconciliation_required: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total_actions: 7, bound_provider_tasks: 7, reconciliation_required: 0 }] });

    await expect(waitForVideoSubmissions({
      database: { query },
      runId: "10000000-0000-4000-8000-000000000001",
      timeoutMs: 2_000
    })).resolves.toMatchObject({ total_actions: 7, bound_provider_tasks: 7 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of restarting across an unknown provider submission", async () => {
    const query = vi.fn(async () => ({
      rows: [{ total_actions: 7, bound_provider_tasks: 6, reconciliation_required: 1 }]
    }));

    await expect(waitForVideoSubmissions({
      database: { query },
      runId: "10000000-0000-4000-8000-000000000001",
      timeoutMs: 2_000
    })).rejects.toThrow(/reconciliation/i);
  });
});
