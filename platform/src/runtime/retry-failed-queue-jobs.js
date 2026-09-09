/**
 * Retries queue jobs that BullMQ has given up on, for one production run.
 *
 * The pipeline is built so that a job either records its work in
 * production_job_execution or leaves nothing behind, and the queue's retries
 * cover the transient failures. Those two properties combine badly in one case:
 * when a claim transaction rolls back, no execution row survives, so once the
 * queue exhausts its attempts the run is left in a working state - `validating`
 * with no live job - that no disposal covers, because a disposal starts from
 * `failed` and nothing failed the run.
 *
 * That is what stranded the first delivered-pack redo after the build-lookup
 * fix: the validation claim had been rejecting a run with two builds, and by
 * the time the fix shipped the queue had already spent its attempts.
 *
 * Retrying is the narrowest possible intervention. It touches the queue only,
 * writes nothing to the database, and the retried job goes through the ordinary
 * claim path with all of its guards. It is not a rescue and grants nothing: use
 * it when a job failed for a reason that has since been fixed.
 *
 * `--stalled` additionally re-queues a job stuck in `active` - which is what a
 * worker being replaced mid-job leaves behind, since BullMQ has no worker left
 * to report the outcome. That one is only safe when the claim never committed,
 * so it is refused unless the database agrees: no production_job_execution row
 * for this run and job name. With no row there is no lease and no work to
 * duplicate; with a row, the ordinary lease expiry is the right recovery and
 * this tool must keep its hands off.
 *
 *   node src/runtime/retry-failed-queue-jobs.js --run <runId> [--job <name>] [--stalled] [--dry-run]
 */

const { createPostgresDatabase } = require("../persistence/postgres-database");
const { BullMqWorkflowQueue, loadBullMqConfig } = require("../queue/bullmq-workflow-queue");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

function usage() {
  return "usage: retry-failed-queue-jobs.js --run <runId> [--job <jobName>] [--stalled] [--dry-run]";
}

/** True when nothing in the database records this job ever being claimed. */
async function claimNeverCommitted(database, runId, jobName) {
  const result = await database.query(
    `SELECT 1 FROM production_job_execution
      WHERE run_id = $1 AND job_name = $2 AND action_id IS NULL`,
    [runId, jobName]
  );
  return !Array.isArray(result?.rows) || result.rows.length === 0;
}

function argument(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) return null;
  const value = String(argv[index + 1]).trim();
  return value ? value : null;
}

async function main({ argv = process.argv.slice(2), environment = process.env, logger = console } = {}) {
  const runId = argument(argv, "--run");
  if (!runId) throw new Error(usage());
  const jobName = argument(argv, "--job");
  const dryRun = argv.includes("--dry-run");
  const includeStalled = argv.includes("--stalled");

  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  const queue = new BullMqWorkflowQueue({ config: loadBullMqConfig(hydrated), logger });
  const database = includeStalled ? createPostgresDatabase({ environment: hydrated, logger }) : null;
  try {
    await queue.assertReady();
    if (database) await database.assertReady();
    const mine = (jobs) => jobs.filter((job) => job?.data?.runId === runId && (!jobName || job.name === jobName));

    const report = [];
    for (const job of mine(await queue.queue.getFailed(0, 500))) {
      report.push({ id: String(job.id), name: job.name, state: "failed", attemptsMade: job.attemptsMade, failedReason: job.failedReason });
      if (!dryRun) await job.retry();
    }
    if (includeStalled) {
      for (const job of mine(await queue.queue.getActive(0, 500))) {
        if (!await claimNeverCommitted(database, runId, job.name)) {
          throw new Error(`${job.name} has a production_job_execution row: let its lease expire instead of re-queueing`);
        }
        const entry = { id: String(job.id), name: job.name, state: "active", attemptsMade: job.attemptsMade, failedReason: job.failedReason };
        if (!dryRun) {
          // A new job ID, because the old one is the queue's dedupe key and the
          // stale job still owns it. Nothing in the database refers to it - the
          // check above is exactly that - so the claim binds cleanly to the new
          // one when the worker picks it up.
          const requeued = `${job.id}-requeue-${Date.now()}`;
          await job.remove({ removeChildren: false });
          await queue.queue.add(job.name, job.data, { ...job.opts, jobId: requeued, delay: 0 });
          entry.requeuedAs = requeued;
        }
        report.push(entry);
      }
    }
    const result = Object.freeze({ runId, dryRun, retried: dryRun ? 0 : report.length, jobs: report });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await queue.close().catch(() => undefined);
    if (database) await database.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`petpack.queue_retry.failed error=${error?.message || error?.name || "Error"}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
