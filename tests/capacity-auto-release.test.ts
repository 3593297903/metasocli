import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile, rename, stat,mkdir,unlink } from 'node:fs/promises';
import { join,dirname,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanup,fixture } from './helpers.js';
import { batchFixture, evidence } from './batch-helpers.js';
import { submit } from '../src/jobs/submit.js';
import { inspectRuntime, occupied, reconcileRuntime, runtimeDirectory, capacityTransaction,mergeJob } from '../src/jobs/coordinator.js';
import { readJob,persistence,listJobs } from '../src/jobs/store.js';
import { resume,attachTask } from '../src/jobs/resume.js';
import { auditCapacitySlot, startCapacityAudit, beginCapacityObservation,recordCapacityEvent,applyCapacityEvent } from '../src/jobs/capacity-events.js';
import { ProviderError, type VideoClient } from '../src/metaso/client.js';
import { loadPlan } from '../src/core/planning.js';
import { runBatch } from '../src/jobs/batch.js';
import { createBatchPlan } from '../src/jobs/batch-store.js';
import { canonicalSha256 } from '../src/storage/canonical.js';
import { acquireLease } from '../src/storage/locking.js';
import { saveSubmissionOwner,submissionLeasePath } from '../src/jobs/submission-owner.js';
import * as submissionOwners from '../src/jobs/submission-owner.js';
import type { Job } from '../src/contracts/job.js';
import * as io from '../src/storage/io.js';
import { runCli } from '../src/cli/main.js';
import { importStory } from '../src/core/project.js';

const running=(taskId:string)=>({taskId,status:'running' as const,rawStatus:'running',evidence});
const generated=(taskId:string)=>({taskId,status:'generated' as const,rawStatus:'succeeded',duration:7,url:'https://example.test/offline.mp4',evidence});
async function evidenceFile(name:string){const folder=resolve(process.env.METASO_TEST_EVIDENCE_DIR??'.work/video-capacity');await mkdir(folder,{recursive:true});return join(folder,name);}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function seed(f:Awaited<ReturnType<typeof batchFixture>>,order:number,status:Job['status'],taskId?:string){
  const item=f.batch.plan.items[order]!,plan=await loadPlan(f.root,item.planId),time=new Date().toISOString();
  const job:Job={schemaVersion:1,operationId:randomUUID(),projectId:plan.projectId,planId:plan.planId,planHash:plan.planHash,episodeId:plan.episodeId,
    segmentId:item.segmentId,revision:plan.revision,requestHash:item.requestHash,inputHash:item.inputHash,attempt:1,status,createdAt:time,updatedAt:time,...(taskId?{taskId}:{})};
  await persistence.job(f.root,job);
  if(taskId)await persistence.receipt(f.root,{operationId:job.operationId,requestHash:job.requestHash,taskId,receivedAt:time,recoveredManually:false});
  return job;
}
async function audit(){const scan=startCapacityAudit(runtimeDirectory());await scan.done;scan.check();}

it('R3 patch 1: durable terminal journal wins after resume interruption and a later running response',async()=>{
  const f=await batchFixture([1]),job=await seed(f,0,'running','terminal-journal');await reconcileRuntime(f.root);
  const create=vi.fn(async()=>{throw Error('POST forbidden');});
  await resume(f.root,job.operationId,{client:{create,query:async id=>generated(id)},checkpoint:async point=>{
    if(point==='capacity-evidence-saved')throw Error('interrupted after durable terminal journal');
  }},{maxPolls:1,download:false});
  const path=join(f.root,'.metasocli/receipts',job.operationId+'-capacity.json'),bytes=await readFile(path);
  expect(JSON.parse(bytes.toString()).event.reason).toBe('provider_terminal');
  expect((await inspectRuntime()).slots[0]!.capacity!.terminal).toBe(false);
  const points:string[]=[];
  await resume(f.root,job.operationId,{client:{create,query:async id=>running(id)},checkpoint:async point=>{points.push(point);}},{maxPolls:1,download:false});
  await audit();
  expect((await inspectRuntime()).slots[0]!.capacity).toMatchObject({state:'released',reason:'provider_terminal',terminal:true});
  expect(points).toContain('capacity-released');expect(points).not.toContain('capacity-restored');
  expect(await readFile(path)).toEqual(bytes);expect(create).not.toHaveBeenCalled();
});

it('R3 patch 1: older terminal journal repairs an advanced watermark once; terminal tail is not rescanned or rewritten',async()=>{
  const f=await batchFixture([1]),job=await seed(f,0,'running','older-terminal');await reconcileRuntime(f.root);
  const seq=await beginCapacityObservation(f.root,job);
  await expect(recordCapacityEvent(f.root,{...job,status:'generated'},seq,'provider_terminal',evidence,undefined,async()=>{throw Error('journal gap');})).rejects.toThrow('journal gap');
  // Reproduce the old implementation's already persisted conflicting watermark.
  await capacityTransaction(runtimeDirectory(),async ledger=>{const cap=ledger.slots[0]!.capacity!;cap.issued=seq+2;cap.applied=seq+1;});
  await audit();expect((await inspectRuntime()).slots[0]!.capacity).toMatchObject({terminal:true,state:'released',applied:seq+1,issued:seq+2});
  const ledgerFile=join(runtimeDirectory(),'video-ledger.json'),bytes=await readFile(ledgerFile),stamp=(await stat(ledgerFile)).mtimeMs;
  const read=vi.spyOn(io,'readJson'),write=vi.spyOn(io,'writeJson');
  try{
    for(let n=0;n<3;n++)await audit();
    expect(read.mock.calls.some(([file])=>file.includes(job.operationId))).toBe(false);
    await recordCapacityEvent(f.root,job,seq+2,'remote_active_recovered',evidence);
    expect(write).not.toHaveBeenCalled();
  }finally{read.mockRestore();write.mockRestore();}
  expect(await readFile(ledgerFile)).toEqual(bytes);expect((await stat(ledgerFile)).mtimeMs).toBe(stamp);
});

