import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  CONTROLLED_ROOT,
  PROJECT_ROOT,
  STAGE_IDS,
  ControlledCanaryError,
  isStrictDescendant,
  registerNormalizedMasterArtifact,
  runControlledCanary
} = require("../../platform/src/canary/controlled-real-modelark-canary");
const { createFixturePng } = require("../../platform/src/development/zero-cost-worker-components");
const {
  assertNoSecretFileConfiguration,
  parseCliArgs
} = require("../../platform/src/runtime/run-controlled-real-modelark-canary");

const createdRoots = [];

async function makeFixture() {
  const root = path.join(CONTROLLED_ROOT, `vitest-${crypto.randomUUID()}`);
  if (!isStrictDescendant(CONTROLLED_ROOT, root)) throw new Error("Unsafe test root");
  createdRoots.push(root);
  const inputDirectory = path.join(root, "inputs");
  await fs.mkdir(inputDirectory, { recursive: true });
  const inputs = await Promise.all([1, 2, 3].map(async (variant) => {
    const filePath = path.join(inputDirectory, `pet-${variant}.jpg`);
    await fs.writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, variant, 0xff, 0xd9]));
    return filePath;
  }));
  return {
    root,
    options: {
      inputPaths: { front1: inputs[0], front2: inputs[1], angle1: inputs[2] },
      petType: "dog",
      outputRoot: path.join(root, "output"),
      priceCard: {
        budgetCny: "30",
        frontImageCny: "0.50",
        sideImageCny: "0.50",
        sleepImageCny: "0.50",
        videoSecondCny: "0.45",
        tokenMillionCny: "46",
        version: "operator-reviewed-2026-08-16",
        sourceReference: "operator supplied ModelArk account price evidence"
      },
      model: {
        registryVersion: "canary-registry-2026-08-16",
        region: "cn-beijing",
        seedreamEndpointId: "ep-seedream-canary",
        seedreamOutputSize: "854x480",
        seedanceEndpointId: "ep-seedance-canary",
        videoResolution: "480p",
        artifactHosts: ["artifact.invalid"]
      }
    }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (createdRoots.length) {
    const root = createdRoots.pop();
    if (!isStrictDescendant(CONTROLLED_ROOT, root)) throw new Error("Refusing unsafe test cleanup");
    await fs.rm(root, { recursive: true, force: true });
  }
});

function imageResult(stage) {
  return {
    providerRequestId: `request-${stage}`,
    outputUrls: [`https://artifact.invalid/${stage}.png?sig=top-secret-${stage}`]
  };
}

function artifactFetcher(url, { stageType }) {
  expect(url).toContain("?sig=top-secret-");
  return Promise.resolve({
    contentType: stageType === "image" ? "image/png" : "video/mp4",
    bytes: Buffer.from(stageType === "image" ? "fake-png" : "fake-mp4")
  });
}

