import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { parse } from '../contracts/story.js';
import { JobSchema, type Job } from '../contracts/job.js';
import { BatchPlan, type VideoBatchPlan, type VideoBatchRun } from '../contracts/batch.js';
import { VideoRetry, type VideoRetryAuthorization } from '../contracts/video-retry.js';
import { loadStory } from '../core/project.js';
import { fail, isCode, publicError } from '../core/errors.js';
import { projectPath, exists } from '../storage/paths.js';
import { readJson } from '../storage/io.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { readJob, jobPath } from './store.js';
import { readVideoRetry, retryPath, samePlannedRequest, verifyRetryOriginal, verifyRetryChild, type PlannedRequest } from './video-retry.js';

export const batchPath=(root:string,id:string,name:'plan'|'run')=>projectPath(root,'.metasocli/batches/'+parse(z.uuid(),id)+'/'+name+'.json');
export async function batchHeader(root:string,id:string){
  const plan=parse(BatchPlan,await readJson(await batchPath(root,id,'plan'))), {batchHash,...base}=plan;
  if(plan.batchId!==id || canonicalSha256(base)!==batchHash || (await loadStory(root)).projectId!==plan.projectId)
    fail('BATCH_TAMPERED','Batch identity/hash changed: '+id);
  const seen=new Set<string>();
  for(const [order,item] of plan.items.entries()){
    const key=item.episodeId+'/'+item.segmentId;
    if(item.order!==order || item.projectId!==plan.projectId || seen.has(key))fail('BATCH_TAMPERED','Invalid order, project or duplicate item: '+id);
    seen.add(key);
  }
  return plan;
}
// A scoped read may avoid a parent only when a separately hashed batch item
// corroborates the full identity. Paid dispatch still uses the global listJobs.
export async function scopedEvidence(root:string,plan:VideoBatchPlan,run?:VideoBatchRun){
  const byId=new Map<string,Job>(), jobs:Job[]=[], retries:VideoRetryAuthorization[]=[];
  const items=[...plan.items], inspected=new Set([plan.batchId]);
  let neighbors:string[]|undefined;
  const relevant=(j:Job)=>plan.items.some(i=>i.episodeId===j.episodeId && i.segmentId===j.segmentId && i.inputHash===j.inputHash);
  const proves=(j:PlannedRequest)=>items.some(item=>samePlannedRequest(item,j));
  async function corroborated(j:PlannedRequest){
    if(proves(j))return true;
    neighbors??=await readdir(await projectPath(root,'.metasocli/batches'));
    for(const id of neighbors){
      if(inspected.has(id)||!z.uuid().safeParse(id).success)continue;
      inspected.add(id);
      try{items.push(...(await batchHeader(root,id)).items);}
      catch(error){
        // This is only a search for independent corroboration. A broken header
        // supplies no evidence. Still require another valid item or a full readJob.
        if(['INVALID_JSON','INVALID_INPUT','BATCH_TAMPERED','ENOENT'].some(code=>isCode(error,code)))continue;
        throw error;
      }
      if(proves(j))return true;
    }
    return false;
  }
  const bound=new Set((run?.items??[]).map(i=>i.operationId));
  for(const id of run?.authorization.retryOnly??[])bound.add(id);
  for(const link of run?.trace??[])if(link.event==='batch-retry-linked'){
    bound.add(link.detail);bound.add(link.operationId);
  }
  for(const file of (await readdir(await projectPath(root,'.metasocli/jobs'))).filter(f=>f.endsWith('.json'))){
    const id=file.slice(0,-5);
    try{
      const j=parse(JobSchema,await readJson(await jobPath(root,id)));
      if(j.operationId!==id || j.projectId!==plan.projectId)fail('JOB_CONFLICT','Job identity differs from its project or file: '+id);
      byId.set(id,j);
      if(!bound.has(id) && !relevant(j) && await corroborated(j))continue;
      const verified=await readJob(root,id);
      if(relevant(verified)||bound.has(id))jobs.push(verified);
    }catch(error){recordError(error,'Job',id);}
  }
  const dir=await projectPath(root,'.metasocli/video-retries');
  if(await exists(dir))for(const file of (await readdir(dir)).filter(f=>f.endsWith('.json'))){
    const id=file.slice(0,-5);
    try{
      const a=parse(VideoRetry,await readJson(await retryPath(root,id))), {hash,...body}=a;
      const old=byId.get(id);
      if(hash!==canonicalSha256(body) || a.oldOperationId!==id || a.projectId!==plan.projectId || !old)fail('RETRY_CONFLICT','Invalid authorization or missing original: '+id);
      verifyRetryOriginal(a,old);
      const child=byId.get(a.newOperationId);
      if(child)verifyRetryChild(a,child);
      const scoped=plan.items.some(i=>i.planId===a.planId && i.segmentId===a.segmentId);
      const selectedSegment=plan.items.some(i=>i.episodeId===a.episodeId && i.segmentId===a.segmentId);
      // The original and the grant can have different parents. Each proof must
      // come from one complete authenticated item. The verified child shares the grant's identity.
      if(!scoped && !selectedSegment && !bound.has(id) && !bound.has(a.newOperationId)
        && await corroborated(old) && await corroborated(a))continue;
      const verified=await readVideoRetry(root,id);
      if(!verified)fail('RETRY_CONFLICT','Retry disappeared: '+id);
      if(scoped)retries.push(verified);
    }catch(error){recordError(error,'Retry',id);}
  }
  return {jobs,retries,hash:canonicalSha256({jobs:jobs.map(j=>[j.operationId,canonicalSha256(j)]).sort(),retries:retries.map(a=>a.hash).sort()})};
}
function recordError(error:unknown,kind:string,id:string):never{
  const reason=publicError(error);
  fail(reason.code==='LOCAL_ERROR'?'VIDEO_SCOPE_UNVERIFIABLE':reason.code,kind+' '+id+': '+reason.message);
}