it('R3 patch 2: attach receipt interrupted before Job, then register and submit reuse restores capacity exactly once',async()=>{
  const f=await batchFixture([1]),item=f.batch.plan.items[0]!;let posts=0;
  const client={async create(){posts++;throw Error('accepted, response lost');},query:async id=>running(id)};
  const old=await submit(f.root,item.planId,item.segmentId,true,{client});expect(occupied(await inspectRuntime())).toHaveLength(0);
  await expect(attachTask(f.root,old.operationId,'recovered-after-gap',true,{client,persistence:{receipt:persistence.receipt,async job(){throw Error('receipt before Job gap');}}})).rejects.toThrow('receipt before Job gap');
  await reconcileRuntime(f.root);
  expect((await inspectRuntime()).slots[0]).toMatchObject({taskId:'recovered-after-gap',capacity:{state:'held',reason:'remote_active_recovered'}});
  const bytes=await readFile(join(runtimeDirectory(),'video-ledger.json'));
  for(let n=0;n<2;n++){
    await reconcileRuntime(f.root);
    expect((await submit(f.root,item.planId,item.segmentId,true,{client})).operationId).toBe(old.operationId);
  }
  expect(await readFile(join(runtimeDirectory(),'video-ledger.json'))).toEqual(bytes);expect(posts).toBe(1);
});

it('R3 patch 3: mismatched Job taskId without receipt is a recoverable source conflict, not terminal evidence',async()=>{
  const f=await batchFixture([1]),job=await seed(f,0,'running','original-id'),other=await batchFixture([1]);
  await seed(other,0,'running','unrelated-id');await reconcileRuntime(f.root);await reconcileRuntime(other.root);
  const foreign=(await inspectRuntime()).slots.find(s=>s.root===other.root)!;await auditCapacitySlot(foreign,runtimeDirectory());
  const protectedSlot=(await inspectRuntime()).slots.find(s=>s.root===other.root);
  await unlink(join(f.root,'.metasocli/receipts',job.operationId+'.json'));
  await persistence.job(f.root,{...job,taskId:'wrong-id',status:'generated'});await audit();
  expect((await inspectRuntime()).slots.find(s=>s.operationId===job.operationId)).toMatchObject({taskId:'original-id',status:'running',capacity:{state:'released',reason:'source_unavailable',terminal:false}});
  expect((await inspectRuntime()).slots.find(s=>s.root===other.root)).toEqual(protectedSlot);
  await persistence.job(f.root,job);
  await persistence.receipt(f.root,{operationId:job.operationId,requestHash:job.requestHash,taskId:job.taskId!,receivedAt:job.createdAt,recoveredManually:true});
  await resume(f.root,job.operationId,{client:{create:async()=>{throw Error('no POST');},query:async id=>running(id)}},{maxPolls:1,download:false});
  expect((await inspectRuntime()).slots.find(s=>s.operationId===job.operationId)).toMatchObject({taskId:'original-id',status:'running',capacity:{state:'held',terminal:false}});
});

it('R3 patch 4: equal input hashes in different segments and episodes submit independently; same segment reuses and explicit retry is once',async()=>{
  const line='完全相同的正文与素材。\n',f=await fixture(line+line);
  await importStory(f.root,{...f.draft,segments:[{id:'s1',start:0,end:line.length,duration:7},{id:'s2',start:line.length,end:line.length*2,duration:7}]});
  const source=join(dirname(f.root),'one-line.txt');await writeFile(source,line);
  await importStory(f.root,{...f.draft,source,episodeId:'ep-2',segments:[{id:'s1',start:0,end:line.length,duration:7}]});
  const batch=(await createBatchPlan(f.root,{episodes:['ep-1','ep-2']})).plan;
  expect(new Set(batch.items.map(i=>i.inputHash)).size).toBe(1);
  let posts=0;const client={async create(){posts++;throw Error('unknown response');},query:async id=>running(id)};
  const jobs=[];for(const i of batch.items)jobs.push(await submit(f.root,i.planId,i.segmentId,true,{client}));
  expect(posts).toBe(3);expect(new Set(jobs.map(j=>j.operationId)).size).toBe(3);
  const another=(await createBatchPlan(f.root,{episodes:['ep-1']})).plan.items[0]!;
  expect((await submit(f.root,another.planId,another.segmentId,true,{client})).operationId).toBe(jobs[0]!.operationId);expect(posts).toBe(3);
  const i=batch.items[0]!,old=jobs[0]!;
  const retry=await submit(f.root,i.planId,i.segmentId,true,{client},old.operationId,true);
  expect((await submit(f.root,i.planId,i.segmentId,true,{client},old.operationId,true)).operationId).toBe(retry.operationId);
  expect(posts).toBe(4);expect((await readJob(f.root,old.operationId)).status).toBe('submit_unknown');
},60000);

afterEach(cleanup);
it('R3 patch 1 reverse: a terminal journal with another task ID never gets absorbing priority',async()=>{
  const f=await batchFixture([1]),job=await seed(f,0,'running','trusted-id');await reconcileRuntime(f.root);
  const seq=await beginCapacityObservation(f.root,job);await capacityTransaction(runtimeDirectory(),async ledger=>{ledger.slots[0]!.capacity!.applied=seq;});
  const event={projectId:job.projectId,operationId:job.operationId,requestHash:job.requestHash,inputHash:job.inputHash,sequence:seq,reason:'provider_terminal' as const,evidence:canonicalSha256(evidence),taskId:'another-id',status:'generated' as const};
  await expect(applyCapacityEvent(f.root,event)).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});
  await io.writeJson(join(f.root,'.metasocli/receipts',job.operationId+'-capacity.json'),{event,hash:canonicalSha256(event)});
  await audit();expect((await inspectRuntime()).slots[0]).toMatchObject({taskId:'trusted-id',status:'running',capacity:{reason:'source_unavailable',terminal:false}});
});

