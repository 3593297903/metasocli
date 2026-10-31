import {afterEach,expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {cleanup} from './helpers.js';
import {imageFixture,imageResponse,profile} from './image-api-helpers.js';
import {createImagePlan} from '../src/images/planning.js';
import {runImages} from '../src/images/run.js';
import {listImageJobs,readImageRun} from '../src/images/store.js';
import {imageRuntime} from '../src/images/coordinator.js';

afterEach(cleanup);
const plan=async(root:string,restartOf?:string)=>(await createImagePlan(root,{episodes:['ep-1'],profile,submissionMode:'all-ready',...(restartOf?{restartOf}:{})})).plan;

it('resumes a saved authorized retry across multiple acknowledged unknown ancestors without changing them',async()=>{
 const f=await imageFixture(),runtimeRoot=join(dirname(f.root),'runtime');let posts=0;
 const unknown={runtimeRoot,client:{async create(){posts++;return new Response('gateway',{status:502});}}};
 const a=await plan(f.root);await runImages(f.root,a.planId,true,unknown);
 const b=await plan(f.root,a.planId);await runImages(f.root,b.planId,true,unknown,undefined,true);
 const originals=await listImageJobs(f.root);
 const oldBytes=await Promise.all(originals.map(j=>readFile(join(f.root,`.metasocli/image-jobs/${j.operationId}.json`))));
 const c=await plan(f.root,b.planId);let reserved='';
 await expect(runImages(f.root,c.planId,true,{runtimeRoot,client:{async create(){posts++;return imageResponse();}},checkpoint:async(point,job)=>{
  if(point==='job-reserved'){reserved=job.operationId;throw Error('stop before the reserved job is persisted');}
 }},undefined,true)).rejects.toThrow('stop before the reserved job is persisted');
 expect(posts).toBe(2);expect(reserved).not.toBe('');
 const saved=(await readImageRun(f.root,c))!;
 expect(saved.authorization.maxRequests).toBe(1);expect(saved.authorization.acceptedUnknown).toHaveLength(2);
 const result=await runImages(f.root,c.planId,false,{runtimeRoot,client:{async create(){posts++;return imageResponse();}}});
 expect(result.summary.registered).toBe(1);expect(posts).toBe(3);
 const jobs=await listImageJobs(f.root),latest=jobs.find(j=>j.operationId===reserved)!;
 expect(latest).toMatchObject({status:'registered',attempt:3,retryOf:originals.find(j=>j.planId===b.planId)!.operationId});
 expect((await readImageRun(f.root,c))!.authorization).toEqual(saved.authorization);
 for(let i=0;i<originals.length;i++)expect(await readFile(join(f.root,`.metasocli/image-jobs/${originals[i]!.operationId}.json`))).toEqual(oldBytes[i]);
 const ledger=JSON.parse(await readFile(join(imageRuntime(profile,runtimeRoot),'ledger.json'),'utf8'));
 expect(ledger.slots.filter((s:{status:string})=>s.status==='submit_unknown')).toHaveLength(2);
 await runImages(f.root,c.planId,false,{runtimeRoot,client:{async create(){posts++;return imageResponse();}}});expect(posts).toBe(3);
});

it('keeps a five-request retry budget and the ten acknowledged older unknown slots',async()=>{
 const f=await imageFixture(5),runtimeRoot=join(dirname(f.root),'runtime');let posts=0;
 function unknownBatch(){const pending:Array<(r:Response)=>void>=[];return {runtimeRoot,client:{async create(){posts++;return new Promise<Response>(resolve=>{
  pending.push(resolve);if(pending.length===5)for(const release of pending)release(new Response('gateway',{status:502}));
 })}}};}
 const a=await plan(f.root);await runImages(f.root,a.planId,true,unknownBatch());
 const b=await plan(f.root,a.planId);await runImages(f.root,b.planId,true,unknownBatch(),undefined,true);
 expect(posts).toBe(10);
 const c=await plan(f.root,b.planId);
 const result=await runImages(f.root,c.planId,true,{runtimeRoot,client:{async create(){posts++;return imageResponse();}}},undefined,true);
 expect(result.summary.registered).toBe(5);expect(posts).toBe(15);
 expect(result.run!.authorization.maxRequests).toBe(5);expect(result.run!.authorization.acceptedUnknown).toHaveLength(10);
 const jobs=await listImageJobs(f.root);expect(jobs.filter(j=>j.status==='submit_unknown')).toHaveLength(10);
 expect(jobs.filter(j=>j.planId===c.planId)).toHaveLength(5);
 await runImages(f.root,c.planId,false,{runtimeRoot,client:{async create(){posts++;return imageResponse();}}});expect(posts).toBe(15);
});
