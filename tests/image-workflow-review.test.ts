import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cleanup, png } from './helpers.js';
import { workflowFixture } from './image-workflow-helpers.js';
import { prepareImages, readPreparation } from '../src/images/preparation.js';
import { imageSummary, collectImages } from '../src/images/reporting.js';
import { createImagePlan } from '../src/images/planning.js';
import { importStory, loadStory } from '../src/core/project.js';
import { runImages } from '../src/images/run.js';
import { listImageJobs, readImagePlan, readImageRun, saveImageJob, saveImageRun } from '../src/images/store.js';
import { canonicalSha256, sha256Hex } from '../src/storage/canonical.js';
import { profile, imageResponse } from './image-api-helpers.js';
import { registerAsset } from '../src/assets/registry.js';
afterEach(cleanup);
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const save=async(path:string,value:unknown)=>writeFile(path,JSON.stringify(value));
const seal=(value:any)=>{const {hash,...base}=value;return {...base,hash:canonicalSha256(base)};};
async function evidence(name:string,value:unknown){
  if(!process.env.METASO_TEST_EVIDENCE_DIR)return;
  const dir=join(process.env.METASO_TEST_EVIDENCE_DIR,'workflow-review');await mkdir(dir,{recursive:true});await save(join(dir,name+'.json'),value);
}
async function inherit(f:Awaited<ReturnType<typeof workflowFixture>>,n=0){
  const entry=f.batch.entries[n]!,draft=await json(join(f.root,entry.draftPath));
  await importStory(f.root,{...draft,source:resolve(f.root,draft.source)});return {entry,draft};
}
async function decision(f:Awaited<ReturnType<typeof workflowFixture>>,n:number,id:string,status:string){
  const e=f.batch.entries[n]!,recipe=await json(join(f.root,e.recipePath)),draft=await json(join(f.root,e.draftPath));
  Object.assign(recipe.assets.find((a:any)=>a.assetId===id),{status,generationPrompt:null,recipeSha256:null,reason:status==='blocked'?'服装冲突，未确定':null});
  draft.recipes=draft.recipes.filter((a:any)=>a.assetId!==id);
  await save(join(f.root,e.recipePath),recipe);await save(join(f.root,e.draftPath),draft);
}
test('review blocked inherited recipe cannot reach fake create; snapshots survive',async()=>{
  const f=await workflowFixture(1,1);await inherit(f);await decision(f,0,'a0','blocked');let posts=0;
  const create=async()=>{posts++;return imageResponse();};
  let error:any;try{const p=await prepareImages(f.root,{batch:f.batchPath});await runImages(f.root,p.planId!,true,{client:{create},runtimeRoot:join(f.root,'runtime')});}catch(e){error=e;}
  expect(posts).toBe(0);expect(error).toMatchObject({code:'IMAGE_PREPARATION_BLOCKED'});expect(error.message).toContain('a0');expect(error.message).toContain('服装冲突');
  expect(await listImageJobs(f.root)).toHaveLength(0);
  const dirs=(await readdir(join(f.root,'.metasocli/image-preparations'))).filter(n=>n!=='by-input');expect(dirs).toHaveLength(1);
  expect((await readPreparation(f.root,dirs[0]!)).entries).toHaveLength(1);
  await evidence('blocked',{fakeOnly:true,posts,error:{code:error.code,message:error.message},snapshots:dirs});
},30000);

async function unknownFixture(){
  const f=await workflowFixture(1,1);await inherit(f);
  const old=(await createImagePlan(f.root,{...f.batch.scope,profile})).plan;let posts=0;
  const deps={runtimeRoot:join(f.root,'runtime'),client:{async create(){posts++;throw new Error('offline lost response');}}};
  await runImages(f.root,old.planId,true,deps);const job=(await listImageJobs(f.root))[0]!;
  const p=await prepareImages(f.root,{batch:f.batchPath});
  return {f,old,job,p,deps,posts:()=>posts};
}
test('review recover without run projects original unknown in summary and collect; zero extra POST',async()=>{
  const {f,job,p,deps,posts}=await unknownFixture(),before=await readFile(join(f.root,`.metasocli/image-jobs/${job.operationId}.json`));
  expect(await readImageRun(f.root,await readImagePlan(f.root,p.planId!))).toBeUndefined();
  const network=vi.fn(async()=>{throw new Error('read paths cannot network');});vi.stubGlobal('fetch',network);
  const summary=await imageSummary(f.root,p.planId!);
  expect(summary.counts).toMatchObject({unknown:1,notStarted:0});expect(summary.blockers).toContain('current_project_unknown');expect(summary.issues[0]?.operationId).toBe(job.operationId);
  const report=await collectImages(f.root,{preparation:p.preparationId});expect(report.complete).toBe(false);expect(report.episodes[0]!.resultPath).toBeNull();
  expect(report.episodes[0]!.items[0]).toMatchObject({operationId:job.operationId,status:'submit_unknown'});expect(report.summary.counts).toEqual(summary.counts);
  expect(network).not.toHaveBeenCalled();expect(await readFile(join(f.root,`.metasocli/image-jobs/${job.operationId}.json`))).toEqual(before);
  await expect(runImages(f.root,p.planId!,true,deps)).rejects.toMatchObject({code:'IMAGE_STAGE_ACTIVE'});expect(posts()).toBe(1);
  await evidence('recover-unknown',{fakeOnly:true,operationId:job.operationId,originalPlan:job.planId,newPlan:p.planId,summary:summary.counts,blockers:summary.blockers,collection:report.episodes,totalPosts:posts(),extraPosts:0,readNetwork:network.mock.calls.length});
},30000);