it('R3 patch 2 reverse: an already indexed no-ID release gap repairs once, but old receipts cannot undo later query release',async()=>{
  const f=await batchFixture([1]),i=f.batch.plan.items[0]!;let posts=0;
  const client={async create(){posts++;throw Error('unknown');},query:async id=>running(id)};
  const old=await submit(f.root,i.planId,i.segmentId,true,{client});
  await persistence.receipt(f.root,{operationId:old.operationId,requestHash:old.requestHash,taskId:'already-indexed',receivedAt:new Date().toISOString(),recoveredManually:true});
  // Preserve the exact old-version gap: ID indexed, no-ID release decision unchanged.
  await capacityTransaction(runtimeDirectory(),async ledger=>{mergeJob(ledger,f.root,await readJob(f.root,old.operationId));});
  expect((await inspectRuntime()).slots[0]).toMatchObject({taskId:'already-indexed',capacity:{state:'released',reason:'create_ended_without_id'}});
  await audit();expect(occupied(await inspectRuntime())).toHaveLength(1);
  await resume(f.root,old.operationId,{client:{...client,query:async()=>{throw Error('new actual GET failure');}}},{download:false,maxPolls:1});
  const cap=(await inspectRuntime()).slots[0]!.capacity;expect(cap?.reason).toBe('query_unavailable');
  for(let n=0;n<2;n++){await reconcileRuntime(f.root);await submit(f.root,i.planId,i.segmentId,true,{client});await audit();}
  expect((await inspectRuntime()).slots[0]!.capacity).toEqual(cap);expect(occupied(await inspectRuntime())).toHaveLength(0);
  await resume(f.root,old.operationId,{client},{download:false,maxPolls:1});expect(occupied(await inspectRuntime())).toHaveLength(1);expect(posts).toBe(1);
});

it('R3 patch 2 reverse: first valid receipt after source loss restores; stale errors and the same receipt do not create observations',async()=>{
  const f=await batchFixture([1]),j=await seed(f,0,'submit_unknown');j.lastError={code:'QUERY_FAILED',message:'old source error'};await persistence.job(f.root,j);
  await reconcileRuntime(f.root);const path=join(f.root,'.metasocli/jobs',j.operationId+'.json'),bytes=await readFile(path);
  await writeFile(path,'unreadable source');await audit();expect((await inspectRuntime()).slots[0]!.capacity?.reason).toBe('source_unavailable');
  await writeFile(path,bytes);await persistence.receipt(f.root,{operationId:j.operationId,requestHash:j.requestHash,taskId:'first-valid-receipt',receivedAt:new Date().toISOString(),recoveredManually:true});
  await reconcileRuntime(f.root);const ledger=await readFile(join(runtimeDirectory(),'video-ledger.json'));
  await audit();expect(await readFile(join(runtimeDirectory(),'video-ledger.json'))).toEqual(ledger);expect(occupied(await inspectRuntime())).toHaveLength(1);
  await writeFile(path,'different broken source');await audit();expect(occupied(await inspectRuntime())).toHaveLength(0);
  await writeFile(path,bytes);await reconcileRuntime(f.root);expect(occupied(await inspectRuntime())).toHaveLength(0);
  await resume(f.root,j.operationId,{client:{create:async()=>{throw Error('no POST');},query:async id=>running(id)}},{download:false,maxPolls:1});
  expect(occupied(await inspectRuntime())).toHaveLength(1);
});

it('R3 patch 2 reverse: a bare task ID or conflicting receipt cannot restore a released reservation',async()=>{
  const f=await batchFixture([1]),j=await seed(f,0,'submit_unknown');await reconcileRuntime(f.root);await audit();
  await persistence.job(f.root,{...j,status:'queued',taskId:'unproven-id'});await reconcileRuntime(f.root);
  expect((await inspectRuntime()).slots[0]).toMatchObject({capacity:{state:'released',terminal:false}});
  expect((await inspectRuntime()).slots[0]!.taskId).toBeUndefined();
  await io.writeJson(join(f.root,'.metasocli/receipts',j.operationId+'.json'),{operationId:randomUUID(),requestHash:j.requestHash,taskId:'unproven-id',receivedAt:j.createdAt,recoveredManually:true});
  await expect(reconcileRuntime(f.root)).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});expect(occupied(await inspectRuntime())).toHaveLength(0);
});

it('R3 patch 2 performance: unchanged evidence avoids a second owner read but an equal-fingerprint receipt gap is still repaired',async()=>{
  const f=await batchFixture([1]),j=await seed(f,0,'running','cached-receipt');await reconcileRuntime(f.root);await audit();
  const owners=vi.spyOn(submissionOwners,'liveSubmissionLease');
  try{
    await audit();expect(owners).toHaveBeenCalledTimes(1); // Fresh owner check outside the shared transaction.
    await capacityTransaction(runtimeDirectory(),async ledger=>{const cap=ledger.slots[0]!.capacity!;cap.state='released';cap.reason='create_ended_without_id';cap.version++;});
    owners.mockClear();await audit();expect(owners).toHaveBeenCalledTimes(2);
    expect((await inspectRuntime()).slots[0]).toMatchObject({taskId:j.taskId,capacity:{state:'held',reason:'remote_active_recovered'}});
  }finally{owners.mockRestore();}
});

it('R3 patch 2 reverse: a pending no-ID journal cannot release the receipt recovered afterwards',async()=>{
  const f=await batchFixture([1]),i=f.batch.plan.items[0]!;let posts=0;
  const client={async create(){posts++;throw Error('unknown');},query:async id=>running(id)};
  await expect(submit(f.root,i.planId,i.segmentId,true,{client,checkpoint:async point=>{if(point==='capacity-evidence-saved')throw Error('create journal gap');}})).rejects.toThrow('create journal gap');
  const old=(await listJobs(f.root))[0]!;
  await expect(attachTask(f.root,old.operationId,'new-valid-id',true,{client,persistence:{receipt:persistence.receipt,async job(){throw Error('attach receipt gap');}}})).rejects.toThrow('attach receipt gap');
  await reconcileRuntime(f.root);await audit();
  expect((await inspectRuntime()).slots[0]).toMatchObject({taskId:'new-valid-id',capacity:{state:'held',terminal:false}});
  const ledger=await readFile(join(runtimeDirectory(),'video-ledger.json'));await audit();expect(await readFile(join(runtimeDirectory(),'video-ledger.json'))).toEqual(ledger);expect(posts).toBe(1);
});

