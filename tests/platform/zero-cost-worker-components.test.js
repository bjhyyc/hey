import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  ACTION_DURATIONS,
  FIXTURE_MASTER_PROCESSOR_VERSION,
  FIXTURE_VALIDATOR_VERSION,
  boundedDevelopmentDelay,
  createDevelopmentDeliveryValidator,
  createFixturePng,
  createFixtureWebm,
  createWorkerComponents,
  decodeVideoTask,
  encodeVideoTask,
  masterAppearance,
  sleepLoopBoundary,
  validFrame,
  videoAppearance
} = require("../../platform/src/development/zero-cost-worker-components");
const { validateMasterImage } = require("../../platform/src/qa/master-image-quality-gate");
const { validateVideoAppearanceInspection } = require("../../platform/src/qa/appearance-lock-v1");
const { createDevelopmentQaPolicy } = require("../../platform/src/qa/character-canvas-v1");
const { validateSleepLoopBoundaryInspection } = require("../../platform/src/qa/sleep-loop-boundary-v1");

describe("zero-cost worker components", () => {
  it("bounds the development-only poll hold", () => {
    expect(boundedDevelopmentDelay(undefined, "hold")).toBe(0);
    expect(boundedDevelopmentDelay("20000", "hold")).toBe(20_000);
    expect(() => boundedDevelopmentDelay("30001", "hold")).toThrow(/between 0 and 30000/);
  });

  it("produces deterministic 854x480 PNG and WebM-signature fixtures", () => {
    const first = createFixturePng({ kind: "front", variant: 1 });
    const second = createFixturePng({ kind: "front", variant: 1 });
    expect(first.equals(second)).toBe(true);
    expect([...first.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(first.readUInt32BE(16)).toBe(854);
    expect(first.readUInt32BE(20)).toBe(480);

    const webm = createFixtureWebm({ actionId: "idle", duration: ACTION_DURATIONS.idle });
    expect([...webm.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(() => createFixtureWebm({ actionId: "idle", duration: 6 })).toThrow(/duration/i);
  });

  it("encodes restart-safe provider task IDs without process memory", () => {
    const encoded = encodeVideoTask({ runId: "run-fixture", actionId: "sleep-loop", duration: 6 });
    expect(decodeVideoTask(encoded)).toEqual({ runId: "run-fixture", actionId: "sleep-loop", duration: 6 });
    expect(() => decodeVideoTask("real-provider-task")).toThrow(/invalid/i);
  });

  it("supplies complete passing master, appearance, and loop evidence", () => {
    const policy = createDevelopmentQaPolicy();
    const frame = validFrame();
    const master = validateMasterImage({
      kind: "front",
      frame,
      contentInspection: {
        exactlyOnePet: true,
        fullBodyVisible: true,
        noText: true,
        noWatermark: true,
        noProps: true,
        noPersons: true,
        noOtherAnimals: true,
        plainRemovableBackground: true,
        backgroundMode: "pure_green",
        pose: "front"
      },
      appearanceInspection: masterAppearance("front", 3),
      sourceReferenceCount: 3,
      policy
    });
    expect(master.ok).toBe(true);

    const frames = 144;
    expect(validateVideoAppearanceInspection(videoAppearance(frames), {
      sampledFrameCount: frames,
      policy
    }).ok).toBe(true);
    expect(validateSleepLoopBoundaryInspection(sleepLoopBoundary(frames), {
      sampledFrameCount: frames,
      policy
    }).ok).toBe(true);
  });

  it("uses loopback-only provider artifacts and rejects production mode", async () => {
    await expect(createWorkerComponents({
      environment: { PETPACK_PLATFORM_MODE: "production" }
    })).rejects.toThrow(/forbidden in production/i);

    const components = await createWorkerComponents({
      environment: { PETPACK_PLATFORM_MODE: "development" },
      logger: { warn() {} }
    });
    try {
      expect(components.masterImageProcessor.version).toBe(FIXTURE_MASTER_PROCESSOR_VERSION);
      expect(components.deliveryValidator.describe()).toMatchObject({
        validatorVersion: FIXTURE_VALIDATOR_VERSION,
        productionAssured: false
      });
      const front = await components.modelArkClient.createFrontMaster();
      expect(new URL(front.outputUrls[0]).hostname).toBe("127.0.0.1");
      const imageResponse = await fetch(front.outputUrls[0]);
      expect(imageResponse.status).toBe(200);
      expect(imageResponse.headers.get("content-type")).toBe("image/png");

      const created = await components.modelArkClient.createVideoTask({
        runId: "run-fixture",
        actionId: "stretch",
        duration: ACTION_DURATIONS.stretch
      });
      const polled = await components.modelArkClient.getVideoTask(created);
      expect(polled.status).toBe("succeeded");
      expect(new URL(polled.outputUrls[0]).hostname).toBe("127.0.0.1");
      const videoResponse = await fetch(polled.outputUrls[0]);
      expect(videoResponse.status).toBe(200);
      expect(videoResponse.headers.get("content-type")).toBe("video/webm");
    } finally {
      await components.close();
    }
  });
});
