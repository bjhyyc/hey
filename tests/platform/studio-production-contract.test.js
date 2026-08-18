import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import actionCatalog from "../../platform/src/domain/action-catalog.js";
import modelRegistryModule from "../../platform/src/config/model-registry.js";
import stateMachine from "../../platform/src/domain/production-state-machine.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";
import serviceModule from "../../platform/src/api/petpack-studio-service.js";
import canvasModule from "../../platform/src/qa/character-canvas-v1.js";
import ffmpegModule from "../../platform/src/media/ffmpeg-plan.js";
import modelArkModule from "../../platform/src/providers/modelark-client.js";
import masterQaModule from "../../platform/src/qa/master-image-quality-gate.js";
import promptFileModule from "../../platform/src/prompts/prompt-file.js";

const { REQUIRED_ACTION_IDS, createVideoJobSnapshot } = actionCatalog;
const { loadModelRegistry } = modelRegistryModule;
const { PRODUCTION_STATES, startProductionRun, transitionProductionRun } = stateMachine;
const { JOB_NAMES, ProductionWorkflow } = workflowModule;
const { ensureSourcePhotoSet } = serviceModule;
const { CHARACTER_CANVAS_V1, LEGACY_CHARACTER_CANVAS_V1 } = canvasModule;
const { createVideoNormalizationPlan } = ffmpegModule;
const { createSeedancePayload, createSeedreamPayload } = modelArkModule;
const { validateMasterImage } = masterQaModule;
const { parsePetPackPromptFile } = promptFileModule;

function photo(index) {
  return {
    contentType: index % 2 ? "image/png" : "image/jpeg",
    sha256: String(index).padStart(64, "0"),
    byteSize: 10_000 + index
  };
}

function master(name) {
  return { objectKey: `private/project/run/${name}.png` };
}

function prompts(resolution = "480p") {
  return REQUIRED_ACTION_IDS.map((actionId, index) => ({
    id: `prompt-${index}`,
    actionId,
    version: "production-480p-v1",
    status: "published",
    resolution,
    disabledAt: null
  }));
}

function validFrame() {
  return {
    width: CHARACTER_CANVAS_V1.width,
    height: CHARACTER_CANVAS_V1.height,
    visibleBounds: { ...CHARACTER_CANVAS_V1.safeFrame },
    groundBaselineY: CHARACTER_CANVAS_V1.groundBaselineY,
    torsoHeightPx: CHARACTER_CANVAS_V1.targetTorsoHeightPx,
    headHeightPx: CHARACTER_CANVAS_V1.targetHeadHeightPx,
    shoulderWidthPx: CHARACTER_CANVAS_V1.targetShoulderWidthPx,
    identityScore: 1
  };
}

function content(kind) {
  return {
    backgroundMode: "pure_green",
    pose: kind,
    singlePet: true,
    fullBodyVisible: true,
    noText: true,
    noProps: true,
    noPeople: true,
    noOtherAnimals: true,
    speciesConsistent: true,
    anatomyValid: true,
    noGreenSpill: true
  };
}

function appearance(referenceCount) {
  return {
    contractVersion: "petpack-studio-appearance-lock/v1",
    sourceReferenceCount: referenceCount,
    fullReferenceCoverage: true,
    identityScore: 1,
    faceIdentityScore: 1,
    coatColorScore: 1,
    markingTopologyScore: 1,
    leftRightMarkingsPreserved: true,
    noMirroredMarkings: true,
    noInventedDistinctiveMarkings: true,
    noMissingDistinctiveMarkings: true
  };
}

