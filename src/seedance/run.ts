import { z } from 'zod';
import { loadStory } from '../core/project.js';
import { readEpisodeSource } from '../core/planning.js';
import { acquireVideoStage } from '../images/phase.js';
import { fail, isCode, publicError } from '../core/errors.js';
import { parse } from '../contracts/story.js';
import { downloadVideo, reconcileOutput } from '../jobs/video.js';
import { verifyAv } from '../jobs/video-av.js';
import { projectPath } from '../storage/paths.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { ApiError, SeedClient, encodeRequest } from './client.js';
import { capacity } from './capacity.js';
import { Model, resolution, verifiedFiles, type Request } from './request.js';
import { batchAttempt, batchAuthorized, currentRequest, deliveryAttempt, frozenItem, initial, lockRequests, matchesEntry, prepare, readPlan, receipt, save, seedOperation, stateFor, type Entry, type State, type SeedPlan } from './store.js';
import { correctedRetry, matchedHeads, renderPair } from './compatibility.js';
import { TaskId } from '../contracts/task.js';
import { redact } from '../metaso/client.js';

type Options={batch?:string;model?:string;episodes?:string[];selection?:unknown;concurrency?:number;expectScope?:string;
  confirm:boolean;verifyAv:boolean;runtime?:string;pollIntervalMs?:number;maxPolls?:number;operation?:string;observeOnly?:boolean;retryOf?:string;acceptUnknown?:boolean;
  capacityWaitMs?:number;capacityPollMs?:number};
type Result={state:'done'|'poll'|'capacity'|'download'; delay?:number; error?:{code:string;message:string}};
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const complete=(job:State)=>['generated','downloaded','failed','cancelled'].includes(job.status);
function accepted(job:State){return job.status==='queued'||job.status==='running'||job.status==='query_unknown';}
async function retrySameRequest(root:string,plan:SeedPlan,item:Entry,parent:State,job:State,acceptUnknown:boolean){
  if(job.operationId===parent.operationId){
    const unknown=job.status==='submit_unknown';
    if(unknown!==acceptUnknown || (!unknown&&!['failed','cancelled'].includes(job.status)))
      fail('RETRY_CONFLICT','Retry requires the applicable terminal or uncertain original attempt.');
    const fresh=currentRequest(await loadStory(root),{episodeId:item.episodeId,segmentId:item.segmentId},plan.model);
    if(!matchesEntry(item,{...item,...fresh}))fail('PLAN_STALE','Selected inputs changed before retry authorization.');
    await batchAttempt(root,plan,item,parent);
    job={...initial(plan,item),credentialRef:parent.credentialRef,retryOf:parent.operationId,attempt:parent.attempt+1};
    await save(root,job,true);
  }
  if(job.retryOf!==parent.operationId || job.requestHash!==parent.requestHash)
    fail('RETRY_CONFLICT','This is not the authorized successor.');
  if(parent.successorId!==job.operationId){parent.successorId=job.operationId;await save(root,parent);}
  return job;
}
async function interrupted(root:string,job:State) {
  if(job.status!=='submitting')return job;
  const persisted=await seedOperation(root,job.operationId);
  if(persisted?.taskId && persisted.credentialRef===job.credentialRef && persisted.requestHash===job.requestHash)return persisted;
  job.status='submit_unknown';job.lastError={code:'SUBMIT_UNKNOWN',message:'Process interrupted before receipt. No automatic resubmission.'};
  await save(root,job);return job;
}
function applyObservation(job:State,result:Awaited<ReturnType<SeedClient['query']>>) {
  const {status}=result;
  if(!['queued','processing','in_progress','completed','failed','error','cancelled'].includes(status))
    fail('SEED_CONTRACT','Unrecognized provider state.');
  job.rawStatus=status;delete job.lastError;
  if(status==='completed')job.status='generated';
  else if(['failed','error','cancelled'].includes(status)){
    job.status=status==='cancelled'?'cancelled':'failed';
    job.lastError={code:'PROVIDER_FAILED',message:result.reason||status};
  }else job.status=status==='queued'?'queued':'running';
}

