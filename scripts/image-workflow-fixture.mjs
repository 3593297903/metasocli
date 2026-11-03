// Synthetic inputs only; shared by offline process and performance checks.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {initializeStory} from '../dist/core/project.js';
import {ImageProfile} from '../dist/images/contracts.js';
import {deflateSync} from 'node:zlib';
export const digest=b=>createHash('sha256').update(b).digest('hex');
export async function workflowFixture(parent,episodes=2,assets=2){
  const root=join(parent,'故事 中文 space'),story=await initializeStory(root,'Synthetic workflow');const entries=[];
  const recipes=Array.from({length:assets},(_,i)=>({assetId:`asset-${i}`,kind:'character',prompt:`完整人物 ${i}。中文名称、资料、正侧背视图与材质。\n完整提示词保持。`,dependencies:[],exactText:[]}));
  for(let i=0;i<episodes;i++){
    const chosen=recipes.filter((_,n)=>n%episodes===i);if(!chosen.length)chosen.push(recipes[i%assets]);
    const episodeId=`ep-${i+1}`,dir=`.metasocli/drafts/${episodeId}`,text='完整旁白原句与人物台词。\n';await mkdir(join(root,dir),{recursive:true});
    const source=`${dir}/原始 来源.txt`;await writeFile(join(root,source),'\ufeff'+text.repeat(chosen.length).replaceAll('\n','\r\n'));
    const draft={episodeId,kind:'video-prompts',source,segments:chosen.map((r,n)=>({id:`s${n+1}`,start:n*text.length,end:(n+1)*text.length,duration:[12.378,6.666,6.963][i%3],references:[{assetId:r.assetId,role:'reference_image'}],parameters:{contextIr:true}})),recipes:chosen};
    const request={schemaVersion:'1.0.0',episodeId,modelPreference:null,requireExactModel:false,assets:chosen.map((r,n)=>({assetId:r.assetId,kind:r.kind,version:'v1',order:n+1,name:r.assetId,required:true,requiredBySegments:[`s${n+1}`],visualDescription:'原文已确定的外观。',sourceFacts:['原文事实'],continuityRequirements:[],exclude:[],dependencyAssetIds:[],exactText:[]}))};
    const recipe={schemaVersion:'1.0.0',episodeId,assets:chosen.map(r=>({assetId:r.assetId,kind:r.kind,status:'planned',generationPrompt:r.prompt,recipeSha256:digest(r.prompt),existingRelativePath:null,contentSha256:null,reason:null}))};
    for(const [name,value] of Object.entries({draft,request,recipe}))await writeFile(join(root,dir,`${name}.json`),JSON.stringify(value));
    entries.push({episodeId,draftPath:`${dir}/draft.json`,requestPath:`${dir}/request.json`,recipePath:`${dir}/recipe.json`,replace:false});
  }
  const profile=ImageProfile.parse({boardSize:'1024x1024',firstFrameSize:'1024x1024',maxImageBytes:65536,maxResponseBytes:131072,maxTempBytes:128*1024*1024});
  await writeFile(join(root,'profile.json'),JSON.stringify(profile));
  const batch={schemaVersion:1,projectId:story.projectId,entries,scope:{episodes:entries.map(e=>e.episodeId)},profilePath:'profile.json'};
  await writeFile(join(root,'batch.json'),JSON.stringify(batch));return {root,batch,profile,batchPath:join(root,'batch.json')};
}
export function png(color=5){
  function chunk(name,data){const body=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;for(const n of body){crc^=n;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);body.copy(b,4);b.writeUInt32BE((crc^0xffffffff)>>>0,b.length-4);return b;}
  const h=Buffer.alloc(13);h.writeUInt32BE(1024);h.writeUInt32BE(1024,4);h[8]=8;h[9]=2;
  const pixels=Buffer.alloc(1024*3073,color);for(let n=0;n<1024;n++)pixels[n*3073]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
