import { describe, expect, it, vi } from "vitest";

import queueModule from "../../platform/src/queue/bullmq-workflow-queue.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";

const {
  BullMqWorkflowQueue,
  normalizeBullMqJob,
  safeBullJobId
} = queueModule;
const { createWorkflowJob, JOB_NAMES } = workflowModule;

const config = Object.freeze({
  queueName: "dedupe-contract",
  prefix: "petpack-dedupe-contract",
  host: "localhost",
  port: 6379,
  username: "default",
  password: "fixture-password",
  database: 0,
  ca: "fixture-ca",
  concurrency: 1
});

function workflowJob() {
  return createWorkflowJob({
    name: JOB_NAMES.FINALIZE_FRONT,
    run: {
      id: "00000000-0000-4000-8000-000000000101",
      orderId: "00000000-0000-4000-8000-000000000102"
    },
    inputRevision: "front-finalizer-contract",
    attempts: 3
  });
}

describe("BullMQ source dedupe identity", () => {
  it("persists the original workflow ID and restores it for workers", async () => {
    let captured;
    class FakeQueue {
      constructor() {}
      async add(name, data, options) {
        captured = { name, data, options };
        return { id: options.jobId };
      }
      async close() {}
    }
    const queue = new BullMqWorkflowQueue({
      config,
      QueueClass: FakeQueue,
      logger: { info: vi.fn() }
    });
    const source = workflowJob();

    await queue.enqueue(source);

    expect(captured.options.jobId).toBe(safeBullJobId(source.dedupeKey));
    expect(captured.options.sourceDedupeKey).toBe(source.dedupeKey);
    const normalized = normalizeBullMqJob({
      id: captured.options.jobId,
      name: captured.name,
      data: captured.data,
      opts: captured.options
    });
    expect(normalized.id).toBe(source.dedupeKey);
    expect(normalized.dedupeKey).toBe(source.dedupeKey);
    expect(normalized.options.jobId).toBe(source.dedupeKey);
    expect(normalized.options).not.toHaveProperty("sourceDedupeKey");
  });

  it("rejects a source identity that does not map to the BullMQ job ID", () => {
    expect(() => normalizeBullMqJob({
      id: safeBullJobId("petpack:actual"),
      name: JOB_NAMES.FINALIZE_FRONT,
      data: { runId: "00000000-0000-4000-8000-000000000101" },
      opts: {
        jobId: safeBullJobId("petpack:actual"),
        sourceDedupeKey: "petpack:substituted"
      }
    })).toThrow(/source dedupe key does not match/i);
  });
});
