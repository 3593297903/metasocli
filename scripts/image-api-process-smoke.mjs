// Offline process recovery: no credential access and no provider traffic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, appendFile, rm, realpath } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { initializeStory, importStory, loadStory } from '../dist/core/project.js';
import { createImagePlan } from '../dist/images/planning.js';
import { runImages, recoverImage } from '../dist/images/run.js';
import { listImageJobs, readImageRun } from '../dist/images/store.js';
import { ImageProfile } from '../dist/images/contracts.js';
import { acquireImageScheduler, imageRuntime } from '../dist/images/coordinator.js';
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const profile=ImageProfile.parse({boardSize:'1024x1024',maxResponseBytes:131072,maxImageBytes:65536,maxTempBytes:10485760});
function png(){function chunk(name,data){const body=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;for(const n of body){crc^=n;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;}const h=Buffer.alloc(13);h.writeUInt32BE(1024);h.writeUInt32BE(1024,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc(1024*(1024*3+1)))),chunk('IEND',Buffer.alloc(0))]);}
const pause=async(point)=>{process.send?.({checkpoint:point});await new Promise(()=>{setInterval(()=>{},1000);});};
if(process.argv[2]==='worker'){
  const [, , ,root,id,point,runtime]=process.argv;
  if(point==='owner'){const lease=await acquireImageScheduler(profile,runtime);await pause(point);await lease.release();}
  else await runImages(root,id,true,{runtimeRoot:runtime,client:{async create(){await appendFile(join(root,'posts.txt'),'POST\n');if(point==='post')await pause(point);
    if(point==='partial-response')return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"data":['));}}));
    return new Response(JSON.stringify({data:[{url:'https://offline.example/image.png'}]}));}},
    fetcher:async()=>new Response(png()),checkpoint:async(p,job)=>{if(p===point||(point==='partial-prepared'&&p==='job-reserved'&&job.assetId==='second'))await pause(point);},onResponseChunk:()=>{if(point==='partial-response')void pause(point);}});
}else{
  const temp=join(packageRoot,'.work/image-api-20260924/tmp');await mkdir(temp,{recursive:true});const base=await mkdtemp(join(temp,'image-process-'));
  const evidence=[];
  async function worker(root,id,point,runtime){
    const env={...process.env,PATH:dirname(process.execPath),USERPROFILE:join(base,'home'),HOME:join(base,'home'),TMP:temp,TEMP:temp};delete env.METASO_API_KEY;delete env.METASOCLI_IMAGE_API_KEY;delete env.METASO_RUNTIME_DIR;
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'worker',root,id,point,runtime],{cwd:base,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    let stderr='';child.stderr.on('data',d=>{stderr+=d;});const exit=new Promise(r=>child.once('exit',r));
    try{await new Promise((ok,bad)=>{const timeout=setTimeout(()=>bad(Error('Checkpoint timeout '+point+' '+stderr)),30000);child.once('message',m=>{clearTimeout(timeout);assert.equal(m.checkpoint,point);ok();});child.once('error',e=>{clearTimeout(timeout);bad(e);});child.once('exit',()=>{clearTimeout(timeout);bad(Error('Early exit '+stderr));});});}
    catch(e){child.kill('SIGKILL');await exit;throw e;}
    return {child,exit};
  }
  try{
    await mkdir(join(base,'home'));
    for(const point of ['prepared','intent','post','response-before','partial-response','response-saved','receipt-saved','download-before','download-saved','register-before','register-saved']){
      const root=join(base,point),runtime=join(base,'runtime-'+point),source=join(base,point+'.txt');await writeFile(source,'完整原文。');await initializeStory(root,point);
      await importStory(root,{episodeId:'ep-1',kind:'video-prompts',source,recipes:[{assetId:'lead',kind:'character',prompt:'完整图片提示词'}],segments:[{id:'s1',start:0,end:5,duration:6,references:[{assetId:'lead',role:'reference_image'}]}]});
      const {plan}=await createImagePlan(root,{episodes:['ep-1'],profile});const {child,exit}=await worker(root,plan.planId,point,runtime);child.kill('SIGKILL');await exit;
      const original=(await listImageJobs(root))[0],before=(await readFile(join(root,'posts.txt'),'utf8').catch(()=>'' )).split('\n').filter(Boolean).length;
      let newPosts=0;const deps={runtimeRoot:runtime,client:{async create(){newPosts++;return new Response(JSON.stringify({data:[{b64_json:png().toString('base64')}]}));}},fetcher:async()=>new Response(png())};
      const recovered=await runImages(root,plan.planId,false,deps),job=(await listImageJobs(root))[0];assert.equal(job.operationId,original.operationId);
      const unknown=['intent','post','response-before','partial-response'].includes(point);assert.equal(job.status,unknown?'submit_unknown':'registered');assert.equal(newPosts,point==='prepared'?1:0);assert.equal(before+newPosts,point==='intent'?0:1);
      const revision=(await loadStory(root)).revision;await recoverImage(root,job.operationId,deps);await runImages(root,plan.planId,false,deps);assert.equal((await loadStory(root)).revision,revision);assert.equal(newPosts,point==='prepared'?1:0);
      evidence.push({point,originalOperationId:original.operationId,recoveredOperationId:job.operationId,before,newPosts,totalPosts:before+newPosts,status:job.status});console.log(`PASS SIGKILL ${point}: original operation retained, ${before+newPosts} total POST, ${job.status}`);
    }
    {
      const point='partial-prepared',root=join(base,point),runtime=join(base,'runtime-'+point),source=join(base,point+'.txt');
      await writeFile(source,'完整原文。');await initializeStory(root,point);
      await importStory(root,{episodeId:'ep-1',kind:'video-prompts',source,recipes:['first','second'].map(assetId=>({assetId,kind:'character',prompt:assetId+' 完整图片提示词'})),
        segments:[{id:'s1',start:0,end:5,duration:6,references:['first','second'].map(assetId=>({assetId,role:'reference_image'}))}]});
      const {plan}=await createImagePlan(root,{episodes:['ep-1'],profile}),{child,exit}=await worker(root,plan.planId,point,runtime);child.kill('SIGKILL');await exit;
      const saved=await listImageJobs(root),original=await readImageRun(root,plan),before=(await readFile(join(root,'posts.txt'),'utf8').catch(()=>'' )).split('\n').filter(Boolean).length;
      assert.equal(saved.length,1);assert.equal(saved[0].status,'prepared');assert.equal(before,0);
      assert.equal(JSON.parse(await readFile(join(imageRuntime(profile,runtime),'ledger.json'),'utf8')).slots.length,0);
      const posts=[],deps={runtimeRoot:runtime,client:{async create(_root,input){posts.push((await readFile(join(root,input.promptPath),'utf8')).split(' ')[0]);return new Response(JSON.stringify({data:[{b64_json:png().toString('base64')}]}));}}};
      assert.equal((await runImages(root,plan.planId,false,deps)).summary.registered,2);const recovered=await listImageJobs(root);
      for(const row of original.items){const job=recovered.find(j=>j.assetId===row.assetId);assert.equal(job.operationId,row.operationId);assert.equal(job.attempt,1);assert.equal(job.status,'registered');}
      await runImages(root,plan.planId,false,deps);assert.deepEqual(posts,['first','second']);
      evidence.push({point,before,ledgerBefore:0,reserved:original.items,recovered:recovered.map(({assetId,operationId,attempt,status})=>({assetId,operationId,attempt,status})),posts,resumeExtraPosts:0});
      console.log('PASS SIGKILL partial-prepared: two reserved IDs retained, 0 historical POST, 1 first POST per asset, 0 repeat POST');
    }
    const runtime=join(base,'contention'),{child,exit}=await worker(base,'unused','owner',runtime);
    try{await assert.rejects(acquireImageScheduler(profile,runtime),{code:'LOCK_BUSY'});}finally{child.kill('SIGKILL');await exit;}
    const owner=await acquireImageScheduler(profile,runtime);await owner.release();evidence.push({point:'two-process-quota',contender:'LOCK_BUSY',deadOwnerReclaimed:true});console.log('PASS two-process quota ownership; dead process recovered without dropping unresolved records');
    await writeFile(join(packageRoot,'.work/image-api-20260924/process-evidence.json'),JSON.stringify({offline:true,cases:evidence},null,2));
  }finally{const actual=await realpath(base),parent=await realpath(temp),rel=relative(parent,actual);if(isAbsolute(rel)||rel.startsWith('..')||!rel.startsWith('image-process-'))throw Error('Unsafe cleanup');await rm(actual,{recursive:true,force:true});}
}
