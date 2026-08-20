const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");

const { REQUIRED_ACTION_IDS } = require("../domain/action-catalog");
const { verifyPetpackArchive } = require("../petpack/build");
const { CHARACTER_CANVAS_V1 } = require("../qa/character-canvas-v1");

const MASTER_PROCESSOR_CONTRACT_VERSION = "character-canvas-v1-master-processor/v1";
const FIXTURE_MASTER_PROCESSOR_VERSION = "zero-cost-master-processor/v1";
const FIXTURE_VALIDATOR_VERSION = "zero-cost-delivery-validator/v1";
const FIXTURE_POLICY_VERSION = "zero-cost-rehearsal-policy/v1";
const FIXTURE_PROVIDER_ID_PREFIX = "zero-cost";

function boundedDevelopmentDelay(value, label) {
  const parsed = value === undefined || value === "" ? 0 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 30_000) {
    throw new Error(`${label} must be between 0 and 30000 milliseconds`);
  }
  return parsed;
}

function wait(milliseconds) {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

const ACTION_DURATIONS = Object.freeze({
  idle: 4,
  sneeze: 4,
  roll: 6,
  "sleep-transition": 6,
  "sleep-loop": 6,
  stretch: 7,
  "hover-attention": 7
});

const CONTENT_CHECKS = Object.freeze({
  cameraFixed: true,
  noText: true,
  noProps: true,
  noPeople: true,
  noOtherAnimals: true,
  petFullyVisible: true,
  speciesConsistent: true,
  primaryCoatColorConsistent: true,
  noSevereIdentityDrift: true,
  noDeformation: true,
  matteComplete: true,
  matteEdgesStable: true,
  greenBackgroundUniform: true,
  noGreenSpill: true
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function fixturePixel(kind, x, y, variant) {
  const centerX = CHARACTER_CANVAS_V1.width / 2;
  const centerY = kind === "sleep" ? 330 : 270;
  const normalizedX = (x - centerX) / (kind === "sleep" ? 230 : 120);
  const normalizedY = (y - centerY) / (kind === "sleep" ? 75 : 145);
  const body = normalizedX * normalizedX + normalizedY * normalizedY <= 1;
  const headX = kind === "side" ? centerX + 35 : centerX;
  const headY = kind === "sleep" ? 285 : 145;
  const headRadiusX = kind === "sleep" ? 82 : 86;
  const headRadiusY = kind === "sleep" ? 58 : 78;
  const head = ((x - headX) / headRadiusX) ** 2 + ((y - headY) / headRadiusY) ** 2 <= 1;
  if (!body && !head) return [0, 255, 0, 255];
  const colors = [
    [232, 197, 139, 255],
    [220, 178, 112, 255],
    [244, 216, 166, 255],
    [205, 157, 91, 255]
  ];
  return colors[Math.abs(Number(variant) || 0) % colors.length];
}

function createFixturePng({ kind = "front", variant = 0 } = {}) {
  if (!["front", "side", "sleep", "source"].includes(kind)) throw new Error("Fixture PNG kind is invalid");
  const pose = kind === "source" ? "front" : kind;
  const width = CHARACTER_CANVAS_V1.width;
  const height = CHARACTER_CANVAS_V1.height;
  const rowBytes = width * 4 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = fixturePixel(pose, x, y, variant);
      const offset = rowStart + 1 + x * 4;
      raw[offset] = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
      raw[offset + 3] = pixel[3];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function createFixtureWebm({ actionId, duration } = {}) {
  if (!REQUIRED_ACTION_IDS.includes(actionId)) throw new Error("Fixture WebM action is invalid");
  const safeDuration = Number(duration);
  if (ACTION_DURATIONS[actionId] !== safeDuration) throw new Error("Fixture WebM duration is inconsistent");
  const marker = Buffer.from(JSON.stringify({ fixture: true, actionId, duration: safeDuration }), "utf8");
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), marker]);
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

function masterAppearance(kind, sourceReferenceCount) {
  const binding = {
    front: "source-photos",
    side: "source-photos-and-approved-front-master",
    sleep: "approved-character-masters"
  }[kind];
  const regions = {};
  for (const region of ["head", "torso", "legs", "tail"]) {
    regions[region] = {
      visible: true,
      ...(region === "head" ? { faceIdentityScore: 1 } : {}),
      coatColorScore: 1,
      markingTopologyScore: 1,
      leftRightPlacementPreserved: true
    };
  }
  return {
    contractVersion: "petpack-appearance-lock/v1",
    referenceBinding: binding,
    sourceReferenceCount,
    fullReferenceCoverage: true,
    occlusionAware: true,
    leftRightAware: true,
    asymmetryPreserved: true,
    speciesAndBreedConsistent: true,
    unresolvedConflictCount: 0,
    faceIdentityScore: 1,
    coatColorScore: 1,
    markingTopologyScore: 1,
    regions
  };
}

function videoAppearance(sampledFrameCount) {
  const regions = {};
  for (const region of ["head", "torso", "legs", "tail"]) {
    regions[region] = {
      visibleFrameCount: sampledFrameCount,
      evaluatedFrameCount: sampledFrameCount,
      ...(region === "head" ? { faceIdentityMinScore: 1, faceIdentityBelowSevereFrameRatio: 0 } : {}),
      coatColorMinScore: 1,
      markingTopologyMinScore: 1,
      leftRightPlacementPreserved: true
    };
  }
  return {
    contractVersion: "petpack-appearance-lock/v1",
    referenceBinding: "approved-action-masters",
    fullFrameCoverage: true,
    occlusionAware: true,
    leftRightAware: true,
    asymmetryPreserved: true,
    speciesConsistent: true,
    primaryCoatColorConsistent: true,
    severeIdentityDriftDetected: false,
    sampledFrameCount,
    faceIdentityMinScore: 1,
    faceIdentityBelowSevereFrameRatio: 0,
    coatColorMinScore: 1,
    markingTopologyMinScore: 1,
    regions
  };
}

function sleepLoopBoundary(sampledFrameCount) {
  return {
    contractVersion: "petpack-sleep-loop-boundary/v1",
    startsAtEndExhaleRest: true,
    endsAtEndExhaleRest: true,
    completeBreathCycle: true,
    nextInhaleStarted: false,
    completedBreathCycles: 1,
    sampledFrameCount,
    firstRestFrameCount: 12,
    lastRestFrameCount: 12,
    seamPixelDelta: 0,
    seamMotionDelta: 0,
    terminalMotion: 0
  };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function encodeVideoTask({ runId, actionId, duration }) {
  return `${FIXTURE_PROVIDER_ID_PREFIX}.${Buffer.from(JSON.stringify({ runId, actionId, duration }), "utf8").toString("base64url")}`;
}

function decodeVideoTask(providerTaskId) {
  const raw = String(providerTaskId || "");
  if (!raw.startsWith(`${FIXTURE_PROVIDER_ID_PREFIX}.`)) throw new Error("Fixture video task ID is invalid");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw.slice(FIXTURE_PROVIDER_ID_PREFIX.length + 1), "base64url").toString("utf8"));
  } catch {
    throw new Error("Fixture video task ID is invalid");
  }
  if (!parsed || !REQUIRED_ACTION_IDS.includes(parsed.actionId) || ACTION_DURATIONS[parsed.actionId] !== Number(parsed.duration)) {
    throw new Error("Fixture video task ID is inconsistent");
  }
  return parsed;
}