it('R3 patch 2 reverse: recovered receipt is counted as the fifth before a sixth dispatch, and original IDs still download',async()=>{
  const f=await batchFixture([6]);let posts=0,done=false;
  const client={async create(){const id='receipt-gap-'+(++posts);if(posts===1)throw Error('accepted, response lost');return {taskId:id,evidence};},query:async id=>done?generated(id):running(id)};
  const first=f.batch.plan.items[0]!,old=await submit(f.root,first.planId,first.segmentId,true,{client});
  for(const i of f.batch.plan.items.slice(1,5))await submit(f.root,i.planId,i.segmentId,true,{client});
  await expect(attachTask(f.root,old.operationId,'receipt-gap-1',true,{client,persistence:{receipt:persistence.receipt,async job(){throw Error('interrupted receipt');}}})).rejects.toThrow('interrupted receipt');
  const sixth=f.batch.plan.items[5]!;
  await expect(submit(f.root,sixth.planId,sixth.segmentId,true,{client})).rejects.toMatchObject({code:'CAPACITY_FULL'});
  expect(occupied(await inspectRuntime())).toHaveLength(5);expect(posts).toBe(5);
  done=true;
  for(const j of await listJobs(f.root))expect((await resume(f.root,j.operationId,{client,fetcher:async()=>new Response((await import('./helpers.js')).mp4(7))},{maxPolls:1})).status).toBe('downloaded');
  expect(posts).toBe(5);expect(occupied(await inspectRuntime())).toHaveLength(0);
  await writeFile(await evidenceFile('r3-fixes-receipt-fifth.json'),JSON.stringify({posts,originalOperationId:old.operationId,recoveredId:'receipt-gap-1',heldAfterRecovery:5,sixthPosts:0,downloaded:5},null,2));
},60000);

it('R3 patch 3 reverse: trusted terminal capacity is not revoked by later corrupt source or wrong Job taskId',async()=>{
  const f=await batchFixture([1]),j=await seed(f,0,'running','trusted-terminal');await reconcileRuntime(f.root);
  await resume(f.root,j.operationId,{client:{create:async()=>{throw Error('no POST');},query:async id=>generated(id)}},{download:false,maxPolls:1});
  const before=await readFile(join(runtimeDirectory(),'video-ledger.json'));
  await persistence.job(f.root,{...j,taskId:'wrong-id'});await audit();
  await auditCapacitySlot((await inspectRuntime()).slots[0]!,runtimeDirectory());expect(await readFile(join(runtimeDirectory(),'video-ledger.json'))).toEqual(before);
});

it('R3 patch 4 reverse: released filtering never exempts a distinct unresolved IR operation',async()=>{
  const f=await batchFixture([2]),first=f.batch.plan.items[0]!,second=f.batch.plan.items[1]!;
  const {createPlan}=await import('../src/core/planning.js'),{submitContextIr}=await import('../src/jobs/context-ir.js');
  const prepare=await createPlan(f.root,'ep-z','h3-context-ir');
  const ir=await submitContextIr(f.root,prepare.planId,first.segmentId,true,{client:{async createContextIr(){throw Error('IR unknown');},async queryContextIr(){throw Error('no GET');}}});
  expect(ir.status).toBe('submit_unknown');
  await expect(submit(f.root,second.planId,second.segmentId,true,{client:{async create(){throw Error('POST forbidden');},query:async id=>running(id)}})).rejects.toMatchObject({code:'SUBMIT_UNKNOWN'});
});

it('R3 releases an ended unknown creation, preserves the unknown and never resends its input', async () => {
  const f = await batchFixture([2]); let posts = 0;
  const client = { async create() { posts++; throw new Error('offline connection reset'); }, async query() { throw new Error('no GET'); } };
  const [a,b] = f.batch.plan.items;
  const old = await submit(f.root,a!.planId,a!.segmentId,true,{client});
  expect(old.status).toBe('submit_unknown');
  expect(occupied(await inspectRuntime())).toHaveLength(0);
  await reconcileRuntime(f.root);
  expect(occupied(await inspectRuntime())).toHaveLength(0);
  expect((await submit(f.root,a!.planId,a!.segmentId,true,{client})).operationId).toBe(old.operationId);
  await submit(f.root,b!.planId,b!.segmentId,true,{client});
  expect(posts).toBe(2); expect((await readJob(f.root,old.operationId)).status).toBe('submit_unknown');
},60000);

it('four legacy no-ID cases release without changing Jobs or sending anything; repeated audits and register do not resurrect',async()=>{
  const f=await batchFixture([4]);const jobs=[];
  for(let i=0;i<4;i++)jobs.push(await seed(f,i,i===3?'submitting':'submit_unknown'));
  const before=await Promise.all(jobs.map(j=>readFile(join(f.root,'.metasocli/jobs',j.operationId+'.json'))));
  await reconcileRuntime(f.root);expect(occupied(await inspectRuntime())).toHaveLength(4);
  await audit();expect(occupied(await inspectRuntime())).toHaveLength(0);
  const ledger=await readFile(join(runtimeDirectory(),'video-ledger.json')),owner=await stat(join(runtimeDirectory(),'owner.json'));
  for(let n=0;n<20;n++){await audit();await reconcileRuntime(f.root);}
  expect(await readFile(join(runtimeDirectory(),'video-ledger.json'))).toEqual(ledger);
  expect((await stat(join(runtimeDirectory(),'owner.json'))).mtimeMs).toBe(owner.mtimeMs);
  expect(await Promise.all(jobs.map(j=>readFile(join(f.root,'.metasocli/jobs',j.operationId+'.json'))))).toEqual(before);
  expect((await inspectRuntime()).slots.map(s=>s.capacity?.reason)).toEqual(['create_ended_without_id','create_ended_without_id','create_ended_without_id','submitter_exited_without_id']);
},60000);

