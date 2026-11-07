import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, cleanup, png, mp4 } from './helpers.js';
import { wav } from './audio-fixtures.js';
import { importStory, loadStory } from '../src/core/project.js';
import { registerAsset } from '../src/assets/registry.js';
import { createPlan } from '../src/core/planning.js';
import { runCli } from '../src/cli/main.js';
import { sha256Hex } from '../src/storage/canonical.js';
import { evidence } from './batch-helpers.js';
import type { H3Request } from '../src/metaso/h3.js';

afterEach(cleanup);
test('one real register replaces one ID in six episodes/eleven segments; old vs new exact selected POST',async()=>{
  const f=await fixture(), ids=['hero','hall','voice'], root=f.root;
  for (let e=1;e<=6;e++) {
    const lines=Array.from({length:e===6?1:2},(_,i)=>'旁白：天亮了。第'+e+'集第'+(i+1)+'段 {{ref:hall}} {{ref:hero}}。\n');
    const source=join(dirname(root),'ep-'+e+'.txt');await writeFile(source,lines.join(''));
    let end=0;
    await importStory(root,{episodeId:'ep-'+e,kind:'video-prompts',source,recipes:ids.map((assetId,i)=>({assetId,kind:['character','scene','narration'][i],prompt:'原配方 '+assetId})),
      segments:lines.map((line,i)=>{const start=end;end+=line.length;return {id:'s'+(i+1),start,end,duration:6.963,references:['hall','hero'].map(assetId=>({assetId,role:'reference_image'})),narration:{assetId:'voice',cues:[{start:3,end:7}]}};})});
  }
  for (const [id,bytes] of [['hero',png()],['hall',png(512,512)],['voice',wav()]] as const) {
    const path=join(dirname(root),id);await writeFile(path,bytes);await registerAsset(root,id,{file:path});
  }
  const before=await loadStory(root),path=join(dirname(root),'选中新图.png'),bytes=png(512,256,2),hash=sha256Hex(bytes);
  await writeFile(path,bytes);
  const selection=join(root,'selection.json');await writeFile(selection,JSON.stringify({schemaVersion:1,episodes:[{episodeId:'ep-1',segmentIds:['s2']}]}));
  const exec=(...args:string[])=>runCli(['video','execute','--root',root,...args]);
  const frozen=(await exec('--selection',selection)).data as any;
  const args=[resolve('dist/cli/main.js'),'assets','register','--root',root,'--id','hero','--file',path,'--expected-sha256',hash,'--provenance','user'];
  const began=performance.now(), receipt=JSON.parse((await promisify(execFile)(process.execPath,args,{windowsHide:true})).stdout);
  const registrationMs=performance.now()-began;expect(receipt).toMatchObject({assetId:'hero',sha256:hash});
  const after=await loadStory(root);
  expect(after.episodes).toEqual(before.episodes);expect(after.episodes.flatMap(e=>e.segments)).toHaveLength(11);
  expect(after.assets.filter(a=>a.recipe.assetId!=='hero')).toEqual(before.assets.filter(a=>a.recipe.assetId!=='hero'));
  expect(after.assets[0]!.recipe).toEqual(before.assets[0]!.recipe);expect(receipt.recipeHash).toBe(before.assets[0]!.recipeHash);
  expect(await readFile(join(root,before.assets[0]!.media!.path))).toEqual(png());
  expect(after.revision).toBe(before.revision+1);
  await promisify(execFile)(process.execPath,args,{windowsHide:true});expect(await loadStory(root)).toEqual(after);
  expect(await readdir(join(root,'.metasocli/jobs'))).toEqual([]);
  expect(await readdir(join(root,'.metasocli'))).not.toContain('image-jobs');
  for (const [flag,value] of [['--expected-sha256','0'.repeat(64)],['--id','wrong'],['--file',f.source]]) {
    const invalid=args.slice(1);invalid[invalid.indexOf(flag)+1]=value;
    expect((await runCli(invalid)).exitCode).toBe(1);expect(await loadStory(root)).toEqual(after);
  }
  const requests:H3Request[]=[];
  const deps={client:{async create(request:H3Request){requests.push(request);return {taskId:'new-image-selected',evidence};},async query(taskId:string){return {taskId,status:'generated' as const,rawStatus:'succeeded',url:'https://example.test/s2.mp4',duration:7,evidence};}},fetcher:async()=>new Response(mp4(7))};
  const execute=(...args:string[])=>runCli(['video','execute','--root',root,...args],deps);
  expect(await execute('--batch',frozen.batchId,'--confirm')).toMatchObject({exitCode:2,data:{error:{code:'PLAN_STALE'}}});expect(requests).toHaveLength(0);
  const newer=(await execute('--selection',selection)).data as any;
  expect(newer.scopeHash).not.toBe(frozen.scopeHash);expect(newer.batchId).not.toBe(frozen.batchId);
  const done=await execute('--selection',selection,'--expect-scope',newer.scopeHash,'--confirm','--poll-ms','0');
  expect(done).toMatchObject({exitCode:0,data:{state:'complete',segments:[{segmentId:'s2',taskId:'new-image-selected'}]}});
  expect(requests).toHaveLength(1);const sent=requests[0]!;
  expect(sent).toMatchObject({context_ir_enabled:true,model:'MiniMax-H3',duration:7});
  expect(sent.content.map(c=>c.type)).toEqual(['text','image_url','image_url','audio_url']);
  for(const [index,expected] of [[1,png(512,512)],[2,bytes],[3,wav()]] as const){
    const c=sent.content[index]!;const url=c.type==='image_url'?c.image_url.url:c.type==='audio_url'?c.audio_url.url:'';
    expect(sha256Hex(Buffer.from(url.split(',')[1]!,'base64'))).toBe(sha256Hex(expected));
  }
  if(process.env.METASO_TEST_EVIDENCE_DIR)await writeFile(join(process.env.METASO_TEST_EVIDENCE_DIR,'replacement.json'),JSON.stringify({episodes:6,segments:11,registrationMs,
    registrationCount:1,idempotenceReplays:1,pureImagePosts:0,pureVideoPosts:0,oldHash:before.assets[0]!.media!.sha256,newHash:hash,staleBatch:frozen.batchId,stalePosts:0,newPosts:1,delivery:done.data},null,2));
},60000);

