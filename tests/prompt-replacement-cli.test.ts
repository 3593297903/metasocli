import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile, stat, open, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanup } from './helpers.js';
import { replacementFixture, selected, files } from './prompt-replacement-fixture.js';
import { loadStory } from '../src/core/project.js';
import { sha256Hex } from '../src/storage/canonical.js';
import { createPlan } from '../src/core/planning.js';
import { submit } from '../src/jobs/submit.js';
import { imageFixture, profile } from './image-api-helpers.js';
import { createImagePlan } from '../src/images/planning.js';
import { runImages } from '../src/images/run.js';
import { listImageJobs } from '../src/images/store.js';
import { evidence } from './batch-helpers.js';
const exec=promisify(execFile),cli=resolve('dist/cli/main.js'),doc='docs/PROMPT_REPLACEMENT.md';
afterEach(cleanup);

async function envFor(root:string,suffix=''){
  const audit=join(dirname(root),'prompt-audit'+suffix+'.jsonl');
  return {audit,env:{...process.env,METASO_API_KEY:'',METASOCLI_IMAGE_API_KEY:'',METASO_RUNTIME_DIR:join(dirname(root),'runtime'),PROMPT_TEST_AUDIT:audit,
    NODE_OPTIONS:[process.env.NODE_OPTIONS,'--import='+pathToFileURL(resolve('scripts/prompt-replacement-test-guard.mjs')).href].filter(Boolean).join(' ')}};
}
async function observations(audit:string){return (await readFile(audit,'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));}

test.each([[6,11,5],[27,152,526]])('documented one-call real CLI (%i episodes, %i segments, %i assets)',async(episodes,count,assets)=>{
  const began=performance.now(),f=await replacementFixture(episodes,count,assets),story=await loadStory(f.root);
  const episodeId=episodes===6?'ep-3':'ep-16',segmentId='s2',s=story.episodes.find(e=>e.id===episodeId)!.segments[1]!;
  const file=await selected(f.root,Buffer.from('\uFEFF场景新增。\r\n'+s.prompt.replace(/\n/g,'\r\n'))),inputHash=sha256Hex(await readFile(file));
  const before=await files(f.root),{env,audit}=await envFor(f.root);
  const setupMs=performance.now()-began;
  let code=await readFile(doc,'utf8');const example=code.match(/^\x60{3}powershell\r?\n([\s\S]*?)^\x60{3}/m)?.[1];expect(example).toBeTruthy();
  const script=join(dirname(f.root),'replace.ps1');
  await writeFile(script,["$nodeExe=$env:P_NODE; $installRoot=$env:P_INSTALL; $storyRoot=$env:P_ROOT; $episodeId=$env:P_EP; $segmentId='s2'; $selectedPromptFile=$env:P_FILE; $expectedPromptHash=$env:P_HASH; $narrationCueFile=$null",example].join('\n'));
  const start=performance.now();
  const {stdout}=process.platform==='win32'?await exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,env:{...env,P_NODE:process.execPath,P_INSTALL:resolve('.'),P_ROOT:f.root,P_EP:episodeId,P_FILE:file,P_HASH:s.promptHash}})
    :await exec(process.execPath,[cli,'prompts','replace','--root',f.root,'--episode',episodeId,'--segment',segmentId,'--file',file,'--expected-sha256',inputHash,'--expected-prompt-hash',s.promptHash],{env});
  const hostCallMs=performance.now()-start,receipt=JSON.parse(stdout),verify=performance.now(),events=await observations(audit);
  expect(receipt).toMatchObject({state:'replaced',episodeId,segmentId,inputSha256:inputHash});expect(events).toHaveLength(1);expect(events[0].command.slice(0,2)).toEqual(['prompts','replace']);
  const after=await files(f.root);expect(Object.keys(before).filter(p=>before[p]!==after[p])).toEqual(['metasocli.yaml']);
  const verificationMs=performance.now()-verify;
  // Measure native CLI start-to-receipt independently of PowerShell startup and post-checks.
  const plainFile=await selected(f.root,'体积基线。'+s.prompt,'volume-baseline.txt'),plain=await envFor(f.root,'-plain'),plainStart=performance.now();
  const plainReceipt=JSON.parse((await exec(process.execPath,[cli,'prompts','replace','--root',f.root,'--episode',episodeId,'--segment',segmentId,'--file',plainFile],{env:plain.env,windowsHide:true})).stdout);
  const plainCliMs=performance.now()-plainStart;expect(plainReceipt.state).toBe('replaced');expect(await observations(plain.audit)).toHaveLength(1);
  // Increase actual gallery byte volume without changing a single manifest entry.
  const huge=join(f.root,'assets/gallery-volume.bin'),handle=await open(huge,'w');await handle.truncate(128*1024*1024);await handle.close();
  const second=await envFor(f.root,'-volume'),start2=performance.now();
  const replay=JSON.parse((await exec(process.execPath,[cli,'prompts','replace','--root',f.root,'--episode',episodeId,'--segment',segmentId,'--file',file,'--expected-prompt-hash',plainReceipt.promptHash],{env:second.env,windowsHide:true})).stdout);
  const cliMs=performance.now()-start2;expect(replay.state).toBe('replaced');expect(await observations(second.audit)).toHaveLength(1);expect((await stat(huge)).size).toBe(128*1024*1024);
  if(process.env.METASO_TEST_EVIDENCE_DIR)await writeFile(join(process.env.METASO_TEST_EVIDENCE_DIR,`prompt-cli-${episodes}.json`),JSON.stringify({episodes,segments:count,assets,setupMs,hostCallMs,receipt,verificationMs,commands:events,
    network:0,keyLoads:0,mediaReads:0,protectedReads:0,changed:Object.keys(before).filter(p=>before[p]!==after[p]),added:Object.keys(after).filter(p=>!(p in before)),before,after,
    nativeCli:{cliMs:plainCliMs,receipt:plainReceipt,commands:await observations(plain.audit)},
    volumeReplacement:{additionalMediaBytes:128*1024*1024,cliMs,receipt:replay,commands:await observations(second.audit)}},null,2));
},90000);

test('actual CLI rejects extra/duplicate/value-bearing options without echoing values or writing',async()=>{
  const f=await replacementFixture(),file=await selected(f.root,'天亮了。新稿。'),before=await files(f.root),{env}=await envFor(f.root);
  const args=[cli,'prompts','replace','--root',f.root,'--episode','ep-1','--segment','s2','--file',file];
  for(const tail of [['--duration','TOP_SECRET'],['--references','TOP_SECRET'],['--model','TOP_SECRET'],['--confirm'],['--runtime-dir','TOP_SECRET'],['--file','TOP_SECRET'],['--episode=TOP_SECRET'],['--wat','TOP_SECRET']]){
    const r=await exec(process.execPath,[...args,...tail],{env,windowsHide:true}).catch(e=>e);
    expect(r.code).toBe(1);expect(JSON.parse(r.stdout)).toMatchObject({error:{code:'CLI_ARGUMENT'}});expect(r.stdout).not.toContain('TOP_SECRET');
  }
  expect(await files(f.root)).toEqual(before);
},30000);

test('three Skills select the same early short path; local and optional user shims still resolve',async()=>{
  for(const name of ['metasoclitk','metasocli-video-prompts','metasocli-video-prompts-旁白']){
    const file=resolve('skills',name,'SKILL.md'),text=await readFile(file,'utf8'),link=text.match(/\[指定段提示词一次替换\]\(([^)]+)\)/)!;
    expect(resolve(dirname(file),link[1]!)).toBe(resolve(doc));expect(text.indexOf(link[0])).toBeLessThan(text.indexOf('[已有图片授权与提交上下文]'));expect(text.indexOf(link[0])).toBeLessThan(text.indexOf('[本机视频授权]'));
    expect(text).toContain('[同 ID 纯换图判断]');expect(text).toContain('继承时不重复执行');
    const shim=resolve('.agents/skills',name,'SKILL.md'),forward=(await readFile(shim,'utf8')).match(/\[技能正文\]\(([^)]+)\)/)!;expect(resolve(dirname(shim),forward[1]!)).toBe(file);
  }
});

