import { afterAll, afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanup } from './helpers.js';
import { batchFixture, evidence } from './batch-helpers.js';
import { imageFixture, imageResponse, profile } from './image-api-helpers.js';
import { isolationEvidence } from './project-isolation-helpers.js';
import { acquireLease } from '../src/storage/locking.js';
import { acquireScheduler, runtimeDirectory, reconcileRuntime, inspectRuntime, occupied } from '../src/jobs/coordinator.js';
import { acquireImageScheduler, imageRuntime, reconcileImageLedger } from '../src/images/coordinator.js';
import { runImages } from '../src/images/run.js';
import { createImagePlan } from '../src/images/planning.js';
import { readImageRun, readImagePlan, listImageJobs } from '../src/images/store.js';
import { submit } from '../src/jobs/submit.js';
import { loadPlan, validatePlan } from '../src/core/planning.js';
import { loadBatch } from '../src/jobs/batch-store.js';
import { effectiveImageTimeout } from '../src/images/transport.js';
import { runBatch } from '../src/jobs/batch.js';
import { batchStatus } from '../src/jobs/batch-store.js';
import { listJobs, persistence, receiptPath } from '../src/jobs/store.js';
import { resume } from '../src/jobs/resume.js';
import { canonicalSha256, sha256Hex } from '../src/storage/canonical.js';
afterEach(cleanup);const records:unknown[]=[];afterAll(()=>isolationEvidence('compat',records));
const client={async create(){return {taskId:'compat-known',evidence};},async query(taskId:string){return {taskId,status:'running' as const,rawStatus:'running',evidence};}};

it('C5/C6: a prepared local rollback cannot erase an older submitting ledger intent or POST again',async()=>{
  const f=await batchFixture([1]),p=f.batch.plan.items[0]!;let posts=0;
  const old=await submit(f.root,p.planId,'s1',true,{client:{...client,async create(){posts++;throw Error('response lost');}}});
  const file=join(runtimeDirectory(),'video-ledger.json'),ledger=JSON.parse(await readFile(file,'utf8'));ledger.slots[0].status='submitting';const {hash:_,...base}=ledger;ledger.hash=canonicalSha256(base);await writeFile(file,JSON.stringify(ledger));
  const rollback={...old,status:'prepared' as const};delete rollback.submittedAt;delete rollback.lastError;await persistence.job(f.root,rollback);
  await expect(submit(f.root,p.planId,'s1',true,{client:{...client,async create(){posts++;return {taskId:'must-not-post',evidence};}}})).rejects.toMatchObject({code:'COORDINATOR_CONFLICT'});
  expect(posts).toBe(1);expect((await inspectRuntime()).slots[0]).toMatchObject({operationId:old.operationId,status:'submitting'});expect(await listJobs(f.root)).toHaveLength(1);
  records.push({case:'C5/C6-intent-rollback',projectId:old.projectId,operationId:old.operationId,historicalPosts:1,recoveryPosts:0,retainedStatus:'submitting'});
});

it('C5/C6: accepted or terminal ledger evidence cannot become a fresh prepared POST after local rollback',async()=>{
  const f=await batchFixture([1]),p=f.batch.plan.items[0]!;let posts=0;
  const deps={client:{...client,async create(){posts++;return {taskId:'retained-terminal',evidence};},async query(taskId:string){return {taskId,status:'failed' as const,rawStatus:'failed',evidence};}}};
  const job=await submit(f.root,p.planId,'s1',true,deps);await resume(f.root,job.operationId,deps,{maxPolls:1,download:false});
  const before=(await inspectRuntime()).slots.find(s=>s.operationId===job.operationId)!;
  const rollback={...job,status:'prepared' as const};delete rollback.taskId;delete rollback.submittedAt;await persistence.job(f.root,rollback);await unlink(await receiptPath(f.root,job.operationId));
  await expect(submit(f.root,p.planId,'s1',true,deps)).rejects.toMatchObject({code:'COORDINATOR_CONFLICT'});
  expect((await inspectRuntime()).slots.find(s=>s.operationId===job.operationId)).toEqual(before);expect(posts).toBe(1);
  expect(occupied({...await inspectRuntime(),slots:[{...before,status:'prepared'}]})).toHaveLength(1);
  records.push({case:'C5/C6-ledger-evidence',operationId:job.operationId,taskId:before.taskId,terminal:before.status,posts,recoveryExtraPosts:0});
});

