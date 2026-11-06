import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { batchPath, batchHeader, scopedEvidence } from './batch-evidence.js';
export { batchPath } from './batch-evidence.js';
import { parse, type Story } from '../contracts/story.js';
import type { Job, SavedOutput } from '../contracts/job.js';
import { BatchPlan, BatchRun, Selection, type VideoBatchPlan, type VideoBatchRun } from '../contracts/batch.js';
import { createPlan, loadPlan } from '../core/planning.js';
import { loadStory } from '../core/project.js';
import { fail, publicError, isCode } from '../core/errors.js';
import { readJson, writeJson } from '../storage/io.js';
import { projectPath, exists } from '../storage/paths.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { withProjectWrite } from '../storage/locking.js';
import { jobPath, listJobs, readJob, receiptPath } from './store.js';
import { listIrOperations } from './context-ir-store.js';
import { outputVersion, localVideoIssue, reconcileOutput } from './video.js';
import { listVideoRetries, readVideoRetry, retryProgress, supersededRetry } from './video-retry.js';
export async function loadBatch(root: string, id: string) {
  const plan=await batchHeader(root,id);
  const loaded = new Map<string, Awaited<ReturnType<typeof loadPlan>>>();
  for(const item of plan.items){
    let parent = loaded.get(item.planId);
    if (!parent) {
      try{parent=await loadPlan(root,item.planId);}
      catch(error){
        if(isCode(error,'ENOENT'))fail('VIDEO_SCOPE_UNVERIFIABLE','Missing parent '+item.planId+' of batch '+id);
        throw error;
      }
      loaded.set(item.planId,parent);
    }
    const segment = parent.segments.find(s => s.segmentId === item.segmentId);
    if (parent.workflow?.stage !== 'inline-video' || parent.projectId !== item.projectId || parent.episodeId !== item.episodeId
      || parent.planHash !== item.planHash || segment?.contextIr !== true || segment.requestHash !== item.requestHash || segment.inputHash !== item.inputHash) fail('BATCH_TAMPERED', 'Batch item differs from its immutable inline plan.');
  }
  return plan;
}
export async function loadBatchRun(root: string, plan: VideoBatchPlan): Promise<VideoBatchRun | undefined> {
  const file = await batchPath(root, plan.batchId, 'run');
  if (!await exists(file)) return undefined;
  const run = parse(BatchRun, await readJson(file)), { hash, ...base } = run;
  if (canonicalSha256(base) !== hash || run.batchId !== plan.batchId || run.batchHash !== plan.batchHash || run.authorization.batchHash !== plan.batchHash
    || run.items.length !== plan.items.length || run.items.some((i, index) => i.order !== index)) fail('BATCH_RUN_TAMPERED', 'Run authorization or index does not match this batch.');
  if (run.authorization.retryOnly) {
    const retries = (await scopedEvidence(root,plan,run)).retries, ids = run.authorization.retryOnly;
    if (new Set(ids).size !== ids.length || ids.some(id => !retries.some(a => a.newOperationId === id
      && plan.items.some(i => i.planId === a.planId && i.segmentId === a.segmentId && i.inputHash === a.inputHash && i.requestHash === a.requestHash)))) {
      fail('BATCH_RUN_TAMPERED', 'Restricted batch scope lacks its exact one-attempt authorization.');
    }
  }
  for(const choice of run.trace.filter(t=>t.event==='batch-retry-linked')){
    const item=plan.items[choice.order??-1];
    if(!item || !choice.operationId || !choice.detail || run.authorization.retryOnly && !run.authorization.retryOnly.includes(choice.operationId))
      fail('BATCH_RUN_TAMPERED','Retry choice exceeds the batch scope: '+plan.batchId);
    const original=await readJob(root,choice.detail);
    if(!matchesItem(original,item))fail('BATCH_RUN_TAMPERED','Retry parent does not match its batch item: '+choice.detail);
    const grant=await readVideoRetry(root,choice.detail);
    const later=run.trace.slice(run.trace.indexOf(choice)+1).some(t=>t.event==='batch-retry-linked' && t.order===choice.order && t.detail===choice.detail);
    if(later && !await exists(await jobPath(root,choice.operationId)) &&
      !(grant?.newOperationId===choice.operationId && await supersededRetry(root,grant)))
      fail('RETRY_CONFLICT','Cannot prove historical missing attempt '+choice.operationId);
    if(grant?.newOperationId===choice.operationId){
      if(original.taskId && !await exists(await jobPath(root,choice.operationId)) && !await supersededRetry(root,grant))
        fail('RETRY_CONFLICT','Missing retry has submission evidence: '+choice.operationId);
      if(grant.planId!==item.planId || grant.planHash!==item.planHash)fail('RETRY_CONFLICT','Wrong parent for retry grant '+choice.operationId);
    }else if(run.authorization.retryOnly || !['failed','cancelled'].includes(original.status) || grant && !await supersededRetry(root,grant))
      fail('RETRY_CONFLICT','Missing or conflicting one-attempt grant for '+choice.operationId);
  }
  return run;
}
export async function writeBatchRunLocked(root: string, run: VideoBatchRun) {
  const file = await batchPath(root, run.batchId, 'run');
  if (await exists(file)) {
    const previous = parse(BatchRun, await readJson(file)), {hash,...base}=previous;
    if (hash !== canonicalSha256(base) || hash !== run.hash || previous.batchHash !== run.batchHash) fail('BATCH_RUN_CONFLICT','Batch run changed during update: '+run.batchId);
  } else if (run.hash !== '0'.repeat(64)) fail('BATCH_RUN_CONFLICT','Batch run disappeared: '+run.batchId);
  const { hash: _, ...previous } = run;
  const base={...previous,updatedAt:new Date().toISOString()};
  const snapshot=parse(BatchRun,{...base,hash:canonicalSha256(base)});
  await writeJson(file,snapshot);
  run.updatedAt=snapshot.updatedAt;
  run.hash=snapshot.hash;
}
export function saveBatchRun(root:string, run:VideoBatchRun) {
  return withProjectWrite(root,()=>writeBatchRunLocked(root,run));
}