function createFixtureProbe({ localPath, buffer, actionId } = {}) {
  if (!REQUIRED_ACTION_IDS.includes(actionId)) throw new Error("Fixture probe action is invalid");
  const duration = ACTION_DURATIONS[actionId];
  const read = Buffer.isBuffer(buffer) ? Promise.resolve(buffer) : fsp.readFile(localPath);
  return read.then((bytes) => ({
    checksumSha256: sha256(bytes),
    probe: {
      streams: [{
        codec_type: "video",
        codec_name: "vp9",
        width: CHARACTER_CANVAS_V1.width,
        height: CHARACTER_CANVAS_V1.height,
        avg_frame_rate: `${CHARACTER_CANVAS_V1.fps}/1`,
        r_frame_rate: `${CHARACTER_CANVAS_V1.fps}/1`,
        duration: String(duration),
        nb_frames: String(duration * CHARACTER_CANVAS_V1.fps)
      }],
      format: { format_name: "matroska,webm", duration: String(duration) }
    }
  }));
}

function createAuditRecorder(environment) {
  const auditPath = typeof environment.PETPACK_REHEARSAL_AUDIT_FILE === "string" && environment.PETPACK_REHEARSAL_AUDIT_FILE.trim()
    ? path.resolve(environment.PETPACK_REHEARSAL_AUDIT_FILE.trim())
    : null;
  let chain = Promise.resolve();
  return {
    record(event, details = {}) {
      if (!auditPath) return Promise.resolve();
      const entry = `${JSON.stringify({ at: new Date().toISOString(), event, external: false, ...details })}\n`;
      chain = chain.then(() => fsp.appendFile(auditPath, entry, { encoding: "utf8" }));
      return chain;
    },
    async close() { await chain; }
  };
}

