import { afterAll, afterEach, expect, it } from 'vitest';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanup, mp4 } from './helpers.js';
import { batchFixture, evidence } from './batch-helpers.js';
import { barrier, isolationEvidence } from './project-isolation-helpers.js';
import { imageFixture, imageResponse, profile } from './image-api-helpers.js';
import { runImages } from '../src/images/run.js';
import { createImagePlan } from '../src/images/planning.js';
import { createBatchPlan } from '../src/jobs/batch-store.js';
import { runBatch } from '../src/jobs/batch.js';
import { submit } from '../src/jobs/submit.js';
import { resume } from '../src/jobs/resume.js';
import { listJobs } from '../src/jobs/store.js';
import { occupied, reconcileRuntime, acquireScheduler, runtimeDirectory } from '../src/jobs/coordinator.js';
import { runCli } from '../src/cli/main.js';
import { sha256Hex } from '../src/storage/canonical.js';
import type { VideoClient } from '../src/metaso/client.js';
afterEach(cleanup);const records:unknown[]=[];afterAll(()=>isolationEvidence('video',records));
const options={maxPolls:1,pollIntervalMs:0,capacityWaitMs:0},fetcher=async()=>new Response(mp4(7));
const running=(taskId:string)=>({taskId,status:'running' as const,rawStatus:'running',evidence});
const generated=(taskId:string)=>({taskId,status:'generated' as const,rawStatus:'succeeded',duration:7,url:'https://example.com/offline.mp4',evidence});
const start=async(f:Awaited<ReturnType<typeof batchFixture>>,client:VideoClient,segment='s1')=>submit(f.root,f.batch.plan.items[0]!.planId,segment,true,{client});

it('V1 R3: foreign ended unknown releases its slot, B starts four; no resend or foreign GET',async()=>{
  const a=await batchFixture([1]),b=await batchFixture([4]);let postsA=0,postsB=0,peak=0;
  const old=await start(a,{async create(){postsA++;throw Error('unknown');},async query(){throw Error('must not query unknown');}});
  const oldBytes=await readFile(join(a.root,`.metasocli/jobs/${old.operationId}.json`));
  const client:VideoClient={async create(r){expect(r.model).toBe('MiniMax-H3');expect(r.context_ir_enabled).toBe(true);peak=Math.max(peak,occupied(await reconcileRuntime(b.root)).length);return {taskId:'B-'+(++postsB),evidence};},async query(id){expect(id.startsWith('B-')).toBe(true);return running(id);}};
  const first=await runBatch(b.root,b.batch.plan.batchId,true,{client},options);expect(first.summary).toMatchObject({pending:0,active:4});expect(first.run?.status).toBe('paused');expect(postsB).toBe(4);expect(peak).toBe(4);
  await runBatch(b.root,b.batch.plan.batchId,false,{client},options);expect(postsB).toBe(4);expect(postsA).toBe(1);expect(await readFile(join(a.root,`.metasocli/jobs/${old.operationId}.json`))).toEqual(oldBytes);
  const status=await runCli(['batch','status','--root',b.root,'--batch',b.batch.plan.batchId],{client});expect(status.data).toMatchObject({capacity:{sharedLimit:4,sharedOccupied:4,currentProjectOccupied:4,otherProjectsOccupied:0,available:0,liveCheckPerformed:false}});expect(postsB).toBe(4);
  records.push({case:'V1',oldOperation:old.operationId,projectA:old.projectId,projectB:b.batch.plan.projectId,postsA,postsB,peak,oldHash:sha256Hex(oldBytes),newIds:(await listJobs(b.root)).map(j=>j.operationId)});
});

it.each(['query_unknown','corrupt-job','missing-root'] as const)('V2/V7/V9 R3: foreign %s releases locally; B completes without foreign GET or source writes',async mode=>{
  const a=await batchFixture([1]),b=await batchFixture([1]);let posts=0;
  const old=await start(a,{async create(){return {taskId:'A-known',evidence};},async query(){throw Error('unused');}});
  if(mode==='query_unknown')await resume(a.root,old.operationId,{client:{async create(){throw Error('no POST');},async query(taskId){return {taskId,status:'unknown',rawStatus:'new-status',evidence};}}},{maxPolls:1,download:false});
  const before=(await reconcileRuntime(a.root)).slots.find(s=>s.operationId===old.operationId);
  if(mode==='corrupt-job')await writeFile(join(a.root,`.metasocli/jobs/${old.operationId}.json`),'broken');
  if(mode==='missing-root')await rename(a.root,join(dirname(a.root),'archived'));
  const queried:string[]=[];const client:VideoClient={async create(){posts++;return {taskId:'B-known',evidence};},async query(taskId){queried.push(taskId);expect(taskId).toBe('B-known');return generated(taskId);}};
  expect((await runBatch(b.root,b.batch.plan.batchId,true,{client,fetcher},options)).run?.status).toBe('complete');
  const after=(await reconcileRuntime(b.root)).slots.find(s=>s.operationId===old.operationId)!;expect(after).toMatchObject({operationId:before!.operationId,taskId:before!.taskId,requestHash:before!.requestHash,capacity:{state:'released'}});expect(posts).toBe(1);expect(queried.length).toBeGreaterThan(0);expect(new Set(queried)).toEqual(new Set(['B-known']));
  records.push({case:'V2/V7/V9',mode,posts,queried,foreignSnapshot:before});
});

