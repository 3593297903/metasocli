import { z } from 'zod';
import { JobSchema, type Job } from '../contracts/job.js';
import { parse } from '../contracts/story.js';
import { fail, MetasoError, publicError } from '../core/errors.js';
import { loadPlan } from '../core/planning.js';
import { withProjectWrite, acquireLease } from '../storage/locking.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { projectPath } from '../storage/paths.js';
import { ProviderError, TaskId, type Observation, type VideoClient } from '../metaso/client.js';
import { persistence, readJob, saveEvidence } from './store.js';
import type { JobDependencies } from './submit.js';
import { downloadVideo, reconcileOutput } from './video.js';
import { operationKind, assertTaskIdAvailable } from './submission-guard.js';
import { terminal, reconcileRuntime, runtimeDirectory, withCoordinator } from './coordinator.js';

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
/** One GET (with bounded transport retries), then a version/identity checked short merge. */
async function observe(root: string, snapshot: Job, deps: JobDependencies, options: Options) {
  const disk = deps.persistence ?? persistence;
  const plan = await loadPlan(root, snapshot.planId), planned = plan.segments.find(s => s.segmentId === snapshot.segmentId)!;
  let observed: Observation | undefined, error: unknown;
  try {
    observed = await queryWithRetry(deps.client, snapshot.taskId!, options, deps.sleep ?? delay);
    if (observed.taskId !== snapshot.taskId) throw new ProviderError('QUERY_CONTRACT', 'Query returned a different task ID.', { evidence: observed.evidence });
  } catch (failure) { error = failure; }
  const job = await withProjectWrite(root, async () => {
    const current = await readJob(root, snapshot.operationId);
    if (canonicalSha256(current) !== canonicalSha256(snapshot)) return current; // A newer merge wins.
    if (error) {
      if (error instanceof ProviderError && error.options.evidence) await saveEvidence(root, current, error.options.evidence);
      if (error instanceof ProviderError && error.code === 'QUERY_CONTRACT' && !terminal(current.status)) current.status = 'query_unknown';
      current.lastError = error instanceof MetasoError ? publicError(error) : { code: 'QUERY_FAILED', message: 'Task query failed; resume this original task later.' };
    } else {
      const result = observed!;
      if (terminal(current.status) && result.status !== 'generated') return current; // Never regress a known terminal task.
      await saveEvidence(root, current, result.evidence);
      current.rawStatus = result.rawStatus; current.status = result.status === 'unknown' ? 'query_unknown' : result.status;
      delete current.lastError;
      if (current.status === 'query_unknown') current.lastError = { code: 'QUERY_UNKNOWN', message: 'Unrecognized task state; preserve its occupied slot and query again later.' };
      if (current.status === 'generated' && ((result.duration !== undefined && result.duration !== planned.duration)
        || (result.resolution !== undefined && result.resolution !== planned.resolution)
        || (result.ratio !== undefined && planned.effectiveRatio !== 'adaptive' && result.ratio !== planned.effectiveRatio) || !result.url)) {
        current.status = terminal(snapshot.status) ? snapshot.status : 'query_unknown';
        current.lastError = { code: 'RESULT_METADATA', message: 'Generated result does not match the planned duration/resolution or lacks its URL.' };
      }
    }
    current.updatedAt = new Date().toISOString();
    if (terminal(current.status)) await deps.checkpoint?.('terminal-before', current);
    await disk.job(root, parse(JobSchema, current));
    if (terminal(current.status)) await deps.checkpoint?.('terminal-saved', current);
    return current;
  });
  if (terminal(job.status)) await deps.checkpoint?.('release-before', job);
  await reconcileRuntime(root, deps.runtimeRoot);
  if (terminal(job.status)) await deps.checkpoint?.('released', job);
  return { job, url: !job.lastError && job.status === 'generated' && observed && observed.taskId === job.taskId && observed.status === 'generated' ? observed.url : undefined, planned };
}
/** Uses only the recorded task ID. No POST and no current source revalidation. */
export async function resume(root: string, operationId: string, deps: JobDependencies, input: Partial<Options> = {}): Promise<Job> {
  const options = parse(Options, input), disk = deps.persistence ?? persistence, sleep = deps.sleep ?? delay;
  if (await operationKind(root, operationId) !== 'video') fail('IR_NOT_VIDEO', 'IR tasks have text results, not downloadable videos.');
  // Only a downloader owns this per-operation lease. Query-only callers remain independent.
  const downloadLease = options.download ? await acquireLease(await projectPath(root, '.metasocli/downloads/' + operationId + '.lock')) : undefined;
  try {
    let job = await readJob(root, operationId);
    if (!job.taskId) fail(job.status === 'prepared' ? 'NOT_SUBMITTED' : 'SUBMIT_UNKNOWN', 'No confirmed task ID. Recover the original task ID; do not resubmit.');
    const forOutput = options.redownloadMissing && job.status === 'downloaded' ? { ...job, status: 'generated' as const, output: undefined } : job;
    const existing = await reconcileOutput(root, forOutput);
    if (existing) return withProjectWrite(root, async () => {
      const latest = await readJob(root, operationId); latest.output = existing; latest.status = 'downloaded'; delete latest.lastError;
      latest.updatedAt = new Date().toISOString(); await disk.job(root, latest); return latest;
    });
    if (options.redownloadMissing && job.status === 'downloaded') job = await withProjectWrite(root, async () => {
      const latest = await readJob(root, operationId); latest.status = 'generated'; delete latest.output;
      await disk.job(root, latest); return latest;
    });
    if (['failed', 'cancelled'].includes(job.status)) { await reconcileRuntime(root, deps.runtimeRoot); return job; }
    for (let poll = 0; poll < options.maxPolls; poll++) {
      const result = await observe(root, job, deps, options); job = result.job;
      if (job.status === 'generated' && options.download && result.url) {
        let output: Awaited<ReturnType<typeof downloadVideo>>;
        try {
          output = await downloadVideo(root, job, result.url, result.planned.duration, deps.fetcher, result.planned.effectiveRatio,
            work => withProjectWrite(root, async () => {
              await downloadLease!.assertOwned();
              const current = await readJob(root, operationId);
              if (current.taskId !== job.taskId || current.requestHash !== job.requestHash) fail('JOB_CONFLICT', 'Task changed before output commit.');
              return work();
            }), async point => deps.checkpoint?.(point, job));
        } catch (error) {
          return await withProjectWrite(root, async () => {
            const current = await readJob(root, operationId);
            if (current.status === 'downloaded') return current;
            current.lastError = error instanceof MetasoError ? publicError(error) : { code: 'DOWNLOAD_FAILED', message: 'Video transfer was interrupted; resume download using the same task.' };
            current.updatedAt = new Date().toISOString(); await disk.job(root, current); return current;
          });
        }
        return await withProjectWrite(root, async () => {
          const current = await readJob(root, operationId); current.output = output; current.status = 'downloaded';
          delete current.lastError; current.updatedAt = new Date().toISOString(); await disk.job(root, current); return current;
        });
      }
      if (terminal(job.status) || job.status === 'query_unknown' || job.lastError || options.observeOnly) return job;
      if (poll + 1 < options.maxPolls) await sleep(options.pollIntervalMs);
      job = await readJob(root, operationId);
    }
    return withProjectWrite(root, async () => {
      const current = await readJob(root, operationId);
      if (!terminal(current.status)) current.lastError = { code: 'POLL_LIMIT', message: 'Polling budget ended; resume the original task ID.' };
      await disk.job(root, current); return current;
    });
  } finally { await downloadLease?.release(); }
}
export async function attachTask(root: string, operationId: string, taskId: string, confirmedLink: boolean, deps: JobDependencies): Promise<Job> {
  if (!confirmedLink) fail('TASK_LINK_REQUIRED', 'Confirm that the recovered provider task belongs to this operation.');
  parse(TaskId, taskId);
  if (await operationKind(root, operationId) !== 'video') fail('IR_NOT_VIDEO', 'Use the IR task recovery entry.');
  const initial = await readJob(root, operationId);
  if (initial.taskId || initial.status !== 'submit_unknown') fail('TASK_LINK_CONFLICT', 'Only unresolved creation can acquire a recovered ID.');
  // Check known local IDs before any GET. Recheck under the shared lock when writing.
  await assertTaskIdAvailable(root, taskId, operationId);
  const observed = await queryWithRetry(deps.client, taskId, Options.parse({}), deps.sleep ?? delay);
  if (observed.taskId !== taskId) fail('QUERY_CONTRACT', 'Provider task identity mismatch.');
  const disk = deps.persistence ?? persistence;
  const job = await withCoordinator(root, runtimeDirectory(deps.runtimeRoot), async ledger => withProjectWrite(root, async () => {
    const current = await readJob(root, operationId);
    if (current.taskId || current.status !== 'submit_unknown') fail('TASK_LINK_CONFLICT', 'Task already recovered or no longer unknown.');
    if (ledger.slots.some(s => s.operationId !== operationId && s.taskId === taskId)) fail('TASK_LINK_CONFLICT', 'Task ID already registered in another project.');
    await assertTaskIdAvailable(root, taskId, operationId);
    await disk.receipt(root, { operationId, taskId, requestHash: current.requestHash, receivedAt: new Date().toISOString(), recoveredManually: true });
    current.taskId = taskId; current.status = 'queued'; delete current.lastError; current.updatedAt = new Date().toISOString();
    await disk.job(root, current); await saveEvidence(root, current, observed.evidence); await disk.job(root, current); return current;
  }));
  await reconcileRuntime(root, deps.runtimeRoot); return job;
}
