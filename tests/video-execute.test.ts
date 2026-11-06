import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { cleanup, fixture, mp4, png } from './helpers.js';
import { batchFixture, evidence } from './batch-helpers.js';
import { runCli } from '../src/cli/main.js';
import { createBatchPlan, loadBatchRun } from '../src/jobs/batch-store.js';
import { registerAsset } from '../src/assets/registry.js';
import { importStory } from '../src/core/project.js';
import { wav } from './audio-fixtures.js';
import { submit } from '../src/jobs/submit.js';
import { listJobs } from '../src/jobs/store.js';
import { sha256Hex } from '../src/storage/canonical.js';
import type { VideoWorkflowDependencies } from '../src/jobs/video-workflow.js';
import type { H3Request } from '../src/metaso/h3.js';
import type { VideoClient } from '../src/metaso/client.js';
afterEach(cleanup);
it('installed CLI preparation never accesses either credential environment variable or fetch',async()=>{
  const f=await batchFixture([1]),guard=join(f.root,'guard.mjs');
  await writeFile(guard,"process.env=new Proxy(process.env,{get(target,key){if(['METASO_API_KEY','METASOCLI_IMAGE_API_KEY'].includes(key))throw Error('unexpected secret read');return Reflect.get(target,key);}});globalThis.fetch=()=>{throw Error('unexpected network');};");
  const result=await promisify(execFile)(process.execPath,['--import',pathToFileURL(guard).href,'dist/cli/main.js','video','execute','--root',f.root,'--batch',f.batch.plan.batchId],{windowsHide:true});
  expect(JSON.parse(result.stdout)).toMatchObject({state:'prepared',batchId:f.batch.plan.batchId});
});
it('an MP4 or download receipt replaced between inspection and publication cannot produce a complete delivery',async()=>{
  const f=await batchFixture([1]),id=f.batch.plan.batchId,network=fake(),off=offline();
  const done=await execute(f.root,['--batch',id,'--confirm','--poll-ms','0'],network.deps);
  expect(done.exitCode).toBe(0);const item=(done.data as any).segments[0];
  for(const path of [item.output.path,join(f.root,'.metasocli/receipts',item.operationId+'-download.json')]){
    const bytes=await readFile(path);let once=true;
    const result=await execute(f.root,['--batch',id],{...off.deps,workflowCheckpoint:async p=>{
      if(once && p==='video-delivery-before-write'){once=false;await writeFile(path,'changed');}
    }});
    expect(result).toMatchObject({exitCode:2,data:{state:'partial',segments:[{output:null,reason:'OUTPUT_NEEDS_RECOVERY'}]}});
    await writeFile(path,bytes);
  }
  checkNoNetwork(off);expect(network.calls.posts).toBe(1);
},60000);
it('a changed file in a later selected parent blocks every new POST in the confirmed scope',async()=>{
  const f=await fixture(),off=offline();
  for (const id of ['one','two']) {
    await importStory(f.root,{...f.draft,episodeId:id,recipes:[{assetId:id,kind:'character',prompt:id}],segments:[{...f.draft.segments[0],references:[{assetId:id,role:'reference_image'}]}]});
    const path=join(dirname(f.root),id+'.png');await writeFile(path,png(id==='one'?256:512,256));
    await registerAsset(f.root,id,{file:path});
  }
  const prep=(await execute(f.root,['--episodes','one,two'],off.deps)).data as any;
  const {loadStory}=await import('../src/core/project.js');
  const target=(await loadStory(f.root)).assets.find(a=>a.recipe.assetId==='two')!.media!;
  await writeFile(join(f.root,target.path),png(256,512));
  expect(await execute(f.root,['--episodes','one,two','--expect-scope',prep.scopeHash,'--confirm'],off.deps)).toMatchObject({exitCode:2,data:{error:{code:'ASSET_CHANGED'}}});
  checkNoNetwork(off);expect(await listJobs(f.root)).toEqual([]);
});
const execute=(root:string,args:string[],deps?:VideoWorkflowDependencies)=>runCli(['video','execute','--root',root,...args],deps);
function offline() {
  const calls={prepare:0,post:0,get:0,download:0};
  const stop=(key:keyof typeof calls):never=>{calls[key]++;throw Error('unexpected '+key);};
  return {calls,deps:{client:{prepare:()=>stop('prepare'),create:()=>stop('post'),query:()=>stop('get')},fetcher:()=>stop('download')}};
}
const success=(id:string)=>({taskId:id,status:'generated' as const,rawStatus:'succeeded',duration:7,url:'https://example.test/video.mp4',evidence});
function fake(){
  const calls={posts:0,gets:0,downloads:0},requests:H3Request[]=[];
  const deps:VideoWorkflowDependencies={client:{async create(r){requests.push(r);calls.posts++;return {taskId:randomUUID(),evidence};},async query(id){calls.gets++;return success(id);}},fetcher:async()=>{calls.downloads++;return new Response(mp4(7));}};
  return {calls,deps,requests};
}
const checkNoNetwork=(c:ReturnType<typeof offline>)=>expect(c.calls).toEqual({prepare:0,post:0,get:0,download:0});
async function record(name:string,value:unknown){if(process.env.METASO_TEST_EVIDENCE_DIR)await writeFile(join(process.env.METASO_TEST_EVIDENCE_DIR,name+'.json'),JSON.stringify(value,null,2));}

