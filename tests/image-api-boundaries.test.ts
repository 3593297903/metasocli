import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cleanup, png } from './helpers.js';
import { imageFixture, imageResponse, profile } from './image-api-helpers.js';
import { createImagePlan } from '../src/images/planning.js';
import { runImages } from '../src/images/run.js';
import { listImageJobs, readImageRun, saveImageJob, saveImageRun } from '../src/images/store.js';
import { imageRuntime } from '../src/images/coordinator.js';
import { sha256Hex } from '../src/storage/canonical.js';

afterEach(async()=>{vi.restoreAllMocks();await cleanup();});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
async function evidence(name:string,value:unknown){const folder=resolve('.work/image-audit-fix-20260924');await mkdir(folder,{recursive:true});await writeFile(join(folder,name),JSON.stringify(value,null,2));}
async function deadline<T>(promise:Promise<T>,message:string){
  let timer:ReturnType<typeof setTimeout>;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),5000);})]);}
  finally{clearTimeout(timer!);}
}

it('resumes partial multi-job preparation with the reserved IDs, missing ledger entries and zero historical POSTs',async()=>{
  const f=await imageFixture(2),{plan}=await createImagePlan(f.root,{episodes:['ep-1'],profile});
  const posts:string[]=[],client={async create(_root:string,input:{promptPath:string}){
    posts.push((await readFile(join(f.root,input.promptPath),'utf8')).split(' ')[0]!);return imageResponse();
  }};
  await expect(runImages(f.root,plan.planId,true,{client,checkpoint:async(point,job)=>{
    if(point==='job-reserved'&&job.assetId==='asset-001')throw Error('interrupted before second job save');
  }})).rejects.toThrow('interrupted before second job save');
  const original=await readImageRun(f.root,plan),saved=await listImageJobs(f.root);
  expect(original?.authorization.maxRequests).toBe(2);
  expect(saved).toHaveLength(1);expect(saved[0]).toMatchObject({status:'prepared',attempt:1,operationId:original!.items[0]!.operationId});
  expect(saved[0]!.requestStartedAt).toBeUndefined();expect(posts).toEqual([]);
  expect(JSON.parse(await readFile(join(imageRuntime(profile),'ledger.json'),'utf8')).slots).toEqual([]);

  const resumed=await runImages(f.root,plan.planId,false,{client});
  expect(resumed.summary.registered).toBe(2);
  const jobs=await listImageJobs(f.root);
  for(const row of original!.items)expect(jobs.find(j=>j.assetId===row.assetId)).toMatchObject({operationId:row.operationId,attempt:1,status:'registered'});
  expect(posts).toEqual(['asset-000','asset-001']);
  expect((await readImageRun(f.root,plan))!.authorization).toEqual(original!.authorization);
  expect(JSON.parse(await readFile(join(imageRuntime(profile),'ledger.json'),'utf8')).slots).toHaveLength(2);
  await runImages(f.root,plan.planId,false,{client});expect(posts).toEqual(['asset-000','asset-001']);
  await evidence('partial-prepared.json',{offline:true,historicalPosts:0,ledgerBefore:0,authorization:original!.authorization,reserved:original!.items,
    recovered:jobs.map(({assetId,operationId,attempt,status})=>({assetId,operationId,attempt,status})),posts,resumeExtraPosts:0});
});

