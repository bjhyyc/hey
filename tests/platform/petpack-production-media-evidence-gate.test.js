import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import actionCatalogModule from "../../platform/src/domain/action-catalog.js";
import appearanceModule from "../../platform/src/qa/appearance-lock-v1.js";
import actionQaModule from "../../platform/src/qa/action-quality-gate.js";
import chromaModule from "../../platform/src/qa/chroma-subject-integrity.js";
import endpointModule from "../../platform/src/qa/frame-continuity-metrics.js";
import masterQaModule from "../../platform/src/qa/master-image-quality-gate.js";
import provenanceModule from "../../platform/src/qa/production-evidence-provenance.js";
import loopBoundaryModule from "../../platform/src/qa/sleep-loop-boundary-v1.js";
import persistenceModule from "../../platform/src/persistence/postgres-petpack-worker-repository.js";
import workerModule from "../../platform/src/workers/petpack-pipeline-worker.js";
import workflowModule from "../../platform/src/workflow/production-workflow.js";

const { ACTION_ENDPOINTS, REQUIRED_ACTION_IDS } = actionCatalogModule;
const { APPEARANCE_LOCK_CONTRACT_VERSION } = appearanceModule;
const { ACTION_QA_CONTRACT_VERSION } = actionQaModule;
const { CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION } = chromaModule;
const {
  DECODED_ENDPOINT_CONTRACT_VERSION,
  TRUSTED_ENDPOINT_DECODER_KIND,
  TRUSTED_ENDPOINT_EVIDENCE_CLASS
} = endpointModule;
const { MASTER_IMAGE_QA_CONTRACT_VERSION } = masterQaModule;
const {
  PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION,
  REQUIRED_MASTER_KINDS
} = provenanceModule;
const { SLEEP_LOOP_BOUNDARY_CONTRACT_VERSION } = loopBoundaryModule;
const {
  PRODUCTION_MEDIA_SNAPSHOT_EVIDENCE_CONTRACT_VERSION,
  PostgresPetpackWorkerRepository,
  createProductionMediaEvidenceRevision
} = persistenceModule;
const {
  PetpackPipelineWorker,
  assertProductionMediaSnapshotEvidence
} = workerModule;
const { JOB_NAMES } = workflowModule;

