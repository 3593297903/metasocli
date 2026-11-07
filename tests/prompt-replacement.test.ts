import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { cleanup, mp4, png } from './helpers.js';
import { replacementFixture, files, selected } from './prompt-replacement-fixture.js';
import { replaceSegmentPrompt } from '../src/core/prompt-replacement.js';
import { loadStory, saveStory } from '../src/core/project.js';
import { canonicalSha256, sha256Hex } from '../src/storage/canonical.js';
import { normalizeText } from '../src/story/text.js';
import { validateNarration } from '../src/story/narration.js';
import { createPlan } from '../src/core/planning.js';
import { createBatchPlan } from '../src/jobs/batch-store.js';
import { submit } from '../src/jobs/submit.js';
import { resume } from '../src/jobs/resume.js';
import { readJob } from '../src/jobs/store.js';
import { evidence } from './batch-helpers.js';
import { registerAsset } from '../src/assets/registry.js';
import * as locking from '../src/storage/locking.js';
import type { H3Request } from '../src/metaso/h3.js';

afterEach(async()=>{vi.restoreAllMocks();await cleanup();});
const options=(file:string,extra={})=>({episodeId:'ep-1',segmentId:'s2',file,...extra});

test.each(['前插场景。','短','等长替换'])('six episodes eleven segments: exact whitelist, input/source evidence and idempotence (%s)',async variant=>{
  const f=await replacementFixture(6,11),before=await loadStory(f.root),old=before.episodes[2]!.segments[1]!;
  const text=variant==='短'?'天亮了。':variant==='等长替换'?old.prompt.replace('不改对白','全新对白'):variant+old.prompt;
  const raw=Buffer.from('\uFEFF'+text.replace(/\n/g,'\r\n')),file=await selected(f.root,raw),previous=await files(f.root);
  const result=await replaceSegmentPrompt(f.root,options(file,{episodeId:'ep-3',expectedSha256:sha256Hex(raw),expectedPromptHash:old.promptHash}));
  const after=await loadStory(f.root),ep=after.episodes[2]!,next=ep.segments[1]!,delta=text.length-old.prompt.length;
  const expected=structuredClone(before);expected.revision++;expected.episodes[2]!.source=ep.source;
  expected.episodes[2]!.segments[1]={...old,prompt:text,promptHash:sha256Hex(text),end:old.end+delta,narration:{...old.narration!,cues:[{start:text.indexOf('天亮了。'),end:text.indexOf('天亮了。')+4}]}};
  expected.episodes[2]!.segments[2]!.start+=delta;expected.episodes[2]!.segments[2]!.end+=delta;
  expect(after).toEqual(expected);expect(next).toMatchObject({duration:7,targetDurationSeconds:6.963,parameters:old.parameters,references:old.references});
  expect(result).toMatchObject({state:'replaced',revision:before.revision+1,narrationMode:'relocated',inputSha256:sha256Hex(raw)});
  expect(result.inputSha256).not.toBe(result.promptHash);
  const record=JSON.parse(await readFile(join(f.root,result.changeRecordPath!),'utf8'));
  expect(record.kind).toBe('prepared-prompt-replacement');expect(record.previousEpisodeHash).toBe(canonicalSha256(before.episodes[2]));expect(record.episodeHash).toBe(canonicalSha256(ep));
  expect(await readFile(join(f.root,record.input.path))).toEqual(raw);
  const source=normalizeText(await readFile(join(f.root,ep.source.rawPath)));
  expect(source).toBe(ep.segments.map(s=>s.prompt).join(''));expect(source).not.toContain('技术适配说明');
  const saved=await files(f.root);expect(Object.keys(previous).filter(p=>previous[p]!==saved[p])).toEqual(['metasocli.yaml']);
  expect(Object.keys(saved).filter(p=>!(p in previous)).sort()).toEqual([record.input.path,ep.source.rawPath,ep.source.textPath,result.changeRecordPath!].sort());
  const stamp=(await stat(join(f.root,'metasocli.yaml'))).mtimeMs;
  const replay=await replaceSegmentPrompt(f.root,options(file,{episodeId:'ep-3',expectedPromptHash:old.promptHash}));
  expect(replay).toMatchObject({state:'unchanged',previousRevision:after.revision,revision:after.revision,previousPromptHash:next.promptHash,promptHash:next.promptHash});
  expect(replay.changeRecordPath).toBeUndefined();expect(await files(f.root)).toEqual(saved);expect((await stat(join(f.root,'metasocli.yaml'))).mtimeMs).toBe(stamp);
  await writeFile(file,text);expect((await replaceSegmentPrompt(f.root,options(file,{episodeId:'ep-3'}))).state).toBe('unchanged');expect(await files(f.root)).toEqual(saved);
},30000);

