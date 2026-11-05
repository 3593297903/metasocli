import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, png } from './helpers.js';
import { workflowFixture } from './image-workflow-helpers.js';
import { prepareImages } from '../src/images/preparation.js';
import { collectImages } from '../src/images/reporting.js';
import { readImagePlan, listImageJobs } from '../src/images/store.js';
import { runImages, recoverImage } from '../src/images/run.js';
import { createImagePlan } from '../src/images/planning.js';
import { YicImageClient } from '../src/images/client.js';
import { loadStory } from '../src/core/project.js';
import { registerAsset } from '../src/assets/registry.js';
import { wav } from './audio-fixtures.js';
import { imageResponse, profile } from './image-api-helpers.js';
import { sha256Hex } from '../src/storage/canonical.js';

afterEach(cleanup);
const execute = promisify(execFile), packageRoot = fileURLToPath(new URL('../', import.meta.url));
const script = join(packageRoot, 'skills/metasocli-reference-images/scripts/append_asset_denoise.py');
const kinds = ['character', 'scene', 'prop'] as const;
const entries = ['metasoclitk', 'metasocli-video-prompts', 'metasocli-video-prompts-旁白'];
const json = async (path:string) => JSON.parse(await readFile(path, 'utf8'));

for (const entrySkill of entries) test(`${entrySkill}: exact final prompts survive prepare/jobs and JSON + file-backed multipart`, async () => {
  const f = await workflowFixture(1, 6), entry = f.batch.entries[0]!;
  // Honor the unchanged jianc template's actual 1920x1088 specification.
  await writeFile(join(f.root,'profile.json'),JSON.stringify({...profile,boardSize:'1920x1088'}));
  const draft = await json(join(f.root, entry.draftPath));
  const request = await json(join(f.root, entry.requestPath));
  const recipe = await json(join(f.root, entry.recipePath));
  const inputs = [], texts:Record<string,string> = {};
  for (const kind of kinds) texts[kind] = await readFile(join(packageRoot, `skills/metasocli-reference-images/references/denoise/${kind}.txt`), 'utf8');
  for (let n = 0; n < 6; n++) {
    const kind = kinds[n % 3]!, id = `a${n}`, dependencies = n < 3 ? [] : ['a1', 'a0'];
    const templateEntry = entrySkill === 'metasoclitk' ? entrySkill : 'metasocli-reference-images';
    const base = `完整事实🙂 ${id}，资料标题，横板；参考角色与尺寸说明在尾段之前。\n` + await readFile(join(packageRoot, `skills/${templateEntry}/references/${kind}-board.md`), 'utf8');
    inputs.push({assetId:id, kind, prompt:base});
    Object.assign(draft.recipes[n], {kind, dependencies, exactText:['资料标题']});
    Object.assign(request.assets[n], {kind, dependencyAssetIds:dependencies, exactText:['资料标题']});
    recipe.assets[n].kind = kind;
  }
  request.assets[0].requiredBySegments = ['s0', 's3', 's4', 's5'];
  request.assets[1].requiredBySegments = ['s1', 's3', 's4', 's5'];
  if (entrySkill.endsWith('旁白')) {
    draft.recipes.push({assetId:'voice', kind:'narration', prompt:'原旁白声线', exactText:[], dependencies:[]});
    draft.segments[0].narration = {assetId:'voice', cues:[{start:0,end:2}]};
  }
  const segmentsBefore = structuredClone(draft.segments), requestBefore = structuredClone(request);
  const inputPath = join(f.root, 'new-recipes.json'), outputPath = join(f.root, 'final-prompts.json');
  await writeFile(inputPath, JSON.stringify({schemaVersion:1, entrySkill, items:inputs}));
  const inputBytes = await readFile(inputPath);
  await execute('python', ['-X','utf8','-B',script,'compose','--input',inputPath,'--output',outputPath], {windowsHide:true});
  await execute('python', ['-X','utf8','-B',script,'check','--input',outputPath], {windowsHide:true});
  const output = await json(outputPath);
  expect(await readFile(inputPath)).toEqual(inputBytes);
  for (let n = 0; n < 6; n++) {
    const final = output.items[n];
    expect(final.prompt).toBe(inputs[n]!.prompt.replace(/^\uFEFF/u,'').replace(/\r\n?/gu,'\n') + '\n\n' + texts[inputs[n]!.kind]);
    expect(final.recipeSha256).toBe(sha256Hex(final.prompt));
    draft.recipes[n].prompt = final.prompt;
    Object.assign(recipe.assets[n], {generationPrompt:final.prompt, recipeSha256:final.recipeSha256});
  }
  for (const [path, value] of [[entry.draftPath, draft], [entry.requestPath, request], [entry.recipePath, recipe]] as const) await writeFile(join(f.root, path), JSON.stringify(value));
  if (entrySkill === 'metasoclitk') {
    await expect(prepareImages(f.root, {batch:f.batchPath, checkpoint:async point => {if (point === 'plan-saved') throw new Error('denoise test interruption');}})).rejects.toThrow('denoise test interruption');
  }
  const prepared = await prepareImages(f.root, {batch:f.batchPath});
  const plan = await readImagePlan(f.root, prepared.planId!);
  expect((await prepareImages(f.root, {preparation:prepared.preparationId})).planId).toBe(plan.planId);
  expect(await listImageJobs(f.root)).toEqual([]);
  expect(plan.profile.submissionMode).toBe('all-ready');
  const storyBeforeRun = await loadStory(f.root);
  expect(storyBeforeRun.episodes[0]!.segments.map(s => s.prompt)).toEqual(Array(6).fill(f.text));
  expect(storyBeforeRun.episodes[0]!.segments.map(s => s.references)).toEqual(segmentsBefore.map((s:any) => s.references));
  if (entrySkill.endsWith('旁白')) {
    const audio = join(f.root, 'voice.wav'); await writeFile(audio, wav());
    await registerAsset(f.root, 'voice', {file:audio});
    expect((await loadStory(f.root)).episodes[0]!.segments[0]!.narration).toEqual(segmentsBefore[0].narration);
  }
  const voiceBefore = (await loadStory(f.root)).assets.find(a => a.recipe.assetId === 'voice');
  if (entrySkill.endsWith('旁白')) expect(voiceBefore?.media?.mime).toBe('audio/wav');
  const captured:any[] = [];
  const client = new YicImageClient('offline-fake-key', async (url, init) => {
    const multipart = init!.body instanceof FormData;
    const fields = multipart ? Object.fromEntries((init!.body as FormData).entries()) : JSON.parse(String(init!.body));
    const n = output.items.findIndex((item:any) => item.prompt === fields.prompt);
    expect(n).toBeGreaterThanOrEqual(0);
    const item = plan.items[n]!, kind = kinds[n % 3]!;
    expect(multipart).toBe(n >= 3);
    expect(String(url).endsWith(n >= 3 ? '/edits' : '/generations')).toBe(true);
    expect(fields.prompt).toBe(output.items[n].prompt);
    expect(fields.prompt.endsWith(texts[kind])).toBe(true);
    for (const other of kinds) expect(fields.prompt.split(texts[other]).length - 1).toBe(Number(other === kind));
    expect(fields.model).toBe('gpt-image-2.5'); expect(String(fields.n)).toBe('1');
    const files = multipart ? (init!.body as FormData).getAll('image[]') as File[] : [];
    if (multipart) {
      expect(files.map(file => file.name)).toEqual(['a1.png', 'a0.png']);
      expect(await Promise.all(files.map(async file => sha256Hex(Buffer.from(await file.arrayBuffer()))))).toEqual([sha256Hex(png(1920,1088,1)),sha256Hex(png(1920,1088,0))]);
    }
    captured.push({assetId:item.assetId, kind, transport:multipart?'multipart':'json', prompt:fields.prompt,
      promptHash:sha256Hex(fields.prompt), references:files.map(file=>file.name)});
    return new Response(JSON.stringify({data:[{b64_json:png(1920,1088,n).toString('base64')}]}));
  });
  const deps = {client, runtimeRoot:join(f.root,'runtime')};
  await runImages(f.root, plan.planId, true, deps);
  expect(captured).toHaveLength(6);
  const jobs = await listImageJobs(f.root);
  for (const item of plan.items) {
    const expected = output.items.find((row:any) => row.assetId === item.assetId);
    expect(await readFile(join(f.root, item.promptPath), 'utf8')).toBe(expected.prompt);
    expect(item.promptHash).toBe(expected.recipeSha256);
    expect(item.recipeHash).not.toBe(item.promptHash);
    const job = jobs.find(j => j.assetId === item.assetId)!;
    expect(job.status).toBe('registered'); expect(job.input!.promptHash).toBe(item.promptHash);
    expect(job.input!.promptPath).toBe(item.promptPath);
    expect(job.input!.references.map(r => r.assetId)).toEqual(item.dependencies);
  }
  expect((await loadStory(f.root)).assets.find(a=>a.recipe.assetId==='voice')).toEqual(voiceBefore);
  expect(await json(join(f.root,entry.requestPath))).toEqual(requestBefore);
  await runImages(f.root, plan.planId, false, deps);
  for (const job of jobs) await recoverImage(f.root,job.operationId,deps);
  expect(captured).toHaveLength(6);
  expect((await listImageJobs(f.root)).map(j=>j.operationId)).toEqual(jobs.map(j=>j.operationId));
  expect((await collectImages(f.root, {preparation:prepared.preparationId})).complete).toBe(true);
  if (process.env.METASO_TEST_EVIDENCE_DIR) {
    const dir = join(process.env.METASO_TEST_EVIDENCE_DIR,'denoise'); await mkdir(dir,{recursive:true});
    await writeFile(join(dir,`${entrySkill}.json`),JSON.stringify({entrySkill,planId:plan.planId,preparationId:prepared.preparationId,
      jobIds:jobs.map(j=>j.operationId),posts:captured.length,recoveryPosts:0,captured},null,2));
  }
}, 90000);

