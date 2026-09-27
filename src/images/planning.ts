import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Id, parse, type Story } from '../contracts/story.js';
import { Selection } from '../contracts/batch.js';
import { fail } from '../core/errors.js';
import { loadStory } from '../core/project.js';
import { readJson, readStable, atomicWrite, writeJson } from '../storage/io.js';
import { exists, projectPath, safePath } from '../storage/paths.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { withProjectWrite } from '../storage/locking.js';
import { inspectImage } from '../assets/image.js';
import { ImagePlan, ImageProfile, type ImagePlanRecord, type ImagePlanItem, type Profile, type EffectiveInput, type ImageJobRecord } from './contracts.js';
import { imagePath, listImageJobs, readImagePlan } from './store.js';

export const IMAGE_PROFILE_FILE=fileURLToPath(new URL('../../.local/image-provider.json',import.meta.url));
export async function loadImageProfile(file?:string):Promise<Profile> {
  const path=await safePath(file??IMAGE_PROFILE_FILE);
  return parse(ImageProfile,await exists(path)?await readJson(path):file?fail('IMAGE_PROFILE_MISSING','Explicit image profile is missing.'):{});
}
export interface ImageScope {episodes?:string[];selection?:unknown;assets?:string[];allEpisodes?:boolean;profile?:unknown;submissionMode?:string}
const binding=(episodeId:string,s:Story['episodes'][number]['segments'][number])=>({episodeId,segmentId:s.id,hash:canonicalSha256(s)});
export async function createImagePlan(root:string,input:ImageScope) {
  if([input.episodes!==undefined,input.selection!==undefined,input.assets!==undefined,input.allEpisodes===true].filter(Boolean).length!==1) fail('IMAGE_SCOPE','Select exactly one ordered image scope.');
  if(input.submissionMode!==undefined&&input.submissionMode!=='all-ready')fail('IMAGE_MODE','Only all-ready image submission is supported.');
  const profile=parse(ImageProfile,input.profile??await loadImageProfile());
  return withProjectWrite(root,async()=>{
    const story=await loadStory(root),jobs=await listImageJobs(root);
    let scope:ImagePlanRecord['scope']=[];const seeds:string[]=[];
    if(input.assets) {
      const ids=parse(z.array(Id).min(1).max(2000),input.assets);if(new Set(ids).size!==ids.length)fail('IMAGE_SCOPE','Repeated asset IDs.');seeds.push(...ids);
    } else {
      const rows=input.selection!==undefined?parse(Selection,input.selection).episodes:(input.episodes??story.episodes.map(e=>e.id)).map(episodeId=>{
        const e=story.episodes.find(e=>e.id===episodeId);if(!e)fail('IMAGE_SCOPE','Selected episode does not exist.');return {episodeId,segmentIds:e.segments.map(s=>s.id)};
      });
      if(!rows.length||new Set(rows.map(r=>r.episodeId)).size!==rows.length)fail('IMAGE_SCOPE','Choose unique episodes.');
      for(const row of rows){const e=story.episodes.find(e=>e.id===row.episodeId);if(!e||!row.segmentIds.length||new Set(row.segmentIds).size!==row.segmentIds.length)fail('IMAGE_SCOPE','Invalid episode/segment selection.');
        for(const id of row.segmentIds){const s=e.segments.find(s=>s.id===id);if(!s)fail('IMAGE_SCOPE','Segment missing.');scope.push(binding(e.id,s));seeds.push(...s.references.map(r=>r.assetId));}
      }
    }
    const ordered:string[]=[],visited=new Set<string>(),active=new Set<string>();
    const visit=(id:string)=>{if(visited.has(id))return;const a=story.assets.find(a=>a.recipe.assetId===id);if(!a)fail('IMAGE_SCOPE',`Asset ${id} is not declared.`);
      if(a.recipe.kind==='narration')return;if(active.has(id))fail('RECIPE_DEPENDENCY','Cyclic image dependency.');active.add(id);a.recipe.dependencies.forEach(visit);active.delete(id);visited.add(id);ordered.push(id);};
    seeds.forEach(visit);
    if(input.assets)scope=story.episodes.flatMap(e=>e.segments.filter(s=>s.references.some(r=>visited.has(r.assetId))).map(s=>binding(e.id,s)));
    const required=new Map<string,ImagePlanRecord['scope']>();
    function use(id:string,b:ImagePlanRecord['scope'][number]){if(!visited.has(id))return;const rows=required.get(id)??[];if(!rows.some(r=>r.episodeId===b.episodeId&&r.segmentId===b.segmentId))rows.push(b);required.set(id,rows);
      story.assets.find(a=>a.recipe.assetId===id)!.recipe.dependencies.forEach(dep=>use(dep,b));}
    for(const b of scope)story.episodes.find(e=>e.id===b.episodeId)!.segments.find(s=>s.id===b.segmentId)!.references.forEach(r=>use(r.assetId,b));
    const items:ImagePlanItem[]=[];
    for(const id of ordered){const asset=story.assets.find(a=>a.recipe.assetId===id)!,recipe=asset.recipe;
      if(recipe.kind==='narration')continue;
      const promptHash=sha256Hex(recipe.prompt),promptPath=`.metasocli/image-inputs/prompts/${promptHash}.txt`;
      await atomicWrite(await projectPath(root,promptPath),recipe.prompt);
      let action:ImagePlanItem['action']='generate',reason:string|undefined,operationId:string|undefined;
      const previous=jobs.filter(j=>j.assetId===id).at(-1);
      if(asset.media){try{if(sha256Hex(await readStable(await projectPath(root,asset.media.path),profile.maxImageBytes))!==asset.media.sha256)throw new Error();action='reuse';}catch{action='blocked';reason='Existing media changed or missing; restore its original result first.';}}
      if(previous && (!['registered','reused','superseded'].includes(previous.status)||(action==='blocked'&&previous.result))){action='recover';operationId=previous.operationId;reason=undefined;}
      const size=profile.sizes[id]??(recipe.kind==='first_frame'?profile.firstFrameSize:profile.boardSize),[w,h]=size.split('x').map(Number) as [number,number];
      if(action==='generate') {
        const pixels=[...recipe.prompt.matchAll(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/gu)];
        if((/\b4K\b/iu.test(recipe.prompt)&&Math.max(w,h)<4096)||(/\b2K\b/iu.test(recipe.prompt)&&Math.max(w,h)<2048)
          ||pixels.some(m=>Number(m[1])!==w||Number(m[2])!==h)||(recipe.kind!=='first_frame'&&w<h)) {action='blocked';reason='Requested image specification conflicts with configured size; choose an explicit documented size.';}
        if(recipe.kind==='first_frame'&&!profile.sizes[id]&&(required.get(id)??[]).some(b=>!['9:16','adaptive'].includes(story.episodes.find(e=>e.id===b.episodeId)!.segments.find(s=>s.id===b.segmentId)!.parameters.ratio))) {action='blocked';reason='This first frame needs an explicit documented size for its composition.';}
      }
      const dependencySources=recipe.dependencies.map(assetId=>{const upstream=items.find(i=>i.assetId===assetId);if(!upstream)fail('IMAGE_DEPENDENCY_KIND','Image dependencies must be images, not narration.');return {assetId,hash:upstream.action==='reuse'?upstream.targetHash:null,producer:upstream.action==='reuse'?null:upstream.operationId?jobs.find(j=>j.operationId===upstream.operationId)!.fingerprint:upstream.fingerprint};});
      const identity={assetId:id,kind:recipe.kind,recipeHash:asset.recipeHash,promptHash,promptPath,dependencies:recipe.dependencies,dependencySources,targetHash:asset.media?.sha256??null,size,requiredBy:required.get(id)??[]};
      items.push({...identity,fingerprint:canonicalSha256({identity,profile}),action,...(reason?{reason}:{}),...(operationId?{operationId}:{})});
    }
    const base={schemaVersion:1 as const,planId:randomUUID(),projectId:story.projectId,createdAt:new Date().toISOString(),revisionAtCreation:story.revision,profile,scope,items};
    const plan=parse(ImagePlan,{...base,planHash:canonicalSha256(base)});await writeJson(await imagePath(root,'image-plans',plan.planId),plan);
    return {plan,summary:imagePlanSummary(plan)};
  });
}
export function imagePlanSummary(plan:ImagePlanRecord){return {total:plan.items.length,reused:plan.items.filter(i=>i.action==='reuse').length,
  immediatelyReady:plan.items.filter(i=>i.action==='generate'&&i.dependencySources.every(d=>d.hash)).length,
  waitingDependency:plan.items.filter(i=>i.action==='generate'&&i.dependencySources.some(d=>!d.hash)).length,
  blocked:plan.items.filter(i=>i.action==='blocked').map(i=>({assetId:i.assetId,reason:i.reason})),recover:plan.items.filter(i=>i.action==='recover').length,
  expectedRequests:plan.items.filter(i=>i.action==='generate').length,submissionMode:plan.profile.submissionMode,model:plan.profile.model,
  providerCapacity:plan.profile.providerLimits??'unknown; real provider capacity unverified'};}