async function submit(root:string,plan:SeedPlan,item:Entry,job:State,client:SeedClient,options:Options):Promise<Result>{
  const story=await loadStory(root);
  const fresh=currentRequest(story,{episodeId:item.episodeId,segmentId:item.segmentId},plan.model);
  const episode=story.episodes.find(e=>e.id===item.episodeId)!;
  const segment=episode.segments.find(s=>s.id===item.segmentId)!;
  const span=(await readEpisodeSource(root,episode)).slice(segment.start,segment.end);
  if(episode.kind==='video-prompts'?fresh.request.sourcePrompt!==span:!fresh.request.sourcePrompt.includes(span))
    fail('SOURCE_CHANGED','Selected prompt lost its source text.');
  if(fresh.requestHash!==item.requestHash || (item.bindings && canonicalSha256(fresh.bindings)!==canonicalSha256(item.bindings)))
    fail('PLAN_STALE','Selected inputs changed. Prepare the updated segment.');
  const files=await verifiedFiles(root,fresh.request);
  const payload=encodeRequest(fresh.request,files);
  job.status='submitting';job.credentialRef=client.credentialRef;
  await save(root,job);
  let taskId:string;
  try {
    taskId=await client.create(plan.model,payload);
  }catch(e){
    const rejected=e instanceof ApiError && [400,401,403,404,413,415,422].includes(e.status);
    job.status=rejected?'failed':'submit_unknown';
    job.lastError={code:rejected?'CREATE_REJECTED':'SUBMIT_UNKNOWN',message:e instanceof ApiError?client.rejection(e,item,payload.type.startsWith('multipart/')):'Creation receipt unavailable. Preserve this operation.'};
    await save(root,job);
    await capacity(root,options.runtime,job.operationId,plan.concurrency,'release');
    return {state:'done'};
  }
  try{await receipt(root,job,taskId);}
  catch(error){
    if(!isCode(error,'SEED_CONTRACT'))throw error;
    job.status='submit_unknown';job.lastError=publicError(error);await save(root,job);
    await capacity(root,options.runtime,job.operationId,plan.concurrency,'release');return {state:'done'};
  }
  return {state:'poll',delay:0};
}

async function observe(root:string,plan:SeedPlan,job:State,client:SeedClient,options:Options):Promise<Result>{
  const now=Date.now(),elapsed=now-Date.parse(job.submittedAt!);
  if(elapsed>=40*60000&&!job.firstWindowReported){
    job.firstWindowReported=true;await save(root,job);
    process.stderr.write(job.episodeId+'/'+job.segmentId+' 已等待 40 分钟，按原任务号继续查询。\n');
  }
  if((job.nextPollAt??0)>now)return {state:'poll',delay:job.nextPollAt!-now};
  const interval=options.pollIntervalMs??10000;
  let next=interval;
  try{
    applyObservation(job,await client.query(job.taskId!,plan.model));
  }catch(e){
    job.status='query_unknown';
    job.lastError=e instanceof ApiError?{code:'QUERY_HTTP',message:e.message}:publicError(e);
    await save(root,job);
    await capacity(root,options.runtime,job.operationId,plan.concurrency,'release');
    if(e instanceof ApiError)next=Math.max(interval,e.retryMs);
    if(isCode(e,'SEED_CONTRACT') || e instanceof ApiError && [401,403,404].includes(e.status)){
      await save(root,job);return {state:'done'};
    }
  }
  job.nextPollAt=Date.now()+next;await save(root,job);
  if(job.status==='queued'||job.status==='running')await capacity(root,options.runtime,job.operationId,plan.concurrency,'restore');
  if(complete(job)){
    await capacity(root,options.runtime,job.operationId,plan.concurrency,'release');
    return {state:job.status==='generated'?'download':'done'};
  }
  const untilNotice=40*60000-(Date.now()-Date.parse(job.submittedAt!));
  return {state:'poll',delay:job.firstWindowReported?next:Math.min(next,Math.max(0,untilNotice))};
}

