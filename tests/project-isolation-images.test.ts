import { afterAll, afterEach, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { cleanup } from './helpers.js';
import { imageFixture, imageResponse, profile } from './image-api-helpers.js';
import { barrier, isolationEvidence } from './project-isolation-helpers.js';
import { createImagePlan } from '../src/images/planning.js';
import { runImages, recoverImage } from '../src/images/run.js';
import { listImageJobs, readImageRun } from '../src/images/store.js';
import { withImageLedger, acquireImageScheduler, imageRuntime } from '../src/images/coordinator.js';
import { createPlan } from '../src/core/planning.js';
import { acquireVideoStage } from '../src/images/phase.js';
import { sha256Hex } from '../src/storage/canonical.js';
import { runCli } from '../src/cli/main.js';
import { submit } from '../src/jobs/submit.js';
import { evidence } from './batch-helpers.js';
afterEach(cleanup);
const records:unknown[]=[];afterAll(()=>isolationEvidence('images',records));
const plan=async(root:string,limits?:{concurrent?:number;rpm?:number})=>(await createImagePlan(root,{episodes:['ep-1'],profile:{...profile,...(limits?{providerLimits:{...limits,source:'offline fixture',checkedAt:new Date().toISOString()}}:{})},submissionMode:'all-ready'})).plan;
const slots=()=>withImageLedger(profile,undefined,async l=>structuredClone(l.slots));

it('I4: A active/dependency wait and later paused unknown do not block B image preparation or video submission',async()=>{
  const a=await imageFixture(2,{'asset-001':['asset-000']}),ap=await plan(a.root),entered=barrier(),release=barrier();
  const active=runImages(a.root,ap.planId,true,{client:{async create(){entered.resolve();await release.promise;throw Error('unknown A');}}});await entered.promise;
  let bImages=0,bVideos=0;
  try{
    expect((await listImageJobs(a.root)).find(j=>j.assetId==='asset-001')?.status).toBe('waiting_dependency');
    const b=await imageFixture(),bp=await plan(b.root);await runImages(b.root,bp.planId,true,{client:{async create(){bImages++;return imageResponse();}}});
    const video=await createPlan(b.root,'ep-1');
    await submit(b.root,video.planId,'s0',true,{client:{async create(){bVideos++;return {taskId:'B-during-A-images',evidence};},async query(){throw Error('unused');}}});
    expect(bVideos).toBe(1);release.resolve();expect((await active).run?.status).toBe('needs_attention');
    const c=await imageFixture(),cp=await plan(c.root);await runImages(c.root,cp.planId,true,{client:{async create(){bImages++;return imageResponse();}}});
    expect(bImages).toBe(2);
    records.push({case:'I4',aWaitingDependency:true,aPausedUnknown:true,bImages,bVideos,bVideoStartedBeforeACompleted:true});
  }finally{release.resolve();await active;}
});

it.each(['missing-root','corrupt-job','corrupt-plan'] as const)('I1/I4/I5: foreign unknown and %s never read or rewrite A; B runs and recovers its original result',async damage=>{
  const a=await imageFixture(),b=await imageFixture(),ap=await plan(a.root),bp=await plan(b.root);
  await runImages(a.root,ap.planId,true,{client:{async create(){throw Error('offline unknown');}}});
  const aj=(await listImageJobs(a.root))[0]!,file=join(a.root,`.metasocli/image-jobs/${aj.operationId}.json`),bytes=await readFile(file),snapshot=(await slots())[0];
  const archived=join(dirname(a.root),'archived');
  if(damage==='missing-root')await rename(a.root,archived);
  if(damage==='corrupt-job')await writeFile(file,'broken');
  if(damage==='corrupt-plan')await writeFile(join(a.root,`.metasocli/image-plans/${ap.planId}.json`),'broken');
  let posts=0;const deps={client:{async create(){posts++;return imageResponse();}}};
  const result=await runImages(b.root,bp.planId,true,deps);expect(result.summary.registered).toBe(1);
  const bj=(await listImageJobs(b.root))[0]!;
  expect((await runCli(['images','status','--root',b.root,'--plan',bp.planId],undefined,deps)).exitCode).toBe(0);
  await recoverImage(b.root,bj.operationId,deps);await runImages(b.root,bp.planId,false,deps);expect(posts).toBe(1);
  await createPlan(b.root,'ep-1');const stage=await acquireVideoStage(b.root);await stage.release();
  expect((await slots()).find(s=>s.operationId===aj.operationId)).toEqual(snapshot);
  if(damage==='missing-root')expect(await readFile(join(archived,`.metasocli/image-jobs/${aj.operationId}.json`))).toEqual(bytes);
  else if(damage!=='corrupt-job')expect(await readFile(file)).toEqual(bytes);
  records.push({case:'I1/I4/I5',damage,projectA:aj.projectId,projectB:bj.projectId,oldOperationId:aj.operationId,newOperationId:bj.operationId,posts,recoveryPosts:0,oldHash:sha256Hex(bytes),snapshotPreserved:true});
});

it('I2/I3: B enters transport before A responds and keeps dispatching when A becomes unknown',async()=>{
  const a=await imageFixture(),b=await imageFixture(3),ap=await plan(a.root),bp=await plan(b.root);
  const aEntered=barrier(),releaseA=barrier(),bEntered=barrier(),releaseB=barrier();let bPosts=0;const sequence:string[]=[];
  const runA=runImages(a.root,ap.planId,true,{client:{async create(){sequence.push('A POST');aEntered.resolve();await releaseA.promise;throw Error('lost');}}});
  await aEntered.promise;
  const runB=runImages(b.root,bp.planId,true,{client:{async create(){bPosts++;sequence.push('B POST '+bPosts);bEntered.resolve();return imageResponse();}},checkpoint:async(p,j)=>{if(p==='intent'&&j.assetId==='asset-001')await releaseB.promise;}});
  try {await bEntered.promise;releaseA.resolve();expect((await runA).summary.unknown).toBe(1);sequence.push('A unknown persisted');releaseB.resolve();expect((await runB).summary.registered).toBe(3);}
  finally{releaseA.resolve();releaseB.resolve();await Promise.allSettled([runA,runB]);}
  expect(sequence.indexOf('B POST 1')).toBeLessThan(sequence.indexOf('A unknown persisted'));expect(sequence.indexOf('B POST 2')).toBeGreaterThan(sequence.indexOf('A unknown persisted'));
  records.push({case:'I2/I3',sequence,bPosts});
});

it('I6: same story lock survives runtime/profile changes and Windows casing; another story is independent',async()=>{
  const a=await imageFixture(),b=await imageFixture(),lease=await acquireImageScheduler(a.root,profile);
  try{await expect(acquireImageScheduler(process.platform==='win32'?a.root.toUpperCase():a.root,{...profile,quotaGroup:'different'},join(dirname(a.root),'different-runtime'))).rejects.toMatchObject({code:'LOCK_BUSY'});
    const other=await acquireImageScheduler(b.root,profile);await other.release();}
  finally{await lease.release();}
  records.push({case:'I6',sameStory:'LOCK_BUSY',otherStory:'acquired'});
});

it('I9: shared known concurrency waits with stable prepared IDs; unknown retains quota; no arbitrary cap without limits',async()=>{
  const a=await imageFixture(),b=await imageFixture(),ap=await plan(a.root,{concurrent:1}),bp=await plan(b.root,{concurrent:1});
  const entered=barrier(),release=barrier();let bPosts=0;
  const active=runImages(a.root,ap.planId,true,{client:{async create(){entered.resolve();await release.promise;return imageResponse();}}});await entered.promise;
  const deps={capacityWaitMs:0,client:{async create(){bPosts++;return imageResponse();}}};
  let waiting;
  try{waiting=await runImages(b.root,bp.planId,true,deps);expect(waiting.run?.waiting).toMatchObject({code:'IMAGE_CAPACITY_WAIT',reason:'concurrent'});expect(bPosts).toBe(0);expect((await listImageJobs(b.root))[0]?.status).toBe('prepared');}
  finally{release.resolve();await active;}
  const id=(await readImageRun(b.root,bp))!.items[0]!.operationId;
  expect((await runImages(b.root,bp.planId,false,deps)).summary.registered).toBe(1);expect((await listImageJobs(b.root))[0]!.operationId).toBe(id);expect(bPosts).toBe(1);
  records.push({case:'I9-concurrent',operationId:id,blockedPosts:0,resumePosts:bPosts,reason:waiting?.run?.waiting});
});

it('I9: RPM is shared and remains counted after generation completes; budget expiry is not unknown',async()=>{
  const a=await imageFixture(),b=await imageFixture(),ap=await plan(a.root,{rpm:1}),bp=await plan(b.root,{rpm:1});let posts=0;
  const client={async create(){posts++;return imageResponse();}};
  await runImages(a.root,ap.planId,true,{client});
  const before=await runImages(b.root,bp.planId,true,{client,capacityWaitMs:0});expect(before.run?.waiting?.reason).toBe('rpm');expect(posts).toBe(1);
  const id=(await listImageJobs(b.root))[0]!.operationId;
  await runImages(b.root,bp.planId,false,{client,now:()=>Date.now()+61000,capacityWaitMs:0});expect(posts).toBe(2);expect((await listImageJobs(b.root))[0]).toMatchObject({operationId:id,status:'registered'});
  records.push({case:'I9-rpm',operationId:id,totalPosts:posts,windowAdvanceMs:61000});
});

it('I9: an old unknown conservatively occupies configured quota; waiting is not a new submission',async()=>{
  const a=await imageFixture(),b=await imageFixture(),ap=await plan(a.root,{concurrent:1}),bp=await plan(b.root,{concurrent:1});
  await runImages(a.root,ap.planId,true,{client:{async create(){throw Error('unknown');}}});const old=(await slots())[0];let posts=0;
  const result=await runImages(b.root,bp.planId,true,{capacityWaitMs:0,client:{async create(){posts++;return imageResponse();}}});
  expect(posts).toBe(0);expect(result.summary).toMatchObject({notStarted:1,started:0,unknown:0});expect(result.run?.waiting?.reason).toBe('concurrent');expect((await slots())[0]).toEqual(old);
  records.push({case:'I9-unknown-quota',oldOperationId:old?.operationId,posts,waiting:result.run?.waiting});
});
