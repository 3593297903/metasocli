import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanup, png } from './helpers.js';
import { imageFixture, imageResponse, profile } from './image-api-helpers.js';
import { createImagePlan, loadImageProfile } from '../src/images/planning.js';
import { attachImageResult, recoverImage, resolveImage, runImages, imageStatus } from '../src/images/run.js';
import { listImageJobs } from '../src/images/store.js';
import { YicImageClient } from '../src/images/client.js';
import { registerAsset } from '../src/assets/registry.js';
import { loadStory } from '../src/core/project.js';
import { createPlan } from '../src/core/planning.js';
import { sha256Hex } from '../src/storage/canonical.js';
import { runCli } from '../src/cli/main.js';
import { acquireImageScheduler, imageRuntime } from '../src/images/coordinator.js';
import { DiskBudget, Semaphore, streamResponse } from '../src/images/stream.js';
import { imageCredentialStatus, loadImageApiKey, saveImageApiKey } from '../src/images/credentials.js';
import { importStory } from '../src/core/project.js';
import { checkImageVideoInputs } from '../src/images/run.js';
import { wav } from './audio-fixtures.js';
import { writeJson } from '../src/storage/io.js';
import { fail } from '../src/core/errors.js';
import { submit } from '../src/jobs/submit.js';
import { resume } from '../src/jobs/resume.js';
import { acquireVideoStage } from '../src/images/phase.js';
import { runBatch } from '../src/jobs/batch.js';
import { createBatchPlan } from '../src/jobs/batch-store.js';
afterEach(cleanup);
const planFor=async(root:string,overrides={})=>(await createImagePlan(root,{episodes:['ep-1'],profile:{...profile,...overrides},submissionMode:'all-ready'})).plan;
it('public CLI plans without credentials, requires authorization, registers, and resumes without POST',async()=>{
  const f=await imageFixture(),config=join(dirname(f.root),'profile.json');await writeFile(config,JSON.stringify(profile));
  const p=await runCli(['images','plan','--root',f.root,'--episodes','ep-1','--profile',config,'--submission-mode','all-ready']);expect(p.exitCode).toBe(0);const id=(p.data as any).plan.planId;
  let posts=0;const deps={client:{async create(){posts++;return imageResponse();}}};
  expect((await runCli(['images','run','--root',f.root,'--plan',id],undefined,deps)).exitCode).toBe(1);expect(posts).toBe(0);
  expect((await runCli(['images','run','--root',f.root,'--plan',id,'--confirm'],undefined,deps)).exitCode).toBe(0);expect(posts).toBe(1);
  const job=(await listImageJobs(f.root))[0]!;const revision=(await loadStory(f.root)).revision;
  await runCli(['images','recover','--root',f.root,'--operation',job.operationId],undefined,deps);
  await runCli(['images','resume','--root',f.root,'--plan',id],undefined,deps);expect(posts).toBe(1);expect((await loadStory(f.root)).revision).toBe(revision);
  expect((await imageStatus(f.root,id)).videoCheck).toMatchObject({ok:true});
  expect((await createPlan(f.root,'ep-1')).segments[0]).toMatchObject({duration:7,targetDurationSeconds:6.666,contextIr:true});
});
it('reuses ready assets; excludes unused and narration; detects frozen recipe/size/capacity conflicts before POST',async()=>{
  const f=await imageFixture(2),file=join(dirname(f.root),'ready.png');await writeFile(file,png(1024,1024));await registerAsset(f.root,f.ids[0]!,{file});
  const p=await planFor(f.root);expect(p.items.map(i=>i.action)).toEqual(['reuse','generate']);
  let posts=0;await expect(runImages(f.root,(await planFor(f.root,{providerLimits:{concurrent:1,source:'offline limit fixture',checkedAt:new Date().toISOString()}})).planId,true,{client:{async create(){posts++;return imageResponse();}}})).resolves.toMatchObject({summary:{reused:1,registered:1}});
  expect(posts).toBe(1);expect((await planFor(f.root)).items.every(i=>i.action==='reuse')).toBe(true);
  const g=await imageFixture(2),limited=await planFor(g.root,{providerLimits:{rpm:1,source:'offline',checkedAt:new Date().toISOString()}});
  await expect(runImages(g.root,limited.planId,true,{client:{async create(){posts++;return imageResponse();}}})).rejects.toMatchObject({code:'IMAGE_PROVIDER_LIMIT'});expect(posts).toBe(1);
  await expect(createImagePlan(g.root,{assets:g.ids,profile:{model:'other'}})).rejects.toMatchObject({code:'INVALID_INPUT'});
  const gp=await planFor(g.root);await writeFile(join(g.root,gp.items[0]!.promptPath),'shortened');await expect(runImages(g.root,gp.planId,true)).rejects.toMatchObject({code:'IMAGE_PLAN_STALE'});
});
it('unlocks real ordered edits without waiting for unrelated slow generation; references are actual file-backed multipart',async()=>{
  const f=await imageFixture(4,{'asset-003':['asset-001','asset-000']}),plan=await planFor(f.root),calls:string[]=[],forms:string[][]=[];
  let releaseSlow!:(r:Response)=>void;const slow=new Promise<Response>(r=>{releaseSlow=r;});
  const client=new YicImageClient('fake-image-key',async(url,init)=>{
    if(String(url).endsWith('/edits')){const form=init!.body as FormData;const files=form.getAll('images') as File[];forms.push(files.map(x=>x.name));expect(form.get('image')).toBeNull();
      expect(await files[0]!.arrayBuffer().then(b=>sha256Hex(Buffer.from(b)))).toBe(sha256Hex(png(1024,1024,1)));
      expect(await files[1]!.arrayBuffer().then(b=>sha256Hex(Buffer.from(b)))).toBe(sha256Hex(png(1024,1024,0)));calls.push('edit');releaseSlow(imageResponse(2));return imageResponse(3);}
    const value=JSON.parse(init!.body as string),id=value.prompt.split(' ')[0];calls.push(id);if(id==='asset-002')return slow;return imageResponse(Number(id.slice(-3)));
  });
  const result=await runImages(f.root,plan.planId,true,{client});expect(result.summary.registered).toBe(4);expect(calls).toHaveLength(4);expect(forms).toEqual([['asset-001.png','asset-000.png']]);expect(result.run?.unlocks.map(u=>u.dependency)).toEqual(['asset-001','asset-000']);
  const edit=(await listImageJobs(f.root)).find(j=>j.assetId==='asset-003')!;expect(edit.input?.references.map(r=>r.assetId)).toEqual(['asset-001','asset-000']);
},30000);
it.each([401,402,403,429,500])('HTTP %s stops unstarted requests and drains already running successes',async(status)=>{
  const f=await imageFixture(5),plan=await planFor(f.root);let posts=0,finishFirst!:(r:Response)=>void;
  const client={async create(){posts++;if(posts===1)return new Promise<Response>(r=>{finishFirst=r;});finishFirst(imageResponse());return new Response('{"error":"no"}',{status,headers:{'Retry-After':'17'}});}};
  const result=await runImages(f.root,plan.planId,true,{client});expect(posts).toBeLessThan(5);expect(result.summary.registered).toBe(1);expect(result.summary[status===500?'unknown':'rejected']).toBe(posts-1);
  const job=(await listImageJobs(f.root)).find(j=>j.status===(status===500?'submit_unknown':'rejected'))!;
  expect(JSON.parse(await readFile(join(f.root,`.metasocli/image-receipts/${job.operationId}/complete.json`),'utf8')).headers['retry-after']).toBe('17');
  if(status===500){const before=posts;await runImages(f.root,plan.planId,false,{client});expect(posts).toBe(before);await expect(runImages(f.root,plan.planId,true,{client},job.operationId)).rejects.toMatchObject({code:'IMAGE_RETRY_FORBIDDEN'});}
});
it.each(['{"data":[]}','not json','{"data":[{"b64_json":"invalid"}]}'])('preserves malformed successful responses and never resends (%s)',async(body)=>{
  const f=await imageFixture(),p=await planFor(f.root);let posts=0;const client={async create(){posts++;return new Response(body);}};
  expect((await runImages(f.root,p.planId,true,{client})).summary.unknown).toBe(1);await runImages(f.root,p.planId,false,{client});expect(posts).toBe(1);
});
it('URL receipt survives expired download; recovered bytes register without sending API credentials or POST',async()=>{
  const f=await imageFixture(),p=await planFor(f.root);let posts=0;
  const result=await runImages(f.root,p.planId,true,{client:{async create(){posts++;return new Response(JSON.stringify({data:[{url:'https://cdn.example.com/out.png?sig=secret'}]}));}},fetcher:async(_url,init)=>{expect(init?.headers).toBeUndefined();return new Response('',{status:403});}});
  expect(result.items[0]).toMatchObject({status:'received',error:{code:'IMAGE_DOWNLOAD_FAILED'}});
  const id=(await listImageJobs(f.root))[0]!.operationId;expect((await recoverImage(f.root,id,{fetcher:async()=>new Response(png(1024,1024))})).status).toBe('registered');expect(posts).toBe(1);
  const story=await loadStory(f.root),managed=join(f.root,story.assets[0]!.media!.path);await unlink(managed);expect(await recoverImage(f.root,id)).toMatchObject({status:'registered'});expect(sha256Hex(await readFile(managed))).toBe(sha256Hex(png(1024,1024)));expect((await loadStory(f.root)).revision).toBe(story.revision);
});
it('user-selected target is preserved; returned image remains superseded evidence',async()=>{
  const f=await imageFixture(),p=await planFor(f.root),file=join(dirname(f.root),'user.png');await writeFile(file,png(1024,1024,99));
  const r=await runImages(f.root,p.planId,true,{client:{async create(){await registerAsset(f.root,f.ids[0]!,{file});return imageResponse();}}});
  expect(r.items[0]).toMatchObject({status:'superseded',result:{sha256:sha256Hex(png(1024,1024))}});expect((await loadStory(f.root)).assets[0]!.media?.sha256).toBe(sha256Hex(png(1024,1024,99)));
});
it('unknown can only be linked to the original result or explicitly resolved with request-bound provider evidence',async()=>{
  const f=await imageFixture(),p=await planFor(f.root);let posts=0;const client={async create(){posts++;throw Error('offline connection lost');}};
  await runImages(f.root,p.planId,true,{client});const job=(await listImageJobs(f.root))[0]!;
  await expect(resolveImage(f.root,job.operationId,'not-created',{},true)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(createPlan(f.root,'ep-1')).rejects.toMatchObject({code:'IMAGE_STAGE_ACTIVE'});
  const evidence={operationId:job.operationId,requestHash:job.requestHash,outcome:'not-created',source:{kind:'provider-support',reference:'offline-ticket',statement:'Explicit fake provider confirmation of non-creation.'}};
  await resolveImage(f.root,job.operationId,'not-created',evidence,true);
  const retry=await runImages(f.root,p.planId,true,{client:{async create(){posts++;return imageResponse();}}},job.operationId);expect(retry.summary.registered).toBe(1);expect(posts).toBe(2);
  const jobs=await listImageJobs(f.root);expect(jobs[1]).toMatchObject({retryOf:job.operationId,attempt:2});
  const g=await imageFixture(),gp=await planFor(g.root);await runImages(g.root,gp.planId,true,{client});const unknown=(await listImageJobs(g.root))[0]!,file=join(dirname(g.root),'original.png');await writeFile(file,png(1024,1024));
  await expect(attachImageResult(g.root,unknown.operationId,file,sha256Hex(png(1024,1024)),false)).rejects.toMatchObject({code:'IMAGE_RESULT_LINK_REQUIRED'});
  expect(await attachImageResult(g.root,unknown.operationId,file,sha256Hex(png(1024,1024)),true)).toMatchObject({status:'registered',recoveredManually:true});
});
it('restores a reserved retry before its job write with the same operation and new-attempt evidence',async()=>{
  const f=await imageFixture(),p=await planFor(f.root);let posts=0;
  await runImages(f.root,p.planId,true,{client:{async create(){posts++;return new Response('{}',{status:429});}}});const original=(await listImageJobs(f.root))[0]!;
  let reserved='';await expect(runImages(f.root,p.planId,true,{client:{async create(){posts++;return imageResponse();}},checkpoint:async(point,job)=>{if(point==='job-reserved'){reserved=job.operationId;throw Error('crash before job/ledger write');}}},original.operationId)).rejects.toThrow();expect(posts).toBe(1);
  await runImages(f.root,p.planId,false,{client:{async create(){posts++;return imageResponse();}}});const recovered=(await listImageJobs(f.root)).find(j=>j.operationId===reserved)!;expect(recovered).toMatchObject({status:'registered',attempt:2,retryOf:original.operationId});expect(posts).toBe(2);
});
it('independent quota owner refuses another scheduler and terminal history uses no video ledger',async()=>{
  const f=await imageFixture(),p=await planFor(f.root),lease=await acquireImageScheduler(p.profile);
  try{await expect(runImages(f.root,p.planId,true)).rejects.toMatchObject({code:'LOCK_BUSY'});}finally{await lease.release();}
  await runImages(f.root,p.planId,true,{client:{async create(){return imageResponse();}}});
  expect(await readFile(join(imageRuntime(profile),'ledger.json'),'utf8')).not.toContain('MiniMax');
});
it('image/video starts check the same project transaction; existing video IDs still query during image stage',async()=>{
  const f=await imageFixture(),p=await planFor(f.root),lease=await acquireVideoStage(f.root);let images=0;
  try{await expect(runImages(f.root,p.planId,true,{client:{async create(){images++;return imageResponse();}}})).rejects.toMatchObject({code:'VIDEO_STAGE_ACTIVE'});}finally{await lease.release();}expect(images).toBe(0);
  await runImages(f.root,p.planId,true,{client:{async create(){return imageResponse();}}});const videoPlan=await createPlan(f.root,'ep-1');let videos=0;
  const evidence={sha256:sha256Hex('{}'),response:{}},video={async create(){videos++;return {taskId:'original-video',evidence};},async query(taskId:string){return {taskId,status:'running' as const,rawStatus:'running',evidence};}};
  const job=await submit(f.root,videoPlan.planId,'s0',true,{client:video});
  const {plan:batch}=await createBatchPlan(f.root,{episodes:['ep-1'],concurrency:4});await runBatch(f.root,batch.batchId,true,{client:video},{maxPolls:1,pollIntervalMs:0});
  const source=join(dirname(f.root),'other.txt');await writeFile(source,'另一个镜头。');await importStory(f.root,{episodeId:'ep-2',kind:'video-prompts',source,recipes:[{assetId:'other',kind:'scene',prompt:'完整场景'}],segments:[{id:'s2',start:0,end:6,duration:6,references:[{assetId:'other',role:'reference_image'}]}]});
  const next=(await createImagePlan(f.root,{episodes:['ep-2'],profile})).plan;
  const result=await runImages(f.root,next.planId,true,{client:{async create(){await expect(createPlan(f.root,'ep-1')).rejects.toMatchObject({code:'IMAGE_STAGE_ACTIVE'});
    expect((await resume(f.root,job.operationId,{client:video},{maxPolls:1,download:false,observeOnly:true})).taskId).toBe('original-video');
    const recovered=await runBatch(f.root,batch.batchId,false,{client:video},{maxPolls:1,pollIntervalMs:0});expect(recovered.run?.trace.some(t=>t.event==='image-stage-pause')).toBe(true);return imageResponse();}}});
  expect(result.summary.registered).toBe(1);expect(videos).toBe(1);
});
it('documented defaults remain landscape boards/portrait first frames; high specifications require explicit compatible size',async()=>{
  const f=await imageFixture(),source=join(dirname(f.root),'first.txt');await writeFile(source,'开场镜头。');
  await importStory(f.root,{episodeId:'first',kind:'video-prompts',source,recipes:[{assetId:'frame',kind:'first_frame',prompt:'完整首帧 4K'}],segments:[{id:'first',start:0,end:5,duration:12.378,references:[{assetId:'frame',role:'first_frame'}]}]});
  const board=await createImagePlan(f.root,{episodes:['ep-1'],profile:{}});expect(board.plan.items[0]?.size).toBe('1920x1088');
  const conflict=await createImagePlan(f.root,{episodes:['first'],profile:{}});expect(conflict.plan.items[0]).toMatchObject({size:'1088x1920',action:'blocked'});
  const explicit=await createImagePlan(f.root,{episodes:['first'],profile:{sizes:{frame:'4096x4096'}}});expect(explicit.plan.items[0]).toMatchObject({size:'4096x4096',action:'generate'});
});
it('per-response and total disk limits retain incomplete evidence and release locks; known shortage sends nothing',async()=>{
  const f=await imageFixture(),p=await planFor(f.root,{maxTempBytes:1000});let posts=0;await expect(runImages(f.root,p.planId,true,{client:{async create(){posts++;return imageResponse();}}})).rejects.toMatchObject({code:'IMAGE_STORAGE_LIMIT'});expect(posts).toBe(0);
  const lease=await acquireImageScheduler(profile);await lease.release();
  const path=join(dirname(f.root),'response.bin');await expect(streamResponse(new Response('x'.repeat(2048)),path,1024,new DiskBudget(99999))).rejects.toMatchObject({code:'IMAGE_RESPONSE_LIMIT'});
  await expect(streamResponse(new Response('x'.repeat(2048)),path,4096,new DiskBudget(1000))).rejects.toMatchObject({code:'IMAGE_STORAGE_LIMIT'});
  let active=0,max=0;const sem=new Semaphore(2);await Promise.all(Array.from({length:10},()=>sem.use(async()=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,2));active--;})));expect(max).toBe(2);
});
it('image environment credentials ignore video key and reject unapproved profile origin',async()=>{
  const f=await imageFixture(),file=join(dirname(f.root),'none.json');
  expect(await imageCredentialStatus({env:{METASO_API_KEY:'video-key'},file})).toMatchObject({configured:false});
  expect(await loadImageApiKey({env:{METASOCLI_IMAGE_API_KEY:'independent-key',METASO_API_KEY:'video-key'},file})).toBe('independent-key');
  await writeFile(file,JSON.stringify({origin:'https://other.example'}));await expect(loadImageProfile(file)).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it.skipIf(process.platform!=='win32')('stores only origin-bound DPAPI image ciphertext and leaves video credentials unchanged',async()=>{
  const f=await imageFixture(),file=join(dirname(f.root),'image-credentials.json'),video=join(dirname(f.root),'metaso-credentials.json');await writeFile(video,'video-sentinel');
  await saveImageApiKey('offline-image-key',file);expect(await readFile(file,'utf8')).not.toContain('offline-image-key');expect(await loadImageApiKey({file,env:{}})).toBe('offline-image-key');expect(await readFile(video,'utf8')).toBe('video-sentinel');
  const record=JSON.parse(await readFile(file,'utf8'));record.origin='https://wrong.example';await writeFile(file,JSON.stringify(record));await expect(loadImageApiKey({file,env:{}})).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
});
it('single-image edits use image; changed dependency never overwrites returned evidence',async()=>{
  const f=await imageFixture(2,{'asset-001':['asset-000']}),p=await planFor(f.root),file=join(dirname(f.root),'new.png');await writeFile(file,png(1024,1024,8));let edits=0;
  const client=new YicImageClient('test-key',async(url,init)=>{if(String(url).endsWith('/edits')){edits++;const form=init!.body as FormData;expect(form.get('image')).toBeInstanceOf(File);expect(form.getAll('images')).toHaveLength(0);await registerAsset(f.root,'asset-000',{file});return imageResponse(1);}return imageResponse();});
  const result=await runImages(f.root,p.planId,true,{client});expect(edits).toBe(1);expect(result.items[1]).toMatchObject({status:'superseded',error:{code:'IMAGE_DEPENDENCY_CHANGED'}});
});
it('a response persistence failure preserves other already sent successes and stops new requests',async()=>{
  const f=await imageFixture(6),p=await planFor(f.root);let posts=0,first!:(r:Response)=>void;
  const result=await runImages(f.root,p.planId,true,{client:{async create(){posts++;if(posts===1)return new Promise<Response>(r=>{first=r;});first(imageResponse());return imageResponse(2);}},checkpoint:async(point,job)=>{if(point==='response-before'&&job.assetId==='asset-001')fail('IMAGE_STORAGE_LIMIT','Injected offline disk failure');}});
  expect(result.summary.registered).toBeGreaterThanOrEqual(1);expect(result.summary.unknown).toBe(1);expect(posts).toBeLessThan(6);
});
it.each([['empty',Buffer.from('')],['invalid',Buffer.from('no image')],['dimensions',png(128,128)],['wrong requested size',png(512,512)]])('technical media rejection is explicit (%s) without changing the prompt',async(_name,bytes)=>{
  const f=await imageFixture(),p=await planFor(f.root);const r=await runImages(f.root,p.planId,true,{client:{async create(){return new Response(JSON.stringify({data:[{b64_json:(bytes as Buffer).toString('base64')}]}));}}});
  expect(['failed','submit_unknown']).toContain((r.items[0] as any).status);expect(r.summary.registered).toBe(0);expect((await loadStory(f.root)).assets[0]!.recipe.prompt).toContain('第二行');
});
it('oversize response/decoded image and structured JSON stay independently bounded',async()=>{
  const f=await imageFixture(),p=await planFor(f.root,{maxResponseBytes:1024,maxImageBytes:1024});let posts=0;
  const r=await runImages(f.root,p.planId,true,{client:{async create(){posts++;return new Response('x'.repeat(2048));}}});expect(r.summary.unknown).toBe(1);expect(posts).toBe(1);
  await expect(writeJson(join(dirname(f.root),'huge.json'),{x:'x'.repeat(8*1024*1024)})).rejects.toBeDefined();
});
it('streams an actual 45 MiB boundary with 64 KiB chunks and retains partial evidence without a complete marker',async()=>{
  const f=await imageFixture(),parent=dirname(f.root),target=join(parent,'boundary.bin');let emitted=0,cancelled=false;
  const response=new Response(new ReadableStream<Uint8Array>({pull(controller){emitted++;controller.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}}));
  await expect(streamResponse(response,target,45*1024*1024,new DiskBudget(50*1024*1024))).rejects.toMatchObject({code:'IMAGE_RESPONSE_LIMIT'});
  expect(cancelled).toBe(true);expect(emitted).toBeLessThan(730);const partial=(await readdir(parent)).find(n=>n.startsWith('boundary.bin.part-'))!;expect((await stat(join(parent,partial))).size).toBe(45*1024*1024);expect((await readdir(parent))).not.toContain('boundary.bin');
},30000);
it('H3 checks actual nine-reference composition and narration overhead; no shrinking or reference deletion',async()=>{
  const f=await imageFixture(9),source=join(dirname(f.root),'narration.txt'),text='旁白：河流向前。';await writeFile(source,text);
  await importStory(f.root,{episodeId:'ep-voice',kind:'video-prompts',source,recipes:[{assetId:'voice',kind:'narration',prompt:'原旁白参考'}],segments:[{id:'s1',start:0,end:text.length,duration:6.963,references:f.ids.map(assetId=>({assetId,role:'reference_image'})),narration:{assetId:'voice',cues:[{start:3,end:text.length}]}}]});
  const img=join(dirname(f.root),'small.png'),audio=join(dirname(f.root),'voice.wav');await writeFile(img,png(1024,1024));await writeFile(audio,wav());for(const id of f.ids)await registerAsset(f.root,id,{file:img});await registerAsset(f.root,'voice',{file:audio});
  const p=(await createImagePlan(f.root,{episodes:['ep-voice'],profile})).plan;expect(p.items).toHaveLength(9);expect(p.items.every(i=>i.kind!=='narration')).toBe(true);
  expect(await checkImageVideoInputs(f.root,p)).toMatchObject({ok:true,segments:[{assets:expect.arrayContaining([expect.objectContaining({assetId:'voice',role:'reference_audio'})])}]});
  // A PNG ancillary chunk is legitimate payload; two large files exceed the encoded H3 budget.
  const original=png(1024,1024),data=Buffer.alloc(25*1024*1024),kind=Buffer.from('tEXt'),chunk=Buffer.alloc(data.length+12);chunk.writeUInt32BE(data.length);kind.copy(chunk,4);data.copy(chunk,8);
  let crc=0xffffffff;for(const n of chunk.subarray(4,-4)){crc^=n;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  await writeFile(img,Buffer.concat([original.subarray(0,-12),chunk,original.subarray(-12)]));for(const id of f.ids.slice(0,2))await registerAsset(f.root,id,{file:img});
  const fullProfile={...profile,maxImageBytes:30*1024*1024},large=(await createImagePlan(f.root,{episodes:['ep-voice'],profile:fullProfile})).plan;
  const check=await checkImageVideoInputs(f.root,large);expect(check).toMatchObject({ok:false,segments:[{episodeId:'ep-voice',segmentId:'s1',assetIds:f.ids,error:{code:'REQUEST_LIMIT'}}]});
  expect((await loadStory(f.root)).episodes.find(e=>e.id==='ep-voice')!.segments[0]).toMatchObject({prompt:text,duration:7,targetDurationSeconds:6.963});
},30000);
