import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm,realpath,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join,resolve,parse,relative,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { makeBatch,fakeMp4,evidence } from './video-batch-process-fixture.mjs';
import { runBatch } from '../dist/jobs/batch.js';
import { listJobs } from '../dist/jobs/store.js';
import { occupied,reconcileRuntime } from '../dist/jobs/coordinator.js';
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=await mkdtemp(join(tmpdir(),'metasocli-batch-process-')), savedRuntime=process.env.METASO_RUNTIME_DIR;
const children=new Set(), report=[];
function worker(f,mode,segment='s1'){
  const permissions=process.platform==='win32'&&parse(packageRoot).root.toLowerCase()!==parse(base).root.toLowerCase()
    ? ['--permission',`--allow-fs-read=${packageRoot}`,`--allow-fs-read=${parse(base).root}`,`--allow-fs-write=${base}`]:[];
  const env={...process.env,PATH:dirname(process.execPath),HOME:join(base,'home'),USERPROFILE:join(base,'home')};delete env.METASO_API_KEY;
  const child=spawn(process.execPath,[...permissions,join(packageRoot,'scripts/video-batch-process-worker.mjs'),f.root,f.batchId,mode,f.planId,segment],{cwd:f.root,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  children.add(child);const messages=[];let stderr='';child.stderr.on('data',d=>stderr+=String(d));child.on('message',m=>messages.push(m));
  const ended=new Promise(r=>child.on('exit',(code)=>{children.delete(child);r(code);}));
  async function until(test){const end=Date.now()+30000;while(Date.now()<end){const m=messages.find(test);if(m)return m;if(child.exitCode!==null)throw new Error('Worker exited: '+stderr+' '+JSON.stringify(messages));await new Promise(r=>setTimeout(r,20));}throw new Error('Worker timeout: '+stderr+' '+JSON.stringify(messages));}
  return {child,messages,ended,until,async kill(){child.kill('SIGKILL');await ended;}};
}
try{
  await mkdir(join(base,'home'));
  for(const point of process.argv.includes('--cross-only')?[]:['reserved','intent','http','receipt','terminal-before','terminal-saved','release-before','released','download-before-rename','download-after-rename']){
    process.env.METASO_RUNTIME_DIR=join(base,'runtime-'+point);const f=await makeBatch(base,point);
    const w=worker(f,point);await w.until(m=>m.checkpoint===point);await w.kill();
    const before=(await listJobs(f.root))[0],initialPosts=w.messages.filter(m=>m.post).length;let recoveryPosts=0;
    const client={async create(){recoveryPosts++;return {taskId:'recovery-'+point,evidence};},async query(taskId){return {taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://example.com/fake.mp4',evidence};}};
    const result=await runBatch(f.root,f.batchId,false,{client,fetcher:async()=>new Response(fakeMp4())},{pollIntervalMs:0,maxPolls:1});
    if(['intent','http'].includes(point)){assert.equal(before.status,'submit_unknown');assert.equal(recoveryPosts,0);assert.equal(result.run.status,'needs_attention');assert.equal(occupied(await reconcileRuntime(f.root)).length,1);}
    else{assert.equal(result.run.status,'complete');assert.equal(recoveryPosts,point==='reserved'?1:0);if(before.taskId)assert.equal(result.items[0].job.taskId,before.taskId);}
    assert.equal(initialPosts+recoveryPosts,point==='intent'?0:1);
    report.push({point,initialPosts,recoveryPosts,before:before.status,after:result.run.status,originalTaskPreserved:!before.taskId||result.items[0].job.taskId===before.taskId});
    console.log('PASS batch SIGKILL at '+point+'; original task retained; total POST '+(initialPosts+recoveryPosts));
  }
  process.env.METASO_RUNTIME_DIR=join(base,'runtime-cross');
  const a=await makeBatch(base,'project-a',3),b=await makeBatch(base,'project-b',3);
  // Four ordinary CLI submit-only processes are kept inside the fake POST concurrently.
  const first=[worker(a,'gate','s1'),worker(a,'gate','s2'),worker(b,'gate','s1'),worker(b,'gate','s2')];
  await Promise.all(first.map(w=>w.until(m=>m.post)));
  assert.equal(occupied(await reconcileRuntime(a.root)).length,4);
  const fifth=worker(b,'running','s3'),refused=await fifth.until(m=>m.result);assert.equal(refused.result.data.error.code,'CAPACITY_FULL');await fifth.ended;
  for(const w of first)w.child.send('release');
  for(const w of first){const result=(await w.until(m=>m.result)).result;assert.equal(result.exitCode,0,JSON.stringify(result));await w.ended;}
  const holder=worker(a,'query-gate');await holder.until(m=>m.checkpoint==='query-gate');
  const competitor=worker(b,'no-wait');assert.equal((await competitor.until(m=>m.error)).error.code,'LOCK_BUSY');await competitor.ended;
  const ordinary=worker(b,'running','s3');assert.equal((await ordinary.until(m=>m.result)).result.data.error.code,'SCHEDULER_BUSY');await ordinary.ended;
  const recovering=worker(b,'batch-running');
  await new Promise(r=>setTimeout(r,200));
  assert.equal(recovering.messages.some(m=>m.result||m.post||m.error),false,'Competing batch must wait for the active scheduler');
  await holder.kill();
  const resumed=await recovering.until(m=>m.result);await recovering.ended;
  assert.equal(resumed.result.summary.pending,1);assert.equal(recovering.messages.filter(m=>m.post).length,0);
  assert.equal(occupied(await reconcileRuntime(b.root)).length,4);
  report.push({scenario:'two projects, four CLI processes, batch contention and SIGKILL',posts:4,occupied:4,fifth:'CAPACITY_FULL',otherBatch:'LOCK_BUSY',ordinaryDuringBatch:'SCHEDULER_BUSY',competingBatchWaited:true,recoveryPosts:0});
  console.log('PASS two projects / four CLI processes / batch ownership / process recovery: 4 POST, no duplicates or capacity bypass');
  await mkdir(join(packageRoot,'.work'),{recursive:true});await writeFile(join(packageRoot,'.work/video-batch-process-evidence.json'),JSON.stringify({fakeClientsOnly:true,report},null,2));
}finally{
  for(const child of children){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}
  if(savedRuntime===undefined)delete process.env.METASO_RUNTIME_DIR;else process.env.METASO_RUNTIME_DIR=savedRuntime;
  const actual=await realpath(base),parent=await realpath(tmpdir()),rel=relative(parent,actual);
  if(!rel.startsWith('metasocli-batch-process-')||rel.includes('..')||isAbsolute(rel))throw new Error('Unsafe cleanup');
  await rm(actual,{recursive:true,force:true});
}
