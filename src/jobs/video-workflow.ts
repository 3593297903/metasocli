import { scopedEvidence } from './batch-evidence.js';
import { resolve } from 'node:path';
import { canonicalSha256 } from '../storage/canonical.js';
import { withProjectWrite } from '../storage/locking.js';
import { projectPath } from '../storage/paths.js';
import { writeJson } from '../storage/io.js';
import { loadStory } from '../core/project.js';
import { loadPlan, validatePlan } from '../core/planning.js';
import { fail, publicError, MetasoError } from '../core/errors.js';
import { runBatch, parseBatchOptions, type BatchOptions } from './batch.js';
import { BatchInspection, batchStatus, loadBatch, loadBatchRun } from './batch-store.js';
import type { JobDependencies } from './submit.js';
import { resume } from './resume.js';
import { frozenScope, resolveVideoScope, type VideoScope, type WorkflowCheckpoint } from './video-scope.js';
import { verifyAv, type AvCommand } from './video-av.js';
import { localVideoIssue, outputVersion } from './video.js';

export interface VideoWorkflowDependencies extends JobDependencies {
  workflowCheckpoint?: WorkflowCheckpoint;
  avCommand?: AvCommand;
}
type Snapshot = Awaited<ReturnType<typeof batchStatus>>;
type Version = Awaited<ReturnType<typeof frozenScope>>;
interface Input extends VideoScope { batch?:string; confirm:boolean; verifyAv:boolean; options:BatchOptions }

async function current(root:string, frozen:Version) {
  const story = await loadStory(root);
  return story.revision===frozen.revision && canonicalSha256(story)===frozen.manifestHash;
}
async function matchesObservation(root:string, snapshot:Snapshot, inspection:BatchInspection) {
  if ((await loadBatchRun(root,snapshot.plan))?.hash !== snapshot.run?.hash) return false;
  if((await scopedEvidence(root,snapshot.plan,snapshot.run)).hash!==inspection.evidenceHash)return false;
  for (const [order, version] of inspection.outputVersions) {
    if (await outputVersion(root,snapshot.items[order]!.job!) !== version) return false;
  }
  return true;
}
function itemReason(snapshot:Snapshot, order:number, stale:boolean) {
  const item = snapshot.items[order]!, job=item.job;
  if (item.outputError) return stale ? item.outputIssue : item.outputError;
  if (stale && !job?.taskId) return 'PLAN_STALE';
  const saved=snapshot.run?.items[order]?.error?.code;
  if (saved) return saved;
  if (job?.lastError) return job.lastError.code;
  if (!job || job.status==='prepared') {
    if (snapshot.run?.authorization.retryOnly && !snapshot.run.authorization.retryOnly.includes(job?.operationId ?? '')) return 'RETRY_ONLY_SCOPE';
    return snapshot.run?.trace.findLast(t=>['image-stage-pause','waiting-shared-capacity','capacity-wait-budget-ended','waiting-capacity-no-queryable-tasks','rate-budget-exhausted'].includes(t.event))?.event ?? 'PENDING';
  }
  return job.status;
}