async function collect(root:string,plan:SeedPlan,job:State,request:Request,client:SeedClient,verifyAudio:boolean){
  const verify=async(file:string,output:NonNullable<State['output']>)=>{
    if(Math.min(output.width,output.height)!==Number(resolution(plan.model).slice(0,-1)))fail('VIDEO_RESOLUTION','Output resolution differs from the selected model.');
    const audio=verifyAudio||request.requireAudio;
    const result=await verifyAv(file,output,undefined,audio);
    if(!result.passed)fail(audio?'VIDEO_AUDIO':'VIDEO_DECODE',result.reason??'Video verification failed.');
  };
  // A missing original file may be recovered. A conflicting published file is preserved by reconcileOutput.
  const target={...job,status:'generated' as const};
  let output=await reconcileOutput(root,target);
  if(output)await verify(await projectPath(root,output.path),output);
  else {
    const download=(url:string)=>downloadVideo(root,target,url,request.duration,client.download,request.ratio,undefined,undefined,verify);
    try{output=await download(client.content(job.taskId!));}
    catch(error){
      if(!isCode(error,'DOWNLOAD_FAILED'))throw error;
      const observed=await client.query(job.taskId!,plan.model);
      if(observed.status!=='completed'||!observed.url)throw error;
      output=await download(observed.url);
    }
  }
  job.status='downloaded';job.output=output;delete job.lastError;await save(root,job);
}

