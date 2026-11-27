// node scripts/seedance-process-smoke.mjs [--ffmpeg <exe>] [--evidence-dir <directory>]
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeStory, importStory } from '../dist/core/project.js';
import { credential, digest, model, startProvider } from './seedance-smoke-http.mjs';

const { values }=parseArgs({options:{ffmpeg:{type:'string'},'evidence-dir':{type:'string'}}});
const toolsDir=dirname(fileURLToPath(import.meta.url));
const cli=join(toolsDir,'../dist/cli/main.js');
const ffmpeg=values.ffmpeg??'ffmpeg', run=promisify(execFile);
const parent=resolve(values['evidence-dir']??process.env.METASO_TEST_EVIDENCE_DIR??tmpdir());
await fs.mkdir(parent,{recursive:true});
const base=await fs.mkdtemp(join(parent,'seedance-video-run-'));
const fixtureDir=join(base,'media');await fs.mkdir(fixtureDir);
const videos=new Map(), media=[], outcomes=[];
async function encode(args) {
  await run(ffmpeg,['-nostdin','-v','error','-xerror',...args],{windowsHide:true,timeout:90000});
}
async function asset(name,role,mime,args){
  const file=join(fixtureDir,name);await encode([...args,file]);
  media.push({role,mime,path:'assets/'+name,sha256:digest(await fs.readFile(file))});
}
for (const [name,color] of [['z.png','blue'],['a.png','red']]) {
  await asset(name,'reference_image','image/png',['-f','lavfi','-i','color=c='+color+':s=96x96','-frames:v','1','-threads','1']);
}
for (const [name,hz] of [['z.wav',880],['a.wav',220]]) {
  await asset(name,'reference_audio','audio/wav',['-f','lavfi','-i','sine=frequency='+hz+':duration=2','-ar','16000','-ac','1']);
}
for (const [name,color] of [['z.mp4','navy'],['a.mp4','yellow']]) {
  await asset(name,'reference_video','video/mp4',['-f','lavfi','-i','color=c='+color+':s=96x96:r=4','-t','1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p']);
}
for(const res of ['480p','720p']) for(const seconds of [5,30]) for(const sound of [true,false]){
  const key=[res,seconds,sound].join('-'), path=join(fixtureDir,key+'.mp4');
  const size=res==='480p'?'480x854':'720x1280';
  const args=['-f','lavfi','-i','color=c=teal:s='+size+':r=3'];
  if(sound)args.push('-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-c:a','aac','-b:a','24k');
  await encode([...args,'-t',String(seconds),'-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','faststart',path]);
  videos.set(key,await fs.readFile(path));
}
const provider=await startProvider(videos);
const children=new Set();

