import { randomUUID } from 'node:crypto';
import type { Job } from '../contracts/job.js';
import type { VideoBatchPlan, VideoBatchRun } from '../contracts/batch.js';
import type { VideoRetryAuthorization } from '../contracts/video-retry.js';
import { loadPlan, validatePlan } from '../core/planning.js';
import { fail } from '../core/errors.js';
import { exists, projectPath, pathIdentity } from '../storage/paths.js';
import { withProjectWrite, serialized } from '../storage/locking.js';
import { batchItemJob, loadBatch, loadBatchRun, matchesItem, writeBatchRunLocked } from './batch-store.js';
import { inspectRuntime, runtimeDirectory, acquireScheduler, requireScheduler } from './coordinator.js';
import { listJobs, persistence, receiptPath } from './store.js';
import { authorizeVideoRetry, effectiveJobs, listVideoRetries, readVideoRetry, materializeRetry, supersededRetry } from './video-retry.js';
import type { JobDependencies } from './submit.js';

type Item=VideoBatchPlan['items'][number];
type Deps=Pick<JobDependencies,'checkpoint'|'runtimeRoot'>;
export function emptyRun(plan:VideoBatchPlan, retryOnly?:string[]):VideoBatchRun {
  const at=new Date().toISOString();
  return {schemaVersion:1,batchId:plan.batchId,batchHash:plan.batchHash,hash:'0'.repeat(64),updatedAt:at,status:'running',
    authorization:{batchHash:plan.batchHash,authorizedAt:at,...(retryOnly?{retryOnly}:{})},
    items:plan.items.map(i=>({order:i.order,retryHistory:[]})),trace:[],rateLimit:{spentWaitMs:0,notBefore:0}};
}
// Caller holds the project write lock and story scheduler. The run is the durable
// choice of the new ID, even if the process dies before its prepared Job is written.
async function link(root:string,run:VideoBatchRun,item:Item,original:Job,id:string){
  const previous=run.trace.find(t=>t.event==='batch-retry-linked' && t.order===item.order && t.detail===original.operationId && t.operationId===id);
  if(previous)return;
  const index=run.items[item.order]!;
  if(index.operationId && index.operationId!==original.operationId && index.operationId!==id)fail('RETRY_CONFLICT','Batch is bound to '+index.operationId);
  index.operationId??=original.operationId;
  if(run.authorization.retryOnly && !run.authorization.retryOnly.includes(id))run.authorization.retryOnly.push(id);
  run.trace.push({event:'batch-retry-linked',at:new Date().toISOString(),order:item.order,operationId:id,detail:original.operationId});
  await writeBatchRunLocked(root,run);
}
async function failedChild(root:string,run:VideoBatchRun,item:Item,old:Job,id:string,jobs:Job[],deps:Deps){
  const existing=jobs.find(j=>j.operationId===id);
  if(existing){
    if(!matchesItem(existing,item) || existing.planId!==item.planId || existing.planHash!==item.planHash || existing.retryOf!==old.operationId
      || existing.attempt<=old.attempt || existing.status==='prepared' && existing.submittedAt)fail('RETRY_CONFLICT','Conflicting linked attempt '+id);
    return existing;
  }
  if(!['failed','cancelled'].includes(old.status) || run.trace.some(t=>t.operationId===id && t.event!=='batch-retry-linked')
    || await exists(await receiptPath(root,id)) || await exists(await projectPath(root,'.metasocli/receipts/'+id+'-create-error.json'))
    || await exists(await projectPath(root,'.metasocli/submissions/'+id+'.json')) || await exists(await projectPath(root,'.metasocli/submissions/'+id+'.lock'))
    || (await inspectRuntime(runtimeDirectory(deps.runtimeRoot))).slots.some(s=>s.operationId===id)
    || effectiveJobs(jobs).some(j=>j.retryOf===old.operationId))fail('RETRY_CONFLICT','Missing linked job with conflicting or submission evidence: '+id);
  const parent=await loadPlan(root,item.planId);await validatePlan(root,parent);
  const at=new Date().toISOString(), peers=jobs.filter(j=>j.episodeId===item.episodeId && j.segmentId===item.segmentId);
  const child:Job={schemaVersion:1,operationId:id,projectId:item.projectId,planId:item.planId,planHash:item.planHash,
    episodeId:item.episodeId,segmentId:item.segmentId,revision:parent.revision,requestHash:item.requestHash,inputHash:item.inputHash,
    retryOf:old.operationId,attempt:Math.max(old.attempt,...peers.map(j=>j.attempt))+1,status:'prepared',createdAt:at,updatedAt:at};
  await persistence.job(root,child);await deps.checkpoint?.('retry-job',child);
  return child;
}
/** Keep the restricted choices independently provable when their ID allowlist is retired. */
function bindRestrictedChoices(plan:VideoBatchPlan, run:VideoBatchRun, jobs:Job[], grants:VideoRetryAuthorization[], targets:Map<string,Job>) {
  const selected=plan.items.map(item=>batchItemJob(item,run,jobs));
  const last=new Map<number,string>();
  for(const grant of grants.sort((a,b)=>a.attempt-b.attempt)){
    const item=plan.items.find(i=>i.planId===grant.planId && i.planHash===grant.planHash && i.segmentId===grant.segmentId);
    if(!item)fail('RETRY_CONFLICT','Restricted operation is outside this batch: '+grant.newOperationId);
    const prior=last.get(item.order);
    if(prior && prior!==grant.oldOperationId)fail('RETRY_CONFLICT','Disconnected restricted attempts: '+prior+' and '+grant.newOperationId);
    last.set(item.order,grant.newOperationId);
    const links=run.trace.filter(t=>t.event==='batch-retry-linked' && t.operationId===grant.newOperationId);
    if(links.length>1 || links.some(t=>t.order!==item.order || t.detail!==grant.oldOperationId))
      fail('RETRY_CONFLICT','Conflicting batch retry history for '+grant.newOperationId);
    if(!links.length)run.trace.push({event:'batch-retry-linked',at:new Date().toISOString(),order:item.order,detail:grant.oldOperationId,operationId:grant.newOperationId});
  }
  for(const [order,child] of last){
    const target=targets.get(child);
    if(!target || selected[order]?.operationId!==target.operationId)fail('RETRY_CONFLICT','Cannot prove restricted selection for '+child);
    run.items[order]!.operationId=target.operationId;
  }
  delete run.authorization.retryOnly;
  for(const item of plan.items){
    if(batchItemJob(item,run,jobs)?.operationId!==selected[item.order]?.operationId)
      fail('RETRY_CONFLICT','Full authorization would change the selected operation for '+item.segmentId);
  }
  return selected;
}