it.each(['video','image'] as const)('C3: %s legacy active/unknown locks forbid cold switch without stealing them',async kind=>{
  const f=await batchFixture([1]),file=kind==='video'?join(runtimeDirectory(),'batch.lock'):join(imageRuntime(profile),'scheduler.lock');
  const acquire=()=>kind==='video'?acquireScheduler(f.root,runtimeDirectory(),0):acquireImageScheduler(f.root,profile);
  const legacy=await acquireLease(file),bytes=await readFile(file);
  try{await expect(acquire()).rejects.toMatchObject({code:'LEGACY_SCHEDULER_BUSY'});expect(await readFile(file)).toEqual(bytes);}finally{await legacy.release();}
  await writeFile(file,'unreadable owner');await expect(acquire()).rejects.toMatchObject({code:'LOCK_UNKNOWN'});expect(await readFile(file,'utf8')).toBe('unreadable owner');await unlink(file);
  const lease=await acquire();await lease.release();
  records.push({case:'C3',kind,active:'preserved',unknown:'preserved',cleanSwitch:'passed'});
});

it('C1/C5: legacy image Run with foreign acknowledgement and prepared IDs resumes without flags; plan/run hashes and attempts stay traceable',async()=>{
  const a=await imageFixture(),b=await imageFixture(2),ap=(await createImagePlan(a.root,{episodes:['ep-1'],profile})).plan,bp=(await createImagePlan(b.root,{episodes:['ep-1'],profile})).plan;
  await runImages(a.root,ap.planId,true,{client:{async create(){throw Error('unknown');}}});const old=(await listImageJobs(a.root))[0]!;
  await expect(runImages(b.root,bp.planId,true,{client:{async create(){throw Error('must not POST');}},acceptExistingUnknown:[old.operationId],checkpoint:async(p)=>{if(p==='prepared')throw Error('interrupted');}})).rejects.toThrow('interrupted');
  const before=(await readImageRun(b.root,bp))!,jobs=await listImageJobs(b.root),planHash=bp.planHash;let posts=0;
  // Synthetic old v1 ledger has no optional quota/time metadata. Keep the same hash protocol.
  const file=join(imageRuntime(profile),'ledger.json'),ledger=JSON.parse(await readFile(file,'utf8'));for(const s of ledger.slots){delete s.limits;delete s.requestStartedAt;}const {hash:_,...base}=ledger;ledger.hash=canonicalSha256(base);await writeFile(file,JSON.stringify(ledger));
  expect((await readImagePlan(b.root,bp.planId)).planHash).toBe(planHash);
  const deps={client:{async create(){posts++;return imageResponse();}}};await runImages(b.root,bp.planId,false,deps);await runImages(b.root,bp.planId,false,deps);
  const after=(await readImageRun(b.root,bp))!;expect(after.authorization).toEqual(before.authorization);expect(after.items).toEqual(before.items);expect(posts).toBe(2);
  expect((await listImageJobs(b.root)).map(j=>[j.operationId,j.attempt])).toEqual(jobs.map(j=>[j.operationId,j.attempt]));
  records.push({case:'C1/C5',planHash,authorizationHash:canonicalSha256(before.authorization),operations:jobs.map(j=>j.operationId),posts,repeatedPosts:0});
});

it.each(['operation','task','hash'] as const)('C4: globally conflicting video %s still rejects before project filtering',async defect=>{
  const a=await batchFixture([1]),b=await batchFixture([1]);await submit(a.root,a.batch.plan.items[0]!.planId,'s1',true,{client});
  const file=join(runtimeDirectory(),'video-ledger.json'),ledger=JSON.parse(await readFile(file,'utf8'));
  if(defect==='operation')ledger.slots.push({...ledger.slots[0]});
  else if(defect==='task')ledger.slots.push({...ledger.slots[0],operationId:randomUUID()});
  else ledger.hash='0'.repeat(64);
  if(defect!=='hash'){const{hash:_,...base}=ledger;ledger.hash=canonicalSha256(base);}await writeFile(file,JSON.stringify(ledger));
  await expect(reconcileRuntime(b.root)).rejects.toMatchObject({code:defect==='hash'?'COORDINATOR_TAMPERED':defect==='task'?'TASK_LINK_CONFLICT':'COORDINATOR_CONFLICT'});
  records.push({case:'C4-video',defect,rejected:true});
});

