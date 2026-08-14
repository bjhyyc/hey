const crypto = require("node:crypto");

const { assertActionId } = require("../domain/action-catalog");
const { CHARACTER_CANVAS_V1, createDevelopmentQaPolicy, requireQaPolicy } = require("../qa/character-canvas-v1");
const { OBJECT_CLASSES, createProjectObjectKey, normalizeSha256 } = require("../storage/private-object-store");
const { JOB_NAMES, createWorkflowJob } = require("../workflow/production-workflow");

const VIDEO_TASK_STATUS = Object.freeze({
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  UNKNOWN: "unknown"
});
const PENDING_VIDEO_STATUSES = new Set(["queued", "pending", "running", "processing", "in_progress", "submitted"]);
const SUCCEEDED_VIDEO_STATUSES = new Set(["succeeded", "success", "completed", "done"]);
const FAILED_VIDEO_STATUSES = new Set(["failed", "error", "cancelled", "canceled", "expired"]);
const MEDIA_PROCESSOR_VERSION = "character-canvas-v1-green-vp9-v1";

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") throw new Error(`${label} must implement ${method}`);
  return value;
}

function requiredString(value, label, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`${label} is required`);
  return value.trim();
}

function parseVideoJob(job, expectedName = JOB_NAMES.GENERATE_VIDEO) {
  if (!job || typeof job !== "object" || job.name !== expectedName) {
    throw new Error(`Production worker expected ${expectedName}`);
  }
  const data = job.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Video job data is required");
  if (Object.keys(data).some((key) => !["runId", "actionId"].includes(key))) {
    throw new Error("Video job data may contain only runId and actionId");
  }
  const actionId = requiredString(data.actionId, "Video job action ID", 64);
  assertActionId(actionId);
  const configuredJobId = job.options?.jobId || job.opts?.jobId;
  const jobId = requiredString(String(job.id || configuredJobId || job.dedupeKey || ""), "Video queue job ID");
  if (configuredJobId && String(configuredJobId) !== jobId) throw new Error("Video queue job ID does not match its configured dedupe ID");
  const maxAttempts = Number(job.options?.attempts ?? job.opts?.attempts);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("Video queue job requires a bounded positive attempt count");
  }
  return { jobId, runId: requiredString(data.runId, "Video job run ID", 128), actionId, maxAttempts };
}

function classifyVideoTaskStatus(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (PENDING_VIDEO_STATUSES.has(normalized)) return VIDEO_TASK_STATUS.PENDING;
  if (SUCCEEDED_VIDEO_STATUSES.has(normalized)) return VIDEO_TASK_STATUS.SUCCEEDED;
  if (FAILED_VIDEO_STATUSES.has(normalized)) return VIDEO_TASK_STATUS.FAILED;
  return VIDEO_TASK_STATUS.UNKNOWN;
}

function createActionJob({ name, claim, inputRevision, attempts }) {
  return createWorkflowJob({
    name,
    run: { id: claim.runId, orderId: claim.orderId },
    actionId: claim.actionId,
    inputRevision,
    attempts
  });
}

function createProviderRequestId(jobId, attempt) {
  const digest = crypto.createHash("sha256").update(`${jobId}|${attempt}`).digest("hex");
  return `petpack-video-${digest}`;
}

function createProviderArtifactFileName(providerTaskId) {
  const digest = crypto.createHash("sha256").update(requiredString(providerTaskId, "ModelArk task ID")).digest("hex").slice(0, 32);
  return `seedance-${digest}.bin`;
}

function createProcessedArtifactFileName({ sourceSha256, outputSha256, policyVersion } = {}) {
  const source = normalizeSha256(sourceSha256, "Provider source checksum");
  const output = normalizeSha256(outputSha256, "Processed action checksum");
  const policy = requiredString(policyVersion, "Action QA policy version", 128);
  const digest = crypto.createHash("sha256")
    .update(`${source}|${output}|${MEDIA_PROCESSOR_VERSION}|${policy}`)
    .digest("hex")
    .slice(0, 40);
  return `action-${digest}.webm`;
}

function safeErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(error.code)
    ? error.code.toLowerCase()
    : fallback;
}

class RetryableProductionJobError extends Error {
  constructor(code, retryAfterMs = null) {
    super("The production job can be retried safely");
    this.name = "RetryableProductionJobError";
    this.code = code;
    const parsedRetryAfterMs = retryAfterMs === null || retryAfterMs === undefined
      ? Number.NaN
      : Number(retryAfterMs);
    this.retryAfterMs = Number.isFinite(parsedRetryAfterMs) && parsedRetryAfterMs > 0
      ? Math.max(1000, Math.ceil(parsedRetryAfterMs))
      : null;
  }
}

function leaseBusyRetryAfterMs(claim, leaseSeconds) {
  const reported = Number(claim?.retryAfterMs);
  const fallback = Number(leaseSeconds) * 1000;
  const remaining = Number.isFinite(reported) && reported > 0 ? reported : fallback;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error("A busy lease requires a positive retry delay");
  }
  // Do not race the database clock at the exact lease boundary.
  return Math.max(1000, Math.ceil(remaining) + 1000);
}

function createLeaseBusyError(code, claim, leaseSeconds) {
  return new RetryableProductionJobError(code, leaseBusyRetryAfterMs(claim, leaseSeconds));
}

/**
 * Handles Seedance submission and authoritative task polling. It never
 * receives prompt text, signed URLs, or provider IDs from the queue payload;
 * those are loaded after a PostgreSQL lease from server-only stores.
 */
class ProductionJobWorker {
  constructor({
    repository,
    modelArkClient,
    objectStore,
    workerId = crypto.randomUUID(),
    leaseSeconds = 120,
    frameGrantTtlSeconds = 3600,
    pollDelaySeconds = 15,
    pollQueryAttempts = 3,
    maxProviderPolls = 120,
    mediaWorker,
    mediaWorkspace,
    workflow,
    qaPolicyProvider,
    productionMode = process.env.PETPACK_PLATFORM_MODE === "production",
    processingLeaseSeconds = 900,
    logger = console
  } = {}) {
    this.repository = requireMethod(repository, "claimVideoSubmission", "Production worker repository");
    for (const method of [
      "prepareVideoSubmission", "completeVideoSubmission", "releaseVideoClaimForRetry",
      "markVideoSubmissionRejected", "markVideoSubmissionUnknown", "claimVideoPoll",
      "completeVideoPollPending", "markVideoProviderOutputSucceeded", "completeVideoPollSuccess", "releaseVideoPollForRetry",
      "markVideoPollFailed", "markVideoPollUnknown"
    ]) {
      requireMethod(repository, method, "Production worker repository");
    }
    this.modelArkClient = requireMethod(modelArkClient, "createVideoTask", "ModelArk client");
    requireMethod(modelArkClient, "getVideoTask", "ModelArk client");
    this.objectStore = requireMethod(objectStore, "createDownloadGrant", "Private object store");
    requireMethod(objectStore, "archiveProviderOutput", "Private object store");
    this.workerId = requiredString(workerId, "Production worker ID", 256);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw new Error("Worker lease seconds must be between 30 and 3600");
    if (!Number.isInteger(frameGrantTtlSeconds) || frameGrantTtlSeconds < 60 || frameGrantTtlSeconds > 3600) {
      throw new Error("Frame grant TTL must be between 60 and 3600 seconds");
    }
    if (!Number.isInteger(pollDelaySeconds) || pollDelaySeconds < 5 || pollDelaySeconds > 3600) {
      throw new Error("Provider poll delay must be between 5 and 3600 seconds");
    }
    if (!Number.isInteger(pollQueryAttempts) || pollQueryAttempts < 1 || pollQueryAttempts > 20) {
      throw new Error("Provider poll query attempts must be between 1 and 20");
    }
    if (!Number.isInteger(maxProviderPolls) || maxProviderPolls < 1 || maxProviderPolls > 1000) {
      throw new Error("Maximum provider polls must be between 1 and 1000");
    }
    if (!Number.isInteger(processingLeaseSeconds) || processingLeaseSeconds < 30 || processingLeaseSeconds > 3600) {
      throw new Error("Media processing lease seconds must be between 30 and 3600");
    }
    this.leaseSeconds = leaseSeconds;
    this.frameGrantTtlSeconds = frameGrantTtlSeconds;
    this.pollDelaySeconds = pollDelaySeconds;
    this.pollQueryAttempts = pollQueryAttempts;
    this.maxProviderPolls = maxProviderPolls;
    this.mediaWorker = mediaWorker;
    this.mediaWorkspace = mediaWorkspace;
    this.workflow = workflow;
    this.qaPolicyProvider = qaPolicyProvider;
    this.productionMode = Boolean(productionMode);
    this.processingLeaseSeconds = processingLeaseSeconds;
    this.logger = logger;
  }

