import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createConcurrencyLimitedModelArkClient
} = require("../../platform/src/providers/modelark-concurrency-limiter");

function deferredOperation(counters, label) {
  return vi.fn(() => new Promise((resolve) => {
    counters.active[label] += 1;
    counters.maximum[label] = Math.max(counters.maximum[label], counters.active[label]);
    counters.release.push(() => {
      counters.active[label] -= 1;
      resolve(label);
    });
  }));
}

describe("ModelArk concurrency limiter", () => {
  it("keeps images serial while allowing exactly seven concurrent video calls", async () => {
    const counters = {
      active: { image: 0, video: 0 },
      maximum: { image: 0, video: 0 },
      release: []
    };
    const client = {
      createFrontMaster: deferredOperation(counters, "image"),
      createVideoTask: deferredOperation(counters, "video")
    };
    const limited = createConcurrencyLimitedModelArkClient(client, {
      imageMaxConcurrent: 1,
      videoMaxConcurrent: 7,
      logger: { info: vi.fn() }
    });
    const images = [limited.createFrontMaster(), limited.createFrontMaster()];
    const videos = Array.from({ length: 9 }, () => limited.createVideoTask());
    await vi.waitFor(() => {
      expect(limited.admissionSnapshot()).toMatchObject({
        image: { active: 1, waiting: 1, limit: 1 },
        video: { active: 7, waiting: 2, limit: 7 }
      });
    });
    expect(counters.maximum).toEqual({ image: 1, video: 7 });

    while (counters.release.length > 0) {
      const release = counters.release.shift();
      release();
      await Promise.resolve();
    }
    await Promise.all([...images, ...videos]);
    expect(limited.admissionSnapshot()).toMatchObject({
      image: { active: 0, waiting: 0 },
      video: { active: 0, waiting: 0 }
    });
  });

  it("releases capacity after a provider rejection and preserves client bindings", async () => {
    const client = {
      identity: "fixture",
      calls: 0,
      async createVideoTask() {
        this.calls += 1;
        if (this.calls === 1) throw new Error("provider rejected");
        return this.identity;
      },
      describe() { return this.identity; }
    };
    const limited = createConcurrencyLimitedModelArkClient(client, { videoMaxConcurrent: 1 });
    await expect(limited.createVideoTask()).rejects.toThrow(/provider rejected/);
    await expect(limited.createVideoTask()).resolves.toBe("fixture");
    expect(limited.describe()).toBe("fixture");
    expect(limited.identity).toBe("fixture");
    expect(limited.admissionSnapshot().video).toMatchObject({ active: 0, waiting: 0, limit: 1 });
  });

  it("rejects unbounded limits", () => {
    expect(() => createConcurrencyLimitedModelArkClient({}, { imageMaxConcurrent: 0 })).toThrow(/between 1 and 32/);
    expect(() => createConcurrencyLimitedModelArkClient({}, { videoMaxConcurrent: 33 })).toThrow(/between 1 and 32/);
  });
});