test.each(['invalid-utf8','empty','long','narration-long','incomplete-ref','unknown-ref','node','episode','segment','script','hash','old-hash','source-raw','source-text','source-relation','coverage','prompt-hash','span','role','narration-role','historical-snapshot'])('rejects %s before any business write',async mode=>{
  const f=await replacementFixture(),story=await loadStory(f.root),ep=story.episodes[0]!,s=ep.segments[1]!;
  let text='新场景。'+s.prompt,raw:Buffer|undefined, extra:any={};
  if(mode==='invalid-utf8')raw=Buffer.from([0xc3,0x28]);
  if(mode==='empty')text=' \n';
  if(mode==='long')text='天亮了。'+'😀'.repeat(7000);
  if(mode==='narration-long')text='天亮了。'+'a'.repeat(6800);
  if(mode==='incomplete-ref')text+='{{ref:hero';if(mode==='unknown-ref')text+='{{ref:missing}}';if(mode==='node')text+='{{Node old}}';
  if(mode==='episode')extra.episodeId='missing';if(mode==='segment')extra.segmentId='missing';
  if(mode==='script')ep.kind='script';if(mode==='hash')extra.expectedSha256='0'.repeat(64);if(mode==='old-hash')extra.expectedPromptHash='0'.repeat(64);
  if(mode==='source-raw')await writeFile(join(f.root,ep.source.rawPath),'damaged');
  if(mode==='source-text')await writeFile(join(f.root,ep.source.textPath),'damaged');
  if(mode==='source-relation'){await writeFile(join(f.root,ep.source.textPath),'different');ep.source.textHash=sha256Hex('different');}
  if(mode==='coverage')s.start++;if(mode==='prompt-hash')s.promptHash='0'.repeat(64);if(mode==='span'){s.prompt='other';s.promptHash=sha256Hex('other');s.narration=null;}
  if(mode==='role')s.references[0]!.role='first_frame';if(mode==='narration-role')s.narration!.assetId='hero';
  await saveStory(f.root,story);const file=await selected(f.root,raw??text);
  if(mode==='historical-snapshot'){
    const path=join(f.root,'.metasocli/prompt-replacements/inputs',sha256Hex(raw??text)+'.bin');await mkdir(dirname(path),{recursive:true});await writeFile(path,'damaged historical evidence');
  }
  const before=await files(f.root);
  await expect(replaceSegmentPrompt(f.root,options(file,extra))).rejects.toThrow();expect(await files(f.root)).toEqual(before);
},20000);

test('Unicode codepoints, null/absent narration, first frame and missing assets preserve local editing',async()=>{
  const f=await replacementFixture(),story=await loadStory(f.root),ep=story.episodes[0]!;
  ep.segments[0]!.references=[{assetId:'frame',role:'first_frame'}];
  story.assets[0]!.media={...story.assets[0]!.media!,transport:'url',url:'https://unreachable.invalid/image.png',path:'missing.image'};
  await saveStory(f.root,story);
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network forbidden'));
  for(const segmentId of ['s1','s3']){
    const file=await selected(f.root,'😀'.repeat(6999)+'\n');const receipt=await replaceSegmentPrompt(f.root,options(file,{segmentId}));expect(receipt.state).toBe('replaced');
  }
  const after=await loadStory(f.root);expect(after.assets).toEqual(story.assets);expect(after.episodes[0]!.segments[0]!.narration).toBeNull();expect('narration' in after.episodes[0]!.segments[2]!).toBe(false);expect(fetch).not.toHaveBeenCalled();
});

