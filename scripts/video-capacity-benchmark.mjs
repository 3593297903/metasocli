// Reproducible local-only comparison. Each sample is a fresh process; OS disk cache is not evicted.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const self=fileURLToPath(import.meta.url),repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
if(process.argv[2]==='worker'){
  const [variant,moduleRoot,base,output]=process.argv.slice(3),records=[],flow=[];let enabled=false;
  globalThis.__r3Metric=(event,file,extra={})=>{if(enabled)records.push({event,file,at:performance.now(),...extra});};
  registerHooks({load(url,context,next){
    const result=next(url,context);
    if(!url.includes('/dist/')||!result.source)return result;
    let source=String(result.source);
    if(url.endsWith('/storage/io.js')){
      source=source.replace('export async function readJson(file) {',"export async function readJson(file) { globalThis.__r3Metric('readJson',file);");
      source=source.replace("return JSON.parse((await readStable(file)).toString('utf8'));","const _readAt=performance.now();const _bytes=await readStable(file);const _decodeAt=performance.now();const _value=JSON.parse(_bytes.toString('utf8'));globalThis.__r3Metric('readDecode',file,{readMs:_decodeAt-_readAt,decodeMs:performance.now()-_decodeAt,bytes:_bytes.length});return _value;");
      source=source.replace('await atomicWrite(target, text);',"await atomicWrite(target, text); globalThis.__r3Metric('writeJson',target,{bytes:Buffer.byteLength(text),value:structuredClone(value)});");
    }
    if(url.endsWith('/jobs/store.js'))source=source.replace('export async function listJobs(root) {',"export async function listJobs(root) { globalThis.__r3Metric('listJobs',root);");
    if(url.endsWith('/jobs/coordinator.js')){
      const from=source.indexOf('export const capacityAvailable'),to=source.indexOf('export const unsafeSlots');
      if(from>=0&&to>from){const part=source.slice(from,to).replace('=> {','=> { const _decisionAt=performance.now(); try {').replace(/\n};\s*$/, "\n} finally {globalThis.__r3Metric('decision',root,{ms:performance.now()-_decisionAt});}\n};\n");source=source.slice(0,from)+part+source.slice(to);}
      source=source.replace("const lease = await waitLease(join(runtime, 'coordinator.lock'));","const _waitAt=performance.now(); const lease = await waitLease(join(runtime, 'coordinator.lock')); const _heldAt=performance.now();globalThis.__r3Metric('lockWait',runtime,{ms:_heldAt-_waitAt});");
      // Only the low-level shared transaction uses this indentation and scope before scheduler helpers.
      const boundary=source.indexOf('export async function acquireScheduler');
      const left=source.slice(0,boundary).replace('await lease.release();',"globalThis.__r3Metric('lockHeld',runtime,{ms:performance.now()-_heldAt}); await lease.release();");
      source=left+source.slice(boundary);
    }
    return {...result,source};
  }});
  const get=relative=>import(pathToFileURL(join(moduleRoot,'dist',relative)).href);
  const project=await get('core/project.js'),plans=await get('jobs/batch-store.js'),coordinator=await get('jobs/coordinator.js');
  const {submit}=await get('jobs/submit.js'),{runBatch}=await get('jobs/batch.js'),{canonicalSha256,sha256Hex}=await get('storage/canonical.js');
  // A preserved baseline may already contain R3. Compare the same hot path in
  // that case; retain legacy-sync sampling only for genuinely pre-R3 snapshots.
  const policy=existsSync(join(moduleRoot,'dist/jobs/capacity-events.js'))?await get('jobs/capacity-events.js'):undefined;
  const {fakeMp4}=await import('./video-batch-process-fixture.mjs');
  globalThis.fetch=async()=>{throw Error('Benchmark remote network forbidden');};
  const evidence={sha256:sha256Hex('{}'),response:{}},runtime=join(base,'runtime');process.env.METASO_RUNTIME_DIR=runtime;
  async function fixture(name,count){
    const root=join(base,name),source=join(base,name+'.txt'),lines=Array.from({length:count},(_,i)=>'完整测试段'+i+'。\n');
    await writeFile(source,lines.join(''));await project.initializeStory(root,name);let start=0;
    const segments=lines.map((line,i)=>{const item={id:'s'+(i+1),start,end:start+line.length,duration:6.963};start+=line.length;return item;});
    await project.importStory(root,{episodeId:'ep-1',kind:'video-prompts',source,segments});return {root,batch:(await plans.createBatchPlan(root,{episodes:['ep-1']})).plan};
  }
  const f=await fixture('capacity',4);let count=0;
  const client={async create(){return {taskId:'startup-'+(++count),evidence};},async query(taskId){return {taskId,status:'running',rawStatus:'running',evidence};}};
  for(const item of f.batch.items)await submit(f.root,item.planId,item.segmentId,true,{client});
  const ledger=await coordinator.inspectRuntime(runtime);
  for(let i=0;i<200;i++){
    const old={...ledger.slots[0],operationId:randomUUID(),taskId:'history-'+i,status:'downloaded'};
    if(policy)old.capacity=coordinator.initialCapacity(old);
    ledger.slots.push(old);
  }
  const {hash,...body}=ledger;ledger.hash=canonicalSha256(body);await writeFile(join(runtime,'video-ledger.json'),JSON.stringify(ledger,null,2));
  const samples=[];
  function summary(name,start,index){
    const events=records.slice(index),writes=events.filter(e=>e.event==='writeJson');
    return {name,elapsedMs:performance.now()-start,expandedTasks:new Set(events.filter(e=>e.event==='readJson'&&/[\\/]jobs[\\/]/.test(e.file)).map(e=>e.file)).size,
      jsonReads:events.filter(e=>e.event==='readJson').length,listJobs:events.filter(e=>e.event==='listJobs').length,
      readMs:events.filter(e=>e.event==='readDecode').reduce((n,e)=>n+e.readMs,0),decodeMs:events.filter(e=>e.event==='readDecode').reduce((n,e)=>n+e.decodeMs,0),
      decisionMs:events.filter(e=>e.event==='decision').map(e=>e.ms),
      ledgerWrites:writes.filter(e=>e.file.endsWith('video-ledger.json')).length,ownerWrites:writes.filter(e=>e.file.endsWith('owner.json')).length,
      batchWrites:writes.filter(e=>/[\\/]batches[\\/].*[\\/]run.json$/.test(e.file)).length,
      writeBytes:writes.reduce((n,e)=>n+e.bytes,0),lockWaitMs:events.filter(e=>e.event==='lockWait').map(e=>e.ms),lockHeldMs:events.filter(e=>e.event==='lockHeld').map(e=>e.ms)};
  }
  async function refresh(){if(policy){const audit=policy.startCapacityAudit(runtime);await audit.done;audit.check();}else await coordinator.reconcileRuntime(f.root,runtime);}
  enabled=true;let index=records.length,start=performance.now();await refresh();samples.push(summary('first-four-local-check-with-200-history',start,index));
  index=records.length;start=performance.now();for(let i=0;i<20;i++)await refresh();samples.push(summary('twenty-warm-identical-checks',start,index));enabled=false;
  if(policy){assert.equal(samples[1].ledgerWrites,0);assert.equal(samples[1].ownerWrites,0);assert.equal(samples[1].listJobs,0);assert.equal(samples[1].expandedTasks,4);}
  // Independent clean runtime for the real submit/batch/resume/download chain.
  const work=await fixture('workflow',8);process.env.METASO_RUNTIME_DIR=join(base,'workflow-runtime');let posts=0,gets=0,downloads=0;
  enabled=true;index=records.length;start=performance.now();
  const result=await runBatch(work.root,work.batch.batchId,true,{client:{async create(request){assert.equal(request.context_ir_enabled,true);const id='work-'+(++posts);flow.push({event:'POST',id,at:performance.now()});return {taskId:id,evidence};},
    async query(taskId){gets++;flow.push({event:'GET',taskId,at:performance.now()});return {taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://example.test/'+taskId+'.mp4',evidence};}},
    fetcher:async url=>{downloads++;flow.push({event:'download',taskId:new URL(String(url)).pathname.slice(1,-4),at:performance.now()});return new Response(fakeMp4());}}, {maxPolls:1,pollIntervalMs:0});
  const workflow=summary('eight-segment-complete-local-chain',start,index);enabled=false;
  assert.equal(result.run.status,'complete');assert.equal(posts,8);assert.equal(gets,16);assert.equal(downloads,8);
  const postTimes=flow.filter(e=>e.event==='POST').map(e=>e.at);
  const releases=[];const observed=new Set();
  for(const e of records.slice(index).filter(e=>e.event==='writeJson'&&e.file.endsWith('video-ledger.json'))){
    for(const s of e.value.slots){const released=s.capacity?s.capacity.state==='released':['generated','downloaded','failed','cancelled'].includes(s.status);
      if(released&&!observed.has(s.operationId)){observed.add(s.operationId);const next=postTimes.find(at=>at>=e.at);releases.push({operationId:s.operationId,at:e.at,nextPostDelayMs:next===undefined?null:next-e.at});}}
  }
  workflow.firstPostMs=postTimes[0]-start;workflow.firstFourPostMs=postTimes.slice(0,4).map(at=>at-start);workflow.releaseToPost=releases;
  workflow.postToFirstQuery=flow.filter(e=>e.event==='POST').map(e=>({taskId:e.id,ms:flow.find(q=>q.event==='GET'&&q.taskId===e.id).at-e.at}));
  workflow.downloadToSaved=flow.filter(e=>e.event==='download').map(e=>({taskId:e.taskId,ms:records.slice(index).find(r=>r.event==='writeJson'&&r.value?.taskId===e.taskId&&r.value.status==='downloaded').at-e.at}));
  workflow.downloadAndDeliveryVerificationMs=performance.now()-flow.find(e=>e.event==='download').at;
  for(const event of records)if(event.value)delete event.value;
  await writeFile(output,JSON.stringify({variant,capacityMode:policy?'R3':'legacy-sync',node:process.version,platform:process.platform,cache:'fresh process, fixture setup warms its files; OS cache not evicted; 20 repeats are warm',samples,workflow,posts,gets,downloads,flow,records},null,2));
  console.log(JSON.stringify({variant,samples,workflow,posts,gets,downloads}));
}else{
  const baseline=process.argv[2];if(!baseline)throw Error('Usage: node scripts/video-capacity-benchmark.mjs <preserved baseline root> [sample-pairs=3]');
  const pairs=Number(process.argv[3]??3);assert(Number.isInteger(pairs)&&pairs>=3&&pairs<=10);
  const parent=resolve(process.env.METASO_TEST_EVIDENCE_DIR??join(repo,'.work'));await mkdir(parent,{recursive:true});const base=await mkdtemp(join(parent,'r3-benchmark-'));const samples=[];
  for(let round=0;round<pairs;round++)for(const variant of round%2?['candidate','baseline']:['baseline','candidate']){
    const dir=join(base,round+'-'+variant);await mkdir(dir);const output=join(dir,'sample.json'),log=join(dir,'run.log');
    const args=[self,'worker',variant,variant==='baseline'?resolve(baseline):repo,dir,output];const started=performance.now();
    const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,METASO_API_KEY:'',METASOCLI_IMAGE_API_KEY:''}});let text='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>text+=b);
    const code=await new Promise((ok,bad)=>{child.once('error',bad);child.once('exit',ok);});await writeFile(log,text);
    samples.push({round,variant,command:[process.execPath,...args],exitCode:code,elapsedMs:performance.now()-started,output,log});
    await writeFile(join(base,'runs.json'),JSON.stringify(samples,null,2));console.log(JSON.stringify(samples.at(-1)));assert.equal(code,0,text);
  }
  console.log('Performance samples: '+join(base,'runs.json'));
}
