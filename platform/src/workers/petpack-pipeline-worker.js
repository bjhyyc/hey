const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const { ACTION_ENDPOINTS, REQUIRED_ACTION_IDS } = require("../domain/action-catalog");
const { buildPetpack } = require("../petpack/build");
const {
  PETPACK_BUILDER_VERSION,
  PETPACK_BUILD_POLICY_VERSION,
  createDeterministicUuid,
  createPackageId,
  createPackageInputRevision,
  createPetpackFileName,
  requiredString
} = require("../petpack/package-contract");
const { PetpackValidationError, isProductionAssuredValidator } = require("../petpack/delivery-validator");
const { isPostgresInfrastructureError } = require("../persistence/postgres-database");
const { ACTION_QA_CONTRACT_VERSION } = require("../qa/action-quality-gate");
const { validateChromaSubjectInspection } = require("../qa/chroma-subject-integrity");
const { validateDecodedEndpointInspection } = require("../qa/frame-continuity-metrics");
const { MASTER_IMAGE_QA_CONTRACT_VERSION } = require("../qa/master-image-quality-gate");
const {
  REQUIRED_MASTER_KINDS,
  ProductionEvidenceProvenanceError,
  assertProductionEvidenceProvenance
} = require("../qa/production-evidence-provenance");
const { OBJECT_CLASSES, createProjectObjectKey } = require("../storage/private-object-store");
const { JOB_NAMES, createWorkflowJob } = require("../workflow/production-workflow");

const PRODUCTION_MEDIA_SNAPSHOT_EVIDENCE_CONTRACT_VERSION =
  "petpack-production-media-snapshot-evidence/v1";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function appendDecisionErrors(errors, path, decision) {
  if (!decision || decision.ok === true) return;
  for (const error of decision.errors || ["failed"]) errors.push(`${path}: ${error}`);
}

function assertPassingQaReport(report, { path, contractVersion }, errors) {
  if (!isRecord(report) || report.ok !== true || !Array.isArray(report.errors) || report.errors.length !== 0) {
    errors.push(`${path} must be a passing QA report with no errors`);
  }
  if (report?.contractVersion !== contractVersion) {
    errors.push(`${path}.contractVersion must be ${contractVersion}`);
  }
}

function assertRelationalProvenanceBinding({
  provenance,
  record,
  inputField = "sourceSha256",
  outputField,
  path
}, errors) {
  if (provenance.inputSha256 !== record?.[inputField]) {
    errors.push(`${path}.provenance.inputSha256 is not bound to the current source asset`);
  }
  if (provenance.outputSha256 !== record?.[outputField]) {
    errors.push(`${path}.provenance.outputSha256 is not bound to the current output asset`);
  }
  if (provenance.processorVersion !== record?.processorVersion) {
    errors.push(`${path}.provenance.processorVersion is not bound to the persisted processor`);
  }
}

/**
 * Production-only aggregate gate for the exact media evidence that will be
 * frozen into a PetPack input snapshot. The provenance contract establishes
 * evidence class and hashes; the relational comparisons bind those hashes to
 * the currently selected database assets and processor rows.
 */