it.each(['submitting','prepared'] as const)('live %s owner remains protected including the reservation/receipt window',async status=>{
  const f=await batchFixture([1]),job=await seed(f,0,status),lease=await acquireLease(await submissionLeasePath(f.root,job.operationId));
  try{
    await saveSubmissionOwner(f.root,job,lease.token,runtimeDirectory());await reconcileRuntime(f.root);
    if(status==='prepared')await capacityTransaction(runtimeDirectory(),async ledger=>{
      const {slotFor,initialCapacity}=await import('../src/jobs/coordinator.js');const slot={...slotFor(f.root,job),status:'reserved' as const};slot.capacity=initialCapacity(slot);ledger.slots.push(slot);});
    await audit();expect(occupied(await inspectRuntime())).toHaveLength(1);
  }finally{await lease.release();}
  await audit();expect(occupied(await inspectRuntime())).toHaveLength(0);
});

it.each([300,600,3600])('known running stays held after %i seconds and POLL_LIMIT',async seconds=>{
  const f=await batchFixture([1]),j=await seed(f,0,'running','running-'+seconds);j.submittedAt=new Date(Date.now()-seconds*1000).toISOString();await persistence.job(f.root,j);
  await reconcileRuntime(f.root);await audit();
  const result=await resume(f.root,j.operationId,{client:{create:async()=>{throw Error('POST forbidden');},query:async id=>running(id)}},{maxPolls:1,download:false});
  expect(result.lastError?.code).toBe('POLL_LIMIT');await audit();expect(occupied(await inspectRuntime())).toHaveLength(1);
});

it.each(['timeout','ECONNRESET',401,403,404,500,'unknown','wrong-id'] as const)('actual GET %s releases without accepting a wrong identity or creating',async mode=>{
  const f=await batchFixture([1]),j=await seed(f,0,'queued','original');let gets=0;
  const client:VideoClient={async create(){throw Error('no POST');},async query(id){gets++;if(mode==='unknown')return {...running(id),status:'unknown'};if(mode==='wrong-id')return running('wrong');throw new ProviderError('PROVIDER_HTTP',String(mode),typeof mode==='number'?{httpStatus:mode}:{});}};
  await reconcileRuntime(f.root);const result=await resume(f.root,j.operationId,{client},{download:false,maxPolls:1});
  expect(result.taskId).toBe('original');expect(gets).toBe(1);expect(occupied(await inspectRuntime())).toHaveLength(0);
  expect((await inspectRuntime()).slots[0]?.capacity?.reason).toBe('query_unavailable');
});

it.each(['move','corrupt'] as const)('unavailable foreign source %s releases only its slot and never writes foreign files',async mode=>{
  const a=await batchFixture([1]),b=await batchFixture([1]);const job=await seed(a,0,'running','foreign');await reconcileRuntime(a.root);
  const old=join(a.root,'.metasocli/jobs',job.operationId+'.json');
  if(mode==='move')await rename(a.root,join(dirname(a.root),'moved'));else await writeFile(old,'broken-original');
  let posts=0;const i=b.batch.plan.items[0]!;
  await submit(b.root,i.planId,i.segmentId,true,{client:{async create(){posts++;return {taskId:'new',evidence};},query:async id=>running(id)}});
  const slot=(await inspectRuntime()).slots.find(s=>s.operationId===job.operationId)!;
  expect(slot.capacity?.reason).toBe('source_unavailable');expect(slot.capacity?.state).toBe('released');expect(posts).toBe(1);
  if(mode==='corrupt')expect(await readFile(old,'utf8')).toBe('broken-original');
});

it('receipt saved before Job indexing recovers its original ID without any POST',async()=>{
  const f=await batchFixture([1]),j=await seed(f,0,'submitting');await reconcileRuntime(f.root);
  await persistence.receipt(f.root,{operationId:j.operationId,requestHash:j.requestHash,taskId:'saved-receipt',receivedAt:new Date().toISOString(),recoveredManually:false});
  await audit();expect((await inspectRuntime()).slots[0]?.taskId).toBe('saved-receipt');
  const item=f.batch.plan.items[0]!;
  expect((await submit(f.root,item.planId,item.segmentId,true,{client:{async create(){throw Error('must not POST');},query:async id=>running(id)}})).taskId).toBe('saved-receipt');
});

it('late active recovery can produce five held slots; stale errors/running never override fresh evidence or terminal',async()=>{
  const f=await batchFixture([5]);const jobs=[];
  for(let i=0;i<5;i++)jobs.push(await seed(f,i,'running','late-'+i));await reconcileRuntime(f.root);
  const j=jobs[0]!,old=await beginCapacityObservation(f.root,j);
  await recordCapacityEvent(f.root,j,old,'query_unavailable',{error:'old'});
  expect(occupied(await inspectRuntime())).toHaveLength(4);
  const fresh=await beginCapacityObservation(f.root,j);
  await recordCapacityEvent(f.root,j,fresh,'remote_active_recovered',evidence);
  await recordCapacityEvent(f.root,j,old,'query_unavailable',{error:'old'});
  await reconcileRuntime(f.root);expect(occupied(await inspectRuntime())).toHaveLength(5);
  const b=await batchFixture([1]),item=b.batch.plan.items[0]!;
  await expect(submit(b.root,item.planId,item.segmentId,true,{client:{async create(){throw Error('no sixth POST');},query:async id=>running(id)}})).rejects.toMatchObject({code:'CAPACITY_FULL'});
  const first=await beginCapacityObservation(f.root,j),last=await beginCapacityObservation(f.root,j);
  await recordCapacityEvent(f.root,j,first,'provider_terminal',evidence);
  await recordCapacityEvent(f.root,j,last,'remote_active_recovered',evidence);
  expect((await inspectRuntime()).slots[0]?.capacity).toMatchObject({state:'released',terminal:true});
});

