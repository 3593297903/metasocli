import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { batchFixture, evidence } from './batch-helpers.js';
import { cleanup, mp4 } from './helpers.js';
import { runBatch } from '../src/jobs/batch.js';
import { batchPath, batchStatus, createBatchPlan, loadBatch, saveBatchRun } from '../src/jobs/batch-store.js';
import { listJobs } from '../src/jobs/store.js';
import { submit } from '../src/jobs/submit.js';
import { resume } from '../src/jobs/resume.js';
import { acquireScheduler, occupied, reconcileRuntime, runtimeDirectory } from '../src/jobs/coordinator.js';
import { MetasoClient, type VideoClient } from '../src/metaso/client.js';
import { runCli } from '../src/cli/main.js';
import { loadStory } from '../src/core/project.js';
import { irFixture } from './context-ir-fixtures.js';
import { submitContextIr } from '../src/jobs/context-ir.js';
import { vi } from 'vitest';
afterEach(cleanup);
const polling = { pollIntervalMs: 0, maxPolls: 1 };
const fetcher = async () => new Response(mp4(7));
it('requires explicit originals in an independent-IR history and rejects duplicate segments or invalid capacity',async()=>{
  const f=await irFixture(false);
  await submitContextIr(f.root,f.plan.planId,'s1',true,{client:f.irClient});
  await expect(createBatchPlan(f.root,{allEpisodes:true})).rejects.toMatchObject({code:'BATCH_ORIGINALS_AMBIGUOUS'});
  expect((await createBatchPlan(f.root,{episodes:['ep-1'],concurrency:1})).plan.items).toHaveLength(1);
  await expect(createBatchPlan(f.root,{episodes:['ep-1'],concurrency:5})).rejects.toThrow();
  await expect(createBatchPlan(f.root,{selection:{schemaVersion:1,episodes:[{episodeId:'ep-1',segmentIds:['s1','s1']}]}})).rejects.toMatchObject({code:'BATCH_SCOPE'});
});

it('uses independent POST 120s and GET 30s deadlines without waiting for real timeouts',async()=>{
  const f=await batchFixture([1]);
  const {loadPlan,validatePlan}=await import('../src/core/planning.js');
  const request=(await validatePlan(f.root,await loadPlan(f.root,f.batch.plan.items[0]!.planId))).built[0]!.request;
  const timeout=vi.spyOn(AbortSignal,'timeout');
  try{
    const client=new MetasoClient('offline',async(_url,init)=>Response.json(init?.method==='POST'?{task_id:'deadline'}:{task:{id:'deadline',status:'running'}}));
    await client.create(request);await client.query('deadline');expect(timeout.mock.calls.map(c=>c[0])).toEqual([120000,30000]);
  }finally{timeout.mockRestore();}
});
it('keeps four IDs occupied across restart, rebuilds a lost batch index, reuses old outputs and never POSTs from ordinary resume', async () => {
  const f = await batchFixture([6]); let posts = 0, complete = false;
  const client: VideoClient = { async create() { return { taskId: 'restart-' + ++posts, evidence }; }, async query(taskId) {
    return complete ? { taskId, status:'generated', rawStatus:'succeeded', duration:7, url:'https://example.com/out.mp4', evidence }
      : { taskId, status:'queued', rawStatus:'queued', evidence };
  } };
  const first = await runBatch(f.root,f.batch.plan.batchId,true,{client,fetcher},polling);
  expect(posts).toBe(4); expect(first.summary).toMatchObject({active:4,pending:2});
  expect(occupied(await reconcileRuntime(f.root))).toHaveLength(4);
  await resume(f.root,first.items[0]!.job!.operationId,{client},{download:false,...polling}); expect(posts).toBe(4);
  // Simulate a crash after durable task receipts but before batch operation links are saved.
  const index = first.run!; for (const item of index.items) delete item.operationId;
  await saveBatchRun(f.root,index); complete = true;
  const second = await runBatch(f.root,f.batch.plan.batchId,false,{client,fetcher},polling);
  expect(second.run!.status,JSON.stringify(second.run!.items.filter(i=>i.error))).toBe('complete'); expect(posts).toBe(6);
  const another = await createBatchPlan(f.root,{episodes:['ep-z']});
  expect(another.summary.reusable).toBe(6);
  expect((await runBatch(f.root,another.plan.batchId,true,{client,fetcher},polling)).run!.status).toBe('complete'); expect(posts).toBe(6);
},90000);