function assertProductionMediaSnapshotEvidence({ masterEvidence, actions } = {}) {
  const masters = isRecord(masterEvidence) ? masterEvidence : {};
  const actionList = Array.isArray(actions) ? actions : [];
  const actionRecords = new Map();
  const collectionErrors = [];
  for (const action of actionList) {
    const actionId = action?.actionId;
    if (typeof actionId !== "string") continue;
    if (actionRecords.has(actionId)) collectionErrors.push(`actions.${actionId} is duplicated`);
    else actionRecords.set(actionId, action);
  }

  const masterReports = Object.fromEntries(
    Object.entries(masters).map(([kind, record]) => [kind, record?.qa])
  );
  const actionReports = Object.fromEntries(
    [...actionRecords].map(([actionId, record]) => [actionId, record?.qa])
  );
  // This call is deliberately the first semantic gate: missing, controlled,
  // development, and unknown provenance must all use the shared fail-closed
  // production evidence contract.
  const provenance = assertProductionEvidenceProvenance({ masterReports, actionReports });
  const errors = [...collectionErrors];

  for (const kind of REQUIRED_MASTER_KINDS) {
    const record = masters[kind];
    const report = record?.qa;
    const path = `masterReports.${kind}`;
    assertPassingQaReport(report, {
      path,
      contractVersion: MASTER_IMAGE_QA_CONTRACT_VERSION
    }, errors);
    const chroma = validateChromaSubjectInspection(report?.chromaIntegrity, {
      production: true,
      expectedFrameCount: 1
    });
    appendDecisionErrors(errors, `${path}.chromaIntegrity`, chroma);
    assertRelationalProvenanceBinding({
      provenance: provenance.masterReports[kind],
      record,
      inputField: "inputSha256",
      outputField: "outputSha256",
      path
    }, errors);
  }

  for (const actionId of REQUIRED_ACTION_IDS) {
    const record = actionRecords.get(actionId);
    const report = record?.qa;
    const path = `actionReports.${actionId}`;
    assertPassingQaReport(report, {
      path,
      contractVersion: ACTION_QA_CONTRACT_VERSION
    }, errors);

    if (report?.decodedEndpoints?.ok !== true) {
      errors.push(`${path}.decodedEndpoints must be passing`);
    }
    const decodedEvidence = report?.evidence?.endpoints?.decoded;
    const expectedEndpoints = ACTION_ENDPOINTS[actionId];
    const expectedFirstMasterHash = masters[expectedEndpoints.firstMaster]?.outputSha256;
    const expectedLastMasterHash = masters[expectedEndpoints.lastMaster]?.outputSha256;
    if (report?.evidence?.endpoints?.firstMasterHash !== expectedFirstMasterHash) {
      errors.push(`${path}.evidence.endpoints.firstMasterHash is not bound to the selected master`);
    }
    if (report?.evidence?.endpoints?.lastMasterHash !== expectedLastMasterHash) {
      errors.push(`${path}.evidence.endpoints.lastMasterHash is not bound to the selected master`);
    }
    const decoded = validateDecodedEndpointInspection(decodedEvidence, {
      production: true,
      actionId,
      expectedFirstMasterHash,
      expectedLastMasterHash,
      expectedOutputHash: record?.sha256
    });
    appendDecisionErrors(errors, `${path}.evidence.endpoints.decoded`, decoded);
    if (!isDeepStrictEqual(report?.decodedEndpoints?.evidence, decodedEvidence)) {
      errors.push(`${path}.decodedEndpoints evidence does not match immutable endpoint evidence`);
    }

    const sampledFrameCount = Number(report?.evidence?.continuity?.sampledFrameCount);
    if (!Number.isSafeInteger(sampledFrameCount) || sampledFrameCount < 1 ||
        !Array.isArray(report?.frameResults) || report.frameResults.length !== sampledFrameCount) {
      errors.push(`${path} has no exact sampled frame count for chroma evidence`);
    }
    if (report?.chromaIntegrity?.ok !== true) {
      errors.push(`${path}.chromaIntegrity must be passing`);
    }
    const chromaEvidence = report?.evidence?.chromaIntegrity;
    const chroma = validateChromaSubjectInspection(chromaEvidence, {
      production: true,
      expectedFrameCount: sampledFrameCount
    });
    appendDecisionErrors(errors, `${path}.evidence.chromaIntegrity`, chroma);
    if (!isDeepStrictEqual(report?.chromaIntegrity?.evidence, chromaEvidence)) {
      errors.push(`${path}.chromaIntegrity evidence does not match immutable chroma evidence`);
    }

    assertRelationalProvenanceBinding({
      provenance: provenance.actionReports[actionId],
      record,
      outputField: "sha256",
      path
    }, errors);
  }

  if (errors.length > 0) throw new ProductionEvidenceProvenanceError(errors);
  return Object.freeze({
    contractVersion: PRODUCTION_MEDIA_SNAPSHOT_EVIDENCE_CONTRACT_VERSION,
    masterEvidence: Object.freeze(Object.fromEntries(
      REQUIRED_MASTER_KINDS.map((kind) => [kind, masters[kind]])
    )),
    actions: Object.freeze(REQUIRED_ACTION_IDS.map((actionId) => actionRecords.get(actionId)))
  });
}

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") throw new Error(`${label} must implement ${method}`);
  return value;
}

function parseRunJob(job, expectedName) {
  if (!job || typeof job !== "object" || job.name !== expectedName) {
    throw new Error(`PetPack pipeline worker expected ${expectedName}`);
  }
  const data = job.data;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some((key) => key !== "runId")) {
    throw new Error("PetPack run-level job data may contain only runId");
  }
  const configuredJobId = job.options?.jobId || job.opts?.jobId;
  const jobId = requiredString(String(job.id || configuredJobId || job.dedupeKey || ""), "PetPack queue job ID");
  if (configuredJobId && String(configuredJobId) !== jobId) {
    throw new Error("PetPack queue job ID does not match its configured dedupe ID");
  }
  const maxAttempts = Number(job.options?.attempts ?? job.opts?.attempts);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("PetPack queue job requires a bounded positive attempt count");
  }
  return {
    jobId,
    runId: requiredString(data.runId, "PetPack job run ID", 128),
    maxAttempts
  };
}

function safeErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(error.code)
    ? error.code.toLowerCase()
    : fallback;
}

class HeavyJobAdmission {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) {
      throw new Error("PetPack heavy-job concurrency must be between 1 and 16");
    }
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(operation) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

class RetryablePetpackJobError extends Error {
  constructor(code, retryAfterMs = null) {
    super("The PetPack pipeline job can be retried safely");
    this.name = "RetryablePetpackJobError";
    this.code = code;
    const parsedRetryAfterMs = retryAfterMs === null || retryAfterMs === undefined
      ? Number.NaN
      : Number(retryAfterMs);
    this.retryAfterMs = Number.isFinite(parsedRetryAfterMs) && parsedRetryAfterMs > 0
      ? Math.max(1000, Math.ceil(parsedRetryAfterMs))
      : null;
  }
}

function postgresInfrastructureFailure(...errors) {
  return errors.find((error) => isPostgresInfrastructureError(error)) || null;
}

function retryablePetpackFailure(code, ...errors) {
  return postgresInfrastructureFailure(...errors) || new RetryablePetpackJobError(code);
}

class PetpackPipelineWorker {
  constructor({
    repository,
    workspace,
    deliveryValidator,
    deliveryValidatorRegistry = [],
    probeAsset,
    builder = buildPetpack,
    workerId = crypto.randomUUID(),
    leaseSeconds = 180,
    maxConcurrentHeavyJobs = 1,
    packageMatteMode = "green-screen",
    productionMode = process.env.PETPACK_PLATFORM_MODE === "production",
    deliveryRetentionDays = null,
    logger = console
  } = {}) {
    for (const method of [
      "claimMediaSnapshot", "completeMediaSnapshot", "claimPackageBuild",
      "renewRunJobLease", "completePackageBuild", "getPackageValidationDescriptor", "claimPackageValidation",
      "completePackageValidation", "failPackageValidation", "releaseRunJobForRetry",
      "claimDeliveryReady", "completeDeliveryReady"
    ]) {
      requireMethod(repository, method, "PetPack worker repository");
    }
    requireMethod(workspace, "withBuildWorkspace", "Private PetPack workspace");
    requireMethod(workspace, "withValidationWorkspace", "Private PetPack workspace");
    requireMethod(deliveryValidator, "describe", "PetPack delivery validator");
    requireMethod(deliveryValidator, "validate", "PetPack delivery validator");
    if (typeof probeAsset !== "function") throw new Error("PetPack pipeline requires a trusted build-time media probe");
    if (typeof builder !== "function") throw new Error("PetPack pipeline requires a package builder");
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) {
      throw new Error("PetPack pipeline lease seconds must be between 30 and 3600");
    }
    this.productionMode = Boolean(productionMode);
    if (this.productionMode) {
      requireMethod(repository, "failMediaSnapshotEvidence", "Production PetPack worker repository");
    }
    if (deliveryRetentionDays !== null && (!Number.isInteger(deliveryRetentionDays) || deliveryRetentionDays < 1 || deliveryRetentionDays > 3650)) {
      throw new Error("Delivery retention days must be between 1 and 3650");
    }
    if (this.productionMode && deliveryRetentionDays === null) {
      throw new Error("Production delivery retention policy must be configured explicitly");
    }
    if (this.productionMode && !isProductionAssuredValidator(deliveryValidator)) {
      throw new Error("Production PetPack worker requires an attested production delivery validator");
    }
    if (!Array.isArray(deliveryValidatorRegistry)) {
      throw new Error("PetPack delivery validator registry must be an array");
    }
    this.deliveryValidators = new Map();
    for (const validator of [deliveryValidator, ...deliveryValidatorRegistry]) {
      requireMethod(validator, "describe", "Registered PetPack delivery validator");
      requireMethod(validator, "validate", "Registered PetPack delivery validator");
      const descriptor = validator.describe();
      const version = requiredString(descriptor?.validatorVersion, "Registered PetPack validator version", 128);
      const existing = this.deliveryValidators.get(version);
      if (existing && existing !== validator) throw new Error("PetPack validator version is registered more than once");
      if (this.productionMode && !isProductionAssuredValidator(validator)) {
        throw new Error("Every production PetPack validator registry entry must be attested");
      }
      this.deliveryValidators.set(version, validator);
    }
    this.repository = repository;
    this.workspace = workspace;
    this.deliveryValidator = deliveryValidator;
    this.probeAsset = probeAsset;
    this.builder = builder;
    this.workerId = requiredString(workerId, "PetPack worker ID", 256);
    this.leaseSeconds = leaseSeconds;
    this.heavyJobAdmission = new HeavyJobAdmission(maxConcurrentHeavyJobs);
    if (!["green-screen", "alpha"].includes(packageMatteMode)) {
      throw new Error("PetPack package matte mode must be green-screen or alpha");
    }
    this.packageMatteMode = packageMatteMode;
    this.deliveryRetentionDays = deliveryRetentionDays;
    this.logger = logger;
  }

  async process(job) {
    if (job?.name === JOB_NAMES.PROCESS_MEDIA) return this._processMediaGate(job);
    if (job?.name === JOB_NAMES.BUILD_PACKAGE) {
      return this.heavyJobAdmission.run(() => this._buildPackage(job));
    }
    if (job?.name === JOB_NAMES.VALIDATE_PACKAGE) {
      return this.heavyJobAdmission.run(() => this._validatePackage(job));
    }
    if (job?.name === JOB_NAMES.DELIVERY_READY) return this._prepareDelivery(job);
    throw new Error("PetPack pipeline worker received an unsupported job name");
  }

  _claimInput(input) {
    return {
      ...input,
      leaseSeconds: this.leaseSeconds,
      leaseOwner: this.workerId
    };
  }

  _createHeartbeat(input, claim) {
    let stopped = false;
    let lostError = null;
    let renewal = null;
    const renew = async () => {
      if (lostError) throw lostError;
      if (!renewal) {
        renewal = this.repository.renewRunJobLease({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          leaseSeconds: this.leaseSeconds
        }).catch((error) => {
          lostError = postgresInfrastructureFailure(error) || Object.assign(
            new Error("PetPack pipeline lease was lost", { cause: error }),
            { code: safeErrorCode(error, "package_lease_lost") }
          );
          throw lostError;
        }).finally(() => {
          renewal = null;
        });
      }
      return renewal;
    };
    const interval = setInterval(() => {
      if (!stopped) renew().catch(() => {});
    }, Math.max(5000, Math.floor(this.leaseSeconds * 1000 / 3)));
    interval.unref?.();
    return {
      renew,
      assertOwned() {
        if (lostError) throw lostError;
      },
      async stop() {
        stopped = true;
        clearInterval(interval);
        if (renewal) await renewal.catch(() => {});
      }
    };
  }

  async _releaseForRetry(input, claim, error, fallbackCode) {
    const code = safeErrorCode(error, fallbackCode);
    let releaseError = null;
    try {
      await this.repository.releaseRunJobForRetry({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: code
      });
    } catch (caught) {
      // The lease remains recoverable after expiry if PostgreSQL is temporarily
      // unavailable during this best-effort release.
      releaseError = caught;
    }
    throw retryablePetpackFailure(code, error, releaseError);
  }

  async _failProductionMediaEvidence(input, claim, error) {
    const code = safeErrorCode(error, "production_evidence_provenance_invalid");
    try {
      await this.repository.failMediaSnapshotEvidence({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: code
      });
    } catch (persistenceError) {
      return this._releaseForRetry(
        input,
        claim,
        persistenceError,
        "production_media_evidence_failure_commit_failed"
      );
    }
    this.logger.warn?.("petpack.worker.production_media_evidence_rejected", {
      runId: input.runId,
      errorCode: code,
      errorCount: Array.isArray(error?.errors) ? error.errors.length : 0
    });
    return { status: "evidence_rejected", runId: input.runId, errorCode: code };
  }

  _nonClaimedResult(claim, runId) {
    if (claim.outcome === "busy") {
      const reported = Number(claim.retryAfterMs);
      const remaining = Number.isFinite(reported) && reported > 0
        ? reported
        : this.leaseSeconds * 1000;
      throw new RetryablePetpackJobError("petpack_execution_busy", Math.ceil(remaining) + 1000);
    }
    return { status: claim.outcome, runId };
  }

  async _processMediaGate(job) {
    const input = parseRunJob(job, JOB_NAMES.PROCESS_MEDIA);
    const claim = await this.repository.claimMediaSnapshot(this._claimInput({
      ...input,
      requireProductionEvidence: this.productionMode
    }));
    if (claim.outcome !== "claimed") return this._nonClaimedResult(claim, input.runId);
    try {
      const productionEvidence = this.productionMode
        ? assertProductionMediaSnapshotEvidence({
            masterEvidence: claim.masterEvidence,
            actions: claim.actions
          })
        : null;
      const snapshot = createPackageInputRevision({
        runId: claim.runId,
        packageName: claim.projectName,
        actions: claim.actions
      });
      const buildJob = createWorkflowJob({
        name: JOB_NAMES.BUILD_PACKAGE,
        run: { id: claim.runId, orderId: claim.orderId },
        inputRevision: `${snapshot.revisionSha256}|${PETPACK_BUILDER_VERSION}`,
        attempts: 3
      });
      await this.repository.completeMediaSnapshot({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        revisionSha256: snapshot.revisionSha256,
        packageName: snapshot.packageName,
        actions: snapshot.actions,
        buildJob,
        ...(productionEvidence ? { productionEvidence } : {})
      });
    } catch (error) {
      if ([
        "production_evidence_provenance_invalid",
        "production_media_evidence_changed"
      ].includes(error?.code)) {
        return this._failProductionMediaEvidence(input, claim, error);
      }
      return this._releaseForRetry(input, claim, error, "package_media_gate_commit_failed");
    }
    this.logger.info?.("petpack.worker.package_inputs_frozen", { runId: input.runId, actionCount: 7 });
    return { status: "snapshot_ready", runId: input.runId };
  }

  async _buildPackage(job) {
    const input = parseRunJob(job, JOB_NAMES.BUILD_PACKAGE);
    const claim = await this.repository.claimPackageBuild(this._claimInput(input));
    if (claim.outcome !== "claimed") return this._nonClaimedResult(claim, input.runId);
    const heartbeat = this._createHeartbeat(input, claim);
    try {
      const packageId = createPackageId(claim.revisionSha256);
      let workspaceResult;
      try {
        workspaceResult = await this.workspace.withBuildWorkspace({
          assets: claim.actions,
          outputObjectKey: ({ sha256 }) => createProjectObjectKey({
            projectId: claim.projectId,
            runId: claim.runId,
            objectClass: OBJECT_CLASSES.FINAL_PETPACK,
            fileName: createPetpackFileName({
              revisionSha256: claim.revisionSha256,
              packageSha256: sha256,
              builderVersion: PETPACK_BUILDER_VERSION
            })
          }),
          beforeUpload: async () => {
            await heartbeat.renew();
            heartbeat.assertOwned();
          }
        }, async ({ assets }) => this.builder({
          packageId,
          name: requiredString(claim.projectName, "Pet project display name", 256),
          version: "1.0.0",
          assets: assets.map((asset) => ({
            ...asset,
            matteMode: this.packageMatteMode,
            container: "webm",
            codec: "vp9",
            expectedSha256: asset.sha256
          })),
          idFactory: (actionId) => createDeterministicUuid(
            `${claim.runId}|${claim.revisionSha256}|${PETPACK_BUILDER_VERSION}|${actionId}`
          ),
          probeAsset: this.probeAsset
        }));
      } catch (error) {
        return await this._releaseForRetry(input, claim, error, "petpack_build_failed");
      }

      try {
        await heartbeat.renew();
        const result = workspaceResult.operationResult;
        const validateDescriptor = this.deliveryValidator.describe();
        const validateJob = createWorkflowJob({
          name: JOB_NAMES.VALIDATE_PACKAGE,
          run: { id: claim.runId, orderId: claim.orderId },
          inputRevision: `${workspaceResult.artifact.sha256}|${validateDescriptor.validatorVersion}`,
          attempts: 3
        });
        await this.repository.completePackageBuild({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          snapshotId: claim.snapshotId,
          revisionSha256: claim.revisionSha256,
          artifact: workspaceResult.artifact,
          packageId,
          manifest: result.manifest,
          buildReport: {
            ok: true,
            policyVersion: PETPACK_BUILD_POLICY_VERSION,
            builderVersion: PETPACK_BUILDER_VERSION,
            inputRevisionSha256: claim.revisionSha256,
            sha256: workspaceResult.artifact.sha256,
            checksums: result.checksums,
            fileNames: result.archive.fileNames
          },
          builderVersion: PETPACK_BUILDER_VERSION,
          validator: validateDescriptor,
          validateJob
        });
        heartbeat.assertOwned();
      } catch (error) {
        return await this._releaseForRetry(input, claim, error, "petpack_build_commit_failed");
      }
      this.logger.info?.("petpack.worker.package_built", { runId: input.runId });
      return { status: "built", runId: input.runId };
    } finally {
      await heartbeat.stop();
    }
  }

  async _validatePackage(job) {
    const input = parseRunJob(job, JOB_NAMES.VALIDATE_PACKAGE);
    const descriptor = await this.repository.getPackageValidationDescriptor({ runId: input.runId });
    const claim = await this.repository.claimPackageValidation({
      ...this._claimInput(input),
      validator: descriptor
    });
    if (claim.outcome !== "claimed") return this._nonClaimedResult(claim, input.runId);
    const validator = this.deliveryValidators.get(descriptor.validatorVersion);
    const registeredDescriptor = validator?.describe?.();
    if (!validator || registeredDescriptor.policyVersion !== descriptor.policyVersion ||
        registeredDescriptor.validatorIdentity !== descriptor.validatorIdentity) {
      return this._releaseForRetry(
        input,
        claim,
        Object.assign(new Error("Frozen PetPack validator version is unavailable"), {
          code: "petpack_validator_version_unavailable"
        }),
        "petpack_validator_version_unavailable"
      );
    }
    const heartbeat = this._createHeartbeat(input, claim);
    try {
      let report;
      try {
        report = await this.workspace.withValidationWorkspace({ artifact: claim.artifact }, async (workspace) => (
          validator.validate({
            ...workspace,
            expectedPackageId: claim.packageId,
            expectedPackageSha256: claim.artifact.sha256,
            actions: claim.actions
          })
        ));
        if (!report || report.ok !== true) {
          throw new PetpackValidationError("PetPack validator did not produce a passing report", report || {
            ok: false,
            errors: ["PetPack validator did not produce a passing report"]
          });
        }
      } catch (error) {
        if (error instanceof PetpackValidationError || (error && error.qa && error.code === "petpack_validation_failed")) {
          try {
            await heartbeat.renew();
            await this.repository.failPackageValidation({
              jobId: input.jobId,
              leaseToken: claim.leaseToken,
              buildId: claim.buildId,
              artifact: claim.artifact,
              report: error.qa,
              errorCode: "petpack_validation_failed"
            });
          } catch (persistenceError) {
            return await this._releaseForRetry(input, claim, persistenceError, "petpack_validation_failure_commit_failed");
          }
          return { status: "validation_failed", runId: input.runId };
        }
        return await this._releaseForRetry(input, claim, error, "petpack_validation_infrastructure_failed");
      }

      try {
        await heartbeat.renew();
        const deliveryJob = createWorkflowJob({
          name: JOB_NAMES.DELIVERY_READY,
          run: { id: claim.runId, orderId: claim.orderId },
          inputRevision: `${claim.artifact.sha256}|${descriptor.validatorVersion}|delivery`,
          attempts: 3
        });
        await this.repository.completePackageValidation({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          buildId: claim.buildId,
          artifact: claim.artifact,
          report,
          deliveryJob
        });
        heartbeat.assertOwned();
      } catch (error) {
        return await this._releaseForRetry(input, claim, error, "petpack_validation_commit_failed");
      }
      this.logger.info?.("petpack.worker.package_validated", { runId: input.runId });
      return { status: "validated", runId: input.runId };
    } finally {
      await heartbeat.stop();
    }
  }

  async _prepareDelivery(job) {
    const input = parseRunJob(job, JOB_NAMES.DELIVERY_READY);
    const claim = await this.repository.claimDeliveryReady(this._claimInput(input));
    if (claim.outcome !== "claimed") return this._nonClaimedResult(claim, input.runId);
    try {
      const result = await this.repository.completeDeliveryReady({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        retentionDays: this.deliveryRetentionDays
      });
      return { status: result.outcome, runId: input.runId };
    } catch (error) {
      return this._releaseForRetry(input, claim, error, "petpack_delivery_commit_failed");
    }
  }
}

module.exports = {
  PRODUCTION_MEDIA_SNAPSHOT_EVIDENCE_CONTRACT_VERSION,
  PetpackPipelineWorker,
  RetryablePetpackJobError,
  HeavyJobAdmission,
  assertProductionMediaSnapshotEvidence,
  postgresInfrastructureFailure,
  parseRunJob,
  retryablePetpackFailure,
  safeErrorCode
};