it('accepted-but-lost response permits five actual fake remote tasks; late ID restores five held and blocks a sixth POST',async()=>{
  const f=await batchFixture([6]),remote=new Set<string>();let posts=0,done=false;
  const client:VideoClient={async create(){const id='accepted-'+(++posts);remote.add(id);if(posts===1)throw Error('accepted but response lost');return {taskId:id,evidence};},
    async query(id){expect(remote.has(id)).toBe(true);return done?generated(id):running(id);}};
  const first=f.batch.plan.items[0]!,lost=await submit(f.root,first.planId,first.segmentId,true,{client});
  for(const item of f.batch.plan.items.slice(1,5))await submit(f.root,item.planId,item.segmentId,true,{client});
  expect(remote.size).toBe(5);expect(occupied(await inspectRuntime())).toHaveLength(4);
  await attachTask(f.root,lost.operationId,'accepted-1',true,{client});
  expect(occupied(await inspectRuntime())).toHaveLength(5);
  const sixth=f.batch.plan.items[5]!;
  await expect(submit(f.root,sixth.planId,sixth.segmentId,true,{client})).rejects.toMatchObject({code:'CAPACITY_FULL'});
  done=true;
  for(const job of await listJobs(f.root))expect((await resume(f.root,job.operationId,{client,fetcher:async()=>new Response((await import('./helpers.js')).mp4(7))},{maxPolls:1})).status).toBe('downloaded');
  expect(posts).toBe(5);expect(occupied(await inspectRuntime())).toHaveLength(0);
  await writeFile(await evidenceFile('r3-actual-remote-five.json'),JSON.stringify({fakeOnly:true,actualRemoteTasks:[...remote],posts,restoredHeld:5,sixthRejected:true,recoveryPosts:0},null,2));
},60000);

it('provider terminal metadata mismatch releases generation but delivery remains failed',async()=>{
  const f=await batchFixture([1]),j=await seed(f,0,'running','bad-metadata');await reconcileRuntime(f.root);
  const result=await resume(f.root,j.operationId,{client:{async create(){throw Error('no POST');},async query(id){return {...generated(id),duration:999,url:undefined};}}},{maxPolls:1});
  expect(result.lastError?.code).toBe('RESULT_METADATA');expect(result.output).toBeUndefined();expect(occupied(await inspectRuntime())).toHaveLength(0);
});

it('capacity changes wake batch while three creates and a GET retry chain remain slow',async()=>{
  const f=await batchFixture([6]),slow=gate(),fifth=gate(),four=gate();let posts=0,queries=0;
  const client:VideoClient={async create(){const n=++posts;if(n===4)four.resolve();if(n===1){await four.promise;throw Error('ended create');}if(n<=4)await slow.promise;if(n===5)fifth.resolve();return {taskId:'slow-'+n,evidence};},
    async query(id){queries++;return generated(id);}};
  const work=runBatch(f.root,f.batch.plan.batchId,true,{client,fetcher:async()=>new Response((await import('./helpers.js')).mp4(7))},{maxPolls:1,pollIntervalMs:0});
  try{await fifth.promise;expect(posts).toBe(5);}finally{slow.resolve();four.resolve();}
  const result=await work;expect(posts).toBe(6);expect(result.summary.reusable).toBe(5);expect(result.items[0]?.job?.status).toBe('submit_unknown');expect(queries).toBeGreaterThan(0);
},60000);

it('a failed GET releases before its bounded retry delay, and later same-ID running restores',async()=>{
  const f=await batchFixture([1]),j=await seed(f,0,'running','retry-get');await reconcileRuntime(f.root);
  let gets=0;const waiting=gate(),release=gate();
  const work=resume(f.root,j.operationId,{client:{async create(){throw Error('no POST');},async query(id){if(++gets===1)throw new ProviderError('PROVIDER_HTTP','offline 500',{retryable:true,httpStatus:500});return running(id);}},
    sleep:async()=>{waiting.resolve();await release.promise;}},{download:false,maxPolls:1});
  try{await waiting.promise;expect(occupied(await inspectRuntime())).toHaveLength(0);}finally{release.resolve();}
  await work;expect(gets).toBe(2);expect(occupied(await inspectRuntime())).toHaveLength(1);
});

it('a slow foreign small-file read does not delay the first legal POST or another ready release',async()=>{
  const a=await batchFixture([2]),b=await batchFixture([1]);const j=await seed(a,0,'running','slow-source'),fast=await seed(a,1,'submit_unknown');await reconcileRuntime(a.root);
  const slow=gate(),entered=gate(),posted=gate();const original=io.readJson;
  const spy=vi.spyOn(io,'readJson').mockImplementation(async file=>{if(file.endsWith(j.operationId+'.json')){entered.resolve();await slow.promise;}return original(file);});
  const i=b.batch.plan.items[0]!;
  const work=submit(b.root,i.planId,i.segmentId,true,{client:{async create(){posted.resolve();return {taskId:'without-wait',evidence};},query:async id=>running(id)}});
  try{await entered.promise;await posted.promise;for(let n=0;n<50&&(await inspectRuntime()).slots.find(s=>s.operationId===fast.operationId)?.capacity?.state!=='released';n++)await new Promise(r=>setTimeout(r,10));
    expect((await inspectRuntime()).slots.find(s=>s.operationId===fast.operationId)?.capacity?.state).toBe('released');
  }finally{slow.resolve();await work;spy.mockRestore();}
});

it('cold migration is backed up once; read-only status does not migrate; shared corruption is never cleared',async()=>{
  const f=await batchFixture([1]);await seed(f,0,'running','legacy');await reconcileRuntime(f.root);
  const current=await inspectRuntime(),file=join(runtimeDirectory(),'video-ledger.json');
  const base={schemaVersion:1,owner:'metasocli',projects:current.projects.map(({coverage,...p})=>p),slots:current.slots.map(({capacity,...s})=>s)};
  const legacy={...base,hash:canonicalSha256(base)};await io.writeJson(file,legacy);
  expect((await inspectRuntime()).schemaVersion).toBe(1);expect(JSON.parse(await readFile(file,'utf8')).schemaVersion).toBe(1);
  await reconcileRuntime(f.root);const backup=join(runtimeDirectory(),'video-ledger.v1-'+legacy.hash+'.json');const bytes=await readFile(backup);
  await reconcileRuntime(f.root);expect(await readFile(backup)).toEqual(bytes);expect((await inspectRuntime()).schemaVersion).toBe(2);
  const broken={...await inspectRuntime(),hash:'0'.repeat(64)};await io.writeJson(file,broken);
  await expect(audit()).rejects.toMatchObject({code:'COORDINATOR_TAMPERED'});expect(JSON.parse(await readFile(file,'utf8'))).toEqual(broken);
});