it('V3/V5/V10: A holds two tasks and its scheduler; B concurrency=1 starts before A ends; ordinary A entry is protected',async()=>{
  const a=await batchFixture([3]),b=await batchFixture([2]),ap=(await createBatchPlan(a.root,{episodes:a.episodeIds,concurrency:2})).plan,bp=(await createBatchPlan(b.root,{episodes:b.episodeIds,concurrency:1})).plan;
  let aPosts=0,bPosts=0,peak=0;const entered=barrier(),release=barrier();
  const active=runBatch(a.root,ap.batchId,true,{client:{async create(){return {taskId:'A-'+(++aPosts),evidence};},async query(id){if(aPosts===2)entered.resolve();await release.promise;return running(id);}}},options);
  try{await entered.promise;
    await expect(start(a,{async create(){throw Error('must not POST');},async query(){throw Error('unused');}},'s3')).rejects.toMatchObject({code:'SCHEDULER_BUSY'});
    const result=await runBatch(b.root,bp.batchId,true,{client:{async create(){bPosts++;peak=occupied(await reconcileRuntime(b.root)).length;return {taskId:'B-one',evidence};},async query(id){return running(id);}}},options);
    expect(result.summary).toMatchObject({active:1,pending:1});expect(bPosts).toBe(1);expect(peak).toBe(3);
  }finally{release.resolve();await active;}
  records.push({case:'V3/V5/V10',aPosts,bPosts,peak,bConcurrency:1,bStartedBeforeACompleted:true});
});

it('V6/V8 R3: four known active foreign tasks wait boundedly without blocking images; a terminal releases and B resumes',async()=>{
  const owners=[];for(let i=0;i<4;i++){const f=await batchFixture([1]);const j=await start(f,{async create(){return {taskId:'active-A-'+i,evidence};},async query(){throw Error('unused');}});owners.push({f,j});}
  const b=await batchFixture([1]);let bPosts=0;
  const client:VideoClient={async create(){bPosts++;return {taskId:'B-after-release',evidence};},async query(id){return generated(id);}};
  const blocked=await runBatch(b.root,b.batch.plan.batchId,true,{client}, {...options,capacityWaitMs:40,capacityPollMs:10});expect(bPosts).toBe(0);expect(blocked.summary.pending).toBe(1);expect(blocked.run?.trace.some(t=>t.event==='capacity-wait-budget-ended')).toBe(true);
  const img=await imageFixture(),ip=(await createImagePlan(img.root,{episodes:['ep-1'],profile})).plan;let images=0;
  await runImages(img.root,ip.planId,true,{client:{async create(){images++;return imageResponse();}}});expect(images).toBe(1);
  const first=owners[0]!;
  const waiting=barrier(),release=barrier();let sawWait=false;
  const work=runBatch(b.root,b.batch.plan.batchId,false,{client,fetcher,sleep:async()=>{if(!sawWait){sawWait=true;waiting.resolve();await release.promise;}}},{...options,capacityWaitMs:5000,capacityPollMs:10});
  try{await waiting.promise;expect(bPosts).toBe(0);const terminal=await resume(first.f.root,first.j.operationId,{client},{maxPolls:1,download:false});expect(terminal.status).toBe('generated');expect(occupied(await reconcileRuntime(first.f.root))).toHaveLength(3);release.resolve();expect((await work).run?.status).toBe('complete');}
  finally{release.resolve();await work;}
  expect(bPosts).toBe(1);expect(occupied(await reconcileRuntime(b.root))).toHaveLength(3);
  const oldBatchHash=blocked.run?.authorization.batchHash;expect((await runCli(['batch','status','--root',b.root,'--batch',b.batch.plan.batchId],{client})).exitCode).toBe(0);expect(bPosts).toBe(1);
  records.push({case:'V6/V8',oldOperations:owners.map(x=>x.j.operationId),blockedPosts:0,bPosts,images,authorizationHash:oldBatchHash,remainingKnownActive:3});
},30000);

it('V10: different-story normal submit ignores A scheduler; same-story casing cannot bypass it',async()=>{
  const a=await batchFixture([1]),b=await batchFixture([1]),lease=await acquireScheduler(a.root,runtimeDirectory());let posts=0;
  const client:VideoClient={async create(){posts++;return {taskId:'independent-single',evidence};},async query(id){return running(id);}};
  try{const result=await runCli(['generate','--root',process.platform==='win32'?a.root.toUpperCase():a.root,'--plan',a.batch.plan.items[0]!.planId,'--segment','s1','--confirm','--submit-only'],{client});expect(result.data).toMatchObject({error:{code:'SCHEDULER_BUSY'}});await start(b,client);expect(posts).toBe(1);}
  finally{await lease.release();}
});