async function splitFixture(){
  const f=await workflowFixture(2,1),e=f.batch.entries[1]!;
  for(const path of [e.draftPath,e.requestPath,e.recipePath])await writeFile(join(f.root,path),(await readFile(join(f.root,path),'utf8')).replaceAll('a0','b0'));
  const a=join(f.root,'a.json'),b=join(f.root,'b.json');
  await save(a,{...f.batch,entries:[f.batch.entries[0]],scope:{episodes:['ep-1']}});await save(b,{...f.batch,entries:[f.batch.entries[1]],scope:{episodes:['ep-2']}});
  const p=await prepareImages(f.root,{batch:a}),input=await readPreparation(f.root,p.preparationId);return {f,a,b,p,input};
}
test('review unrelated trusted metadata avoids corrupted old contents; new scope remains independent',async()=>{
  const {f,b,input,p}=await splitFixture();await writeFile(join(f.root,input.entries[0]!.source.path),'damaged old content');
  const next=await prepareImages(f.root,{batch:b});expect(next.planId).not.toBe(p.planId);
  expect((await readImagePlan(f.root,next.planId!)).items.map(i=>i.assetId)).toEqual(['b0']);expect(await listImageJobs(f.root)).toHaveLength(0);
  await evidence('unrelated',{oldPlan:p.planId,newPlan:next.planId,oldScope:'ep-1/a0',newScope:'ep-2/b0',oldContentCorrupt:true,jobs:0});
},30000);

test('selected skipped_optional cannot generate an inherited recipe',async()=>{
  const f=await workflowFixture(1,1),{entry,draft}=await inherit(f);await decision(f,0,'a0','skipped_optional');
  const request=await json(join(f.root,entry.requestPath));Object.assign(request.assets[0],{required:false,requiredBySegments:[]});
  draft.recipes=[];draft.segments[0].references=[];await save(join(f.root,entry.draftPath),draft);await save(join(f.root,entry.requestPath),request);
  await save(f.batchPath,{...f.batch,entries:[{...entry,replace:true}],scope:{assets:['a0']}});
  await expect(prepareImages(f.root,{batch:f.batchPath})).rejects.toMatchObject({code:'IMAGE_HANDOFF_CONFLICT'});expect(await listImageJobs(f.root)).toHaveLength(0);
});
test('required skipped_optional is rejected without deleting the reference',async()=>{
  const f=await workflowFixture(1,1);await inherit(f);await decision(f,0,'a0','skipped_optional');const before=await readFile(join(f.root,'metasocli.yaml'));
  await expect(prepareImages(f.root,{batch:f.batchPath})).rejects.toMatchObject({code:'IMAGE_HANDOFF_INVALID'});
  expect(await readFile(join(f.root,'metasocli.yaml'))).toEqual(before);expect(await listImageJobs(f.root)).toHaveLength(0);
});
test('out of scope blocked asset does not veto independent selected planned asset',async()=>{
  const f=await workflowFixture(1,2);await inherit(f);await decision(f,0,'a1','blocked');await save(f.batchPath,{...f.batch,scope:{assets:['a0']}});
  const p=await prepareImages(f.root,{batch:f.batchPath});expect((await readImagePlan(f.root,p.planId!)).items.map(i=>[i.assetId,i.action])).toEqual([['a0','generate']]);
});
test('shared asset decisions conflict before importing any episode',async()=>{
  const f=await workflowFixture(2,1);await decision(f,1,'a0','blocked');
  await expect(prepareImages(f.root,{batch:f.batchPath})).rejects.toMatchObject({code:'IMAGE_HANDOFF_CONFLICT'});
  expect((await loadStory(f.root)).episodes).toHaveLength(0);expect(await listImageJobs(f.root)).toHaveLength(0);
});
test('reused decision retains identity and byte checks; normal preparation repeats the same IDs',async()=>{
  const f=await workflowFixture(1,1),{entry}=await inherit(f),file=join(f.root,'test.png');await writeFile(file,png(1024,1024));await registerAsset(f.root,'a0',{file,provenance:'user'});
  const media=(await loadStory(f.root)).assets[0]!.media!,recipe=await json(join(f.root,entry.recipePath));
  Object.assign(recipe.assets[0],{status:'reused',generationPrompt:null,recipeSha256:null,existingRelativePath:media.path,contentSha256:media.sha256});await save(join(f.root,entry.recipePath),recipe);
  const p=await prepareImages(f.root,{batch:f.batchPath}),q=await prepareImages(f.root,{batch:f.batchPath});expect(q).toMatchObject({preparationId:p.preparationId,planId:p.planId});
  expect((await readImagePlan(f.root,p.planId!)).items[0]!.action).toBe('reuse');expect((await collectImages(f.root,{preparation:p.preparationId})).complete).toBe(true);
  await writeFile(join(f.root,media.path),'changed');await expect(prepareImages(f.root,{preparation:p.preparationId})).rejects.toMatchObject({code:'IMAGE_PREPARATION_STALE'});
});

