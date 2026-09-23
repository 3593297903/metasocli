import { randomUUID } from 'node:crypto';
import { parse, Id } from '../contracts/story.js';
import { Receipt, type Job } from '../contracts/job.js';
import { fail, MetasoError } from '../core/errors.js';
import { loadPlan, validatePlan } from '../core/planning.js';
import { withProjectWrite, acquireLease, type Lease } from '../storage/locking.js';
import { ProviderError, type VideoClient, type Submission } from '../metaso/client.js';
import type { Fetch } from '../metaso/transport.js';
import { listJobs, readJob, persistence, saveEvidence, type Persistence } from './store.js';
import { assertTaskIdAvailable, checkSubmissionConflicts, operationKind, verifyRemoteAssets } from './submission-guard.js';
import { occupied, unsafeSlots, runtimeDirectory, withCoordinator, reconcileRuntime, requireScheduler, slotFor } from './coordinator.js';
import { saveSubmissionOwner, submissionLeasePath } from './submission-owner.js';
import { projectPath } from '../storage/paths.js';
import { writeJson } from '../storage/io.js';

export interface JobDependencies {
  client: VideoClient; fetcher?: Fetch; persistence?: Persistence; sleep?: (ms: number) => Promise<void>;
  runtimeRoot?: string; schedulerToken?: string; capacity?: number;
  checkpoint?: (event: string, job: Job) => Promise<void>;
}
function choose(jobs: Job[], episodeId: string, segmentId: string, inputHash: string, retryOf?: string) {
  const related = jobs.filter(j => j.episodeId === episodeId && j.segmentId === segmentId);
  const previous = related.filter(j => j.inputHash === inputHash).at(-1);
  if (retryOf) {
    const repeated = jobs.find(j => j.retryOf === retryOf);
    if (repeated) {
      if (repeated.inputHash !== inputHash || !related.includes(repeated)) fail('RETRY_CONFLICT', 'Retry belongs to a different request.');
      return { previous: repeated, reuse: true };
    }
    if (!previous || previous.operationId !== retryOf || !['failed', 'cancelled'].includes(previous.status)) fail('RETRY_FORBIDDEN', 'Only the latest definitively failed or cancelled attempt can be explicitly regenerated.');
  }
  return { previous, reuse: !retryOf && !!previous && previous.status !== 'prepared' };
}
/** Persist/reserve under short locks, POST exactly once outside locks, persist receipt before indexing. */
export async function submit(root: string, planId: string, segmentId: string, authorized: boolean, deps: JobDependencies, retryOf?: string): Promise<Job> {
  if (authorized !== true) fail('GENERATION_NOT_AUTHORIZED', 'Generation requires explicit authorization for this plan.');
  parse(Id, segmentId);
  const disk = deps.persistence ?? persistence, runtime = runtimeDirectory(deps.runtimeRoot);
  const plan = await loadPlan(root, planId), segment = plan.segments.find(s => s.segmentId === segmentId);
  if (plan.workflow?.stage === 'prepare') fail('IR_PREPARE_NOT_VIDEO', 'This is an IR preparation plan; derive a video plan before video submission.');
  if (!segment) fail('SEGMENT_MISSING', 'Segment is absent from the chosen plan.');
  const initial = choose(await listJobs(root), plan.episodeId, segmentId, segment.inputHash, retryOf);
  if (initial.reuse) {
    await operationKind(root, initial.previous!.operationId);
    if (initial.previous!.status === 'submitting') fail('LOCK_BUSY', 'This request is still owned by its submitting process.');
    await reconcileRuntime(root, runtime); return initial.previous!;
  }
  // Network reference validation is outside project/shared locks. Rebuild locally again when reserving.
  const preflight = await validatePlan(root, plan);
  await verifyRemoteAssets(preflight.story, preflight.built.find(b => b.summary.segmentId === segmentId)!.summary.assets, deps.fetcher);
  let owner: Lease | undefined;
  try {
    const prepared = await withCoordinator(root, runtime, async (ledger, save) => withProjectWrite(root, async () => {
      await requireScheduler(runtime, deps.schedulerToken);
      const jobs = await listJobs(root), selected = choose(jobs, plan.episodeId, segmentId, segment.inputHash, retryOf);
      if (selected.reuse) {
        if (selected.previous!.status === 'submitting') fail('LOCK_BUSY', 'This request is still submitting.');
        return { job: selected.previous! };
      }
      await checkSubmissionConflicts(root, plan.episodeId, segmentId);
      if (unsafeSlots(ledger).length) fail('SUBMIT_UNKNOWN', 'Shared capacity contains an unknown task; recover it before creating.');
      const previous = selected.previous;
      const held = !retryOf && previous?.status === 'prepared' ? ledger.slots.find(s => s.operationId === previous.operationId) : undefined;
      const capacity = deps.capacity ?? 4;
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4) fail('CAPACITY_INVALID', 'Video capacity must be 1–4.');
      if (occupied(ledger).length - (held ? 1 : 0) >= capacity) fail('CAPACITY_FULL', 'Remote video slots are occupied; query existing tasks first.');
      const { built } = await validatePlan(root, plan), request = built.find(b => b.summary.segmentId === segmentId)!.request;
      const now = new Date().toISOString();
      const job: Job = !retryOf && previous?.status === 'prepared' ? previous : {
        schemaVersion: 1, operationId: randomUUID(), projectId: plan.projectId, planId: plan.planId, planHash: plan.planHash,
        episodeId: plan.episodeId, segmentId, revision: plan.revision, requestHash: segment.requestHash, inputHash: segment.inputHash,
        attempt: (previous?.attempt ?? 0) + 1, ...(retryOf ? { retryOf } : {}), status: 'prepared', createdAt: now, updatedAt: now,
      };
      await disk.job(root, job); await operationKind(root, job.operationId);
      owner = await acquireLease(await submissionLeasePath(root, job.operationId));
      await saveSubmissionOwner(root, job, owner.token, runtime);
      const index = ledger.slots.findIndex(s => s.operationId === job.operationId);
      const slot = { ...slotFor(root, job), status: 'reserved' as const };
      if (index < 0) ledger.slots.push(slot); else ledger.slots[index] = slot;
      await save(); await deps.checkpoint?.('reserved', job);
      job.status = 'submitting'; job.submittedAt = new Date().toISOString(); job.updatedAt = job.submittedAt;
      await disk.job(root, job); await deps.checkpoint?.('intent', job);
      return { job, request };
    }));
    if (!prepared.request) return prepared.job;
    const job = prepared.job;
    await owner!.assertOwned();
    let receipt: Submission;
    try {
      receipt = await deps.client.create(prepared.request);
      parse(Receipt, { operationId: job.operationId, requestHash: job.requestHash, taskId: receipt.taskId, receivedAt: new Date().toISOString() });
    } catch (error) {
      const failed = await withProjectWrite(root, async () => {
        await owner!.assertOwned();
        const current = await readJob(root, job.operationId);
        current.status = error instanceof ProviderError && error.options.rejected ? 'failed' : 'submit_unknown';
        current.lastError = { code: current.status === 'failed' ? 'CREATE_REJECTED' : 'SUBMIT_UNKNOWN', message: current.status === 'failed' ? 'Provider explicitly rejected creation.' : 'Creation result is unknown. Recover the original task ID; do not resubmit.' };
        if (error instanceof ProviderError) {
          await writeJson(await projectPath(root, '.metasocli/receipts/' + job.operationId + '-create-error.json'), {
            operationId: job.operationId, requestHash: job.requestHash, httpStatus: error.options.httpStatus ?? null,
            safeToRetry: error.options.safeToRetry === true, retryAfterMs: error.options.retryAfterMs ?? 0,
          });
          if (error.options.evidence) await saveEvidence(root, current, error.options.evidence);
        }
        current.updatedAt = new Date().toISOString(); await disk.job(root, current); return current;
      });
      await reconcileRuntime(root, runtime);
      return failed;
    }
    try {
      await withCoordinator(root, runtime, async ledger => withProjectWrite(root, async () => {
        await owner!.assertOwned();
        if (ledger.slots.some(s => s.operationId !== job.operationId && s.taskId === receipt.taskId)) fail('TASK_LINK_CONFLICT', 'Remote task ID is already registered to another project.');
        await assertTaskIdAvailable(root, receipt.taskId, job.operationId);
        await disk.receipt(root, { operationId: job.operationId, requestHash: job.requestHash, taskId: receipt.taskId, receivedAt: new Date().toISOString(), recoveredManually: false });
        await deps.checkpoint?.('receipt', job);
        job.taskId = receipt.taskId; job.status = 'queued'; job.updatedAt = new Date().toISOString();
        await disk.job(root, job); await saveEvidence(root, job, receipt.evidence); await disk.job(root, job);
      }));
    } catch {
      throw new MetasoError('RECEIPT_PERSISTENCE', 'Receipt save failed. Operation ' + job.operationId + ', remote task ' + receipt.taskId + '. Preserve these IDs and use attach-task/resume.');
    }
    await reconcileRuntime(root, runtime);
    return job;
  } finally { await owner?.release(); }
}
