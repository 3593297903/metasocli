import { z } from 'zod';
import { JobSchema, type Job } from '../contracts/job.js';
import { parse } from '../contracts/story.js';
import { fail, MetasoError, publicError } from '../core/errors.js';
import { loadPlan } from '../core/planning.js';
import { withProjectLock } from '../storage/locking.js';
import { ProviderError, TaskId, type Observation, type VideoClient } from '../metaso/client.js';
import { listJobs, persistence, readJob, saveEvidence } from './store.js';
import type { JobDependencies } from './submit.js';
import { downloadVideo, reconcileOutput } from './video.js';
import { operationKind, assertTaskIdAvailable } from './submission-guard.js';

const Options = z.object({
  maxPolls: z.number().int().min(1).max(720).default(60), pollIntervalMs: z.number().int().min(0).max(60000).default(5000),
  queryAttempts: z.number().int().min(1).max(5).default(3), retryBudgetMs: z.number().int().min(0).max(60000).default(30000),
  download: z.boolean().default(true), redownloadMissing: z.boolean().default(false), observeOnly: z.boolean().default(false),
}).strict();
type Options = z.infer<typeof Options>;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function queryWithRetry(client: VideoClient, taskId: string, options: Options, sleep: (ms: number) => Promise<void>): Promise<Observation> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try { return await client.query(taskId); }
    catch (error) {
      if (!(error instanceof ProviderError) || !error.options.retryable || attempt + 1 >= options.queryAttempts) throw error;
      const ms = Math.max(error.options.retryAfterMs ?? 0, 250 * 2 ** attempt);
      if (ms > options.retryBudgetMs - waited) throw new ProviderError('QUERY_DEFERRED', 'Provider retry delay exceeds this run budget; resume later.', { evidence: error.options.evidence });
      await sleep(ms); waited += ms;
    }
  }
}
/** Uses only the recorded task ID. Never invokes client.create or validates changed source inputs. */
export async function resume(root: string, operationId: string, deps: JobDependencies, input: Partial<Options> = {}): Promise<Job> {
  const options = parse(Options, input), disk = deps.persistence ?? persistence, sleep = deps.sleep ?? delay;
  return withProjectLock(root, async assertOwned => {
    if (await operationKind(root, operationId) !== 'video') fail('IR_NOT_VIDEO', 'IR tasks have text results, not downloadable videos.');
    const job = await readJob(root, operationId);
    if (!job.taskId) fail(job.status === 'prepared' ? 'NOT_SUBMITTED' : 'SUBMIT_UNKNOWN', 'No confirmed task ID. Recover the original task ID with attach-task; do not resubmit.');
    if (options.redownloadMissing && job.status === 'downloaded') { job.status = 'generated'; delete job.output; }
    const existing = await reconcileOutput(root, job);
    if (existing) { job.output = existing; job.status = 'downloaded'; delete job.lastError; job.updatedAt = new Date().toISOString(); await disk.job(root, job); return job; }
    if (['failed', 'cancelled'].includes(job.status)) return job;
    const plan = await loadPlan(root, job.planId), planned = plan.segments.find(s => s.segmentId === job.segmentId)!;
    for (let poll = 0; poll < options.maxPolls; poll++) {
      await assertOwned();
      let observed: Observation;
      try { observed = await queryWithRetry(deps.client, job.taskId, options, sleep); }
      catch (error) {
        if (error instanceof ProviderError && error.options.evidence) await saveEvidence(root, job, error.options.evidence);
        if (error instanceof ProviderError && error.code === 'QUERY_CONTRACT') job.status = 'query_unknown';
        job.lastError = error instanceof MetasoError ? publicError(error) : { code: 'QUERY_FAILED', message: 'Task query failed; resume this original task later.' };
        job.updatedAt = new Date().toISOString(); await disk.job(root, job); return job;
      }
      if (observed.taskId !== job.taskId) fail('QUERY_CONTRACT', 'Query returned a different task ID.');
      await saveEvidence(root, job, observed.evidence);
      job.rawStatus = observed.rawStatus; job.status = observed.status === 'unknown' ? 'query_unknown' : observed.status;
      delete job.lastError; job.updatedAt = new Date().toISOString();
      if (job.status === 'query_unknown') job.lastError = { code: 'QUERY_UNKNOWN', message: 'Provider returned an unrecognized task state; preserve evidence and query again later.' };
      if (job.status === 'generated' && ((observed.duration !== undefined && observed.duration !== planned.duration) || (observed.resolution !== undefined && observed.resolution !== planned.resolution) || (observed.ratio !== undefined && planned.effectiveRatio !== 'adaptive' && observed.ratio !== planned.effectiveRatio) || !observed.url)) {
        job.status = 'query_unknown'; job.lastError = { code: 'RESULT_METADATA', message: 'Generated result does not match the planned duration/resolution or lacks its URL.' };
      }
      await disk.job(root, parse(JobSchema, job)); // generated is durable before a download starts.
      if (job.status === 'generated' && options.download) {
        try { job.output = await downloadVideo(root, job, observed.url!, planned.duration, deps.fetcher, planned.effectiveRatio); }
        catch (error) {
          job.lastError = error instanceof MetasoError ? publicError(error) : { code: 'DOWNLOAD_FAILED', message: 'Video transfer was interrupted; resume download using the same task.' };
          job.updatedAt = new Date().toISOString(); await disk.job(root, job); return job;
        }
        job.status = 'downloaded'; job.updatedAt = new Date().toISOString();
        await disk.job(root, job); return job;
      }
      if (['generated', 'failed', 'cancelled', 'query_unknown'].includes(job.status)) return job;
      if (options.observeOnly) return job;
      if (poll + 1 < options.maxPolls) await sleep(options.pollIntervalMs);
    }
    job.lastError = { code: 'POLL_LIMIT', message: 'Polling budget ended. The remote task may still run; resume with its saved operation ID.' };
    await disk.job(root, job); return job;
  });
}
export async function attachTask(root: string, operationId: string, taskId: string, confirmedLink: boolean, deps: JobDependencies): Promise<Job> {
  if (!confirmedLink) fail('TASK_LINK_REQUIRED', 'Explicitly confirm that the recovered provider task ID belongs to this operation.');
  parse(TaskId, taskId);
  return withProjectLock(root, async () => {
    if (await operationKind(root, operationId) !== 'video') fail('IR_NOT_VIDEO', 'Use the IR task recovery entry for this operation.');
    const disk = deps.persistence ?? persistence, job = await readJob(root, operationId);
    if (job.taskId || job.status !== 'submit_unknown') fail('TASK_LINK_CONFLICT', 'Only an unresolved creation can acquire a manually recovered task ID.');
    await assertTaskIdAvailable(root, taskId, operationId);
    const observed = await queryWithRetry(deps.client, taskId, Options.parse({}), deps.sleep ?? delay);
    if (observed.taskId !== taskId) fail('QUERY_CONTRACT', 'Provider task identity mismatch.');
    await disk.receipt(root, { operationId, taskId, requestHash: job.requestHash, receivedAt: new Date().toISOString(), recoveredManually: true });
    job.taskId = taskId; job.status = 'queued'; delete job.lastError; job.updatedAt = new Date().toISOString();
    await disk.job(root, job); await saveEvidence(root, job, observed.evidence); await disk.job(root, job);
    return job;
  });
}