  async process(job) {
    if (job && job.name === JOB_NAMES.GENERATE_VIDEO) return this._processVideoSubmission(job);
    if (job && job.name === JOB_NAMES.POLL_VIDEO) return this._processVideoPoll(job);
    if (job && job.name === JOB_NAMES.PROCESS_VIDEO_ACTION) return this._processVideoAction(job);
    if (job && job.name === JOB_NAMES.FINALIZE_VIDEO_ACTION) return this._processVideoAction(job);
    throw new Error("Production worker received an unsupported job name");
  }

  async _processVideoSubmission(job) {
    const input = parseVideoJob(job);
    const claim = await this.repository.claimVideoSubmission({
      ...input,
      leaseSeconds: this.leaseSeconds,
      leaseOwner: this.workerId
    });
    if (claim.outcome === "busy") {
      throw createLeaseBusyError("video_submission_busy", claim, this.leaseSeconds);
    }
    if (claim.outcome !== "claimed") {
      return { status: claim.outcome, runId: input.runId, actionId: input.actionId };
    }

    let firstFrame;
    let lastFrame;
    try {
      [firstFrame, lastFrame] = await Promise.all([
        this.objectStore.createDownloadGrant({
          objectKey: claim.firstFrameObjectKey,
          expiresInSeconds: this.frameGrantTtlSeconds,
          disposition: "inline"
        }),
        this.objectStore.createDownloadGrant({
          objectKey: claim.lastFrameObjectKey,
          expiresInSeconds: this.frameGrantTtlSeconds,
          disposition: "inline"
        })
      ]);
    } catch (error) {
      const code = safeErrorCode(error, "frame_grant_failed");
      await this.repository.releaseVideoClaimForRetry({ jobId: input.jobId, leaseToken: claim.leaseToken, errorCode: code });
      throw new RetryableProductionJobError(code);
    }

    const providerRequestId = createProviderRequestId(input.jobId, claim.attempt);
    try {
      await this.repository.prepareVideoSubmission({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        providerRequestId
      });
    } catch (error) {
      const code = safeErrorCode(error, "submission_intent_failed");
      try {
        await this.repository.releaseVideoClaimForRetry({ jobId: input.jobId, leaseToken: claim.leaseToken, errorCode: code });
      } catch {
        // The lease will expire and become recoverable even if PostgreSQL is
        // unavailable for this immediate best-effort release.
      }
      throw new RetryableProductionJobError(code);
    }

    let created;
    try {
      created = await this.modelArkClient.createVideoTask({
        requestId: providerRequestId,
        runId: input.runId,
        actionId: input.actionId,
        promptVersion: claim.promptVersion,
        firstFrame: {
          objectKey: claim.firstFrameObjectKey,
          signedReadUrl: firstFrame.url,
          canvasId: CHARACTER_CANVAS_V1.id
        },
        lastFrame: {
          objectKey: claim.lastFrameObjectKey,
          signedReadUrl: lastFrame.url,
          canvasId: CHARACTER_CANVAS_V1.id
        },
        duration: claim.promptVersion.duration,
        modelReference: claim.modelReference
      });
    } catch (error) {
      const code = safeErrorCode(error, "modelark_submission_unknown");
      if (error && error.providerSubmissionOutcome === "rejected") {
        await this.repository.markVideoSubmissionRejected({ jobId: input.jobId, leaseToken: claim.leaseToken, errorCode: code });
        throw new RetryableProductionJobError(code);
      }
      await this.repository.markVideoSubmissionUnknown({ jobId: input.jobId, leaseToken: claim.leaseToken, errorCode: code });
      return { status: "reconciliation_required", runId: input.runId, actionId: input.actionId };
    }

    const providerTaskId = requiredString(created.providerTaskId, "ModelArk task ID");
    const pollJob = createActionJob({
      name: JOB_NAMES.POLL_VIDEO,
      claim,
      inputRevision: `${providerTaskId}:poll:0`,
      attempts: this.pollQueryAttempts
    });
    try {
      await this.repository.completeVideoSubmission({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        providerRequestId,
        providerTaskId,
        pollJob,
        pollDelaySeconds: this.pollDelaySeconds
      });
    } catch (error) {
      // One idempotent recovery attempt closes the common case where the
      // provider succeeded but the first database write had a transient error.
      // If it still fails, the persisted request ID prevents blind resubmission.
      try {
        await this.repository.completeVideoSubmission({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          providerRequestId,
          providerTaskId,
          pollJob,
          pollDelaySeconds: this.pollDelaySeconds
        });
      } catch {
        this.logger.warn?.("petpack.worker.video_task_binding_failed", { runId: input.runId, actionId: input.actionId });
        throw error;
      }
    }
    this.logger.info?.("petpack.worker.video_submitted", { runId: input.runId, actionId: input.actionId, attempt: claim.attempt });
    return { status: "submitted", runId: input.runId, actionId: input.actionId };
  }

