import { afterEach, expect, test } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cleanup } from './helpers.js';
import { workflowFixture } from './image-workflow-helpers.js';
import { prepareImages } from '../src/images/preparation.js';
import { collectImages, imageSummary } from '../src/images/reporting.js';
import { importStory, loadStory } from '../src/core/project.js';
import { createImagePlan } from '../src/images/planning.js';
import { readImagePlan } from '../src/images/store.js';
import { runImages, recoverImage } from '../src/images/run.js';
import { effectiveImageInput } from '../src/images/planning.js';
import { listImageJobs, readImageRun, saveImageRun } from '../src/images/store.js';
import { sha256Hex } from '../src/storage/canonical.js';
import { imageResponse, profile } from './image-api-helpers.js';
import { runCli } from '../src/cli/main.js';
afterEach(cleanup);

test('prepare output equals original import/plan; repeat and registered progression reuse exact IDs',async()=>{
  const f=await workflowFixture(),old=await workflowFixture();
  for(const entry of old.batch.entries){const draft=JSON.parse(await readFile(join(old.root,entry.draftPath),'utf8'));draft.source=resolve(old.root,draft.source);await importStory(old.root,draft);}
  const oldPlan=(await createImagePlan(old.root,{...old.batch.scope,profile})).plan;
  const prepared=await prepareImages(f.root,{batch:f.batchPath});
  const plan=await readImagePlan(f.root,prepared.planId!);
  expect((await loadStory(f.root)).episodes).toEqual((await loadStory(old.root)).episodes);
  expect((await loadStory(f.root)).assets).toEqual((await loadStory(old.root)).assets);
  // Only these random/project/time fields may differ; all item fingerprints and scopes must match.
  const stable=({planId,planHash,projectId,createdAt,...p}:typeof plan)=>p;
  expect(stable(plan)).toEqual(stable(oldPlan));
  expect(await effectiveImageInput(f.root,plan,plan.items[0]!,[],await loadStory(f.root)))
    .toEqual(await effectiveImageInput(old.root,oldPlan,oldPlan.items[0]!,[],await loadStory(old.root)));
  expect(await prepareImages(f.root,{batch:f.batchPath})).toMatchObject({preparationId:prepared.preparationId,planId:prepared.planId});
  let posts=0;await runImages(f.root,plan.planId,true,{runtimeRoot:join(f.root,'runtime'),client:{async create(){posts++;return imageResponse();}}});
  const before=await readFile(join(f.root,'metasocli.yaml'));
  expect(await prepareImages(f.root,{preparation:prepared.preparationId})).toMatchObject({planId:plan.planId});
  expect(await readFile(join(f.root,'metasocli.yaml'))).toEqual(before);expect(posts).toBe(2);
  const report=await collectImages(f.root,{preparation:prepared.preparationId});
  expect(report.complete).toBe(true);expect(report.episodes).toHaveLength(2);
  const result=JSON.parse(await readFile(join(f.root,report.episodes[0]!.resultPath!),'utf8'));
  expect(result.assets[0]).toMatchObject({status:'generated',recipeSha256:plan.items[0]!.promptHash,generationMode:'api',requestedModel:'gpt-image-2.5'});
  expect(result.assets[0].recipeSha256).not.toBe(plan.items[0]!.recipeHash);
  const again=await collectImages(f.root,{preparation:prepared.preparationId});expect(again.collectionId).not.toBe(report.collectionId);expect(posts).toBe(2);
},60000);

test('partial results preserve actual unknown/dependency status and collect never mutates jobs',async()=>{
  const f=await workflowFixture(1,2),p=await prepareImages(f.root,{batch:f.batchPath});
  let posts=0;await runImages(f.root,p.planId!,true,{runtimeRoot:join(f.root,'runtime'),client:{async create(){posts++;throw new Error('offline unknown');}}});
  const dir=join(f.root,'.metasocli/image-jobs'),files=await readdir(dir),before=await Promise.all(files.map(n=>readFile(join(dir,n))));
  const report=await collectImages(f.root,{preparation:p.preparationId});expect(report.complete).toBe(false);expect(report.episodes[0]!.resultPath).toBeNull();
  expect((await imageSummary(f.root,p.planId!)).counts.unknown).toBeGreaterThan(0);
  expect(await Promise.all(files.map(n=>readFile(join(dir,n))))).toEqual(before);expect(posts).toBeLessThanOrEqual(2);
},30000);