it('shares capacity across two projects and normal generate/submit-only; scheduler ownership is exclusive',async()=>{
  const a=await batchFixture([3]), b=await batchFixture([3]); let posts=0;
  const client:VideoClient={async create(){return {taskId:'shared-'+ ++posts,evidence};},async query(taskId){return {taskId,status:'running',rawStatus:'running',evidence};}};
  const planA=a.batch.plan.items[0]!.planId, planB=b.batch.plan.items[0]!.planId;
  for(const id of ['s1','s2','s3']) await submit(a.root,planA,id,true,{client});
  const cli=await runCli(['generate','--root',b.root,'--plan',planB,'--segment','s1','--confirm','--submit-only'],{client});
  expect(cli.exitCode).toBe(0); expect(posts).toBe(4);
  await expect(submit(b.root,planB,'s2',true,{client})).rejects.toMatchObject({code:'CAPACITY_FULL'});
  const result=await runBatch(b.root,b.batch.plan.batchId,true,{client},polling); expect(result.summary.pending).toBe(2);expect(posts).toBe(4);
  const scheduler=await acquireScheduler(runtimeDirectory());
  try {
    await expect(submit(b.root,planB,'s2',true,{client})).rejects.toMatchObject({code:'SCHEDULER_BUSY'});
    await expect(runBatch(a.root,a.batch.plan.batchId,true,{client},{...polling,schedulerWaitMs:0})).rejects.toMatchObject({code:'LOCK_BUSY'});
  }finally{await scheduler.release();}
  expect(occupied(await reconcileRuntime(a.root))).toHaveLength(4);
},60000);

it.each([401,402,403])('halts new dispatch on HTTP %i but preserves known tasks',async code=>{
  const f=await batchFixture([6]);let posts=0;
  const client=new MetasoClient('offline',async(_url,init)=>{
    if(init?.method==='POST'){posts++;return Response.json({error:'account rejected'},{status:code});}
    throw new Error('no accepted task');
  });
  const result=await runBatch(f.root,f.batch.plan.batchId,true,{client},polling);
  expect(posts).toBe(1);expect(result.summary).toMatchObject({failed:1,pending:5});expect(result.run!.status).toBe('needs_attention');
},30000);

it.each(['429-id','429-ambiguous','429-null','500','timeout','conflicting-id'])('never retries ambiguous creation: %s',async mode=>{
  const f=await batchFixture([5]);let posts=0;
  const client=new MetasoClient('offline',async(_url,init)=>{
    expect(init?.method).toBe('POST');posts++;
    if(mode==='timeout')throw new Error('connection ended after acceptance');
    if(mode==='429-id')return Response.json({error:'rate',task_id:'accepted'},{status:429});
    if(mode==='429-ambiguous')return Response.json({message:'busy'},{status:429});
    if(mode==='429-null')return Response.json({error:null,base_resp:{status_code:'0'}},{status:429});
    if(mode==='500')return Response.json({error:'server'},{status:500});
    return Response.json({task_id:'one',task:{id:'two'}});
  });
  const result=await runBatch(f.root,f.batch.plan.batchId,true,{client},polling);
  expect(posts).toBe(1);expect(result.items[0]!.job!.status).toBe('submit_unknown');
  await runBatch(f.root,f.batch.plan.batchId,false,{client},polling);expect(posts).toBe(1);
  expect(occupied(await reconcileRuntime(f.root))).toHaveLength(1);
},30000);

it('persists a finite safe-429 retry budget and does not reset it on resume',async()=>{
  const f=await batchFixture([1]);let posts=0,clock=Date.now();
  const client=new MetasoClient('offline',async()=>{posts++;return Response.json({error:'not accepted'},{status:429,headers:{'retry-after':'0.25'}});});
  const deps={client,now:()=>clock,sleep:async(ms:number)=>{clock+=ms;}};
  const result=await runBatch(f.root,f.batch.plan.batchId,true,deps,polling);
  expect(posts).toBe(3);expect(result.run!.items[0]!.retryHistory).toHaveLength(2);expect(result.run!.rateLimit.spentWaitMs).toBe(750);
  await runBatch(f.root,f.batch.plan.batchId,false,deps,polling);expect(posts).toBe(3);
},45000);

it('persists a successful safe-429 retry without an obsolete retry link or duplicate creation on resume',async()=>{
  const f=await batchFixture([1]);let posts=0,clock=Date.now();
  const client=new MetasoClient('offline',async(_url,init)=>{
    if(init?.method==='POST')return ++posts===1?Response.json({error:'not accepted'},{status:429}):Response.json({task_id:'retry-success'});
    return Response.json({task:{id:'retry-success',status:'succeeded',duration:7,content:{url:'https://example.com/out.mp4'}}});
  });
  const deps={client,fetcher,now:()=>clock,sleep:async(ms:number)=>{clock+=ms;}};
  const result=await runBatch(f.root,f.batch.plan.batchId,true,deps,polling);
  expect(result.run!.status).toBe('complete');expect(result.run!.items[0]!.retryOf).toBeUndefined();expect(result.run!.items[0]!.retryHistory).toHaveLength(1);
  await runBatch(f.root,f.batch.plan.batchId,false,deps,polling);expect(posts).toBe(2);
},30000);