it('local preparation adopts the one existing ordered batch and rejects unsafe CLI combinations before any transport',async()=>{
  const f=await batchFixture([2]),off=offline(),first=await execute(f.root,['--episodes','ep-z'],off.deps);
  expect(first).toMatchObject({exitCode:0,data:{state:'prepared',batchId:f.batch.plan.batchId,counts:{pending:2}}});
  const p=first.data as any;
  const selection=join(f.root,'selection.json');await writeFile(selection,JSON.stringify({schemaVersion:1,episodes:[{episodeId:'ep-z',segmentIds:['s1','s1']}]}));
  for(const invalid of [[],['--episodes','ep-z,ep-z'],['--episodes','ep-z','--confirm'],['--episodes','ep-z','--expect-scope','0'.repeat(64),'--confirm'],['--episodes','ep-z','--poll-ms','60001'],['--episodes','ep-z','--capacity-poll-ms','1'],['--episodes','ep-z','--concurrency','5'],['--batch',p.batchId,'--concurrency','1'],['--selection',selection,'--batch',p.batchId],['--selection',selection],['--all-episodes'],['--episodes','ep-z','--accept-unknown-result']]){
    expect((await execute(f.root,invalid,off.deps)).exitCode).toBe(1);
  }
  expect(await listJobs(f.root)).toEqual([]);checkNoNetwork(off);
  await record('video-prepared',{...p,network:off.calls});
});