type Item = VideoBatchPlan['items'][number];
export function matchesItem(job:Job,item:Item) {
  return job.projectId===item.projectId && job.episodeId===item.episodeId && job.segmentId===item.segmentId
    && job.requestHash===item.requestHash && job.inputHash===item.inputHash;
}
/** Input equivalence permits initial reuse. Only a durable batch choice can move an existing binding. */
export function batchItemJob(item:Item, run:VideoBatchRun|undefined, jobs:Job[]):Job|undefined {
  const conflict=jobs.find(j=>j.episodeId===item.episodeId && j.segmentId===item.segmentId && j.inputHash===item.inputHash && !matchesItem(j,item));
  if(conflict)fail('BATCH_OPERATION_CONFLICT','Input equivalence disagrees with request identity '+conflict.operationId);
  const candidates=jobs.filter(j=>matchesItem(j,item));
  const own=(j:Job)=>j.planId===item.planId && j.planHash===item.planHash;
  const exact=(id:string)=>{
    const job=candidates.find(j=>j.operationId===id);
    if(!job)fail('BATCH_RUN_TAMPERED','Missing or conflicting batch operation '+id);
    return job;
  };
  const links=run?.trace.filter(t=>t.order===item.order && t.event==='batch-retry-linked')??[];
  const index=run?.items[item.order];
  const creates=run?.trace.filter(t=>t.order===item.order && t.event==='create-result' && t.operationId)??[];
  const observed=creates[0]?.operationId;
  // The hashed creation history can reconstruct a lost index, and detects an index
  // redirected to a different, independently valid operation with identical inputs.
  const reachable=new Set<string>();
  if(observed){
    reachable.add(exact(observed).operationId);
    for(const event of run!.trace.filter(t=>t.order===item.order)){
      if(!event.operationId)continue;
      if(event.event==='batch-retry-linked' && event.detail && reachable.has(event.detail))reachable.add(event.operationId);
      if(event.event==='create-result'){
        const next=exact(event.operationId);
        if(next.retryOf && reachable.has(next.retryOf) && own(next) &&
          (index?.retryHistory.includes(next.retryOf) || run!.authorization.retryOnly?.includes(next.operationId)
          || run!.trace.some(t=>t.event==='dispatch' && t.order===item.order && t.operationId===next.operationId)))reachable.add(next.operationId);
      }
    }
    if(index?.operationId && !reachable.has(index.operationId)){
      const original=exact(observed);
      if(!(original.retryOf===index.operationId && original.lastError?.code==='RETRY_SUPERSEDED'))
        fail('BATCH_RUN_TAMPERED','Index '+index.operationId+' conflicts with recorded creation '+observed);
    }
  }
  let job:Job|undefined;
  if(index?.operationId) job=exact(index.operationId);
  else if(observed)job=exact(creates.findLast(t=>reachable.has(t.operationId!))!.operationId!);
  else {
    const ownJobs=candidates.filter(own);
    const roots=ownJobs.filter(j=>!j.retryOf);
    const choices=roots.length?roots:ownJobs.length?ownJobs:candidates;
    if(choices.length>1)fail('BATCH_OPERATION_AMBIGUOUS','Select or recover the exact operation; candidates: '+choices.map(j=>j.operationId).join(', '));
    job=choices[0];
  }
  if(job && run?.authorization.retryOnly && !links.length) {
    const allowed=candidates.filter(j=>own(j) && j.retryOf===job!.operationId && run.authorization.retryOnly?.includes(j.operationId));
    if(allowed.length>1)fail('RETRY_CONFLICT','Ambiguous restricted children: '+allowed.map(j=>j.operationId).join(', '));
    job=allowed[0]??job;
  }
  if(job?.lastError?.code==='RETRY_SUPERSEDED' && job.retryOf && !job.submittedAt && !job.taskId)job=exact(job.retryOf);
  for(const link of links){
    if(!link.detail || !link.operationId)fail('BATCH_RUN_TAMPERED','Incomplete retry link for '+item.segmentId);
    const old=exact(link.detail), child=candidates.find(j=>j.operationId===link.operationId);
    if(!child){
      // An authorization-only child can be superseded before it ever gets a Job.
      // loadBatchRun checks the recovered receipt, grant and absence of submission evidence.
      if(old.taskId && links.slice(links.indexOf(link)+1).some(t=>t.detail===old.operationId))continue;
      if(index?.operationId!==old.operationId || job?.operationId!==old.operationId)fail('BATCH_RUN_TAMPERED','Missing linked attempt '+link.operationId);
      continue; // interrupted after recording a choice, before the child was saved
    }
    if(!own(child) || child.retryOf!==old.operationId || child.attempt<=old.attempt || (child.status==='prepared' && child.submittedAt))fail('BATCH_RUN_TAMPERED','Conflicting retry link '+link.operationId);
    if(child.status==='cancelled' && child.lastError?.code==='RETRY_SUPERSEDED' && !child.taskId && !child.submittedAt && old.taskId)continue;
    if(job?.operationId===old.operationId)job=child;
  }
  // An unstarted child cancelled by recovery of its original receipt resolves to that original.
  if(job?.status==='cancelled' && job.lastError?.code==='RETRY_SUPERSEDED' && job.retryOf && !job.submittedAt && !job.taskId){
    const original=exact(job.retryOf);
    if(!original.taskId)fail('RETRY_CONFLICT','Recovered original lacks its receipt: '+original.operationId);
    return original;
  }
  return job;
}
/** Optional in-memory evidence for publishing a delivery from this exact local observation. */
export class BatchInspection {
  outputs = new Map<number, SavedOutput>();
  outputVersions = new Map<number, string>();
  evidenceHash='';
}
export async function batchStatus(root: string, id: string, inspection?: BatchInspection) {
  const plan = await loadBatch(root, id), run = await loadBatchRun(root, plan);
  const scoped=inspection?await scopedEvidence(root,plan,run):undefined;
  const allJobs=scoped?.jobs??await listJobs(root);
  let reusable = 0, active = 0, pending = 0, failed = 0, downloads = 0;
  const items = [];
  if (inspection) {
    inspection.outputs.clear();
    inspection.outputVersions.clear();
    inspection.evidenceHash=scoped!.hash;
  }
  for (const item of plan.items) {
    const job = batchItemJob(item,run,allJobs);
    if(job?.taskId && !await exists(await receiptPath(root,job.operationId)))fail('RECEIPT_CONFLICT','Missing creation receipt for '+job.operationId);
    let outputError: string | undefined, outputIssue: string | undefined;
    if (!job || job.status === 'prepared') pending++;
    else if (job.status === 'downloaded') {
      try {
        if (inspection) inspection.outputVersions.set(item.order,await outputVersion(root,job));
        const output = await reconcileOutput(root, job, !!inspection);
        if (output) { reusable++; inspection?.outputs.set(item.order, output); }
      } catch(error) {
        outputIssue=publicError(error).code;
        if(inspection && !localVideoIssue(outputIssue))throw error;
        downloads++; outputError='OUTPUT_NEEDS_RECOVERY';
      }
    } else if (['failed','cancelled'].includes(job.status)) failed++;
    else if (job.status === 'generated') downloads++;
    else active++;
    items.push({ ...item, ...(job ? { job } : {}), ...(outputError ? { outputError, outputIssue } : {}) });
  }
  const retries = await Promise.all((scoped?.retries??await listVideoRetries(root)).filter(a => plan.items.some(i => i.planId === a.planId && i.segmentId === a.segmentId)).map(a => retryProgress(root, a)));
  return { plan, run, summary: { total: items.length, reusable, active, pending, failed, downloads, concurrency: plan.concurrency, downloadConcurrency: plan.downloadConcurrency }, items, retries };
}
export function batchSelection(story: Story, input: { episodes?: string[]; selection?: unknown }) {
  const selection = input.selection !== undefined ? parse(Selection, input.selection).episodes
    : (input.episodes ?? story.episodes.map(e => e.id)).map(episodeId => {
      const episode = story.episodes.find(e => e.id === episodeId);
      if (!episode) fail('EPISODE_MISSING', 'Selected episode does not exist.');
      return { episodeId, segmentIds: episode.segments.map(s => s.id) };
    });
  if (!selection.length || new Set(selection.map(e => e.episodeId)).size !== selection.length) fail('BATCH_SCOPE', 'Episode selection must be nonempty and unique.');
  for (const row of selection) {
    const episode = story.episodes.find(e => e.id === row.episodeId);
    if (!episode || new Set(row.segmentIds).size !== row.segmentIds.length || row.segmentIds.some(id => !episode.segments.some(s => s.id === id))) fail('BATCH_SCOPE', 'Selected segments must exist and be unique.');
  }
  return selection;
}
export async function freezeBatchPlan(root: string, input: { episodes?: string[]; selection?: unknown; allEpisodes?: boolean; concurrency?: number }) {
  if ([input.episodes !== undefined, input.selection !== undefined, input.allEpisodes === true].filter(Boolean).length !== 1) fail('BATCH_SCOPE', 'Use exactly one of --episodes, --selection or --all-episodes.');
  const concurrency = parse(z.number().int().min(1).max(4), input.concurrency ?? 4), story = await loadStory(root);
  if (input.allEpisodes && ((await listIrOperations(root)).length || story.episodes.some(e => /[\\/]context-ir[\\/]/u.test(e.source.origin)))) {
    fail('BATCH_ORIGINALS_AMBIGUOUS', 'Independent IR history exists. Use explicit original episode IDs or a selection; no copy episodes are inferred from names.');
  }
  const selection = batchSelection(story, input);
  const items: VideoBatchPlan['items'] = [];
  for (const row of selection) {
    const plan = await createPlan(root, row.episodeId, 'h3-inline-ir');
    for (const segmentId of row.segmentIds) {
      const s = plan.segments.find(s => s.segmentId === segmentId)!;
      items.push({ order: items.length, projectId: story.projectId, episodeId: row.episodeId, segmentId, planId: plan.planId, planHash: plan.planHash, requestHash: s.requestHash, inputHash: s.inputHash });
    }
  }
  const base = { schemaVersion: 1 as const, batchId: randomUUID(), projectId: story.projectId, createdAt: new Date().toISOString(), concurrency,
    downloadConcurrency: 2 as const, retryPolicy: { max429RetriesPerItem: 2 as const, totalWaitBudgetMs: 60000 as const }, items };
  const plan = parse(BatchPlan, { ...base, batchHash: canonicalSha256(base) });
  await withProjectWrite(root, async () => {
    if (canonicalSha256(await loadStory(root)) !== canonicalSha256(story)) fail('BATCH_STALE', 'Story changed while freezing the scope; prepare again.');
    await writeJson(await batchPath(root, plan.batchId, 'plan'), plan);
  });
  return plan;
}
export async function createBatchPlan(root:string,input:Parameters<typeof freezeBatchPlan>[1]) {
  return batchStatus(root,(await freezeBatchPlan(root,input)).batchId);
}
