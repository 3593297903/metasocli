import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fixture, cleanup, png, mp4 } from './helpers.js';
import { wav } from './audio-fixtures.js';
import { importStory, loadStory } from '../src/core/project.js';
import { registerAsset } from '../src/assets/registry.js';
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

test('the three entry shims distinguish global replacement, new recipes, partial scope and unknown result recovery',async()=>{
  const rule=await readFile('skills/metasocli-reference-images/references/selected-local-image.md','utf8');
  for(const text of ['所有引用','只改部分段','新 ID','images attach-result','expected-sha256','--provenance'])expect(rule).toContain(text);
  for(const name of ['metasoclitk','metasocli-video-prompts','metasocli-video-prompts-旁白','metasocli-reference-images']){
    expect(await readFile('skills/'+name+'/SKILL.md','utf8')).toContain('selected-local-image.md');
  }
});