const sharedRule = 'skills/metasocli-reference-images/references/selected-local-image.md';

async function storyFiles(root: string) {
  const entries = await readdir(root, {recursive:true, withFileTypes:true});
  return Object.fromEntries(await Promise.all(entries.filter(e=>e.isFile()).map(async e=>{
    const file = join(e.parentPath, e.name);
    return [relative(root,file).split(sep).join('/'), sha256Hex(await readFile(file))];
  })));
}

// On Windows exercise the exact example that the three entries delegate to.
// Other hosts exercise the same public CLI without a PowerShell dependency.
async function replaceFromDisk(root: string, originalId: string, selectedFile: string) {
  const folder = dirname(root), guard = join(folder,'observe-cli.mjs'), audit = join(folder,'calls.jsonl');
  await writeFile(guard, [
    "import {appendFileSync} from 'node:fs';",
    "const record = value => appendFileSync(process.env.REPLACEMENT_AUDIT, JSON.stringify(value)+'\\n');",
    "record({args:process.argv.slice(2)});",
    "globalThis.fetch = () => { record({fetch:true}); throw Error('Offline replacement attempted network'); };"
  ].join('\n'));
  const env = {...process.env, REPLACEMENT_AUDIT:audit,
    NODE_OPTIONS:[process.env.NODE_OPTIONS,'--import='+pathToFileURL(guard).href].filter(Boolean).join(' ')};
  const exec = promisify(execFile);
  let result: {receipt:{assetId:string;sha256:string;recipeHash:string};registerMs:number};
  if (process.platform === 'win32') {
    const rule = await readFile(sharedRule,'utf8');
    const example = rule.match(/^\x60{3}powershell\r?\n([\s\S]*?)^\x60{3}/m)?.[1];
    if (!example) throw Error('Missing shared PowerShell registration example');
    const script = [
      "$ErrorActionPreference='Stop'; $nodeExe=$env:REPLACEMENT_NODE; $installRoot=(Get-Location).Path",
      "$storyRoot=$env:REPLACEMENT_ROOT; $selectedFile=$env:REPLACEMENT_FILE; $originalAssetId=$env:REPLACEMENT_ID",
      "$provenance='user'; $trustedSelectedHash=$null; $clock=[Diagnostics.Stopwatch]::StartNew()",
      '$line = & {', example, '}',
      '$clock.Stop(); [pscustomobject]@{receipt=($line | ConvertFrom-Json); registerMs=$clock.Elapsed.TotalMilliseconds} | ConvertTo-Json -Compress'
    ].join('\n');
    const scriptPath=join(folder,'replace-selected.ps1');
    await writeFile(scriptPath,script);
    const {stdout} = await exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',scriptPath],{
      cwd:resolve('.'), windowsHide:true, env:{...env,REPLACEMENT_NODE:process.execPath,REPLACEMENT_ROOT:root,
        REPLACEMENT_FILE:selectedFile,REPLACEMENT_ID:originalId}
    });
    result = JSON.parse(stdout);
  } else {
    const start = performance.now(), expected = sha256Hex(await readFile(selectedFile));
    const {stdout} = await exec(process.execPath,[resolve('dist/cli/main.js'),'assets','register',
      '--root',root,'--id',originalId,'--file',selectedFile,'--expected-sha256',expected,'--provenance','user'],{env});
    const receipt = JSON.parse(stdout);
    expect(receipt).toMatchObject({assetId:originalId,sha256:expected});
    result = {receipt,registerMs:performance.now()-start};
  }
  const events: {args?:string[];fetch?:boolean}[] = (await readFile(audit,'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
  return {...result, commands:events.flatMap(e=>e.args?[e.args]:[]), fetches:events.filter(e=>e.fetch).length};
}

test('another ID already owns the selected image: replace only original media in one real CLI registration',async()=>{
  const start = performance.now(), {root} = await fixture();
  const originalId = 'vera-red', otherId = 'vera-black', controlId = 'letter';
  const recipes = [
    {assetId:originalId,kind:'character',prompt:'薇拉，红发。'},
    {assetId:otherId,kind:'character',prompt:'薇拉，黑棕发。'},
    {assetId:controlId,kind:'prop',prompt:'白色信封。'}
  ];
  for (let ep=1;ep<=6;ep++) {
    const lines = Array.from({length:ep===6?1:2},(_,i)=>'第'+ep+'集第'+(i+1)+'段：红发薇拉 {{ref:vera-red}} 拿起 {{ref:letter}}。\n');
    const source = join(root,'input-'+ep+'.txt');
    await writeFile(source,lines.join(''));
    let end=0;
    const segments=lines.map((line,i)=>{
      const start=end; end+=line.length;
      return {id:'s'+(i+1),start,end,duration:6.963,references:[originalId,controlId].map(assetId=>({assetId,role:'reference_image'}))};
    });
    await importStory(root,{episodeId:'ep-'+ep,kind:'video-prompts',source,segments,recipes});
  }
  for (const [id,bytes] of [[originalId,png(256,256,1)],[otherId,png(512,256,2)],[controlId,png(256,512,3)]] as const) {
    const file=join(dirname(root),id+'.png');
    await writeFile(file,bytes);
    await registerAsset(root,id,{file,provenance:id===originalId?'imagegen':'user'});
  }
  await createPlan(root,'ep-1');
  const gallery=join(root,'gallery');
  await mkdir(gallery);
  await writeFile(join(gallery,'preview.png'),png());
  await writeFile(join(gallery,'delivery.zip'),Buffer.from('PK\x03\x04fixture'));
  const before=await loadStory(root), filesBefore=await storyFiles(root);
  const old=before.assets.find(a=>a.recipe.assetId===originalId)!, donor=before.assets.find(a=>a.recipe.assetId===otherId)!;
  const selected=donor.media!, input=join(root,selected.path), expectedMedia={...selected,path:'assets/'+originalId+'/'+selected.sha256+'.image'};
  expect(old.media!.sha256).not.toBe(selected.sha256);
  const setupMs=performance.now()-start;

  const outcome=await replaceFromDisk(root,originalId,input);
  const verifyStart=performance.now();
  expect(outcome.receipt).toEqual({assetId:originalId,sha256:selected.sha256,recipeHash:old.recipeHash});
  expect(outcome.commands).toEqual([['assets','register','--root',root,'--id',originalId,'--file',input,'--expected-sha256',selected.sha256,'--provenance','user']]);
  expect(outcome.fetches).toBe(0);
  const after=await loadStory(root);
  expect(after).toEqual({...before,revision:before.revision+1,
    assets:before.assets.map(a=>a.recipe.assetId===originalId?{...a,media:expectedMedia}:a)});
  const segments=after.episodes.flatMap(e=>e.segments);
  expect(after.episodes).toHaveLength(6);
  expect(segments).toHaveLength(11);
  for(const segment of segments){
    expect(segment.references.map(r=>r.assetId)).toEqual([originalId,controlId]);
    expect(segment.prompt).toContain('红发薇拉');
  }
  const filesAfter=await storyFiles(root);
  expect(filesBefore[expectedMedia.path]).toBeUndefined();
  const changed=Object.keys(filesBefore).filter(f=>filesBefore[f]!==filesAfter[f]);
  const added=Object.keys(filesAfter).filter(f=>!(f in filesBefore));
  expect(changed).toEqual(['metasocli.yaml']);
  expect(added).toEqual([expectedMedia.path]);
  expect(filesAfter[old.media!.path]).toBe(old.media!.sha256);
  expect(filesAfter[selected.path]).toBe(selected.sha256);
  expect(filesAfter[expectedMedia.path]).toBe(selected.sha256);
  const verificationMs=performance.now()-verifyStart;
  if(process.env.METASO_TEST_EVIDENCE_DIR)await writeFile(join(process.env.METASO_TEST_EVIDENCE_DIR,'replacement-other-id.json'),JSON.stringify({
    scenario:'another ID holds selected bytes', originalId,otherId,controlId,episodes:after.episodes.length,segments:segments.length,
    priorMedia:old.media,selectedMedia:selected,newMedia:expectedMedia,receipt:outcome.receipt, revisions:[before.revision,after.revision],
    commands:outcome.commands,registrationCount:outcome.commands.length,networkRequests:outcome.fetches,
    changedExistingFiles:changed,addedFiles:added,filesBefore,filesAfter,setupMs,hashThroughReceiptMs:outcome.registerMs,verificationMs
  },null,2));
},60000);

test('the three entry shims distinguish global replacement, new recipes, partial scope and unknown result recovery',async()=>{
  const rule=await readFile(sharedRule,'utf8');
  for(const text of ['所有引用','沿用已有配方','只问一次','零写入','只改部分段','新 ID','改提示词','改配方','旁白音频',
    'images attach-result','expected-sha256','--provenance','vera-red','vera-black','相同的图片哈希','红发','黑棕发',
    '$receipt.assetId -cne $originalAssetId','$receipt.sha256 -cne $expected','禁止自动重试'])expect(rule).toContain(text);
  expect(await readFile('skills/metasocli-reference-images/SKILL.md','utf8')).toContain('references/selected-local-image.md');
  for(const name of ['metasoclitk','metasocli-video-prompts','metasocli-video-prompts-旁白']){
    const entry=resolve('skills',name,'SKILL.md'), shim=resolve('.agents/skills',name,'SKILL.md');
    const forward=(await readFile(shim,'utf8')).match(/\[技能正文\]\(([^)]+)\)/u);
    expect(forward,name).toBeTruthy();expect(resolve(dirname(shim),forward![1]!)).toBe(entry);
    const text=await readFile(entry,'utf8');
    const paragraph=text.split(/\r?\n\s*\r?\n/u).find(p=>p.includes('[同 ID 纯换图判断]'));
    expect(paragraph,name).toBeTruthy();
    const target=paragraph!.match(/\[同 ID 纯换图判断\]\(([^)]+)\)/u);
    expect(resolve(dirname(entry),target![1]!)).toBe(resolve(sharedRule));
    for(const term of ['目标唯一','原资产 ID','另一个 ID','登记一次','校验并交付回执','到此结束'])expect(paragraph).toContain(term);
    expect(text.indexOf(paragraph!)).toBeLessThan(text.indexOf('[已有图片授权与提交上下文]'));
  }
});