it('scope binding and parent proofs reject ambiguity, broken targets, cross-scope pointers and malformed locks',async()=>{
  const f=await batchFixture([2]),off=offline();
  const duplicate=await createBatchPlan(f.root,{episodes:['ep-z']});
  const ambiguous=await execute(f.root,['--episodes','ep-z'],off.deps);
  expect(ambiguous).toMatchObject({exitCode:1,data:{error:{code:'VIDEO_SCOPE_AMBIGUOUS'}}});
  for(const id of [duplicate.plan.batchId,f.batch.plan.batchId])expect((ambiguous.data as any).error.message).toContain(id);
  const p=(await execute(f.root,['--episodes','ep-z','--concurrency','2'],off.deps)).data as any;
  const file=join(f.root,'.metasocli/video-executions/by-scope',p.scopeHash+'.json'),original=JSON.parse(await readFile(file,'utf8'));
  for(const bad of [{...original,batchId:'c21413d2-7560-42ea-a705-7ce8a2d16831'},{...original,projectId:'c21413d2-7560-42ea-a705-7ce8a2d16831'},
    {...original,batchId:duplicate.plan.batchId,batchHash:duplicate.plan.batchHash},{...original,extra:true}]){
    await writeFile(file,JSON.stringify(bad));expect((await execute(f.root,['--episodes','ep-z','--concurrency','2'],off.deps)).exitCode).toBe(1);
    expect(JSON.parse(await readFile(file,'utf8'))).toEqual(bad);
  }
  expect((await execute(f.root,['--batch',p.batchId],off.deps)).exitCode).toBe(0);
  const lock=join(f.root,'.metasocli/video-executions/prepare.lock');await writeFile(lock,'{}');
  expect(await execute(f.root,['--episodes','ep-z'],off.deps)).toMatchObject({exitCode:1,data:{error:{code:'LOCK_UNKNOWN'}}});
  expect(await readFile(lock,'utf8')).toBe('{}');checkNoNetwork(off);
});

it('old and new public entries send identical ordered images, voice, inline IR and original decimal-duration request',async()=>{
  const requests:H3Request[][]=[];
  for(const entry of ['batch','video']){
    const text='林舟：“快走！”旁白：天亮了。 {{ref:b}} {{ref:a}}\n',f=await fixture(text),start=text.indexOf('天亮了。');
    await importStory(f.root,{...f.draft,recipes:[{assetId:'a',kind:'character',prompt:'完整人物'}, {assetId:'b',kind:'scene',prompt:'完整场景'}, {assetId:'n',kind:'narration',prompt:'旁白声线'}],
      segments:[{...f.draft.segments[0],duration:6.963,references:['b','a'].map(assetId=>({assetId,role:'reference_image'})),narration:{assetId:'n',cues:[{start,end:start+4}]}}]});
    for(const [id,bytes] of [['a',png()],['b',png(512,512)],['n',wav()]] as const){const path=join(dirname(f.root),id);await writeFile(path,bytes);await registerAsset(f.root,id,{file:path});}
    const deps=fake(),b=await createBatchPlan(f.root,{episodes:['ep-1']});
    const result=entry==='batch'?await runCli(['batch','run','--root',f.root,'--batch',b.plan.batchId,'--confirm','--poll-ms','0'],deps.deps)
      :await execute(f.root,['--batch',b.plan.batchId,'--confirm','--poll-ms','0'],deps.deps);
    const data=result.data as any;
    expect(result.exitCode,JSON.stringify({entry,error:data.error,status:data.state,segments:data.segments,items:data.run?.items})).toBe(0);
    expect(deps.requests).toHaveLength(1);requests.push(deps.requests);
  }
  expect(requests[0]).toEqual(requests[1]);expect(requests[1]![0]).toMatchObject({context_ir_enabled:true,duration:7,model:'MiniMax-H3',resolution:'768P'});
  expect(requests[1]![0]!.content.map(c=>c.type)).toEqual(['text','image_url','image_url','audio_url']);
  await record('equivalent-video',{oldRequestHash:sha256Hex(JSON.stringify(requests[0])),newRequestHash:sha256Hex(JSON.stringify(requests[1])),posts:[1,1]});
},60000);