test('7 registered / 20 unknown / 2 dependent entries stay partial, unchanged and offline',async()=>{
  const f=await workflowFixture(1,29),entry=f.batch.entries[0]!;
  const draft=JSON.parse(await readFile(join(f.root,entry.draftPath),'utf8'));
  const request=JSON.parse(await readFile(join(f.root,entry.requestPath),'utf8'));
  draft.recipes[27].dependencies=['a7'];draft.recipes[28].dependencies=['a7'];
  request.assets[27].dependencyAssetIds=['a7'];request.assets[28].dependencyAssetIds=['a7'];request.assets[7].requiredBySegments.push('s27','s28');
  await writeFile(join(f.root,entry.draftPath),JSON.stringify(draft));await writeFile(join(f.root,entry.requestPath),JSON.stringify(request));
  const p=await prepareImages(f.root,{batch:f.batchPath});let posted=0,release!:()=>void;
  const gate=new Promise<void>(r=>release=r);
  const deps={runtimeRoot:join(f.root,'runtime'),client:{async create(_root:string,input:any){const n=Number((await readFile(join(f.root,input.promptPath),'utf8')).match(/人物图 (\d+)/)![1]);posted++;if(posted===27)release();await gate;if(n<7)return imageResponse(n);throw new Error('unknown');}}};
  await runImages(f.root,p.planId!,true,deps);
  const jobs=await listImageJobs(f.root),original=JSON.stringify(jobs),ledger=await readFile(join(f.root,'runtime/images/yiciyuang-default/ledger.json'));
  const report=await collectImages(f.root,{preparation:p.preparationId});
  expect(report.summary.counts).toMatchObject({total:29,registered:7,unknown:20,waitingDependency:2,failed:0});
  expect(report.episodes[0]!.resultPath).toBeNull();expect(report.summary.files).toHaveLength(7);
  expect(JSON.stringify(await listImageJobs(f.root))).toBe(original);expect(await readFile(join(f.root,'runtime/images/yiciyuang-default/ledger.json'))).toEqual(ledger);
  await prepareImages(f.root,{batch:f.batchPath});await runImages(f.root,p.planId!,false,deps);expect(posted).toBe(27);
},90000);

test('download failure collection does not GET; original recovery yields null reported model and detects changed evidence',async()=>{
  const f=await workflowFixture(1,1),p=await prepareImages(f.root,{batch:f.batchPath});let posts=0,gets=0;
  const deps={runtimeRoot:join(f.root,'runtime'),client:{async create(){posts++;return new Response(JSON.stringify({data:[{url:'https://example.test/result.png'}]}));}},fetcher:async()=>{gets++;throw new Error('download blocked');}};
  await runImages(f.root,p.planId!,true,deps);const before=gets;
  expect((await collectImages(f.root,{preparation:p.preparationId})).complete).toBe(false);expect(gets).toBe(before);
  const job=(await listImageJobs(f.root))[0]!;
  const {png}=await import('./helpers.js');
  expect((await recoverImage(f.root,job.operationId,{...deps,fetcher:async()=>new Response(png(1024,1024))})).status).toBe('registered');
  const report=await collectImages(f.root,{preparation:p.preparationId});
  const result=JSON.parse(await readFile(join(f.root,report.episodes[0]!.resultPath!),'utf8'));
  expect(result.assets[0].reportedModel).toBeNull();expect(result.assets[0].stagedRelativePath).toBe((await listImageJobs(f.root))[0]!.result!.path);expect(posts).toBe(1);
  const execution=join(f.root,result.assets[0].executionRelativePath),raw=await readFile(execution,'utf8');
  await writeFile(execution,raw.replace('"requestedModel": "gpt-image-2.5"','"requestedModel": "invented"'));
  await expect(collectImages(f.root,{preparation:p.preparationId})).rejects.toMatchObject({code:'IMAGE_HANDOFF_INVALID'});expect(posts).toBe(1);
},30000);

