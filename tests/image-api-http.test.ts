import { afterEach, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanup, png } from './helpers.js';
import { imageFixture, profile } from './image-api-helpers.js';
import { nativeFetch } from './offline.js';
import { createImagePlan } from '../src/images/planning.js';
import { runImages } from '../src/images/run.js';
import { YicImageClient } from '../src/images/client.js';
import { loadStory } from '../src/core/project.js';
import { sha256Hex } from '../src/storage/canonical.js';
afterEach(cleanup);
it('receives 200 complete HTTP request bodies before any success; all 200 bodies stream before bounded decoding',async()=>{
  const f=await imageFixture(200),{plan}=await createImagePlan(f.root,{episodes:['ep-1'],profile,submissionMode:'all-ready'});
  const arrivals:Array<{assetId:string;at:number;bytes:number;hash:string}>=[],responses=new Map<string,ServerResponse>(),streams=new Set<string>(),completed:string[]=[],images=new Map(f.ids.map((id,i)=>[id,png(1024,1024,i)]));
  let firstResponse=Infinity,releaseAt=0,serverFailure:unknown;
  const server=createServer(async(req,res)=>{try{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),data=JSON.parse(body.toString());
    expect(req.url).toBe('/v1/images/generations');expect(req.headers.authorization).toBe('Bearer offline-test-key');expect(data.n).toBe(1);expect(data.model).toBe('gpt-image-2.5');
    const assetId=data.prompt.split(' ')[0];expect(data.prompt).toBe(`${assetId} 完整图片提示词：保留所有汉字\n第二行，不改写。`);
    expect(responses.has(assetId)).toBe(false);responses.set(assetId,res);arrivals.push({assetId,at:Date.now(),bytes:body.length,hash:sha256Hex(body)});
    if(arrivals.length===200){releaseAt=Date.now();for(const response of responses.values()){firstResponse=Math.min(firstResponse,Date.now());response.writeHead(200,{'content-type':'application/json'});response.write('{"data":[');}}
  }catch(error){serverFailure=error;res.destroy();}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('No loopback address');
  const deadline=setTimeout(()=>{serverFailure=new Error(`Deadline: only ${arrivals.length}/200 arrived; ${streams.size}/200 streaming`);server.closeAllConnections();},150000);
  const client=new YicImageClient('offline-test-key',async(url,init)=>{expect(String(url).startsWith('https://api.yiciyuang.com/')).toBe(true);return nativeFetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`,init);});
  try{
    const result=await runImages(f.root,plan.planId,true,{client,onResponseChunk(id){streams.add(id);if(streams.size===200&&!completed.length){clearTimeout(deadline);
      // Deterministic shuffled completion, with unique actual image bytes for every asset.
      for(const assetId of [...f.ids].sort((a,b)=>(Number(a.slice(-3))*73%200)-(Number(b.slice(-3))*73%200))){completed.push(assetId);responses.get(assetId)!.end(JSON.stringify({b64_json:images.get(assetId)!.toString('base64')})+'],"model":"actual-provider-response"}');}
    }}});
    if(serverFailure)throw serverFailure;
    expect(arrivals).toHaveLength(200);expect(streams.size).toBe(200);expect(firstResponse).toBeGreaterThanOrEqual(arrivals.at(-1)!.at);expect(result.summary.registered).toBe(200);expect(result.run?.status).toBe('complete');
    expect(new Set(result.items.map(i=>'operationId'in i?i.operationId:null)).size).toBe(200);
    const story=await loadStory(f.root);for(const asset of story.assets)expect(asset.media?.sha256).toBe(sha256Hex(images.get(asset.recipe.assetId)!));
    expect(story.episodes[0]!.segments.every(s=>s.duration===7&&s.targetDurationSeconds===6.666)).toBe(true);
    const before=story.revision;let reposts=0;await runImages(f.root,plan.planId,false,{client:{async create(){reposts++;throw Error('Duplicate POST');}}});expect(reposts).toBe(0);expect((await loadStory(f.root)).revision).toBe(before);
    const evidence=resolve('.work/image-api-20260924/200-arrivals.json');await mkdir(resolve('.work/image-api-20260924'),{recursive:true});
    await writeFile(evidence,JSON.stringify({offline:true,providerCapacityVerified:false,total:200,allStreamsBeforeDecode:true,releaseAt,firstResponse,arrivals,completionOrder:completed,registered:result.summary.registered,reposts,storyRevision:before},null,2));
  }finally{clearTimeout(deadline);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
},420000);
