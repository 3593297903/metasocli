import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { loadStory } from '../src/core/project.js';
import { sha256Hex } from '../src/storage/canonical.js';
import { profile } from './image-api-helpers.js';

export async function workflowFixture(episodes=2, assets=2) {
  const f=await fixture('原始台词。\n'), entries=[];
  const recipes=Array.from({length:assets},(_,i)=>({assetId:`a${i}`,kind:'character',prompt:`完整人物图 ${i}。\n原样保留`,dependencies:[],exactText:[]}));
  for(let i=0;i<episodes;i++){
    const episodeId=`ep-${i+1}`,dir=`.metasocli/drafts/中文 空格/${episodeId}`;
    await mkdir(join(f.root,dir),{recursive:true});
    const segments=recipes.map((r,n)=>({id:`s${n}`,start:n*f.text.length,end:(n+1)*f.text.length,duration:6.666,references:[{assetId:r.assetId,role:'reference_image'}]}));
    const source=`${dir}/原文.txt`;await writeFile(join(f.root,source),Buffer.from('\ufeff'+f.text.repeat(assets).replaceAll('\n','\r\n')));
    const draft={episodeId,kind:'video-prompts',source,segments,recipes};
    const request={schemaVersion:'1.0.0',episodeId,modelPreference:null,requireExactModel:false,assets:recipes.map((r,n)=>({assetId:r.assetId,kind:r.kind,version:'v1',order:n+1,name:r.assetId,required:true,requiredBySegments:[`s${n}`],visualDescription:'完整原文外观。',sourceFacts:['原文事实'],continuityRequirements:[],exclude:[],dependencyAssetIds:[],exactText:[]}))};
    const recipe={schemaVersion:'1.0.0',episodeId,assets:recipes.map(r=>({assetId:r.assetId,kind:r.kind,status:'planned',generationPrompt:r.prompt,recipeSha256:sha256Hex(r.prompt),existingRelativePath:null,contentSha256:null,reason:null}))};
    for(const [name,obj] of Object.entries({draft,request,recipe}))await writeFile(join(f.root,dir,`${name}.json`),JSON.stringify(obj));
    entries.push({episodeId,draftPath:`${dir}/draft.json`,requestPath:`${dir}/request.json`,recipePath:`${dir}/recipe.json`,replace:false});
  }
  await writeFile(join(f.root,'profile.json'),JSON.stringify(profile));
  const batch={schemaVersion:1,projectId:(await loadStory(f.root)).projectId,entries,scope:{episodes:entries.map(e=>e.episodeId)},profilePath:'profile.json'};
  const batchPath=join(f.root,'batch.json');await writeFile(batchPath,JSON.stringify(batch));
  return {...f,batch,batchPath,recipes};
}
