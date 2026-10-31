import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanup } from './helpers.js';
import { imageFixture, imageResponse, profile } from './image-api-helpers.js';
import { createImagePlan } from '../src/images/planning.js';
import { recoverImage, runImages } from '../src/images/run.js';
import { listImageJobs, readImageJob, readImageRun, saveImageJob } from '../src/images/store.js';
import { imageRuntime } from '../src/images/coordinator.js';
import { runCli } from '../src/cli/main.js';

afterEach(cleanup);
const plan=async(root:string)=>(await createImagePlan(root,{episodes:['ep-1'],profile,submissionMode:'all-ready'})).plan;
async function unknown(root:string,runtimeRoot:string){
  const p=await plan(root);
  await runImages(root,p.planId,true,{runtimeRoot,client:{async create(){return new Response('gateway',{status:502});}}});
  return (await listImageJobs(root))[0]!;
}

it('requires an explicit CLI confirmation, preserves the old unknown, and resumes the same reserved plan',async()=>{
  const old=await imageFixture(),current=await imageFixture(),other=await imageFixture();
  const runtimeRoot=join(dirname(current.root),'runtime');
  const prior=await unknown(old.root,runtimeRoot),originalBytes=await readFile(join(old.root,`.metasocli/image-jobs/${prior.operationId}.json`));
  const p=await plan(current.root);let posts=0;
  const deps={runtimeRoot,client:{async create(){posts++;return imageResponse();}}};
  const blocked=await runImages(current.root,p.planId,true,deps);
  expect(blocked.summary.started).toBe(0);expect(posts).toBe(0);
  const reserved=(await listImageJobs(current.root))[0]!.operationId;
  const args=['images','run','--root',current.root,'--plan',p.planId,'--accept-existing-unknown',prior.operationId];
  expect((await runCli(args,undefined,deps)).exitCode).not.toBe(0);expect(posts).toBe(0);
  expect((await runCli([...args,'--confirm'],undefined,deps)).exitCode).toBe(0);expect(posts).toBe(1);
  expect((await listImageJobs(current.root))[0]!.operationId).toBe(reserved);
  expect(await readFile(join(old.root,`.metasocli/image-jobs/${prior.operationId}.json`))).toEqual(originalBytes);
  expect((await readImageJob(old.root,prior.operationId)).status).toBe('submit_unknown');
  const ledger=JSON.parse(await readFile(join(imageRuntime(profile,runtimeRoot),'ledger.json'),'utf8'));
  expect(ledger.slots.find((s:any)=>s.operationId===prior.operationId).status).toBe('submit_unknown');
  const ack=(await readImageRun(current.root,p))!.authorization.acceptedExistingUnknown!;
  expect(ack).toHaveLength(1);expect(ack[0]).toMatchObject({root:old.root,operationId:prior.operationId,projectId:prior.projectId,planId:prior.planId,requestHash:prior.requestHash,fingerprint:prior.fingerprint});
  expect((await runCli(['images','resume','--root',current.root,'--plan',p.planId],undefined,deps)).exitCode).toBe(0);
  expect(posts).toBe(1);
  expect((await runCli(['images','resume','--root',current.root,'--plan',p.planId,'--accept-existing-unknown',prior.operationId],undefined,deps)).exitCode).not.toBe(0);
  const op=await plan(other.root);await runImages(other.root,op.planId,true,deps);expect(posts).toBe(1);
});

it('rejects missing and duplicate identities and cannot add an acknowledgement through resume',async()=>{
  const old=await imageFixture(),current=await imageFixture(),runtimeRoot=join(dirname(current.root),'runtime');
  const prior=await unknown(old.root,runtimeRoot),p=await plan(current.root);let posts=0;
  const deps={runtimeRoot,client:{async create(){posts++;return imageResponse();}}};
  await runImages(current.root,p.planId,true,deps);
  await expect(runImages(current.root,p.planId,true,{...deps,acceptExistingUnknown:[randomUUID()]})).rejects.toMatchObject({code:'IMAGE_SCOPE_ACK_INVALID'});
  await expect(runImages(current.root,p.planId,true,{...deps,acceptExistingUnknown:[prior.operationId,prior.operationId]})).rejects.toMatchObject({code:'IMAGE_SCOPE_ACK_INVALID'});
  await expect(runImages(current.root,p.planId,false,{...deps,acceptExistingUnknown:[prior.operationId]})).rejects.toMatchObject({code:'IMAGE_SCOPE_ACK_REQUIRED'});
  expect(posts).toBe(0);
});

it('a new current-project unknown halts dispatch and cannot be included in the old-project acknowledgement',async()=>{
  const old=await imageFixture(),current=await imageFixture(3),runtimeRoot=join(dirname(current.root),'runtime');
  const prior=await unknown(old.root,runtimeRoot),p=await plan(current.root);let posts=0;
  const deps={runtimeRoot,client:{async create(){posts++;return new Response('new gateway failure',{status:502});}}};
  await runImages(current.root,p.planId,true,{...deps,acceptExistingUnknown:[prior.operationId]});
  expect(posts).toBeGreaterThan(0);expect(posts).toBeLessThan(3);
  const before=posts,newUnknown=(await listImageJobs(current.root)).find(j=>j.status==='submit_unknown')!;
  await runImages(current.root,p.planId,false,deps);expect(posts).toBe(before);
  await expect(runImages(current.root,p.planId,true,{...deps,acceptExistingUnknown:[newUnknown.operationId]})).rejects.toMatchObject({code:'IMAGE_SCOPE_ACK_INVALID'});
  expect(posts).toBe(before);
});

it('unlisted unknowns still block the exact plan and can only be added by a new explicit confirmation',async()=>{
  const old=await imageFixture(),second=await imageFixture(),current=await imageFixture(),runtimeRoot=join(dirname(current.root),'runtime');
  const first=await unknown(old.root,runtimeRoot),next=await unknown(second.root,join(dirname(second.root),'other-runtime'));
  await recoverImage(second.root,next.operationId,{runtimeRoot});
  const p=await plan(current.root);let posts=0;const deps={runtimeRoot,client:{async create(){posts++;return imageResponse();}}};
  await runImages(current.root,p.planId,true,{...deps,acceptExistingUnknown:[first.operationId]});expect(posts).toBe(0);
  await runImages(current.root,p.planId,false,deps);
  expect(posts).toBe(0);
  const result=await runImages(current.root,p.planId,true,{...deps,acceptExistingUnknown:[next.operationId]});
  expect(result.summary.registered).toBe(1);expect(posts).toBe(1);
});

it('saved acknowledgements reject changed original request identities without any new POST',async()=>{
  const old=await imageFixture(),current=await imageFixture(),runtimeRoot=join(dirname(current.root),'runtime');
  const prior=await unknown(old.root,runtimeRoot),p=await plan(current.root);let posts=0;
  const deps={runtimeRoot,client:{async create(){posts++;return imageResponse();}}};
  await runImages(current.root,p.planId,true,{...deps,acceptExistingUnknown:[prior.operationId]});expect(posts).toBe(1);
  await saveImageJob(old.root,{...prior,requestHash:'a'.repeat(64)});
  await expect(runImages(current.root,p.planId,false,deps)).rejects.toMatchObject({code:'IMAGE_JOB_CONFLICT'});
  expect(posts).toBe(1);
});