it('active/partial/complete local reports do zero I/O to provider; failed download and corruption recover by original ID',async()=>{
  const f=await batchFixture([1]),id=f.batch.plan.batchId,off=offline(),{deps,calls}=fake();
  let allow=false;
  const start=performance.now();
  const paused=await execute(f.root,['--batch',id,'--confirm','--poll-ms','0'],{...deps,fetcher:async()=>{calls.downloads++;return new Response(null,{status:503});}});
  expect(paused).toMatchObject({exitCode:2,data:{state:'partial',counts:{downloads:1}}});
  const pending=(paused.data as any).segments[0];
  expect(await execute(f.root,['--batch',id],off.deps)).toMatchObject({exitCode:2,data:{segments:[{operationId:pending.operationId,output:null}]}});
  const resumed=await execute(f.root,['--batch',id,'--confirm','--poll-ms','0'],deps);
  expect(resumed).toMatchObject({exitCode:0,data:{segments:[{operationId:pending.operationId,taskId:pending.taskId,output:{sha256:sha256Hex(mp4(7)),duration:7}}]}});
  const saved=(resumed.data as any).segments[0].output,report=(resumed.data as any).deliveryPath;
  await writeFile(report,'{corrupt');expect(await execute(f.root,['--batch',id,'--confirm'],off.deps)).toMatchObject({exitCode:0,data:{state:'complete'}});
  await unlink(report);await mkdir(report);
  expect(await execute(f.root,['--batch',id],off.deps)).toMatchObject({exitCode:2,data:{state:'delivery_incomplete',error:{code:'DELIVERY_WRITE_FAILED'},counts:{reusable:1}}});
  await rmdir(report);expect((await execute(f.root,['--batch',id],off.deps)).exitCode).toBe(0);
  const plain=await readFile(saved.path);await writeFile(saved.path,Buffer.from('corrupt'));
  expect(await execute(f.root,['--batch',id],off.deps)).toMatchObject({exitCode:2,data:{segments:[{reason:'OUTPUT_NEEDS_RECOVERY',output:null}]}});
  await unlink(saved.path);expect((await execute(f.root,['--batch',id],off.deps)).exitCode).toBe(2);
  await writeFile(saved.path,plain);
  const av=()=>execute(f.root,['--batch',id,'--verify-av'],{...off.deps,avCommand:async(tool,args)=>{
    if(!allow)throw Object.assign(Error(),{code:'ENOENT'});
    expect(args).toContain(saved.path);return tool==='ffprobe'?'{"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}':'';
  }});
  expect(await av()).toMatchObject({exitCode:2,data:{segments:[{av:{passed:false,reason:'AV_TOOL_UNAVAILABLE'}}]}});
  allow=true;expect(await av()).toMatchObject({exitCode:0,data:{segments:[{av:{passed:true}}]}});
  expect(await execute(f.root,['--batch',id,'--verify-av'],{...off.deps,avCommand:async(tool)=>{if(tool==='ffmpeg')throw Error('decode');return '{"streams":[{"codec_type":"audio"},{"codec_type":"video"}]}';}})).toMatchObject({exitCode:2,data:{segments:[{reason:'AV_VERIFICATION_FAILED'}]}});
  checkNoNetwork(off);expect(calls.posts).toBe(1);
  await record('video-download',{elapsedMs:performance.now()-start,operationId:pending.operationId,taskId:pending.taskId,calls,localRebuild:off.calls});
},60000);

it('retryOnly authorization survives confirm and a new invocation; unrelated pending items get no POST',async()=>{
  const f=await batchFixture([3]),id=f.batch.plan.batchId,item=f.batch.plan.items[1]!,network=fake(),off=offline();
  const old=await submit(f.root,item.planId,item.segmentId,true,{client:{async create(){throw Error('lost');},async query(){throw Error('unknown');}}});
  expect((await execute(f.root,['--batch',id],off.deps)).exitCode).toBe(2);
  const retry=await runCli(['batch','retry','--root',f.root,'--batch',id,'--operation',old.operationId,'--confirm','--accept-unknown-result','--poll-ms','0'],network.deps);
  expect(retry).toMatchObject({exitCode:2,data:{summary:{pending:2,reusable:1}}});
  const grant=(await loadBatchRun(f.root,f.batch.plan))!.authorization;
  expect(await execute(f.root,['--batch',id,'--confirm'],network.deps)).toMatchObject({exitCode:2,data:{counts:{pending:2,reusable:1}}});
  expect((await loadBatchRun(f.root,f.batch.plan))!.authorization).toEqual(grant);expect(grant.retryOnly).toHaveLength(1);
  expect(network.calls.posts).toBe(1);expect((await listJobs(f.root)).some(j=>j.operationId===old.operationId && j.status==='submit_unknown')).toBe(true);checkNoNetwork(off);
},60000);

