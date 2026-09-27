import { fixture, png } from './helpers.js';
import { importStory } from '../src/core/project.js';
import { ImageProfile } from '../src/images/contracts.js';
export const profile=ImageProfile.parse({boardSize:'1024x1024',firstFrameSize:'1024x1024',maxResponseBytes:128*1024,maxImageBytes:64*1024,maxTempBytes:128*1024*1024});
export async function imageFixture(count=1,dependencies:Record<string,string[]>={}){
  const ids=Array.from({length:count},(_,i)=>'asset-'+String(i).padStart(3,'0'));
  const texts=ids.map(id=>`完整视频原文 ${id}。\n`),f=await fixture(texts.join(''));let start=0;
  await importStory(f.root,{...f.draft,recipes:ids.map(assetId=>({assetId,kind:'character',prompt:`${assetId} 完整图片提示词：保留所有汉字\n第二行，不改写。`,dependencies:dependencies[assetId]??[]})),
    segments:texts.map((text,i)=>{const segment={id:'s'+i,start,end:start+text.length,duration:6.666,references:[{assetId:ids[i],role:'reference_image'}]};start+=text.length;return segment;})});
  return {...f,ids};
}
export const imageResponse=(color=0)=>new Response(JSON.stringify({data:[{b64_json:png(1024,1024,color).toString('base64')}],model:'provider-reported-alias',usage:{images:1}}));
