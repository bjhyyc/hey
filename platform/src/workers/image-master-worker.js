const crypto = require("node:crypto");

const { createModelReference } = require("../config/model-registry");
const {
  CHARACTER_CANVAS_V1,
  createDevelopmentQaPolicy,
  requireQaPolicy
} = require("../qa/character-canvas-v1");
const { validateMasterImage } = require("../qa/master-image-quality-gate");
const { formatServerOnlyImageInstruction } = require("../providers/modelark-client");
const {
  OBJECT_CLASSES,
  createProjectObjectKey,
  normalizeSha256
} = require("../storage/private-object-store");
const { JOB_NAMES, createWorkflowJob } = require("../workflow/production-workflow");
const { RetryableProductionJobError, safeErrorCode } = require("./production-job-worker");

const MASTER_IMAGE_PROCESSOR_CONTRACT_VERSION = "character-canvas-v1-master-processor/v1";
const GENERATION_JOB_NAMES = new Set([
  JOB_NAMES.GENERATE_FRONT,
  JOB_NAMES.GENERATE_SIDE,
  JOB_NAMES.GENERATE_SLEEP
]);
const FINALIZER_JOB_NAMES = new Set([
  JOB_NAMES.FINALIZE_FRONT,
  JOB_NAMES.FINALIZE_SIDE,
  JOB_NAMES.FINALIZE_SLEEP
]);

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") throw new Error(`${label} must implement ${method}`);
  return value;
}

function parseMasterJob(job, allowedNames) {
  if (!job || typeof job !== "object" || !allowedNames.has(job.name)) {
    throw new Error("Image master worker received an unsupported job name");
  }
  const data = job.data;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some((key) => key !== "runId")) {
    throw new Error("Master-image job data may contain only runId");
  }
  const configuredJobId = job.options?.jobId || job.opts?.jobId;
  const jobId = requiredString(String(job.id || configuredJobId || job.dedupeKey || ""), "Master-image queue job ID");
  if (configuredJobId && String(configuredJobId) !== jobId) {
    throw new Error("Master-image queue job ID does not match its configured dedupe ID");
  }
  const maxAttempts = Number(job.options?.attempts ?? job.opts?.attempts);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("Master-image job requires a bounded positive attempt count");
  }
  return {
    jobId,
    jobName: job.name,
    runId: requiredString(data.runId, "Master-image run ID", 128),
    maxAttempts
  };
}

function createMasterProviderRequestId(jobId, attempt) {
  const digest = crypto.createHash("sha256").update(`${jobId}|${attempt}`).digest("hex");
  return `petpack-image-${digest}`;
}

function createMasterProviderArtifactFileName(providerRequestId) {
  const digest = crypto.createHash("sha256")
    .update(requiredString(providerRequestId, "Seedream request ID"))
    .digest("hex")
    .slice(0, 40);
  return `seedream-${digest}.bin`;
}

function createNormalizedMasterFileName({ sourceSha256, outputSha256, policyVersion, processorVersion } = {}) {
  const source = normalizeSha256(sourceSha256, "Seedream source checksum");
  const output = normalizeSha256(outputSha256, "Normalized master checksum");
  const policy = requiredString(policyVersion, "Master QA policy version", 128);
  const processor = requiredString(processorVersion, "Master processor version", 128);
  const digest = crypto.createHash("sha256")
    .update(`${source}|${output}|${policy}|${processor}`)
    .digest("hex")
    .slice(0, 40);
  return `master-${digest}.png`;
}

function createMasterFinalizerJob(claim, artifact, qaPassed) {
  const name = {
    front: JOB_NAMES.FINALIZE_FRONT,
    side: JOB_NAMES.FINALIZE_SIDE,
    sleep: JOB_NAMES.FINALIZE_SLEEP
  }[claim.kind];
  if (!name) throw new Error("Master finalizer requires a front, side, or sleep claim");
  return createWorkflowJob({
    name,
    run: { id: claim.runId, orderId: claim.orderId },
    inputRevision: `${claim.generationId}:${artifact.sha256}:${qaPassed ? "passed" : "failed"}`,
    attempts: 8
  });
}