export async function runSeedance(root:string,options:Options){
  if([options.batch!==undefined,options.episodes!==undefined,options.selection!==undefined].filter(Boolean).length!==1)
    fail('BATCH_SCOPE','Select exactly one batch, episode list or segment selection.');
  const limit=parse(z.number().int().min(1).max(2),options.concurrency??1);
  const plan=options.batch?await readPlan(root,options.batch):await prepare(root,parse(Model,options.model),limit,options);
  if((options.model&&plan.model!==options.model)||(options.expectScope&&options.expectScope!==plan.scopeHash)||
    (options.batch&&options.concurrency&&options.concurrency!==plan.concurrency))fail('VIDEO_SCOPE_CHANGED','Requested settings differ from frozen Seedance scope.');
  const selected=options.operation||options.retryOf?await seedOperation(root,(options.operation??options.retryOf)!):undefined;
  if((options.operation||options.retryOf)&&(!selected||selected.planId!==plan.batchId||!plan.items.some(i=>i.requestHash===selected.requestHash)))
    fail('BATCH_SCOPE','Use the original operation and the batch which created it.');
  const canCreate=options.confirm && !options.operation && !options.retryOf &&
    await batchAuthorized(root,plan,!options.batch || options.expectScope===plan.scopeHash);
  const scope=selected?plan.items.filter(i=>i.requestHash===selected.requestHash):plan.items;
  if(options.retryOf && (!options.batch||!options.confirm))fail('GENERATION_NOT_AUTHORIZED','A retry requires its original batch and confirmation.');
  const pairs=new Map(await Promise.all(scope.map(async i=>[i.requestHash,await renderPair(root,plan,i,selected)] as const)));
  const viewed=new Map<string,{job:State;historicalPrompt?:string}>();
  let pending=scope.filter(item=>item.request);
  const problems=new Map<string,{code:string;message:string}>();
  const counts=new Map<string,number>(),downloadFailures=new Map<string,number>();
  const downloading=new Map<string,Promise<void>>();
  let client:SeedClient|undefined;
  async function turn(row:Entry,fetchOutput=false):Promise<Result>{
    const pair=pairs.get(row.requestHash);
    const lease=await lockRequests(root,pair?[pair.current.requestHash,pair.legacy.requestHash]:[row.requestHash]);
    try {
      let item=row,activePlan=plan;
      const heads=pair&&!options.operation?await matchedHeads(root,plan,pair):undefined;
      const existing=heads?(row.requestHash===pair!.current.requestHash?heads.current:heads.legacy):await stateFor(root,plan,row);
      const original=await batchAttempt(root,plan,row);
      let job=(options.operation?await seedOperation(root,options.operation):options.retryOf?existing:original)??existing??heads?.legacy??initial(plan,row);
      if(!options.operation&&!options.retryOf && heads?.legacy?.taskId &&
        (heads.current?.status==='prepared'||heads.current?.lastError?.code==='RETRY_SUPERSEDED'))job=heads.legacy;
      if(!options.operation && !options.retryOf && options.confirm){
        if(job.successorId)job=await deliveryAttempt(root,job);
        if(pair && job.requestHash===pair.legacy.requestHash && job.status==='prepared' && job.retryOf){
          const parent=await seedOperation(root,job.retryOf);
          if(parent?.status==='submit_unknown' && parent.requestHash===job.requestHash &&
            (!parent.successorId || parent.successorId===job.operationId))job=parent;
        }
      }
      if(options.confirm && !options.operation && !original && existing)await batchAttempt(root,plan,row,existing);
      const remember=()=>viewed.set(row.requestHash,{job,...(pair && job.requestHash===pair.legacy.requestHash && job.status!=='prepared'?
        {historicalPrompt:String(redact(pair.legacy.request!.prompt,[process.env.METASOCLI_YICIYUANG_VIDEO_API_KEY??''])).replace(/\bsk-[\w-]+/giu,'[secret]')}:{})});
      remember();
      if(options.confirm)job=await interrupted(root,job);
      if(options.retryOf){
        const parent=await seedOperation(root,options.retryOf);
        if(!parent)fail('RETRY_CONFLICT','Original operation is missing.');
        client??=await SeedClient.configured();
        if(!parent.credentialRef||parent.credentialRef!==client.credentialRef)fail('CREDENTIAL_CHANGED','Use the credential which created '+parent.operationId);
        if(pair && heads && parent.requestHash===pair.legacy.requestHash && (parent.correction || parent.status==='submit_unknown') &&
          (parent.correction || !existing || existing.operationId===parent.operationId || existing.status==='prepared')){
          const corrected=await correctedRetry(root,parent,plan,pair,heads,client.credentialRef,!!options.acceptUnknown);
          job=await interrupted(root,corrected.job);activePlan=corrected.plan;item=corrected.item;
        }else job=await retrySameRequest(root,plan,item,parent,job,!!options.acceptUnknown);
        await capacity(root,options.runtime,options.retryOf,plan.concurrency,'release');
        remember();
      }
      if(job.requestHash!==item.requestHash){
        activePlan=await readPlan(root,job.planId);item=frozenItem(activePlan,job);
      }
      if(!options.confirm){
        if(job.status==='prepared')await verifiedFiles(root,item.request!);
        if(job.output)await reconcileOutput(root,job,true);
        return {state:'done'};
      }
      if(complete(job)||job.status==='submit_unknown')await capacity(root,options.runtime,job.operationId,plan.concurrency,'release');
      if(job.status==='downloaded'){
        try{await reconcileOutput(root,job,true);
          const audio=options.verifyAv||item.request!.requireAudio;
          const av=await verifyAv(await projectPath(root,job.output!.path),job.output!,undefined,audio);
          if(!av.passed)fail(audio?'VIDEO_AUDIO':'VIDEO_DECODE',av.reason!);
          return {state:'done'};
        }catch(e){if(!isCode(e,'OUTPUT_MISSING'))throw e;job.status='generated';await save(root,job);}
      }
      if(['failed','cancelled','submit_unknown'].includes(job.status))return {state:'done'};
      if(job.status==='prepared' && !options.retryOf && !canCreate){
        if(options.operation)return {state:'done'};
        await verifiedFiles(root,item.request!);
        fail('GENERATION_NOT_AUTHORIZED','This batch has only a local preview. Select its episodes or segments to authorize creation.');
      }
      client??=await SeedClient.configured();
      if(job.credentialRef&&job.credentialRef!==client.credentialRef)fail('CREDENTIAL_CHANGED','Use the credential which created this Seedance task.');
      if(job.status==='prepared'){
        if(options.operation)return {state:'done'};
        if(job.retryOf && heads?.legacy?.correction?.operationId===job.operationId && !options.retryOf)
          fail('RETRY_CONFLICT','Resume the authorized retry with its original operation: '+job.retryOf);
        if(pair && job.requestHash===pair.legacy.requestHash)fail('PLAN_STALE','Historical rendered text cannot be sent. Use the corrected segment.');
        if(!existing)await save(root,job);
        await batchAttempt(root,activePlan,item,job);
        if(!await capacity(root,options.runtime,job.operationId,plan.concurrency,'claim'))return {state:'capacity'};
        try{
          const stage=await acquireVideoStage(root);
          try{return await submit(root,activePlan,item,job,client,options);}
          finally{await stage.release();}
        }catch(error){
          if(job.status==='prepared')await capacity(root,options.runtime,job.operationId,plan.concurrency,'release');
          throw error;
        }
      }
      if(job.status==='generated'){
        if(options.observeOnly)return {state:'done'};
        if(!fetchOutput)return {state:'download'};
        await collect(root,plan,job,item.request!,client,options.verifyAv);return {state:'done'};
      }
      if(!accepted(job))fail('SEED_STATE','Unsupported local job state.');
      if(Date.now()>=(job.nextPollAt??0))counts.set(row.requestHash,(counts.get(row.requestHash)??0)+1);
      return await observe(root,plan,job,client,options);
    }finally{await lease.release();}
  }
  let capacityDeadline:number|undefined;
  while(pending.length){
    const remaining:Entry[]=[];let delay=Infinity,capacityOnly=true;
    for(const item of pending){
      const key=item.requestHash;
      if(downloading.has(key)){remaining.push(item);continue;}
      if(problems.has(key))continue;
      try{
        const result=await turn(item);
        if(result.state==='done')continue;
        remaining.push(item);
        if(result.state==='capacity')continue;
        capacityOnly=false;
        if(result.state==='download'){
          if(options.observeOnly){remaining.pop();continue;}
          if(downloading.size<2){
            const task=turn(item,true).catch(error=>{
              const attempts=(downloadFailures.get(key)??0)+1;downloadFailures.set(key,attempts);
              if(attempts>=3||!['DOWNLOAD_FAILED','DOWNLOAD_TRUNCATED'].some(code=>isCode(error,code)))problems.set(key,publicError(error));
              else return sleep(1000*attempts);
            }).then(()=>{}).finally(()=>downloading.delete(key));
            downloading.set(key,task);
          }
          continue;
        }
        if(options.maxPolls&&(counts.get(key)??0)>=options.maxPolls)remaining.pop();
        else delay=Math.min(delay,result.delay??0);
      }catch(error){problems.set(key,publicError(error));}
    }
    pending=remaining;
    if(!pending.length)break;
    if(downloading.size){await Promise.race([...downloading.values(),...(Number.isFinite(delay)?[sleep(delay)]:[])]);continue;}
    if(capacityOnly){
      capacityDeadline??=Date.now()+(options.capacityWaitMs??30000);
      if(Date.now()>=capacityDeadline){
        for(const item of pending)problems.set(item.requestHash,{code:'WAITING_CAPACITY',message:'Resume this batch when a Seedance generation slot is available.'});
        break;
      }
      await sleep(Math.min(options.capacityPollMs??500,capacityDeadline-Date.now()));
      continue;
    }
    capacityDeadline=undefined;
    await sleep(Number.isFinite(delay)?delay:0);
  }
  await Promise.all(downloading.values());
  const segments=await Promise.all(scope.map(async(item,order)=>{
    const view=viewed.get(item.requestHash);
    const job=view?(await seedOperation(root,view.job.operationId)??(view.job.status!=='prepared'?view.job:undefined)):selected;
    const issue=problems.get(item.requestHash)??item.issue??job?.lastError;
    const output=job?.output&&job.status==='downloaded'&&!issue?{...job.output,absolutePath:await projectPath(root,job.output.path)}:undefined;
    return {order,episodeId:item.episodeId,segmentId:item.segmentId,model:plan.model,status:problems.has(item.requestHash)||item.issue?'blocked':job?.status??'prepared',
      operationId:job?.operationId,operationBatchId:job?.planId,requestHash:job?.requestHash,historicalSentPrompt:view?.historicalPrompt,retryOf:job?.retryOf,successorId:job?.successorId,taskId:job?.taskId,acceptedAt:job?.submittedAt,firstWindowReported:job?.firstWindowReported,output,issue};
  }));
  const done=segments.every(s=>s.output),blocked=segments.some(s=>s.issue);
  const state=done?'complete':options.confirm||blocked?'partial':'prepared';
  return {exitCode:state==='partial'?2:0,data:{provider:'yiciyuang',model:plan.model,batchId:plan.batchId,scopeHash:plan.scopeHash,state,status:state,segments}};
}