function sha256(label) {
  return crypto.createHash("sha256").update(label).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function createChromaEvidence(sampledFrameCount = 1) {
  return {
    contractVersion: CHROMA_SUBJECT_INTEGRITY_CONTRACT_VERSION,
    measuredFromDecodedOutput: true,
    fullFrameCoverage: true,
    sampledFrameCount,
    worstFrame: {
      foregroundRatio: 0.2,
      transparentBorderRatio: 1,
      rowSpanHoleRatio: 0,
      largestComponentRatio: 1,
      significantComponentCount: 1,
      componentCount: 1,
      foregroundGreenSpillRatio: 0
    }
  };
}

function createDecodedEndpointEvidence({
  actionId,
  firstMasterSha256,
  lastMasterSha256,
  outputSha256
}) {
  const metrics = {
    maskIoU: 1,
    boundingBoxIoU: 1,
    centroidDeltaPx: 0,
    premultipliedMeanAbsoluteDelta: 0,
    referenceForegroundPixels: 10_000,
    candidateForegroundPixels: 10_000
  };
  return {
    contractVersion: DECODED_ENDPOINT_CONTRACT_VERSION,
    measuredFromDecodedOutput: true,
    trustedDecoder: {
      kind: TRUSTED_ENDPOINT_DECODER_KIND,
      executableSha256: sha256("trusted-ffmpeg")
    },
    actionId,
    outputSha256,
    outputFrameCount: 144,
    endpointFrameIndices: [0, 143],
    firstMasterKind: ACTION_ENDPOINTS[actionId].firstMaster,
    lastMasterKind: ACTION_ENDPOINTS[actionId].lastMaster,
    firstMasterSha256,
    lastMasterSha256,
    firstFrame: { ...metrics },
    lastFrame: { ...metrics },
    terminalFrameMatches: true,
    evidenceClass: TRUSTED_ENDPOINT_EVIDENCE_CLASS
  };
}

function createFrameEvidence() {
  return {
    width: 720,
    height: 720,
    visibleBounds: { left: 180, top: 80, right: 540, bottom: 680 },
    groundBaselineY: 680,
    torsoHeightPx: 300,
    headHeightPx: 160,
    shoulderWidthPx: 240,
    identityScore: 0.99
  };
}

function createProvenance({ inputSha256, outputSha256, processorVersion }) {
  return {
    contractVersion: PRODUCTION_EVIDENCE_PROVENANCE_CONTRACT_VERSION,
    evidenceClass: "production",
    inputSha256,
    outputSha256,
    processorVersion,
    calibrationDigest: sha256(`${inputSha256}|${outputSha256}|${processorVersion}|calibration`)
  };
}

function createActionQa(actionId, {
  inputSha256,
  outputSha256,
  processorVersion,
  firstMasterSha256,
  lastMasterSha256
}) {
  const decoded = createDecodedEndpointEvidence({
    actionId,
    firstMasterSha256,
    lastMasterSha256,
    outputSha256
  });
  const chroma = createChromaEvidence(1);
  const frame = createFrameEvidence();
  const contentInspection = {
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
    noGreenSpill: true,
    ...(actionId === "sleep-loop" ? { loopSeamAcceptable: true } : {})
  };
  const provenance = createProvenance({ inputSha256, outputSha256, processorVersion });
  return {
    actionId,
    contractVersion: ACTION_QA_CONTRACT_VERSION,
    ok: true,
    errors: [],
    media: { ok: true, errors: [] },
    canvas: { ok: true, errors: [] },
    endpoints: { ok: true, errors: [] },
    decodedEndpoints: { ok: true, errors: [], evidence: decoded },
    chromaIntegrity: { ok: true, errors: [], evidence: chroma },
    content: { ok: true, errors: [] },
    continuity: { ok: true, errors: [] },
    appearance: { ok: true, errors: [] },
    loopBoundary: actionId === "sleep-loop" ? { ok: true, errors: [] } : { ok: true, errors: [] },
    frameResults: [{ ok: true, errors: [] }],
    provenance,
    evidence: {
      contentInspection,
      chromaIntegrity: chroma,
      provenance,
      appearance: {
        contractVersion: APPEARANCE_LOCK_CONTRACT_VERSION,
        referenceBinding: "approved-action-masters",
        fullFrameCoverage: true,
        sampledFrameCount: 1
      },
      endpoints: {
        firstMasterHash: firstMasterSha256,
        lastMasterHash: lastMasterSha256,
        decoded
      },
      continuity: {
        sampledFrameCount: 1,
        firstFrame: frame,
        lastFrame: frame
      },
      ...(actionId === "sleep-loop" ? {
        loopBoundary: {
          contractVersion: SLEEP_LOOP_BOUNDARY_CONTRACT_VERSION,
          startsAtEndExhaleRest: true,
          endsAtEndExhaleRest: true,
          completeBreathCycle: true,
          nextInhaleStarted: false,
          completedBreathCycles: 1,
          sampledFrameCount: 1
        }
      } : {})
    }
  };
}

function createProductionMediaEvidenceFixture() {
  const masterEvidence = Object.fromEntries(REQUIRED_MASTER_KINDS.map((kind) => {
    const inputSha256 = sha256(`${kind}|provider-input`);
    const outputSha256 = sha256(`${kind}|normalized-output`);
    const processorVersion = `master-${kind}-processor/v1`;
    return [kind, {
      kind,
      masterGenerationId: `master-generation-${kind}`,
      imageCandidateId: `candidate-${kind}`,
      sourceMediaAssetId: `master-source-${kind}`,
      mediaAssetId: `master-output-${kind}`,
      qaReportId: `master-qa-${kind}`,
      inputSha256,
      outputSha256,
      processingPolicyVersion: "master-policy/v1",
      processorVersion,
      modelRegistryVersion: "model-registry/v1",
      qa: {
        kind,
        contractVersion: MASTER_IMAGE_QA_CONTRACT_VERSION,
        ok: true,
        errors: [],
        provenance: createProvenance({ inputSha256, outputSha256, processorVersion }),
        chromaIntegrity: createChromaEvidence(1)
      }
    }];
  }));
  const masterOutputHashes = Object.fromEntries(
    Object.entries(masterEvidence).map(([kind, record]) => [kind, record.outputSha256])
  );
  const actions = REQUIRED_ACTION_IDS.map((actionId) => {
    const sourceSha256 = sha256(`${actionId}|provider-input`);
    const outputSha256 = sha256(`${actionId}|normalized-output`);
    const processorVersion = `action-${actionId}-processor/v1`;
    const expectedEndpoints = ACTION_ENDPOINTS[actionId];
    return {
      actionId,
      generationActionId: `generation-${actionId}`,
      sourceMediaAssetId: `action-source-${actionId}`,
      mediaAssetId: `action-output-${actionId}`,
      qaReportId: `action-qa-${actionId}`,
      promptVersionId: `prompt-${actionId}`,
      promptVersionLabel: "prompt/v1",
      objectKey: `private/projects/project-1/runs/run-1/action-video/${actionId}.webm`,
      sourceSha256,
      sha256: outputSha256,
      byteSize: 1234,
      contentType: "video/webm",
      processingPolicyVersion: "action-policy/v1",
      processorVersion,
      qa: createActionQa(actionId, {
        inputSha256: sourceSha256,
        outputSha256,
        processorVersion,
        firstMasterSha256: masterOutputHashes[expectedEndpoints.firstMaster],
        lastMasterSha256: masterOutputHashes[expectedEndpoints.lastMaster]
      })
    };
  });
  return { masterEvidence, actions };
}

function queueJob(id = "media-gate-job") {
  return {
    id,
    name: JOB_NAMES.PROCESS_MEDIA,
    data: { runId: "run-1" },
    opts: { jobId: id, attempts: 3 }
  };
}

function createBareWorker(repository, { productionMode }) {
  const worker = Object.create(PetpackPipelineWorker.prototype);
  Object.assign(worker, {
    repository,
    productionMode,
    workerId: "petpack-worker-test",
    leaseSeconds: 180,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  });
  return worker;
}

describe("production PetPack media evidence aggregate gate", () => {
  it("accepts exactly three current masters and seven current actions bound to DB hashes and processors", () => {
    const fixture = createProductionMediaEvidenceFixture();

    const result = assertProductionMediaSnapshotEvidence(fixture);

    expect(result.contractVersion).toBe(PRODUCTION_MEDIA_SNAPSHOT_EVIDENCE_CONTRACT_VERSION);
    expect(Object.keys(result.masterEvidence)).toEqual(REQUIRED_MASTER_KINDS);
    expect(result.actions.map((action) => action.actionId)).toEqual(REQUIRED_ACTION_IDS);
    expect(createProductionMediaEvidenceRevision(result)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([undefined, "controlled", "development", "unknown"])(
    "rejects evidenceClass %s fail-closed",
    (evidenceClass) => {
      const fixture = createProductionMediaEvidenceFixture();
      if (evidenceClass === undefined) delete fixture.masterEvidence.front.qa.provenance.evidenceClass;
      else fixture.masterEvidence.front.qa.provenance.evidenceClass = evidenceClass;

      expect(() => assertProductionMediaSnapshotEvidence(fixture)).toThrow(expect.objectContaining({
        code: "production_evidence_provenance_invalid"
      }));
    }
  );

  it("rejects a missing master or action report", () => {
    const missingMaster = createProductionMediaEvidenceFixture();
    delete missingMaster.masterEvidence.sleep;
    expect(() => assertProductionMediaSnapshotEvidence(missingMaster)).toThrow(expect.objectContaining({
      code: "production_evidence_provenance_invalid"
    }));

    const missingAction = createProductionMediaEvidenceFixture();
    missingAction.actions.pop();
    expect(() => assertProductionMediaSnapshotEvidence(missingAction)).toThrow(expect.objectContaining({
      code: "production_evidence_provenance_invalid"
    }));
  });

  it.each([
    ["action input", (fixture) => { fixture.actions[0].sourceSha256 = sha256("changed-action-input"); }],
    ["action output", (fixture) => { fixture.actions[0].sha256 = sha256("changed-action-output"); }],
    ["action processor", (fixture) => { fixture.actions[0].processorVersion = "changed-action-processor/v1"; }],
    ["master input", (fixture) => { fixture.masterEvidence.front.inputSha256 = sha256("changed-master-input"); }],
    ["master output", (fixture) => { fixture.masterEvidence.front.outputSha256 = sha256("changed-master-output"); }],
    ["master processor", (fixture) => { fixture.masterEvidence.front.processorVersion = "changed-master-processor/v1"; }]
  ])("rejects a provenance mismatch against the current %s binding", (_label, mutate) => {
    const fixture = createProductionMediaEvidenceFixture();
    mutate(fixture);

    expect(() => assertProductionMediaSnapshotEvidence(fixture)).toThrow(expect.objectContaining({
      code: "production_evidence_provenance_invalid"
    }));
  });

  it.each([
    ["failed gate", (report) => { report.decodedEndpoints.ok = false; }],
    ["wrong contract", (report) => { report.evidence.endpoints.decoded.contractVersion = "wrong/v1"; }],
    ["not decoded", (report) => { report.evidence.endpoints.decoded.measuredFromDecodedOutput = false; }],
    ["missing trusted decoder", (report) => { delete report.evidence.endpoints.decoded.trustedDecoder; }],
    ["wrong action binding", (report) => { report.evidence.endpoints.decoded.actionId = "sleep-loop"; }],
    ["wrong output binding", (report) => { report.evidence.endpoints.decoded.outputSha256 = sha256("wrong-output"); }],
    ["wrong first-master binding", (report) => {
      report.evidence.endpoints.decoded.firstMasterSha256 = sha256("wrong-first-master");
    }],
    ["wrong terminal frame index", (report) => { report.evidence.endpoints.decoded.endpointFrameIndices[1] = 142; }],
    ["unconfirmed terminal frame", (report) => { report.evidence.endpoints.decoded.terminalFrameMatches = false; }],
    ["failing metrics", (report) => { report.evidence.endpoints.decoded.firstFrame.maskIoU = 0; }],
    ["split gate evidence", (report) => {
      report.decodedEndpoints.evidence = clone(report.decodedEndpoints.evidence);
      report.decodedEndpoints.evidence.lastFrame.maskIoU = 0.99;
    }]
  ])("rejects action decoded-endpoint evidence with %s", (_label, mutate) => {
    const fixture = createProductionMediaEvidenceFixture();
    mutate(fixture.actions[0].qa);

    expect(() => assertProductionMediaSnapshotEvidence(fixture)).toThrow(expect.objectContaining({
      code: "production_evidence_provenance_invalid"
    }));
  });

  it.each([
    ["failed gate", (report) => { report.chromaIntegrity.ok = false; }],
    ["wrong contract", (report) => { report.evidence.chromaIntegrity.contractVersion = "wrong/v1"; }],
    ["not decoded", (report) => { report.evidence.chromaIntegrity.measuredFromDecodedOutput = false; }],
    ["partial coverage", (report) => { report.evidence.chromaIntegrity.fullFrameCoverage = false; }],
    ["wrong sample count", (report) => { report.evidence.chromaIntegrity.sampledFrameCount = 2; }],
    ["failing worst frame", (report) => { report.evidence.chromaIntegrity.worstFrame.foregroundRatio = 0; }],
    ["split gate evidence", (report) => {
      report.chromaIntegrity.evidence = clone(report.chromaIntegrity.evidence);
      report.chromaIntegrity.evidence.sampledFrameCount = 2;
    }]
  ])("rejects action chroma evidence with %s", (_label, mutate) => {
    const fixture = createProductionMediaEvidenceFixture();
    mutate(fixture.actions[0].qa);

    expect(() => assertProductionMediaSnapshotEvidence(fixture)).toThrow(expect.objectContaining({
      code: "production_evidence_provenance_invalid"
    }));
  });

  it("rejects invalid master chroma evidence", () => {
    const fixture = createProductionMediaEvidenceFixture();
    fixture.masterEvidence.side.qa.chromaIntegrity.fullFrameCoverage = false;

    expect(() => assertProductionMediaSnapshotEvidence(fixture)).toThrow(expect.objectContaining({
      code: "production_evidence_provenance_invalid"
    }));
  });
});

describe("PetpackPipelineWorker production media-gate wiring", () => {
  it("passes the validated production evidence to commit before snapshot/build outbox creation", async () => {
    const fixture = createProductionMediaEvidenceFixture();
    const repository = {
      claimMediaSnapshot: vi.fn(async () => ({
        outcome: "claimed",
        leaseToken: "lease-1",
        runId: "run-1",
        projectId: "project-1",
        orderId: "order-1",
        projectName: "Evidence Pet",
        ...fixture
      })),
      completeMediaSnapshot: vi.fn(async () => ({})),
      releaseRunJobForRetry: vi.fn(async () => ({}))
    };
    const worker = createBareWorker(repository, { productionMode: true });

    await expect(worker._processMediaGate(queueJob())).resolves.toEqual({
      status: "snapshot_ready",
      runId: "run-1"
    });

    expect(repository.claimMediaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      requireProductionEvidence: true
    }));
    expect(repository.completeMediaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      productionEvidence: expect.objectContaining({
        contractVersion: PRODUCTION_MEDIA_SNAPSHOT_EVIDENCE_CONTRACT_VERSION
      })
    }));
    expect(repository.releaseRunJobForRetry).not.toHaveBeenCalled();
  });

  it("settles a production claim as a deterministic failure without freezing a snapshot when provenance is non-production", async () => {
    const fixture = createProductionMediaEvidenceFixture();
    fixture.actions[0].qa.provenance.evidenceClass = "controlled";
    const repository = {
      claimMediaSnapshot: vi.fn(async () => ({
        outcome: "claimed",
        leaseToken: "lease-1",
        runId: "run-1",
        projectId: "project-1",
        orderId: "order-1",
        projectName: "Evidence Pet",
        ...fixture
      })),
      completeMediaSnapshot: vi.fn(async () => ({})),
      failMediaSnapshotEvidence: vi.fn(async () => ({ status: "evidence_rejected" })),
      releaseRunJobForRetry: vi.fn(async () => ({}))
    };
    const worker = createBareWorker(repository, { productionMode: true });

    await expect(worker._processMediaGate(queueJob())).resolves.toEqual({
      status: "evidence_rejected",
      runId: "run-1",
      errorCode: "production_evidence_provenance_invalid"
    });
    expect(repository.completeMediaSnapshot).not.toHaveBeenCalled();
    expect(repository.failMediaSnapshotEvidence).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "production_evidence_provenance_invalid"
    }));
    expect(repository.releaseRunJobForRetry).not.toHaveBeenCalled();
  });

  it("keeps development compatible with legacy QA that has no production-only evidence", async () => {
    const fixture = createProductionMediaEvidenceFixture();
    for (const action of fixture.actions) {
      delete action.qa.provenance;
      delete action.qa.decodedEndpoints;
      delete action.qa.chromaIntegrity;
      delete action.qa.evidence.provenance;
      delete action.qa.evidence.endpoints.decoded;
      delete action.qa.evidence.chromaIntegrity;
    }
    const repository = {
      claimMediaSnapshot: vi.fn(async () => ({
        outcome: "claimed",
        leaseToken: "lease-1",
        runId: "run-1",
        projectId: "project-1",
        orderId: "order-1",
        projectName: "Development Pet",
        actions: fixture.actions
      })),
      completeMediaSnapshot: vi.fn(async () => ({})),
      releaseRunJobForRetry: vi.fn(async () => ({}))
    };
    const worker = createBareWorker(repository, { productionMode: false });

    await expect(worker._processMediaGate(queueJob("development-media-gate"))).resolves.toEqual({
      status: "snapshot_ready",
      runId: "run-1"
    });
    expect(repository.claimMediaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      requireProductionEvidence: false
    }));
    expect(repository.completeMediaSnapshot).toHaveBeenCalledWith(expect.not.objectContaining({
      productionEvidence: expect.anything()
    }));
  });
});