it.each(['unknown','failed','submit_unknown'] as const)('retains %s task under repeated confirmation',async mode=>{
  const f=await batchFixture([1]),id=f.batch.plan.batchId;let posts=0;
  const client:VideoClient={async create(){posts++;if(mode==='submit_unknown')throw Error('lost');return {taskId:'original',evidence};},
    async query(taskId){return {taskId,status:mode==='failed'?'failed':'unknown',rawStatus:mode,evidence};}};
  for(let n=0;n<2;n++)expect((await execute(f.root,['--batch',id,'--confirm','--max-polls','1','--poll-ms','0'],{client})).exitCode).toBe(2);
  expect(posts).toBe(1);expect((await listJobs(f.root))[0]).toMatchObject({status:mode==='unknown'?'query_unknown':mode});
},45000);

it('stale mixed batch reports only original IDs for recovery; active local read does not poll',async()=>{
  const f=await batchFixture([2]),off=offline(),item=f.batch.plan.items[0]!;
  const job=await submit(f.root,item.planId,item.segmentId,true,fake().deps);
  expect(await execute(f.root,['--batch',f.batch.plan.batchId],off.deps)).toMatchObject({exitCode:2,data:{segments:[{taskId:job.taskId},{status:'pending'}]}});
  const source=join(f.root,'added.txt');await writeFile(source,'新增。');
  await importStory(f.root,{episodeId:'extra',kind:'video-prompts',source,segments:[{id:'s1',start:0,end:3,duration:6}]});
  expect(await execute(f.root,['--batch',f.batch.plan.batchId,'--confirm'],off.deps)).toMatchObject({exitCode:2,data:{error:{code:'PLAN_STALE'},segments:[
    {operationId:job.operationId,recover:['resume','--root',f.root,'--operation',job.operationId]},{status:'pending',reason:'PLAN_STALE'}]}});
  checkNoNetwork(off);
});

it('two projects share four slots, terminal segment 3 admits 4 while two downloads are held',async()=>{
  const a=await batchFixture([8]),b=await batchFixture([1]),trace:object[]=[],posts:number[]=[];
  let active=0,peak=0,dl=0,peakDl=0,releaseB!:()=>void,releaseDl!:()=>void,bStarted!:()=>void;
  const bGate=new Promise<void>(r=>releaseB=r),dlGate=new Promise<void>(r=>releaseDl=r),start=new Promise<void>(r=>bStarted=r);
  const live=new Set<string>();
  function entered(id:string){live.add(id);active++;peak=Math.max(peak,active);trace.push({event:'post',id,active});expect(active).toBeLessThanOrEqual(4);}
  function ended(id:string){if(live.delete(id)){active--;trace.push({event:'terminal',id,active});}return success(id);}
  const bWork=execute(b.root,['--batch',b.batch.plan.batchId,'--confirm','--poll-ms','0'],{client:{async create(){entered('B');bStarted();return {taskId:'B',evidence};},async query(id){await bGate;return ended(id);}},fetcher:async()=>new Response(mp4(7))});
  await start;
  const aWork=execute(a.root,['--batch',a.batch.plan.batchId,'--confirm','--poll-ms','5'],{client:{
    async create(req){const text=req.content[0];const n=Number(text?.type==='text' && text.text.match(/第(\d+)段/u)?.[1]);posts.push(n);entered('A'+n);
      if(n===4)expect((await listJobs(a.root)).find(j=>j.segmentId==='s3')?.status).toMatch(/generated|downloaded/);
      if(n===5)releaseB();if(n===8)releaseDl();return {taskId:'A'+n,evidence};},
    async query(id){if((id==='A1'||id==='A2') && posts.length<5)return {taskId:id,status:'running',rawStatus:'running',evidence};return ended(id);}
  },fetcher:async()=>{dl++;peakDl=Math.max(peakDl,dl);try{await dlGate;return new Response(mp4(7));}finally{dl--;}}});
  try{expect((await aWork).exitCode).toBe(0);}finally{releaseB();releaseDl();}
  expect((await bWork).exitCode).toBe(0);expect(posts).toEqual([1,2,3,4,5,6,7,8]);expect(peak).toBe(4);expect(peakDl).toBe(2);
  await record('video-execute-capacity',{posts,otherProjectPosts:1,peak,peakDl,trace});
},120000);

