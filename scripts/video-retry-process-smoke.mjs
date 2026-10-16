import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,dirname,relative,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { makeBatch,evidence } from './video-batch-process-fixture.mjs';
import { submit } from '../dist/jobs/submit.js';
import { runCli } from '../dist/cli/main.js';
import { authorizeVideoRetry,listVideoRetries,retryPath } from '../dist/jobs/video-retry.js';
import { occupied,reconcileRuntime } from '../dist/jobs/coordinator.js';
import { listJobs,persistence,readJob } from '../dist/jobs/store.js';
import { attachTask,resume } from '../dist/jobs/resume.js';
import { runBatch } from '../dist/jobs/batch.js';
import { batchStatus } from '../dist/jobs/batch-store.js';
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=await mkdtemp(join(tmpdir(),'metasocli-retry-process-')), previous=process.env.METASO_RUNTIME_DIR, children=new Set(),report=[];
globalThis.fetch=async()=>{throw new Error('Real network forbidden');};
function worker(f,old,point){
  const env={...process.env,PATH:dirname(process.execPath),USERPROFILE:join(base,'home'),HOME:join(base,'home')};delete env.METASO_API_KEY;delete env.METASOCLI_IMAGE_API_KEY;
  const child=spawn(process.execPath,[join(packageRoot,'scripts/video-retry-process-worker.mjs'),f.root,f.planId,f.batchId,old,point],{cwd:f.root,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  children.add(child);const messages=[];let stderr='';child.stderr.on('data',d=>stderr+=String(d));child.on('message',m=>messages.push(m));
  const ended=new Promise((r,j)=>{child.once('error',j);child.once('exit',code=>{children.delete(child);r(code);});});
  async function checkpoint(){const deadline=Date.now()+45000;while(Date.now()<deadline){if(messages.some(m=>m.checkpoint===point))return;if(child.exitCode!==null)throw new Error(stderr+JSON.stringify(messages));await new Promise(r=>setTimeout(r,25));}throw new Error('Checkpoint timeout '+point+stderr);}
  return {child,messages,ended,checkpoint};
}
try{
  await mkdir(join(base,'home'));
  for(const point of ['retry-authorization','retry-job','reserved','intent','http','receipt','retry-batch-index','concurrent']){
    process.env.METASO_RUNTIME_DIR=join(base,'runtime-'+point);const f=await makeBatch(base,point);
    const old=await submit(f.root,f.planId,'s1',true,{client:{async create(){throw new Error('original accepted, response lost');},async query(){throw new Error('no ID');}}});
    const first=worker(f,old.operationId,point);let workers=[first];
    if(point==='concurrent'){workers.push(worker(f,old.operationId,point));await Promise.all(workers.map(w=>w.ended));assert.ok(workers.some(w=>w.messages.some(m=>m.result?.exitCode===0)));}
    else{await first.checkpoint();first.child.kill('SIGKILL');await first.ended;}
    const a=(await listVideoRetries(f.root))[0];assert.ok(a);
    const initialPosts=workers.flatMap(w=>w.messages).filter(m=>m.post);let recoveryPosts=0;
    const client={async create(){recoveryPosts++;return {taskId:'recovery-'+point,evidence};},async query(taskId){return {taskId,status:'running',rawStatus:'running',evidence};}};
    const args=['generate','--root',f.root,'--plan',f.planId,'--segment','s1','--retry-of',old.operationId,'--confirm','--accept-unknown-result','--submit-only'];
    const result=await runCli(args,{client});const job=result.data.jobs[0];assert.equal(job.operationId,a.newOperationId);
    assert.equal(initialPosts.length+recoveryPosts,point==='intent'?0:1);
    if(['intent','http'].includes(point))assert.equal(job.status,'submit_unknown');
    else if(point==='retry-batch-index')assert.ok(['queued','running'].includes(job.status), 'Accepted batch task can already have been queried');
    else assert.equal(job.status,'queued');
    if(initialPosts.length&&!['http'].includes(point))assert.equal(job.taskId,initialPosts[0].post);
    await runCli(args,{client});assert.equal(initialPosts.length+recoveryPosts,point==='intent'?0:1);
    assert.equal((await readJob(f.root,old.operationId)).status,'submit_unknown');
    assert.equal(occupied(await reconcileRuntime(f.root)).length,2);
    report.push({point,oldOperationId:old.operationId,newOperationId:a.newOperationId,initialPosts:initialPosts.length,recoveryPosts,taskId:job.taskId,status:job.status,possibleOccupied:2});
    console.log('PASS explicit retry process '+point+': stable identity; no duplicate POST; old unknown retained');
  }
  for(const stage of ['prepared','reserved','intent','http','receipt','retry-batch-index','concurrent']){
    const point='failure-'+stage;
    process.env.METASO_RUNTIME_DIR=join(base,'runtime-'+point);const f=await makeBatch(base,point);
    let originalPosts=0;
    const originalClient={async create(){originalPosts++;throw new Error('A response lost');},async query(taskId){return {taskId,status:'failed',rawStatus:'failed',evidence};}};
    await runBatch(f.root,f.batchId,true,{client:originalClient},{maxPolls:1,pollIntervalMs:0});
    const old=(await listJobs(f.root))[0],grant=await authorizeVideoRetry(f.root,f.planId,'s1',old.operationId,true,true);
    const authFile=await retryPath(f.root,old.operationId),authBytes=await readFile(authFile);
    await attachTask(f.root,old.operationId,'recovered-A-'+stage,true,{client:originalClient});
    const args=['generate','--root',f.root,'--plan',f.planId,'--segment','s1','--retry-of',old.operationId,'--confirm','--submit-only'];
    const unknownArgs=[...args,'--accept-unknown-result'];
    await runCli(unknownArgs,{client:originalClient});
    await resume(f.root,old.operationId,{client:originalClient},{maxPolls:1,download:false});
    assert.equal(originalPosts,1);
    if(stage==='retry-batch-index'){
      const prepared=await runCli(args,{client:originalClient,persistence:{...persistence,async job(root,job){await persistence.job(root,job);if(job.status==='prepared')throw new Error('stop after C prepared');}}});
      assert.equal(prepared.exitCode,1);assert.equal(originalPosts,1);
    }
    const first=worker(f,old.operationId,point),workers=[first];
    if(stage==='concurrent'){workers.push(worker(f,old.operationId,point));await Promise.all(workers.map(w=>w.ended));assert.ok(workers.some(w=>w.messages.some(m=>m.result?.exitCode===0)));}
    else{await first.checkpoint();first.child.kill('SIGKILL');await first.ended;}
    const initialPosts=workers.flatMap(w=>w.messages).filter(m=>m.post);let recoveryPosts=0;
    const c=(await listJobs(f.root)).at(-1);assert.equal(c.attempt,3);assert.notEqual(c.operationId,grant.job.operationId);
    const client={async create(){recoveryPosts++;return {taskId:'recovery-C-'+stage,evidence};},async query(taskId){return {taskId,status:'running',rawStatus:'running',evidence};}};
    const result=await runCli(args,{client});assert.ok(result.data.jobs,JSON.stringify(result));const job=result.data.jobs[0];
    assert.equal(job.operationId,c.operationId);assert.equal(job.retryOf,old.operationId);
    assert.equal(initialPosts.length+recoveryPosts,stage==='intent'?0:1);
    if(['intent','http'].includes(stage))assert.equal(job.status,'submit_unknown');
    else if(stage==='retry-batch-index')assert.ok(['queued','running'].includes(job.status));
    else assert.equal(job.status,'queued');
    if(initialPosts.length&&stage!=='http')assert.equal(job.taskId,initialPosts[0].post);
    await runCli(args,{client});
    const repeatedGrant=await runCli(unknownArgs,{client});assert.equal(repeatedGrant.data.jobs[0].operationId,old.operationId);
    const batch=await runBatch(f.root,f.batchId,false,{client},{maxPolls:1,pollIntervalMs:0});
    assert.equal(batch.run.items[0].operationId,c.operationId);
    assert.equal((await batchStatus(f.root,f.batchId)).items[0].job.operationId,c.operationId);
    assert.equal(initialPosts.length+recoveryPosts,stage==='intent'?0:1);
    assert.equal((await readJob(f.root,old.operationId)).status,'failed');
    assert.equal((await readJob(f.root,grant.job.operationId)).lastError.code,'RETRY_SUPERSEDED');
    assert.deepEqual(await readFile(authFile),authBytes);assert.equal((await listJobs(f.root)).length,3);
    assert.deepEqual(occupied(await reconcileRuntime(f.root)).map(s=>s.operationId),[c.operationId]);
    report.push({point,oldOperationId:old.operationId,supersededOperationId:grant.job.operationId,newOperationId:c.operationId,originalPosts,initialPosts:initialPosts.length,recoveryPosts,taskId:job.taskId,status:job.status,attempt:3,historyRetained:true,batchOperationId:batch.run.items[0].operationId});
    console.log('PASS recovered failure retry process '+stage+': C stable; old grant retained; no duplicate POST; batch indexes C');
  }
  const output=resolve(process.env.METASO_RETRY_TEST_EVIDENCE_DIR??'.work/unknown-video-retry-20261016');await mkdir(output,{recursive:true});await writeFile(join(output,'process-evidence.json'),JSON.stringify({fakeOnly:true,report},null,2));
}finally{
  for(const child of children)child.kill('SIGKILL');
  if(previous===undefined)delete process.env.METASO_RUNTIME_DIR;else process.env.METASO_RUNTIME_DIR=previous;
  const actual=await realpath(base),parent=await realpath(tmpdir()),rel=relative(parent,actual);
  if(!rel.startsWith('metasocli-retry-process-')||rel.includes('..')||isAbsolute(rel))throw new Error('Unsafe cleanup target');
  await rm(actual,{recursive:true,force:true});
}
