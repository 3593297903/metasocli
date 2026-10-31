import { afterEach, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { cleanup } from './helpers.js';
import { imageFixture, imageResponse, profile } from './image-api-helpers.js';
import { createImagePlan } from '../src/images/planning.js';
import { runImages } from '../src/images/run.js';
import { listImageJobs, readImageJob } from '../src/images/store.js';
import { importStory } from '../src/core/project.js';
import { runCli } from '../src/cli/main.js';
afterEach(cleanup);
const plan=(root:string,restartOf?:string)=>createImagePlan(root,{episodes:['ep-1'],profile,submissionMode:'all-ready',...(restartOf?{restartOf}:{})});
it('restarts an explicitly authorized unknown once, preserving the old request and stable new operation',async()=>{
 const f=await imageFixture(2,{'asset-001':['asset-000']}),runtimeRoot=join(dirname(f.root),'runtime');
 const first=(await plan(f.root)).plan;let calls=0;
 await runImages(f.root,first.planId,true,{runtimeRoot,client:{async create(){calls++;return new Response('gateway',{status:502});}}});
 const unknown=(await listImageJobs(f.root)).find(j=>j.status==='submit_unknown')!;
 const next=(await plan(f.root,first.planId)).plan;
 expect(next.restartOf).toBe(first.planId);expect(next.items.every(i=>i.action==='generate')).toBe(true);
 const deps={runtimeRoot,client:{async create(){calls++;return imageResponse(calls);}}};
 await expect(runImages(f.root,next.planId,true,deps)).rejects.toMatchObject({code:'IMAGE_UNKNOWN_ACCEPTANCE_REQUIRED'});
 expect(calls).toBe(1);
 const result=await runImages(f.root,next.planId,true,deps,undefined,true);
 expect(result.summary.registered).toBe(2);expect(calls).toBe(3);
 expect(await readImageJob(f.root,unknown.operationId)).toMatchObject({status:'submit_unknown',requestHash:unknown.requestHash});
 const child=(await listImageJobs(f.root)).find(j=>j.retryOf===unknown.operationId)!;
 expect(child.status).toBe('registered');expect(child.attempt).toBe(unknown.attempt+1);
 await runImages(f.root,next.planId,false,deps);expect(calls).toBe(3);
 await expect(runImages(f.root,first.planId,false,deps)).rejects.toMatchObject({code:'IMAGE_PLAN_REPLACED'});
 const extra=(await plan(f.root,first.planId)).plan;
 await expect(runImages(f.root,extra.planId,true,deps,undefined,true)).rejects.toMatchObject({code:'IMAGE_PLAN_REPLACED'});expect(calls).toBe(3);
});
it('restarts after a casting revision without sending obsolete identities or modifying old records',async()=>{
 const f=await imageFixture(),runtimeRoot=join(dirname(f.root),'runtime'),first=(await plan(f.root)).plan;
 await runImages(f.root,first.planId,true,{runtimeRoot,client:{async create(){return new Response('gateway',{status:502});}}});
 const unknown=(await listImageJobs(f.root))[0]!;
 await importStory(f.root,{...f.draft,segments:[{id:'s0',start:0,end:f.text.length,duration:6.666,references:[{assetId:'white-child',role:'reference_image'}]}],recipes:[{assetId:'white-child',kind:'character',prompt:'New user-authorized white child casting, complete production board',dependencies:[]}]},true);
 const next=(await plan(f.root,first.planId)).plan;const seen:string[]=[];
 const result=await runImages(f.root,next.planId,true,{runtimeRoot,client:{async create(root,input){seen.push(await readFile(join(root,input.promptPath),'utf8'));return imageResponse();}}},undefined,true);
 expect(result.summary.registered).toBe(1);expect(seen).toEqual(['New user-authorized white child casting, complete production board']);
 expect((await readImageJob(f.root,unknown.operationId)).status).toBe('submit_unknown');
});
it('keeps a new 502 unknown and never reuses the previous authorization for another POST',async()=>{
 const f=await imageFixture(),runtimeRoot=join(dirname(f.root),'runtime'),first=(await plan(f.root)).plan;let calls=0;
 const deps={runtimeRoot,client:{async create(){calls++;return new Response('gateway',{status:502});}}};
 await runImages(f.root,first.planId,true,deps);const next=(await plan(f.root,first.planId)).plan;
 await runImages(f.root,next.planId,true,deps,undefined,true);expect(calls).toBe(2);
 await runImages(f.root,next.planId,false,deps);await runImages(f.root,next.planId,true,deps,undefined,true);expect(calls).toBe(2);
 expect((await listImageJobs(f.root)).filter(j=>j.status==='submit_unknown')).toHaveLength(2);
});
it('an unrelated project unknown continues to stop new POSTs',async()=>{
 const f=await imageFixture(),g=await imageFixture(),runtimeRoot=join(dirname(f.root),'runtime');let calls=0;
 const fail={runtimeRoot,client:{async create(){calls++;return new Response('gateway',{status:502});}}};
 const first=(await plan(f.root)).plan;await runImages(f.root,first.planId,true,fail);
 // An independent unknown is created under its own runtime, then registered in the shared ledger through recovery.
 const other=(await plan(g.root)).plan;await runImages(g.root,other.planId,true,{...fail,runtimeRoot:join(dirname(g.root),'own-runtime')});
 const {recoverImage}=await import('../src/images/run.js');await recoverImage(g.root,(await listImageJobs(g.root))[0]!.operationId,{runtimeRoot});
 const next=(await plan(f.root,first.planId)).plan;const before=calls;
 await runImages(f.root,next.planId,true,{runtimeRoot,client:{async create(){calls++;return imageResponse();}}},undefined,true);
 expect(calls).toBe(before);
});
it('public CLI exposes offline restart planning and requires explicit unknown acceptance',async()=>{
 const f=await imageFixture(),runtimeRoot=join(dirname(f.root),'runtime');
 const first=(await plan(f.root)).plan;await runImages(f.root,first.planId,true,{runtimeRoot,client:{async create(){return new Response('gateway',{status:502});}}});
 const {writeFile}=await import('node:fs/promises');const config=join(dirname(f.root),'profile.json');await writeFile(config,JSON.stringify(profile));
 const p=await runCli(['images','plan','--root',f.root,'--episodes','ep-1','--profile',config,'--submission-mode','all-ready','--restart-of',first.planId]);
 expect(p.exitCode).toBe(0);const id=(p.data as any).plan.planId;let calls=0;const deps={runtimeRoot,client:{async create(){calls++;return imageResponse();}}};
 expect((await runCli(['images','run','--root',f.root,'--plan',id,'--confirm'],undefined,deps)).exitCode).toBe(1);expect(calls).toBe(0);
 expect((await runCli(['images','run','--root',f.root,'--plan',id,'--confirm','--accept-unknown-result'],undefined,deps)).exitCode).toBe(0);expect(calls).toBe(1);
});

it('resolves a verified provider task_interrupted response as failed without any new POST',async()=>{
 const f=await imageFixture(),runtimeRoot=join(dirname(f.root),'runtime'),p=(await plan(f.root)).plan;let posts=0;
 await runImages(f.root,p.planId,true,{runtimeRoot,client:{async create(){posts++;return new Response(JSON.stringify({error:{message:'The image generation tool encountered an error. Please try again.',type:'server_error',code:'task_interrupted'}}),{status:503});}}});
 const j=(await listImageJobs(f.root))[0]!;const {resolveImage}=await import('../src/images/run.js');
 const result=await resolveImage(f.root,j.operationId,'failed',{operationId:j.operationId,requestHash:j.requestHash,outcome:'failed',source:{kind:'provider-api-response',reference:`.metasocli/image-receipts/${j.operationId}/complete.json`,statement:'Original provider response explicitly reports task_interrupted; retain response bytes and request identity.'}},true,{runtimeRoot});
 expect(result.status).toBe('failed');expect(posts).toBe(1);
 const evidence=JSON.parse(await readFile(join(f.root,result.resolutionPath!),'utf8'));expect(evidence.independentlyVerified).toBe(true);expect(evidence.providerResponse.errorCode).toBe('task_interrupted');
});
it.each([502,503])('does not resolve a generic HTTP %s response as a terminated task',async(status)=>{
 const f=await imageFixture(),runtimeRoot=join(dirname(f.root),'runtime'),p=(await plan(f.root)).plan;
 await runImages(f.root,p.planId,true,{runtimeRoot,client:{async create(){return new Response(JSON.stringify({error:{message:'service unavailable',code:'service_unavailable'}}),{status});}}});
 const j=(await listImageJobs(f.root))[0]!;const {resolveImage}=await import('../src/images/run.js');
 await expect(resolveImage(f.root,j.operationId,'failed',{operationId:j.operationId,requestHash:j.requestHash,outcome:'failed',source:{kind:'provider-api-response',reference:`.metasocli/image-receipts/${j.operationId}/complete.json`,statement:'This generic gateway error must not be treated as provider termination evidence.'}},true,{runtimeRoot})).rejects.toMatchObject({code:'IMAGE_RESOLUTION_UNPROVEN'});
 expect((await readImageJob(f.root,j.operationId)).status).toBe('submit_unknown');
});

it('sends multiple ordered references under the gateway-supported image[] multipart field',async()=>{
 const f=await imageFixture(3,{'asset-002':['asset-001','asset-000']}),runtimeRoot=join(dirname(f.root),'runtime'),p=(await plan(f.root)).plan;
 const {YicImageClient}=await import('../src/images/client.js');let fields:string[]=[];let number=0;
 const result=await runImages(f.root,p.planId,true,{runtimeRoot,client:new YicImageClient('offline-key',async(url,init)=>{
  if(String(url).endsWith('/edits')){const form=init!.body as FormData;fields=[...form.keys()];const files=form.getAll('image[]') as File[];
   if(files.length!==2)return new Response(JSON.stringify({error:{message:'image is required',type:'new_api_error',code:'convert_request_failed'}}),{status:500});
   expect(files.map(f=>f.name)).toEqual(['asset-001.png','asset-000.png']);expect(form.get('images')).toBeNull();expect(form.get('image')).toBeNull();
  }return imageResponse(number++);
 })});expect(result.summary.registered).toBe(3);expect(fields.filter(k=>k==='image[]')).toHaveLength(2);
});
it('resolves an intact image-is-required conversion failure as not-created without claiming generic HTTP500 rejection',async()=>{
 const f=await imageFixture(),runtimeRoot=join(dirname(f.root),'runtime'),p=(await plan(f.root)).plan;
 // The resolver also checks that this saved request was an actual edits request with references.
 const upstream=await imageFixture(3,{'asset-002':['asset-000','asset-001']}),up=(await plan(upstream.root)).plan;let n=0;
 await runImages(upstream.root,up.planId,true,{runtimeRoot,client:{async create(_r,input){if(input.references.length)return new Response(JSON.stringify({error:{message:'image is required (request id: original-provider-id)',type:'new_api_error',code:'convert_request_failed'}}),{status:500});return imageResponse(n++);}}});
 const j=(await listImageJobs(upstream.root)).find(j=>j.status==='submit_unknown')!;const {resolveImage}=await import('../src/images/run.js');
 const result=await resolveImage(upstream.root,j.operationId,'not-created',{operationId:j.operationId,requestHash:j.requestHash,outcome:'not-created',source:{kind:'provider-api-response',reference:`.metasocli/image-receipts/${j.operationId}/complete.json`,statement:'Original image edit request was rejected during gateway conversion because image was required; preserve actual response.'}},true,{runtimeRoot});
 expect(result.status).toBe('rejected');
});

it('can prepare an explicitly authorized full retry after a subset continuation while reusing ready assets',async()=>{
 const f=await imageFixture(2),runtimeRoot=join(dirname(f.root),'runtime'),first=(await plan(f.root)).plan;
 await runImages(f.root,first.planId,true,{runtimeRoot,client:{async create(root,input){const prompt=await readFile(join(root,input.promptPath),'utf8');return prompt.startsWith('asset-000')?new Response(JSON.stringify({error:{message:'interrupted',type:'server_error',code:'task_interrupted'}}),{status:503}):imageResponse();}}});
 const failed=(await listImageJobs(f.root)).find(j=>j.assetId==='asset-000')!;const {resolveImage}=await import('../src/images/run.js');
 await resolveImage(f.root,failed.operationId,'failed',{operationId:failed.operationId,requestHash:failed.requestHash,outcome:'failed',source:{kind:'provider-api-response',reference:`.metasocli/image-receipts/${failed.operationId}/complete.json`,statement:'Original response explicitly reports task_interrupted, preserve original bytes.'}},true,{runtimeRoot});
 const subset=(await createImagePlan(f.root,{assets:['asset-001'],profile,restartOf:first.planId})).plan;
 await runImages(f.root,subset.planId,true,{runtimeRoot,client:{async create(){return imageResponse();}}});
 const full=(await plan(f.root,subset.planId)).plan;let posts=0;
 const result=await runImages(f.root,full.planId,true,{runtimeRoot,client:{async create(){posts++;return imageResponse(3);}}});
 expect(result.summary.reused).toBe(1);expect(result.summary.registered).toBe(1);expect(posts).toBe(1);
 expect((await listImageJobs(f.root)).find(j=>j.retryOf===failed.operationId)?.status).toBe('registered');
});

it('records an explicit provider content-policy refusal as failed without resubmitting',async()=>{
 const f=await imageFixture(),runtimeRoot=join(dirname(f.root),'runtime'),p=(await plan(f.root)).plan;let posts=0;
 await runImages(f.root,p.planId,true,{runtimeRoot,client:{async create(){posts++;return new Response(JSON.stringify({error:{message:'非常抱歉，该提示可能违反了我们的内容政策。',type:'invalid_request_error',code:'upstream_text_reply'}}),{status:400});}}});
 const j=(await listImageJobs(f.root))[0]!;const {resolveImage}=await import('../src/images/run.js');
 const result=await resolveImage(f.root,j.operationId,'failed',{operationId:j.operationId,requestHash:j.requestHash,outcome:'failed',source:{kind:'provider-api-response',reference:`.metasocli/image-receipts/${j.operationId}/complete.json`,statement:'Provider explicitly refused to return an image under its content policy. Preserve original refusal; no retry.'}},true,{runtimeRoot});
 expect(result.status).toBe('failed');expect(posts).toBe(1);
});