test('old no-tail ready assets and frozen unknown plans remain unchanged with zero recovery POST',async()=>{
  const ready = await workflowFixture(1,1), entry = ready.batch.entries[0]!;
  const p = await prepareImages(ready.root,{batch:ready.batchPath});
  let posts = 0;
  const deps = {runtimeRoot:join(ready.root,'runtime'),client:{async create(){posts++;return imageResponse();}}};
  await runImages(ready.root,p.planId!,true,deps);
  const before = await readFile(join(ready.root,'metasocli.yaml'));
  const originalRecipe = await readFile(join(ready.root,entry.recipePath));
  const reuse = (await createImagePlan(ready.root,{episodes:['ep-1'],profile})).plan;
  expect(reuse.items[0]!.action).toBe('reuse');
  await runImages(ready.root,reuse.planId,true,deps);
  expect(posts).toBe(1); expect(await readFile(join(ready.root,'metasocli.yaml'))).toEqual(before);
  expect(await readFile(join(ready.root,entry.recipePath))).toEqual(originalRecipe);
  expect(await readFile(join(ready.root,reuse.items[0]!.promptPath),'utf8')).toBe(ready.recipes[0]!.prompt);
  const unknown = await workflowFixture(1,1), up = await prepareImages(unknown.root,{batch:unknown.batchPath});
  const frozen = await readImagePlan(unknown.root,up.planId!); let unknownPosts = 0;
  const unknownDeps = {runtimeRoot:join(unknown.root,'runtime'),client:{async create(){unknownPosts++;throw new Error('offline lost response');}}};
  await runImages(unknown.root,frozen.planId,true,unknownDeps);
  const job = (await listImageJobs(unknown.root))[0]!;
  expect(job.status).toBe('submit_unknown');
  await prepareImages(unknown.root,{preparation:up.preparationId});
  await runImages(unknown.root,frozen.planId,false,unknownDeps);
  await recoverImage(unknown.root,job.operationId,unknownDeps);
  expect(unknownPosts).toBe(1); expect(await readImagePlan(unknown.root,frozen.planId)).toEqual(frozen);
  expect((await listImageJobs(unknown.root))[0]).toMatchObject({operationId:job.operationId,status:'submit_unknown',input:job.input});
  expect(await readFile(join(unknown.root,frozen.items[0]!.promptPath),'utf8')).toBe(unknown.recipes[0]!.prompt);
},45000);