export async function attachSeedTask(root:string,original:State,value:string,confirm:boolean,runtime?:string){
  if(!confirm)fail('GENERATION_NOT_AUTHORIZED','Confirm linking the original task.');
  const id=parse(TaskId,value),plan=await readPlan(root,original.planId);
  const item=plan.items.find(i=>i.requestHash===original.requestHash);
  if(!item)fail('BATCH_SCOPE','Cannot locate original segment.');
  const pair=await renderPair(root,plan,item,original);
  const lease=await lockRequests(root,pair?[pair.current.requestHash,pair.legacy.requestHash]:[item.requestHash]);
  try{
    const job=await seedOperation(root,original.operationId);
    if(!job||job.operationId!==original.operationId||!['submitting','submit_unknown'].includes(job.status))fail('SEED_STATE','Only an unresolved creation may be linked.');
    const client=await SeedClient.configured();
    if(job.credentialRef!==client.credentialRef)fail('CREDENTIAL_CHANGED','Use original account credential.');
    const seen=await client.query(id,plan.model,true);
    const observed={...job};
    applyObservation(observed,seen);
    await receipt(root,job,id,observed);
    await capacity(root,runtime,job.operationId,plan.concurrency,accepted(job)?'restore':'release');
    let successor=job.successorId?await seedOperation(root,job.successorId):await stateFor(root,plan,item);
    if(job.correction && !successor){
      const target=await readPlan(root,job.correction.planId),entry=target.items[0];
      if(!pair || !entry || target.items.length!==1 || !matchesEntry(entry,pair.current) || entry.requestHash!==job.correction.requestHash)
        fail('RETRY_CONFLICT','Cannot verify the reserved corrected attempt.');
      successor={...initial(target,entry),operationId:job.correction.operationId,retryOf:job.operationId,attempt:job.attempt+1};
    }
    if(successor?.retryOf===job.operationId && successor.status==='prepared'){
      successor.status='cancelled';
      successor.lastError={code:'RETRY_SUPERSEDED',message:'Original receipt recovered before the new attempt was sent.'};
      await save(root,successor);
      await capacity(root,runtime,successor.operationId,plan.concurrency,'release');
      await save(root,job,true);
    }
    return {operationId:job.operationId,taskId:id,batchId:plan.batchId};
  }finally{await lease.release();}
}
