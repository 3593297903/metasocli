import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadStory } from '../core/project.js';
import { fail, publicError } from '../core/errors.js';
import { Hash, Id, SeedAsset, parse, type Story } from '../contracts/story.js';
import { JobSchema } from '../contracts/job.js';
import { batchSelection } from '../jobs/batch-store.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { readJson, writeJson } from '../storage/io.js';
import { exists, projectPath } from '../storage/paths.js';
import { waitLease, withProjectWrite, type Lease } from '../storage/locking.js';
import { Model, Request, orderedBindings, planRequest } from './request.js';

const issue=z.object({code:z.string(),message:z.string()});
const binding=z.object({role:SeedAsset.shape.role,ordinal:z.number().int().positive(),sha256:Hash,assetId:Id.optional(),recipeHash:Hash.optional()}).strict();
const entry=z.object({episodeId:Id,segmentId:Id,requestHash:Hash,request:Request.optional(),bindings:z.array(binding).optional(),issue:issue.optional()}).strict();
const scope=z.object({version:z.literal(1),projectId:z.uuid(),model:Model,concurrency:z.number().int().min(1).max(2),items:z.array(entry).min(1)}).strict();
const Plan=scope.extend({batchId:z.uuid(),scopeHash:Hash});
export type SeedPlan=z.infer<typeof Plan>;
export type Entry=z.infer<typeof entry>;
const Correction=z.object({operationId:z.uuid(),planId:z.uuid(),requestHash:Hash,replacesPrepared:z.uuid().optional()}).strict();
const State=JobSchema.extend({provider:z.literal('yiciyuang'),model:Model,credentialRef:Hash.optional(),firstWindowReported:z.boolean().optional(),nextPollAt:z.number().optional(),successorId:z.uuid().optional(),correction:Correction.optional()});
export type State=z.infer<typeof State>;
export const seedPath=(root:string,rel:string)=>projectPath(root,'.metasocli/seedance/'+rel);
const statePath=(root:string,hash:string)=>seedPath(root,'jobs/'+parse(Hash,hash)+'.json');
const operationPath=(root:string,id:string)=>seedPath(root,'operations/'+parse(z.uuid(),id)+'.json');
export async function seedOperation(root:string,id:string){
  const file=await operationPath(root,id);
  if(!await exists(file))return;
  const job=parse(State,await readJson(file));
  if(job.operationId!==id)fail('SEED_STATE','Operation ID mismatch.');
  return job;
}
export async function hasSeedPlan(root:string,id:string){return exists(await seedPath(root,'plans/'+parse(z.uuid(),id)+'.json'));}
export function currentRequest(story:Story,row:{episodeId:string;segmentId:string},model:Model){
  const segment=story.episodes.find(e=>e.id===row.episodeId)?.segments.find(s=>s.id===row.segmentId);
  if(!segment)fail('SEGMENT_MISSING','Segment is absent: '+row.episodeId+'/'+row.segmentId);
  const request=planRequest(story,segment,model);
  const ordinals=new Map<string,number>();
  const bindings=orderedBindings(story,segment).map(({role,assetId,asset})=>{
    const ordinal=(ordinals.get(role)??0)+1;
    ordinals.set(role,ordinal);
    const recipeHash=assetId?story.assets.find(a=>a.recipe.assetId===assetId)!.recipeHash:undefined;
    return {role,ordinal,sha256:asset!.sha256,...(assetId?{assetId,recipeHash}:{})};
  });
  // Keep the existing request identity so upgraded clients can reuse receipts from older frozen plans.
  return {request,bindings,requestHash:canonicalSha256({projectId:story.projectId,...row,request})};
}
export async function prepare(root:string,model:Model,concurrency:number,input:{episodes?:string[];selection?:unknown}){
  return withProjectWrite(root,async()=>{
    const story=await loadStory(root);
    const items=batchSelection(story,input).flatMap(({episodeId,segmentIds})=>story.episodes.find(e=>e.id===episodeId)!.segments
      .filter(s=>segmentIds.includes(s.id)).map(({id:segmentId})=>{
      const row={episodeId,segmentId};
      try{return {...row,...currentRequest(story,row,model)};}
      catch(error){const issue=publicError(error);return {...row,issue,requestHash:canonicalSha256({projectId:story.projectId,...row,model,issue})};}
    }));
    const body=scope.parse({version:1,projectId:story.projectId,model,concurrency,items});
    const scopeHash=canonicalSha256(body),index=await seedPath(root,'scopes/'+scopeHash+'.json');
    if(await exists(index))return readPlan(root,parse(z.uuid(),await readJson(index)),scopeHash);
    const plan={...body,scopeHash,batchId:randomUUID()};
    await writeJson(await seedPath(root,'plans/'+plan.batchId+'.json'),plan);
    await writeJson(index,plan.batchId);
    return plan;
  });
}
export async function readPlan(root:string,id:string,expected?:string){
  const plan=parse(Plan,await readJson(await seedPath(root,'plans/'+parse(z.uuid(),id)+'.json')));
  const {scopeHash,batchId,...body}=plan;
  if(batchId!==id||canonicalSha256(body)!==scopeHash||(expected&&expected!==scopeHash)||(await loadStory(root)).projectId!==plan.projectId||
    await readJson(await seedPath(root,'scopes/'+scopeHash+'.json'))!==id)fail('BATCH_TAMPERED','Seedance frozen scope mismatch.');
  return plan;
}
export async function stateFor(root:string,plan:SeedPlan,item:Entry):Promise<State|undefined>{
  const file=await statePath(root,item.requestHash);
  if(!await exists(file))return;
  const job=parse(State,await readJson(file));
  if(job.requestHash!==item.requestHash||job.inputHash!==item.requestHash||job.projectId!==plan.projectId||job.model!==plan.model||
     job.episodeId!==item.episodeId||job.segmentId!==item.segmentId)fail('SEED_STATE','Operation identity mismatch.');
  if(['queued','running','generated','downloaded'].includes(job.status)&&(!job.taskId||!job.submittedAt||!job.credentialRef))fail('SEED_STATE','Accepted operation lacks a receipt.');
  const op=await seedOperation(root,job.operationId);
  if(!op||op.requestHash!==job.requestHash||op.planId!==job.planId||op.projectId!==job.projectId||
     op.model!==job.model||op.episodeId!==job.episodeId||op.segmentId!==job.segmentId||op.inputHash!==job.inputHash)
    fail('SEED_STATE','Request index and operation disagree: '+job.operationId);
  return op; // save() persists the operation before refreshing the request index.
}
export function historicalRendering(projectId:string,item:Entry):Entry {
  const r=item.request;
  if(!r)return item;
  const prompt=r.prompt.replace(/参考图([1-9]\d*)/gu,'@图$1');
  if(prompt===r.prompt)return item;
  const request={...r,prompt,promptHash:sha256Hex(prompt)};
  const requestHash=canonicalSha256({projectId,episodeId:item.episodeId,segmentId:item.segmentId,request});
  return {...item,requestHash,request};
}
export function matchesEntry(a:Entry,b:Entry){
  return a.episodeId===b.episodeId && a.segmentId===b.segmentId && a.requestHash===b.requestHash &&
    !!a.request && !!b.request && canonicalSha256(a.request)===canonicalSha256(b.request) &&
    (!a.bindings||!b.bindings||canonicalSha256(a.bindings)===canonicalSha256(b.bindings));
}
export function frozenItem(plan:SeedPlan,job:State) {
  const item=plan.items.find(i=>i.requestHash===job.requestHash && i.episodeId===job.episodeId && i.segmentId===job.segmentId);
  if(!item?.request || plan.projectId!==job.projectId || plan.model!==job.model || plan.batchId!==job.planId ||
     plan.scopeHash!==job.planHash || job.inputHash!==job.requestHash ||
     canonicalSha256({projectId:plan.projectId,episodeId:item.episodeId,segmentId:item.segmentId,request:item.request})!==item.requestHash)
    fail('SEED_STATE','Operation and frozen request disagree: '+job.operationId);
  return item;
}
export async function lockRequests(root:string,hashes:string[]) {
  const leases:Lease[]=[];
  const release=async()=>{try{await Promise.all(leases.map(l=>l.release()));}finally{leases.length=0;}};
  try{
    for(const hash of [...new Set(hashes)].sort())
      leases.push(await waitLease(await seedPath(root,'locks/'+parse(Hash,hash)+'.lock')));
  }catch(error){await release();throw error;}
  return {release};
}
export async function batchAuthorized(root:string,plan:SeedPlan,grant:boolean) {
  const path=await seedPath(root,'authorizations/'+plan.batchId+'.json');
  const scope={batchId:plan.batchId,scopeHash:plan.scopeHash,projectId:plan.projectId,
    segments:plan.items.map(({episodeId,segmentId,requestHash})=>({episodeId,segmentId,requestHash}))};
  if(await exists(path)) {
    if(canonicalSha256(await readJson(path))!==canonicalSha256(scope))fail('BATCH_SCOPE','Stored generation authorization differs from the frozen scope.');
    return true;
  }
  if(grant)await withProjectWrite(root,()=>writeJson(path,scope));
  return grant;
}
// A shared request can be observed by several batches. Pin each batch's original attempt separately from the current head.
export async function batchAttempt(root:string,plan:SeedPlan,item:Entry,bind?:State) {
  const file=await seedPath(root,'bindings/'+plan.batchId+'/'+item.requestHash+'.json');
  if(await exists(file)) {
    const id=parse(z.uuid(),await readJson(file));
    const job=await seedOperation(root,id);
    if(!job || job.requestHash!==item.requestHash || job.projectId!==plan.projectId || job.episodeId!==item.episodeId ||
      job.segmentId!==item.segmentId || job.model!==plan.model)fail('SEED_STATE','Original attempt differs from the frozen segment.');
    return job;
  }
  if(bind){await writeJson(file,bind.operationId);return bind;}
  return undefined;
}
/** Delivery may reuse a separately authorized successor, while local history always reports the original. */
export async function deliveryAttempt(root:string,original:State) {
  let job=original;
  while(job.successorId && (!job.taskId || ['failed','cancelled'].includes(job.status))){
    const next=await seedOperation(root,job.successorId);
    if(!next && job.correction?.operationId===job.successorId)return job;
    if(!next || next.retryOf!==job.operationId || next.attempt!==job.attempt+1)
      fail('RETRY_CONFLICT','Successor operation does not match its original attempt.');
    if(next.requestHash!==job.requestHash){
      const grant=job.correction;
      if(grant?.operationId!==next.operationId || grant.planId!==next.planId || grant.requestHash!==next.requestHash)
        fail('RETRY_CONFLICT','No authorization for a different request hash: '+job.operationId);
      const before=frozenItem(await readPlan(root,job.planId),job),after=frozenItem(await readPlan(root,next.planId),next);
      if(job.projectId!==next.projectId || !matchesEntry(before,historicalRendering(job.projectId,after)))
        fail('RETRY_CONFLICT','Corrected attempt differs from the authorized historical input.');
    }
    job=next;
  }
  return job;
}
export async function save(root:string,job:State,replaceAttempt=false){
  job.updatedAt=new Date(Date.now()).toISOString();
  // The per-attempt record keeps its task receipt even after a separately authorized retry.
  await writeJson(await operationPath(root,job.operationId),parse(State,job));
  const path=await statePath(root,job.requestHash);
  if(!replaceAttempt && await exists(path) && parse(State,await readJson(path)).operationId!==job.operationId)return;
  await writeJson(path,parse(State,job));
}
export async function receipt(root:string,job:State,id:string,observed?:Pick<State,'status'|'rawStatus'|'lastError'>){
  const link=await seedPath(root,'tasks/'+canonicalSha256([job.credentialRef,id])+'.json');
  await withProjectWrite(root,async()=>{
    if(await exists(link)&&await readJson(link)!==job.operationId)fail('SEED_CONTRACT','Provider task already belongs to another operation.');
    await writeJson(link,job.operationId);
    job.taskId=id;job.status=observed?.status??'queued';job.rawStatus=observed?.rawStatus??'queued';job.submittedAt??=new Date(Date.now()).toISOString();
    job.lastError=observed?.lastError;await save(root,job);
  });
}
export function initial(plan:SeedPlan,row:Entry):State{
  const now=new Date().toISOString();
  return {schemaVersion:1,provider:'yiciyuang',model:plan.model,operationId:randomUUID(),projectId:plan.projectId,planId:plan.batchId,
    planHash:plan.scopeHash,episodeId:row.episodeId,segmentId:row.segmentId,revision:0,inputHash:row.requestHash,requestHash:row.requestHash,
    attempt:1,status:'prepared',createdAt:now,updatedAt:now};
}