  async _processVideoPoll(job) {
    const input = parseVideoJob(job, JOB_NAMES.POLL_VIDEO);
    const claim = await this.repository.claimVideoPoll({
      ...input,
      leaseSeconds: this.leaseSeconds,
      leaseOwner: this.workerId
    });
    if (claim.outcome === "busy") {
      throw createLeaseBusyError("video_poll_busy", claim, this.leaseSeconds);
    }
    if (claim.outcome !== "claimed") {
      return { status: claim.outcome, runId: input.runId, actionId: input.actionId };
    }

    let task;
    try {
      task = await this.modelArkClient.getVideoTask({
        requestId: createProviderRequestId(`${input.jobId}|poll-query`, claim.attempt),
        providerTaskId: claim.providerTaskId
      });
    } catch (error) {
      const code = safeErrorCode(error, "modelark_poll_failed");
      await this.repository.releaseVideoPollForRetry({ jobId: input.jobId, leaseToken: claim.leaseToken, errorCode: code });
      throw new RetryableProductionJobError(code);
    }

    const providerState = classifyVideoTaskStatus(task.status);
    if (providerState === VIDEO_TASK_STATUS.PENDING) {
      if (claim.pollCount >= this.maxProviderPolls) {
        await this.repository.markVideoPollUnknown({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          errorCode: "modelark_poll_timeout"
        });
        return { status: "provider_timeout", runId: input.runId, actionId: input.actionId };
      }
      const nextPollCount = claim.pollCount + 1;
      const nextPollJob = createActionJob({
        name: JOB_NAMES.POLL_VIDEO,
        claim,
        inputRevision: `${claim.providerTaskId}:poll:${nextPollCount}`,
        attempts: this.pollQueryAttempts
      });
      await this.repository.completeVideoPollPending({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        expectedPollCount: claim.pollCount,
        nextPollJob,
        pollDelaySeconds: this.pollDelaySeconds
      });
      return { status: "waiting_provider", runId: input.runId, actionId: input.actionId };
    }
    if (providerState === VIDEO_TASK_STATUS.FAILED) {
      await this.repository.markVideoPollFailed({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: "modelark_task_failed"
      });
      return { status: "provider_failed", runId: input.runId, actionId: input.actionId };
    }
    if (providerState === VIDEO_TASK_STATUS.UNKNOWN) {
      await this.repository.markVideoPollUnknown({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: "modelark_task_status_unknown"
      });
      return { status: "reconciliation_required", runId: input.runId, actionId: input.actionId };
    }

    if (!Array.isArray(task.outputUrls) || task.outputUrls.length !== 1) {
      await this.repository.releaseVideoPollForRetry({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: "modelark_output_not_ready"
      });
      throw new RetryableProductionJobError("modelark_output_not_ready");
    }
    try {
      await this.repository.markVideoProviderOutputSucceeded({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        providerTaskId: claim.providerTaskId
      });
    } catch (error) {
      const code = safeErrorCode(error, "modelark_output_accounting_failed");
      await this.repository.markVideoPollUnknown({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: code
      }).catch(() => {});
      return { status: "reconciliation_required", runId: input.runId, actionId: input.actionId };
    }
    const objectKey = createProjectObjectKey({
      projectId: claim.projectId,
      runId: claim.runId,
      objectClass: OBJECT_CLASSES.PROVIDER_OUTPUT,
      actionId: claim.actionId,
      fileName: createProviderArtifactFileName(claim.providerTaskId)
    });
    let artifact;
    try {
      artifact = await this.objectStore.archiveProviderOutput({
        sourceUrl: task.outputUrls[0],
        objectKey
      });
      if (!artifact || !artifact.sha256 || !artifact.byteSize || !artifact.contentType) {
        throw Object.assign(new Error("Archived output metadata is incomplete"), { code: "provider_archive_metadata_missing" });
      }
    } catch (error) {
      const code = safeErrorCode(error, "provider_output_archive_failed");
      await this.repository.releaseVideoPollForRetry({ jobId: input.jobId, leaseToken: claim.leaseToken, errorCode: code });
      throw new RetryableProductionJobError(code);
    }
    const processJob = createActionJob({
      name: JOB_NAMES.PROCESS_VIDEO_ACTION,
      claim,
      inputRevision: `${artifact.sha256}:process`,
      attempts: 3
    });
    await this.repository.completeVideoPollSuccess({
      jobId: input.jobId,
      leaseToken: claim.leaseToken,
      providerTaskId: claim.providerTaskId,
      artifact,
      processJob
    });
    this.logger.info?.("petpack.worker.video_output_archived", { runId: input.runId, actionId: input.actionId });
    return { status: "archived", runId: input.runId, actionId: input.actionId };
  }

