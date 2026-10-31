import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { z } from 'zod';
import { parse } from '../contracts/story.js';
import { loadStory } from '../core/project.js';
import { fail, publicError } from '../core/errors.js';
import { exists, projectPath, samePath } from '../storage/paths.js';
import { readStable, readJson, atomicWrite, writeJson } from '../storage/io.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { acquireLease, withProjectWrite } from '../storage/locking.js';
import { listJobs } from '../jobs/store.js';
import { runtimeDirectory } from '../jobs/coordinator.js';
import { buildRequest } from '../metaso/h3.js';
import type { Fetch } from '../metaso/transport.js';
import { type ImageClient } from './client.js';
import { resolvedImage, type ImagePlanRecord, type ImageJobRecord, type ImageRunRecord } from './contracts.js';
import { imagePath, readImagePlan, readImageJob, listImageJobs, readImageRun, saveImageRun, saveImageJob, receiptFile, readBodyReceipt } from './store.js';
import { assertKnownCapacity, acquireImageScheduler, reconcileImageLedger, withImageLedger, imageSlot, updateImageSlot } from './coordinator.js';
import { startImageStage, finishImageStage } from './phase.js';
import { effectiveImageInput, validateImagePlan } from './planning.js';
import { DiskBudget, Semaphore, preflightSpace } from './stream.js';
import { saveImageResponse, receiveImage, downloadImageResult, registerImageResult, saveResultBytes, type ImageCheckpoint, type ResultContext } from './result.js';

