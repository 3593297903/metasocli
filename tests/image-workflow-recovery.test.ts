import { afterEach, expect, test } from 'vitest';
import { readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup } from './helpers.js';
import { workflowFixture } from './image-workflow-helpers.js';
import { prepareImages } from '../src/images/preparation.js';
import { importStory, loadStory } from '../src/core/project.js';
import { canonicalSha256 } from '../src/storage/canonical.js';
import { registerAsset } from '../src/assets/registry.js';
import { png } from './helpers.js';
afterEach(cleanup);
for(const point of ['snapshot-saved','import-before:ep-1','import-after:ep-1','import-after:ep-2','plan-intent-saved','plan-saved'])test(`resume ${point} retains one exact plan`,async()=>{
  const f=await workflowFixture();let hit=false;
  await expect(prepareImages(f.root,{batch:f.batchPath,checkpoint:async name=>{if(name===point){hit=true;throw new Error('simulated interruption');}}})).rejects.toThrow();expect(hit).toBe(true);
  const p=await prepareImages(f.root,{batch:f.batchPath});expect(p.planId).toBeTruthy();expect((await loadStory(f.root)).revision).toBe(2);
  expect((await readdir(join(f.root,'.metasocli/image-plans'))).filter(n=>n.endsWith('.json'))).toEqual([`${p.planId}.json`]);
  expect(await prepareImages(f.root,{preparation:p.preparationId})).toMatchObject({planId:p.planId});
},30000);

test('checkpoint cannot overwrite an intervening episode edit, including replace=true',async()=>{
  const f=await workflowFixture(2,1);f.batch.entries.forEach(e=>e.replace=true);await writeFile(f.batchPath,JSON.stringify(f.batch));
  await expect(prepareImages(f.root,{batch:f.batchPath,checkpoint:async name=>{if(name==='import-after:ep-1')throw new Error('stop');}})).rejects.toThrow();
  const draft=JSON.parse(await readFile(join(f.root,f.batch.entries[0]!.draftPath),'utf8'));draft.source=join(f.root,draft.source);draft.segments[0].duration=12.378;
  await importStory(f.root,draft,true);const before=await readFile(join(f.root,'metasocli.yaml'));
  await expect(prepareImages(f.root,{batch:f.batchPath})).rejects.toMatchObject({code:'IMAGE_PREPARATION_STALE'});
  expect(await readFile(join(f.root,'metasocli.yaml'))).toEqual(before);
});
test('index and summary are not authority; changed intent or formal plan is rejected',async()=>{
  const f=await workflowFixture(1,1),p=await prepareImages(f.root,{batch:f.batchPath});
  const input=JSON.parse(await readFile(join(f.root,p.recordPath,'input.json'),'utf8'));
  await writeFile(join(f.root,'.metasocli/image-preparations/by-input',`${input.inputFingerprint}.json`),'{}');
  await writeFile(join(f.root,p.recordPath,'summary.json'),'invented complete');
  expect(await prepareImages(f.root,{batch:f.batchPath})).toMatchObject({planId:p.planId});
  const file=join(f.root,p.recordPath,'plan-intent.json'),intent=JSON.parse(await readFile(file,'utf8'));intent.plan.profile.quality='high';
  await writeFile(file,JSON.stringify(intent));await expect(prepareImages(f.root,{preparation:p.preparationId})).rejects.toMatchObject({code:'IMAGE_PREPARATION_TAMPERED'});
});
test('intent-only recovery rejects a replaced target and retains original intent',async()=>{
  const f=await workflowFixture(1,1);await expect(prepareImages(f.root,{batch:f.batchPath,checkpoint:async name=>{if(name==='plan-intent-saved')throw new Error('stop');}})).rejects.toThrow();
  const file=join(f.root,'chosen.png');await writeFile(file,png(1024,1024));await registerAsset(f.root,'a0',{file,provenance:'user'});
  await expect(prepareImages(f.root,{batch:f.batchPath})).rejects.toMatchObject({code:'IMAGE_PLAN_STALE'});
});
test('cross-episode recipe conflicts fail before any import and missing Python does not claim validation',async()=>{
  const f=await workflowFixture();const e=f.batch.entries[1]!;
  const draft=JSON.parse(await readFile(join(f.root,e.draftPath),'utf8'));draft.recipes[0].prompt='different';await writeFile(join(f.root,e.draftPath),JSON.stringify(draft));
  await expect(prepareImages(f.root,{batch:f.batchPath})).rejects.toMatchObject({code:'RECIPE_CONFLICT'});expect((await loadStory(f.root)).episodes).toHaveLength(0);
  await expect(prepareImages(f.root,{batch:f.batchPath,python:join(f.root,'missing-python.exe')})).rejects.toMatchObject({code:'IMAGE_PYTHON_UNAVAILABLE'});
});
test('source change gets a new input fingerprint without overwriting the old preparation',async()=>{
  const f=await workflowFixture(1,1),p=await prepareImages(f.root,{batch:f.batchPath}),entry=f.batch.entries[0]!;
  const draft=JSON.parse(await readFile(join(f.root,entry.draftPath),'utf8')),source=join(f.root,draft.source);
  // Same normalized content but different original bytes: explicit replacement is required.
  const text=await readFile(source,'utf8');await writeFile(source,text.replaceAll('\r\n','\n'));
  f.batch.entries[0]!.replace=true;await writeFile(f.batchPath,JSON.stringify(f.batch));
  const q=await prepareImages(f.root,{batch:f.batchPath});expect(q.preparationId).not.toBe(p.preparationId);expect(q.planId).not.toBe(p.planId);
  expect(await readFile(join(f.root,p.recordPath,'input.json'),'utf8')).toContain(p.preparationId);
  await expect(prepareImages(f.root,{preparation:p.preparationId})).rejects.toMatchObject({code:'IMAGE_PREPARATION_STALE'});
});
test('junction preparation writes and legacy input roots remain rejected',async()=>{
  const a=await workflowFixture(1,1),b=await workflowFixture(1,1);
  await symlink(b.root,join(a.root,'.metasocli/image-preparations'),'junction');
  await expect(prepareImages(a.root,{batch:a.batchPath})).rejects.toMatchObject({code:'LINK_PATH'});
  await expect(prepareImages(b.root,{batch:'E:\\libcli\\anything.json'})).rejects.toMatchObject({code:'LEGACY_ROOT'});
});
test('snapshot corruption and edits after import never authorize stale preparation',async()=>{
  const f=await workflowFixture();const p=await prepareImages(f.root,{batch:f.batchPath});
  const input=JSON.parse(await readFile(join(f.root,p.recordPath,'input.json'),'utf8'));
  await writeFile(join(f.root,input.entries[0].source.path),'changed');
  await expect(prepareImages(f.root,{preparation:p.preparationId})).rejects.toMatchObject({code:'IMAGE_PREPARATION_TAMPERED'});
});
test('same story serializes prepares; separate story lease does not block',async()=>{
  const a=await workflowFixture(1,1),b=await workflowFixture(1,1);let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
  const first=prepareImages(a.root,{batch:a.batchPath,checkpoint:async name=>{if(name==='snapshot-saved'){started();await gate;}}});
  await entered;const second=prepareImages(a.root,{batch:a.batchPath});
  const other=await prepareImages(b.root,{batch:b.batchPath});expect(other.planId).toBeTruthy();release();
  const [one,two]=await Promise.all([first,second]);expect(two.planId).toBe(one.planId);
},30000);