describe("PostgreSQL current production media evidence binding", () => {
  it("atomically settles deterministic production evidence rejection instead of retrying it", async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes("SELECT execution.run_id")) {
        return { rows: [{
          run_id: "run-1",
          project_id: "project-1",
          order_id: "order-1",
          run_state: "media_processing",
          run_version: 7
        }] };
      }
      if (sql.includes("UPDATE production_job_execution")) {
        return { rows: [{ id: "execution-1" }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const database = {
      transaction: vi.fn(async (callback) => callback({ query }))
    };
    const repository = new PostgresPetpackWorkerRepository({
      database,
      logger: { warn: vi.fn() }
    });
    repository._failRun = vi.fn(async () => undefined);

    await expect(repository.failMediaSnapshotEvidence({
      jobId: "media-gate-job",
      leaseToken: "00000000-0000-4000-8000-000000000001",
      errorCode: "production_evidence_provenance_invalid"
    })).resolves.toEqual({
      status: "evidence_rejected",
      runId: "run-1",
      errorCode: "production_evidence_provenance_invalid"
    });
    expect(repository._failRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ run_id: "run-1", run_version: 7 }),
      "production_evidence_provenance_invalid"
    );
    expect(query.mock.calls[0][0]).toContain("execution.job_name = $3");
    expect(query.mock.calls[1][0]).toContain("SET status = 'dead'");
  });

  it("loads selected revision masters through generation, QA, source, and normalized asset bindings", async () => {
    const fixture = createProductionMediaEvidenceFixture();
    const rows = REQUIRED_MASTER_KINDS.map((kind) => {
      const record = fixture.masterEvidence[kind];
      return {
        kind,
        master_generation_id: record.masterGenerationId,
        image_candidate_id: record.imageCandidateId,
        source_media_asset_id: record.sourceMediaAssetId,
        media_asset_id: record.mediaAssetId,
        qa_report_id: record.qaReportId,
        input_sha256: record.inputSha256,
        output_sha256: record.outputSha256,
        processing_policy_version: record.processingPolicyVersion,
        processor_version: record.processorVersion,
        model_registry_version: record.modelRegistryVersion,
        qa_report: record.qa
      };
    });
    const query = vi.fn(async () => ({ rows }));
    const repository = new PostgresPetpackWorkerRepository({
      database: { transaction: vi.fn() }
    });

    await expect(repository._loadCurrentMasterEvidence({ query }, "run-1", { lock: true }))
      .resolves.toMatchObject({
        front: { inputSha256: fixture.masterEvidence.front.inputSha256 },
        side: { outputSha256: fixture.masterEvidence.side.outputSha256 },
        sleep: { processorVersion: fixture.masterEvidence.sleep.processorVersion }
      });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("JOIN character_revision revision");
    expect(sql).toContain("revision.front_candidate_id");
    expect(sql).toContain("revision.side_candidate_id");
    expect(sql).toContain("revision.sleep_candidate_id");
    expect(sql).toContain("generation.normalized_media_asset_id = candidate.media_asset_id");
    expect(sql).toContain("qa.source_media_asset_id = source.id");
    expect(sql).toContain("qa.processor_version = generation.processor_version");
    expect(sql).toContain("FOR UPDATE OF revision, candidate, generation, source, asset, qa");
    expect(params).toEqual(["run-1"]);
  });

  it("changes the commit-time evidence revision for any source, output, processor, or QA mutation", () => {
    const fixture = createProductionMediaEvidenceFixture();
    const evidence = {
      contractVersion: PRODUCTION_MEDIA_SNAPSHOT_EVIDENCE_CONTRACT_VERSION,
      ...fixture
    };
    const original = createProductionMediaEvidenceRevision(evidence);

    const mutations = [
      (value) => { value.masterEvidence.front.inputSha256 = sha256("master-source-changed"); },
      (value) => { value.masterEvidence.side.outputSha256 = sha256("master-output-changed"); },
      (value) => { value.masterEvidence.sleep.processorVersion = "master-processor-changed/v1"; },
      (value) => { value.actions[0].sourceSha256 = sha256("action-source-changed"); },
      (value) => { value.actions[1].sha256 = sha256("action-output-changed"); },
      (value) => { value.actions[2].processorVersion = "action-processor-changed/v1"; },
      (value) => { value.actions[3].qa.media.auditMarker = "changed-after-claim"; }
    ];
    for (const mutate of mutations) {
      const changed = clone(evidence);
      mutate(changed);
      expect(createProductionMediaEvidenceRevision(changed)).not.toBe(original);
    }
  });
});