it('retains query-unknown occupancy; definitive task failure releases capacity without retrying that segment',async()=>{
  const f=await batchFixture([6]);let posts=0,unknown=true,release!:()=>void;
  const firstFour=new Promise<void>(r=>{release=r;});
  const client:VideoClient={async create(){const n=++posts;if(n===4)release();if(n<=4)await firstFour;return {taskId:'state-'+ n,evidence};},async query(taskId){
    return {taskId,status:unknown?(taskId==='state-1'?'unknown':'running'):'failed',rawStatus:unknown?(taskId==='state-1'?'new-state':'running'):'failed',evidence};
  }};
  const first=await runBatch(f.root,f.batch.plan.batchId,true,{client},polling);
  expect(posts).toBe(4);expect(first.items[0]!.job!.status).toBe('query_unknown');expect(occupied(await reconcileRuntime(f.root))).toHaveLength(4);
  unknown=false;const second=await runBatch(f.root,f.batch.plan.batchId,false,{client},polling);
  expect(posts).toBe(6);expect(second.summary.failed).toBe(6);expect(second.run!.status).toBe('partial_failed');
},60000);

it('rejects changed sources and tampered batch/run/ledger records, while accepted tasks can still recover',async()=>{
  const f=await batchFixture([1]);let posts=0;
  const client:VideoClient={async create(){posts++;return {taskId:'stale',evidence};},async query(taskId){return {taskId,status:'running',rawStatus:'running',evidence};}};
  const p=await batchPath(f.root,f.batch.plan.batchId,'plan'),original=await readFile(p);
  const changed=JSON.parse(original.toString());changed.concurrency=3;await writeFile(p,JSON.stringify(changed));
  await expect(loadBatch(f.root,f.batch.plan.batchId)).rejects.toMatchObject({code:'BATCH_TAMPERED'});await writeFile(p,original);
  const story=await loadStory(f.root),source=join(f.root,story.episodes[0]!.source.textPath),bytes=await readFile(source);
  await writeFile(source,'changed');
  const blocked=await runBatch(f.root,f.batch.plan.batchId,true,{client},polling);expect(posts).toBe(0);expect(blocked.run!.status).toBe('needs_attention');
  await writeFile(source,bytes);await runBatch(f.root,f.batch.plan.batchId,false,{client},polling);expect(posts).toBe(1);
  await writeFile(source,'changed after acceptance');await runBatch(f.root,f.batch.plan.batchId,false,{client},polling);expect(posts).toBe(1);
  const rp=await batchPath(f.root,f.batch.plan.batchId,'run'),run=JSON.parse(await readFile(rp,'utf8'));run.authorization.batchHash='0'.repeat(64);await writeFile(rp,JSON.stringify(run));
  await expect(batchStatus(f.root,f.batch.plan.batchId)).rejects.toMatchObject({code:'BATCH_RUN_TAMPERED'});
  const ledger=join(runtimeDirectory(),'video-ledger.json'),record=JSON.parse(await readFile(ledger,'utf8'));record.slots=[];await writeFile(ledger,JSON.stringify(record));
  await expect(reconcileRuntime(f.root)).rejects.toMatchObject({code:'COORDINATOR_TAMPERED'});
},45000);

it('does not let a stale running query overwrite a persisted terminal result',async()=>{
  const f=await batchFixture([1]);let release!:()=>void,entered!:()=>void;
  const barrier=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const job=await submit(f.root,f.batch.plan.items[0]!.planId,'s1',true,{client:{async create(){return {taskId:'stale-get',evidence};},async query(){throw new Error();}}});
  const slow=resume(f.root,job.operationId,{client:{async create(){throw new Error();},async query(taskId){entered();await barrier;return {taskId,status:'running',rawStatus:'running',evidence};}}},{download:false,...polling});
  await started;
  const done=await resume(f.root,job.operationId,{client:{async create(){throw new Error();},async query(taskId){return {taskId,status:'generated',rawStatus:'succeeded',url:'https://example.com/out.mp4',duration:7,evidence};}}},{download:false,...polling});
  expect(done.status).toBe('generated');release();expect((await slow).status).toBe('generated');expect(occupied(await reconcileRuntime(f.root))).toHaveLength(0);
},30000);
