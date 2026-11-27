// End-to-end fault injection at a loopback HTTP receiver, with isolated stories and credentials.
// node scripts/seedance-recovery-smoke.mjs --ffmpeg <exe> --evidence-dir <dir> [--legacy <pre-change receipt>]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { runCli } from '../dist/cli/main.js';
import { initializeStory, importStory } from '../dist/core/project.js';
import { digest, model } from './seedance-smoke-http.mjs';
import { evidence } from './video-batch-process-fixture.mjs';
import { upgradeScenarios, rejectionScenarios } from './seedance-upgrade-smoke.mjs';

const { values } = parseArgs({options:{ffmpeg:{type:'string'},'evidence-dir':{type:'string'},legacy:{type:'string'}}});
const base = resolve(values['evidence-dir'] ?? tmpdir());
await fs.mkdir(base,{recursive:true});
const work = await fs.mkdtemp(join(base,'recovery-'));
const ffmpeg = values.ffmpeg ?? 'ffmpeg';
process.env.METASOCLI_FFMPEG = ffmpeg;
const key = 'offline-recovery-video-key';
process.env.METASOCLI_YICIYUANG_VIDEO_API_KEY = key;
process.env.METASO_API_KEY = '';
process.env.METASOCLI_IMAGE_API_KEY = '';
function media(args) {
  const result = spawnSync(ffmpeg,['-nostdin','-v','error','-xerror',...args],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,String(result.error ?? result.stderr));
}
const image = join(work,'project.png');
media(['-f','lavfi','-i','color=c=blue:s=96x96','-frames:v','1','-threads','1',image]);
const imageBytes = await fs.readFile(image);
const h3File=join(work,'h3-seven-seconds.mp4');
media(['-f','lavfi','-i','color=c=green:s=768x1366:r=3','-t','7','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',h3File]);
const h3Output=await fs.readFile(h3File);
const mixedH3=join(work,'h3-five.mp4'),mixed720=join(work,'seedance-720-30.mp4');
for(const [file,seconds,size] of [[mixedH3,5,'768x1366'],[mixed720,30,'720x1280']])
  media(['-f','lavfi','-i','color=c=blue:s='+size+':r=3','-t',String(seconds),'-c:v','libx264','-threads','1','-pix_fmt','yuv420p',file]);
const videos = {};
for (const [length,sound] of [[5,false],[5,true],[30,false]]) {
  const name = length+'-'+sound, path = join(work,name+'.mp4');
  const spec = ['-f','lavfi','-i','color=c=blue:s=480x854:r=3'];
  if(sound) spec.push('-f','lavfi','-i','sine=frequency=220:sample_rate=16000','-c:a','aac');
  media([...spec,'-t',String(length),'-c:v','libx264','-threads','1','-pix_fmt','yuv420p',path]);
  videos[name] = await fs.readFile(path);
}
const corrupt = Buffer.from(videos['5-false']);
let damaged = 0;
for(let i=0;i+8<=corrupt.length;) {
  const bytes=corrupt.readUInt32BE(i)||corrupt.length-i;
  assert.ok(bytes>=8 && i+bytes<=corrupt.length);
  if(corrupt.toString('ascii',i+4,i+8)==='mdat'){corrupt.fill(0,i+8,i+bytes);damaged+=bytes-8;}
  i+=bytes;
}
assert.ok(damaged>0);
const badFile=join(work,'damaged.mp4');await fs.writeFile(badFile,corrupt);
assert.throws(()=>media(['-i',badFile,'-map','0:v:0','-f','null','-']));

