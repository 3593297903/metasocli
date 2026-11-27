// Uses the installed package's CLI entrypoint and synthetic files only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { ImageProfile } from '../dist/images/contracts.js';
import { loadStory } from '../dist/core/project.js';
import { readPlan, seedOperation } from '../dist/seedance/store.js';
import { inspectVideo } from '../dist/jobs/video.js';
import { png } from './image-workflow-fixture.mjs';
import { startProvider, model, digest, credential } from './seedance-smoke-http.mjs';

const { values } = parseArgs({options:{ffmpeg:{type:'string'},python:{type:'string'},'evidence-dir':{type:'string'}}});
const scripts = dirname(fileURLToPath(import.meta.url));
const cli = resolve(scripts,'../dist/cli/main.js');
const python = values.python ?? 'python', ffmpeg = values.ffmpeg ?? 'ffmpeg';
const run = promisify(execFile), parent = resolve(values['evidence-dir'] ?? tmpdir());
await fs.mkdir(parent,{recursive:true});
const base = await fs.mkdtemp(join(parent,'creation-')), root = join(base,'story'), samples = join(base,'inputs');
await fs.mkdir(samples);
const json = async (path,value) => fs.writeFile(path,JSON.stringify(value,null,2));
const videoTemplates = new Map();
const service = await startProvider(videoTemplates);
const http = service.newCase('creation-acceptance',{captureWire:true});
const evidence = {base,story:root,drafts:[],tests:[],outputs:[],requests:http.requests};
const postCount = () => http.requests.filter(r=>r.method==='POST').length;
async function cmd(args,{code=0,file,program=cli}={}) {
  const env = {...process.env,NODE_OPTIONS:'--import='+pathToFileURL(join(scripts,'seedance-test-preload.mjs')).href,
    METASOCLI_YICIYUANG_VIDEO_API_KEY:credential,METASOCLI_IMAGE_API_KEY:'fixture-key',METASO_API_KEY:'',
    METASO_TEST_LOOPBACK:service.origin,METASO_TEST_SCENARIO:http.name,METASO_RUNTIME_DIR:join(base,'runtime')};
  if(values.ffmpeg) env.PATH = dirname(resolve(ffmpeg))+delimiter+(env.PATH??env.Path??'');
  let response, exit=0;
  const command=[program,...args];
  if(program===cli) command.push('--root',root);
  try { response=await run(process.execPath,command,{env,timeout:120000,maxBuffer:8*1024*1024,windowsHide:true}); }
  catch(err) { if(typeof err.code!=='number')throw err; exit=err.code;response=err; }
  const data=JSON.parse(response.stdout);
  if(file) await json(join(base,file),{args,exit,data,stderr:response.stderr});
  if(code!==null) assert.equal(exit,code,JSON.stringify(data));
  return {data,exit};
}
async function check(name,fn) {
  const before=postCount(), result={name};
  try { Object.assign(result,await fn(),{passed:true}); }
  catch(err) { result.passed=false;result.error=String(err.stack); }
  result.posts=postCount()-before;evidence.tests.push(result);
  console.log((result.passed?'PASS ':'FAIL ')+name+' ('+result.posts+' POST) '+(result.error?.split('\n')[0]??''));
}
async function encode(args) {
  return run(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-xerror',...args],{timeout:90000,windowsHide:true});
}
function wave(hz) {
  const rate=16000, samples=rate*2, data=Buffer.alloc(44+samples*2);
  data.write('RIFF',0);data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);
  data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);
  data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);
  data.write('data',36);data.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)data.writeInt16LE(Math.round(Math.sin(2*Math.PI*hz*i/rate)*6000),44+i*2);
  return data;
}
const sources={image:[],audio:[],video:[]};
async function addFile(kind,n,mime,extension,producer) {
  const name=kind+'-'+n+'.'+extension, file=join(samples,name), path='local-media/'+name;
  await producer(file); await fs.copyFile(file,join(root,path));
  sources[kind].push({role:'reference_'+kind,mime,path,sha256:digest(await fs.readFile(file))});
}
async function fixtures() {
  await fs.mkdir(join(root,'local-media'));
  for(let n=1;n<=31;n++)
    await addFile('image',n,'image/png','png',path=>fs.writeFile(path,png(5+n*7)));
  for(let n=1;n<=11;n++){
    await addFile('audio',n,'audio/wav','wav',path=>fs.writeFile(path,wave(200+17*n)));
    const color=(0x113377*n & 0xffffff).toString(16).padStart(6,'0');
    await addFile('video',n,'video/mp4','mp4',path=>encode(['-f','lavfi','-i','color=c=0x'+color+':s=256x256:r=3',
      '-t','1','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p',path]));
  }
  for(const [res,seconds,sound] of [['720p',24,true],['720p',24,false],['480p',24,false],['720p',5,false],['480p',5,false],['720p',30,true],['480p',30,true]]){
    const key=[res,seconds,sound].join('-'), file=join(samples,key+'.mp4'), size=res==='480p'?'480x854':'720x1280';
    // The moving test card and brief tones make the delivered synthetic sample easy to check by eye and ear.
    const args=['-f','lavfi','-i','testsrc2=size='+size+':rate=8'];
    if(sound)args.push('-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-af',
      "volume='if(lt(mod(t,2),0.16),0.25,0)':eval=frame",'-c:a','aac');
    await encode([...args,'-t',String(seconds),'-c:v','libx264','-threads','1','-preset','ultrafast',
      '-pix_fmt','yuv420p','-movflags','+faststart',file]);
    videoTemplates.set(key,await fs.readFile(file));
  }
}
const order=[7,1,10,4,12,2,9,3,8,5,11,6];
const allProjectImages=[...order,...Array.from({length:18},(_,i)=>30-i)];
const idFor=n=>'board-'+n;
const boards=['陆岚，靛蓝短雨衣与斜挎包','旧站售票厅，黄铜窗口与磨石地板','封着红蜡的牛皮信封',
  '站长沈舟，灰制服与方框眼镜','弧顶候车廊，长椅靠东墙','磨亮的铜钥匙，齿口一道缺痕',
  '邮差叶青，军绿外套与防水邮袋','雨中的三号站台，铁皮雨棚滴水','检查员的红色手提信号灯',
  '检票员阿禾，帽沿藏有银色别针','站台尽头的小门与三节石阶','白瓷面旧挂钟，指针停在九点',
  ...allProjectImages.slice(12).map(n=>'第'+n+'号分镜用合成测试色板')];
