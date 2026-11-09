// R3 real Windows child processes; all provider calls are injected fakes.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join,resolve } from 'node:path';
import { mkdtemp,readFile,writeFile,appendFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { makeBatch,evidence } from './video-batch-process-fixture.mjs';
import { runCli } from '../dist/cli/main.js';
import { inspectRuntime,occupied,ensureRegistered,runtimeDirectory,reconcileRuntime } from '../dist/jobs/coordinator.js';
import { startCapacityAudit,beginCapacityObservation,recordCapacityEvent } from '../dist/jobs/capacity-events.js';
import { listJobs,readJob,persistence } from '../dist/jobs/store.js';
import { submit } from '../dist/jobs/submit.js';
import { resume,attachTask } from '../dist/jobs/resume.js';

globalThis.fetch=async()=>{throw Error('Real network forbidden');};
const self=fileURLToPath(import.meta.url);
if(process.argv[2]==='worker'){
  const config=JSON.parse(await readFile(process.argv[3],'utf8'));
  const {root,planId,runtime,point,mode,operationId}=config;
  process.env.METASO_RUNTIME_DIR=runtime;
  async function checkpoint(event,job){if(point!==event)return;process.send({point:event,operationId:job.operationId});await new Promise(()=>{});}
  const client={async create(){const taskId='fake-'+process.pid;await appendFile(join(root,'posts.jsonl'),JSON.stringify({taskId,pid:process.pid,at:performance.now()})+'\n');process.send({post:taskId});
    await checkpoint('http',{operationId:'transport'});if(mode==='create-error')throw Error('offline reset');return {taskId,evidence};},
    async query(taskId){return mode==='query-error'?Promise.reject(Error('offline GET reset')):
      mode==='query-terminal'?{taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://offline.test/fake.mp4',evidence}:{taskId,status:'running',rawStatus:'running',evidence};}};
  try{
    if(mode==='audit'){const audit=startCapacityAudit(runtime);await audit.done;audit.check();process.send({done:true});}
    else if(mode==='register'){await reconcileRuntime(root,runtime);process.send({done:true});}
    else if(mode==='attach-gap'){
      await attachTask(root,operationId,config.taskId,true,{client,runtimeRoot:runtime,persistence:{
        async receipt(root,receipt){await persistence.receipt(root,receipt);await checkpoint('attached-receipt',receipt);},
        async job(root,job){await persistence.job(root,job);await checkpoint('attached-job',job);}
      }});process.send({done:true});
    }else if(mode==='event'){
      const job=await readJob(root,operationId);await recordCapacityEvent(root,job,config.sequence,config.reason,{fixture:true},runtime);process.send({done:true});
    }else{
      const args=operationId?['status','--root',root,'--operation',operationId,'--remote']:
        ['generate','--root',root,'--plan',planId,'--segment',config.segment??'s1','--confirm','--submit-only'];
      process.send({result:await runCli(args,{client,runtimeRoot:runtime,checkpoint})});
    }
  }catch(error){process.send({error:{code:error.code,message:error.message}});process.exitCode=1;}
  process.disconnect();
}else{
  const base=await mkdtemp(join(process.env.METASO_TEST_EVIDENCE_DIR??tmpdir(),'r3-process-'));const children=new Set(),cases=[];
  async function worker(config){
    const file=join(base,'worker-'+crypto.randomUUID()+'.json');await writeFile(file,JSON.stringify(config));
    const child=fork(self,['worker',file],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,METASO_API_KEY:'',METASOCLI_IMAGE_API_KEY:''}});children.add(child);
    const messages=[];let stderr='';child.stderr.on('data',b=>stderr+=b);child.on('message',m=>messages.push(m));
    const ended=new Promise((ok,bad)=>{child.once('error',bad);child.once('exit',code=>{children.delete(child);ok(code);});});
    async function until(test){const deadline=Date.now()+45000;while(Date.now()<deadline){const found=messages.find(test);if(found)return found;if(!children.has(child))throw Error(stderr+JSON.stringify(messages));await new Promise(r=>setTimeout(r,10));}throw Error('Process checkpoint timed out '+JSON.stringify(config));}
    return {child,messages,until,async kill(){assert(children.has(child),'Only this fixture may terminate its owned child');child.kill('SIGKILL');await ended;},async finish(){assert.equal(await ended,0,stderr+JSON.stringify(messages));return messages;}};
  }
  const posts=async root=>{try{return (await readFile(join(root,'posts.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  try{
    for(const [point,mode] of [['reserved','create'],['intent','create'],['http','create'],['receipt','create'],['capacity-evidence-saved','create-error'],['capacity-released','create-error'],['capacity-restored','create']]){
      const f=await makeBatch(base,'crash-'+point),runtime=join(base,'runtime-'+point);const w=await worker({...f,runtime,point,mode});await w.until(m=>m.point===point);await w.kill();
      const before=(await listJobs(f.root))[0],beforePosts=(await posts(f.root)).length;
      const recovery=await worker({...f,runtime,mode:'create'});const result=(await recovery.finish()).find(m=>m.result)?.result;
      const after=(await listJobs(f.root))[0];assert.equal(after.operationId,before.operationId);
      assert.equal((await posts(f.root)).length,point==='reserved'?1:beforePosts);
      if(before.taskId)assert.equal(after.taskId,before.taskId);
      const scan=startCapacityAudit(runtime);await scan.done;scan.check();
      assert.equal(occupied(await inspectRuntime(runtime)).length,after.taskId?1:0);
      const row={point,beforePosts,afterPosts:(await posts(f.root)).length,operationId:after.operationId,taskId:after.taskId??null,state:after.status,exit:result.exitCode};cases.push(row);console.log('PASS '+JSON.stringify(row));
    }
    // Business evidence / shared capacity gap on release and restoration.
    for(const mode of ['query-error','query-active']){
      const f=await makeBatch(base,mode),runtime=join(base,'runtime-'+mode);const initial=await worker({...f,runtime,mode:'create'});await initial.finish();const job=(await listJobs(f.root))[0];
      if(mode==='query-active')await resume(f.root,job.operationId,{runtimeRoot:runtime,client:{create:async()=>{throw Error('no POST');},query:async()=>{throw Error('query unavailable');}}},{download:false,maxPolls:1});
      const w=await worker({...f,runtime,mode,operationId:job.operationId,point:'capacity-evidence-saved'});await w.until(m=>m.point);await w.kill();
      const repair=await worker({...f,runtime,mode:'audit'});await repair.finish();
      assert.equal(occupied(await inspectRuntime(runtime)).length,mode==='query-active'?1:0);assert.equal((await posts(f.root)).length,1);
      cases.push({mode,originalId:job.taskId,posts:1,journalGapRepaired:true});console.log('PASS '+mode+' observation gap');
    }
    // Durable terminal journal -> shared ledger: kill the actual Windows writer,
    // then deliver stale running in another process. The durable terminal wins.
    {
      const f=await makeBatch(base,'terminal-journal-gap'),runtime=join(base,'runtime-terminal-journal-gap');
      const initial=await worker({...f,runtime,mode:'create'});await initial.finish();const original=(await listJobs(f.root))[0];
      const w=await worker({...f,runtime,mode:'query-terminal',operationId:original.operationId,point:'capacity-evidence-saved'});
      await w.until(m=>m.point==='capacity-evidence-saved');const killedPid=w.child.pid;await w.kill();
      const journal=JSON.parse(await readFile(join(f.root,'.metasocli/receipts',original.operationId+'-capacity.json'),'utf8'));
      assert.equal(journal.event.reason,'provider_terminal');assert.equal((await inspectRuntime(runtime)).slots[0].capacity.terminal,false);
      const late=await worker({...f,runtime,mode:'query-active',operationId:original.operationId});await late.finish();
      const repair=await worker({...f,runtime,mode:'audit'});await repair.finish();const slot=(await inspectRuntime(runtime)).slots[0];
      assert.equal(slot.taskId,original.taskId);assert.equal(slot.capacity.state,'released');assert.equal(slot.capacity.terminal,true);assert.equal((await posts(f.root)).length,1);
      const row={case:'terminal-journal-before-ledger',killedPid,recoveryPid:late.child.pid,operationId:original.operationId,taskId:original.taskId,posts:1,capacity:slot.capacity};cases.push(row);console.log('PASS '+JSON.stringify(row));
    }
    // Recovered receipt -> Job -> shared ledger: exercise both durable-file gaps,
    // with explicit registration in a new process before the original submit reuse.
    for(const point of ['attached-receipt','attached-job']){
      const f=await makeBatch(base,point),runtime=join(base,'runtime-'+point);
      const initial=await worker({...f,runtime,mode:'create-error'});await initial.finish();const original=(await listJobs(f.root))[0],taskId=(await posts(f.root))[0].taskId;
      assert.equal(occupied(await inspectRuntime(runtime)).length,0);
      const w=await worker({...f,runtime,mode:'attach-gap',operationId:original.operationId,taskId,point});
      await w.until(m=>m.point===point);const killedPid=w.child.pid;await w.kill();
      const registration=await worker({...f,runtime,mode:'register'});await registration.finish();
      assert.equal(occupied(await inspectRuntime(runtime)).length,1);
      const before=await readFile(join(runtime,'video-ledger.json'));
      for(let n=0;n<2;n++){const reuse=await worker({...f,runtime,mode:'create'});await reuse.finish();}
      assert.deepEqual(await readFile(join(runtime,'video-ledger.json')),before);
      const job=await readJob(f.root,original.operationId);assert.equal(job.taskId,taskId);assert.equal((await posts(f.root)).length,1);
      const row={case:point,killedPid,registrationPid:registration.child.pid,operationId:job.operationId,taskId,posts:1,held:1};cases.push(row);console.log('PASS '+JSON.stringify(row));
    }
    // Two independent writers race a release and a later restore against new reservation.
    const runtime=join(base,'race-runtime'),seed=await makeBatch(base,'seed',4);process.env.METASO_RUNTIME_DIR=runtime;
    let n=0;const client={async create(){return {taskId:'seed-'+(++n),evidence};},async query(taskId){return {taskId,status:'running',rawStatus:'running',evidence};}};
    for(let i=1;i<=4;i++)await submit(seed.root,seed.planId,'s'+i,true,{client,runtimeRoot:runtime});
    const original=(await listJobs(seed.root))[0],old=await beginCapacityObservation(seed.root,original,runtime),newer=await beginCapacityObservation(seed.root,original,runtime);
    const release=await worker({...seed,runtime,mode:'event',operationId:original.operationId,sequence:old,reason:'query_unavailable'});
    const restore=await worker({...seed,runtime,mode:'event',operationId:original.operationId,sequence:newer,reason:'remote_active_recovered'});
    const b=await makeBatch(base,'race-B'),c=await makeBatch(base,'race-C');await ensureRegistered(b.root,runtime);await ensureRegistered(c.root,runtime);
    const contenders=await Promise.all([worker({...b,runtime,mode:'create'}),worker({...c,runtime,mode:'create'})]);
    await Promise.all([release.finish(),restore.finish(),...contenders.map(w=>w.finish())]);
    assert.equal((await posts(b.root)).length+(await posts(c.root)).length,0);assert.equal(occupied(await inspectRuntime(runtime)).length,4);
    cases.push({race:'stale release/new restore/two reservations',newPosts:0,held:4,originalId:original.taskId});
    const output=resolve(process.env.METASO_TEST_EVIDENCE_DIR??base);await mkdir(output,{recursive:true});await writeFile(join(output,'r3-capacity-process.json'),JSON.stringify({base,cases},null,2));
    console.log('PASS '+cases.length+' R3 process cases; evidence '+base);
  }finally{for(const child of children){child.kill('SIGKILL');} }
}