export interface ImageDependencies {client?:ImageClient;fetcher?:Fetch;runtimeRoot?:string;checkpoint?:ImageCheckpoint;onResponseChunk?:(operationId:string,bytes:number)=>void;acceptExistingUnknown?:string[]}
const now=()=>new Date().toISOString();
const receiverPath=(root:string,id:string)=>projectPath(root,receiptFile(id,'receiver.lock'));
function context(plan:ImagePlanRecord,deps:ImageDependencies,used=0):ResultContext {return {budget:new DiskBudget(plan.profile.maxTempBytes,used),decode:new Semaphore(plan.profile.decodeConcurrency),download:new Semaphore(plan.profile.downloadConcurrency),registration:new Semaphore(1),...deps};}
async function diskUsage(root:string):Promise<number>{let total=0;for(const base of ['.metasocli/image-receipts','.metasocli/drafts/assets','.metasocli/image-inputs']){
  const start=await projectPath(root,base);if(!await exists(start))continue;
  async function visit(path:string):Promise<void>{for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isSymbolicLink())fail('LINK_PATH','Image temporary storage contains a link.');if(entry.isDirectory())await visit(file);else total+=(await stat(file)).size;}}await visit(start);
}return total;}
async function finishExisting(root:string,job:ImageJobRecord,plan:ImagePlanRecord,ctx:ResultContext){
  if(job.status==='registered'){ // A missing managed image is restored from the original result, never regenerated.
    await registerImageResult(root,job,plan,ctx);return;
  }
  if(['submitting','submit_unknown','response_saved'].includes(job.status)){
    if(!await readBodyReceipt(root,job)){job.status='submit_unknown';await saveImageJob(root,job);return;}
    await receiveImage(root,job,plan.profile,ctx);
  }
  if(job.status==='received')await downloadImageResult(root,job,plan.profile,ctx);
  if(job.status==='downloaded')await registerImageResult(root,job,plan,ctx);
}
function captureFailure(job:ImageJobRecord,error:unknown){const detail=publicError(error);job.error={code:detail.code,message:detail.message};
  if(['IMAGE_TARGET_CHANGED','IMAGE_DEPENDENCY_CHANGED','IMAGE_PLAN_STALE'].includes(detail.code))job.status=job.result?'superseded':'blocked';
  else if(['IMAGE_SIZE_MISMATCH','IMAGE_INVALID','IMAGE_DIMENSIONS','IMAGE_LIMIT','IMAGE_SIZE_LIMIT'].includes(detail.code))job.status='failed';
  else if(['submitting','response_saved'].includes(job.status))job.status='submit_unknown';
  else if(job.status==='registered')job.status='downloaded';
}
const neverSubmittedImage=(job:ImageJobRecord)=>!job.input&&!job.inputHash&&!job.requestHash&&!job.requestStartedAt&&!job.responseHeadersAt&&!job.responseSavedAt&&!job.receiptSavedAt&&!job.downloadCompletedAt&&!job.registeredAt&&!job.result&&!job.resolutionPath&&!job.recoveredManually;
/** Only this function can dispatch image POSTs; receivers and result recovery have no create calls. */
export async function runImages(root:string,id:string,authorize:boolean,deps:ImageDependencies={},retryOf?:string,acceptUnknownResult=false){
  const plan=await readImagePlan(root,id),profile=plan.profile;
  const scheduler=await acquireImageScheduler(profile,deps.runtimeRoot),inFlight=new Map<string,Promise<void>>();
  let run:ImageRunRecord|undefined;
  const jobs:ImageJobRecord[]=[];let halt=false,completionVersion=0;
  try {
    const ctx=context(plan,deps,await diskUsage(root));
    run=await readImageRun(root,plan);if(run?.replacementPlanId)fail('IMAGE_PLAN_REPLACED','This plan has one saved successor; resume the successor rather than generating obsolete inputs.');if(!run&&!authorize)fail('IMAGE_NOT_AUTHORIZED','images resume requires this exact saved authorization and may submit its unstarted items.');
    await validateImagePlan(root,plan);
    if(plan.items.some(i=>i.action==='blocked'))fail('IMAGE_PLAN_BLOCKED','Resolve the blocked specifications/assets before any image POST.');
    const ledger=await reconcileImageLedger(profile,deps.runtimeRoot);
    const existing=await listImageJobs(root);
    const restartPlan=plan.restartOf?await readImagePlan(root,plan.restartOf):undefined;
    const restartAncestors=new Set<string>();
    for(let ancestor=restartPlan;ancestor;ancestor=ancestor.restartOf?await readImagePlan(root,ancestor.restartOf):undefined){
      if(restartAncestors.has(ancestor.planId)||ancestor.projectId!==plan.projectId)fail('IMAGE_RESTART_INVALID','Image restart ancestry is cyclic or crosses project identity.');
      restartAncestors.add(ancestor.planId);
    }
    const restartRun=restartPlan?await readImageRun(root,restartPlan):undefined;
    if(restartPlan&&(!restartRun||restartPlan.projectId!==plan.projectId||restartPlan.profile.quotaGroup!==profile.quotaGroup))fail('IMAGE_RESTART_INVALID','Restart must preserve this project and shared quota group.');
    if(restartRun?.replacementPlanId&&restartRun.replacementPlanId!==id)fail('IMAGE_PLAN_REPLACED','The predecessor already has a saved successor; resume that exact successor.');
    if(restartPlan&&existing.some(j=>j.planId===restartPlan.planId&&['submitting','response_saved','received','downloaded'].includes(j.status)))fail('IMAGE_RESTART_RECOVERY_REQUIRED','Finish saved/in-flight results before replacing this plan.');
    if(acceptUnknownResult&&!restartPlan)fail('IMAGE_RESTART_INVALID','Unknown-result acceptance is only valid for an explicit --restart-of plan.');
    const inherited=restartRun?.authorization.acceptedUnknown??[];
    const unknowns=restartPlan?existing.filter(j=>j.planId===restartPlan.planId&&j.status==='submit_unknown'):[];
    const proposedAccepted=[...new Map([...inherited,...unknowns.map(j=>({operationId:j.operationId,requestHash:j.requestHash!}))].map(a=>[a.operationId,a])).values()];
    if(!run&&proposedAccepted.length&&(!authorize||!acceptUnknownResult))fail('IMAGE_UNKNOWN_ACCEPTANCE_REQUIRED','Explicitly accept possible duplicate billing for one saved successor; old unknown requests remain unchanged.');
    const acceptedUnknown=run?.authorization.acceptedUnknown??proposedAccepted;
    for(const a of acceptedUnknown){const original=existing.find(j=>j.operationId===a.operationId);if(!restartPlan||!original||original.requestHash!==a.requestHash)fail('IMAGE_RESTART_INVALID','Saved unknown acceptance no longer matches its original request.');}
    // A user may explicitly let this exact plan proceed past named older projects.
    // Preserve all old jobs/receipts/ledger entries; never acknowledge a new unknown in this project.
    const acceptedExistingUnknown=[...(run?.authorization.acceptedExistingUnknown??[])];
    const sameAcknowledgement=(a:typeof acceptedExistingUnknown[number],slot:typeof ledger.slots[number])=>
      samePath(a.root,slot.root)&&a.projectId===slot.projectId&&a.planId===slot.planId&&a.operationId===slot.operationId
      &&a.assetId===slot.assetId&&a.fingerprint===slot.fingerprint&&a.requestHash===slot.requestHash;
    for(const a of acceptedExistingUnknown){
      const slot=ledger.slots.find(s=>s.operationId===a.operationId);
      if(!slot||slot.projectId===plan.projectId||samePath(slot.root,root)||!sameAcknowledgement(a,slot))
        fail('IMAGE_SCOPE_ACK_CONFLICT','Saved acknowledgement no longer matches the exact other-project request.');
    }
    if(deps.acceptExistingUnknown!==undefined){
      if(!authorize||retryOf)fail('IMAGE_SCOPE_ACK_REQUIRED','Only images run --confirm may add an acknowledgement for this frozen plan.');
      const ids=parse(z.array(z.uuid()).min(1).max(1000),deps.acceptExistingUnknown);
      if(new Set(ids).size!==ids.length)fail('IMAGE_SCOPE_ACK_INVALID','Acknowledgement IDs must be unique.');
      for(const operationId of ids){
        const slot=ledger.slots.find(s=>s.operationId===operationId);
        const saved=acceptedExistingUnknown.find(a=>a.operationId===operationId);
        if(saved){if(!slot||!sameAcknowledgement(saved,slot))fail('IMAGE_SCOPE_ACK_CONFLICT','Acknowledged request identity changed.');continue;}
        if(!slot||slot.status!=='submit_unknown'||!slot.requestHash||slot.projectId===plan.projectId||samePath(slot.root,root))
          fail('IMAGE_SCOPE_ACK_INVALID','Name an existing unknown request in another project; current-project unknowns cannot be skipped.');
        acceptedExistingUnknown.push({root:slot.root,projectId:slot.projectId,planId:slot.planId,operationId:slot.operationId,
          assetId:slot.assetId,fingerprint:slot.fingerprint,requestHash:slot.requestHash});
      }
    }
    const unacceptedUnknown=(slot:typeof ledger.slots[number])=>slot.status==='submit_unknown'
      &&!acceptedUnknown.some(a=>slot.projectId===plan.projectId&&slot.operationId===a.operationId&&slot.requestHash===a.requestHash)
      &&!acceptedExistingUnknown.some(a=>sameAcknowledgement(a,slot));
    halt=ledger.slots.some(unacceptedUnknown);
    const retry=retryOf?existing.find(j=>j.operationId===retryOf):undefined;
    if(retryOf&&(!authorize||!retry||!['failed','rejected'].includes(retry.status)||existing.some(j=>j.retryOf===retryOf)))fail('IMAGE_RETRY_FORBIDDEN','Only a definitively failed/rejected original request can get one explicitly authorized new attempt. Unknown requests cannot retry.');
    const toStart=retryOf?1:plan.items.filter(i=>{const row=run?.items.find(r=>r.assetId===i.assetId),job=row?.operationId?existing.find(j=>j.operationId===row.operationId):undefined;return job?['prepared','waiting_dependency'].includes(job.status):i.action==='generate';}).length;
    assertKnownCapacity(profile,toStart);
    const referenceCopies=new Set<string>();
    if(toStart)for(const item of plan.items)for(const dep of item.dependencySources){if(dep.hash&&await exists(await projectPath(root,`.metasocli/image-inputs/files/${dep.hash}.image`)))continue;referenceCopies.add(dep.hash??dep.producer!);}
    await preflightSpace(root,toStart*(profile.maxResponseBytes+3*profile.maxImageBytes+256*1024)+referenceCopies.size*profile.maxImageBytes,profile.maxTempBytes-ctx.budget.used);
    if(toStart&&!halt){if(!deps.client)fail('IMAGE_CLIENT_MISSING','Configure the independent image credential before authorizing new requests.');await deps.client.prepare?.();}
    if(!run){run={schemaVersion:1,planId:id,planHash:plan.planHash,hash:'0'.repeat(64),authorization:{planHash:plan.planHash,provider:profile.provider,quotaGroup:profile.quotaGroup,maxRequests:plan.items.filter(i=>i.action==='generate').length,authorizedAt:now(),...(acceptedUnknown.length?{acceptedUnknown}:{})},
      items:plan.items.map(i=>({assetId:i.assetId,...(i.action==='generate'?{operationId:randomUUID()}:i.operationId?{operationId:i.operationId}:{}),...(i.retryOf?{retryOf:i.retryOf}:{})})),unlocks:[],status:'running',updatedAt:now()};}
    const state=run;
    if(acceptedExistingUnknown.length)state.authorization.acceptedExistingUnknown=acceptedExistingUnknown;
    if(retry){const row=state.items.find(i=>i.assetId===retry.assetId)!;if(row.retryOf!==retry.operationId||!row.operationId)row.operationId=randomUUID();row.retryOf=retry.operationId;
      await writeJson(await projectPath(root,receiptFile(row.operationId,'retry-authorization.json')),{retryOf,planHash:plan.planHash,assetId:retry.assetId,confirmedAt:now(),maxRequests:1});}
    await withImageLedger(profile,deps.runtimeRoot,async(shared,save)=>withProjectWrite(root,async()=>{
      const story=await validateImagePlan(root,plan);
      if((await listJobs(root)).some(j=>['prepared','submitting','submit_unknown'].includes(j.status)))fail('VIDEO_STAGE_ACTIVE','Video submission intent is unresolved; recover it before image preparation.');
      if(restartPlan&&restartRun){
        restartRun.replacementPlanId=id;await saveImageRun(root,restartRun);
        for(const old of existing.filter(j=>j.planId===restartPlan.planId&&['prepared','waiting_dependency','blocked'].includes(j.status)&&neverSubmittedImage(j))){
          old.status='superseded';old.error={code:'IMAGE_PLAN_REPLACED',message:'Unsubmitted original authorization replaced by one explicitly authorized successor.'};await saveImageJob(root,old);
          const slot=shared.slots.find(s=>s.operationId===old.operationId);if(slot)Object.assign(slot,imageSlot(slot.root,old));
        }
      }
      await startImageStage(root,{projectId:plan.projectId,planId:id,runtime:runtimeDirectory(deps.runtimeRoot),quotaGroup:profile.quotaGroup,token:scheduler.token,state:'active'},restartPlan?.planId);
      for(const slot of shared.slots)if(slot.projectId===plan.projectId&&!samePath(slot.root,root))fail('IMAGE_LEDGER_CONFLICT','Image project identity is registered at another directory.');
      await saveImageRun(root,state); // Persist all reserved operation IDs before their individual records.
      for(const item of plan.items){const row=state.items.find(i=>i.assetId===item.assetId)!;if(!row.operationId)continue;
        let job=existing.find(j=>j.operationId===row.operationId);
        const parent=row.retryOf?existing.find(j=>j.operationId===row.retryOf):undefined;
        let preparedAt=state.authorization.authorizedAt;
        if(row.retryOf){
          const restartParent=!!restartPlan&&item.retryOf===row.retryOf&&!!parent&&restartAncestors.has(parent.planId);
          const parentAllowed=parent&&(['failed','rejected'].includes(parent.status)||(restartParent&&(neverSubmittedImage(parent)||acceptedUnknown.some(a=>a.operationId===parent.operationId&&a.requestHash===parent.requestHash))));
          if(!parent||!parentAllowed||parent.assetId!==item.assetId||existing.some(j=>j.retryOf===parent.operationId&&j.operationId!==row.operationId))fail('IMAGE_RETRY_FORBIDDEN','A restart gets only one new authorized child of its preserved original.');
          const authPath=await projectPath(root,receiptFile(row.operationId,'retry-authorization.json'));
          if(restartParent&&!job&&!await exists(authPath))await writeJson(authPath,{retryOf:parent.operationId,planHash:plan.planHash,assetId:item.assetId,confirmedAt:state.authorization.authorizedAt,maxRequests:1,restartOf:restartPlan!.planId});
          const authorization=parse(z.object({retryOf:z.uuid(),planHash:z.string(),assetId:z.string(),confirmedAt:z.iso.datetime(),maxRequests:z.literal(1),restartOf:z.uuid().optional()}).strict(),await readJson(authPath));
          if(authorization.retryOf!==parent.operationId||authorization.assetId!==item.assetId||authorization.planHash!==plan.planHash||(restartParent&&authorization.restartOf!==restartPlan!.planId))fail('IMAGE_RETRY_FORBIDDEN','The reserved retry lacks its exact saved new-attempt authorization.');preparedAt=authorization.confirmedAt;
        }
        if(!job){if(item.action!=='generate'&&!row.retryOf)fail('IMAGE_JOB_CONFLICT','Recovery operation is missing.');
          if(existing.some(j=>{
            if(j.assetId!==item.assetId||resolvedImage(j.status))return false;
            // Keep acknowledged unknown ancestors intact while restoring one saved retry.
            const acknowledgedAncestor=!!plan.restartOf&&restartAncestors.has(j.planId)&&j.status==='submit_unknown'
              &&acceptedUnknown.some(a=>a.operationId===j.operationId&&a.requestHash===j.requestHash);
            return !acknowledgedAncestor;
          }))fail('IMAGE_ASSET_ACTIVE','Asset already has an unfinished image request.');
          job={schemaVersion:1,operationId:row.operationId,projectId:plan.projectId,planId:id,planHash:plan.planHash,assetId:item.assetId,fingerprint:item.fingerprint,attempt:parent?parent.attempt+1:1,
            ...(parent?{retryOf:parent.operationId}:{}),status:item.dependencySources.some(d=>!d.hash)?'waiting_dependency':'prepared',preparedAt};
          await deps.checkpoint?.('job-reserved',job);
          await saveImageJob(root,job);
        }
        const reservedHere=item.action==='generate'||!!row.retryOf;
        if(job.projectId!==plan.projectId||job.assetId!==item.assetId
          ||(reservedHere?(job.planId!==id||job.planHash!==plan.planHash||job.fingerprint!==item.fingerprint||job.attempt!==(parent?parent.attempt+1:1)||job.retryOf!==parent?.operationId||job.preparedAt!==preparedAt):job.operationId!==item.operationId))
          fail('IMAGE_JOB_CONFLICT','Image job does not match its saved authorization and reserved attempt.');
        const slot=shared.slots.find(s=>s.operationId===job.operationId);
        if(slot){if(!samePath(slot.root,root)||slot.projectId!==job.projectId||slot.planId!==job.planId||slot.assetId!==job.assetId||slot.fingerprint!==job.fingerprint||(slot.requestHash&&slot.requestHash!==job.requestHash))
          fail('IMAGE_LEDGER_CONFLICT','Image operation identity conflicts with its ledger.');}
        else {
          // A preparation crash can persist only part of the Jobs before the shared ledger save.
          // Repair only the exact authorized reservation, with no evidence of entering submission.
          if(!reservedHere||!['prepared','waiting_dependency'].includes(job.status)
            ||job.input||job.inputHash||job.requestHash||job.requestStartedAt||job.responseHeadersAt||job.responseSavedAt||job.receiptSavedAt||job.downloadCompletedAt||job.registeredAt||job.result||job.resolutionPath||job.recoveredManually)
            fail('IMAGE_LEDGER_CONFLICT','Missing image ledger entry is not an unsubmitted authorized reservation; preserve submission evidence.');
          shared.slots.push(imageSlot(root,job));
        }
        jobs.push(job);
      }
      await save();
    }));
    await deps.checkpoint?.('prepared',jobs[0]!);
    // Resume all accepted results first. Already returned files are useful even when an unknown halts new POSTs.
    const startRecovery=(job:ImageJobRecord)=>{
      const work=(async()=>{const lease=await acquireLease(await receiverPath(root,job.operationId));try{
        await finishExisting(root,job,job.planId===id?plan:await readImagePlan(root,job.planId),ctx);
        if(job.status==='submit_unknown')halt=true;
      }catch(e){halt=true;captureFailure(job,e);await saveImageJob(root,job);}finally{try{await updateImageSlot(root,job,profile,deps.runtimeRoot);}finally{await lease.release();}}})();
      inFlight.set(job.operationId,work.catch(()=>{halt=true;}).finally(()=>{inFlight.delete(job.operationId);completionVersion++;}));
    };
    for(const job of jobs)if(!['prepared','waiting_dependency','rejected','failed','blocked','superseded','reused'].includes(job.status))startRecovery(job);
    const dispatched=new Set<string>();
    for(;;){const scanVersion=completionVersion;await scheduler.assertOwned();
      if(!halt)for(const job of jobs){if(halt)break;if(!['prepared','waiting_dependency'].includes(job.status)||dispatched.has(job.operationId)|| (retry&&job.assetId!==retry.assetId))continue;
        const item=plan.items.find(i=>i.assetId===job.assetId)!;let lease:Awaited<ReturnType<typeof acquireLease>>|undefined;
        try {
          const ready=await withImageLedger(profile,deps.runtimeRoot,async(shared,save)=>withProjectWrite(root,async()=>{
            if(halt)return false;
            const story=await validateImagePlan(root,plan,undefined,item),input=await effectiveImageInput(root,plan,item,jobs,story,n=>ctx.budget.charge(n));if(!input)return false;
            if(halt||shared.slots.some(unacceptedUnknown)){halt=true;return false;}
            const slot=shared.slots.find(s=>s.operationId===job.operationId);
            if(!slot)fail('IMAGE_LEDGER_CONFLICT','Image reservation must be in the ledger before submission intent.');
            lease=await acquireLease(await receiverPath(root,job.operationId));
            job.input=input;job.requestHash=canonicalSha256(input);job.inputHash=canonicalSha256({fingerprint:job.fingerprint,input});job.status='submitting';job.requestStartedAt=now();
            await saveImageJob(root,job);Object.assign(slot,imageSlot(slot.root,job));await save();return true;
          }));
          if(!ready)continue;dispatched.add(job.operationId);
          for(const dep of item.dependencySources.filter(d=>!d.hash))state.unlocks.push({at:now(),dependency:dep.assetId,assets:[job.assetId]});
          await saveImageRun(root,state);await deps.checkpoint?.('intent',job);
          if(!deps.client)fail('IMAGE_CLIENT_MISSING','An authorized image submission requires its independent API credential.');
          const owner=lease!;
          const work=(async()=>{try{
            const response=await deps.client!.create(root,job.input!,profile);
            if([401,402,403,429].includes(response.status)||response.status>=500)halt=true;
            await saveImageResponse(root,job,response,profile,ctx);await receiveImage(root,job,profile,ctx);
            if(job.status==='received')await downloadImageResult(root,job,profile,ctx);
            if(job.status==='downloaded')await registerImageResult(root,job,plan,ctx);
          }catch(error){halt=true;captureFailure(job,error);await saveImageJob(root,job);}finally{try{await updateImageSlot(root,job,profile,deps.runtimeRoot);}finally{await owner.release();}}})();
          inFlight.set(job.operationId,work.catch(()=>{halt=true;}).finally(()=>{inFlight.delete(job.operationId);completionVersion++;}));
        }catch(error){halt=true;captureFailure(job,error);try{await saveImageJob(root,job);await updateImageSlot(root,job,profile,deps.runtimeRoot);}finally{await lease?.release();}}
      }
      // A dependency may have settled and removed its Promise while this scan awaited local I/O.
      // Re-scan that progress before waiting on unrelated work or deciding there is nothing left.
      if(completionVersion!==scanVersion)continue;
      if(!inFlight.size)break;await Promise.race(inFlight.values());
    }
    await Promise.allSettled(inFlight.values());
    for(const job of jobs)if(job.status==='waiting_dependency'&&plan.items.find(i=>i.assetId===job.assetId)!.dependencies.some(id=>jobs.some(j=>j.assetId===id&&['failed','rejected','blocked','superseded'].includes(j.status)))){
      job.status='blocked';job.error={code:'IMAGE_DEPENDENCY_BLOCKED',message:'A required image dependency did not register.'};await saveImageJob(root,job);await updateImageSlot(root,job,profile,deps.runtimeRoot);}
    state.status=jobs.every(j=>['registered','reused'].includes(j.status))?'complete':'needs_attention';
    await withProjectWrite(root,async()=>{await saveImageRun(root,state);await finishImageStage(root,id,jobs.every(j=>resolvedImage(j.status)));});
    if(state.status==='complete')await checkImageVideoInputs(root,plan);
    await writeImageIndex(root,plan);
    return imageStatus(root,id);
  }finally{await Promise.allSettled(inFlight.values());await scheduler.release();}
}
/** Offline validation only. A new video plan and its own authorization are still required. */
export async function checkImageVideoInputs(root:string,plan:ImagePlanRecord){
  return withProjectWrite(root,async()=>{const story=await validateImagePlan(root,plan),segments=[];
    for(const binding of plan.scope){const segment=story.episodes.find(e=>e.id===binding.episodeId)!.segments.find(s=>s.id===binding.segmentId)!;
      try{const built=await buildRequest(root,story,{...segment,parameters:{...segment.parameters,contextIr:true}});segments.push({...binding,ok:true,requestBytes:built.summary.requestBytes,requestHash:built.summary.requestHash,assets:built.summary.assets});}
      catch(error){segments.push({...binding,ok:false,assetIds:segment.references.map(r=>r.assetId),narration:segment.narration?.assetId,error:publicError(error)});}
    }
    const result={planId:plan.planId,planHash:plan.planHash,revision:story.revision,checkedAt:now(),ok:segments.every(s=>s.ok),segments};
    await writeJson(await projectPath(root,`.metasocli/image-runs/${plan.planId}-video-check.json`),result);return result;
  });
}
async function writeImageIndex(root:string,plan:ImagePlanRecord){
  const status=await imageStatus(root,plan.planId);
  const lines=['# Image results',`Plan: ${plan.planId}`, 'Provider capacity: unverified.', ''];
  for(const item of status.items){const row=item as Record<string,any>;lines.push(`- ${row.assetId} — ${row.status} — ${row.size??''} — ${row.operationId??'reused'}`);
    lines.push(`  References: ${(row.requiredBy??[]).map((b:{episodeId:string;segmentId:string})=>`${b.episodeId}/${b.segmentId}`).join(', ')}`);
    if(row.result)lines.push(`  ![${row.assetId}](../${row.result.path.replace(/^\.metasocli\//u,'')})`);
    else if(row.existingRelativePath)lines.push(`  ![${row.assetId}](../../${row.existingRelativePath})`);
  }
  await atomicWrite(await projectPath(root,`.metasocli/image-runs/${plan.planId}-index.md`),lines.join('\n'));
}
export async function imageStatus(root:string,id?:string){
  const plan=id?await readImagePlan(root,id):undefined,run=plan?await readImageRun(root,plan):undefined;
  const all=await listImageJobs(root),jobs=plan?all.filter(j=>run?.items.some(i=>i.operationId===j.operationId)):all;
  const count=(...statuses:string[])=>jobs.filter(j=>statuses.includes(j.status)).length;
  const story=await loadStory(root);
  const items=plan?plan.items.map(item=>({assetId:item.assetId,kind:item.kind,size:item.size,requestedModel:plan.profile.model,requiredBy:item.requiredBy,
    existingRelativePath:item.action==='reuse'?story.assets.find(a=>a.recipe.assetId===item.assetId)?.media?.path:undefined,
    ...(jobs.find(j=>j.operationId===run?.items.find(i=>i.assetId===item.assetId)?.operationId)??{status:item.action==='reuse'?'reused':item.action==='blocked'?'blocked':'prepared'})})):jobs;
  const checkFile=id?await projectPath(root,`.metasocli/image-runs/${id}-video-check.json`):undefined;
  return {videoCheck:checkFile&&await exists(checkFile)?await readJson(checkFile):undefined,indexPath:id?`.metasocli/image-runs/${id}-index.md`:undefined,planId:id,planHash:plan?.planHash,submissionMode:'all-ready',providerCapacity:plan?.profile.providerLimits??'unknown; not verified',run,
    summary:{total:plan?.items.length??jobs.length,reused:plan?.items.filter(i=>i.action==='reuse').length??count('reused'),waitingDependency:count('waiting_dependency'),notStarted:count('prepared'),
      started:jobs.filter(j=>j.requestStartedAt).length,inFlight:count('submitting'),received:count('received','downloaded','registered'),registered:count('registered'),rejected:count('rejected'),unknown:count('submit_unknown')},items};
}
export async function recoverImage(root:string,id:string,deps:ImageDependencies={}){
  const job=await readImageJob(root,id),plan=await readImagePlan(root,job.planId),ctx=context(plan,deps,await diskUsage(root));
  const lease=await acquireLease(await receiverPath(root,id));
  try{Object.assign(job,await readImageJob(root,id));await finishExisting(root,job,plan,ctx);return job;}catch(error){captureFailure(job,error);await saveImageJob(root,job);return job;}
  finally{try{await updateImageSlot(root,job,plan.profile,deps.runtimeRoot);}finally{await lease.release();}}
}
export async function attachImageResult(root:string,id:string,file:string,hash:string,confirmed:boolean,deps:ImageDependencies={}){
  if(!confirmed)fail('IMAGE_RESULT_LINK_REQUIRED','Confirm that the recovered file is the original request result.');
  const job=await readImageJob(root,id),plan=await readImagePlan(root,job.planId),ctx=context(plan,deps,await diskUsage(root));
  const lease=await acquireLease(await receiverPath(root,id));
  try{Object.assign(job,await readImageJob(root,id));if(!job.requestHash||!job.input||!['submit_unknown','received','response_saved'].includes(job.status))fail('IMAGE_RESULT_LINK_CONFLICT','Only a submitted unresolved/missing result can be linked.');
    const bytes=await readStable(file,plan.profile.maxImageBytes);const {sha256Hex}=await import('../storage/canonical.js');if(sha256Hex(bytes)!==hash)fail('ASSET_CHANGED','Manual result hash differs.');
    job.result=await saveResultBytes(root,job,bytes,plan.profile,ctx);job.recoveredManually=true;job.status='downloaded';job.downloadCompletedAt=now();
    await writeJson(await projectPath(root,receiptFile(id,'manual-link.json')),{operationId:id,requestHash:job.requestHash,sha256:hash,recoveredManually:true,confirmedAt:now()});
    await saveImageJob(root,job);await registerImageResult(root,job,plan,ctx);return job;
  }finally{try{await updateImageSlot(root,job,plan.profile,deps.runtimeRoot);}finally{await lease.release();}}
}
export async function resolveImage(root:string,id:string,outcome:string,evidence:unknown,confirmed:boolean,deps:ImageDependencies={}){
  if(!confirmed)fail('IMAGE_RESOLUTION_REQUIRED','Explicit confirmation of provider non-creation/termination evidence is required.');
  const record=parse(z.object({operationId:z.uuid(),requestHash:z.string(),outcome:z.enum(['not-created','failed']),source:z.object({kind:z.enum(['provider-support','provider-request-log','provider-api-response']),reference:z.string().min(1).max(2000),statement:z.string().min(10).max(8000)}).strict()}).strict(),evidence);
  const job=await readImageJob(root,id),plan=await readImagePlan(root,job.planId);
  const lease=await acquireLease(await receiverPath(root,id));
  try{Object.assign(job,await readImageJob(root,id));if(job.status!=='submit_unknown'||record.operationId!==id||record.requestHash!==job.requestHash||record.outcome!==outcome)fail('IMAGE_RESOLUTION_CONFLICT','Evidence must identify this unresolved request and outcome.');
    let providerResponse:{httpStatus:number;errorCode:string;bodySha256:string}|undefined;
    if(record.source.kind==='provider-api-response'){
      const receipt=await readBodyReceipt(root,job);
      if(!receipt||record.source.reference!==receiptFile(id,'complete.json'))fail('IMAGE_RESOLUTION_UNPROVEN','Provider response does not prove this request terminated.');
      const bytes=await readStable(await projectPath(root,receipt.path),plan.profile.maxResponseBytes);let body:unknown;
      try{body=JSON.parse(bytes.toString('utf8'));}catch{}
      const error=z.object({error:z.object({code:z.string(),type:z.string(),message:z.string().min(1)}).passthrough()}).passthrough().safeParse(body);
      const interrupted=error.success&&receipt.httpStatus===503&&outcome==='failed'&&error.data.error.code==='task_interrupted'&&error.data.error.type==='server_error';
      const rejectedEdit=error.success&&receipt.httpStatus===500&&outcome==='not-created'&&job.input?.route==='/v1/images/edits'&&!!job.input.references.length&&error.data.error.code==='convert_request_failed'&&error.data.error.type==='new_api_error'&&error.data.error.message.startsWith('image is required');
      const policyRefused=error.success&&receipt.httpStatus===400&&outcome==='failed'&&error.data.error.type==='invalid_request_error'&&error.data.error.code==='upstream_text_reply'&&(error.data.error.message.includes('内容政策')||error.data.error.message.toLowerCase().includes('content policy'));
      if(sha256Hex(bytes)!==receipt.sha256||!error.success||(!interrupted&&!rejectedEdit&&!policyRefused))fail('IMAGE_RESOLUTION_UNPROVEN','Only intact, explicitly terminated or pre-generation rejected provider responses can resolve unknown requests.');
      providerResponse={httpStatus:receipt.httpStatus,errorCode:error.data.error.code,bodySha256:receipt.sha256};
    }
    job.resolutionPath=receiptFile(id,'resolution.json');await writeJson(await projectPath(root,job.resolutionPath),{...record,confirmedAt:now(),reportedBy:providerResponse?'provider-api-response':'user',independentlyVerified:!!providerResponse,...(providerResponse?{providerResponse}:{})});
    job.status=outcome==='not-created'?'rejected':'failed';delete job.error;await saveImageJob(root,job);return job;
  }finally{try{await updateImageSlot(root,job,plan.profile,deps.runtimeRoot);}finally{await lease.release();}}
}