const recipes=allProjectImages.map((n,i)=>({
  assetId:idFor(n),kind:['character','scene','prop'][i%3],
  prompt:'为末班车的交接戏制作'+['角色多视图','场景空间板','道具结构板'][i%3]+'。主体为'+boards[i]+
    '。保持主体材质、颜色和空间关系一致，采用正面和侧面视角，便于连续镜头核对。',
  dependencies:[],exactText:[],
}));
function segment(id,duration,bindings=[],extra=[]) {
  // This deterministic draft encodes the creation skill's script/coverage/recipe contract.
  const original=id==='core24'?
    '旧站挂钟敲了九下。陆岚从售票窗口走入候车廊，把牛皮信封递给沈舟，指了指交接手册。\n'+
    '陆岚：“请打开参考图1。”\n沈舟：“看见了，我把信交给你。”\n'+
    '沈舟把铜钥匙交给叶青。检票员阿禾在雨棚下亮起红色信号灯。叶青沿三号站台奔下石阶，开了尽头的小门。\n':
    '第'+id+'段。灯光亮起。\n陆岚：“请打开参考图1。”\n沈舟：“看见了，我把信交给你。”\n';
  const technical=bindings.map(n=>'{{ref:'+idFor(n)+'}}');
  for(let i=0;i<extra.filter(a=>a.role==='reference_image').length;i++) technical.push('@图'+(bindings.length+i+1));
  const directions=technical.length?'镜头参考按绑定顺序：'+technical.join('、')+'。':'镜头从月台缓缓推向窗户。';
  const prompt=original+directions+(technical.length?' 第一张使用@图1。':'');
  const expected=original+(technical.length?'镜头参考按绑定顺序：'+technical.map((_,i)=>'@图'+(i+1)).join('、')+'。 第一张使用@图1。':directions);
  return {id,duration,bindings,extra,original,prompt,expected,requireAudio:id==='core24'||extra.some(a=>a.role==='reference_audio')};
}
async function handoff(episodeId,segments,{legacy=false}={}) {
  const dir='.metasocli/drafts/'+episodeId;await fs.mkdir(join(root,dir),{recursive:true});
  const source=dir+'/source.txt';let text='';
  const drafts=segments.map(s=>{
    const start=text.length;text+=s.original;
    const draft={id:s.id,start,end:text.length,duration:s.duration,prompt:s.prompt,
      references:s.bindings.map(n=>({assetId:idFor(n),role:'reference_image'}))};
    if(!legacy)draft.seedance={assets:s.extra,ratio:'9:16',requireAudio:s.requireAudio};
    return draft;
  });
  await fs.writeFile(join(root,source),text);
  const used=recipes.filter(r=>segments.some(s=>s.bindings.some(n=>idFor(n)===r.assetId)));
  const draft={episodeId,kind:'script',source,recipes:used,segments:drafts};
  const request={schemaVersion:'1.0.0',episodeId,modelPreference:null,requireExactModel:false,
    assets:used.map((r,i)=>({assetId:r.assetId,kind:r.kind,version:'v1',order:i+1,name:boards[recipes.indexOf(r)],required:true,
      requiredBySegments:segments.filter(s=>s.bindings.some(n=>idFor(n)===r.assetId)).map(s=>s.id),
      visualDescription:r.prompt,sourceFacts:[boards[recipes.indexOf(r)]],continuityRequirements:['同一身份的外观贯穿本次交接戏'],exclude:[],dependencyAssetIds:[],exactText:[]}))};
  const recipe={schemaVersion:'1.0.0',episodeId,assets:used.map(r=>({assetId:r.assetId,kind:r.kind,status:'planned',
    generationPrompt:r.prompt,recipeSha256:digest(r.prompt),existingRelativePath:null,contentSha256:null,reason:null}))};
  for(const [name,value] of Object.entries({draft,request,recipe}))await json(join(root,dir,name+'.json'),value);
  evidence.drafts.push(join(root,dir,'draft.json'));
  return {episodeId,draftPath:dir+'/draft.json',requestPath:dir+'/request.json',recipePath:dir+'/recipe.json',replace:false};
}
async function prepare(name,entries,projectId){
  const batch=join(root,name+'-batch.json');
  await json(batch,{schemaVersion:1,projectId,entries,scope:{episodes:entries.map(e=>e.episodeId)},profilePath:'profile.json'});
  return cmd(['images','prepare','--batch',batch,'--python',python],{code:null,file:name+'-prepare.json'});
}
function expectedAssets(s) {
  return [...s.bindings.map(n=>({...sources.image[n-1],assetId:idFor(n)})),...s.extra];
}
async function validateClip(entry,s,rootDir) {
  const task=http.tasks.get(entry.taskId);assert(task);
  assert.equal(entry.segmentId,s.id);assert.equal(task.receivedPrompt,s.expected);
  assert(task.receivedPrompt.includes('陆岚：“请打开参考图1。”'));
  const path=entry.output?.absolutePath;assert(path);assert.equal(dirname(path),join(rootDir,'outputs',entry.episodeId));
  const output=await inspectVideo(path), low=entry.model===model('480p');
  assert.equal(output.sha256,digest(task.output));assert.equal(output.duration,Math.ceil(s.duration));
  assert.deepEqual([output.width,output.height],low?[480,854]:[720,1280]);
  const args=['-f','mov','-i',path,'-map','0:v:0'];if(s.requireAudio)args.push('-map','0:a:0');
  await encode([...args,'-f','null','-']);
  const expected=expectedAssets(s), ledger=[];
  const fields={reference_image:'referenceImages',reference_audio:'referenceAudios',reference_video:'referenceVideos'};
  for(const [role,field] of Object.entries(fields)){
    const match=task.parts.filter(f=>f.field===field), wanted=expected.filter(f=>f.role===role);
    assert.equal(match.length,wanted.length);
    wanted.forEach((f,i)=>{
      assert.equal(match[i].sha256,f.sha256);assert.equal(match[i].mime,f.mime);
      ledger.push({field,ordinal:i+1,assetId:f.assetId,source:f.path,expectedSha256:f.sha256,receivedSha256:match[i].sha256,filename:match[i].name});
    });
  }
  assert.equal(new Set(ledger.map(v=>v.receivedSha256)).size,expected.length);
  const receivedForm=task.formEntries.map((v,i)=>({wireOrdinal:i+1,...v}));
  assert.deepEqual(receivedForm.filter(v=>v.mime).map(v=>[v.field,v.sha256]),ledger.map(v=>[v.field,v.expectedSha256]));
  assert.equal(receivedForm.find(v=>v.field==='prompt').sha256,digest(s.expected));
  const operation=await seedOperation(rootDir,entry.operationId);
  const plan=await readPlan(rootDir,operation.planId);
  const frozenBindings=plan.items.find(item=>item.requestHash===operation.requestHash).bindings;
  assert.deepEqual(frozenBindings.map(b=>[fields[b.role],b.ordinal,b.assetId,b.sha256]),
    ledger.map(f=>[f.field,f.ordinal,f.assetId,f.receivedSha256]));
  const wire={model:entry.model,segment:s.id,taskId:entry.taskId,sourcePrompt:s.prompt,sourcePromptSha256:digest(s.prompt),
    expectedPrompt:s.expected,receivedPrompt:task.receivedPrompt,receivedPromptSha256:task.promptSha256,
    receivedForm,ledger,frozenBindings,postsForTask:http.requests.filter(r=>r.method==='POST'&&r.taskId===entry.taskId).length,
    gets:http.requests.filter(r=>r.method==='GET'&&r.taskId===entry.taskId),output:{...output,path}};
  assert.equal(wire.postsForTask,1);assert(wire.gets.some(r=>r.route.endsWith('/content')));
  assert(wire.gets.some(r=>r.route.endsWith('/'+entry.taskId)));
  const proof=join(base,entry.segmentId+'-'+(low?'480p':'720p')+'-wire.json');
  await json(proof,wire);evidence.outputs.push({proof,segment:s.id,model:entry.model,taskId:entry.taskId,path,count:ledger.length});
}
async function video(episodeId,which,res) {
  const select=join(base,'select-'+episodeId+'-'+which.join('-')+'.json');
  await json(select,{schemaVersion:1,episodes:[{episodeId,segmentIds:which}]});
  return cmd(['video','run','--model',model(res),'--selection',select,'--confirm'],{code:null});
}
try {
  const {data:init}=await cmd(['init','--name','创作入口离线验收']);
  const skill=join(scripts,'seedance-skill.mjs'), packet=join(base,'creation-skill-packet.json');
  await json(packet,{entry:'yiciyuang2',intent:'prepare',message:'$yiciyuang2.5cli 按照末班车交接戏的完整剧本准备一个24秒分镜和12张项目参考图',root});
  await check('从创作入口原样触发进入剧本准备',async()=>{
    const selected=await cmd([packet],{program:skill,file:'creation-skill-response.json'});
    assert.deepEqual(selected.data,{status:'prepare_story'});
    assert.equal(postCount(),0);
  });
  await fixtures();
  await json(join(root,'profile.json'),ImageProfile.parse({boardSize:'1024x1024',firstFrameSize:'1024x1024',
    maxImageBytes:65536,maxResponseBytes:131072,maxTempBytes:128*1024*1024}));
  const core=segment('core24',24,order);
  const fractional=segment('fractional',23.2,[...order].reverse());
  const short=segment('s3',5,[order[0]]);
  const extras=[...sources.image.slice(12,30),...sources.audio.slice(0,10),...sources.video.slice(0,10)];
  const full=segment('s5',30,order,extras);
  const missing=segment('missing',5,[],[{...sources.image[30],path:'local-media/absent.png'}]);
  const good=[core,fractional,short,full];
  for(const s of good)http.expected.set(s.expected,{...s,assets:expectedAssets(s)});
  const coreEntry=await handoff('ep-core',[core]);
  const otherEntry=await handoff('ep-range',[fractional,short,full,missing]);
  await check('正式 images prepare 校验并导入整段剧本与图片配方',async()=>{
    const prepared=await prepare('legal',[coreEntry,otherEntry],init.projectId);
    assert.equal(prepared.exit,0,JSON.stringify(prepared.data));assert.equal(prepared.data.status,'ready');
    assert.deepEqual(prepared.data.importedEpisodes,['ep-core','ep-range']);
    const story=await loadStory(root);
    const actual=story.episodes[0].segments;
    assert.equal(actual.length,1);assert.equal(actual[0].duration,24);assert.equal(actual[0].prompt,core.prompt);
    assert.deepEqual(actual[0].references.map(r=>r.assetId),order.map(idFor));
    assert.equal((await fs.readFile(join(root,story.episodes[0].source.rawPath),'utf8')),core.original);
    const reused=await cmd(['images','prepare','--preparation',prepared.data.preparationId,'--python',python]);
    assert.equal(reused.data.planId,prepared.data.planId);assert.equal(postCount(),0);
    return {planId:prepared.data.planId,preparationId:prepared.data.preparationId};
  });
  if(evidence.tests.at(-1).passed){
    await check('正式登记十二张图并核对清单、原目标与缺文件',async()=>{
      for(const n of order){
        const hash=sources.image[n-1].sha256;
        await cmd(['assets','register','--id',idFor(n),'--file',join(samples,'image-'+n+'.png'),'--expected-sha256',hash]);
      }
      const coreCheck=await cmd(['seedance','checklist','--episode','ep-core'],{file:'core-checklist.json'});
      const coreRow=coreCheck.data.segments[0];assert.equal(coreRow.status,'ready');
      assert.deepEqual(coreRow.assets.map(a=>[a.assetId,a.ordinal,a.sha256]),order.map((n,i)=>[idFor(n),i+1,sources.image[n-1].sha256]));
      assert.equal(coreRow.counts.reference_image,12);
      const rangeCheck=await cmd(['seedance','checklist','--episode','ep-range'],{code:2,file:'range-checklist.json'});
      const [frac,,max,absent]=rangeCheck.data.segments;
      assert.equal(frac.duration,24);assert.equal(frac.targetDuration,23.2);
      assert.deepEqual([max.counts.reference_image,max.counts.reference_audio,max.counts.reference_video],[30,10,10]);
      assert.equal(absent.status,'blocked');assert.match(JSON.stringify(absent),/absent\.png/);
      assert.equal(postCount(),0);
    });
    for(const [name,episode,rows,res] of [
      ['核心24秒12张项目图','ep-core',[core],'720p'],['小数23.2秒','ep-range',[fractional],'480p'],
      ['480p 5秒与30秒50份混合素材','ep-range',[short,full],'480p'],
      ['720p 5秒与30秒50份混合素材','ep-range',[short,full],'720p']]){
      await check(name,async()=>{
        const before=postCount(),r=await video(episode,rows.map(s=>s.id),res);
        assert.equal(r.exit,0,JSON.stringify(r.data)+' '+http.errors.join(' '));assert.equal(postCount()-before,rows.length);
        assert.deepEqual(r.data.segments.map(s=>s.segmentId),rows.map(s=>s.id));
        for(const [i,s] of rows.entries())await validateClip(r.data.segments[i],s,root);
        return {batchId:r.data.batchId};
      });
    }
    await check('同批已选缺项与就绪分镜',async()=>{
      const before=postCount(),r=await video('ep-range',[missing.id,fractional.id],'720p');
      assert.equal(r.exit,2);
      assert.equal(postCount()-before,1);
      const ids=r.data.segments.map(row=>row.segmentId);
      assert.deepEqual(ids,[fractional.id,missing.id]);
      const ready=r.data.segments.find(row=>row.segmentId===fractional.id);
      const blocked=r.data.segments.find(row=>row.segmentId===missing.id);
      assert(!blocked.taskId);
      assert.match(JSON.stringify(blocked),/absent\.png/);
      await validateClip(ready,fractional,root);
      return {requested:[missing.id,fractional.id],returned:ids,blocked:blocked.segmentId,batchId:r.data.batchId};
    });
  }
  for(const [episode,s,pattern] of [
    ['invalid-images',segment('bad-images',5,order,sources.image.slice(12)),/reference_image 31, maximum 30/],
    ['invalid-audios',segment('bad-audios',5,[],sources.audio),/reference_audio 11, maximum 10/],
    ['invalid-videos',segment('bad-videos',5,[],sources.video),/reference_video 11, maximum 10/],
    ['invalid-short',segment('bad-short',4),/duration 4s, expected 5.30s/],
    ['invalid-long',segment('bad-long',31),/duration 31s, expected 5.30s/],
  ])await check(episode+' 在准备时定位超限',async()=>{
    const before=postCount(),entry=await handoff(episode,[s]),r=await prepare(episode,[entry],init.projectId);
    assert.notEqual(r.exit,0,JSON.stringify(r));
    const message=JSON.stringify(r.data.error);
    assert(message.includes(episode)&&message.includes(s.id),message);assert.match(message,pattern);
    assert.equal(postCount(),before);return {reason:r.data.error};
  });
  await check('无 seedance 的 H3 第10张图仍受原校验',async()=>{
    const e=await handoff('legacy-h3',[segment('legacy',10,order.slice(0,10))],{legacy:true});
    const r=await prepare('legacy',[e],init.projectId);assert.notEqual(r.exit,0);
    const validator=resolve(scripts,'../skills/metasocli-reference-images/scripts/validate_handoff.py');
    let diagnostic='';
    try {await run(python,['-X','utf8','-B',validator,'recipe',join(root,e.recipePath),'--request',join(root,e.requestPath),'--draft',join(root,e.draftPath)],{windowsHide:true});}
    catch(err) {assert.equal(typeof err.code,'number');diagnostic=err.stderr;}
    assert.match(diagnostic,/9|nine/iu);
    return {reason:r.data.error,python:diagnostic.trim()};
  });
  await check('30 张全部使用项目图片准备和登记',async()=>{
    const thirty=segment('project30',5,allProjectImages);
    const entry=await handoff('ep-project30',[thirty]);
    const prepared=await prepare('project30',[entry],init.projectId);
    assert.equal(prepared.exit,0,JSON.stringify(prepared.data));
    for(const n of allProjectImages.slice(12)){
      await cmd(['assets','register','--id',idFor(n),'--file',join(samples,'image-'+n+'.png'),'--expected-sha256',sources.image[n-1].sha256]);
    }
    const review=await cmd(['seedance','checklist','--episode',entry.episodeId]);
    assert.deepEqual(review.data.segments[0].assets.map(a=>a.assetId),allProjectImages.map(idFor));
    http.expected.set(thirty.expected,{...thirty,assets:expectedAssets(thirty)});
    const before=postCount(),result=await video(entry.episodeId,[thirty.id],'480p');
    assert.equal(result.exit,0,JSON.stringify(result.data));assert.equal(postCount()-before,1);
    await validateClip(result.data.segments[0],thirty,root);
    return {batchId:result.data.batchId,preparationId:prepared.data.preparationId};
  });
  await check('30 张已登记项目图复用、图片阶段收集和视频输入复核',async()=>{
    const episodeId='ep-project30',dir='.metasocli/drafts/'+episodeId;
    const story=await loadStory(root);
    const decisions=recipes.map(({assetId,kind})=>{
      const {media}=story.assets.find(a=>a.recipe.assetId===assetId);
      return {assetId,kind,status:'reused',generationPrompt:null,recipeSha256:null,existingRelativePath:media.path,contentSha256:media.sha256,reason:null};
    });
    const recipePath=dir+'/reused.json';
    await json(join(root,recipePath),{schemaVersion:'1.0.0',episodeId,assets:decisions});
    const entry={episodeId,draftPath:dir+'/draft.json',requestPath:dir+'/request.json',recipePath,replace:false};
    const prepared=await prepare('reuse-project30',[entry],init.projectId);
    assert.equal(prepared.exit,0,JSON.stringify(prepared.data));
    const before=http.requests.length;
    const run=await cmd(['images','run','--plan',prepared.data.planId,'--confirm']);
    assert.equal(run.data.summary.reused,30);
    assert.equal(run.data.run.status,'complete');
    assert(run.data.videoCheck.ok,JSON.stringify(run.data.videoCheck));
    assert.equal(run.data.videoCheck.segments[0].provider,'yiciyuang');
    assert.equal(run.data.videoCheck.segments[0].assets.length,30);
    const collection=await cmd(['images','collect','--preparation',prepared.data.preparationId,'--python',python],{file:'collected-project30.json'});
    assert.equal(collection.data.complete,true);assert.equal(http.requests.length,before);
    return {planId:prepared.data.planId,preparationId:prepared.data.preparationId,networkCalls:0};
  });
  assert.deepEqual(http.errors,[]);
}catch(err){evidence.fatal=String(err.stack);}
finally{
  await service.close();
  evidence.posts=postCount();evidence.realRequests=0;evidence.receiverErrors=http.errors;
  await json(join(base,'evidence.json'),evidence);
  console.log('Evidence: '+join(base,'evidence.json'));
}
if(evidence.fatal||evidence.tests.some(t=>!t.passed)){if(evidence.fatal)console.error(evidence.fatal);process.exitCode=1;}