let context;
const calls=[];
const candidateSecret='secret-signed-query-not-for-logs';
function json(res,status,value){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
async function receive(req,res) {
  if(req.url.startsWith('/api/'))req.url=req.url.slice(4); // Same loopback service for spawned CLI processes.
  assert.equal(req.headers.authorization,'Bearer '+key);
  if(req.method==='POST'){
    assert.equal(req.url,'/v1/videos');
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const body=Buffer.concat(chunks), contentType=req.headers['content-type'];
    let params, parts=[];
    if(contentType.startsWith('multipart/form-data')){
      const form=await new Response(body,{headers:{'content-type':contentType}}).formData();
      params=Object.fromEntries([...form].filter(([,value])=>typeof value==='string'));
      for(const [field,value] of form)if(typeof value!=='string')parts.push({field,name:value.name,sha256:digest(Buffer.from(await value.arrayBuffer()))});
    }else params=JSON.parse(body.toString('utf8'));
    const id='offline_'+randomUUID(), order={method:'POST',id,params,promptSha256:digest(params.prompt),parts};
    context.orders.push(order);context.requests.push(order);
    if('rejection' in context){if(context.rejection===null){res.writeHead(422);return res.end();}return json(res,422,{error:context.rejection});}
    if(context.reject)return json(res,422,{error:{code:'BAD_REFERENCE',message:'Reference audio is unsupported. https://invalid.example/ref?signature='+candidateSecret+' Authorization: Bearer '+key+' '+'x'.repeat(7000)}});
    if(context.drop)return req.socket.destroy();
    return json(res,200,{id,status:'queued',model:params.model});
  }
  assert.equal(req.method,'GET');
  const [,id,content]=/^\/v1\/videos\/([^/]+)(\/content)?$/.exec(req.url);
  const order=context.orders.find(o=>o.id===id);assert.ok(order);
  const log={method:'GET',id,action:content?'content':'status'};context.requests.push(log);
  if(content) {
    const bytes=context.output ?? videos[order.params.duration+'-false'];
    log.sha256=digest(bytes);res.writeHead(200,{'content-type':'video/mp4'});res.end(bytes);return;
  }
  if(context.missing?.has(id))return json(res,404,{error:{code:'NOT_FOUND',message:'Task is unavailable.'}});
  const status=context.status??'completed';
  log.status=status;
  return json(res,200,{id,status,model:order.params.model});
}
const http=createServer((req,res)=>receive(req,res).catch(error=>{context.errors.push(String(error.stack));res.destroy();}));
http.listen(0,'127.0.0.1');await once(http,'listening');
const origin='http://127.0.0.1:'+http.address().port;
const actualFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
  const url=new URL(input instanceof Request?input.url:input);
  assert.equal(url.origin,'https://api.yiciyuang.com','Unexpected external URL');
  return actualFetch(new URL(url.pathname,origin),{...init,redirect:'manual'});
};
async function fixture(name,rows){
  const root=join(work,name),source=join(work,name+'.txt');
  await initializeStory(root,name);
  await fs.mkdir(join(root,'assets'),{recursive:true});
  await fs.copyFile(image,join(root,'assets','ref1.png'));
  let text='';
  const segments=rows.map(row=>{
    const prompt=row.prompt??'Caption '+row.id+'.\n',start=text.length;text+=prompt;
    return {id:row.id,start,end:text.length,prompt,duration:row.duration??5,...(row.seedance?{seedance:row.seedance}:{})};
  });
  await fs.writeFile(source,text);
  await importStory(root,{source,episodeId:'ep-1',kind:'video-prompts',segments});
  return root;
}
async function select(root,...ids) {
  const path=join(root,'selected-'+ids.join('-')+'.json');
  await fs.writeFile(path,JSON.stringify({schemaVersion:1,episodes:[{episodeId:'ep-1',segmentIds:ids}]}));
  return ['--selection',path];
}
const seed=(...args)=>['--model',model('480p'),...args];
async function command(root,verb,args,deps) {
  const data=await runCli([...verb,'--root',root,'--runtime-dir',context.runtime,...args],deps);
  assert.ok(!JSON.stringify(data).includes(key),'Fixture key in CLI response');
  context.results.push({verb,args,data:data.data,exitCode:data.exitCode});
  return data.data;
}
const run=(root,args,deps)=>command(root,['video','run'],['--poll-ms','0','--capacity-wait-ms','0',...args],deps);
const operation=(root,id,verb='resume')=>command(root,[verb],['--operation',id,...(verb==='resume'?['--poll-ms','0']:[])]);
const single=(result)=>{assert.equal(result.segments?.length,1,JSON.stringify(result));return result.segments[0];};
function delivered(result){assert.equal(result.state,'complete',JSON.stringify(result));return single(result);}
const count=()=>context.orders.length;
async function slots(){return JSON.parse(await fs.readFile(join(context.runtime,'seedance','slots.json'),'utf8')).length;}
async function probe(name,body){
  context={name,runtime:join(work,'runtime-'+name),requests:[],orders:[],results:[],errors:[]};
  try{await body();assert.deepEqual(context.errors,[]);context.passed=true;}
  catch(error){context.passed=false;context.error=String(error.stack);}
  calls.push({name,passed:context.passed,error:context.error,posts:count(),requests:context.requests,results:context.results,extra:context.extra});
  console.log((context.passed?'PASS ':'FAIL ')+name,'POST',count(),context.error?.split('\n').slice(0,2).join(' ')??'');
}
const two=[{id:'s1'},{id:'s2'}];
try {
  const harness={fixture,select,probe,seed,run,command,operation,count,single,delivered,work,media,imageBytes,origin,context:()=>context};
  await upgradeScenarios(harness);
  await rejectionScenarios(harness);
  await probe('dialogue-quoted-and-unquoted',async()=>{
    const prompt='镜头以 @图1 中的人物为参考。\n甲：“请打开参考图1。”\n乙：请打开参考图1。\n';
    const assets=[{role:'reference_image',path:'assets/ref1.png',mime:'image/png',sha256:digest(imageBytes)}];
    const root=await fixture('Dialogue',[{id:'s1',prompt,seedance:{assets}}]);
    delivered(await run(root,seed('--episodes','ep-1','--confirm')));
    assert.equal(count(),1);const received=context.orders[0];
    assert.equal(received.promptSha256,digest(prompt));assert.deepEqual(received.parts.map(f=>f.sha256),[digest(imageBytes)]);
  });
  await probe('cross-batch-retry-and-history',async()=>{
    const root=await fixture('Authorization',two),aSelection=await select(root,'s1');
    const stages=[];
    function checkScope(action,s1,s2){
      const totals=['s1','s2'].map(id=>context.orders.filter(o=>o.params.prompt==='Caption '+id+'.\n').length);
      assert.deepEqual(totals,[s1,s2]);stages.push({action,s1,s2});
    }
    const b=await run(root,seed('--episodes','ep-1'));assert.equal(count(),0);
    context.drop=true;
    const a=await run(root,seed(...aSelection,'--confirm'));const old=single(a);
    assert.equal(old.status,'submit_unknown');assert.equal(count(),1);
    context.drop=false;
    const flags=['--retry-of',old.operationId,'--accept-unknown-result','--confirm','--max-polls','1'];
    const wrong=await run(root,['--batch',b.batchId,...flags]);
    assert.ok(wrong.error||wrong.segments?.some(s=>s.issue));assert.equal(count(),1);
    await run(root,['--batch',b.batchId,'--confirm']);assert.equal(count(),1,'Preview granted authorization to create');
    checkScope('A authorized only s1; B preview and cross-batch retry',1,0);
    context.status='queued';
    const retry=single(await run(root,['--batch',a.batchId,...flags]));
    assert.ok(retry.taskId);assert.equal(count(),2);
    context.status='completed';
    const found=delivered(await operation(root,retry.operationId));
    assert.equal(count(),2);assert.equal(found.taskId,retry.taskId);
    checkScope('authorized retry s1 then recover only s1',2,0);
    const history=await run(root,['--batch',a.batchId]);
    const records=[history,await operation(root,old.operationId,'status'),await operation(root,retry.operationId,'status')];
    assert.equal(records[1].status,'submit_unknown');assert.equal(records[2].retryOf,old.operationId);
    assert.ok(JSON.stringify(history).includes(old.operationId) && JSON.stringify(history).includes(retry.operationId),'Batch history omits original or successor');
    assert.deepEqual(context.orders.map(o=>o.params.prompt),['Caption s1.\n','Caption s1.\n']);
    const all=await run(root,seed('--episodes','ep-1','--confirm'));assert.equal(all.state,'complete');assert.equal(count(),3);
    assert.equal(context.orders[2].params.prompt,'Caption s2.\n');
    checkScope('s2 explicitly authorized',2,1);
    context.extra={old:old.operationId,retry:retry.operationId,newPostsOnOperationResume:0,stages};
  });
  await probe('unknown-releases-slot-and-found-receipt',async()=>{
    const a=await fixture('Unknown',two),b=await fixture('Independent',[{id:'s3'}]);context.drop=true;
    const old=single(await run(a,seed(...await select(a,'s1'),'--confirm')));context.drop=false;
    assert.equal(old.status,'submit_unknown');assert.equal(await slots(),0);
    delivered(await run(a,seed(...await select(a,'s2'),'--confirm')));
    delivered(await run(b,seed('--episodes','ep-1','--confirm')));
    assert.equal(count(),3);
    const stillUnknown=single(await operation(a,old.operationId));assert.equal(stillUnknown.status,'submit_unknown');
    const id=context.orders[0].id;
    await command(a,['attach-task'],['--operation',old.operationId,'--task',id,'--confirm-task-link']);
    assert.equal(await slots(),0,'Attaching a confirmed completed task must not hold a generation slot');
    const got=delivered(await operation(a,old.operationId));assert.equal(got.taskId,id);
    assert.equal(await slots(),0);assert.equal(count(),3);
    context.extra={recoveredOriginalId:id,newPostsOnResume:0};
  });
  await probe('batch-resumes-only-previously-authorized-pending-orders',async()=>{
    const root=await fixture('PausedBatch',[...two,{id:'s3'}]);
    const view=await run(root,seed(...await select(root,'s1','s2')));
    assert.equal(count(),0);context.status='queued';
    const partial=await run(root,['--batch',view.batchId,'--expect-scope',view.scopeHash,'--confirm','--max-polls','1']);
    assert.equal(partial.state,'partial');assert.equal(count(),1);
    const first=partial.segments[0];assert.equal(first.segmentId,'s1');assert.ok(first.taskId);
    context.status='completed';
    assert.equal(delivered(await operation(root,first.operationId)).taskId,first.taskId);assert.equal(count(),1);
    const collected=await run(root,['--batch',view.batchId,'--confirm']);
    assert.equal(collected.state,'complete');assert.equal(count(),2);
    assert.deepEqual(collected.segments.map(s=>s.segmentId),['s1','s2']);
    assert.deepEqual(context.orders.map(o=>o.params.prompt),['Caption s1.\n','Caption s2.\n']);
    context.extra={postsOnSingleOperation:0,newlyStartedBySavedBatch:['s2'],unselected:'s3'};
  });
  await probe('known-404-releases-and-reclaims-capacity',async()=>{
    const a=await fixture('LostStatus',two),b=await fixture('Unrelated',[{id:'s3'}]);context.status='queued';
    const paused=single(await run(a,seed(...await select(a,'s1'),'--confirm','--max-polls','1')));
    assert.equal(await slots(),1);const id=paused.taskId;
    context.missing=new Set([id]);context.status='completed';
    const missing=single(await operation(a,paused.operationId));assert.equal(missing.taskId,id);assert.equal(await slots(),0);
    delivered(await run(a,seed(...await select(a,'s2'),'--confirm')));
    delivered(await run(b,seed('--episodes','ep-1','--confirm')));
    context.missing.clear();context.status='queued';
    const again=await command(a,['resume'],['--operation',paused.operationId,'--poll-ms','0','--max-polls','1']);
    assert.equal(single(again).taskId,id);assert.equal(await slots(),1,'A trusted active result must restore the slot');
    context.status='completed';assert.equal(delivered(await operation(a,paused.operationId)).taskId,id);
    assert.equal(await slots(),0);assert.equal(count(),3);
  });
  if(process.platform==='win32') await probe('windows-casing',async()=>{
    const root=await fixture('WindowsCase',two);context.status='queued';
    const old=single(await run(root,seed(...await select(root,'s1'),'--confirm','--max-polls','1')));
    context.status='completed';const got=delivered(await operation(root.replace(/WindowsCase$/,'windowscase'),old.operationId));
    assert.equal(got.taskId,old.taskId);assert.equal(await slots(),0);
    delivered(await run(root,seed(...await select(root,'s2'),'--confirm')));assert.equal(count(),2);
  });
  for(const requireAudio of [false,true])await probe(requireAudio?'required-audio':'corrupt-silent',async()=>{
    const root=await fixture(requireAudio?'Audio':'Corrupt',[{id:'s1',seedance:{assets:[],requireAudio}}]);
    context.output=requireAudio?videos['5-false']:corrupt;
    const bad=single(await run(root,seed('--episodes','ep-1','--confirm')));
    assert.ok(bad.issue && !bad.output);
    const files=await fs.readdir(join(root,'outputs'),{recursive:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    assert.ok(files.every(f=>!f.endsWith('.mp4')));
    context.output=videos['5-'+requireAudio];
    const good=delivered(await operation(root,bad.operationId));assert.equal(good.taskId,bad.taskId);assert.equal(count(),1);
    media(['-i',good.output.absolutePath,'-map','0:v:0',...(requireAudio?['-map','0:a:0']:[]),'-f','null','-']);
    context.extra={newPostsOnDownloadRecovery:0};
  });
  await probe('422-useful-bounded-redacted',async()=>{
    const root=await fixture('Rejected',[{id:'s1'}]);context.reject=true;
    const rejected=single(await run(root,seed('--episodes','ep-1','--confirm')));
    const diagnostic=JSON.stringify(rejected.issue);
    assert.match(diagnostic,/BAD_REFERENCE/);assert.match(diagnostic,/audio/i);assert.ok(diagnostic.length<2048);
    assert.ok(!diagnostic.includes(candidateSecret) && !diagnostic.includes(key));assert.equal(count(),1);assert.equal(await slots(),0);
  });
  function h3Client(log,allowedId,seconds=7,output=h3Output) {
    return {runtimeRoot:context.runtime,
      client:{async create(request){assert.equal(request.context_ir_enabled,true);const taskId=randomUUID();log.push({action:'create',request,taskId});return {taskId,evidence};},
        async query(taskId){if(allowedId)assert.equal(taskId,allowedId);log.push({action:'query',taskId});return {taskId,status:'generated',rawStatus:'succeeded',duration:seconds,url:'https://example.test/fake.mp4',evidence};}},
      fetcher:async()=>new Response(output)};
  }
  await probe('mixed-episode-actual-execution',async()=>{
    const root=await fixture('Mixed',[{id:'h3',duration:5},{id:'long',duration:30,seedance:{assets:[],ratio:'9:16'}}]);
    const log=[];context.extra={h3:log};
    const h3=delivered(await run(root,[...await select(root,'h3'),'--confirm'],h3Client(log,undefined,5,await fs.readFile(mixedH3))));
    assert.equal(h3.segmentId,'h3');assert.equal(log.filter(e=>e.action==='create').length,1);
    media(['-i',h3.output.path,'-map','0:v:0','-f','null','-']);
    assert.equal(count(),0);
    context.output=await fs.readFile(mixed720);
    const got=delivered(await run(root,['--model',model('720p'),...await select(root,'long'),'--confirm']));
    assert.equal(got.segmentId,'long');assert.equal(count(),1);assert.equal(Number(context.orders[0].params.duration),30);
    media(['-i',got.output.absolutePath,'-map','0:v:0','-f','null','-']);
    context.extra.stages=[{h3:1,ycy:0},{h3:1,ycy:1}];context.extra.paths=[h3.output.path,got.output.absolutePath];
  });
  if(values.legacy)await probe('previous-build-frozen-h3-recovery',async()=>{
    const old=JSON.parse(await fs.readFile(values.legacy,'utf8'));const prior=single(old.result.data);
    const root=join(work,'OldFrozenH3');await fs.cp(old.root,root,{recursive:true});
    // Use a clean coordinator when mounting the pre-change frozen story at a new path.
    const log=[];context.extra={log,originalOperation:prior.operationId};
    const got=delivered(await run(root,['--batch',old.result.data.batchId,'--confirm'],h3Client(log,old.id)));
    assert.equal(got.taskId,old.id);assert.equal(got.operationId,prior.operationId);assert.equal(got.sourcePlanHash,prior.sourcePlanHash);
    assert.ok(log.some(e=>e.action==='query'));assert.ok(log.every(e=>e.action!=='create'));
  });
} finally {
  globalThis.fetch=actualFetch;
  http.closeAllConnections();await new Promise(done=>http.close(done));
}
const report={work,origin,source:fileURLToPath(import.meta.url),cases:calls};
await fs.writeFile(join(work,'report.json'),JSON.stringify(report,null,2));
console.log(calls.filter(c=>c.passed).length+'/'+calls.length,join(work,'report.json'));
if(calls.some(c=>!c.passed))process.exitCode=1;