  _requireVideoProcessingDependencies() {
    for (const method of [
      "claimVideoProcessing", "bindVideoProcessingPolicy", "renewVideoProcessingLease",
      "saveVideoProcessingResult", "failVideoProcessingQa", "completeVideoProcessingExecution",
      "releaseVideoProcessingForRetry"
    ]) {
      requireMethod(this.repository, method, "Production worker repository");
    }
    requireMethod(this.mediaWorker, "processAction", "Media worker");
    requireMethod(this.mediaWorkspace, "withActionWorkspace", "Private media workspace");
    requireMethod(this.workflow, "videoActionQaPassed", "Production workflow");
    if (this.productionMode) requireMethod(this.qaPolicyProvider, "getPolicy", "Production QA policy provider");
  }

  _createProcessingHeartbeat(input, claim) {
    let stopped = false;
    let lostError = null;
    let renewal = null;
    const renew = async () => {
      if (lostError) throw lostError;
      if (!renewal) {
        renewal = this.repository.renewVideoProcessingLease({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          leaseSeconds: this.processingLeaseSeconds
        }).catch((error) => {
          lostError = Object.assign(new Error("Video processing lease was lost"), {
            code: safeErrorCode(error, "processing_lease_lost")
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
    }, Math.max(5000, Math.floor(this.processingLeaseSeconds * 1000 / 3)));
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

  async _loadAndFreezeProcessingPolicy(input, claim) {
    let policy;
    if (this.qaPolicyProvider && typeof this.qaPolicyProvider.getPolicy === "function") {
      policy = await this.qaPolicyProvider.getPolicy({
        version: claim.processingPolicyVersion || undefined,
        runId: claim.runId,
        actionId: claim.actionId
      });
    } else {
      policy = createDevelopmentQaPolicy();
    }
    const validated = requireQaPolicy(policy, { production: this.productionMode });
    if (claim.processingPolicyVersion && validated.version !== claim.processingPolicyVersion) {
      throw new Error("Configured QA policy does not match the action's frozen policy version");
    }
    if (claim.processorVersion && claim.processorVersion !== MEDIA_PROCESSOR_VERSION) {
      throw new Error("Action media was frozen to a different processor version");
    }
    await this.repository.bindVideoProcessingPolicy({
      jobId: input.jobId,
      leaseToken: claim.leaseToken,
      policyVersion: validated.version,
      processorVersion: MEDIA_PROCESSOR_VERSION
    });
    return validated;
  }

  async _finalizeVideoAction(input, claim, heartbeat) {
    await heartbeat.renew();
    heartbeat.assertOwned();
    await this.workflow.videoActionQaPassed({
      run: claim.run,
      actionId: claim.actionId,
      actionRevisionId: claim.mediaAssetId,
      providerTaskId: claim.providerTaskId
    });
    heartbeat.assertOwned();
    await this.repository.completeVideoProcessingExecution({
      jobId: input.jobId,
      leaseToken: claim.leaseToken
    });
  }

  async _releaseProcessingForRetry(input, claim, error) {
    const code = safeErrorCode(error, "action_media_processing_failed");
    try {
      const settled = await this.repository.releaseVideoProcessingForRetry({
        jobId: input.jobId,
        leaseToken: claim.leaseToken,
        errorCode: code
      });
      if (settled && settled.status === "succeeded") {
        return { status: "processed", runId: input.runId, actionId: input.actionId };
      }
    } catch {
      // An expired lease is recoverable by redelivery; a concurrently committed
      // qa_passed action remains the durable source of truth.
    }
    throw new RetryableProductionJobError(code);
  }

  async _processVideoAction(job) {
    this._requireVideoProcessingDependencies();
    const expectedName = job?.name === JOB_NAMES.FINALIZE_VIDEO_ACTION
      ? JOB_NAMES.FINALIZE_VIDEO_ACTION
      : JOB_NAMES.PROCESS_VIDEO_ACTION;
    const input = parseVideoJob(job, expectedName);
    const claim = await this.repository.claimVideoProcessing({
      ...input,
      jobName: expectedName,
      leaseSeconds: this.processingLeaseSeconds,
      leaseOwner: this.workerId
    });
    if (claim.outcome === "busy") {
      throw createLeaseBusyError("action_media_processing_busy", claim, this.processingLeaseSeconds);
    }
    if (!["claimed", "finalize_pending"].includes(claim.outcome)) {
      return { status: claim.outcome, runId: input.runId, actionId: input.actionId };
    }
    const heartbeat = this._createProcessingHeartbeat(input, claim);
    try {
      if (claim.outcome === "finalize_pending") {
        try {
          await this._finalizeVideoAction(input, claim, heartbeat);
        } catch (error) {
          return await this._releaseProcessingForRetry(input, claim, error);
        }
        return { status: "processed", runId: input.runId, actionId: input.actionId };
      }

      let policy;
      try {
        policy = await this._loadAndFreezeProcessingPolicy(input, claim);
        await heartbeat.renew();
      } catch (error) {
        return await this._releaseProcessingForRetry(input, claim, error);
      }

      let workspaceResult;
      try {
        workspaceResult = await this.mediaWorkspace.withActionWorkspace({
          inputObjectKey: claim.sourceObjectKey,
          expectedSha256: claim.sourceSha256,
          expectedByteSize: claim.sourceByteSize,
          firstMaster: {
            objectKey: claim.firstMasterObjectKey,
            sha256: claim.expectedFirstMasterHash,
            byteSize: claim.firstMasterByteSize
          },
          lastMaster: {
            objectKey: claim.lastMasterObjectKey,
            sha256: claim.expectedLastMasterHash,
            byteSize: claim.lastMasterByteSize
          },
          outputObjectKey: ({ sha256 }) => createProjectObjectKey({
            projectId: claim.projectId,
            runId: claim.runId,
            objectClass: OBJECT_CLASSES.ACTION_VIDEO,
            actionId: claim.actionId,
            fileName: createProcessedArtifactFileName({
              sourceSha256: claim.sourceSha256,
              outputSha256: sha256,
              policyVersion: policy.version
            })
          }),
          outputContentType: "video/webm",
          beforeUpload: async () => {
            await heartbeat.renew();
            heartbeat.assertOwned();
          }
        }, async ({ inputPath, firstMasterPath, lastMasterPath, mattePath, outputPath, scratchDirectory }) => (
          this.mediaWorker.processAction({
            actionId: claim.actionId,
            inputPath,
            outputPath,
            mattePath,
            firstMasterPath,
            lastMasterPath,
            scratchDirectory,
            expectedFirstMasterHash: claim.expectedFirstMasterHash,
            expectedLastMasterHash: claim.expectedLastMasterHash,
            requestedDuration: claim.requestedDuration,
            referenceMetrics: claim.referenceMetrics,
            qaPolicy: policy,
            production: this.productionMode
          })
        ));
      } catch (error) {
        if (error && error.qa && error.qa.ok === false) {
          try {
            await heartbeat.renew();
            await this.repository.failVideoProcessingQa({
              jobId: input.jobId,
              leaseToken: claim.leaseToken,
              sourceAssetId: claim.sourceAssetId,
              qaReport: error.qa,
              policyVersion: policy.version,
              processorVersion: MEDIA_PROCESSOR_VERSION,
              errorCode: "action_qa_failed"
            });
          } catch (persistenceError) {
            return await this._releaseProcessingForRetry(input, claim, persistenceError);
          }
          return { status: "qa_failed", runId: input.runId, actionId: input.actionId };
        }
        return await this._releaseProcessingForRetry(input, claim, error);
      }

      try {
        await heartbeat.renew();
        const probeDigest = normalizeSha256(
          workspaceResult.operationResult?.probeResult?.checksumSha256,
          "Trusted processed action checksum"
        );
        if (probeDigest !== workspaceResult.artifact.sha256) {
          throw Object.assign(new Error("Processed action changed between trusted probe and private upload"), {
            code: "processed_action_integrity_mismatch"
          });
        }
        const saved = await this.repository.saveVideoProcessingResult({
          jobId: input.jobId,
          leaseToken: claim.leaseToken,
          sourceAssetId: claim.sourceAssetId,
          artifact: workspaceResult.artifact,
          qaReport: {
            ...workspaceResult.operationResult.qa,
            processing: {
              processorVersion: MEDIA_PROCESSOR_VERSION,
              policyVersion: policy.version,
              sourceSha256: claim.sourceSha256,
              outputSha256: workspaceResult.artifact.sha256,
              matteMode: workspaceResult.operationResult.matteMode
            }
          },
          policyVersion: policy.version,
          processorVersion: MEDIA_PROCESSOR_VERSION,
          finalizeJob: createActionJob({
            name: JOB_NAMES.FINALIZE_VIDEO_ACTION,
            claim,
            inputRevision: `${workspaceResult.artifact.sha256}:finalize`,
            attempts: 8
          })
        });
        claim.mediaAssetId = saved.mediaAssetId;
        await this._finalizeVideoAction(input, claim, heartbeat);
      } catch (error) {
        return await this._releaseProcessingForRetry(input, claim, error);
      }
      this.logger.info?.("petpack.worker.action_media_processed", { runId: input.runId, actionId: input.actionId });
      return { status: "processed", runId: input.runId, actionId: input.actionId };
    } finally {
      await heartbeat.stop();
    }
  }
}

module.exports = {
  ProductionJobWorker,
  RetryableProductionJobError,
  createLeaseBusyError,
  leaseBusyRetryAfterMs,
  MEDIA_PROCESSOR_VERSION,
  VIDEO_TASK_STATUS,
  classifyVideoTaskStatus,
  createActionJob,
  createProviderArtifactFileName,
  createProcessedArtifactFileName,
  createProviderRequestId,
  parseVideoJob,
  safeErrorCode
};
