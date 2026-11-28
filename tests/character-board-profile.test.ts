import { afterEach,expect,test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cleanup,fixture } from './helpers.js';
import { importStory } from '../src/core/project.js';
import { runCli } from '../src/cli/main.js';

afterEach(cleanup);
test('first-draft profile preserves explicit settings; mixed scope retains image order and frame dependencies',async()=>{
  const f=await fixture(),base=join(f.root,'base.json'),recipe=join(f.root,'recipe.json'),out=join(f.root,'sizes.json');
  const recipes=[
    {assetId:'actor-winter',kind:'character',prompt:'3:4 白底人物竖幅。'},
    {assetId:'village',kind:'scene',prompt:'村落横向空间。'},
    {assetId:'lantern',kind:'prop',prompt:'灯具结构。'},
    {assetId:'opening',kind:'first_frame',prompt:'开场。',dependencies:['village','actor-winter','lantern']},
    {assetId:'explicit',kind:'character',prompt:'人物竖版 1536×2048。'},
    {assetId:'previous',kind:'character',prompt:'旧配方的横板。'},
    {assetId:'refused',kind:'scene',prompt:'空间板。'}
  ];
  const sizes={lantern:'1536x1024',explicit:'1920x1088',refused:'1536x2048'};
  const providerLimits={batch:12,source:'test',checkedAt:'2026-11-28T00:00:00.000Z'};
  await writeFile(base,JSON.stringify({quality:'high',sizes,providerLimits}));
  await writeFile(recipe,JSON.stringify({assets:recipes.map(({assetId,kind,prompt})=>({assetId,kind,status:'planned',generationPrompt:prompt}))}));
  const helper=fileURLToPath(new URL('../skills/metasocli-reference-images/scripts/character-board-profile.mjs',import.meta.url));
  const select = (id:string) => promisify(execFile)(process.execPath,[helper,'--profile',base,'--recipe',recipe,'--asset',id,'--out',out]);
  await select('actor-winter');
  await select('actor-winter');
  await expect(select('explicit')).rejects.toThrow(/explicit.*1920x1088/);
  await expect(select('village')).rejects.toThrow(/No planned character.*village/);
  expect(JSON.parse(await readFile(out,'utf8'))).toMatchObject({quality:'high',providerLimits,sizes:{...sizes,'actor-winter':'1536x2048'}});
  await importStory(f.root,{...f.draft,recipes,segments:[{...f.draft.segments[0],references:[{assetId:'opening',role:'first_frame'}]}]});
  const plan=async(ids:string[])=>{
    const result=await runCli(['images','plan','--root',f.root,'--assets',ids.join(','),'--profile',out,'--submission-mode','all-ready']);
    return (result.data as any).plan.items;
  };
  const mixed=await plan(['opening']);
  expect(mixed.map((i:any)=>[i.assetId,i.size,i.action])).toEqual([
    ['village','1920x1088','generate'],['actor-winter','1536x2048','generate'],['lantern','1536x1024','generate'],['opening','1088x1920','generate']]);
  expect(mixed[3].dependencies).toEqual(['village','actor-winter','lantern']);
  expect(await plan(['actor-winter'])).toHaveLength(1);
  expect((await plan(['explicit']))[0]).toMatchObject({action:'blocked',size:'1920x1088'});
  expect((await plan(['refused']))[0]).toMatchObject({action:'blocked',size:'1536x2048'});
  expect((await plan(['previous']))[0]).toMatchObject({action:'generate',size:'1920x1088'});
});