test('CLI prepare/collect are offline and strict; summary is optional and requires a plan',async()=>{
  const f=await workflowFixture(1,1);let network=0;
  const deps={client:{async create(){network++;throw new Error('forbidden');},async prepare(){network++;throw new Error('forbidden');}}};
  const result=await runCli(['images','prepare','--root',f.root,'--batch',f.batchPath],undefined,deps);expect(result.exitCode).toBe(0);
  const p=result.data as any;expect(network).toBe(0);
  expect((await runCli(['images','status','--root',f.root,'--summary'])).exitCode).toBe(1);
  const full=await runCli(['images','status','--root',f.root,'--plan',p.planId]);expect(full.data).toHaveProperty('items');
  const compact=await runCli(['images','status','--root',f.root,'--plan',p.planId,'--summary']);expect(compact.data).not.toHaveProperty('items');expect(compact.data).toHaveProperty('counts');
  const collected=await runCli(['images','collect','--root',f.root,'--preparation',p.preparationId],undefined,deps);expect(collected.exitCode).toBe(2);expect(network).toBe(0);
  await writeFile(f.batchPath,JSON.stringify({...f.batch,unexpected:true}));expect((await runCli(['images','prepare','--root',f.root,'--batch',f.batchPath])).exitCode).toBe(1);
},30000);

test('normalization shares original source, ordered dependencies, narration cues and decimal durations',async()=>{
  const f=await workflowFixture(1,3),entry=f.batch.entries[0]!;
  const draft=JSON.parse(await readFile(join(f.root,entry.draftPath),'utf8')),request=JSON.parse(await readFile(join(f.root,entry.requestPath),'utf8'));
  draft.segments[0].references=[{assetId:'a1',role:'reference_image'},{assetId:'a0',role:'reference_image'}];
  draft.recipes[1].dependencies=['a0'];request.assets[1].dependencyAssetIds=['a0'];
  request.assets[0].requiredBySegments=['s0','s1'];request.assets[1].requiredBySegments=['s0','s1'];
  draft.recipes.push({assetId:'voice',kind:'narration',prompt:'原旁白声线',dependencies:[],exactText:[]});
  draft.segments[0].narration={assetId:'voice',cues:[{start:0,end:2}]};draft.segments[1].narration=null;
  [12.378,6.666,6.963].forEach((d,i)=>draft.segments[i].duration=d);
  await writeFile(join(f.root,entry.draftPath),JSON.stringify(draft));await writeFile(join(f.root,entry.requestPath),JSON.stringify(request));
  const prepared=await prepareImages(f.root,{batch:f.batchPath}),story=await loadStory(f.root),segments=story.episodes[0]!.segments;
  expect(segments.map(s=>s.duration)).toEqual([13,7,7]);expect(segments.map(s=>s.targetDurationSeconds)).toEqual([12.378,6.666,6.963]);
  expect(segments[0]!.references).toEqual(draft.segments[0].references);expect(segments[0]!.narration).toEqual(draft.segments[0].narration);expect(segments[1]!.narration).toBeNull();
  const plan=await readImagePlan(f.root,prepared.planId!);expect(plan.items.map(i=>i.assetId)).toEqual(['a0','a1','a2']);expect(plan.items[1]!.dependencies).toEqual(['a0']);
  const before=await readFile(join(f.root,'metasocli.yaml'));await importStory(f.root,{...draft,source:resolve(f.root,draft.source)});expect(await readFile(join(f.root,'metasocli.yaml'))).toEqual(before);
});

test('collector resamples a moving run; it never rewrites execution or job evidence',async()=>{
  const f=await workflowFixture(1,1),p=await prepareImages(f.root,{batch:f.batchPath});
  await runImages(f.root,p.planId!,true,{runtimeRoot:join(f.root,'runtime'),client:{async create(){return imageResponse();}}});
  const job=(await listImageJobs(f.root))[0]!,file=join(f.root,`.metasocli/image-jobs/${job.operationId}.json`),before=await readFile(file);let moves=0;
  const report=await collectImages(f.root,{preparation:p.preparationId,checkpoint:async()=>{if(moves++===0){const plan=await readImagePlan(f.root,p.planId!),run=(await readImageRun(f.root,plan))!;await saveImageRun(f.root,run);}}});
  expect(moves).toBe(2);expect(report.complete).toBe(true);expect(await readFile(file)).toEqual(before);
});