test.each(['same','relocated','explicit','duplicate','missing','order','overlap','surrogate','cue-hash','cue-text','cue-empty','cue-asset','no-voice'])('narration %s',async mode=>{
  const f=await replacementFixture(),story=await loadStory(f.root),s=story.episodes[0]!.segments[1]!;
  let text=s.prompt,explicit:any,segmentId='s2';
  if(mode==='relocated')text='插入😀\n'+text;
  if(mode==='duplicate')text+='天亮了。';if(mode==='missing')text=text.replace('天亮了。','新旁白。');
  if(mode==='order'||mode==='overlap'){
    const start=s.prompt.indexOf('她说');s.narration!.cues.push({start,end:start+2});await saveStory(f.root,story);
    text='她说天亮了。';if(mode==='overlap'){s.narration!.cues=[{start:0,end:5},{start:4,end:7}];await saveStory(f.root,story);}
  }
  if(['explicit','surrogate','cue-hash','cue-text','cue-empty','cue-asset','no-voice'].includes(mode)){
    text='😀新旁白。人物对白。';explicit={schemaVersion:1,promptHash:sha256Hex(text),cues:[{start:2,end:6,text:'新旁白。'}]};
    if(mode==='surrogate')explicit.cues=[{start:1,end:6,text:text.slice(1,6)}];
    if(mode==='cue-hash')explicit.promptHash='0'.repeat(64);if(mode==='cue-text')explicit.cues[0].text='错误';if(mode==='cue-empty')explicit.cues=[];if(mode==='cue-asset')explicit.assetId='hero';if(mode==='no-voice')segmentId='s1';
  }
  const file=await selected(f.root,text),cueFile=explicit?await selected(f.root,JSON.stringify(explicit),'cues.json'):undefined,before=await files(f.root);
  if(['same','relocated','explicit'].includes(mode)){
    const r=await replaceSegmentPrompt(f.root,options(file,{segmentId,narrationCues:cueFile}));expect(r.narrationMode).toBe(mode==='same'?'kept':mode);
    const after=await loadStory(f.root),next=after.episodes[0]!.segments[1]!;expect(next.narration!.assetId).toBe('voice');validateNarration(next);
    expect(after.episodes[0]!.segments[0]).toEqual(story.episodes[0]!.segments[0]);
    const unrelated=after.episodes[0]!.segments[2]!,old=story.episodes[0]!.segments[2]!;expect({...unrelated,start:old.start,end:old.end}).toEqual(old);
    if(mode==='same')expect(await files(f.root)).toEqual(before);
    if(mode==='explicit')expect(next.narration!.cues).toEqual([{start:2,end:6}]);
  }else{await expect(replaceSegmentPrompt(f.root,options(file,{segmentId,narrationCues:cueFile}))).rejects.toThrow();expect(await files(f.root)).toEqual(before);}
});

test('unchanged never masks source damage and never validates an unrelated episode source',async()=>{
  const f=await replacementFixture(6,11),story=await loadStory(f.root);await writeFile(join(f.root,story.episodes[5]!.source.rawPath),'damaged unrelated');
  const file=await selected(f.root,story.episodes[2]!.segments[1]!.prompt);
  expect((await replaceSegmentPrompt(f.root,options(file,{episodeId:'ep-3'}))).state).toBe('unchanged');
  await writeFile(join(f.root,story.episodes[2]!.source.rawPath),'damaged target');const before=await files(f.root);
  await expect(replaceSegmentPrompt(f.root,options(file,{episodeId:'ep-3'}))).rejects.toMatchObject({code:'SOURCE_CHANGED'});expect(await files(f.root)).toEqual(before);
});

test('bounded regular-file input and absent target duration remain explicit',async()=>{
  const f=await replacementFixture(),story=await loadStory(f.root);delete story.episodes[0]!.segments[0]!.targetDurationSeconds;await saveStory(f.root,story);
  const tooLarge=await selected(f.root,Buffer.alloc(8*1024*1024+1,65),'oversized.txt'),before=await files(f.root);
  await expect(replaceSegmentPrompt(f.root,options(tooLarge,{segmentId:'s1'}))).rejects.toMatchObject({code:'FILE_LIMIT'});
  await expect(replaceSegmentPrompt(f.root,options(dirname(tooLarge),{segmentId:'s1'}))).rejects.toMatchObject({code:'FILE_LIMIT'});
  expect(await files(f.root)).toEqual(before);
  const file=await selected(f.root,'完整新稿。');await replaceSegmentPrompt(f.root,options(file,{segmentId:'s1'}));
  const next=(await loadStory(f.root)).episodes[0]!.segments[0]!;expect('targetDurationSeconds' in next).toBe(false);expect(next.duration).toBe(story.episodes[0]!.segments[0]!.duration);expect(next.parameters).toEqual(story.episodes[0]!.segments[0]!.parameters);
});

