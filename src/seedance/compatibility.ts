import { fail } from '../core/errors.js';
import { loadStory } from '../core/project.js';
import { batchAttempt, currentRequest, deliveryAttempt, frozenItem, historicalRendering, initial, matchesEntry,
  prepare, readPlan, save, seedOperation, stateFor, type Entry, type SeedPlan, type State } from './store.js';

export type RenderPair={current:Entry;legacy:Entry};
/** Only the known renderer change may bridge two independent content hashes. Asset bytes are not needed for lookup. */
export async function renderPair(root:string,plan:SeedPlan,item:Entry,operation?:State):Promise<RenderPair|undefined>{
  const older=historicalRendering(plan.projectId,item);
  if(older!==item)return {current:item,legacy:older};
  if(!item.request?.sourcePrompt.includes('参考图'))return;
  let current:Entry;
  if(operation?.correction){
    const corrected=await readPlan(root,operation.correction.planId);
    const found=corrected.items.find(i=>i.requestHash===operation.correction!.requestHash);
    if(!found || corrected.projectId!==plan.projectId || corrected.model!==plan.model)fail('RETRY_CONFLICT','Invalid correction for '+operation.operationId);
    current=found;
  }else{
    const story=await loadStory(root);
    const row={episodeId:item.episodeId,segmentId:item.segmentId};
    // An accepted old job remains recoverable even if the story has since been edited.
    try{current={...row,...currentRequest(story,row,plan.model)};}catch{return;}
  }
  if(current.requestHash!==item.requestHash && matchesEntry(item,historicalRendering(plan.projectId,current)))return {current,legacy:item};
}

function conflict(a:State,b:State):never {
  return fail('SEED_HISTORY_CONFLICT','Separate attempts exist: '+a.planId+'/'+a.operationId+' and '+b.planId+'/'+b.operationId+'. Resume each by its operation ID.');
}
export async function matchedHeads(root:string,plan:SeedPlan,pair:RenderPair){
  const current=await stateFor(root,plan,pair.current),legacy=await stateFor(root,plan,pair.legacy);
  for(const [job,expected] of [[current,pair.current],[legacy,pair.legacy]] as const) {
    if(job && !matchesEntry(frozenItem(await readPlan(root,job.planId),job),expected))
      fail('SEED_HISTORY_CONFLICT','Frozen assets or request differ for '+job.planId+'/'+job.operationId);
  }
  if(current && legacy){
    const grant=legacy.correction;
    if(!grant || grant.requestHash!==current.requestHash)conflict(legacy,current);
    const linked=await seedOperation(root,grant.operationId);
    if(!linked || linked.retryOf!==legacy.operationId || linked.planId!==grant.planId ||
       linked.requestHash!==grant.requestHash || linked.attempt!==legacy.attempt+1)conflict(legacy,current);
    if((await deliveryAttempt(root,linked)).operationId!==current.operationId)conflict(legacy,current);
    if(legacy.taskId && current.credentialRef && current.status!=='prepared' && current.lastError?.code!=='RETRY_SUPERSEDED')
      conflict(legacy,current);
  }
  return {current,legacy};
}

/** The grant lives in the original operation and is durable before the corrected operation can be submitted. */
export async function correctedRetry(root:string,original:State,plan:SeedPlan,pair:RenderPair,
  heads:Awaited<ReturnType<typeof matchedHeads>>,keyRef:string,acceptUnknown:boolean) {
  if(original.credentialRef!==keyRef)fail('CREDENTIAL_CHANGED','Use the credential which created '+original.operationId);
  if(original.taskId || original.status!=='submit_unknown'||!acceptUnknown)
    fail('RETRY_CONFLICT','A correction needs the unresolved original attempt: '+original.operationId);
  const previous=original.successorId?await seedOperation(root,original.successorId):heads.legacy;
  let grant=original.correction;
  if(!grant){
    if(heads.current)conflict(original,heads.current);
    if(previous && previous.operationId!==original.operationId &&
       (previous.retryOf!==original.operationId || previous.requestHash!==original.requestHash ||
        previous.status!=='prepared' || previous.taskId || previous.credentialRef))
      fail('RETRY_CONFLICT','Existing attempt may already have been sent. Resume '+previous.operationId);
    const fresh=await prepare(root,plan.model,plan.concurrency,{selection:{schemaVersion:1,episodes:[
      {episodeId:original.episodeId,segmentIds:[original.segmentId]}]}});
    if(!matchesEntry(fresh.items[0]!,pair.current))fail('PLAN_STALE','Current inputs differ from the authorized correction.');
    const candidate=initial(fresh,fresh.items[0]!);
    grant={operationId:candidate.operationId,planId:fresh.batchId,requestHash:candidate.requestHash,
      ...(previous && previous.operationId!==original.operationId?{replacesPrepared:previous.operationId}:{})};
    await batchAttempt(root,plan,pair.legacy,original);
    original.correction=grant;original.successorId=grant.operationId;
    await save(root,original,true);
  }
  const target=await readPlan(root,grant.planId),item=target.items[0]!;
  if(target.items.length!==1 || !matchesEntry(item,pair.current) || item.requestHash!==grant.requestHash ||
     !matchesEntry(historicalRendering(plan.projectId,item),pair.legacy))fail('RETRY_CONFLICT','Correction scope changed for '+original.operationId);
  if(heads.legacy?.operationId!==original.operationId){
    if(heads.legacy && heads.legacy.operationId!==grant.replacesPrepared)conflict(original,heads.legacy);
    await save(root,original,true); // Repair a crash between the parent's operation and index writes.
  }
  if(grant.replacesPrepared){
    const prior=await seedOperation(root,grant.replacesPrepared);
    if(!prior || prior.retryOf!==original.operationId || prior.requestHash!==original.requestHash || prior.taskId || prior.credentialRef ||
       (prior.status!=='prepared' && prior.lastError?.code!=='RETRY_SUPERSEDED'))fail('RETRY_CONFLICT','Cannot replace uncertain attempt '+grant.replacesPrepared);
    if(prior.status==='prepared'){
      prior.status='cancelled';prior.lastError={code:'RETRY_SUPERSEDED',message:'Unsent attempt replaced by '+grant.operationId};await save(root,prior);
    }
  }
  let child=await seedOperation(root,grant.operationId);
  if(!child)child={...initial(target,item),operationId:grant.operationId,retryOf:original.operationId,attempt:original.attempt+1,credentialRef:keyRef};
  if(child.retryOf!==original.operationId || child.requestHash!==item.requestHash || child.planId!==target.batchId ||
    child.attempt!==original.attempt+1 || (child.credentialRef && child.credentialRef!==keyRef))fail('RETRY_CONFLICT','Correction identity mismatch.');
  if(!heads.current)await save(root,child,true);
  await batchAttempt(root,target,item,child);
  return {job:child,plan:target,item};
}