async function createFixtureArtifactServer({ recorder, logger = console } = {}) {
  const server = http.createServer((request, response) => {
    try {
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      const url = new URL(request.url, "http://127.0.0.1");
      const masterMatch = /^\/masters\/(front|side|sleep)\.png$/.exec(url.pathname);
      if (masterMatch) {
        const kind = masterMatch[1];
        const bytes = createFixturePng({ kind, variant: { front: 0, side: 1, sleep: 2 }[kind] });
        recorder.record("fixture.artifact_read", { kind });
        response.writeHead(200, { "content-type": "image/png", "content-length": bytes.length });
        response.end(bytes);
        return;
      }
      const videoMatch = /^\/videos\/([A-Za-z0-9_-]+)\.webm$/.exec(url.pathname);
      if (videoMatch) {
        const task = decodeVideoTask(Buffer.from(videoMatch[1], "base64url").toString("utf8"));
        const bytes = createFixtureWebm(task);
        recorder.record("fixture.artifact_read", { actionId: task.actionId });
        response.writeHead(200, { "content-type": "video/webm", "content-length": bytes.length });
        response.end(bytes);
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      logger.warn?.("petpack.rehearsal.artifact_failed", { errorName: error?.name || "Error" });
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Fixture artifact server did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function createDevelopmentMasterProcessor() {
  return {
    version: FIXTURE_MASTER_PROCESSOR_VERSION,
    contractVersion: MASTER_PROCESSOR_CONTRACT_VERSION,
    async normalizeAndInspect({ kind, inputPath, outputPath, referencePaths }) {
      await fsp.copyFile(inputPath, outputPath);
      const sourceReferenceCount = referencePaths.length;
      return {
        frame: validFrame(),
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
          pose: kind
        },
        appearanceInspection: masterAppearance(kind, sourceReferenceCount)
      };
    }
  };
}

function createDevelopmentMattingService() {
  return {
    async createMatteAndMetrics({ matteOutputPath }) {
      await fsp.writeFile(matteOutputPath, Buffer.from("zero-cost-matte", "utf8"), { flag: "wx" });
      return { mattePath: matteOutputPath, correction: { scale: 1, offsetX: 0, offsetY: 0 } };
    },
    async inspectProcessedAction({ actionId, expectedFirstMasterHash, expectedLastMasterHash }) {
      const duration = ACTION_DURATIONS[actionId];
      const sampledFrameCount = duration * CHARACTER_CANVAS_V1.fps;
      const frame = validFrame();
      return {
        sampledFrames: Array.from({ length: sampledFrameCount }, () => ({ ...frame, visibleBounds: { ...frame.visibleBounds } })),
        firstFrame: { masterHash: expectedFirstMasterHash },
        lastFrame: { masterHash: expectedLastMasterHash },
        contentInspection: {
          ...CONTENT_CHECKS,
          ...(actionId === "sleep-loop" ? { loopSeamAcceptable: true } : {})
        },
        appearanceInspection: videoAppearance(sampledFrameCount),
        ...(actionId === "sleep-loop" ? { loopBoundaryInspection: sleepLoopBoundary(sampledFrameCount) } : {})
      };
    }
  };
}

function createDevelopmentDeliveryValidator() {
  return {
    describe() {
      return {
        policyVersion: FIXTURE_POLICY_VERSION,
        validatorVersion: FIXTURE_VALIDATOR_VERSION,
        validatorIdentity: "loopback-zero-cost-rehearsal",
        productionAssured: false
      };
    },
    async validate({ bytes, expectedPackageId, expectedPackageSha256, actions }) {
      const archive = await verifyPetpackArchive(bytes);
      if (archive.manifest.packageId !== expectedPackageId) throw new Error("Fixture PetPack package ID mismatch");
      if (sha256(bytes) !== expectedPackageSha256) throw new Error("Fixture PetPack checksum mismatch");
      if (!Array.isArray(actions) || actions.length !== REQUIRED_ACTION_IDS.length) throw new Error("Fixture PetPack action set mismatch");
      return {
        ok: true,
        policyVersion: FIXTURE_POLICY_VERSION,
        validatorVersion: FIXTURE_VALIDATOR_VERSION,
        validatorIdentity: "loopback-zero-cost-rehearsal",
        packageSha256: expectedPackageSha256,
        packageByteSize: bytes.length,
        archive: { ok: true, fileCount: archive.fileNames.length, packageId: expectedPackageId },
        media: { ok: true, actions: actions.map(({ actionId, sha256: digest }) => ({ actionId, sha256: digest })) },
        originalImport: { ok: true, verifier: "fixture-contract" },
        interactions: { ok: true, verifier: "fixture-contract" },
        errors: []
      };
    }
  };
}

async function createWorkerComponents({ environment = process.env, logger = console } = {}) {
  if (environment.PETPACK_PLATFORM_MODE === "production") {
    throw new Error("Zero-cost worker components are forbidden in production");
  }
  const recorder = createAuditRecorder(environment);
  const artifactServer = await createFixtureArtifactServer({ recorder, logger });
  const videoPollHoldMs = boundedDevelopmentDelay(
    environment.PETPACK_REHEARSAL_VIDEO_POLL_HOLD_MS,
    "Zero-cost video poll hold"
  );
  const modelArkClient = {
    async createFrontMaster({ requestId } = {}) {
      await recorder.record("fixture.seedream", { kind: "front", requestId });
      return { outputUrls: [`${artifactServer.origin}/masters/front.png`] };
    },
    async createSideMaster({ requestId } = {}) {
      await recorder.record("fixture.seedream", { kind: "side", requestId });
      return { outputUrls: [`${artifactServer.origin}/masters/side.png`] };
    },
    async createSleepingMaster({ requestId } = {}) {
      await recorder.record("fixture.seedream", { kind: "sleep", requestId });
      return { outputUrls: [`${artifactServer.origin}/masters/sleep.png`] };
    },
    async createVideoTask({ runId, actionId, duration }) {
      const providerTaskId = encodeVideoTask({ runId, actionId, duration: Number(duration) });
      await recorder.record("fixture.seedance_create", { runId, actionId, duration: Number(duration) });
      return { providerTaskId };
    },
    async getVideoTask({ providerTaskId }) {
      const task = decodeVideoTask(providerTaskId);
      const encodedTask = Buffer.from(providerTaskId, "utf8").toString("base64url");
      await recorder.record("fixture.seedance_poll", { runId: task.runId, actionId: task.actionId });
      await wait(videoPollHoldMs);
      return {
        providerTaskId,
        status: "succeeded",
        outputUrls: [`${artifactServer.origin}/videos/${encodedTask}.webm`]
      };
    }
  };
  return {
    modelArkClient,
    masterImageProcessor: createDevelopmentMasterProcessor(),
    mattingService: createDevelopmentMattingService(),
    deliveryValidator: createDevelopmentDeliveryValidator(),
    probeAsset: createFixtureProbe,
    async runMediaPlan(plan) {
      const inputIndex = plan.args.indexOf("-i");
      if (inputIndex < 0 || !plan.args[inputIndex + 1] || !plan.args.at(-1)) throw new Error("Fixture media plan is invalid");
      await fsp.copyFile(plan.args[inputIndex + 1], plan.args.at(-1));
    },
    async close() {
      await artifactServer.close();
      await recorder.close();
    }
  };
}

module.exports = {
  ACTION_DURATIONS,
  FIXTURE_MASTER_PROCESSOR_VERSION,
  FIXTURE_POLICY_VERSION,
  FIXTURE_VALIDATOR_VERSION,
  boundedDevelopmentDelay,
  createDevelopmentDeliveryValidator,
  createDevelopmentMasterProcessor,
  createDevelopmentMattingService,
  createFixturePng,
  createFixtureProbe,
  createFixtureWebm,
  createWorkerComponents,
  decodeVideoTask,
  encodeVideoTask,
  masterAppearance,
  sleepLoopBoundary,
  validFrame,
  videoAppearance
};
