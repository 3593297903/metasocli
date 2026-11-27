import { z } from 'zod';
import { openAsBlob } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { SeedAsset, parse, seedCounts, seedLimits, seedRoles, type SeedRole, type Story, type StorySegment } from '../contracts/story.js';
import { projectPath } from '../storage/paths.js';
import { requireFileIdentity } from '../storage/file-identity.js';
import { sha256Hex } from '../storage/canonical.js';
import { fail, isCode } from '../core/errors.js';
import { publicHttps } from '../metaso/transport.js';

export const Model = z.enum(['seedance-2.5-face-full-5s-480p','seedance-2.5-face-full-5s-720p']);
export type Model = z.infer<typeof Model>;
export const resolution = (model: Model) => model.endsWith('-480p') ? '480p' : '720p';
export const Request = z.object({
  model: Model, sourcePrompt: z.string(), sourceHash: z.string(), prompt: z.string().min(1), promptHash: z.string(),
  duration: z.number().int().min(5).max(30), targetDuration: z.number().positive(),
  ratio: z.enum(['16:9','9:16','4:3','3:4','1:1']), requireAudio: z.boolean(), assets:z.array(SeedAsset),
}).strict();
export type Request = z.infer<typeof Request>;
type Asset = z.infer<typeof SeedAsset>;
type Binding = {role:SeedRole; assetId?:string; asset?:Asset; problem?:string};
export const field = {reference_image:'referenceImages',reference_audio:'referenceAudios',reference_video:'referenceVideos',first_frame:'first_frame_image',last_frame:'last_frame_image'};
export const extension = {'image/png':'png','image/jpeg':'jpg','audio/wav':'wav','audio/mpeg':'mp3','video/mp4':'mp4'};

export function orderedBindings(story:Story, segment:StorySegment):Binding[] {
  const bindings:Binding[] = [];
  function managed(assetId:string,role:SeedRole) {
    const registered=story.assets.find(a=>a.recipe.assetId===assetId);
    const media=registered?.media;
    const parsed=media && SeedAsset.safeParse({role,path:media.path,mime:media.mime,sha256:media.sha256,url:media.url});
    if (!media) bindings.push({role,assetId});
    else if (!parsed?.success || (registered?.recipe.kind==='first_frame')!==(role==='first_frame'))
      bindings.push({role,assetId,problem:'Unsupported format or mismatched role for '+assetId});
    else bindings.push({role,assetId,asset:parsed.data});
  }
  for(const ref of segment.references) managed(ref.assetId,ref.role);
  if(segment.narration) managed(segment.narration.assetId,'reference_audio');
  for(const asset of segment.seedance?.assets??[]) {
    const duplicate=bindings.some(b=>b.role===asset.role && b.asset && (b.asset.path===asset.path || b.asset.sha256===asset.sha256));
    bindings.push({role:asset.role,asset,...(duplicate?{problem:'Repeated binding for '+asset.path}:{})});
  }
  return bindings;
}

const PreparedInputs = Request.omit({model:true});
export function prepareInputs(story:Story, s:StorySegment) {
  const assets:Asset[] = [];
  const labels = new Map<string,string>();
  let imageOrdinal=0;
  for(const binding of orderedBindings(story,s)) {
    if(binding.problem)fail('ASSET_ROLE',binding.problem);
    if(!binding.asset)fail('MISSING_ASSET','Missing registered asset '+binding.assetId+' for '+s.id);
    assets.push(binding.asset);
    if(binding.role==='reference_image')imageOrdinal++;
    if(binding.assetId) labels.set(binding.assetId,binding.role==='first_frame'?'首帧图片':binding.role==='reference_audio'?'参考音频1':'@图'+imageOrdinal);
  }
  const counts=seedCounts(s);
  for(const role of seedRoles) {
    if(counts[role]>seedLimits[role])fail('SEED_ASSETS',s.id+': '+role+' '+counts[role]+', maximum '+seedLimits[role]);
  }
  const pictures=counts.reference_image;
  if((counts.last_frame&&!counts.first_frame) || (pictures&&counts.first_frame))fail('SEED_FRAMES','Invalid first/last frame combination in '+s.id);
  for(const asset of assets) {
    const family=asset.role==='reference_video'?'video':asset.role==='reference_audio'?'audio':'image';
    if(!asset.mime.startsWith(family+'/'))fail('ASSET_ROLE','Incorrect media type for '+asset.path);
    if(asset.url)publicHttps(asset.url);
  }
  if(sha256Hex(s.prompt)!==s.promptHash)fail('CONTENT_CHANGED','Changed source prompt in '+s.id);
  // Render legacy binding headers only. Free text and dialogue may literally discuss a reference image.
  const prompt=s.prompt.replace(/\{\{ref:([^{}]+)\}\}/gu,(_m,id:string)=>labels.get(id)??fail('UNKNOWN_REFERENCE','Unbound asset in '+s.id))
    .replace(/^(\s*(?:素材绑定|图片绑定|参考图序|图序)[：:][ \t]*)((?:参考图[1-9]\d*[ \t、,，]*)+)$/gmu,
      (_line,header:string,list:string)=>header+list.replace(/参考图(\d+)/gu,'@图$1'));
  const refs=new Set([...prompt.matchAll(/@图(\d+)/gu)].map(m=>m[1]));
  if(/\{\{(?:ref:|\s*Node\b)/iu.test(prompt) || Array.from({length:pictures},(_,i)=>String(i+1)).some(n=>!refs.has(n)) || refs.size!==pictures)
    fail('SEED_REFERENCE','Prompt image ordinals must match the bound files in '+s.id);
  return parse(PreparedInputs,{sourcePrompt:s.prompt,sourceHash:s.promptHash,prompt,promptHash:sha256Hex(prompt),
    duration:s.duration,targetDuration:s.targetDurationSeconds??s.duration,ratio:s.seedance?.ratio??s.parameters.ratio,
    requireAudio:s.seedance?.requireAudio??assets.some(a=>a.role==='reference_audio'),assets});
}
export function planRequest(story:Story, s:StorySegment, model:Model):Request {
  return {model,...prepareInputs(story,s)};
}

/** File-backed blobs check changes again while fetch streams them. Hash the same snapshot before creating an order. */
export async function verifiedFile(root:string, a:Asset) {
    const path=await projectPath(root,a.path);
    try {
      requireFileIdentity(await lstat(path,{bigint:true}),path);
      const blob=await openAsBlob(path,{type:a.mime});
      const head=Buffer.from(await blob.slice(0,16).arrayBuffer());
      const signature=a.mime==='image/png'?head.subarray(0,8).toString('hex')==='89504e470d0a1a0a':
        a.mime==='image/jpeg'?head.subarray(0,3).toString('hex')==='ffd8ff':
        a.mime==='video/mp4'?head.toString('ascii',4,8)==='ftyp':
        a.mime==='audio/wav'?head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WAVE':
        head.toString('ascii',0,3)==='ID3'||(head[0]===255&&((head[1]??0)&224)===224);
      if(!signature)fail('ASSET_TYPE','Unexpected file format for '+a.path);
      const hash=createHash('sha256');
      for await(const chunk of blob.stream())hash.update(chunk);
      if(hash.digest('hex')!==a.sha256)fail('ASSET_CHANGED','Changed asset '+a.path);
      return blob;
    } catch(e){if(isCode(e,'ENOENT'))fail('MISSING_ASSET','Missing file '+a.path);throw e;}
}
export async function verifiedFiles(root:string, request:Pick<Request,'assets'>) {
  return Promise.all(request.assets.map(a=>verifiedFile(root,a)));
}
