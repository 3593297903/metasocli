import { randomUUID } from 'node:crypto';
import { parse, Id } from '../contracts/story.js';
import { Receipt, type Job } from '../contracts/job.js';
import { fail, MetasoError } from '../core/errors.js';
import { loadPlan, validatePlan } from '../core/planning.js';
import { withProjectLock } from '../storage/locking.js';
import { sha256Hex } from '../storage/canonical.js';
import { ProviderError, type VideoClient, type Submission } from '../metaso/client.js';
import { fetchMedia, type Fetch } from '../metaso/transport.js';
import { MAX_AUDIO_BYTES } from '../assets/audio.js';
import { MAX_IMAGE_BYTES } from '../assets/image.js';
import { listJobs, persistence, saveEvidence, type Persistence } from './store.js';
import { assertTaskIdAvailable, checkSubmissionConflicts, operationKind } from './submission-guard.js';

export interface JobDependencies { client: VideoClient; fetcher?: Fetch; persistence?: Persistence; sleep?: (ms: number) => Promise<void> }
export async function submit(root: string, planId: string, segmentId: string, authorized: boolean, deps: JobDependencies, retryOf?: string): Promise<Job> {
  if (authorized !== true) fail('GENERATION_NOT_AUTHORIZED', 'Generation requires explicit authorization for this plan.');
  parse(Id, segmentId);
  const disk = deps.persistence ?? persistence;
  return withProjectLock(root, async assertOwned => {
    const plan = await loadPlan(root, planId), segment = plan.segments.find(s => s.segmentId === segmentId);
    if (plan.workflow?.stage === 'prepare') fail('IR_PREPARE_NOT_VIDEO', 'This is an IR preparation plan. Use context-ir --plan <id> --segment <id> --confirm, then review and derive a video plan.');
    if (!segment) fail('SEGMENT_MISSING', 'Segment is absent from the chosen plan.');
    const jobs = await listJobs(root);
    const related = jobs.filter(j => j.episodeId === plan.episodeId && j.segmentId === segmentId);
    const matching = related.filter(j => j.inputHash === segment.inputHash);
    let previous = matching.at(-1);
    if (retryOf) {
      const repeatedRetry = jobs.find(j => j.retryOf === retryOf);
      if (repeatedRetry) {
        if (repeatedRetry.inputHash !== segment.inputHash || !related.includes(repeatedRetry)) fail('RETRY_CONFLICT', 'Retry belongs to a different request.');
        await operationKind(root, repeatedRetry.operationId);
        return repeatedRetry;
      }
      if (!previous || previous.operationId !== retryOf || !['failed', 'cancelled'].includes(previous.status)) fail('RETRY_FORBIDDEN', 'Only the latest definitively failed or cancelled attempt can be explicitly regenerated.');
    } else if (previous && previous.status !== 'prepared') { await operationKind(root, previous.operationId); return previous; }
    await checkSubmissionConflicts(root, plan.episodeId, segmentId);
    if (jobs.some(j => j.status === 'submit_unknown')) fail('SUBMIT_UNKNOWN', 'An earlier creation has an unknown result. Recover its task ID before any new generation.');
    if (related.some(j => !['failed', 'cancelled', 'downloaded', 'prepared'].includes(j.status))) fail('JOB_ACTIVE', 'This segment already has an unfinished task; resume it.');
    const { story, built } = await validatePlan(root, plan);
    const selected = built.find(b => b.summary.segmentId === segmentId)!;
    // Public URLs are mutable; compare current remote bytes before committing paid intent.
    for (const ref of selected.summary.assets.filter(a => a.transport === 'url')) {
      const media = story.assets.find(a => a.recipe.assetId === ref.assetId)!.media!;
      if (sha256Hex(await fetchMedia(media.url!, ref.role === 'reference_audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES, deps.fetcher)) !== ref.sha256) fail('REMOTE_ASSET_CHANGED', 'Public reference bytes changed; re-register and replan.');
    }
    const now = new Date().toISOString();
    const job: Job = !retryOf && previous?.status === 'prepared' ? previous : {
      schemaVersion: 1, operationId: randomUUID(), projectId: plan.projectId, planId: plan.planId, planHash: plan.planHash,
      episodeId: plan.episodeId, segmentId, revision: plan.revision, requestHash: segment.requestHash, inputHash: segment.inputHash,
      attempt: (previous?.attempt ?? 0) + 1, ...(retryOf ? { retryOf } : {}), status: 'prepared', createdAt: now, updatedAt: now,
    };
    await disk.job(root, job);
    await operationKind(root, job.operationId);
    job.status = 'submitting'; job.submittedAt = new Date().toISOString(); job.updatedAt = job.submittedAt;
    await disk.job(root, job); // Must durably precede the ONE create call.
    await assertOwned();
    let receipt: Submission;
    try {
      receipt = await deps.client.create(selected.request);
      parse(Receipt, { operationId: job.operationId, requestHash: job.requestHash, taskId: receipt.taskId, receivedAt: new Date().toISOString() });
    } catch (error) {
      job.status = error instanceof ProviderError && error.options.rejected ? 'failed' : 'submit_unknown';
      job.lastError = { code: job.status === 'failed' ? 'CREATE_REJECTED' : 'SUBMIT_UNKNOWN', message: job.status === 'failed' ? 'Provider rejected creation. A new paid attempt requires explicit retry.' : 'Creation result is unknown. Do not resubmit; reconcile the remote task ID.' };
      job.updatedAt = new Date().toISOString();
      await disk.job(root, job);
      if (error instanceof ProviderError && error.options.evidence) { await saveEvidence(root, job, error.options.evidence); await disk.job(root, job); }
      return job;
    }
    try {
      await assertTaskIdAvailable(root, receipt.taskId, job.operationId);
      await disk.receipt(root, { operationId: job.operationId, requestHash: job.requestHash, taskId: receipt.taskId, receivedAt: new Date().toISOString(), recoveredManually: false });
      job.taskId = receipt.taskId; job.status = 'queued'; job.updatedAt = new Date().toISOString();
      await disk.job(root, job);
    } catch {
      // Preserve task ID in a controlled diagnostic for manual reconciliation; never try create again.
      throw new MetasoError('RECEIPT_PERSISTENCE', `Receipt save failed. Operation ${job.operationId}, remote task ${receipt.taskId}. Preserve these IDs and use attach-task/resume.`);
    }
    await saveEvidence(root, job, receipt.evidence); await disk.job(root, job);
    return job;
  });
}