test.each(['same-target','same-result','different-segment','different-episode','image'])('lock-internal merge preserves concurrent %s',async mode=>{
  const f=await replacementFixture(6,11),story=await loadStory(f.root),old=story.episodes[2]!.segments[1]!,newText='插入。'+old.prompt;
  const file=await selected(f.root,newText),other=await selected(f.root,'并发另一稿。'+old.prompt,'other.txt');
  const original=locking.withProjectWrite;let injected=false;
  vi.spyOn(locking,'withProjectWrite').mockImplementation(async(root,work)=>{
    if(!injected){injected=true;
      if(mode==='image'){const image=await selected(root,png(512,512,4),'new.png');await registerAsset(root,'hero',{file:image});}
      else await replaceSegmentPrompt(root,options(mode==='same-result'?file:other,{episodeId:mode==='different-episode'?'ep-2':'ep-3',segmentId:mode==='different-segment'?'s1':'s2'}));
    }
    return original(root,work);
  });
  const action=()=>replaceSegmentPrompt(f.root,options(file,{episodeId:'ep-3',expectedPromptHash:old.promptHash}));
  if(mode==='same-target')await expect(action()).rejects.toMatchObject({code:'PROMPT_REPLACEMENT_STALE'});
  else expect((await action()).state).toBe(mode==='same-result'?'unchanged':'replaced');
  const after=await loadStory(f.root);expect(after.revision).toBe(story.revision+(['same-target','same-result'].includes(mode)?1:2));
  expect(after.episodes[2]!.segments[1]!.prompt).toBe(mode==='same-target'?'并发另一稿。'+old.prompt:newText);
  if(mode==='different-segment')expect(after.episodes[2]!.segments[0]!.prompt).toBe('并发另一稿。'+old.prompt);
  if(mode==='different-episode')expect(after.episodes[1]!.segments[1]!.prompt).toBe('并发另一稿。'+old.prompt);
  if(mode==='image')expect(after.assets[0]!.media!.sha256).toBe(sha256Hex(png(512,512,4)));
});

test('stale plans reject POST; fresh fake H3 and accepted old task preserve request identities',async()=>{
  const f=await replacementFixture(),before=await loadStory(f.root),old=await createPlan(f.root,'ep-1');await createBatchPlan(f.root,{episodes:['ep-1']});
  const requests:H3Request[]=[],queries:string[]=[];
  const video=mp4(7),track=video.indexOf('tkhd')+4;video.writeUInt32BE(2048*65536,track+76);video.writeUInt32BE(1152*65536,track+80);
  const deps={client:{async create(request:H3Request){requests.push(request);return {taskId:'accepted-'+requests.length,evidence};},async query(taskId:string){queries.push(taskId);return {taskId,status:'generated' as const,rawStatus:'succeeded',duration:7,url:'https://example.test/video.mp4',evidence};}},fetcher:async()=>new Response(video)};
  const accepted=await submit(f.root,old.planId,'s1',true,deps);const diskBefore=await files(f.root);
  const text='新镜头与新人但原图不变。'+before.episodes[0]!.segments[1]!.prompt,file=await selected(f.root,text);
  await replaceSegmentPrompt(f.root,options(file));const diskAfter=await files(f.root);
  for(const path of Object.keys(diskBefore).filter(p=>/\/(plans|batches|jobs|receipts)\//.test(p)))expect(diskAfter[path]).toBe(diskBefore[path]);
  await expect(submit(f.root,old.planId,'s2',true,deps)).rejects.toMatchObject({code:'PLAN_STALE'});expect(requests).toHaveLength(1);
  const plan=await createPlan(f.root,'ep-1'),fresh=await submit(f.root,plan.planId,'s2',true,deps);expect(requests).toHaveLength(2);
  const request=requests[1]!;expect(request).toMatchObject({model:'MiniMax-H3',context_ir_enabled:true,duration:7,resolution:'2K',ratio:'16:9',aigc_watermark:true});expect(request.content[0]).toMatchObject({text:expect.stringContaining(text.replace('{{ref:hero}}','参考图1').replace('{{ref:letter}}','参考图2'))});
  expect(plan.segments[1]!.assets).toEqual(old.segments[1]!.assets);expect(plan.segments[1]!.targetDurationSeconds).toBe(6.963);
  const done=await resume(f.root,accepted.operationId,deps,{maxPolls:1,pollIntervalMs:0});expect(done.status).toBe('downloaded');expect(done.taskId).toBe(accepted.taskId);expect(queries).toEqual([accepted.taskId]);expect(requests).toHaveLength(2);expect((await readJob(f.root,fresh.operationId)).taskId).toBe(fresh.taskId);
});