test('foreign queued/unknown video and unknown image retain exact ledgers while actual prompt CLI edits locally',async()=>{
  const f=await replacementFixture(),foreign=await replacementFixture(),image=await imageFixture(),runtimeRoot=join(dirname(f.root),'foreign-runtime');
  const plan=await createPlan(foreign.root,'ep-1');
  const known=await submit(foreign.root,plan.planId,'s1',true,{runtimeRoot,client:{async create(){return {taskId:'foreign-queued',evidence};},async query(){throw Error('No query');}}});
  const unknown=await submit(foreign.root,plan.planId,'s2',true,{runtimeRoot,client:{async create(){throw Error('Lost create response');},async query(){throw Error('No query');}}});
  expect(known.status).toBe('queued');expect(unknown.status).toBe('submit_unknown');
  const imagePlan=await createImagePlan(image.root,{episodes:['ep-1'],profile});
  await runImages(image.root,imagePlan.plan.planId,true,{runtimeRoot,client:{async create(){throw Error('Lost image response');}}});
  expect((await listImageJobs(image.root))[0]!.status).toBe('submit_unknown');
  const oldRuntime=await files(runtimeRoot),oldForeign=await files(foreign.root),oldImage=await files(image.root),file=await selected(f.root,'天亮了。完整新稿。'),{env,audit}=await envFor(f.root);
  const receipt=JSON.parse((await exec(process.execPath,[cli,'prompts','replace','--root',f.root,'--episode','ep-1','--segment','s2','--file',file],{env:{...env,METASO_RUNTIME_DIR:runtimeRoot},windowsHide:true})).stdout);
  expect(receipt.state).toBe('replaced');expect(await observations(audit)).toHaveLength(1);
  expect(await files(runtimeRoot)).toEqual(oldRuntime);expect(await files(foreign.root)).toEqual(oldForeign);expect(await files(image.root)).toEqual(oldImage);
  if(process.env.METASO_TEST_EVIDENCE_DIR)await writeFile(join(process.env.METASO_TEST_EVIDENCE_DIR,'prompt-foreign-isolation.json'),JSON.stringify({queued:known.operationId,unknown:unknown.operationId,imageUnknown:(await listImageJobs(image.root))[0]!.operationId,receipt,events:await observations(audit),runtimeBefore:oldRuntime,runtimeAfter:await files(runtimeRoot)},null,2));
},30000);

