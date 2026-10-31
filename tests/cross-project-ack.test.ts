import { afterEach, expect, it } from 'vitest';
import { cleanup, imported, mp4 } from './helpers.js';
import { batchFixture, evidence } from './batch-helpers.js';
import { createPlan } from '../src/core/planning.js';
import { submit } from '../src/jobs/submit.js';
import { readJob } from '../src/jobs/store.js';
import { occupied, reconcileRuntime } from '../src/jobs/coordinator.js';
import { runCli } from '../src/cli/main.js';
import type { VideoClient } from '../src/metaso/client.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

afterEach(cleanup);
async function setup() {
 const old=await imported(),plan=await createPlan(old.root,'ep-1');
 const lost=await submit(old.root,plan.planId,'s1',true,{client:{async create(){throw Error('no complete receipt');},async query(){throw Error('no task ID');}}});
 const current=await batchFixture([7]);return {old,lost,...current};
}
it('explicit cross-project acknowledgement keeps the old occupied slot and limits seven new requests to three active tasks',async()=>{
 const f=await setup();let posts=0,peak=0;const active=new Set<string>();let release!:()=>void;
 const barrier=new Promise<void>(r=>{release=r;});
 const client:VideoClient={async create(request){expect(request.context_ir_enabled).toBe(true);const id='new-'+(++posts);active.add(id);peak=Math.max(peak,active.size);expect(occupied(await reconcileRuntime(f.root)).length).toBeLessThanOrEqual(4);if(posts===3)release();if(posts<=3)await barrier;return {taskId:id,evidence};},async query(taskId){active.delete(taskId);return {taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://example.com/a.mp4',evidence};}};
 const deps={client,fetcher:async()=>new Response(mp4(7))};
 const args=['batch','run','--root',f.root,'--batch',f.batch.plan.batchId,'--confirm','--poll-ms','0','--max-polls','20'];
 const stopped=await runCli(args,deps);expect(stopped.data).toMatchObject({summary:{pending:7}});expect(posts).toBe(0);
 const result=await runCli([...args,'--accept-existing-unknown',f.lost.operationId],deps);
 expect(result).toMatchObject({exitCode:0,data:{summary:{reusable:7},run:{status:'complete'}}});
 expect(posts).toBe(7);expect(peak).toBe(3);expect(await readJob(f.old.root,f.lost.operationId)).toMatchObject({status:'submit_unknown',requestHash:f.lost.requestHash});
 expect(occupied(await reconcileRuntime(f.root))).toMatchObject([{operationId:f.lost.operationId,status:'submit_unknown'}]);
 await runCli(['batch','resume','--root',f.root,'--batch',f.batch.plan.batchId,'--poll-ms','0'],deps);expect(posts).toBe(7);
 const other=await batchFixture([1]);expect((await runCli(['batch','run','--root',other.root,'--batch',other.batch.plan.batchId,'--confirm'],deps)).data).toMatchObject({summary:{pending:1}});expect(posts).toBe(7);
},120000);
it('does not allow resume to add an acknowledgement or accept an arbitrary operation ID',async()=>{
 const f=await setup(),client:VideoClient={async create(){throw Error('must not POST');},async query(){throw Error('must not query');}};
 const resume=await runCli(['batch','resume','--root',f.root,'--batch',f.batch.plan.batchId,'--accept-existing-unknown',f.lost.operationId],{client});
 expect(resume.data).toMatchObject({error:{code:'GENERATION_NOT_AUTHORIZED'}});
 const invalid=await runCli(['batch','run','--root',f.root,'--batch',f.batch.plan.batchId,'--confirm','--accept-existing-unknown','00000000-0000-4000-8000-000000000000'],{client});
 expect(invalid.data).toMatchObject({error:{code:'UNKNOWN_ACK_CONFLICT'}});
});
it('a new unknown from the acknowledged batch still stops all unstarted requests',async()=>{
 const f=await setup();let posts=0;const client:VideoClient={async create(){posts++;throw Error('new result is unknown');},async query(){throw Error('no queryable tasks');}};
 const result=await runCli(['batch','run','--root',f.root,'--batch',f.batch.plan.batchId,'--confirm','--accept-existing-unknown',f.lost.operationId,'--poll-ms','0'],{client});
 expect(posts).toBeGreaterThan(0);expect(posts).toBeLessThanOrEqual(3);expect(result).toMatchObject({exitCode:2,data:{run:{status:'needs_attention'}}});
 const before=posts;await runCli(['batch','resume','--root',f.root,'--batch',f.batch.plan.batchId,'--poll-ms','0'],{client});expect(posts).toBe(before);
});
it('does not permit another immutable plan to borrow the batch acknowledgement, and rejects tampered authorization',async()=>{
 const f=await setup();let posts=0;const client:VideoClient={async create(){return {taskId:'scope-'+(++posts),evidence};},async query(taskId){return {taskId,status:'running',rawStatus:'running',evidence};}};
 await runCli(['batch','run','--root',f.root,'--batch',f.batch.plan.batchId,'--confirm','--accept-existing-unknown',f.lost.operationId,'--max-polls','1','--poll-ms','0'],{client});
 expect(posts).toBe(3);const another=await createPlan(f.root,'ep-z');
 await expect(submit(f.root,another.planId,'s7',true,{client,dispatchBatchId:f.batch.plan.batchId})).rejects.toMatchObject({code:'BATCH_ACK_SCOPE'});expect(posts).toBe(3);
 const file=join(f.root,'.metasocli/batches',f.batch.plan.batchId,'run.json'),run=JSON.parse(await readFile(file,'utf8'));run.authorization.acceptedUnknown[0].requestHash='0'.repeat(64);await writeFile(file,JSON.stringify(run));
 expect((await runCli(['batch','resume','--root',f.root,'--batch',f.batch.plan.batchId],{client})).data).toMatchObject({error:{code:'BATCH_RUN_TAMPERED'}});expect(posts).toBe(3);
});