it('batch replenishes on the first GET failure notification before its retry chain or other GETs end',async()=>{
  const f=await batchFixture([5]),fifth=gate(),released=gate();let posts=0,failedOnce=false,delayEntered=false;
  const client:VideoClient={async create(){const n=++posts;if(n===5){expect(delayEntered).toBe(true);fifth.resolve();}return {taskId:'wake-'+n,evidence};},
    async query(id){if(id==='wake-1'&&!failedOnce){failedOnce=true;throw new ProviderError('PROVIDER_HTTP','retry later',{retryable:true,httpStatus:500});}
      await released.promise;return generated(id);}};
  const work=runBatch(f.root,f.batch.plan.batchId,true,{client,sleep:async()=>{delayEntered=true;await released.promise;},fetcher:async()=>new Response((await import('./helpers.js')).mp4(7))},{maxPolls:1,pollIntervalMs:0});
  try{await fifth.promise;expect(posts).toBe(5);}finally{released.resolve();}
  expect((await work).run?.status).toBe('complete');expect(posts).toBe(5);
},60000);

it('normal held queries get the four query workers before released recovery; no extra budget for released-only work',async()=>{
  const f=await batchFixture([8]);const jobs=[];
  for(let i=0;i<8;i++)jobs.push(await seed(f,i,'running','priority-'+i));await reconcileRuntime(f.root);
  for(const job of jobs.slice(0,4)){const seq=await beginCapacityObservation(f.root,job);await recordCapacityEvent(f.root,job,seq,'query_unavailable',{old:true});}
  const gets:string[]=[];const four=gate();
  const client:VideoClient={async create(){throw Error('no POST');},async query(id){gets.push(id);if(gets.length===4)four.resolve();await four.promise;return {...running(id),status:'unknown'};}};
  await runBatch(f.root,f.batch.plan.batchId,true,{client},{maxPolls:60,pollIntervalMs:0});
  expect(new Set(gets.slice(0,4))).toEqual(new Set(['priority-4','priority-5','priority-6','priority-7']));
  expect(gets.every(id=>!['priority-0','priority-1','priority-2','priority-3'].includes(id))).toBe(true);
  const single=await batchFixture([1]),j=await seed(single,0,'queued','only');await reconcileRuntime(single.root);let count=0;
  await runBatch(single.root,single.batch.plan.batchId,true,{client:{async create(){throw Error('no POST');},async query(id){count++;return {...running(id),status:'unknown'};}}},{maxPolls:60,pollIntervalMs:0});
  expect(count).toBe(1);expect((await readJob(single.root,j.operationId)).taskId).toBe('only');
},60000);

it('an authorized new input can coexist with released old input, while unchanged input across new batch is not resent',async()=>{
  const f=await batchFixture([1]),i=f.batch.plan.items[0]!;let posts=0;
  const client={async create(){posts++;throw Error('offline ambiguous acceptance');},query:async id=>running(id)};
  const old=await submit(f.root,i.planId,i.segmentId,true,{client});
  const another=(await createBatchPlan(f.root,{episodes:f.episodeIds})).plan.items[0]!;
  expect((await submit(f.root,another.planId,another.segmentId,true,{client})).operationId).toBe(old.operationId);expect(posts).toBe(1);
  const source=join(dirname(f.root),'new-input.txt'),text='明确修改后的完整提示词。';await writeFile(source,text);
  const {replaceSegmentPrompt}=await import('../src/core/prompt-replacement.js');await replaceSegmentPrompt(f.root,{episodeId:'ep-z',segmentId:'s1',file:source});
  const changed=(await createBatchPlan(f.root,{episodes:f.episodeIds})).plan.items[0]!;
  const next=await submit(f.root,changed.planId,changed.segmentId,true,{client});expect(next.inputHash).not.toBe(old.inputHash);expect(posts).toBe(2);
},60000);

it.each([false,true])('stale accepted scope stops only for a current account failure (current=%s), never historical 401 evidence',async current=>{
  const f=await batchFixture([2]),first=await seed(f,0,'running','stale-first');await seed(f,1,'running','stale-second');await reconcileRuntime(f.root);
  const account=()=>new ProviderError('PROVIDER_HTTP','account unavailable',{httpStatus:401,evidence:{...evidence,httpStatus:401}});
  await resume(f.root,first.operationId,{client:{async create(){throw Error('no POST');},async query(){throw account();}}},{download:false,maxPolls:1});
  const {loadStory,saveStory}=await import('../src/core/project.js'),story=await loadStory(f.root);story.revision++;await saveStory(f.root,story);
  const queries:string[]=[];let posts=0,downloads=0;
  const result=await runCli(['video','execute','--root',f.root,'--batch',f.batch.plan.batchId,'--confirm','--max-polls','1','--poll-ms','0'],{
    client:{async create(){posts++;throw Error('no POST');},async query(id){queries.push(id);if(id==='stale-first')throw current?account():Error('current transport reset without evidence');return generated(id);}},
    fetcher:async()=>{downloads++;return new Response((await import('./helpers.js')).mp4(7));}});
  expect(result.exitCode).toBe(2);expect(queries).toEqual(current?['stale-first']:['stale-first','stale-second']);expect(downloads).toBe(current?0:1);expect(posts).toBe(0);
  expect((await readJob(f.root,first.operationId)).taskId).toBe('stale-first');
},60000);

it('a saved accepted Job missing from covered ledger is indexed before a new request reserves capacity',async()=>{
  const f=await batchFixture([2]);await reconcileRuntime(f.root);const old=await seed(f,0,'queued','gap-original');let count=0;
  const i=f.batch.plan.items[1]!;
  const next=await submit(f.root,i.planId,i.segmentId,true,{client:{async create(){count++;expect(occupied(await inspectRuntime())).toHaveLength(2);return {taskId:'gap-new',evidence};},query:async id=>running(id)}});
  expect(count).toBe(1);expect((await inspectRuntime()).slots.find(s=>s.operationId===old.operationId)?.taskId).toBe('gap-original');expect(next.taskId).toBe('gap-new');
});

