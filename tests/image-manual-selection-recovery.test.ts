import { afterEach, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanup, png } from './helpers.js';
import { imageFixture, profile } from './image-api-helpers.js';
import { createImagePlan } from '../src/images/planning.js';
import { attachImageResult, recoverImage, runImages } from '../src/images/run.js';
import { listImageJobs, readImagePlan } from '../src/images/store.js';
import { registerAsset } from '../src/assets/registry.js';
import { loadStory, saveStory } from '../src/core/project.js';
import { sha256Hex } from '../src/storage/canonical.js';

afterEach(cleanup);

async function preparedRecovery(manual:boolean){
 const f=await imageFixture(3,{'asset-001':['asset-000']});
 const parent=join(dirname(f.root),'parent.png'),other=join(dirname(f.root),'other.png'),file=join(dirname(f.root),'selected.png');
 await writeFile(parent,png(1024,1024,1));await writeFile(other,png(1024,1024,2));await writeFile(file,png(1024,1024,9));
 await registerAsset(f.root,f.ids[0]!,{file:parent});await registerAsset(f.root,f.ids[2]!,{file:other});
 const {plan}=await createImagePlan(f.root,{assets:[f.ids[1]!],profile,submissionMode:'all-ready'});let posts=0;
 const unknown=await runImages(f.root,plan.planId,true,{client:{async create(){posts++;return new Response('{}');}}});expect(unknown.summary.unknown).toBe(1);
 const job=(await listImageJobs(f.root)).find(j=>j.assetId===f.ids[1])!;
 if(!manual){await attachImageResult(f.root,job.operationId,file,sha256Hex(png(1024,1024,9)),true);}
 const story=await loadStory(f.root);story.episodes[0]!.segments[1]!.references.push({assetId:f.ids[2]!,role:'reference_image'});story.revision++;await saveStory(f.root,story);
 if(manual)await expect(attachImageResult(f.root,job.operationId,file,sha256Hex(png(1024,1024,9)),true)).rejects.toMatchObject({code:'IMAGE_PLAN_STALE'});
 await registerAsset(f.root,f.ids[1]!,{file,provenance:'user'});
 return {f,plan,job,file,parent,posts:()=>posts};
}

it('finishes a manually associated exact user selection after unrelated segment bindings change without POST or rewriting the plan',async()=>{
 const x=await preparedRecovery(true),before=await loadStory(x.f.root);
 const result=await recoverImage(x.f.root,x.job.operationId);expect(result).toMatchObject({status:'registered',recoveredManually:true});expect(x.posts()).toBe(1);
 const after=await loadStory(x.f.root);expect(after).toEqual(before);expect(after.assets.find(a=>a.recipe.assetId===x.f.ids[1])?.media).toMatchObject({provenance:'user',sha256:sha256Hex(png(1024,1024,9))});expect((await readImagePlan(x.f.root,x.plan.planId)).planHash).toBe(x.plan.planHash);
});

it('still refuses changed actual image dependencies for an exact manually selected target',async()=>{
 const x=await preparedRecovery(true);await writeFile(x.parent,png(1024,1024,3));await registerAsset(x.f.root,x.f.ids[0]!,{file:x.parent});
 const result=await recoverImage(x.f.root,x.job.operationId);expect(result.status).not.toBe('registered');expect(result.error?.code).toBe('IMAGE_DEPENDENCY_CHANGED');expect(x.posts()).toBe(1);
});

it('still refuses a different current target after source bindings change',async()=>{
 const x=await preparedRecovery(true);await writeFile(x.file,png(1024,1024,8));await registerAsset(x.f.root,x.f.ids[1]!,{file:x.file,provenance:'user'});
 const result=await recoverImage(x.f.root,x.job.operationId);expect(result.status).not.toBe('registered');expect(result.error?.code).toBe('IMAGE_PLAN_STALE');expect(x.posts()).toBe(1);
});