export async function validateImagePlan(root:string,plan:ImagePlanRecord,story?:Story,onlyItem?:ImagePlanItem) {
  story??=await loadStory(root);if(story.projectId!==plan.projectId)fail('IMAGE_PLAN_STALE','Image project identity changed.');
  for(const b of onlyItem?.requiredBy??plan.scope){const s=story.episodes.find(e=>e.id===b.episodeId)?.segments.find(s=>s.id===b.segmentId);if(!s||canonicalSha256(s)!==b.hash)fail('IMAGE_PLAN_STALE',`Selected source or references changed: ${b.episodeId}/${b.segmentId}.`);}
  for(const item of onlyItem?[onlyItem]:plan.items){const a=story.assets.find(a=>a.recipe.assetId===item.assetId);if(!a||a.recipeHash!==item.recipeHash||sha256Hex(a.recipe.prompt)!==item.promptHash)fail('IMAGE_PLAN_STALE',`Image recipe changed: ${item.assetId}.`);
    if(item.action==='reuse'&&(!a.media||a.media.sha256!==item.targetHash||sha256Hex(await readStable(await projectPath(root,a.media.path),plan.profile.maxImageBytes))!==item.targetHash))fail('IMAGE_DEPENDENCY_CHANGED',`Frozen reusable image changed: ${item.assetId}.`);
    if(sha256Hex(await readStable(await projectPath(root,item.promptPath)))!==item.promptHash)fail('IMAGE_PLAN_STALE',`Frozen prompt changed: ${item.assetId}.`);}
  return story;
}
export async function effectiveImageInput(root:string,plan:ImagePlanRecord,item:ImagePlanItem,jobs:ImageJobRecord[],story:Story,chargeSnapshot?:(bytes:number)=>void):Promise<EffectiveInput|undefined> {
  const asset=story.assets.find(a=>a.recipe.assetId===item.assetId)!;
  if((asset.media?.sha256??null)!==item.targetHash)fail('IMAGE_TARGET_CHANGED',`Image target replaced: ${item.assetId}.`);
  const references:EffectiveInput['references']=[];
  for(const dep of item.dependencySources){const asset=story.assets.find(a=>a.recipe.assetId===dep.assetId)!;
    const producer=jobs.find(j=>j.assetId===dep.assetId&&j.status==='registered');
    if(!dep.hash&&producer&&producer.fingerprint!==dep.producer)fail('IMAGE_DEPENDENCY_CHANGED',`Reference producer changed: ${dep.assetId}.`);
    const expected=dep.hash??producer?.result?.sha256;if(!expected)return undefined;
    if(!asset.media||asset.media.sha256!==expected||!('width'in asset.media))fail('IMAGE_DEPENDENCY_CHANGED',`Reference changed: ${item.assetId}/${dep.assetId}.`);
    const bytes=await readStable(await projectPath(root,asset.media.path),plan.profile.maxImageBytes);if(sha256Hex(bytes)!==expected)fail('IMAGE_DEPENDENCY_CHANGED',`Reference bytes changed: ${dep.assetId}.`);
    const info=inspectImage(bytes),path=`.metasocli/image-inputs/files/${expected}.image`,file=await projectPath(root,path);
    if(await exists(file)){if(sha256Hex(await readStable(file,plan.profile.maxImageBytes))!==expected)fail('IMAGE_INPUT_CHANGED','Managed image input snapshot changed.');}else {chargeSnapshot?.(bytes.length);await atomicWrite(file,bytes);}
    references.push({assetId:dep.assetId,sha256:expected,path,mime:info.mime});
  }
  return {provider:plan.profile.provider,origin:plan.profile.origin,route:references.length?'/v1/images/edits':'/v1/images/generations',model:plan.profile.model,quality:plan.profile.quality,
    size:item.size,n:1,response_format:plan.profile.response_format,promptPath:item.promptPath,promptHash:item.promptHash,references};
}