describe("recovered Studio production contract", () => {
  it("requires two front photos plus one or two angle photos", () => {
    expect(() => ensureSourcePhotoSet([photo(1), photo(2)])).toThrow(/two front/i);
    expect(ensureSourcePhotoSet([photo(1), photo(2), photo(3)]).map((item) => item.fileName))
      .toEqual(["front-1.png", "front-2.jpg", "angle-1.png"]);
    expect(ensureSourcePhotoSet([photo(1), photo(2), photo(3), photo(4)])).toHaveLength(4);
    expect(() => ensureSourcePhotoSet([photo(1), photo(1), photo(3)])).toThrow(/different/i);
  });

  it("uses an explicit 854x480 active canvas and retains the legacy canvas only for history", () => {
    expect(CHARACTER_CANVAS_V1).toMatchObject({
      id: "character_canvas_480p_v1",
      width: 854,
      height: 480,
      fps: 24
    });
    expect(LEGACY_CHARACTER_CANVAS_V1).toMatchObject({
      id: "character_canvas_v1",
      width: 1280,
      height: 720
    });
    const plan = createVideoNormalizationPlan({
      inputPath: "input.mp4",
      mattePath: "matte.webm",
      outputPath: "output.webm",
      expectedDuration: 4
    });
    expect(plan.mediaProfile).toMatchObject({
      width: 854,
      height: 480,
      fps: 24,
      frameCount: 96,
      matteMode: "alpha"
    });
    expect(plan.args).toContain("yuva420p");
    expect(plan.args).toContain("alpha_mode=1");
    expect(plan.args.join(" ")).not.toContain("color=c=0x00ff00");
  });

  it("defaults new work to 480p and rejects a 720p production registry", () => {
    expect(loadModelRegistry({}).modelArk.video.resolution).toBe("480p");
    expect(() => loadModelRegistry({
      PETPACK_PLATFORM_MODE: "production",
      MODELARK_VIDEO_RESOLUTION: "720p"
    })).toThrow(/must use 480p/i);
  });

  it("binds every video snapshot to three masters and a matching 480p prompt", () => {
    const snapshot = createVideoJobSnapshot({
      actionId: "sleep-transition",
      promptVersion: prompts()[0],
      frontMaster: master("front"),
      sideMaster: master("side"),
      sleepMaster: master("sleep"),
      modelReference: { endpointId: "seedance", resolution: "480p" }
    });
    expect(snapshot.firstFrameObjectKey).toContain("front.png");
    expect(snapshot.lastFrameObjectKey).toContain("sleep.png");
    expect(snapshot.approvedCharacterReferenceObjectKeys).toEqual([
      master("front").objectKey,
      master("side").objectKey
    ]);
    expect(() => createVideoJobSnapshot({
      actionId: "idle",
      promptVersion: { ...prompts()[0], resolution: "720p" },
      frontMaster: master("front"),
      sideMaster: master("side"),
      sleepMaster: master("sleep"),
      modelReference: { endpointId: "seedance", resolution: "480p" }
    })).toThrow(/resolution must match/i);
  });

  it("releases all seven video jobs in one atomic workflow transition", async () => {
    let committed;
    const workflow = new ProductionWorkflow({
      runStore: {
        async commitTransition(payload) {
          committed = payload;
          return payload.run;
        }
      },
      promptStore: { async listPublishedMetadata() { return prompts(); } },
      modelRegistry: {
        version: "registry-480p-v1",
        modelArk: {
          region: "cn",
          image: { endpointId: "seedream", maxRetries: 2 },
          video: { endpointId: "seedance", resolution: "480p", maxRetries: 2 }
        }
      },
      logger: { info() {}, warn() {}, error() {} }
    });
    const run = {
      id: "run-1",
      orderId: "order-1",
      modelRegistryVersion: "registry-480p-v1",
      state: PRODUCTION_STATES.AWAITING_PROMPT_GATE,
      completedActions: []
    };
    const result = await workflow.resumeAwaitingPromptGate({
      run,
      frontMaster: master("front"),
      sideMaster: master("side"),
      sleepMaster: master("sleep")
    });
    expect(result.state).toBe(PRODUCTION_STATES.VIDEO_GENERATING);
    expect(committed.snapshots.map((item) => item.actionId)).toEqual(REQUIRED_ACTION_IDS);
    expect(committed.jobs).toHaveLength(7);
    expect(committed.jobs.every((job) => job.name === JOB_NAMES.GENERATE_VIDEO)).toBe(true);
    expect(new Set(committed.jobs.map((job) => job.options.jobId)).size).toBe(7);
  });

  it("walks front then side, confirms once, and automatically enters sleep generation", () => {
    let run = startProductionRun({
      order: { id: "order-1", status: "paid" },
      projectId: "project-1",
      runId: "run-1",
      modelRegistryVersion: "registry-480p-v1"
    });
    run = transitionProductionRun(run, "photosAccepted");
    expect(run).toMatchObject({ state: PRODUCTION_STATES.AWAKE_GENERATING, frontGenerationAttempts: 1 });
    run = transitionProductionRun(run, "characterMasterGenerated", { view: "front" });
    expect(run).toMatchObject({ state: PRODUCTION_STATES.AWAKE_GENERATING, sideGenerationAttempts: 1 });
    run = transitionProductionRun(run, "characterMasterGenerated", { view: "side" });
    expect(run.state).toBe(PRODUCTION_STATES.AWAITING_CHARACTER_CONFIRMATION);
    run = transitionProductionRun(run, "characterConfirmed");
    expect(run.state).toBe(PRODUCTION_STATES.SLEEP_GENERATING);
  });

  it("sends the exact 480p endpoint-frame payload without audio or watermark", () => {
    const payload = createSeedancePayload({
      modelReference: { endpointId: "seedance", resolution: "480p" },
      prompt: "one stable action",
      negativePrompt: "camera motion",
      actionId: "idle",
      duration: 4,
      firstFrame: {
        canvasId: CHARACTER_CANVAS_V1.id,
        objectKey: "private/front.png",
        signedReadUrl: "data:image/png;base64,AA=="
      },
      lastFrame: {
        canvasId: CHARACTER_CANVAS_V1.id,
        objectKey: "private/front.png",
        signedReadUrl: "data:image/png;base64,AA=="
      },
      allowDataUrls: true
    });
    expect(payload).toMatchObject({
      resolution: "480p",
      ratio: "16:9",
      duration: 4,
      generate_audio: false,
      watermark: false,
      return_last_frame: true
    });
    expect(payload.content).toHaveLength(3);
    expect(payload.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AA==" },
      role: "first_frame"
    });
    expect(payload.content[2]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AA==" },
      role: "last_frame"
    });
  });

  it("uses legacy Seedream single-image non-streaming controls for compatible models", () => {
    const payload = createSeedreamPayload({
      modelReference: { endpointId: "seedream" },
      prompt: "preserve this pet identity",
      sourceImages: [{
        objectKey: "private/source.png",
        signedReadUrl: "data:image/png;base64,AA=="
      }],
      outputSize: "1536x864",
      allowDataUrls: true
    });

    expect(payload).toEqual({
      model: "seedream",
      prompt: "preserve this pet identity",
      image: ["data:image/png;base64,AA=="],
      sequential_image_generation: "disabled",
      stream: false,
      response_format: "url",
      watermark: false,
      size: "1536x864"
    });
  });

  it("omits unsupported legacy stream controls for Seedream 5.0 Pro", () => {
    const payload = createSeedreamPayload({
      modelReference: { endpointId: "doubao-seedream-5-0-pro-260628" },
      prompt: "preserve this pet identity",
      sourceImages: [{
        objectKey: "private/source.png",
        signedReadUrl: "data:image/png;base64,AA=="
      }],
      outputSize: "2816x1584",
      allowDataUrls: true
    });

    expect(payload).toEqual({
      model: "doubao-seedream-5-0-pro-260628",
      prompt: "preserve this pet identity",
      image: ["data:image/png;base64,AA=="],
      response_format: "url",
      watermark: false,
      size: "2816x1584"
    });
  });

  it("rejects durations outside the Seedance 2.0 4-15 second contract", () => {
    const input = {
      modelReference: { endpointId: "seedance", resolution: "480p" },
      prompt: "one stable action",
      actionId: "idle",
      firstFrame: {
        canvasId: CHARACTER_CANVAS_V1.id,
        objectKey: "private/front.png",
        signedReadUrl: "data:image/png;base64,AA=="
      },
      lastFrame: {
        canvasId: CHARACTER_CANVAS_V1.id,
        objectKey: "private/front.png",
        signedReadUrl: "data:image/png;base64,AA=="
      },
      allowDataUrls: true
    };

    expect(() => createSeedancePayload({ ...input, duration: 3 })).toThrow(/4 to 15/);
    expect(() => createSeedancePayload({ ...input, duration: 16 })).toThrow(/4 to 15/);
    expect(() => createSeedancePayload({ ...input, duration: 4.5 })).toThrow(/4 to 15/);
  });

  it("requires all 3-4 photo references for front/side master QA", () => {
    const frontWithTwo = validateMasterImage({
      kind: "front",
      frame: validFrame(),
      contentInspection: content("front"),
      appearanceInspection: appearance(2),
      sourceReferenceCount: 2
    });
    const frontWithThree = validateMasterImage({
      kind: "front",
      frame: validFrame(),
      contentInspection: content("front"),
      appearanceInspection: appearance(3),
      sourceReferenceCount: 3
    });
    expect(frontWithTwo.errors).toContain("front master has an invalid identity reference count");
    expect(frontWithThree.errors).not.toContain("front master has an invalid identity reference count");

    const sideWithThree = validateMasterImage({
      kind: "side",
      frame: validFrame(),
      contentInspection: content("side"),
      appearanceInspection: appearance(3),
      referenceMetrics: validFrame(),
      sourceReferenceCount: 3
    });
    const sideWithFour = validateMasterImage({
      kind: "side",
      frame: validFrame(),
      contentInspection: content("side"),
      appearanceInspection: appearance(4),
      referenceMetrics: validFrame(),
      sourceReferenceCount: 4
    });
    expect(sideWithThree.errors).toContain("side master has an invalid identity reference count");
    expect(sideWithFour.errors).not.toContain("side master has an invalid identity reference count");
  });

  it("parses the production prompt candidate as exactly 3 masters and 7 brand-safe 480p actions", () => {
    const promptPath = path.resolve("docs/prompts/正式发布候选·三母图七动作·480p-v1.txt");
    const text = fs.readFileSync(promptPath, "utf8");
    const parsed = parsePetPackPromptFile(text);

    expect(parsed.images.map((item) => item.kind)).toEqual(["front", "side", "sleep"]);
    expect(parsed.videos.map((item) => item.actionId)).toEqual([
      "idle",
      "sleep-transition",
      "sleep-loop",
      "stretch",
      "sneeze",
      "roll",
      "hover-attention"
    ]);
    expect(parsed.videos.map((item) => item.duration)).toEqual([4, 6, 6, 7, 4, 6, 7]);
    expect(parsed.videos.every((item) => item.resolution === "480p")).toBe(true);
    expect(text).not.toMatch(/皮克斯|迪士尼|Pixar|Disney|保留音效|背景音乐|720p|1280\s*[×x]\s*720/i);
  });
});
