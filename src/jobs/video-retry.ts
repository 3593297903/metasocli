import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { parse } from '../contracts/story.js';
import { VideoRetry, type VideoRetryAuthorization } from '../contracts/video-retry.js';
import type { Job } from '../contracts/job.js';
import { fail } from '../core/errors.js';
import { loadPlan, validatePlan } from '../core/planning.js';
import { exists, projectPath, samePath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { withProjectWrite } from '../storage/locking.js';
import { listJobs, readJob, persistence, jobPath } from './store.js';
import { runtimeDirectory, inspectRuntime } from './coordinator.js';

export const retryPath = (root: string, old: string) => projectPath(root, '.metasocli/video-retries/' + parse(z.uuid(), old) + '.json');
export const effectiveJobs = (jobs: Job[]) => jobs.filter(j => !(j.status === 'cancelled' && j.lastError?.code === 'RETRY_SUPERSEDED'));
export function retryJob(a: VideoRetryAuthorization, revision: number): Job {
  return { schemaVersion: 1, operationId: a.newOperationId, projectId: a.projectId, planId: a.planId, planHash: a.planHash,
    episodeId: a.episodeId, segmentId: a.segmentId, revision, requestHash: a.requestHash, inputHash: a.inputHash,
    attempt: a.attempt, retryOf: a.oldOperationId, status: 'prepared', createdAt: a.authorizedAt, updatedAt: a.authorizedAt };
}
export type PlannedRequest = Pick<Job, 'projectId'|'planId'|'planHash'|'episodeId'|'segmentId'|'inputHash'|'requestHash'>;
export function samePlannedRequest(a: PlannedRequest, b: PlannedRequest) {
  return a.projectId === b.projectId && a.planId === b.planId && a.planHash === b.planHash
    && a.episodeId === b.episodeId && a.segmentId === b.segmentId && a.inputHash === b.inputHash && a.requestHash === b.requestHash;
}
export function verifyRetryOriginal(a: VideoRetryAuthorization, original: Job) {
  if (a.oldOperationId !== original.operationId || a.newOperationId === original.operationId || a.attempt !== original.attempt + 1
    || a.projectId !== original.projectId || a.episodeId !== original.episodeId || a.segmentId !== original.segmentId
    || a.inputHash !== original.inputHash || a.requestHash !== original.requestHash)
    fail('RETRY_CONFLICT', 'Retry authorization conflicts with original operation '+original.operationId);
}
export function verifyRetryChild(a: VideoRetryAuthorization, child: Job) {
  if (child.operationId !== a.newOperationId || child.retryOf !== a.oldOperationId || child.attempt !== a.attempt
    || child.createdAt !== a.authorizedAt || !samePlannedRequest(child, a) || (child.status === 'prepared' && (child.submittedAt || child.taskId)))
    fail('RETRY_CONFLICT', 'Retry attempt differs from its saved authorization: '+a.newOperationId);
}
export async function readVideoRetry(root: string, old: string, runtime?: string): Promise<VideoRetryAuthorization | undefined> {
  const file = await retryPath(root, old);
  if (!await exists(file)) return undefined;
  const a = parse(VideoRetry, await readJson(file)), { hash, ...base } = a;
  const original = await readJob(root, old), plan = await loadPlan(root, a.planId), s = plan.segments.find(s => s.segmentId === a.segmentId);
  verifyRetryOriginal(a,original);
  if (canonicalSha256(base) !== hash || a.projectId !== plan.projectId || a.planHash !== plan.planHash
    || a.episodeId !== plan.episodeId || a.inputHash !== s?.inputHash || a.requestHash !== s?.requestHash
    || s?.contextIr !== true || plan.workflow?.stage !== 'inline-video'
    || (runtime && !samePath(a.runtimeRoot, runtime))) fail('RETRY_CONFLICT', 'Retry authorization identity, runtime or immutable request changed.');
  if (await exists(await jobPath(root, a.newOperationId))) {
    verifyRetryChild(a,await readJob(root, a.newOperationId));
  }
  return a;
}
export async function listVideoRetries(root: string, runtime?: string) {
  const dir = await projectPath(root, '.metasocli/video-retries');
  if (!await exists(dir)) return [];
  const result: VideoRetryAuthorization[] = [];
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.json'))) result.push((await readVideoRetry(root, file.slice(0, -5), runtime))!);
  return result;
}
/** A missing Job is recoverable only at the authorization-only checkpoint. */
async function hasRetrySubmissionEvidence(root:string,a:VideoRetryAuthorization) {
  const id=a.newOperationId;
  for(const relative of ['receipts/'+id+'.json','receipts/'+id+'-create-error.json','submissions/'+id+'.json','submissions/'+id+'.lock']){
    if(await exists(await projectPath(root,'.metasocli/'+relative)))return true;
  }
  return (await inspectRuntime(a.runtimeRoot)).slots.some(s=>s.operationId===id);
}
/** Read-only proof that this unknown-result grant never started a new request. */
export async function supersededRetry(root: string, a: VideoRetryAuthorization) {
  if (!(await readJob(root, a.oldOperationId)).taskId) return false;
  if (await exists(await jobPath(root, a.newOperationId))) {
    const child = await readJob(root, a.newOperationId);
    return child.status === 'cancelled' && child.lastError?.code === 'RETRY_SUPERSEDED' && !child.submittedAt && !child.taskId;
  }
  // An authorization-only crash may never have written B. Missing submission evidence
  // is required as well; an absent job alone is never permission for another POST.
  return !await hasRetrySubmissionEvidence(root,a);
}
/** The caller owns the project write lock. Never reset submitted/unknown attempts. */
export async function materializeRetry(root: string, a: VideoRetryAuthorization, checkpoint?: (event: string, job: Job) => Promise<void>) {
  const plan = await loadPlan(root, a.planId);
  let child = await exists(await jobPath(root, a.newOperationId)) ? await readJob(root, a.newOperationId) : undefined;
  const old = await readJob(root, a.oldOperationId);
  if(!child && await hasRetrySubmissionEvidence(root,a))fail('RETRY_CONFLICT','Missing retry '+a.newOperationId+' has submission evidence. Restore its record; never resend.');
  if (old.taskId && (!child || (child.status === 'prepared' && !child.submittedAt))) {
    if (child) {
      child.status = 'cancelled'; child.updatedAt = new Date().toISOString();
      child.lastError = { code: 'RETRY_SUPERSEDED', message: 'Original receipt recovered before this new attempt started; recover the original task.' };
      await persistence.job(root, child);
    }
    return old;
  }
  if (child) return child.lastError?.code === 'RETRY_SUPERSEDED' ? old : child;
  // Only the authorization checkpoint may lack a job. Any other descendant is a conflict.
  const jobs = await listJobs(root);
  if (jobs.some(j => j.retryOf === a.oldOperationId || (j.episodeId === a.episodeId && j.segmentId === a.segmentId && j.inputHash === a.inputHash && j.attempt >= a.attempt))) fail('RETRY_CONFLICT', 'Reserved retry identity is missing but another attempt exists.');
  if (old.status !== 'submit_unknown' || old.taskId) fail('RETRY_FORBIDDEN', 'Original no-ID unknown condition no longer holds.');
  child = retryJob(a, plan.revision);
  await persistence.job(root, child); await checkpoint?.('retry-job', child);
  return child;
}
/** No key or network access. Saving this authorization does not reserve or release capacity. */
export async function authorizeVideoRetry(root: string, planId: string, segmentId: string, old: string, confirmed: boolean, accepted: boolean,
  runtime?: string, checkpoint?: (event: string, job: Job) => Promise<void>,
  linkLocked?: (authorization:VideoRetryAuthorization)=>Promise<void>) {
  if (!confirmed || !accepted) fail('GENERATION_NOT_AUTHORIZED', 'A no-ID video retry needs explicit one-attempt authorization and --accept-unknown-result.');
  parse(z.uuid(), old);
  return withProjectWrite(root, async () => {
    const plan = await loadPlan(root, planId), segment = plan.segments.find(s => s.segmentId === segmentId);
    if (plan.workflow?.stage !== 'inline-video' || segment?.contextIr !== true) fail('INLINE_IR_REQUIRED', 'Unknown-result retries require the original inline-IR request.');
    const saved = await readVideoRetry(root, old, runtimeDirectory(runtime));
    if (saved) {
      if (saved.planId !== planId || saved.segmentId !== segmentId) fail('RETRY_CONFLICT', 'This authorization belongs to another plan or segment.');
      await linkLocked?.(saved);
      return { authorization: saved, job: await materializeRetry(root, saved, checkpoint) };
    }
    const jobs = await listJobs(root), original = jobs.find(j => j.operationId === old);
    const latest = effectiveJobs(jobs).filter(j => j.episodeId === plan.episodeId && j.segmentId === segmentId).at(-1);
    if (!original || latest?.operationId !== old || original.projectId !== plan.projectId || original.inputHash !== segment.inputHash
      || original.requestHash !== segment.requestHash || original.status !== 'submit_unknown' || original.taskId) fail('RETRY_FORBIDDEN', 'Only the latest matching submit_unknown attempt without taskId may receive a new authorization.');
    await validatePlan(root, plan);
    const base = { schemaVersion: 1 as const, projectId: plan.projectId, runtimeRoot: runtimeDirectory(runtime), oldOperationId: old, newOperationId: randomUUID(),
      planId, planHash: plan.planHash, episodeId: plan.episodeId, segmentId, requestHash: segment.requestHash, inputHash: segment.inputHash,
      authorizedAt: new Date().toISOString(), maxNewAttempts: 1 as const, acceptUnknownResult: true as const, attempt: original.attempt + 1 };
    const authorization = parse(VideoRetry, { ...base, hash: canonicalSha256(base) });
    await writeJson(await retryPath(root, old), authorization);
    await linkLocked?.(authorization);
    await checkpoint?.('retry-authorization', retryJob(authorization, plan.revision));
    return { authorization, job: await materializeRetry(root, authorization, checkpoint) };
  });
}
export async function retryProgress(root: string, a: VideoRetryAuthorization) {
  const slots = (await inspectRuntime(a.runtimeRoot)).slots;
  const old = await readJob(root, a.oldOperationId);
  const job = await exists(await jobPath(root, a.newOperationId)) ? await readJob(root, a.newOperationId) : undefined;
  const phase = (!job || job.status === 'prepared') && old.taskId ? 'original_recovered'
    : job?.lastError?.code === 'RETRY_SUPERSEDED' ? 'original_recovered'
    : !job || job.status === 'prepared' ? slots.some(s => s.operationId === a.newOperationId) ? 'reserved' : 'waiting_capacity'
    : job.status === 'submitting' ? 'intent_saved' : job.taskId ? 'receipt_saved' : job.status;
  return { ...a, phase, ...(job ? { job } : {}), originalTaskId: old.taskId, oldStillUnknown: old.status === 'submit_unknown' && !old.taskId };
}