interface RecoveryIssue {code:string; jobHash:string; outputVersion:string}
async function delivery(root:string, snapshot:Snapshot, inspection:BatchInspection, frozen:Version, input:Input, deps:VideoWorkflowDependencies, blocker?:{code:string;message:string},issues=new Map<string,RecoveryIssue>()) {
  // Verify only scoped outputs. Keep decoding outside write locks. A changed formal
  // snapshot is resampled instead of letting an earlier writer replace a later report.
  for (let attempt=0; attempt<3; attempt++) {
    const stale = !await current(root,frozen);
    const segments=[];
    for (const item of snapshot.items) {
      const output=inspection.outputs.get(item.order), job=item.job;
      const issue=job && issues.get(job.operationId);
      const sameIssue=issue && job && issue.jobHash===canonicalSha256(job) && issue.outputVersion===await outputVersion(root,job);
      if(sameIssue)inspection.outputVersions.set(item.order,issue.outputVersion);
      const av=output && input.verifyAv ? await verifyAv(await projectPath(root,output.path),output,deps.avCommand) : undefined;
      segments.push({order:item.order,episodeId:item.episodeId,segmentId:item.segmentId,status:job?.status ?? 'pending',
        operationId:job?.operationId ?? null,taskId:job?.taskId ?? null,
        sourcePlanId:job?.planId??null,sourcePlanHash:job?.planHash??null,
        output:output ? {...output,path:resolve(root,output.path)} : null,
        ...(job?.output && item.outputError?{expectedFile:resolve(root,job.output.path),expectedSha256:job.output.sha256,
          recoveryNote:item.outputIssue==='OUTPUT_RECEIPT_INVALID'?'Preserve and repair the invalid download receipt before recovering the original file.':'Preserve the damaged bytes. Restore the verified file or move it aside before downloading the same task.'}:{}),
        reason:av?.reason ?? (output ? null : blocker?.code ?? (sameIssue?issue.code:undefined) ?? itemReason(snapshot,item.order,stale)),
        ...(av?{av}:{}), ...(!output && job?.taskId && (stale || item.outputError) ? {recover:job.status==='downloaded'
          ? ['download','--root',root,'--operation',job.operationId,'--redownload-missing']
          : ['resume','--root',root,'--operation',job.operationId]} : {})});
    }
    const counts=snapshot.summary, complete=counts.reusable===counts.total;
    const prepared=!input.confirm && !stale && !snapshot.run && snapshot.items.every(i=>!i.job);
    const state=complete && segments.every(s=>!s.av || s.av.passed) ? 'complete' : prepared ? 'prepared' : 'partial';
    const data={schemaVersion:1,mode:input.confirm?'execute':'local',state,projectId:snapshot.plan.projectId,
      batchId:snapshot.plan.batchId,batchHash:snapshot.plan.batchHash,scopeHash:frozen.scopeHash,revision:frozen.revision,manifestHash:frozen.manifestHash,
      counts,segments,generationState:snapshot.run?.status ?? null,
      ...(stale && snapshot.items.some(i=>!i.job?.taskId) && !complete ? {error:{code:'PLAN_STALE',message:'Freeze a new batch for current inputs. Recover listed accepted tasks by their original operation IDs.'}} : {}),
      ...(blocker && !complete ? {error:blocker} : {})};
    if (prepared) return {exitCode:0,data};
    const file='.metasocli/batches/'+snapshot.plan.batchId+'/delivery-v1.json';
    let writing=false;
    try {
      await deps.workflowCheckpoint?.('video-delivery-before-write',snapshot.plan.batchId);
      const published = await withProjectWrite(root,async assertOwned=>{
        const stillCurrent = await current(root,frozen);
        if (stillCurrent === stale || !await matchesObservation(root,snapshot,inspection)) return false;
        await assertOwned();
        const target=await projectPath(root,file);
        writing=true;
        await writeJson(target,data);
        writing=false;
        return true;
      });
      if (published) {
        await deps.workflowCheckpoint?.('video-delivery-saved',snapshot.plan.batchId);
        return {exitCode:state==='complete'?0:2,data:{...data,deliveryPath:resolve(root,file)}};
      }
    } catch (error) {
      if(!writing || error instanceof MetasoError)throw error;
      return {exitCode:2,data:{...data,state:'delivery_incomplete',error:{code:'DELIVERY_WRITE_FAILED',detail:publicError(error).code},
        recovery:['video','execute','--root',root,'--batch',snapshot.plan.batchId]}};
    }
    if (attempt===2) return {exitCode:2,data:{...data,state:'delivery_incomplete',error:{code:'DELIVERY_CHANGED'}}};
    snapshot=await batchStatus(root,snapshot.plan.batchId,inspection);
  }
  return fail('DELIVERY_CHANGED','The formal state changed during delivery.');
}