function row(id,{duration=5,assets=[],requireAudio=false,extra=''}={}) {
  const count=assets.filter(a=>a.role==='reference_image').length;
  const refs=Array.from({length:count},(_,i)=>'@图'+(i+1)).join('、');
  return {id,duration,assets,requireAudio,prompt:id+' '+refs+' 镜头缓缓前移。\n角色说：“灯亮了。” 🎬 '+extra+'  '};
}
async function story(c,episodes) {
  const root=join(base,c.name); await initializeStory(root,c.name);
  await fs.cp(fixtureDir,join(root,'assets'),{recursive:true});
  // Exercise the project's stored .image naming convention.
  await fs.copyFile(join(root,'assets','z.png'),join(root,'assets','z.image'));
  for(const [episodeId,items] of Object.entries(episodes)) {
    const source=join(base,c.name+'-'+episodeId+'.txt');
    let text='';const segments=[];
    for(const r of items) {
      const start=text.length;text+=r.prompt;
      segments.push({id:r.id,start,end:text.length,duration:r.duration,prompt:r.prompt,
        seedance:{assets:r.assets,requireAudio:r.requireAudio,ratio:'9:16'}});
      c.expected.set(r.prompt,r);
    }
    await fs.writeFile(source,text);
    await importStory(root,{episodeId,kind:'video-prompts',source,segments});
  }
  return root;
}
function execute(c,root,args,skillPacket,verb=['video','run']) {
  const env={...process.env,METASO_TEST_LOOPBACK:provider.origin,METASO_TEST_SCENARIO:c.name,
    METASO_RUNTIME_DIR:join(base,'runtime-'+c.name),
    METASOCLI_YICIYUANG_VIDEO_API_KEY:credential,METASO_API_KEY:'',METASOCLI_IMAGE_API_KEY:'',NODE_OPTIONS:'--import='+pathToFileURL(join(toolsDir,'seedance-test-preload.mjs')).href};
  if(isAbsolute(ffmpeg))env.PATH=dirname(ffmpeg)+delimiter+(env.PATH??env.Path??'');
  const command=skillPacket ? [join(toolsDir,'seedance-skill.mjs'),skillPacket] :
    [cli,...verb,'--root',root,'--runtime-dir',env.METASO_RUNTIME_DIR,...args];
  const proc=spawn(process.execPath,command,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  children.add(proc);
  let stdout='',stderr='';
  proc.stdout.on('data',s=>stdout+=s);proc.stderr.on('data',s=>stderr+=s);
  const ended=new Promise((ok,bad)=>{proc.once('error',bad);proc.once('close',code=>{
    try {
      assert(!stdout.includes(credential)&&!stderr.includes(credential),'credential leaked in CLI output');
      ok({code,data:stdout.trim()?JSON.parse(stdout):undefined,stderr});
    }catch(e){bad(e);}
  });});
  const timeout=setTimeout(()=>proc.kill('SIGKILL'),120000);
  ended.finally(()=>{clearTimeout(timeout);children.delete(proc);}).catch(()=>{});
  return {proc,ended};
}
const createCount=c=>c.requests.filter(r=>r.method==='POST').length;
const start=(res,...scope)=>['--model',model(res),...scope];
async function selection(name,episodes) {
  const file=join(base,name+'.json');
  await fs.writeFile(file,JSON.stringify({schemaVersion:1,episodes:Object.entries(episodes).map(([episodeId,segmentIds])=>({episodeId,segmentIds}))}));
  return ['--selection',file];
}
async function checkOutput(c,entry,root) {
  const task=c.tasks.get(entry.taskId);assert.ok(task);
  assert.equal(entry.model,task.model);assert.equal(entry.segmentId,task.segmentId);
  const file=entry.output?.absolutePath;assert.ok(file,JSON.stringify(entry));
  assert.equal(dirname(file),join(root,'outputs',entry.episodeId));
  const bytes=await fs.readFile(file);assert.equal(digest(bytes),digest(task.output));
  assert.equal(entry.output.sha256,digest(bytes));assert.match(basename(file),new RegExp('^'+entry.segmentId+'-'));
  const sound=c.expected.get([...c.expected.keys()].find(p=>digest(p)===task.promptSha256)).requireAudio;
  const args=['-protocol_whitelist','file,pipe','-f','mov','-i',file,'-map','0:v:0'];
  if(sound) args.push('-map','0:a:0');
  await encode([...args,'-f','null','-']);
  c.outputs.push({taskId:entry.taskId,segmentId:entry.segmentId,path:file,sha256:digest(bytes),requireAudio:sound});
}
function success(r){assert.equal(r.code,0,JSON.stringify(r));return r.data;}
function waitUntil(promise,ms,msg) {
  let timer; const deadline=new Promise((_,bad)=>{timer=setTimeout(()=>bad(Error(msg)),ms);});
  return Promise.race([promise,deadline]).finally(()=>clearTimeout(timer));
}
async function test(name,options,fn) {
  const c=provider.newCase(name,options);c.outputs=[];let error;
  try{await fn(c);assert.deepEqual(c.errors,[]);}
  catch(e){error=[String(e.stack),...c.errors].join('\n');}
  const tasks=Array.from(c.tasks.values(),({output,...v})=>v);
  outcomes.push({name,passed:!error,error,creates:createCount(c),requests:c.requests,tasks,outputs:c.outputs});
  console.log((error?'FAIL ':'PASS ')+name+' ('+createCount(c)+' POST)'+(error?' '+error.split('\n').slice(0,2).join('\n'):''));
}
const mixed=media.map(a=>a.path==='assets/z.png'?{...a,path:'assets/z.image'}:a);
const missing=row('s1',{assets:[{...media[0],path:'assets/absent.png'}]});
try {
  await test('selected-and-models',{},async c=>{
    const root=await story(c,{'ep-2':[missing,row('s3',{assets:mixed,requireAudio:true}),row('s5',{assets:mixed,duration:29.2,requireAudio:true})]});
    const scope=await selection('two',{'ep-2':['s3','s5']});
    const packet=join(base,'skill.json');
    const plain={entry:'ycy480sd2',root,selection:scope[1],intent:'generate'};
    for(const [message,intent] of [['$ycy480sd2.5','select'],['讨论示例：`$ycy480sd2.5 生成第2集第3、5段`','discuss'],['$ycy480sd2.50 生成第2集第3、5段','generate']]){
      await fs.writeFile(packet,JSON.stringify({...plain,message,intent}));
      success(await execute(c,root,[],packet).ended);assert.equal(createCount(c),0);
    }
    await fs.writeFile(packet,JSON.stringify({...plain,message:'生成第2集第3、5段',prior:{root,message:'$ycy480sd2.5'}}));
    for(const [index,res] of ['480p','720p'].entries()){
      const args=start(res,...scope);
      const preview=success(await execute(c,root,args).ended);
      assert.equal(createCount(c),index*2);assert.deepEqual(preview.segments.map(s=>s.segmentId),['s3','s5']);
      const result=success(await execute(c,root,[...args,'--confirm'],index===0?packet:undefined).ended);
      assert.deepEqual(result.segments.map(s=>s.segmentId),['s3','s5']);
      assert.equal(createCount(c),index*2+2);
      for(const segment of result.segments) await checkOutput(c,segment,root);
      const again=success(await execute(c,root,['--batch',result.batchId,'--confirm']).ended);
      assert.deepEqual(again.segments.map(s=>s.operationId),result.segments.map(s=>s.operationId));
      assert.equal(createCount(c),index*2+2);
    }
    assert.equal(new Set(c.outputs.map(o=>o.path)).size,4);
    const bad=await execute(c,root,start('480p','--episodes','ep-2','--confirm')).ended;
    assert.equal(bad.code,2);assert.match(JSON.stringify(bad.data.segments[0]),/absent\.png/);
    assert.equal(createCount(c),4);
  });
  await test('ordered-episodes-and-urls',{},async c=>{
    const frames=media.slice(0,2).map((a,i)=>({...a,role:i?'last_frame':'first_frame',url:'https://assets.example/'+i+'.png'}));
    const root=await story(c,{'ep-3':[row('s2',{assets:frames})],'ep-4':[row('s4')]});
    const r=success(await execute(c,root,start('480p','--episodes','ep-4,ep-3','--confirm')).ended);
    assert.deepEqual(r.segments.map(s=>s.episodeId),['ep-4','ep-3']);
    assert.equal(createCount(c),2);for(const s of r.segments) await checkOutput(c,s,root);
  });
  await test('partial-ready-batch',{},async c=>{
    const root=await story(c,{'ep-1':[missing,row('ready')]});
    const result=await execute(c,root,start('480p','--episodes','ep-1','--confirm')).ended;
    assert.equal(result.code,2);assert.equal(createCount(c),1);
    const [blocked,ready]=result.data.segments;
    assert.match(JSON.stringify(blocked.issue),/absent\.png/);assert(!blocked.taskId);
    await checkOutput(c,ready,root);
  });
  await test('concurrent-processes',{},async c=>{
    const root=await story(c,{'ep-1':[row('s1')]});
    const args=start('480p','--episodes','ep-1','--confirm');
    const concurrent=await Promise.all([execute(c,root,args).ended,execute(c,root,args).ended]);
    assert(concurrent.some(r=>r.code===0),JSON.stringify(concurrent));
    const again=success(await execute(c,root,args).ended);
    assert.equal(createCount(c),1);await checkOutput(c,again.segments[0],root);
  });
  for(const minutes of [39,41])await test('minute-'+minutes,{minutes,query429:true},async c=>{
    const root=await story(c,{'ep-1':[row('long')]});
    const result=await execute(c,root,start('720p','--episodes','ep-1','--confirm')).ended;
    const [entry]=success(result).segments;
    assert.equal(!!entry.firstWindowReported,minutes>40);assert.equal(/40 分钟/.test(result.stderr),minutes>40);
    const finalQuery=c.requests.find(r=>r.status==='completed');
    const t=c.tasks.get(entry.taskId);assert.ok(finalQuery.now-t.receivedAt>=minutes*60000);
    assert(c.requests.some(r=>r.httpStatus===429));
    assert.equal(createCount(c),1);await checkOutput(c,entry,root);
  });
  await test('restart-during-query',{holdQuery:true},async c=>{
    const root=await story(c,{'ep-1':[row('restart')]});
    const args=start('480p','--episodes','ep-1');
    const plan=success(await execute(c,root,args).ended);
    const held=new Promise(r=>{c.options.onHeld=r;});
    const first=execute(c,root,[...args,'--confirm']);
    try { await waitUntil(held,20000,'No query before process termination'); }
    finally {first.proc.kill('SIGKILL');await first.ended;}
    assert.equal(createCount(c),1);c.options.holdQuery=false;
    const recovered=success(await execute(c,root,['--batch',plan.batchId,'--confirm']).ended);
    assert.equal(createCount(c),1);await checkOutput(c,recovered.segments[0],root);
  });
  await test('download-resume-and-redirect',{downloadFailure:true,redirect:true},async c=>{
    const root=await story(c,{'ep-1':[row('download')]});
    const first=await execute(c,root,start('480p','--episodes','ep-1','--confirm')).ended;
    assert.equal(first.code,2,JSON.stringify(first));assert.equal(createCount(c),1);
    c.options.allowDownload=true;
    const recovered=success(await execute(c,root,['--operation',first.data.segments[0].operationId],undefined,['resume']).ended);
    assert.equal(first.data.segments[0].taskId,recovered.segments[0].taskId);
    assert.equal(createCount(c),1);assert(c.requests.some(r=>r.route.startsWith('/cdn/')));
    assert(c.requests.some(r=>r.httpStatus===503));
    await checkOutput(c,recovered.segments[0],root);
  });
  await test('lost-create-receipt',{dropCreate:true},async c=>{
    const root=await story(c,{'ep-1':[row('unknown')]});
    const first=await execute(c,root,start('720p','--episodes','ep-1','--confirm')).ended;
    assert.equal(first.data?.segments?.[0].status,'submit_unknown',JSON.stringify(first));
    const next=await execute(c,root,['--batch',first.data.batchId,'--confirm']).ended;
    assert.equal(next.data.segments[0].status,'submit_unknown');
    assert.equal(createCount(c),1);assert.equal(next.data.segments[0].taskId,undefined);
    const id=[...c.tasks.keys()][0],operation=next.data.segments[0].operationId;
    success(await execute(c,root,['--operation',operation,'--task',id,'--confirm-task-link'],undefined,['attach-task']).ended);
    const recovered=success(await execute(c,root,['--operation',operation],undefined,['resume']).ended);
    assert.equal(recovered.segments[0].taskId,id);assert.equal(createCount(c),1);
    await checkOutput(c,recovered.segments[0],root);
  });
  await test('authorized-one-time-retry',{dropCreate:true},async c=>{
    const root=await story(c,{'ep-1':[row('retry')]});
    const first=await execute(c,root,start('480p','--episodes','ep-1','--confirm')).ended;
    const original=first.data.segments[0];
    assert.equal(original.status,'submit_unknown');assert.equal(createCount(c),1);
    c.options.dropCreate=false;
    const args=['--batch',first.data.batchId,'--retry-of',original.operationId,'--accept-unknown-result','--confirm'];
    const second=success(await execute(c,root,args).ended);
    assert.notEqual(second.segments[0].operationId,original.operationId);assert.equal(createCount(c),2);
    const again=success(await execute(c,root,args).ended);
    assert.equal(again.segments[0].operationId,second.segments[0].operationId);assert.equal(createCount(c),2);
    await checkOutput(c,again.segments[0],root);
  });
  await test('conflicting-query-identity',{badIdentity:true},async c=>{
    const root=await story(c,{'ep-1':[row('identity')]});
    const result=await execute(c,root,start('480p','--episodes','ep-1','--confirm')).ended;
    assert.equal(result.code,2);assert.equal(createCount(c),1);assert(!result.data.segments[0].output);
    assert(!c.requests.some(r=>r.route.endsWith('/content')));
    c.options.badIdentity=false;
    const recovered=success(await execute(c,root,['--batch',result.data.batchId,'--confirm']).ended);
    assert.equal(createCount(c),1);await checkOutput(c,recovered.segments[0],root);
  });
  await test('wrong-resolution-rejected',{wrongResolution:'480p'},async c=>{
    const root=await story(c,{'ep-1':[row('size')]});
    const result=await execute(c,root,start('720p','--episodes','ep-1','--confirm')).ended;
    assert.equal(result.code,2);assert.equal(createCount(c),1);assert(!result.data.segments[0].output);
    assert.match(JSON.stringify(result.data),/VIDEO_RESOLUTION/);
  });
  await test('changed-file-before-submit',{},async c=>{
    const root=await story(c,{'ep-1':[row('binding',{assets:media.slice(0,2)})]});
    const plan=success(await execute(c,root,start('480p','--episodes','ep-1')).ended);
    await fs.copyFile(join(root,'assets','a.png'),join(root,'assets','z.png'));
    const result=await execute(c,root,['--batch',plan.batchId,'--confirm']).ended;
    assert.equal(result.code,2);assert.match(JSON.stringify(result.data),/ASSET_CHANGED/);
    assert.equal(createCount(c),0);
  });
  await test('missing-audio-rejected',{silentResult:true},async c=>{
    const root=await story(c,{'ep-1':[row('audio',{requireAudio:true})]});
    const result=await execute(c,root,start('480p','--episodes','ep-1','--confirm')).ended;
    assert.equal(result.code,2);assert.equal(createCount(c),1);assert(!result.data.segments[0].output);
  });
  await test('illegal-duration',{},async c=>{
    await assert.rejects(()=>story(c,{'ep-1':[row('invalid',{duration:31})]}));
    assert.equal(createCount(c),0);
  });
}finally{
  for(const p of children)p.kill('SIGKILL');
  await provider.close();
  const report=join(base,'evidence.json');await fs.writeFile(report,JSON.stringify({fixture:'loopback-only',outcomes},null,2));
  console.log('Evidence: '+report);
}
if(outcomes.some(r=>!r.passed)) process.exitCode=1;