export async function restoreBatchLinks(root:string,plan:VideoBatchPlan,run:VideoBatchRun,deps:Deps,authorizeFull=false) {
  const links=run.trace.filter(t=>t.event==='batch-retry-linked');
  const restricted=run.authorization.retryOnly??[];
  if(!links.length && !restricted.length)return;
  return withProjectWrite(root,async()=>{
    // Legacy retryOnly binds exact authorization IDs even when the run predates trace links.
    const grants=restricted.length?(await listVideoRetries(root,runtimeDirectory(deps.runtimeRoot))).filter(a=>restricted.includes(a.newOperationId)):[];
    if(grants.length!==restricted.length)fail('RETRY_CONFLICT','Missing or ambiguous restricted grants for '+plan.batchId);
    const targets=new Map<string,Job>();
    for(const a of grants)targets.set(a.newOperationId,await materializeRetry(root,a,deps.checkpoint));
    if(restricted.some(id=>!targets.has(id)))fail('RETRY_CONFLICT','Missing one-attempt authorization for batch '+plan.batchId);
    const jobs=await listJobs(root);
    for(const t of links){
      const item=plan.items[t.order??-1], old=jobs.find(j=>j.operationId===t.detail);
      if(!old || !item || !matchesItem(old,item) || !t.operationId)fail('RETRY_CONFLICT','Invalid retry link in batch '+plan.batchId);
      if(jobs.some(j=>j.operationId===t.operationId))continue; // batchItemJob validates all existing children
      const a=await readVideoRetry(root,old.operationId,runtimeDirectory(deps.runtimeRoot));
      if(a?.newOperationId===t.operationId)await materializeRetry(root,a,deps.checkpoint);
      else await failedChild(root,run,item,old,t.operationId,jobs,deps);
    }
    if(authorizeFull){
      const selected=bindRestrictedChoices(plan,run,jobs,grants,targets);
      return new Set(plan.items.filter(i=>!selected[i.order] || selected[i.order]!.status==='prepared').map(i=>i.planId));
    }
  });
}
export async function prepareFailedBatchRetry(root:string,plan:VideoBatchPlan,run:VideoBatchRun,item:Item,old:Job,deps:Deps,rateRetry=false){
  const jobs=await listJobs(root);
  const previous=run.trace.findLast(t=>t.event==='batch-retry-linked' && t.order===item.order && t.detail===old.operationId &&
    !jobs.some(j=>j.operationId===t.operationId && j.status==='cancelled' && j.lastError?.code==='RETRY_SUPERSEDED' && !j.taskId && !j.submittedAt && old.taskId));
  if(previous?.operationId)return failedChild(root,run,item,old,previous.operationId,jobs,deps);
  const active=batchItemJob(item,run,jobs);
  if(active?.operationId!==old.operationId)fail('RETRY_CONFLICT','Batch operation differs from requested retry '+old.operationId);
  const children=effectiveJobs(jobs).filter(j=>j.retryOf===old.operationId);
  if(children.length>1 || children.some(j=>!matchesItem(j,item)||j.planId!==item.planId))fail('RETRY_CONFLICT','Other attempts exist: '+children.map(j=>j.operationId).join(', '));
  const latest=effectiveJobs(jobs).filter(j=>j.episodeId===item.episodeId && j.segmentId===item.segmentId).at(-1);
  if(!children.length && latest?.operationId!==old.operationId)fail('RETRY_FORBIDDEN','Only the latest definitively failed operation may be retried.');
  const grant=await readVideoRetry(root,old.operationId,runtimeDirectory(deps.runtimeRoot));
  if(grant && !await supersededRetry(root,grant))fail('RETRY_CONFLICT','Recover the existing unknown-result retry first.');
  if(rateRetry && children.length && !run.trace.some(t=>t.order===item.order && t.event==='dispatch' && t.operationId===old.operationId))
    fail('RETRY_CONFLICT','Rate-limit retry has a separate unproven attempt: '+children[0]!.operationId);
  await validatePlan(root,await loadPlan(root,item.planId));
  const id=children[0]?.operationId??randomUUID();
  run.items[item.order]!.operationId=active.operationId;
  await link(root,run,item,old,id);
  await deps.checkpoint?.('batch-retry-linked',{...old,operationId:id});
  return failedChild(root,run,item,old,id,jobs,deps);
}
export function authorizeBatchRetry(root:string,id:string,oldId:string,confirmed:boolean,accepted:boolean,deps:Deps={}){
  return serialized('batch-retry:'+pathIdentity(root),async()=>{
    const runtime=runtimeDirectory(deps.runtimeRoot);
    await requireScheduler(root,runtime);
    const scheduler=await acquireScheduler(root,runtime);
    try{
      const plan=await loadBatch(root,id),jobs=await listJobs(root),old=jobs.find(j=>j.operationId===oldId);
      const item=old && plan.items.find(i=>matchesItem(old,i));
      if(!item || !old)fail('RETRY_CONFLICT','Local operation is outside batch '+id);
      if(!confirmed)fail('GENERATION_NOT_AUTHORIZED','Batch retry requires explicit confirmation.');
      let run=await loadBatchRun(root,plan);
      if(!accepted && ['failed','cancelled'].includes(old.status)){
        if(!run || run.authorization.retryOnly)fail('GENERATION_NOT_AUTHORIZED','Failed retry requires a saved full batch authorization.');
        const state=run;
        return {job:await withProjectWrite(root,()=>prepareFailedBatchRetry(root,plan,state,item,old,deps))};
      }
      if(!accepted)fail('GENERATION_NOT_AUTHORIZED','Unknown-result retry requires explicit risk acceptance.');
      const index=run?.items[item.order]?.operationId;
      if(index && index!==oldId && !run?.trace.some(t=>t.event==='batch-retry-linked' && t.order===item.order && t.detail===oldId)
        && !run?.authorization.retryOnly?.includes(index))fail('RETRY_CONFLICT','Requested retry differs from batch operation '+index);
      return await authorizeVideoRetry(root,item.planId,item.segmentId,oldId,confirmed,accepted,runtime,deps.checkpoint,async a=>{
        run??=emptyRun(plan,[a.newOperationId]);
        const indexed=run.items[item.order]?.operationId;
        if(indexed && indexed!==oldId && indexed!==a.newOperationId &&
          !run.trace.some(t=>t.event==='batch-retry-linked' && t.order===item.order && t.detail===oldId && t.operationId===a.newOperationId))
          fail('RETRY_CONFLICT','Requested retry differs from the batch binding '+indexed);
        await link(root,run,item,old,a.newOperationId);
      });
    }finally{await scheduler.release();}
  });
}