it('older partial report cannot overwrite a newer complete delivery; active image stage reports a recoverable pause',async()=>{
  const f=await batchFixture([1]),id=f.batch.plan.batchId,item=f.batch.plan.items[0]!,off=offline(),network=fake();
  const stage=join(f.root,'.metasocli/image-stage.json');
  await writeFile(stage,JSON.stringify({projectId:f.batch.plan.projectId,planId:randomUUID(),runtime:dirname(f.root),quotaGroup:'test',token:randomUUID(),state:'active'}));
  expect(await execute(f.root,['--batch',id,'--confirm'],off.deps)).toMatchObject({exitCode:2,data:{error:{code:'IMAGE_STAGE_ACTIVE'}}});
  expect(await listJobs(f.root)).toEqual([]);await unlink(stage);
  await submit(f.root,item.planId,item.segmentId,true,network.deps);
  let holding!:()=>void,release!:()=>void;
  const holdingPromise=new Promise<void>(r=>holding=r),released=new Promise<void>(r=>release=r);
  const older=execute(f.root,['--batch',id],{...off.deps,workflowCheckpoint:async point=>{if(point==='video-delivery-before-write'){holding();await released;}}});
  await holdingPromise;
  try{expect((await execute(f.root,['--batch',id,'--confirm','--poll-ms','0'],network.deps)).exitCode).toBe(0);}finally{release();}
  const result=await older;expect(result).toMatchObject({exitCode:0,data:{state:'complete'}});
  expect(JSON.parse(await readFile((result.data as any).deliveryPath,'utf8')).state).toBe('complete');
  checkNoNetwork(off);expect(network.calls.posts).toBe(1);
},60000);

it('records local preparation, execution including download, and independent zero-network delivery timings',async()=>{
  const f=await batchFixture([2]),file=join(f.root,'only-second.json');
  await writeFile(file,JSON.stringify({schemaVersion:1,episodes:[{episodeId:'ep-z',segmentIds:['s2']}]}));
  const off=offline(),network=fake();
  let began=performance.now();const prepared=await execute(f.root,['--selection',file],off.deps),prepareMs=performance.now()-began;
  const p=prepared.data as any;let downloadBegan=0,downloadMs=0;
  began=performance.now();
  const done=await execute(f.root,['--batch',p.batchId,'--confirm','--poll-ms','0'],{...network.deps,
    fetcher:async()=>{network.calls.downloads++;downloadBegan=performance.now();return new Response(mp4(7));},
    checkpoint:async point=>{if(point==='download-after-rename')downloadMs=performance.now()-downloadBegan;}});
  const executeMs=performance.now()-began;expect(done.exitCode).toBe(0);
  began=performance.now();const check=await execute(f.root,['--batch',p.batchId],off.deps);const deliveryMs=performance.now()-began;
  expect(check.exitCode).toBe(0);expect(downloadMs).toBeGreaterThan(0);checkNoNetwork(off);
  await record('video-timings',{prepareMs,executeMs,downloadMs,deliveryMs,publicInvocations:3,executeIncludesDownload:true,
    executionNetwork:network.calls,localNetwork:off.calls,prepared:p,delivered:check.data});
},45000);