it('unconfirmed prepare and read-only status preserve v1 bytes and perform no cleanup or calls',async()=>{
  const f=await batchFixture([1]);await seed(f,0,'submit_unknown');await reconcileRuntime(f.root);const before=await inspectRuntime();
  const base={schemaVersion:1,owner:'metasocli',projects:before.projects.map(({coverage,...p})=>p),slots:before.slots.map(({capacity,...s})=>s)};
  const file=join(runtimeDirectory(),'video-ledger.json');await io.writeJson(file,{...base,hash:canonicalSha256(base)});const bytes=await readFile(file);
  const client={async create(){throw Error('POST forbidden');},async query(){throw Error('GET forbidden');}};
  await runCli(['video','run','--root',f.root,'--batch',f.batch.plan.batchId],{client});
  await runCli(['status','--root',f.root],{client});expect(await readFile(file)).toEqual(bytes);
});

it('terminal-capacity-before-Job crash is recovered by the original ID and delivered without POST',async()=>{
  const f=await batchFixture([1]),i=f.batch.plan.items[0]!;let posts=0;
  const client={async create(){posts++;return {taskId:'terminal-gap',evidence};},query:async id=>generated(id)};
  const job=await submit(f.root,i.planId,i.segmentId,true,{client});
  await expect(resume(f.root,job.operationId,{client,checkpoint:async point=>{if(point==='terminal-before')throw Error('crash before Job');}},{download:false,maxPolls:1})).rejects.toThrow('crash before Job');
  expect((await readJob(f.root,job.operationId)).status).toBe('queued');expect(occupied(await inspectRuntime())).toHaveLength(0);
  const result=await runBatch(f.root,f.batch.plan.batchId,true,{client,fetcher:async()=>new Response((await import('./helpers.js')).mp4(7))},{maxPolls:1,pollIntervalMs:0});
  expect(result.run?.status).toBe('complete');expect(result.items[0]?.job?.taskId).toBe('terminal-gap');expect(posts).toBe(1);
});

it('a shared-store failure after HTTP acceptance cannot discard its local receipt',async()=>{
  const f=await batchFixture([1]),i=f.batch.plan.items[0]!,file=join(runtimeDirectory(),'video-ledger.json');let posts=0,healthy:Buffer;
  const client={async create(){posts++;healthy=await readFile(file);const broken=JSON.parse(healthy.toString());broken.hash='0'.repeat(64);await writeFile(file,JSON.stringify(broken));return {taskId:'late-known-receipt',evidence};},query:async id=>running(id)};
  await expect(submit(f.root,i.planId,i.segmentId,true,{client})).rejects.toThrow();
  const job=(await listJobs(f.root))[0]!;expect(job.taskId).toBe('late-known-receipt');
  expect(JSON.parse(await readFile(join(f.root,'.metasocli/receipts',job.operationId+'.json'),'utf8')).taskId).toBe('late-known-receipt');
  // Repair only this synthetic fault, preserving the original reservation and all receipts.
  await writeFile(file,healthy!);expect((await submit(f.root,i.planId,i.segmentId,true,{client})).operationId).toBe(job.operationId);expect(posts).toBe(1);
});

it('bounded stable JSON reads tolerate a transient missing pathname without source release',async()=>{
  const f=await batchFixture([1]),job=await seed(f,0,'running','atomic-read');await reconcileRuntime(f.root);
  const path=join(f.root,'.metasocli/jobs',job.operationId+'.json'),moved=path+'.held';let hit=false,restoring:Promise<void>|undefined;
  const original=io.readJson,spy=vi.spyOn(io,'readJson').mockImplementation(async file=>{
    if(file===path&&!hit){hit=true;await rename(path,moved);restoring=new Promise<void>((ok,bad)=>setTimeout(()=>{rename(moved,path).then(()=>ok(),bad);},15));}
    return original(file);
  });
  try{await audit();await restoring;expect(hit).toBe(true);expect(occupied(await inspectRuntime())).toHaveLength(1);expect((await inspectRuntime()).slots[0]?.capacity?.reason).not.toBe('source_unavailable');}
  finally{await restoring;spy.mockRestore();}
});

it('fresh active evidence survives the same old corrupt-source error; latest release and restore bases remain recorded',async()=>{
  const f=await batchFixture([1]),job=await seed(f,0,'running','corrupt-recovered');await reconcileRuntime(f.root);
  const path=join(f.root,'.metasocli/jobs',job.operationId+'.json'),bytes=await readFile(path);
  await writeFile(path,'broken');await audit();expect(occupied(await inspectRuntime())).toHaveLength(0);
  await writeFile(path,bytes);await resume(f.root,job.operationId,{client:{async create(){throw Error('no POST');},query:async id=>running(id)}},{download:false,maxPolls:1});
  await writeFile(path,'broken');await audit();
  expect((await inspectRuntime()).slots[0]?.capacity).toMatchObject({state:'held',lastRelease:{reason:'source_unavailable'},lastRestore:{reason:'remote_active_recovered'}});
  await writeFile(path,bytes);
});

it('R3 releases actual GET failure and restores the same ID on fresh running evidence', async () => {
  const f=await batchFixture([1]); let posts=0, unavailable=true;
  const client={async create(){posts++;return {taskId:'r3-task',evidence};},async query(taskId:string){if(unavailable)throw new Error('offline GET reset');return {taskId,status:'running' as const,rawStatus:'running',evidence};}};
  const i=f.batch.plan.items[0]!,job=await submit(f.root,i.planId,i.segmentId,true,{client});
  await resume(f.root,job.operationId,{client},{download:false,maxPolls:1});
  expect(occupied(await inspectRuntime())).toHaveLength(0);
  unavailable=false;
  await resume(f.root,job.operationId,{client},{download:false,maxPolls:1});
  expect(occupied(await inspectRuntime())).toHaveLength(1); expect(posts).toBe(1);
  expect((await readJob(f.root,job.operationId)).taskId).toBe('r3-task');
},60000);