class ImageMasterWorker {
  constructor({
    repository,
    modelArkClient,
    objectStore,
    masterWorkspace,
    masterImageProcessor,
    masterImageProcessorRegistry,
    workflow,
    modelRegistry,
    qaPolicyProvider,
    workerId = crypto.randomUUID(),
    leaseSeconds = 900,
    sourceGrantTtlSeconds = 3600,
    productionMode = process.env.PETPACK_PLATFORM_MODE === "production",
    logger = console
  } = {}) {
    for (const method of [
      "claimMasterGeneration", "prepareMasterSubmission", "markMasterProviderAccepted",
      "markMasterProviderOutputSucceeded", "markMasterSubmissionRejected",
      "markMasterSubmissionUnknown", "saveMasterProviderOutput", "bindMasterProcessingPolicy",
      "renewMasterLease", "saveMasterResult", "releaseMasterClaimForRetry",
      "claimMasterFinalization", "completeMasterFinalization", "releaseMasterFinalizationForRetry"
    ]) requireMethod(repository, method, "Image master repository");
    requireMethod(modelArkClient, "createFrontMaster", "ModelArk client");
    requireMethod(modelArkClient, "createSideMaster", "ModelArk client");
    requireMethod(modelArkClient, "createSleepingMaster", "ModelArk client");
    requireMethod(objectStore, "createDownloadGrant", "Private object store");
    requireMethod(objectStore, "archiveProviderOutput", "Private object store");
    requireMethod(masterWorkspace, "withMasterWorkspace", "Private master workspace");
    requireMethod(masterImageProcessor, "normalizeAndInspect", "Master image processor");
    for (const method of ["characterMasterGenerated", "characterMasterQaFailed", "sleepMasterQaPassed", "sleepMasterQaFailed"]) {
      requireMethod(workflow, method, "Production workflow");
    }
    if (!modelRegistry || !modelRegistry.modelArk?.image) throw new Error("ModelArk image registry is required");
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) {
      throw new Error("Master-image lease seconds must be between 30 and 3600");
    }
    if (!Number.isInteger(sourceGrantTtlSeconds) || sourceGrantTtlSeconds < 60 || sourceGrantTtlSeconds > 3600) {
      throw new Error("Master-image source grant TTL must be between 60 and 3600 seconds");
    }
    this.repository = repository;
    this.modelArkClient = modelArkClient;
    this.objectStore = objectStore;
    this.masterWorkspace = masterWorkspace;
    this.masterImageProcessor = masterImageProcessor;
    this.workflow = workflow;
    this.modelRegistry = modelRegistry;
    this.qaPolicyProvider = qaPolicyProvider;
    this.workerId = requiredString(workerId, "Image master worker ID", 256);
    this.leaseSeconds = leaseSeconds;
    this.sourceGrantTtlSeconds = sourceGrantTtlSeconds;
    this.productionMode = Boolean(productionMode);
    this.processorVersion = requiredString(masterImageProcessor.version, "Master image processor version", 128);
    if (masterImageProcessor.contractVersion !== MASTER_IMAGE_PROCESSOR_CONTRACT_VERSION) {
      throw new Error("Master image processor uses an unsupported contract version");
    }
    this.processorRegistry = new Map([[this.processorVersion, masterImageProcessor]]);
    if (masterImageProcessorRegistry !== undefined) {
      const entries = masterImageProcessorRegistry instanceof Map
        ? [...masterImageProcessorRegistry.entries()]
        : Object.entries(masterImageProcessorRegistry || {});
      for (const [version, processor] of entries) {
        const normalizedVersion = requiredString(version, "Retained master processor version", 128);
        requireMethod(processor, "normalizeAndInspect", "Retained master image processor");
        if (processor.version !== normalizedVersion || processor.contractVersion !== MASTER_IMAGE_PROCESSOR_CONTRACT_VERSION) {
          throw new Error("Retained master image processor identity is inconsistent");
        }
        this.processorRegistry.set(normalizedVersion, processor);
      }
    }
    if (this.productionMode) requireMethod(qaPolicyProvider, "getPolicy", "Production QA policy provider");
    this.logger = logger;
  }

  async process(job) {
    if (GENERATION_JOB_NAMES.has(job?.name)) return this._processGeneration(job);
    if (FINALIZER_JOB_NAMES.has(job?.name)) return this._processFinalization(job);
    throw new Error("Image master worker received an unsupported job name");
  }

  _createHeartbeat(input, claim) {
    let stopped = false;
    let lostError = null;
    let renewal = null;
    const renew = async () => {
      if (lostError) throw lostError;
      if (!renewal) {
        renewal = this.repository.renewMasterLease({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          leaseSeconds: this.leaseSeconds
        }).catch((error) => {
          lostError = Object.assign(new Error("Master-image lease was lost"), {
            code: safeErrorCode(error, "master_lease_lost")
          });
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

  async _loadPolicy(claim) {
    const policy = this.qaPolicyProvider && typeof this.qaPolicyProvider.getPolicy === "function"
      ? await this.qaPolicyProvider.getPolicy({
          version: claim.processingPolicyVersion || undefined,
          runId: claim.runId,
          kind: claim.kind
        })
      : createDevelopmentQaPolicy();
    const validated = requireQaPolicy(policy, { production: this.productionMode });
    requiredString(validated.version, "Master QA policy version", 128);
    if (claim.processingPolicyVersion && validated.version !== claim.processingPolicyVersion) {
      throw new Error("Configured QA policy does not match the frozen master policy");
    }
    return validated;
  }

  _resolveProcessor(claim) {
    const version = claim.processorVersion || this.processorVersion;
    const processor = this.processorRegistry.get(version);
    if (!processor) {
      throw Object.assign(new Error("Frozen master image processor version is unavailable"), {
        code: "master_processor_version_unavailable"
      });
    }
    return { processor, version };
  }

  async _releaseGenerationForRetry(input, claim, error) {
    const code = safeErrorCode(error, "master_image_processing_failed");
    try {
      await this.repository.releaseMasterClaimForRetry({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: code
      });
    } catch {
      // An expired lease remains recoverable through normal queue redelivery.
    }
    throw new RetryableProductionJobError(code);
  }

  async _submitSeedream(input, claim, heartbeat) {
    let grants;
    try {
      grants = await Promise.all(claim.references.map((reference) => this.objectStore.createDownloadGrant({
        objectKey: reference.objectKey,
        expiresInSeconds: this.sourceGrantTtlSeconds,
        disposition: "inline"
      })));
    } catch (error) {
      return this._releaseGenerationForRetry(input, claim, error);
    }
    const providerRequestId = createMasterProviderRequestId(input.jobId, claim.attempt);
    try {
      await this.repository.prepareMasterSubmission({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        providerRequestId
      });
    } catch (error) {
      return this._releaseGenerationForRetry(input, claim, error);
    }
    const serverPrompt = formatServerOnlyImageInstruction({
      kind: claim.kind,
      prompt: claim.promptVersion.prompt,
      negativePrompt: claim.promptVersion.negativePrompt
    });
    let created;
    try {
      if (claim.kind === "front") {
        created = await this.modelArkClient.createFrontMaster({
          requestId: providerRequestId,
          serverPrompt,
          sourcePhotos: claim.references.map((reference, index) => ({
            objectKey: reference.objectKey,
            signedReadUrl: grants[index].url
          })),
          modelReference: claim.modelReference,
          outputSize: claim.outputSize
        });
      } else if (claim.kind === "side") {
        if (claim.references.length < 3) throw new Error("Side master requires source photos and an approved front reference");
        const frontIndex = claim.references.findIndex((reference) => reference.role === "front");
        const resolvedFrontIndex = frontIndex >= 0 ? frontIndex : claim.references.length - 1;
        created = await this.modelArkClient.createSideMaster({
          requestId: providerRequestId,
          serverPrompt,
          sourcePhotos: claim.references
            .filter((_, index) => index !== resolvedFrontIndex)
            .map((reference) => ({ objectKey: reference.objectKey, signedReadUrl: grants[claim.references.indexOf(reference)].url })),
          frontMaster: {
            objectKey: claim.references[resolvedFrontIndex].objectKey,
            signedReadUrl: grants[resolvedFrontIndex].url,
            canvasId: CHARACTER_CANVAS_V1.id
          },
          modelReference: claim.modelReference,
          outputSize: claim.outputSize
        });
      } else {
        if (claim.references.length !== 2) throw new Error("Sleeping master requires approved front and side references");
        const frontIndex = Math.max(0, claim.references.findIndex((reference) => reference.role === "front"));
        const sideIndex = claim.references.findIndex((reference) => reference.role === "side");
        const resolvedSideIndex = sideIndex >= 0 ? sideIndex : (frontIndex === 0 ? 1 : 0);
        created = await this.modelArkClient.createSleepingMaster({
          requestId: providerRequestId,
          serverPrompt,
          frontMaster: {
            objectKey: claim.references[frontIndex].objectKey,
            signedReadUrl: grants[frontIndex].url,
            canvasId: CHARACTER_CANVAS_V1.id
          },
          sideMaster: {
            objectKey: claim.references[resolvedSideIndex].objectKey,
            signedReadUrl: grants[resolvedSideIndex].url,
            canvasId: CHARACTER_CANVAS_V1.id
          },
          modelReference: claim.modelReference,
          outputSize: claim.outputSize
        });
      }
    } catch (error) {
      const code = safeErrorCode(error, "seedream_submission_unknown");
      if (error?.providerSubmissionOutcome === "rejected") {
        await this.repository.markMasterSubmissionRejected({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          errorCode: code
        });
        throw new RetryableProductionJobError(code);
      }
      await this.repository.markMasterSubmissionUnknown({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: code
      });
      return { reconciliationRequired: true };
    }
    try {
      await this.repository.markMasterProviderAccepted({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        providerRequestId
      });
    } catch (error) {
      const code = safeErrorCode(error, "seedream_acceptance_accounting_failed");
      await this.repository.markMasterSubmissionUnknown({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: code
      }).catch(() => {});
      return { reconciliationRequired: true };
    }
    if (!Array.isArray(created.outputUrls) || created.outputUrls.length !== 1) {
      await this.repository.markMasterSubmissionUnknown({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: "seedream_output_ambiguous"
      });
      return { reconciliationRequired: true };
    }
    try {
      await this.repository.markMasterProviderOutputSucceeded({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        providerRequestId
      });
    } catch (error) {
      const code = safeErrorCode(error, "seedream_output_accounting_failed");
      await this.repository.markMasterSubmissionUnknown({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: code
      }).catch(() => {});
      return { reconciliationRequired: true };
    }
    const objectKey = createProjectObjectKey({
      projectId: claim.projectId,
      runId: claim.runId,
      objectClass: OBJECT_CLASSES.PROVIDER_OUTPUT,
      fileName: createMasterProviderArtifactFileName(providerRequestId)
    });
    let artifact;
    try {
      await heartbeat.renew();
      artifact = await this.objectStore.archiveProviderOutput({
        sourceUrl: created.outputUrls[0],
        objectKey
      });
      if (!artifact?.sha256 || !artifact?.byteSize || !artifact?.contentType) {
        throw Object.assign(new Error("Archived Seedream metadata is incomplete"), { code: "seedream_archive_metadata_missing" });
      }
      claim.providerOutput = await this.repository.saveMasterProviderOutput({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        providerRequestId,
        artifact
      });
    } catch (error) {
      const code = safeErrorCode(error, "seedream_output_archive_failed");
      await this.repository.markMasterSubmissionUnknown({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: code
      }).catch(() => {});
      return { reconciliationRequired: true };
    }
    return { reconciliationRequired: false };
  }

  async _processGeneration(job) {
    const input = parseMasterJob(job, GENERATION_JOB_NAMES);
    const claim = await this.repository.claimMasterGeneration({
      ...input,
      leaseSeconds: this.leaseSeconds,
      leaseOwner: this.workerId,
      modelReference: createModelReference(this.modelRegistry, "image"),
      outputSize: this.modelRegistry.modelArk.image.outputSize || null
    });
    if (claim.outcome === "busy") throw new RetryableProductionJobError("master_image_busy");
    if (claim.outcome !== "claimed") return { status: claim.outcome, runId: input.runId, kind: claim.kind };
    const heartbeat = this._createHeartbeat(input, claim);
    try {
      if (claim.stage === "submit") {
        const submission = await this._submitSeedream(input, claim, heartbeat);
        if (submission.reconciliationRequired) {
          return { status: "reconciliation_required", runId: input.runId, kind: claim.kind };
        }
      }
      let policy;
      let selectedProcessor;
      try {
        policy = await this._loadPolicy(claim);
        selectedProcessor = this._resolveProcessor(claim);
        await this.repository.bindMasterProcessingPolicy({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          policyVersion: policy.version,
          processorVersion: selectedProcessor.version
        });
        await heartbeat.renew();
      } catch (error) {
        return this._releaseGenerationForRetry(input, claim, error);
      }

      let workspaceResult;
      try {
        workspaceResult = await this.masterWorkspace.withMasterWorkspace({
          input: claim.providerOutput,
          references: claim.references,
          outputObjectKey: ({ sha256 }) => createProjectObjectKey({
            projectId: claim.projectId,
            runId: claim.runId,
            objectClass: claim.kind === "sleep" ? OBJECT_CLASSES.SLEEP_MASTER : OBJECT_CLASSES.AWAKE_MASTER,
            fileName: createNormalizedMasterFileName({
              sourceSha256: claim.providerOutput.sha256,
              outputSha256: sha256,
              policyVersion: policy.version,
              processorVersion: selectedProcessor.version
            })
          }),
          beforeUpload: async () => {
            await heartbeat.renew();
            heartbeat.assertOwned();
          }
        }, async ({ inputPath, outputPath, referencePaths, scratchDirectory }) => {
          const inspection = await selectedProcessor.processor.normalizeAndInspect({
            kind: claim.kind,
            inputPath,
            outputPath,
            referencePaths,
            scratchDirectory,
            canvas: CHARACTER_CANVAS_V1,
            referenceMetrics: claim.referenceMetrics
          });
          if (!inspection || !inspection.frame || !inspection.contentInspection || !inspection.appearanceInspection) {
            throw new Error("Master image processor returned incomplete QA evidence");
          }
          const qa = validateMasterImage({
            kind: claim.kind,
            frame: inspection.frame,
            contentInspection: inspection.contentInspection,
            appearanceInspection: inspection.appearanceInspection,
            referenceMetrics: claim.referenceMetrics,
            sourceReferenceCount: referencePaths.length,
            policy,
            production: this.productionMode
          });
          return { inspection, qa };
        });
      } catch (error) {
        return this._releaseGenerationForRetry(input, claim, error);
      }
      if (workspaceResult.localArtifact.width !== CHARACTER_CANVAS_V1.width ||
          workspaceResult.localArtifact.height !== CHARACTER_CANVAS_V1.height) {
        return this._releaseGenerationForRetry(input, claim, Object.assign(
          new Error(`Normalized master PNG does not match ${CHARACTER_CANVAS_V1.id}`),
          { code: "master_canvas_mismatch" }
        ));
      }
      try {
        await heartbeat.renew();
        const qa = {
          ...workspaceResult.operationResult.qa,
          processing: {
            processorContractVersion: MASTER_IMAGE_PROCESSOR_CONTRACT_VERSION,
            processorVersion: selectedProcessor.version,
            policyVersion: policy.version,
            sourceSha256: claim.providerOutput.sha256,
            outputSha256: workspaceResult.artifact.sha256
          }
        };
        const saved = await this.repository.saveMasterResult({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          artifact: workspaceResult.artifact,
          qaReport: qa,
          policyVersion: policy.version,
          processorVersion: selectedProcessor.version,
          finalizerJob: createMasterFinalizerJob(claim, workspaceResult.artifact, qa.ok)
        });
        this.logger.info?.("petpack.worker.master_image_processed", {
          runId: input.runId,
          kind: claim.kind,
          qaPassed: saved.qaPassed
        });
        return { status: saved.qaPassed ? "qa_passed" : "qa_failed", runId: input.runId, kind: claim.kind };
      } catch (error) {
        return this._releaseGenerationForRetry(input, claim, error);
      }
    } finally {
      await heartbeat.stop();
    }
  }

  async _processFinalization(job) {
    const input = parseMasterJob(job, FINALIZER_JOB_NAMES);
    const claim = await this.repository.claimMasterFinalization({
      ...input,
      leaseSeconds: Math.min(this.leaseSeconds, 300),
      leaseOwner: this.workerId
    });
    if (claim.outcome === "busy") throw new RetryableProductionJobError("master_finalization_busy");
    if (claim.outcome !== "claimed") return { status: claim.outcome, runId: input.runId, kind: claim.kind };
    try {
      if (claim.kind === "front" || claim.kind === "side") {
        if (claim.qaPassed) {
          await this.workflow.characterMasterGenerated({
            run: claim.run,
            view: claim.kind,
            candidateId: claim.candidateId
          });
        } else {
          await this.workflow.characterMasterQaFailed({ run: claim.run, view: claim.kind });
        }
      } else if (claim.qaPassed) {
        await this.workflow.sleepMasterQaPassed({
          run: claim.run,
          frontMaster: claim.frontMaster,
          sideMaster: claim.sideMaster,
          sleepMaster: claim.sleepMaster
        });
      } else {
        await this.workflow.sleepMasterQaFailed({
          run: claim.run,
          frontMasterRevisionId: claim.frontCandidateId,
          sideMasterRevisionId: claim.sideCandidateId
        });
      }
      await this.repository.completeMasterFinalization({
        jobId: input.jobId,
        leaseToken: claim.leaseToken
      });
      return {
        status: claim.qaPassed ? "finalized" : (claim.kind === "sleep" ? "retry_scheduled" : "failed"),
        runId: input.runId,
        kind: claim.kind
      };
    } catch (error) {
      const code = safeErrorCode(error, "master_finalization_failed");
      await this.repository.releaseMasterFinalizationForRetry({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: code
      }).catch(() => {});
      throw new RetryableProductionJobError(code);
    }
  }
}

module.exports = {
  FINALIZER_JOB_NAMES,
  GENERATION_JOB_NAMES,
  ImageMasterWorker,
  MASTER_IMAGE_PROCESSOR_CONTRACT_VERSION,
  createMasterFinalizerJob,
  createMasterProviderArtifactFileName,
  createMasterProviderRequestId,
  createNormalizedMasterFileName,
  parseMasterJob
};
