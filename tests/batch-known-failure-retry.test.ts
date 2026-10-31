import { afterEach, expect, it } from 'vitest';
import { cleanup, imported, mp4 } from './helpers.js';
import { batchFixture, evidence } from './batch-helpers.js';
import { createPlan } from '../src/core/planning.js';
import { submit } from '../src/jobs/submit.js';
import { listJobs, readJob } from '../src/jobs/store.js';
import { occupied, reconcileRuntime } from '../src/jobs/coordinator.js';
import { runCli } from '../src/cli/main.js';
import { authorizeBatchRetry } from '../src/jobs/batch.js';
import { ProviderError, type VideoClient } from '../src/metaso/client.js';

afterEach(cleanup);
async function setup(count=2) {
 const old=await imported(),oldPlan=await createPlan(old.root,'ep-1');
 const lost=await submit(old.root,oldPlan.planId,'s1',true,{client:{async create(){throw Error('old missing receipt');},async query(){throw Error('no task ID');}}});
 const f=await batchFixture([count]);let posts=0,mode:'balance'|'success'|'unknown'|'safe429'='balance';
 const client:VideoClient={async create(request){expect(request.context_ir_enabled).toBe(true);posts++;if(mode==='balance')throw new ProviderError('HTTP_402','credits exhausted',{rejected:true,httpStatus:402,evidence});if(mode==='unknown')throw Error('new missing receipt');if(mode==='safe429')throw new ProviderError('HTTP_429','not accepted',{rejected:true,httpStatus:429,safeToRetry:true,evidence});return {taskId:'after-topup-'+posts,evidence};},async query(taskId){return {taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://example.com/out.mp4',evidence};}};
 const deps={client,fetcher:async()=>new Response(mp4(7))};
 const first=await runCli(['batch','run','--root',f.root,'--batch',f.batch.plan.batchId,'--confirm','--accept-existing-unknown',lost.operationId,'--poll-ms','0'],deps);
 expect(first.exitCode).toBe(2);expect(posts).toBe(1);
 const failed=(await listJobs(f.root)).find(j=>j.status==='failed')!;expect(failed).toBeDefined();
 const args=['batch','retry','--root',f.root,'--batch',f.batch.plan.batchId,'--operation',failed.operationId,'--confirm','--poll-ms','0'];
 return {...f,old,lost,failed,deps,args,get posts(){return posts;},setMode(value:typeof mode){mode=value;}};
}
it('after a confirmed 402 failure, retries once inside the original acknowledged batch, preserves the old slot, and continues the remaining authorized items',async()=>{
 const f=await setup();f.setMode('success');
 const result=await runCli(f.args,f.deps);
 expect(result).toMatchObject({exitCode:0,data:{summary:{reusable:2},run:{status:'complete'}}});expect(f.posts).toBe(3);
 expect((await listJobs(f.root)).filter(j=>j.retryOf===f.failed.operationId)).toHaveLength(1);
 expect(await readJob(f.root,f.failed.operationId)).toMatchObject({status:'failed'});
 expect(occupied(await reconcileRuntime(f.root))).toMatchObject([{operationId:f.lost.operationId,status:'submit_unknown'}]);
 await runCli(f.args,f.deps);expect(f.posts).toBe(3);
},60000);
it('persists the explicit failed retry before dispatch, so an ordinary batch resume survives interruption before the POST',async()=>{
 const f=await setup(1);f.setMode('success');
 await authorizeBatchRetry(f.root,f.batch.plan.batchId,f.failed.operationId,true,false);
 expect(f.posts).toBe(1);
 const result=await runCli(['batch','resume','--root',f.root,'--batch',f.batch.plan.batchId,'--poll-ms','0'],f.deps);
 expect(result).toMatchObject({exitCode:0,data:{summary:{reusable:1}}});expect(f.posts).toBe(2);
},60000);
it.each(['balance','unknown','safe429'] as const)('never repeats a new %s outcome under the old failed-operation authorization',async mode=>{
 const f=await setup(1);f.setMode(mode);
 await runCli(f.args,f.deps);expect(f.posts).toBe(2);
 const children=(await listJobs(f.root)).filter(j=>j.retryOf===f.failed.operationId);expect(children).toHaveLength(1);
 await runCli(f.args,f.deps);
 await runCli(['batch','resume','--root',f.root,'--batch',f.batch.plan.batchId,'--poll-ms','0'],f.deps);
 expect(f.posts).toBe(2);expect((await listJobs(f.root)).filter(j=>j.retryOf===f.failed.operationId)).toHaveLength(1);
},60000);
it('refuses a failed-task retry without current confirmation and does not send another request',async()=>{
 const f=await setup(1);f.setMode('success');
 const result=await runCli(f.args.filter(v=>v!=='--confirm'),f.deps);
 expect(result).toMatchObject({exitCode:2,data:{error:{code:'GENERATION_NOT_AUTHORIZED'}}});expect(f.posts).toBe(1);
},60000);