it('does not lose A completion during scanning: dependent B starts before unrelated C is released',async()=>{
  const f=await imageFixture(3,{'asset-001':['asset-000']}),{plan}=await createImagePlan(f.root,{episodes:['ep-1'],profile});
  expect(plan.items.map(i=>i.assetId)).toEqual(['asset-000','asset-001','asset-002']);
  const a=deferred<Response>(),c=deferred<Response>(),aSettled=deferred<void>(),bStarted=deferred<void>(),cStarted=deferred<void>();
  const events:string[]=[],posts:string[]=[];let aId='',cReleased=false;
  // Observe the exact removal of A's in-flight promise, not a timing delay or a provider response.
  // At C's intent the scan has already skipped B. Keep C blocked until B actually starts.
  const mapDelete=Map.prototype.delete;
  vi.spyOn(Map.prototype,'delete').mockImplementation(function(this:Map<unknown,unknown>,key:unknown){
    const result=mapDelete.call(this,key);if(key===aId&&result)aSettled.resolve();return result;
  });
  const work=runImages(f.root,plan.planId,true,{
    checkpoint:async(point,job)=>{
      if(point==='intent'&&job.assetId==='asset-000')aId=job.operationId;
      if(point==='intent'&&job.assetId==='asset-002'){
        a.resolve(imageResponse());await deadline(aSettled.promise,'A never settled during scan');
        expect((await listImageJobs(f.root)).find(j=>j.operationId===aId)?.status).toBe('registered');
        events.push('A registered and settled during scan');
      }
    },
    client:{async create(_root,input){
      const asset=(await readFile(join(f.root,input.promptPath),'utf8')).split(' ')[0]!;posts.push(asset);
      if(asset==='asset-000')return a.promise;
      if(asset==='asset-002'){events.push('C started');cStarted.resolve();return c.promise;}
      expect(cReleased).toBe(false);expect(input.route).toBe('/v1/images/edits');
      expect(input.references.map(r=>({assetId:r.assetId,sha256:r.sha256}))).toEqual([{assetId:'asset-000',sha256:sha256Hex(png(1024,1024))}]);
      events.push('B started');bStarted.resolve();return imageResponse(1);
    }},
  });
  try{
    await deadline(cStarted.promise,'C never started');
    await deadline(bStarted.promise,'B did not start while unrelated C was still blocked');
    expect(events).toEqual(['A registered and settled during scan','C started','B started']);
  }finally{events.push('C released');cReleased=true;a.resolve(imageResponse());c.resolve(imageResponse(2));await work;}
  expect((await work).summary.registered).toBe(3);expect(posts).toEqual(['asset-000','asset-002','asset-001']);
  await runImages(f.root,plan.planId,false,{client:{async create(){throw Error('Unexpected repeat POST');}}});
  await evidence('dependency-wakeup.json',{offline:true,events,posts,registered:3,resumeExtraPosts:0});
},20000);

it.each(['attempt','reservation','submission evidence'])('refuses partial-preparation repair with changed %s',async(change)=>{
  const f=await imageFixture(2),{plan}=await createImagePlan(f.root,{episodes:['ep-1'],profile});let posts=0;
  const client={async create(){posts++;return imageResponse();}};
  await expect(runImages(f.root,plan.planId,true,{client,checkpoint:async(point,job)=>{
    if(point==='job-reserved'&&job.assetId==='asset-001')throw Error('partial prepare');
  }})).rejects.toThrow('partial prepare');
  const [job]=await listImageJobs(f.root),run=(await readImageRun(f.root,plan))!;
  if(change==='reservation'){
    [run.items[0]!.operationId,run.items[1]!.operationId]=[run.items[1]!.operationId,run.items[0]!.operationId];await saveImageRun(f.root,run);
  }else {if(change==='attempt')job!.attempt=2;else job!.requestStartedAt=new Date().toISOString();await saveImageJob(f.root,job!);}
  await expect(runImages(f.root,plan.planId,false,{client})).rejects.toMatchObject({code:change==='submission evidence'?'IMAGE_LEDGER_CONFLICT':change==='reservation'?'IMAGE_ASSET_ACTIVE':'IMAGE_JOB_CONFLICT'});
  expect(posts).toBe(0);expect((await listImageJobs(f.root))[0]).toEqual(job);
  expect(JSON.parse(await readFile(join(imageRuntime(profile),'ledger.json'),'utf8')).slots).toEqual([]);
});

it('preserves actual unknown requests and their ledger identities while resuming, without POST',async()=>{
  const f=await imageFixture(2),{plan}=await createImagePlan(f.root,{episodes:['ep-1'],profile});let posts=0;
  const client={async create(){posts++;throw Error('request outcome unknown');}};
  await runImages(f.root,plan.planId,true,{client});const before=await listImageJobs(f.root),count=posts;
  expect(before.some(j=>j.status==='submit_unknown')).toBe(true);
  await runImages(f.root,plan.planId,false,{client});expect(posts).toBe(count);
  expect((await listImageJobs(f.root)).map(j=>[j.operationId,j.attempt,j.status])).toEqual(before.map(j=>[j.operationId,j.attempt,j.status]));
  const ledger=JSON.parse(await readFile(join(imageRuntime(profile),'ledger.json'),'utf8'));
  for(const job of before)expect(ledger.slots.find((s:{operationId:string})=>s.operationId===job.operationId)).toMatchObject({status:job.status,operationId:job.operationId});
});