async function persistedPreparedStage(outputRoot, stageId) {
  const [state, audit] = await Promise.all([
    fs.readFile(path.join(outputRoot, "state.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(outputRoot, "audit.json"), "utf8").then(JSON.parse)
  ]);
  expect(state.stages[stageId].status).toBe("submission_prepared");
  expect(state.stages[stageId].submissionOutcome).toBe("unknown");
  expect(state.audit.at(-1)).toMatchObject({ type: "before_provider_post", stageId });
  expect(audit.entries).toEqual(state.audit);
}

function fakeSuccessfulClient(outputRoot, postCalls, getCalls = []) {
  return {
    async createFrontMaster() {
      await persistedPreparedStage(outputRoot, "front");
      postCalls.push("front");
      return imageResult("front");
    },
    async createSideMaster() {
      await persistedPreparedStage(outputRoot, "side");
      postCalls.push("side");
      return imageResult("side");
    },
    async createSleepingMaster() {
      await persistedPreparedStage(outputRoot, "sleep");
      postCalls.push("sleep");
      return imageResult("sleep");
    },
    async createVideoTask({ actionId }) {
      await persistedPreparedStage(outputRoot, actionId);
      postCalls.push(actionId);
      return { providerTaskId: `task-${actionId}` };
    },
    async getVideoTask({ providerTaskId }) {
      getCalls.push(providerTaskId);
      const actionId = providerTaskId.replace(/^task-/, "");
      return {
        status: "succeeded",
        outputUrls: [`https://artifact.invalid/${actionId}.mp4?sig=top-secret-${actionId}`],
        raw: {
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          ignored_sensitive_raw_field: "must-never-be-persisted"
        }
      };
    }
  };
}

describe("controlled real ModelArk canary", () => {
  it("creates only a fail-closed plan with the reviewed CNY calculation and no client", async () => {
    const fixture = await makeFixture();
    const result = await runControlledCanary(fixture.options, {
      modelArkClient: new Proxy({}, {
        get() {
          throw new Error("Plan mode touched the ModelArk client");
        }
      })
    });

    expect(result.mode).toBe("plan");
    expect(result.state.runStatus).toBe("planned");
    expect(result.plan.projectedCostCny).toBe("19.5");
    expect(result.plan.bufferedProjectedCostCny).toBe("23.4");
    expect(result.plan.budgetSafetyThresholdCny).toBe("24");
    expect(result.plan.priceCard).toMatchObject({
      frontImageCny: "0.5",
      sideImageCny: "0.5",
      sleepImageCny: "0.5",
      videoSecondCny: "0.45",
      tokenMillionCny: "46"
    });
    expect(result.plan.stages.map(({ id }) => id)).toEqual(STAGE_IDS);
    expect(await fs.readdir(fixture.options.outputRoot)).toEqual(expect.arrayContaining([
      "artifacts",
      "audit.json",
      "plan.json",
      "state.json"
    ]));

    const missingPrice = structuredClone(fixture.options);
    missingPrice.outputRoot = path.join(fixture.root, "missing-price");
    delete missingPrice.priceCard.videoSecondCny;
    await expect(runControlledCanary(missingPrice)).rejects.toThrow(/videoSecondCny is required/i);
    await expect(fs.stat(path.join(missingPrice.outputRoot, "plan.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects the project root, E drive, wrong budget, and unsafe price headroom", async () => {
    const fixture = await makeFixture();
    await expect(runControlledCanary({ ...fixture.options, outputRoot: PROJECT_ROOT }))
      .rejects.toMatchObject({ code: "unsafe_output_root" });
    await expect(runControlledCanary({ ...fixture.options, outputRoot: "E:\\controlled-real-canary" }))
      .rejects.toMatchObject({ code: "forbidden_drive" });

    const wrongBudget = structuredClone(fixture.options);
    wrongBudget.outputRoot = path.join(fixture.root, "wrong-budget");
    wrongBudget.priceCard.budgetCny = "29";
    await expect(runControlledCanary(wrongBudget)).rejects.toMatchObject({ code: "invalid_budget" });

    const unsafePrice = structuredClone(fixture.options);
    unsafePrice.outputRoot = path.join(fixture.root, "unsafe-price");
    unsafePrice.priceCard.videoSecondCny = "0.50";
    await expect(runControlledCanary(unsafePrice))
      .rejects.toMatchObject({ code: "budget_safety_threshold_exceeded" });
  });

  it("defaults to one stage, honors explicit through gates, and stores only safe provider evidence", async () => {
    const fixture = await makeFixture();
    await runControlledCanary(fixture.options);
    const posts = [];
    const gets = [];
    const client = fakeSuccessfulClient(fixture.options.outputRoot, posts, gets);
    const dependencies = { modelArkClient: client, artifactFetcher, sleep: async () => undefined };

    let result = await runControlledCanary({ ...fixture.options, execute: true }, dependencies);
    expect(posts).toEqual(["front"]);
    expect(result.state.runStatus).toBe("awaiting_approval");

    result = await runControlledCanary({ ...fixture.options, execute: true }, dependencies);
    expect(posts).toEqual(["front", "side"]);
    result = await runControlledCanary({ ...fixture.options, execute: true }, dependencies);
    expect(posts).toEqual(["front", "side", "sleep"]);

    result = await runControlledCanary({ ...fixture.options, execute: true, through: "stretch" }, dependencies);
    expect(posts).toEqual(["front", "side", "sleep", "idle", "sleep-transition", "sleep-loop", "stretch"]);
    expect(result.state.runStatus).toBe("awaiting_approval");

    result = await runControlledCanary({ ...fixture.options, execute: true, through: "hover-attention" }, dependencies);
    expect(posts).toEqual(STAGE_IDS);
    expect(gets).toEqual(STAGE_IDS.slice(3).map((id) => `task-${id}`));
    expect(result.state.runStatus).toBe("completed");
    expect(result.state.committedCostCny).toBe("19.5");
    expect(result.state.observedVideoUsage).toEqual({
      inputTokens: 70,
      outputTokens: 140,
      totalTokens: 210,
      observedTokenCostCny: "0.00966"
    });
    expect(result.state.stages.front.providerRequestId).toBe("request-front");
    expect(result.state.stages.idle.finalUsage).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      observedTokenCostCny: "0.00138"
    });

    const persisted = await fs.readFile(path.join(fixture.options.outputRoot, "state.json"), "utf8");
    expect(persisted).not.toContain("top-secret");
    expect(persisted).not.toContain("ignored_sensitive_raw_field");
    expect(persisted).not.toContain("providerOutputUrl");
    expect((await fs.readdir(path.join(fixture.options.outputRoot, "artifacts"))).length).toBe(10);
  });

  it("stops a crash-window submission in reconciliation and never replays its POST", async () => {
    const fixture = await makeFixture();
    await runControlledCanary(fixture.options);
    const createFrontMaster = vi.fn(() => {
      throw new Error("must not be called after the preparation crash");
    });
    const client = { createFrontMaster };

    await expect(runControlledCanary({ ...fixture.options, execute: true }, {
      modelArkClient: client,
      hooks: {
        afterPreparedBeforePost() {
          throw new Error("simulated process stop after durable preparation");
        }
      }
    })).rejects.toThrow(/simulated process stop/);
    expect(createFrontMaster).not.toHaveBeenCalled();

    let persisted = JSON.parse(await fs.readFile(path.join(fixture.options.outputRoot, "state.json"), "utf8"));
    expect(persisted.stages.front).toMatchObject({
      status: "submission_prepared",
      submissionOutcome: "unknown"
    });
    expect(persisted.committedCostCny).toBe("0.5");

    await expect(runControlledCanary({ ...fixture.options, execute: true }, { modelArkClient: client }))
      .rejects.toMatchObject({ code: "reconciliation_required" });
    expect(createFrontMaster).not.toHaveBeenCalled();
    persisted = JSON.parse(await fs.readFile(path.join(fixture.options.outputRoot, "state.json"), "utf8"));
    expect(persisted.stages.front.status).toBe("reconciliation_required");
  });

  it("resumes a known Seedance task with GET only and does not open the next stage", async () => {
    const fixture = await makeFixture();
    await runControlledCanary(fixture.options);
    const masterPosts = [];
    const masters = fakeSuccessfulClient(fixture.options.outputRoot, masterPosts);
    await runControlledCanary({ ...fixture.options, execute: true, through: "sleep" }, {
      modelArkClient: masters,
      artifactFetcher,
      sleep: async () => undefined
    });

    const createVideoTask = vi.fn(async ({ actionId }) => ({ providerTaskId: `task-${actionId}` }));
    const firstClient = {
      createVideoTask,
      getVideoTask: vi.fn(async () => {
        const error = new Error("temporary GET failure");
        error.code = "temporary_get_failure";
        throw error;
      })
    };
    await expect(runControlledCanary({ ...fixture.options, execute: true }, {
      modelArkClient: firstClient,
      artifactFetcher,
      sleep: async () => undefined
    })).rejects.toMatchObject({ code: "poll_failed_resume_safe" });
    expect(createVideoTask).toHaveBeenCalledTimes(1);

    const resumedCreate = vi.fn(() => {
      throw new Error("resume must not create another paid task");
    });
    const resumedGet = vi.fn(async ({ providerTaskId }) => ({
      status: "succeeded",
      outputUrls: ["https://artifact.invalid/idle.mp4?sig=top-secret-idle"],
      raw: { usage: { completion_tokens: "22", total_tokens: "22" } },
      providerTaskId
    }));
    const result = await runControlledCanary({ ...fixture.options, execute: true }, {
      modelArkClient: { createVideoTask: resumedCreate, getVideoTask: resumedGet },
      artifactFetcher,
      sleep: async () => undefined
    });
    expect(resumedCreate).not.toHaveBeenCalled();
    expect(resumedGet).toHaveBeenCalledWith(expect.objectContaining({ providerTaskId: "task-idle" }));
    expect(result.state.stages.idle.status).toBe("completed");
    expect(result.state.stages["sleep-transition"].status).toBe("planned");
    expect(result.state.runStatus).toBe("awaiting_approval");
  });

  it("submits the complete remaining video cohort concurrently without polling or duplicate POSTs", async () => {
    const fixture = await makeFixture();
    await runControlledCanary(fixture.options);
    await runControlledCanary({ ...fixture.options, execute: true, through: "sleep" }, {
      modelArkClient: fakeSuccessfulClient(fixture.options.outputRoot, []),
      artifactFetcher,
      sleep: async () => undefined
    });

    const started = [];
    let releaseSubmissions;
    let notifyAllStarted;
    const releasePromise = new Promise((resolve) => { releaseSubmissions = resolve; });
    const allStartedPromise = new Promise((resolve) => { notifyAllStarted = resolve; });
    const createVideoTask = vi.fn(async ({ actionId }) => {
      const durableState = JSON.parse(await fs.readFile(
        path.join(fixture.options.outputRoot, "state.json"),
        "utf8"
      ));
      expect(durableState.stages[actionId]).toMatchObject({
        status: "submission_prepared",
        submissionOutcome: "unknown"
      });
      started.push(actionId);
      if (started.length === 7) notifyAllStarted();
      await releasePromise;
      return { providerTaskId: `parallel-task-${actionId}` };
    });
    const getVideoTask = vi.fn(() => {
      throw new Error("cohort submission must not poll");
    });

    const cohortPromise = runControlledCanary({
      ...fixture.options,
      execute: true,
      submitVideoCohort: true
    }, {
      modelArkClient: { createVideoTask, getVideoTask },
      artifactFetcher,
      sleep: async () => undefined
    });
    await allStartedPromise;
    expect([...started].sort()).toEqual([...STAGE_IDS.slice(3)].sort());
    expect(createVideoTask).toHaveBeenCalledTimes(7);
    expect(getVideoTask).not.toHaveBeenCalled();
    const preparedState = JSON.parse(await fs.readFile(
      path.join(fixture.options.outputRoot, "state.json"),
      "utf8"
    ));
    expect(STAGE_IDS.slice(3).map((id) => preparedState.stages[id].status))
      .toEqual(Array(7).fill("submission_prepared"));

    releaseSubmissions();
    const result = await cohortPromise;
    expect(result.state.committedCostCny).toBe("19.5");
    expect(result.state.runStatus).toBe("executing");
    expect(STAGE_IDS.slice(3).map((id) => result.state.stages[id].status))
      .toEqual(Array(7).fill("submitted"));
    expect(new Set(STAGE_IDS.slice(3).map((id) => result.state.stages[id].providerTaskId)).size)
      .toBe(7);
  });

  it("keeps token pricing optional and refuses every ModelArk secret-file convention", () => {
    expect(() => assertNoSecretFileConfiguration({ MODELARK_API_KEY_FILE: "D:\\secret.txt" }))
      .toThrowError(ControlledCanaryError);
    expect(() => assertNoSecretFileConfiguration({ MODELARK_CALLBACK_SECRET_FILE: "D:\\secret.txt" }))
      .toThrow(/never reads key or secret files/i);

    const parsed = parseCliArgs([
      "--front-1", "D:\\one.jpg", "--front-2", "D:\\two.jpg", "--angle-1", "D:\\three.jpg",
      "--pet-type", "dog", "--output-root", `${CONTROLLED_ROOT}\\manual-run`, "--budget-cny", "30",
      "--front-image-cny", "0.50", "--side-image-cny", "0.50", "--sleep-image-cny", "0.50",
      "--video-second-cny", "0.45", "--price-card-version", "reviewed", "--price-source-reference", "evidence",
      "--registry-version", "v1", "--region", "cn-beijing", "--image-endpoint", "image-ep",
      "--image-size", "854x480", "--video-endpoint", "video-ep"
      , "--artifact-host", "artifact.example.com", "--execute", "--submit-video-cohort"
    ]);
    expect(parsed.execute).toBe(true);
    expect(parsed.submitVideoCohort).toBe(true);
    expect(parsed.through).toBeNull();
    expect(parsed.priceCard.tokenMillionCny).toBeNull();
  });

  it("registers a normalized master idempotently and makes side use it", async () => {
    const fixture = await makeFixture();
    await runControlledCanary(fixture.options);
    const frontPosts = [];
    await runControlledCanary({ ...fixture.options, execute: true }, {
      modelArkClient: fakeSuccessfulClient(fixture.options.outputRoot, frontPosts),
      artifactFetcher,
      sleep: async () => undefined
    });
    expect(frontPosts).toEqual(["front"]);

    const normalizedDirectory = path.join(fixture.options.outputRoot, "artifacts", "normalized");
    const normalizedPath = path.join(normalizedDirectory, "front-reviewed.png");
    const normalizedBytes = createFixturePng({ kind: "front", variant: 41 });
    const normalizedHash = crypto.createHash("sha256").update(normalizedBytes).digest("hex");
    await fs.mkdir(normalizedDirectory, { recursive: true });
    await fs.writeFile(normalizedPath, normalizedBytes);

    const registered = await registerNormalizedMasterArtifact({
      outputRoot: fixture.options.outputRoot,
      kind: "front",
      artifactPath: normalizedPath,
      sha256: normalizedHash
    });
    expect(registered).toMatchObject({
      kind: "front",
      idempotent: false,
      artifact: {
        relativePath: "artifacts/normalized/front-reviewed.png",
        contentType: "image/png",
        byteSize: normalizedBytes.length,
        sha256: normalizedHash,
        width: 854,
        height: 480,
        canvasId: "character_canvas_480p_v1"
      }
    });
    const statePath = path.join(fixture.options.outputRoot, "state.json");
    const auditPath = path.join(fixture.options.outputRoot, "audit.json");
    const stateAfterRegistration = await fs.readFile(statePath, "utf8");
    const auditAfterRegistration = await fs.readFile(auditPath, "utf8");
    const parsedState = JSON.parse(stateAfterRegistration);
    expect(parsedState.stages.front.normalizedArtifact).toEqual(registered.artifact);
    expect(parsedState.audit.at(-1)).toMatchObject({
      type: "normalized_master_registered",
      stageId: "front",
      sha256: normalizedHash,
      providerArtifactSha256: parsedState.stages.front.artifact.sha256
    });

    const repeated = await registerNormalizedMasterArtifact({
      outputRoot: fixture.options.outputRoot,
      kind: "front",
      artifactPath: normalizedPath,
      sha256: normalizedHash
    });
    expect(repeated).toMatchObject({ kind: "front", idempotent: true, artifact: registered.artifact });
    expect(await fs.readFile(statePath, "utf8")).toBe(stateAfterRegistration);
    expect(await fs.readFile(auditPath, "utf8")).toBe(auditAfterRegistration);

    const createSideMaster = vi.fn(async ({ frontMaster }) => {
      await persistedPreparedStage(fixture.options.outputRoot, "side");
      expect(frontMaster.objectKey).toContain(normalizedHash.slice(0, 16));
      expect(frontMaster.canvasId).toBe("character_canvas_480p_v1");
      const referencedBytes = Buffer.from(frontMaster.signedReadUrl.split(",")[1], "base64");
      expect(referencedBytes.equals(normalizedBytes)).toBe(true);
      return imageResult("side");
    });
    const sideResult = await runControlledCanary({ ...fixture.options, execute: true }, {
      modelArkClient: { createSideMaster },
      artifactFetcher,
      sleep: async () => undefined
    });
    expect(createSideMaster).toHaveBeenCalledTimes(1);
    expect(sideResult.state.stages.side.status).toBe("completed");
  });

  it("rejects unsafe, wrong-size, wrong-hash, different, and tampered normalized masters", async () => {
    const fixture = await makeFixture();
    await runControlledCanary(fixture.options);
    await runControlledCanary({ ...fixture.options, execute: true }, {
      modelArkClient: fakeSuccessfulClient(fixture.options.outputRoot, []),
      artifactFetcher,
      sleep: async () => undefined
    });
    const normalizedDirectory = path.join(fixture.options.outputRoot, "artifacts", "normalized");
    await fs.mkdir(normalizedDirectory, { recursive: true });
    const validBytes = createFixturePng({ kind: "front", variant: 51 });
    const validHash = crypto.createHash("sha256").update(validBytes).digest("hex");
    const validPath = path.join(normalizedDirectory, "front-reviewed.png");
    await fs.writeFile(validPath, validBytes);

    const outsidePath = path.join(fixture.root, "outside-reviewed.png");
    await fs.writeFile(outsidePath, validBytes);
    await expect(registerNormalizedMasterArtifact({
      outputRoot: fixture.options.outputRoot,
      kind: "front",
      artifactPath: outsidePath,
      sha256: validHash
    })).rejects.toMatchObject({ code: "unsafe_normalized_master_path" });

    await expect(registerNormalizedMasterArtifact({
      outputRoot: fixture.options.outputRoot,
      kind: "front",
      artifactPath: validPath,
      sha256: "0".repeat(64)
    })).rejects.toMatchObject({ code: "normalized_master_hash_mismatch" });

    const wrongSizeBytes = Buffer.from(createFixturePng({ kind: "front", variant: 52 }));
    wrongSizeBytes.writeUInt32BE(853, 16);
    const wrongSizePath = path.join(normalizedDirectory, "wrong-size.png");
    await fs.writeFile(wrongSizePath, wrongSizeBytes);
    await expect(registerNormalizedMasterArtifact({
      outputRoot: fixture.options.outputRoot,
      kind: "front",
      artifactPath: wrongSizePath,
      sha256: crypto.createHash("sha256").update(wrongSizeBytes).digest("hex")
    })).rejects.toMatchObject({ code: "invalid_normalized_master_dimensions" });

    await registerNormalizedMasterArtifact({
      outputRoot: fixture.options.outputRoot,
      kind: "front",
      artifactPath: validPath,
      sha256: validHash
    });
    const differentPath = path.join(normalizedDirectory, "front-other-file.png");
    await fs.writeFile(differentPath, validBytes);
    await expect(registerNormalizedMasterArtifact({
      outputRoot: fixture.options.outputRoot,
      kind: "front",
      artifactPath: differentPath,
      sha256: validHash
    })).rejects.toMatchObject({ code: "normalized_master_conflict" });

    const tamperedBytes = createFixturePng({ kind: "front", variant: 53 });
    const tamperedHash = crypto.createHash("sha256").update(tamperedBytes).digest("hex");
    await fs.writeFile(validPath, tamperedBytes);
    await expect(registerNormalizedMasterArtifact({
      outputRoot: fixture.options.outputRoot,
      kind: "front",
      artifactPath: validPath,
      sha256: tamperedHash
    })).rejects.toMatchObject({ code: "normalized_master_changed" });
  });
});