// Construct the exact old, internally hash-consistent record shape in a synthetic story.
// The old preparer allowed blocked inherited recipes and persisted these intents.
async function legacyBlocked(intentOnly:boolean){
  const f=await workflowFixture(1,1),p=await prepareImages(f.root,{batch:f.batchPath}),input=await json(join(f.root,p.recordPath,'input.json')),entry=input.entries[0];
  const draft=await json(join(f.root,entry.draft.path));draft.recipes=[];await save(join(f.root,entry.draft.path),draft);
  const recipe=await json(join(f.root,entry.recipe.path));Object.assign(recipe.assets[0],{status:'blocked',generationPrompt:null,recipeSha256:null,reason:'服装冲突，未确定'});await save(join(f.root,entry.recipe.path),recipe);
  for(const kind of ['recipe','draft'])entry[kind].sha256=sha256Hex(await readFile(join(f.root,entry[kind].path)));
  input.contentFingerprint=canonicalSha256({projectId:input.projectId,scope:input.scope,profile:input.profile,entries:input.entries.map((e:any)=>({episodeId:e.episodeId,replace:e.replace,draftHash:e.draft.sha256,requestHash:e.request.sha256,recipeHash:e.recipe.sha256,sourceHash:e.source.sha256,sourceBasename:e.sourceBasename}))});
  input.inputFingerprint=canonicalSha256({contentFingerprint:input.contentFingerprint,validatorHash:input.validatorHash,workflowVersion:input.workflowVersion});
  const sealed=seal(input);await save(join(f.root,p.recordPath,'input.json'),sealed);
  const state=await json(join(f.root,p.recordPath,'state.json'));state.inputHash=sealed.hash;
  if(intentOnly){state.status='preparing';state.planHash=null;await rm(join(f.root,`.metasocli/image-plans/${p.planId}.json`));}
  await save(join(f.root,p.recordPath,'state.json'),seal(state));
  const path=join(f.root,p.recordPath,'plan-intent.json'),intent=await json(path);intent.inputHash=sealed.hash;intent.inputFingerprint=sealed.inputFingerprint;await save(path,seal(intent));
  return {f,p,path};
}
for(const intentOnly of [true,false])test(`legacy blocked ${intentOnly?'intent only':'ready plan'} is rejected despite matching validatedBy`,async()=>{
  const {f,p,path}=await legacyBlocked(intentOnly),before=await readFile(path);
  await expect(prepareImages(f.root,{preparation:p.preparationId})).rejects.toMatchObject({code:'IMAGE_PREPARATION_BLOCKED'});
  expect(await readFile(path)).toEqual(before);expect(await listImageJobs(f.root)).toHaveLength(0);
});
for(const [status,count] of [['response_saved','responseSaved'],['received','pendingDownload'],['downloaded','pendingRegistration']] as const)test(`recover no run preserves original ${status} in both read paths`,async()=>{
  const {f,p,job,old,posts}=await unknownFixture();job.status=status;delete job.error;await saveImageJob(f.root,job);
  const summary=await imageSummary(f.root,p.planId!);expect(summary.counts[count]).toBe(1);expect(summary.timing.items[0]).toMatchObject({operationId:job.operationId});
  const report=await collectImages(f.root,{preparation:p.preparationId});expect(report.summary.counts).toEqual(summary.counts);expect(report.episodes[0]!.items[0]).toMatchObject({status,operationId:job.operationId});expect(report.complete).toBe(false);
  expect((await listImageJobs(f.root))[0]!.planId).toBe(old.planId);expect(posts()).toBe(1);
});
test('missing recover record produces an explicit error in summary and collect',async()=>{
  const {f,p,job}=await unknownFixture();await rm(join(f.root,`.metasocli/image-jobs/${job.operationId}.json`));
  await expect(imageSummary(f.root,p.planId!)).rejects.toMatchObject({code:'IMAGE_JOB_MISSING'});
  await expect(collectImages(f.root,{preparation:p.preparationId})).rejects.toMatchObject({code:'IMAGE_JOB_MISSING'});
});
test('recover source fingerprint mismatch is rejected instead of notStarted',async()=>{
  const {f,p}=await unknownFixture(),plan=await readImagePlan(f.root,p.planId!);plan.items[0]!.fingerprint='a'.repeat(64);
  const {planHash,...base}=plan;await save(join(f.root,`.metasocli/image-plans/${plan.planId}.json`),{...base,planHash:canonicalSha256(base)});
  await expect(imageSummary(f.root,p.planId!)).rejects.toMatchObject({code:'IMAGE_JOB_CONFLICT'});
});
test('current run operation takes precedence over frozen recover operation',async()=>{
  const {f,p,job}=await unknownFixture(),plan=await readImagePlan(f.root,p.planId!);
  const replacement={...job,operationId:crypto.randomUUID(),status:'received' as const};await saveImageJob(f.root,replacement);
  await saveImageRun(f.root,{schemaVersion:1,planId:plan.planId,planHash:plan.planHash,hash:'a'.repeat(64),authorization:{planHash:plan.planHash,provider:plan.profile.provider,quotaGroup:plan.profile.quotaGroup,maxRequests:0,authorizedAt:new Date().toISOString()},items:[{assetId:job.assetId,operationId:replacement.operationId}],unlocks:[],status:'running',updatedAt:new Date().toISOString()});
  const summary=await imageSummary(f.root,p.planId!);expect(summary.counts).toMatchObject({pendingDownload:1,unknown:0});
  const report=await collectImages(f.root,{preparation:p.preparationId});expect(report.episodes[0]!.items[0]!.operationId).toBe(replacement.operationId);expect(report.summary.counts).toEqual(summary.counts);
});
test('collect watches source recover job and resamples rather than mixing stages',async()=>{
  const {f,p,job}=await unknownFixture();let samples=0;
  const report=await collectImages(f.root,{preparation:p.preparationId,checkpoint:async()=>{if(samples++===0){job.status='response_saved';delete job.error;await saveImageJob(f.root,job);}}});
  expect(samples).toBe(2);expect(report.episodes[0]!.items[0]!.status).toBe('response_saved');expect(report.summary.counts.responseSaved).toBe(1);expect(report.complete).toBe(false);
});
for(const mode of ['matching','explicit','metadata'] as const)test(`corrupt ${mode} preparation remains rejected`,async()=>{
  const {f,a,b,input,p}=await splitFixture();
  if(mode==='metadata'){const file=join(f.root,p.recordPath,'input.json');const bad=await json(file);bad.contentFingerprint='b'.repeat(64);await save(file,seal(bad));}
  else await writeFile(join(f.root,input.entries[0]!.source.path),'corrupt');
  const options=mode==='explicit'?{preparation:p.preparationId}:{batch:mode==='metadata'?b:a};
  await expect(prepareImages(f.root,options)).rejects.toMatchObject({code:'IMAGE_PREPARATION_TAMPERED'});expect(await listImageJobs(f.root)).toHaveLength(0);
});
test('a valid source job for another asset cannot be claimed by recover summary or collect',async()=>{
  const f=await workflowFixture(1,2);await inherit(f);const old=(await createImagePlan(f.root,{...f.batch.scope,profile})).plan;
  await runImages(f.root,old.planId,true,{runtimeRoot:join(f.root,'runtime'),client:{async create(){throw new Error('offline unknown');}}});
  const p=await prepareImages(f.root,{batch:f.batchPath}),plan=await readImagePlan(f.root,p.planId!),foreign=(await listImageJobs(f.root)).find(j=>j.assetId==='a1')!;
  plan.items[0]!.operationId=foreign.operationId;const {planHash,...base}=plan;plan.planHash=canonicalSha256(base);
  await save(join(f.root,`.metasocli/image-plans/${plan.planId}.json`),plan);
  const intentPath=join(f.root,p.recordPath,'plan-intent.json'),intent=await json(intentPath);intent.plan=plan;await save(intentPath,seal(intent));
  const statePath=join(f.root,p.recordPath,'state.json'),state=await json(statePath);state.planHash=plan.planHash;await save(statePath,seal(state));
  await expect(imageSummary(f.root,plan.planId)).rejects.toMatchObject({code:'IMAGE_JOB_CONFLICT'});
  await expect(collectImages(f.root,{preparation:p.preparationId})).rejects.toMatchObject({code:'IMAGE_JOB_CONFLICT'});
});