it.each(['clone','operation','hash'] as const)('C4: globally conflicting image %s still rejects before project filtering',async defect=>{
  const a=await imageFixture(),b=await imageFixture(),p=(await createImagePlan(a.root,{episodes:['ep-1'],profile})).plan;
  await runImages(a.root,p.planId,true,{client:{async create(){throw Error('unknown');}}});
  if(defect==='clone'){const clone=join(dirname(a.root),'clone');await cp(a.root,clone,{recursive:true});await expect(reconcileImageLedger(clone,profile)).rejects.toMatchObject({code:'IMAGE_LEDGER_CONFLICT'});}
  else{const file=join(imageRuntime(profile),'ledger.json'),ledger=JSON.parse(await readFile(file,'utf8'));if(defect==='operation'){ledger.slots.push({...ledger.slots[0]});const{hash:_,...base}=ledger;ledger.hash=canonicalSha256(base);}else ledger.hash='0'.repeat(64);await writeFile(file,JSON.stringify(ledger));await expect(reconcileImageLedger(b.root,profile)).rejects.toMatchObject({code:defect==='hash'?'IMAGE_LEDGER_TAMPERED':'IMAGE_LEDGER_CONFLICT'});}
  records.push({case:'C4-image',defect,rejected:true});
});

it('C5/C6: old immutable video plan/body untouched by registration; status is read-only and no default enters hashes',async()=>{
  const f=await batchFixture([1]),p=await loadPlan(f.root,f.batch.plan.items[0]!.planId),before=canonicalSha256(p),batchBefore=f.batch.plan.batchHash;
  const request=(await validatePlan(f.root,p)).built[0]!.request;expect(request).toMatchObject({model:'MiniMax-H3',context_ir_enabled:true,duration:7});
  await reconcileRuntime(f.root);const ledgerFile=join(runtimeDirectory(),'video-ledger.json'),bytes=await readFile(ledgerFile);await inspectRuntime();expect(await readFile(ledgerFile)).toEqual(bytes);
  expect(canonicalSha256(await loadPlan(f.root,p.planId))).toBe(before);expect((await loadBatch(f.root,f.batch.plan.batchId)).batchHash).toBe(batchBefore);expect(effectiveImageTimeout(600000)).toBe(300000);expect(profile.model).toBe('gpt-image-2.5');
  records.push({case:'C5/C6',planHash:before,batchHash:batchBefore,bodyHash:canonicalSha256(request),ledgerHash:sha256Hex(bytes),imageTimeout:300000,posts:0});
});

it('C1: old video batch acknowledgement and reserved attempt survive interruption without another authorization',async()=>{
  const a=await batchFixture([1]),b=await batchFixture([1]);
  const old=await submit(a.root,a.batch.plan.items[0]!.planId,'s1',true,{client:{async create(){throw Error('unknown A');},async query(){throw Error('unused');}}});let posts=0;
  const deps={client:{async create(){posts++;return {taskId:'legacy-B',evidence};},async query(id:string){return {taskId:id,status:'running' as const,rawStatus:'running',evidence};}}};
  await runBatch(b.root,b.batch.plan.batchId,true,{...deps,acceptExistingUnknown:[old.operationId],checkpoint:async(point)=>{if(point==='reserved')throw Error('reserved interruption');}},{maxPolls:1,pollIntervalMs:0,capacityWaitMs:0});
  const original=(await listJobs(b.root))[0]!,before=(await batchStatus(b.root,b.batch.plan.batchId)).run!;expect(original.status).toBe('prepared');expect(posts).toBe(0);
  const options={maxPolls:1,pollIntervalMs:0,capacityWaitMs:0};await runBatch(b.root,b.batch.plan.batchId,false,deps,options);await runBatch(b.root,b.batch.plan.batchId,false,deps,options);
  expect(posts).toBe(1);expect((await listJobs(b.root))[0]).toMatchObject({operationId:original.operationId,attempt:original.attempt,taskId:'legacy-B'});expect((await batchStatus(b.root,b.batch.plan.batchId)).run!.authorization).toEqual(before.authorization);
  records.push({case:'C1-video',oldOperationId:old.operationId,newOperationId:original.operationId,posts,recoveryExtraPosts:0,authorizationHash:canonicalSha256(before.authorization)});
});
