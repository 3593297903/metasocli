import { randomUUID } from 'node:crypto';
import { parse } from '../contracts/story.js';
import { fail, isCode } from '../core/errors.js';
import { loadStory } from '../core/project.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { exists, projectPath } from '../storage/paths.js';
import { readJson, readStable, writeJson } from '../storage/io.js';
import { ImageReceipt, type ImageJobRecord, type ImagePlanRecord } from './contracts.js';
import { imageStatus } from './run.js';
import { imagePath, readBodyReceipt, readImageJob, readImagePlan, readImageRun, receiptFile } from './store.js';
import { validateImagePlan } from './planning.js';
import { preparedPlan, preparationDirectory, readPreparation, validatePreparationHandoffs, validatePreparedContent } from './preparation.js';
import { checkPython, validateHandoff } from './handoff.js';
import { WorkflowTimer } from './workflow-timing.js';
import type { CollectOptions } from './workflow-contracts.js';

type StatusResult=Awaited<ReturnType<typeof imageStatus>>;
type SummarySnapshot=Omit<StatusResult,'items'>&{items:StatusResult['items'][number][]};
export function imageBlockerCategory(code:string){
  if(/COORDINATOR|CONFLICT|TAMPERED/u.test(code))return 'coordination_corrupt';
  if(/LOCK|SCHEDULER/u.test(code))return 'current_project_process';
  if(/UNKNOWN/u.test(code))return 'current_project_unknown';
  if(/CAPACITY/u.test(code))return 'shared_capacity';
  if(/STALE|CHANGED|SUPERSEDED/u.test(code))return 'input_changed';
  if(/DEPENDENCY/u.test(code))return 'asset_dependency';
  return 'other';
}
/** Pure projection of the existing status snapshot. No second execution or authorization path. */
export function compactImageStatus(status:SummarySnapshot,projectId:string,preparationId?:string,plan?:ImagePlanRecord) {
  const counts={total:status.items.length,reused:0,notStarted:0,waitingDependency:0,submitting:0,responseSaved:0,pendingDownload:0,pendingRegistration:0,registered:0,failed:0,rejected:0,unknown:0,blocked:0,superseded:0};
  const mapping:Record<string,keyof typeof counts>={reused:'reused',prepared:'notStarted',waiting_dependency:'waitingDependency',submitting:'submitting',response_saved:'responseSaved',received:'pendingDownload',downloaded:'pendingRegistration',registered:'registered',failed:'failed',rejected:'rejected',submit_unknown:'unknown',blocked:'blocked',superseded:'superseded'};
  const issues:{assetId:string;operationId:string|null;status:string;code:string}[]=[],files:{assetId:string;operationId:string|null;path:string;sha256?:string}[]=[];
  const timings:Record<string,unknown>[]=[];
  for(const item of status.items){const original=item as ImageJobRecord&{existingRelativePath?:string};
    const frozen=plan?.items.find(i=>i.assetId===original.assetId);
    const row=!original.operationId&&original.status==='prepared'&&frozen?.dependencySources.some(d=>!d.hash)?{...original,status:'waiting_dependency' as const}:original;
    const key=mapping[row.status];if(key)counts[key]++;
    if(row.error||['submit_unknown','blocked','failed','rejected','waiting_dependency','superseded'].includes(row.status))issues.push({assetId:row.assetId,operationId:row.operationId??null,status:row.status,code:row.error?.code??row.status});
    if(row.status==='registered'&&row.result)files.push({assetId:row.assetId,operationId:row.operationId,path:row.result.path,sha256:row.result.sha256});
    if(row.status==='reused'&&row.existingRelativePath)files.push({assetId:row.assetId,operationId:null,path:row.existingRelativePath});
    if(row.operationId)timings.push({assetId:row.assetId,operationId:row.operationId,requestStartedAt:row.requestStartedAt??null,responseHeadersAt:row.responseHeadersAt??null,responseSavedAt:row.responseSavedAt??null,downloadCompletedAt:row.downloadCompletedAt??null,registeredAt:row.registeredAt??null,
      localStartToHeadersMs:row.requestStartedAt&&row.responseHeadersAt?Date.parse(row.responseHeadersAt)-Date.parse(row.requestStartedAt):null});
  }
  const blockers:string[]=[];
  if(counts.unknown)blockers.push('current_project_unknown');if(counts.waitingDependency)blockers.push('asset_dependency');
  if(status.run?.waiting)blockers.push('shared_capacity');
  if(issues.some(i=>/STALE|CHANGED|SUPERSEDED/u.test(i.code)))blockers.push('input_changed');
  if(issues.some(i=>/COORDINATOR|CONFLICT|TAMPERED/u.test(i.code)))blockers.push('coordination_corrupt');
  if(issues.some(i=>/LOCK_BUSY/u.test(i.code)))blockers.push('current_project_process');
  const observed=timings as {requestStartedAt:string|null;responseHeadersAt:string|null;responseSavedAt:string|null;registeredAt:string|null}[];
  const range=(key:'requestStartedAt'|'responseHeadersAt'|'responseSavedAt'|'registeredAt')=>{const values=observed.map(r=>r[key]).filter((s):s is string=>s!==null).sort();return {first:values[0]??null,last:values.at(-1)??null,observations:values.length};};
  return {schemaVersion:1,preparationId:preparationId??null,projectId,planId:status.planId,sampledAt:new Date().toISOString(),
    status:status.run?.status??'prepared',counts,blockers,issues:issues.slice(0,50),issueCount:issues.length,issuesTruncated:issues.length>50,
    files:files.slice(0,50),fileCount:files.length,filesTruncated:files.length>50,indexPath:status.indexPath,
    records:{plan:`.metasocli/image-plans/${status.planId}.json`,run:`.metasocli/image-runs/${status.planId}.json`,jobs:'.metasocli/image-jobs',
      timing:preparationId?`${preparationDirectory(preparationId)}/timings.json`:null},
    timing:{note:'requestStartedAt is local intent, not provider acceptance; null means no observed headers. Concurrent durations must not be summed.',observedRanges:{requestStartedAt:range('requestStartedAt'),responseHeadersAt:range('responseHeadersAt'),responseSavedAt:range('responseSavedAt'),registeredAt:range('registeredAt')},items:timings.slice(0,50),total:timings.length}};
}
export async function imageSummary(root:string,planId:string,status?:StatusResult){
  const plan=await readImagePlan(root,planId),snapshot=await resolveImageSnapshot(root,plan,status);
  return compactImageStatus(snapshot.status,plan.projectId,undefined,plan);
}
/** Read only: a recover item may reference a job owned by an older frozen plan. */
async function resolveImageSnapshot(root:string,plan:ImagePlanRecord,existing?:StatusResult){
  const status=existing??await imageStatus(root,plan.planId),jobs=new Map<string,ImageJobRecord>();
  if(status.planId!==plan.planId||status.planHash!==plan.planHash||(await loadStory(root)).projectId!==plan.projectId)
    fail('IMAGE_JOB_CONFLICT','Summary snapshot does not belong to this project/plan.');
  for(const item of plan.items){
    const op=status.run?status.run.items.find(i=>i.assetId===item.assetId)?.operationId:item.action==='recover'?item.operationId:undefined;
    if(!op){if(item.action==='recover')fail('IMAGE_JOB_CONFLICT',`Recover item has no operation identity: ${item.assetId}.`);continue;}
    if(!await exists(await imagePath(root,'image-jobs',op)))fail('IMAGE_JOB_MISSING',`Referenced image job is missing: ${item.assetId}, ${op}.`);
    const job=await readImageJob(root,op);
    if(job.projectId!==plan.projectId||job.assetId!==item.assetId||job.fingerprint!==item.fingerprint)
      fail('IMAGE_JOB_CONFLICT',`Referenced job does not match its frozen asset: ${item.assetId}, ${op}.`);
    jobs.set(item.assetId,job);
  }
  return {jobs,status:{...status,items:status.items.map(item=>jobs.get(item.assetId)??item)}};
}
interface RecipeItem {assetId:string;kind:string;status:string;generationPrompt:string|null;recipeSha256:string|null;existingRelativePath:string|null;contentSha256:string|null;reason:string|null}
interface EpisodeCollection {episodeId:string;resultPath:string|null;items:{assetId:string;status:string;operationId:string|null;reason:string|null;path:string|null}[]}
interface CollectionReport {schemaVersion:1;preparationId:string;planId:string;projectId:string;collectionId:string;sampledAt:string;complete:boolean;episodes:EpisodeCollection[];summary:ReturnType<typeof compactImageStatus>;reportPath:string;timingsPath:string}
export async function collectImages(root:string,options:CollectOptions):Promise<CollectionReport> {
  await checkPython(options.python);
  // Retry only a moving local sample. Never recover/download/register or create a job here.
  for(let attempt=0;;attempt++){
    try{return await collectSnapshot(root,options);}catch(error){if(!isCode(error,'IMAGE_COLLECTION_CHANGED')||attempt>=2)throw error;}
  }
}
async function collectSnapshot(root:string,options:CollectOptions):Promise<CollectionReport> {
  const timer=new WorkflowTimer(),input=await readPreparation(root,options.preparation),plan=await preparedPlan(root,input);
  await validatePreparedContent(root,input);await validateImagePlan(root,plan);
  await timer.measure('handoff-validation',()=>validatePreparationHandoffs(root,input,options.python));
  const collectionId=randomUUID(),base=`${preparationDirectory(input.preparationId)}/collections/${collectionId}`,watched=new Map<string,string>();
  const watch=async(path:string,limit?:number)=>{const bytes=await readStable(await projectPath(root,path),limit);watched.set(path,sha256Hex(bytes));return bytes;};
  const unchanged=async()=>{
    for(const [path,hash] of watched){
      const limit=path.endsWith('response.bin')?plan.profile.maxResponseBytes:Math.max(8*1024*1024,plan.profile.maxImageBytes);
      if(!await exists(await projectPath(root,path))||sha256Hex(await readStable(await projectPath(root,path),limit))!==hash)
        fail('IMAGE_COLLECTION_CHANGED','Execution changed while sampling; recollect without modifying jobs.');
    }
  };
  await watch('metasocli.yaml');
  const snapshot=await resolveImageSnapshot(root,plan),run=snapshot.status.run;
  if(run){const bytes=await watch(`.metasocli/image-runs/${plan.planId}.json`);if(canonicalSha256(JSON.parse(bytes.toString('utf8')))!==canonicalSha256(run))fail('IMAGE_COLLECTION_CHANGED','Run changed while opening the snapshot.');}
  const story=await loadStory(root),episodes:EpisodeCollection[]=[],pending:{path:string;result:unknown}[]=[];
  await timer.measure('result-evidence',async()=>{
    for(const entry of input.entries){
      const recipe=await readJson(await projectPath(root,entry.recipe.path)) as {assets:RecipeItem[]},assets:unknown[]=[],items:EpisodeCollection['items']=[];let complete=true;
      for(const item of recipe.assets){
        const frozen=plan.items.find(i=>i.assetId===item.assetId),job=snapshot.jobs.get(item.assetId),op=job?.operationId;
        if(job){
          const bytes=await watch(`.metasocli/image-jobs/${job.operationId}.json`);if(canonicalSha256(JSON.parse(bytes.toString('utf8')))!==canonicalSha256(job))fail('IMAGE_COLLECTION_CHANGED','Job changed while opening the snapshot.');
          const sourcePlan=await readImagePlan(root,job.planId),sourceBytes=await watch(`.metasocli/image-plans/${job.planId}.json`);
          if(sourcePlan.planHash!==job.planHash||canonicalSha256(JSON.parse(sourceBytes.toString('utf8')))!==canonicalSha256(sourcePlan))fail('IMAGE_COLLECTION_CHANGED','Source plan changed while opening the snapshot.');
        }
        const row={assetId:item.assetId,status:job?.status??(frozen?.action==='reuse'?'reused':frozen?.action==='blocked'?'blocked':frozen?'not_started':'outside_scope'),operationId:op??null,reason:null as string|null,path:null as string|null};
        const result:Record<string,unknown>={assetId:item.assetId,kind:item.kind,status:'blocked',operationId:null,stagedRelativePath:null,existingRelativePath:null,contentSha256:null,generationPrompt:null,recipeSha256:null,generationMode:'not_run',reportedModel:null,reason:null,requestedModel:null,executionRelativePath:null,executionSha256:null};
        if(item.status==='skipped_optional'){result.status='skipped_optional';row.status='skipped_optional';}
        else if(!frozen){complete=false;row.reason='outside_frozen_scope';}
        else if(item.status==='reused'&&frozen.action==='reuse'){
          const media=story.assets.find(a=>a.recipe.assetId===item.assetId)?.media;
          if(!media||media.path!==item.existingRelativePath||media.sha256!==item.contentSha256||sha256Hex(await watch(media.path,plan.profile.maxImageBytes))!==item.contentSha256)fail('IMAGE_COLLECTION_EVIDENCE','Reused file no longer matches the original recipe decision.');
          Object.assign(result,{status:'reused',existingRelativePath:media.path,contentSha256:media.sha256});row.path=media.path;
        }else if(item.status==='planned'&&job?.status==='registered'&&job.result&&job.input){
          const executionPath=receiptFile(job.operationId,'execution.json');
          if(!await exists(await projectPath(root,executionPath))){complete=false;row.reason='execution_evidence_pending';}
          else {
            const executionBytes=await watch(executionPath),receiptPath=receiptFile(job.operationId,'receipt.json');
            const receipt=await exists(await projectPath(root,receiptPath))?parse(ImageReceipt,JSON.parse((await watch(receiptPath)).toString('utf8'))):undefined;
            const media=story.assets.find(a=>a.recipe.assetId===item.assetId)?.media;
            if(!media||media.sha256!==job.result.sha256||sha256Hex(await watch(media.path,plan.profile.maxImageBytes))!==job.result.sha256)fail('IMAGE_COLLECTION_EVIDENCE','Registered result no longer matches the formal asset.');
            if(sha256Hex(await watch(job.result.path,plan.profile.maxImageBytes))!==job.result.sha256)fail('IMAGE_COLLECTION_EVIDENCE','Original staged result bytes changed.');
            await watch(job.input.promptPath);
            const body=await readBodyReceipt(root,job);
            if(body){await watch(receiptFile(job.operationId,'complete.json'));if(sha256Hex(await watch(body.path,plan.profile.maxResponseBytes))!==body.sha256||receipt&&receipt.bodyHash!==body.sha256)fail('IMAGE_COLLECTION_EVIDENCE','Original response receipt bytes changed.');}
            if(!body&&!job.recoveredManually)fail('IMAGE_COLLECTION_EVIDENCE','Registered API result has no complete response evidence.');
            Object.assign(result,{status:'generated',operationId:job.operationId,stagedRelativePath:job.result.path,contentSha256:job.result.sha256,
              generationPrompt:item.generationPrompt,recipeSha256:item.recipeSha256,generationMode:'api',requestedModel:job.input.model,reportedModel:receipt?.reportedModel??null,
              executionRelativePath:executionPath,executionSha256:sha256Hex(executionBytes)});row.path=job.result.path;
          }
        }else if(item.status==='planned'&&job&&['failed','rejected'].includes(job.status)&&job.requestStartedAt){
          Object.assign(result,{status:'failed',generationMode:'api',reason:`${job.status}: ${job.error?.code??'known_terminal'}`});
        }else if((item.status==='blocked'||item.status==='planned')&&frozen.action==='blocked'&&!job){
          result.reason=frozen.reason??item.reason??'blocked_before_submission';
        }else {complete=false;row.reason=job?.error?.code??'not_representable_as_final_handoff';}
        items.push(row);assets.push(result);
      }
      const resultPath=complete?`${base}/${entry.episodeId}/reference-image-result.json`:null;
      if(resultPath){
        const result={schemaVersion:'1.1.0',episodeId:entry.episodeId,assets},candidate=`${base}/${entry.episodeId}/candidate.json`;
        await writeJson(await projectPath(root,candidate),result);
        try{await validateHandoff('result',await projectPath(root,candidate),await projectPath(root,entry.request.path),await projectPath(root,entry.recipe.path),root,options.python);}
        catch(error){await unchanged();throw error;}
        pending.push({path:resultPath,result});
      }
      episodes.push({episodeId:entry.episodeId,resultPath,items});
    }
  });
  await options.checkpoint?.('collection-sampled');
  const summary=compactImageStatus(snapshot.status,plan.projectId,input.preparationId,plan);
  await unchanged();await readPreparation(root,input.preparationId);
  const currentRun=await readImageRun(root,plan);if(canonicalSha256(currentRun??null)!==canonicalSha256(run??null))fail('IMAGE_COLLECTION_CHANGED','Run index changed during collection.');
  const report:CollectionReport={schemaVersion:1,preparationId:input.preparationId,planId:plan.planId,projectId:plan.projectId,collectionId,sampledAt:new Date().toISOString(),complete:episodes.every(e=>e.resultPath!==null),episodes,summary,reportPath:`${base}/collection-report.json`,timingsPath:`${base}/timings.json`};
  await timer.measure('result-export',async()=>{
    for(const row of pending)await writeJson(await projectPath(root,row.path),row.result);
    await writeJson(await projectPath(root,report.reportPath),report);
    await writeJson(await projectPath(root,`${preparationDirectory(input.preparationId)}/latest-collection.json`),{collectionId,reportPath:report.reportPath});
  });
  await timer.save(root,report.timingsPath);return report;
}
