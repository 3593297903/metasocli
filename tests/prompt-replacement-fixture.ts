import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fixture, png } from './helpers.js';
import { wav } from './audio-fixtures.js';
import { importStory, loadStory, saveStory } from '../src/core/project.js';
import { registerAsset } from '../src/assets/registry.js';
import { sha256Hex, canonicalSha256 } from '../src/storage/canonical.js';

export async function replacementFixture(episodes = 1, total = 3, assetCount = 5) {
  const f = await fixture(), start = performance.now();
  const recipes = ['hero', 'hall', 'letter', 'frame', 'voice'].map((assetId, i) => ({ assetId, kind: ['character','scene','prop','first_frame','narration'][i], prompt: '保留原配方 ' + assetId }));
  let remaining = total;
  for (let e = 1; e <= episodes; e++) {
    // Six episodes/eleven segments: ep-3 has a genuine middle segment.
    const count = episodes === 6 ? [1,2,3,2,2,1][e-1]! : Math.ceil(remaining / (episodes - e + 1));
    remaining -= count;
    const lines = Array.from({length:count},(_,i)=>`第${e}集${i+1}段 😀 旁白：天亮了。她说：「不改对白。」 {{ref:hero}} {{ref:letter}}\n`);
    const source = join(dirname(f.root), 'ep-'+e+'.txt'); await writeFile(source, '\uFEFF'+lines.join('').replace(/\n/g,'\r\n'));
    let cursor = 0;
    await importStory(f.root, {episodeId:'ep-'+e,kind:'video-prompts',source,recipes,
      segments:lines.map((prompt,i)=>{ const start=cursor;cursor+=prompt.length;
        const cue=prompt.indexOf('天亮了。');
        return {id:'s'+(i+1),start,end:cursor,duration:6.963,parameters:{contextIr:true,resolution:'2K',ratio:'16:9',watermark:true},
          references:['hero','letter'].map(assetId=>({assetId,role:'reference_image'})),
          ...(i===1?{narration:{assetId:'voice',cues:[{start:cue,end:cue+4}]}}:i===0?{narration:null}:{})};})});
  }
  for (const [id,bytes] of [['hero',png()],['hall',png(512,256)],['letter',png(256,512)],['frame',png()],['voice',wav()]] as const) {
    const path = join(dirname(f.root), id+'.media'); await writeFile(path,bytes); await registerAsset(f.root,id,{file:path});
  }
  if(assetCount>5){
    const story=await loadStory(f.root);
    for(let i=5;i<assetCount;i++){
      const recipe={assetId:'extra-'+i,kind:'prop' as const,prompt:'保留独立配方 '+i,exactText:[],dependencies:[]};
      story.assets.push({recipe,recipeHash:canonicalSha256(recipe),media:{...story.assets[2]!.media!,path:`assets/extra-${i}/missing.image`}});
    }
    await saveStory(f.root,story);
  }
  for(const file of ['gallery/preview.png','gallery/delivery.zip','全部27集.txt','current-16.json','.metasocli/receipts/historical.json']){
    await mkdir(dirname(join(f.root,file)),{recursive:true}); await writeFile(join(f.root,file),'untouched fixture '+file);
  }
  return {...f, setupMs:performance.now()-start};
}
export async function files(root:string) {
  const entries=await readdir(root,{recursive:true,withFileTypes:true});
  return Object.fromEntries(await Promise.all(entries.filter(e=>e.isFile()).map(async e=>{
    const path=join(e.parentPath,e.name);return [relative(root,path).split(sep).join('/'),sha256Hex(await readFile(path))];
  })));
}
export async function selected(root:string, text:string|Buffer, name='replacement.txt'){
  const file=join(dirname(root),name);await writeFile(file,text);return file;
}