export async function executeVideo(root:string,input:Input,deps:VideoWorkflowDependencies) {
  if ([input.batch,input.selection,input.episodes].filter(v=>v!==undefined).length!==1) fail('BATCH_SCOPE','Use exactly one of --batch, --selection or --episodes.');
  if (input.batch!==undefined && (input.concurrency!==undefined || input.expectScope!==undefined)) fail('CLI_ARGUMENT','A batch ID already fixes the scope and concurrency.');
  if (input.batch===undefined && input.confirm && input.expectScope===undefined) fail('VIDEO_SCOPE_REQUIRED','Prepare the scope first and use its batchId or --expect-scope.');
  const options=parseBatchOptions(input.options);
  const plan=input.batch===undefined ? await resolveVideoScope(root,input,deps.workflowCheckpoint) : await loadBatch(root,input.batch);
  const frozen=await frozenScope(root,plan), inspection=new BatchInspection();
  const issues=new Map<string,RecoveryIssue>();
  let snapshot=await batchStatus(root,plan.batchId,inspection);
  const unfinishedLink = snapshot.run?.trace.some(choice => {
    if (choice.event !== 'batch-retry-linked' || choice.order === undefined || !choice.operationId) return false;
    const original = snapshot.items[choice.order]?.job;
    return original?.operationId === choice.detail && (original?.status === 'failed' || original?.status === 'cancelled')
      && !snapshot.retries.some(grant => grant.newOperationId === choice.operationId && grant.phase === 'original_recovered');
  });
  const finishedFailures=snapshot.run?.status==='partial_failed' && snapshot.summary.reusable+snapshot.summary.failed===snapshot.summary.total &&
    !unfinishedLink && !snapshot.run.items.some(i=>i.retryOf);
  if (input.confirm && snapshot.summary.reusable!==snapshot.summary.total && !finishedFailures) {
    if (await current(root,frozen)) {
      try {
        // A material file can change on disk without a manifest revision. Check all
        // parents with eligible new work before the first dispatch, including later
        // episodes in a selector. submit still validates again under its own guard.
        const restricted = snapshot.run?.authorization.retryOnly;
        const pendingParents = new Set(snapshot.items.filter(item => {
          if (restricted && (!item.job || !restricted.includes(item.job.operationId))) return false;
          return !item.job || item.job.status === 'prepared' || !!snapshot.run?.items[item.order]?.retryOf;
        }).map(item => item.planId));
        for (const parentId of pendingParents) await validatePlan(root, await loadPlan(root,parentId));
        snapshot=await runBatch(root,plan.batchId,'first-run',{...deps,onStart:async()=>deps.workflowCheckpoint?.('video-authorization-saved',plan.batchId)},options,inspection);
      } catch (error) {
        if (!(error instanceof MetasoError) || !['IMAGE_STAGE_ACTIVE','LOCK_BUSY','SCHEDULER_BUSY','LEGACY_SCHEDULER_BUSY','CAPACITY_FULL','PLAN_STALE','ASSET_CHANGED','SOURCE_CHANGED'].includes(error.code)) throw error;
        snapshot=await batchStatus(root,plan.batchId,inspection);
        return delivery(root,snapshot,inspection,frozen,input,deps,publicError(error));
      }
    } else if (snapshot.items.every(i=>i.job?.taskId)) {
      // A stale all-accepted batch can only observe/download its original IDs.
      // A mixed stale batch instead returns per-operation recovery commands.
      for (const item of snapshot.items) {
        if (inspection.outputs.has(item.order) || ['failed','cancelled'].includes(item.job!.status)) continue;
        const job=item.job!;
        if(item.outputIssue && item.outputIssue!=='OUTPUT_MISSING')continue; // preserve existing corrupt evidence
        try {
          const result=await resume(root,job.operationId,deps,{maxPolls:options.maxPolls,pollIntervalMs:options.pollIntervalMs,redownloadMissing:true,strictDelivery:true});
          if(result.lastError && !localVideoIssue(result.lastError.code)){
            if(result.lastError.code==='QUERY_CONTRACT')fail(result.lastError.code,result.lastError.message);
            break; // preserve the query/account/unknown halt; do not poll subsequent segments
          }
        } catch(error) {
          const code=publicError(error).code;
          if(!localVideoIssue(code))throw error;
          issues.set(job.operationId,{code,jobHash:canonicalSha256(job),outputVersion:await outputVersion(root,job)});
        }
      }
      snapshot=await batchStatus(root,plan.batchId,inspection);
    }
  }
  return delivery(root,snapshot,inspection,frozen,input,deps,undefined,issues);
}
