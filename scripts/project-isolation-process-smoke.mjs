// Only synthetic stories, injected clients and loopback HTTP. Never loads API credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';
import { mkdir,mkdtemp,readFile,writeFile,rm,realpath } from 'node:fs/promises';
import { dirname,join,resolve,relative,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBatch,evidence } from './video-batch-process-fixture.mjs';
import { initializeStory,importStory } from '../dist/core/project.js';
import { createImagePlan } from '../dist/images/planning.js';
import { runImages } from '../dist/images/run.js';
import { listImageJobs } from '../dist/images/store.js';
import { ImageProfile } from '../dist/images/contracts.js';
import { acquireImageScheduler,imageRuntime } from '../dist/images/coordinator.js';
import { runBatch } from '../dist/jobs/batch.js';
import { submit } from '../dist/jobs/submit.js';
import { resume } from '../dist/jobs/resume.js';
import { listJobs } from '../dist/jobs/store.js';
import { acquireScheduler,occupied,reconcileRuntime } from '../dist/jobs/coordinator.js';
import { acquireLease } from '../dist/storage/locking.js';
import { sha256Hex } from '../dist/storage/canonical.js';
const nativeFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Real network forbidden in isolation smoke');};
const self=fileURLToPath(import.meta.url),packageRoot=resolve(dirname(self),'..');
const profile=ImageProfile.parse({boardSize:'1024x1024',maxResponseBytes:131072,maxImageBytes:65536,maxTempBytes:10485760});
const running=taskId=>({taskId,status:'running',rawStatus:'running',evidence});
const generated=taskId=>({taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://example.com/offline.mp4',evidence});
function png(){const chunk=(type,data)=>{const b=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const n of b){crc^=n;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const o=Buffer.alloc(data.length+12);o.writeUInt32BE(data.length);b.copy(o,4);o.writeUInt32BE((crc^0xffffffff)>>>0,o.length-4);return o;};const h=Buffer.alloc(13);h.writeUInt32BE(1024);h.writeUInt32BE(1024,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc(1024*3073))),chunk('IEND',Buffer.alloc(0))]);}
const body=JSON.stringify({data:[{b64_json:png().toString('base64')}]});
if(process.argv[2]==='worker'){
  const config=JSON.parse(await readFile(process.argv[3],'utf8'));process.env.METASO_RUNTIME_DIR=config.runtime;
  try{
    if(config.mode==='legacy'){
      const lease=await acquireLease(config.file);process.send({ready:true});await new Promise(()=>{setInterval(()=>{},1000);});await lease.release();
    }else if(config.mode==='image'){
      assert.match(config.url,/^http:\/\/127\.0\.0\.1:\d+\//);
      const result=await runImages(config.root,config.planId,config.authorize!==false,{capacityWaitMs:config.wait??0,capacityPollMs:10,client:{async create(_root,input,p){assert.equal(p.model,'gpt-image-2.5');assert.equal(p.generationTimeoutMs,600000);return nativeFetch(config.url,{method:'POST',body:JSON.stringify(input)});}}});
      process.send({result,ids:(await listImageJobs(config.root)).map(j=>({projectId:j.projectId,operationId:j.operationId,status:j.status,attempt:j.attempt}))});
    }else if(config.mode==='video'){
      const result=await runBatch(config.root,config.batchId,config.authorize!==false,{client:{async create(request){assert.equal(request.context_ir_enabled,true);assert.equal(request.model,'MiniMax-H3');const taskId='isolation-'+process.pid;process.send({post:taskId,at:new Date().toISOString()});await new Promise(r=>process.once('message',r));return {taskId,evidence};},async query(id){return running(id);}}},{maxPolls:1,pollIntervalMs:0,capacityWaitMs:10000,capacityPollMs:25});
      process.send({result,ids:(await listJobs(config.root)).map(j=>({projectId:j.projectId,operationId:j.operationId,taskId:j.taskId,status:j.status}))});
    }else throw Error('Fake worker mode required');
  }catch(error){process.send({error:{code:error.code,message:error.message}});process.exitCode=1;}
  process.disconnect();
}else{
  const temp=process.env.METASO_TEST_EVIDENCE_DIR ? join(process.env.METASO_TEST_EVIDENCE_DIR,'project-isolation-tmp') : join(packageRoot,'.work/project-isolation-implementation-20261102/tmp');await mkdir(temp,{recursive:true});
  const base=await mkdtemp(join(temp,'isolation-process-')),children=new Set(),report=[];const savedRuntime=process.env.METASO_RUNTIME_DIR;
  const requests=[],responses=new Map();let active=0,peak=0;
  const server=createServer(async(req,res)=>{let bytes=0;for await(const chunk of req)bytes+=chunk.length;const event={path:req.url,bytes,at:new Date().toISOString()};requests.push(event);active++;peak=Math.max(peak,active);responses.set(req.url,res);res.once('close',()=>{active--;});});server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const release=path=>{const r=responses.get(path);assert.ok(r,'missing HTTP '+path);r.writeHead(200,{'content-type':'application/json'});r.end(body);};
  async function until(predicate,label){const end=Date.now()+30000;while(Date.now()<end){const result=await predicate();if(result)return result;await new Promise(r=>setTimeout(r,15));}throw Error('Timed out: '+label);}
  async function worker(config){
    const file=join(base,'worker-'+Math.random().toString(16).slice(2)+'.json');await writeFile(file,JSON.stringify(config));
    const env={...process.env,PATH:dirname(process.execPath),USERPROFILE:join(base,'home'),HOME:join(base,'home'),TMP:temp,TEMP:temp,TMPDIR:temp};delete env.METASO_API_KEY;delete env.METASOCLI_IMAGE_API_KEY;
    const child=spawn(process.execPath,[self,'worker',file],{cwd:base,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});children.add(child);const messages=[];let stderr='';child.stderr.on('data',d=>stderr+=d);child.on('message',m=>messages.push(m));
    const ended=new Promise((ok,bad)=>{child.once('error',bad);child.once('exit',code=>{children.delete(child);ok(code);});});
    const message=predicate=>until(()=>{const found=messages.find(predicate);if(found)return found;if(child.exitCode!==null)throw Error('Early worker exit '+stderr+' '+JSON.stringify(messages));return false;},JSON.stringify(config));
    return {child,messages,ended,message,async finish(){const m=await message(m=>m.result||m.error);assert.ok(!m.error,JSON.stringify(m));assert.equal(await ended,0);return m;},async kill(){child.kill('SIGKILL');await ended;}};
  }
  async function imageFixture(name,limits){const root=join(base,name),source=join(base,name+'.txt');await writeFile(source,'完整原文。');await initializeStory(root,name);await importStory(root,{episodeId:'ep-1',kind:'video-prompts',source,recipes:[{assetId:'lead',kind:'character',prompt:'完整人物图'}],segments:[{id:'s1',start:0,end:5,duration:6.666,references:[{assetId:'lead',role:'reference_image'}]}]});const {plan}=await createImagePlan(root,{episodes:['ep-1'],profile:{...profile,...(limits?{providerLimits:{...limits,source:'offline',checkedAt:new Date().toISOString()}}:{})}});return {root,planId:plan.planId};}
  try{
    await mkdir(join(base,'home'));
    // Real HTTP bodies at the local server, with responses withheld until both projects arrive.
    const runtime=join(base,'images'),a=await imageFixture('image-A'),b=await imageFixture('image-B');
    const wa=await worker({...a,runtime,mode:'image',url:origin+'/A'});await until(()=>responses.has('/A'),'A HTTP');
    const same=await worker({...a,root:process.platform==='win32'?a.root.toUpperCase():a.root,runtime,mode:'image',url:origin+'/duplicate'});assert.equal((await same.message(m=>m.error)).error.code,'LOCK_BUSY');assert.equal(await same.ended,1);
    const wb=await worker({...b,runtime,mode:'image',url:origin+'/B'});await until(()=>responses.has('/B'),'B HTTP before A response');assert.equal(requests.length,2);assert.equal(peak,2);
    await wa.kill();release('/B');const resultB=await wb.finish();
    const before=requests.length;const recoverA=await worker({...a,runtime,mode:'image',authorize:false,url:origin+'/A-repeat'});const ar=await recoverA.finish();assert.equal(ar.ids[0].status,'submit_unknown');assert.equal(requests.length,before);
    const br=await worker({...b,runtime,mode:'image',authorize:false,url:origin+'/B-repeat'});const recoveredB=await br.finish();assert.equal(recoveredB.ids[0].operationId,resultB.ids[0].operationId);assert.equal(requests.length,before);
    report.push({case:'I2/I3/I6/C2',projects:[{root:'<synthetic>/image-A',...ar.ids[0]},{root:'<synthetic>/image-B',...resultB.ids[0]}],httpRequests:[...requests],peak,oldOperationId:ar.ids[0].operationId,newOperationId:resultB.ids[0].operationId,postRecovery:0,sameStoryCasing:'LOCK_BUSY'});
    // Same configured quota is atomic across processes. B saves prepared and resumes the identical ID.
    for(const limit of ['concurrent','rpm']){
      const runtime=join(base,'quota-'+limit),a=await imageFixture('quota-A-'+limit,{[limit]:1}),b=await imageFixture('quota-B-'+limit,{[limit]:1});const aPath='/quota-A-'+limit,bPath='/quota-B-'+limit,start=requests.length;
      const first=await worker({...a,runtime,mode:'image',url:origin+aPath});await until(()=>responses.has(aPath),'quota A');
      if(limit==='rpm'){release(aPath);await first.finish();}
      const second=await worker({...b,runtime,mode:'image',url:origin+bPath});const waiting=await second.finish();assert.equal(waiting.result.run.waiting.reason,limit);assert.equal(waiting.ids[0].status,'prepared');assert.equal(requests.length-start,1);
      if(limit==='concurrent'){release(aPath);await first.finish();const next=await worker({...b,runtime,mode:'image',authorize:false,url:origin+bPath});await until(()=>responses.has(bPath),'quota B after release');release(bPath);const completed=await next.finish();assert.equal(completed.ids[0].operationId,waiting.ids[0].operationId);}
      report.push({case:'I9',limit,project:{root:'<synthetic>/quota-B-'+limit,...waiting.ids[0]},operationId:waiting.ids[0].operationId,blockedPosts:0,requests:requests.slice(start),maxConcurrent:1});
    }
    // Three known tasks leave one slot. Two independent process schedulers race for it.
    process.env.METASO_RUNTIME_DIR=join(base,'video');const seed=await makeBatch(base,'seed',3);let seedPosts=0;
    const client={async create(){return {taskId:'seed-'+(++seedPosts),evidence};},async query(id){return generated(id);}};
    for(const id of ['s1','s2','s3'])await submit(seed.root,seed.planId,id,true,{client});
    const x=await makeBatch(base,'video-X'),y=await makeBatch(base,'video-Y'),wx=await worker({...x,runtime:process.env.METASO_RUNTIME_DIR,mode:'video'}),wy=await worker({...y,runtime:process.env.METASO_RUNTIME_DIR,mode:'video'});
    await until(()=>[wx,wy].some(w=>w.messages.some(m=>m.post)),'last slot winner');
    const winner=wx.messages.some(m=>m.post)?wx:wy,loser=winner===wx?wy:wx,loserFixture=winner===wx?y:x;
    await until(async()=>{try{return JSON.parse(await readFile(join(loserFixture.root,'.metasocli/batches',loserFixture.batchId,'run.json'),'utf8')).trace.some(t=>t.event==='waiting-shared-capacity');}catch{return false;}},'last slot loser saved waiting');
    assert.equal([wx,wy].flatMap(w=>w.messages).filter(m=>m.post).length,1);assert.equal(occupied(await reconcileRuntime(seed.root)).length,4);
    const original=(await listJobs(seed.root))[0];await resume(seed.root,original.operationId,{client},{maxPolls:1,download:false});const terminalPersistedAt=new Date().toISOString();
    await loser.message(m=>m.post);assert.equal(winner.child.exitCode,null);assert.equal(occupied(await reconcileRuntime(seed.root)).length,4);
    for(const w of [wx,wy])w.child.send('release');const results=await Promise.all([wx.finish(),wy.finish()]);
    let repeatPosts=0;for(const f of [x,y])await runBatch(f.root,f.batchId,false,{client:{async create(){repeatPosts++;throw Error('repeat POST');},async query(id){return running(id);}}},{maxPolls:1,pollIntervalMs:0,capacityWaitMs:0});assert.equal(repeatPosts,0);
    report.push({case:'V3/V4/V8/C6',seedPosts,newPosts:2,lastSlotWinners:1,peak:4,secondStartedBeforeFirstCompleted:true,recoveryPosts:repeatPosts,releasedOriginal:{root:'<synthetic>/seed',projectId:original.projectId,operationId:original.operationId,taskId:original.taskId},timeline:{posts:[wx,wy].flatMap(w=>w.messages).filter(m=>m.post),terminalPersistedAt},results:results.map((r,i)=>({root:'<synthetic>/video-'+(i?'Y':'X'),jobs:r.ids}))});
    // Dead legacy global locks are reclaimed only after SIGKILL, using the existing owner protocol.
    for(const kind of ['image','video']){const runtime=join(base,'legacy-'+kind),f=await makeBatch(base,'legacy-'+kind),file=kind==='video'?join(runtime,'batch.lock'):join(imageRuntime(profile,runtime),'scheduler.lock');const w=await worker({mode:'legacy',runtime,file});await w.message(m=>m.ready);const bytes=await readFile(file);const acquire=()=>kind==='video'?acquireScheduler(f.root,runtime,0):acquireImageScheduler(f.root,profile,runtime);await assert.rejects(acquire(),{code:'LEGACY_SCHEDULER_BUSY'});assert.deepEqual(await readFile(file),bytes);await w.kill();const lease=await acquire();await lease.release();report.push({case:'C3',kind,liveOwnerBlocked:true,killedPid:w.child.pid,deadOwnerReclaimed:true,ownerHash:sha256Hex(bytes)});}
    const out=resolve(process.env.METASO_ISOLATION_EVIDENCE_DIR??'.work/project-isolation-implementation-20261102/evidence');await mkdir(out,{recursive:true});await writeFile(join(out,'process.json'),JSON.stringify({syntheticOnly:true,report},null,2));
    for(const row of report)console.log('PASS '+row.case+' '+JSON.stringify(row));
  }finally{
    for(const child of children){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
    server.closeAllConnections();await new Promise(r=>server.close(r));
    if(savedRuntime===undefined)delete process.env.METASO_RUNTIME_DIR;else process.env.METASO_RUNTIME_DIR=savedRuntime;
    const actual=await realpath(base),parent=await realpath(temp),rel=relative(parent,actual);if(isAbsolute(rel)||rel.startsWith('..')||!rel.startsWith('isolation-process-'))throw Error('Unsafe cleanup');await rm(actual,{recursive:true,force:true});
  }
}