test('shared PowerShell receipt checks reject mismatched identities/hashes/non-JSON/errors without retry',async()=>{
  if(process.platform!=='win32')return;
  const f=await replacementFixture(),folder=dirname(f.root),entry=join(folder,'fake-install/dist/cli');await mkdir(entry,{recursive:true});
  const file=await selected(f.root,'选定稿'),fake=join(entry,'main.js'),script=join(folder,'receipt.ps1'),calls=join(folder,'calls.jsonl');
  const example=(await readFile(doc,'utf8')).match(/^\x60{3}powershell\r?\n([\s\S]*?)^\x60{3}/m)![1];
  await writeFile(fake,"import fs from 'node:fs';fs.appendFileSync(process.env.P_CALLS,'call\\n');let r={schemaVersion:1,episodeId:'ep-1',segmentId:'s2',inputSha256:process.argv.at(-1),promptHash:'a'.repeat(64),state:'replaced',changed:true};if(process.env.P_CASE==='id')r.segmentId='wrong';if(process.env.P_CASE==='hash')r.inputSha256='bad';if(process.env.P_CASE==='state')r.changed=false;console.log(process.env.P_CASE==='json'?'bad':JSON.stringify(r));if(process.env.P_CASE==='exit')process.exitCode=19;");
  await writeFile(script,["$nodeExe=$env:P_NODE;$installRoot=$env:P_INSTALL;$storyRoot=$env:P_ROOT;$episodeId='ep-1';$segmentId='s2';$selectedPromptFile=$env:P_FILE;$expectedPromptHash=$null;$narrationCueFile=$null",example].join('\n'));
  for(const mode of ['valid','id','hash','state','json','exit']){
    const r=await exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,env:{...process.env,P_NODE:process.execPath,P_INSTALL:join(folder,'fake-install'),P_ROOT:f.root,P_FILE:file,P_CALLS:calls,P_CASE:mode}}).catch(e=>e);
    if(mode==='valid')expect(JSON.parse(r.stdout).state).toBe('replaced');else expect(r.code).not.toBe(0);
  }
  expect((await readFile(calls,'utf8')).trim().split('\n')).toHaveLength(6);
},30000);
