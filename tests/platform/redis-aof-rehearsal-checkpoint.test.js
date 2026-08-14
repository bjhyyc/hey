import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { REQUIRED_ACTION_IDS } = require("../../platform/src/domain/action-catalog");
const { safeBullJobId } = require("../../platform/src/queue/bullmq-workflow-queue");
const { JOB_NAMES } = require("../../platform/src/workflow/production-workflow");
const {
  REDIS_AOF_DELAY_MS,
  assertRedisAofControlRoot,
  assertRedisAofQueueSnapshot,
  collectFinalRedisAofQueueContract,
  collectQueueSnapshot,
  loadRedisAofCheckpointConfig,
  prepareRedisAofVideoJobs,
  waitForPendingRedisAofVideoOutboxRows,
  waitForRedisAofQueueCheckpoint,
  waitForResume
} = require("../../platform/src/development/redis-aof-rehearsal-checkpoint");

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const runId = "10000000-0000-4000-8000-000000000001";

function uniqueControlRoot(label) {
  const control = path.join(
    repositoryRoot,
    ".tmp",
    "redis-aof-rehearsals",
    `unit-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "control"
  );
  fs.mkdirSync(control, { recursive: true });
  return control;
}

function videoRows() {
  return REQUIRED_ACTION_IDS.map((actionId, index) => {
    const dedupeKey = `petpack:aof-video-${index}`;
    return {
      id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      job_name: JOB_NAMES.GENERATE_VIDEO,
      status: "pending",
      attempts: 0,
      dedupe_key: dedupeKey,
      payload: {
        name: JOB_NAMES.GENERATE_VIDEO,
        data: { runId, actionId },
        options: { jobId: dedupeKey, attempts: 3 }
      }
    };
  });
}

function checkpointJobs(rows = videoRows()) {
  const delayedDedupeKey = rows[0].dedupe_key;
  const byState = {
    wait: [], delayed: [], active: [], failed: [], prioritized: [],
    "waiting-children": [], repeat: [], completed: []
  };
  rows.forEach((row, index) => {
    const payload = row.payload;
    const state = index === 0 ? "delayed" : "wait";
    byState[state].push({
      id: safeBullJobId(row.dedupe_key),
      name: payload.name,
      data: payload.data,
      opts: {
        jobId: safeBullJobId(row.dedupe_key),
        sourceDedupeKey: row.dedupe_key,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: false,
        removeOnFail: false,
        delay: index === 0 ? REDIS_AOF_DELAY_MS : 0
      },
      timestamp: 1_700_000_000_000 + index,
      attemptsMade: 0
    });
  });
  return { byState, delayedDedupeKey };
}

function fakeQueue(byState) {
  return {
    assertReady: vi.fn(async () => ({ ok: true })),
    queue: {
      isPaused: vi.fn(async () => false),
      getJobs: vi.fn(async ([state]) => byState[state] || [])
    },
    close: vi.fn(async () => {})
  };
}

describe("Redis AOF rehearsal checkpoint", () => {
  it("accepts only a real control directory below the dedicated project temp base", () => {
    const control = uniqueControlRoot("path");
    expect(assertRedisAofControlRoot(control)).toBe(fs.realpathSync.native(control));
    expect(() => assertRedisAofControlRoot(repositoryRoot)).toThrow(/approved project temp base|descendant/i);
    expect(loadRedisAofCheckpointConfig({
      NODE_ENV: "development",
      PETPACK_PLATFORM_MODE: "development",
      PETPACK_REHEARSAL_REDIS_AOF_CONTROL_ROOT: control
    })).toMatchObject({ controlRoot: fs.realpathSync.native(control), delayMs: REDIS_AOF_DELAY_MS });
    expect(() => loadRedisAofCheckpointConfig({
      NODE_ENV: "production",
      PETPACK_REHEARSAL_REDIS_AOF_CONTROL_ROOT: control
    })).toThrow(/forbidden in production/i);
  });

  it("locks all seven pristine video rows and injects delay into exactly one deterministic row", async () => {
    const rows = videoRows();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{
        id: rows[0].id,
        dedupe_key: rows[0].dedupe_key,
        action_id: REQUIRED_ACTION_IDS[0],
        delay_ms: REDIS_AOF_DELAY_MS
      }] });
    const database = { transaction: vi.fn(async (callback) => callback({ query })) };

    await expect(prepareRedisAofVideoJobs({ database, runId })).resolves.toEqual({
      runId,
      outboxId: rows[0].id,
      delayedDedupeKey: rows[0].dedupe_key,
      delayedActionId: REQUIRED_ACTION_IDS[0],
      delayMs: REDIS_AOF_DELAY_MS
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([runId, rows[0].id, REDIS_AOF_DELAY_MS]);
  });

  it("fails closed before an update when any video outbox row was already attempted", async () => {
    const rows = videoRows();
    rows[3] = { ...rows[3], attempts: 1 };
    const query = vi.fn(async () => ({ rows }));
    const database = { transaction: vi.fn(async (callback) => callback({ query })) };

    await expect(prepareRedisAofVideoJobs({ database, runId })).rejects.toThrow(/unsafe video outbox row/i);
    expect(query).toHaveBeenCalledOnce();
  });

  it("waits until all seven video outbox rows exist and every row is still pristine", async () => {
    const rows = videoRows();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: rows.slice(0, 3) })
      .mockResolvedValueOnce({ rows });

    await expect(waitForPendingRedisAofVideoOutboxRows({
      database: { query },
      runId,
      timeoutMs: 100,
      intervalMs: 1
    })).resolves.toEqual({
      runId,
      rowCount: 7,
      actionIds: [...REQUIRED_ACTION_IDS].sort()
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects attempted video work instead of accepting a partial AOF checkpoint", async () => {
    const rows = videoRows();
    rows[2] = { ...rows[2], attempts: 1 };

    await expect(waitForPendingRedisAofVideoOutboxRows({
      database: { query: vi.fn(async () => ({ rows })) },
      runId,
      timeoutMs: 100,
      intervalMs: 1
    })).rejects.toThrow(/unsafe pending video outbox progress/i);
  });

  it("requires exact persisted identities for six waiting and one delayed workflow job", async () => {
    const rows = videoRows();
    const { byState, delayedDedupeKey } = checkpointJobs(rows);
    const queue = fakeQueue(byState);
    const prepared = {
      runId,
      delayedDedupeKey,
      delayedActionId: REQUIRED_ACTION_IDS[0],
      delayMs: REDIS_AOF_DELAY_MS
    };
    const snapshot = await collectQueueSnapshot(queue);

    expect(assertRedisAofQueueSnapshot(snapshot, prepared)).toBe(snapshot);
    expect(snapshot.counts).toMatchObject({
      waiting: 6, delayed: 1, active: 0, failed: 0, prioritized: 0,
      "waiting-children": 0, repeat: 0
    });
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    const originalAttempts = byState.wait[0].opts.attempts;
    byState.wait[0].opts.attempts = originalAttempts + 1;
    await expect(collectQueueSnapshot(queue)).resolves.not.toMatchObject({ sha256: snapshot.sha256 });
    byState.wait[0].opts.attempts = originalAttempts;
    queue.queue.isPaused.mockResolvedValueOnce(true);
    await expect(collectQueueSnapshot(queue)).rejects.toThrow(/queue is paused/i);
    byState.delayed[0] = { ...byState.delayed[0], id: "wrong-id" };
    await expect(collectQueueSnapshot(queue)).rejects.toThrow(/identity changed/i);
  });

  it("waits for seven sent outbox rows before accepting the queue checkpoint", async () => {
    const rows = videoRows();
    const { byState, delayedDedupeKey } = checkpointJobs(rows);
    const queue = fakeQueue(byState);
    const database = {
      query: vi.fn(async () => ({
        rows: rows.map((row) => ({ ...row, status: "sent", attempts: 1 }))
      }))
    };
    const prepared = {
      runId,
      delayedDedupeKey,
      delayedActionId: REQUIRED_ACTION_IDS[0],
      delayMs: REDIS_AOF_DELAY_MS
    };

    await expect(waitForRedisAofQueueCheckpoint({
      database,
      environment: {},
      prepared,
      queueFactory: () => queue,
      timeoutMs: 100,
      intervalMs: 1
    })).resolves.toMatchObject({ counts: { waiting: 6, delayed: 1 } });
    expect(queue.close).toHaveBeenCalledOnce();
  });

  it("accepts only nonce-bound same-container resume evidence", async () => {
    const controlRoot = uniqueControlRoot("resume");
    const nonce = "a".repeat(48);
    const config = {
      resumePath: path.join(controlRoot, "resume.json")
    };
    fs.writeFileSync(config.resumePath, `${JSON.stringify({
      schemaVersion: "petpack-redis-aof-resume/v1",
      nonce,
      containerId: "b".repeat(64),
      sameContainerRestarted: true
    })}\n`, { encoding: "utf8", flag: "wx" });

    await expect(waitForResume(config, nonce, { timeoutMs: 50, intervalMs: 1 })).resolves.toMatchObject({
      containerId: "b".repeat(64),
      sameContainerRestarted: true
    });
    await expect(waitForResume(config, "wrong", { timeoutMs: 50, intervalMs: 1 })).rejects.toThrow(/invalid/i);
  });

  it("requires all 39 durable outbox jobs to be completed and no nonterminal BullMQ state", async () => {
    const outboxRows = Array.from({ length: 39 }, (_, index) => ({
      dedupe_key: `petpack:final-${index}`,
      status: "sent"
    }));
    const byState = {
      wait: [], delayed: [], active: [], failed: [], prioritized: [], "waiting-children": [], repeat: [],
      completed: outboxRows.map((row, index) => ({
      id: safeBullJobId(row.dedupe_key),
      name: JOB_NAMES.AWAIT_PHOTOS,
      data: { runId },
      opts: {
        jobId: safeBullJobId(row.dedupe_key),
        sourceDedupeKey: row.dedupe_key,
        attempts: 1,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: false,
        removeOnFail: false,
        delay: 0
      },
      timestamp: 1_700_100_000_000 + index,
      attemptsMade: 0
    })) };
    const queue = fakeQueue(byState);
    const database = { query: vi.fn(async () => ({ rows: outboxRows })) };

    await expect(collectFinalRedisAofQueueContract({
      database,
      environment: {},
      runId,
      queueFactory: () => queue
    })).resolves.toMatchObject({
      counts: {
        waiting: 0, delayed: 0, active: 0, failed: 0, prioritized: 0,
        "waiting-children": 0, repeat: 0, completed: 39
      },
      outboxJobCount: 39
    });
    byState.prioritized.push({
      ...byState.completed[0],
      id: "unexpected-prioritized",
      opts: {
        ...byState.completed[0].opts,
        jobId: "unexpected-prioritized",
        sourceDedupeKey: "unexpected-prioritized"
      }
    });
    await expect(collectFinalRedisAofQueueContract({
      database,
      environment: {},
      runId,
      queueFactory: () => queue
    })).rejects.toThrow(/fully and exactly drained/i);
  });
});
