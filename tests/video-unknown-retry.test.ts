import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { cleanup, fixture, imported, mp4, png } from './helpers.js';
import { batchFixture, evidence } from './batch-helpers.js';
import { createPlan, validatePlan } from '../src/core/planning.js';
import { importStory } from '../src/core/project.js';
import { registerAsset } from '../src/assets/registry.js';
import { wav } from './audio-fixtures.js';
import { submit } from '../src/jobs/submit.js';
import { resume, attachTask } from '../src/jobs/resume.js';
import { listJobs, persistence, readJob } from '../src/jobs/store.js';
import { authorizeVideoRetry, listVideoRetries, retryPath } from '../src/jobs/video-retry.js';
import { occupied, reconcileRuntime, blockingSlots } from '../src/jobs/coordinator.js';
import { runBatch } from '../src/jobs/batch.js';
import { batchStatus } from '../src/jobs/batch-store.js';
import { runCli } from '../src/cli/main.js';
import { MetasoClient, ProviderError, type VideoClient } from '../src/metaso/client.js';
import { canonicalSha256 } from '../src/storage/canonical.js';
import { loadStory } from '../src/core/project.js';
afterEach(cleanup);
async function setup() {
  const f = await imported(), plan = await createPlan(f.root, 'ep-1');
  const calls: unknown[] = [];
  const client: VideoClient = { async create(request) { calls.push(request); throw new Error('lost after POST'); }, async query(taskId) { return { taskId, status: 'running', rawStatus: 'running', evidence }; } };
  const old = await submit(f.root, plan.planId, 's1', true, { client });
  const args = ['generate','--root',f.root,'--plan',plan.planId,'--segment','s1','--retry-of',old.operationId,'--confirm','--accept-unknown-result','--submit-only'];
  return { ...f, plan, old, client, calls, args };
}
it('defaults remain sticky; explicit CLI authorization makes one stable attempt, preserving the original unknown slot', async () => {
  const f = await setup();
  await expect(resume(f.root, f.old.operationId, { client: f.client })).rejects.toMatchObject({ code: 'SUBMIT_UNKNOWN' });
  await submit(f.root, f.plan.planId, 's1', true, { client: f.client });
  expect((await runCli(f.args.filter(a => a !== '--accept-unknown-result'), { client: f.client })).data).toMatchObject({ error: { code: 'RETRY_FORBIDDEN' } });
  f.client.create = async request => { f.calls.push(request); return { taskId: 'new-task', evidence }; };
  const result = await runCli(f.args, { client: f.client });
  expect(result).toMatchObject({ exitCode: 0, data: { jobs: [{ status: 'queued', taskId: 'new-task', attempt: 2, retryOf: f.old.operationId }] } });
  for (let i = 0; i < 3; i++) expect((await runCli(f.args, { client: f.client })).exitCode).toBe(0);
  expect(f.calls).toHaveLength(2); expect(f.calls[1]).toEqual(f.calls[0]);
  expect(await readJob(f.root, f.old.operationId)).toMatchObject({ status: 'submit_unknown', operationId: f.old.operationId });
  expect(occupied(await reconcileRuntime(f.root))).toHaveLength(2);
});
it('preserves exact original text, decimal duration, image order and narration bytes through an actual request adapter', async () => {
  const f = await fixture('镜头 {{ref:b}} 与 {{ref:a}}。旁白：天亮了。\n'), start = f.text.indexOf('天亮了。');
  await importStory(f.root, { ...f.draft, recipes: [{assetId:'a',kind:'character',prompt:'人物'},{assetId:'b',kind:'scene',prompt:'场景'},{assetId:'n',kind:'narration',prompt:'原旁白'}],
    segments: [{ ...f.draft.segments[0], duration:6.963, references:[{assetId:'b',role:'reference_image'},{assetId:'a',role:'reference_image'}], narration:{assetId:'n',cues:[{start,end:start+4}]} }] });
  for (const [id, bytes] of [['a',png()],['b',png(512,512)],['n',wav(3.125)]] as const) {
    const file=join(dirname(f.root),id+(id==='n'?'.wav':'.png')); await writeFile(file,bytes); await registerAsset(f.root,id,{file});
  }
  const manifest=await readFile(join(f.root,'metasocli.yaml')), plan=await createPlan(f.root,'ep-1'), requests:unknown[]=[];
  const client=new MetasoClient('offline',async(_url,init)=>{ requests.push(JSON.parse(String(init?.body))); if(requests.length===1)throw new TypeError('timeout'); return Response.json({task_id:'audio-retry'}); });
  const old=await submit(f.root,plan.planId,'s1',true,{client});
  const job=await submit(f.root,plan.planId,'s1',true,{client},old.operationId,true);
  expect(requests).toEqual(Array(2).fill((await validatePlan(f.root,plan)).built[0]!.request));
  expect(job.inputHash).toBe(old.inputHash); expect(job.requestHash).toBe(old.requestHash);
  expect(await readFile(join(f.root,'metasocli.yaml'))).toEqual(manifest);
});
it('task5 retry waits behind three accepted tasks plus its old unknown, then has priority and replenishes the saved scope', async () => {
  const f=await batchFixture([7]), trace:unknown[]=[], posts:number[]=[];
  let continuing=false, attempts5=0, terminal2=false, new5=false;
  const client:VideoClient={
    async create(request){
      const text=request.content[0]; if(text?.type!=='text')throw new Error('text');
      const n=Number(/第1集第(\d+)段/u.exec(text.text)![1]); posts.push(n);
      const ledger=await reconcileRuntime(f.root); expect(occupied(ledger).length).toBeLessThanOrEqual(4);
      trace.push({event:'POST',n,occupied:occupied(ledger).map(s=>({operationId:s.operationId,status:s.status}))});
      if(n===5){attempts5++;if(attempts5===1)throw new Error('unknown');expect(terminal2).toBe(true);new5=true;}
      if(n>5)expect(new5).toBe(true);
      return {taskId:'task-'+n+'-'+posts.length,evidence};
    },
    async query(taskId){const n=Number(taskId.split('-')[1]);const done=n===1||continuing;
      if(done&&n===2)terminal2=true;
      trace.push({event:'GET',taskId,done});return {taskId,status:done?'generated':'running',rawStatus:done?'succeeded':'running',duration:7,url:'https://example.com/test.mp4',evidence};}
  };
  const deps={client,fetcher:async()=>new Response(mp4(7))};
  await runBatch(f.root,f.batch.plan.batchId,true,deps,{maxPolls:1,pollIntervalMs:0});
  expect(posts).toEqual([1,2,3,4,5]);
  const old=(await listJobs(f.root)).find(j=>j.segmentId==='s5')!, item=f.batch.plan.items[4]!;
  const args=['generate','--root',f.root,'--plan',item.planId,'--segment','s5','--retry-of',old.operationId,'--confirm','--accept-unknown-result','--submit-only'];
  const waiting=await runCli(args,deps);
  expect(waiting).toMatchObject({exitCode:2,data:{jobs:[{status:'prepared'}],videoRetries:[{phase:'waiting_capacity'}]}});
  const candidate=(await listVideoRetries(f.root))[0]!.newOperationId;
  expect(posts).toHaveLength(5); expect(occupied(await reconcileRuntime(f.root))).toHaveLength(4);
  continuing=true;
  const result=await runCli(['batch','retry','--root',f.root,'--batch',f.batch.plan.batchId,'--operation',old.operationId,'--confirm','--accept-unknown-result','--poll-ms','0','--max-polls','10'],deps);
  expect(result).toMatchObject({exitCode:0,data:{summary:{reusable:7}}});
  expect(posts).toEqual([1,2,3,4,5,5,6,7]);
  expect((await batchStatus(f.root,f.batch.plan.batchId)).items[4]!.job!.operationId).toBe(candidate);
  expect(occupied(await reconcileRuntime(f.root))).toMatchObject([{operationId:old.operationId,status:'submit_unknown'}]);
  await runCli(args,deps);expect(posts).toHaveLength(8);
  const folder=resolve('.work/unknown-video-retry-20261016');await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'replenishment.json'),JSON.stringify({fakeOnly:true,posts,oldOperationId:old.operationId,newOperationId:candidate,trace,result},null,2));
},180000);
it('a second unknown needs another explicit authorization targeting the new local operation; original command never creates a third POST', async()=>{
  const f=await setup();
  await runCli(f.args,{client:f.client});
  const child=(await listJobs(f.root)).at(-1)!;
  for(let i=0;i<2;i++)await runCli(f.args,{client:f.client});
  expect(f.calls).toHaveLength(2);
  await submit(f.root,f.plan.planId,'s1',true,{client:f.client},child.operationId,true);
  expect(f.calls).toHaveLength(3);
  expect((await listJobs(f.root)).map(j=>j.status)).toEqual(['submit_unknown','submit_unknown','submit_unknown']);
});
it.each(['retry-authorization','retry-job','reserved','intent','receipt'])('recovers durable identity at %s without duplicating any ambiguous POST',async point=>{
  const f=await setup();f.client.create=async request=>{f.calls.push(request);return {taskId:'recover-'+point,evidence};};
  let fired=false;
  await expect(submit(f.root,f.plan.planId,'s1',true,{client:f.client,checkpoint:async event=>{if(event===point&&!fired){fired=true;throw new Error('crash');}}},f.old.operationId,true)).rejects.toThrow();
  const a=(await listVideoRetries(f.root))[0]!;
  const result=await submit(f.root,f.plan.planId,'s1',true,{client:f.client},f.old.operationId,true);
  expect(result.operationId).toBe(a.newOperationId);
  expect(f.calls.length).toBe(point==='intent'?1:2);
  expect(result.status).toBe(point==='intent'?'submit_unknown':'queued');
  await submit(f.root,f.plan.planId,'s1',true,{client:f.client},f.old.operationId,true);
  expect(f.calls.length).toBe(point==='intent'?1:2);
});
it('recovering the original receipt before a waiting retry cancels only the provably unstarted child',async()=>{
  const f=await setup();const auth=await authorizeVideoRetry(f.root,f.plan.planId,'s1',f.old.operationId,true,true);
  await attachTask(f.root,f.old.operationId,'restored-original',true,{client:f.client});
  const result=await runCli(f.args,{client:f.client});
  expect(result).toMatchObject({exitCode:0,data:{jobs:[{operationId:f.old.operationId,taskId:'restored-original'}],videoRetries:[{phase:'original_recovered'}]}});
  expect((await readJob(f.root,auth.authorization.newOperationId)).lastError?.code).toBe('RETRY_SUPERSEDED');expect(f.calls).toHaveLength(1);
});
it('four acknowledged unknowns keep all slots and stop a batch iteration with an accurate no-queryable-tasks result',async()=>{
  const f=await batchFixture([4]);let posts=0,queries=0;
  const client:VideoClient={async create(){posts++;throw new Error('lost');},async query(){queries++;throw new Error('no IDs');}};
  for(const item of f.batch.plan.items){const old=await submit(f.root,item.planId,item.segmentId,true,{client});await authorizeVideoRetry(f.root,item.planId,item.segmentId,old.operationId,true,true);}
  const result=await runBatch(f.root,f.batch.plan.batchId,true,{client},{maxPolls:1,pollIntervalMs:0});
  expect(result.run!.trace.some(t=>t.event==='waiting-capacity-no-queryable-tasks')).toBe(true);
  expect(result.retries.every(r=>r.phase==='waiting_capacity')).toBe(true);expect(posts).toBe(4);expect(queries).toBe(0);
  expect(occupied(await reconcileRuntime(f.root))).toHaveLength(4);
},90000);
it('batch retry without prior scope authorization only sends the specifically authorized segment',async()=>{
  const f=await batchFixture([3]);let posts=0;
  const client:VideoClient={async create(){posts++;if(posts===1)throw new Error('lost');return {taskId:'specific',evidence};},async query(taskId){return {taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://example.com/fake.mp4',evidence};}};
  const item=f.batch.plan.items[1]!, old=await submit(f.root,item.planId,item.segmentId,true,{client});
  const deps={client,fetcher:async()=>new Response(mp4(7))};
  const result=await runCli(['batch','retry','--root',f.root,'--batch',f.batch.plan.batchId,'--operation',old.operationId,'--confirm','--accept-unknown-result','--poll-ms','0'],deps);
  expect(result).toMatchObject({exitCode:2,data:{summary:{reusable:1,pending:2},run:{authorization:{retryOnly:expect.any(Array)}}}});
  await runCli(['batch','resume','--root',f.root,'--batch',f.batch.plan.batchId,'--poll-ms','0'],deps);expect(posts).toBe(2);
},90000);
it('rejects wrong identity, missing authorization, known tasks, other-project unknowns and tampered authorization before POST',async()=>{
  const f=await setup();
  expect((await runCli(f.args.filter(s=>s!=='--confirm'),{client:f.client})).data).toMatchObject({error:{code:'GENERATION_NOT_AUTHORIZED'}});
  expect((await runCli(['generate','--root',f.root,'--plan',f.plan.planId,'--confirm','--accept-unknown-result'],{client:f.client})).data).toMatchObject({error:{code:'CLI_ARGUMENT'}});
  const second=await imported(), other=await createPlan(second.root,'ep-1');
  await expect(authorizeVideoRetry(second.root,other.planId,'s1',f.old.operationId,true,true)).rejects.toMatchObject({code:'RETRY_FORBIDDEN'});
  const a=await authorizeVideoRetry(f.root,f.plan.planId,'s1',f.old.operationId,true,true);
  const ledger=await reconcileRuntime(second.root);
  expect(await blockingSlots(second.root,ledger)).toHaveLength(1);
  await expect(submit(second.root,other.planId,'s1',true,{client:f.client})).rejects.toMatchObject({code:'SUBMIT_UNKNOWN'});
  await writeFile(await retryPath(f.root,f.old.operationId),JSON.stringify({...a.authorization,inputHash:'0'.repeat(64)}));
  await expect(submit(f.root,f.plan.planId,'s1',true,{client:f.client},f.old.operationId,true)).rejects.toMatchObject({code:'RETRY_CONFLICT'});
  expect(f.calls).toHaveLength(1);
});
it('records bounded redacted transport diagnostics including headers, cause code, HTTP status and request ID',async()=>{
  const f=await imported(),plan=await createPlan(f.root,'ep-1');
  const client=new MetasoClient('secret-key',async()=>new Response(new ReadableStream({start(c){c.error(Object.assign(new TypeError('secret-key https://signed.example/token'),{cause:{code:'ECONNRESET'}}));}}),{status:200,headers:{'x-request-id':'request-123'}}));
  const job=await submit(f.root,plan.planId,'s1',true,{client});
  const raw=await readFile(join(f.root,'.metasocli/receipts',job.operationId+'-create-error.json'),'utf8');
  expect(JSON.parse(raw)).toMatchObject({diagnostics:{stage:'response-body',receivedHeaders:true,httpStatus:200,requestId:'request-123',errorName:'TypeError',errorCode:'ECONNRESET'}});
  expect(raw).not.toContain('secret-key');expect(raw).not.toContain('signed.example');
  const bodyClient=new MetasoClient('offline',async()=>Response.json({request_id:'body-request-id',error:'unavailable'},{status:503}));
  await expect(bodyClient.create((await validatePlan(f.root,plan)).built[0]!.request)).rejects.toMatchObject({options:{diagnostics:{stage:'response-contract',requestId:'body-request-id',httpStatus:503,receivedHeaders:true}}});
});
it('rechecks original receipt after preflight and before reservation, and rebuilds the batch index on that original',async()=>{
  const f=await batchFixture([1]);let posts=0;
  const client:VideoClient={async create(){posts++;throw new Error('lost');},async query(taskId){return {taskId,status:'running',rawStatus:'running',evidence};}};
  await runBatch(f.root,f.batch.plan.batchId,true,{client},{maxPolls:1,pollIntervalMs:0});
  const old=(await listJobs(f.root))[0]!,item=f.batch.plan.items[0]!;
  await authorizeVideoRetry(f.root,item.planId,item.segmentId,old.operationId,true,true);
  client.prepare=async()=>{delete client.prepare;await attachTask(f.root,old.operationId,'found-before-reservation',true,{client});};
  const result=await runBatch(f.root,f.batch.plan.batchId,false,{client},{maxPolls:1,pollIntervalMs:0});
  expect(result.items[0]!.job!.operationId).toBe(old.operationId);expect(result.run!.items[0]!.operationId).toBe(old.operationId);
  expect(result.retries[0]!.phase).toBe('original_recovered');expect(posts).toBe(1);
});
it('one-attempt unknown authorization does not inherit the batch automatic 429 retry budget',async()=>{
  const f=await batchFixture([1]);let posts=0;
  const client:VideoClient={async create(){posts++;if(posts===1)throw new Error('lost');throw new ProviderError('HTTP','rejected',{rejected:true,httpStatus:429,safeToRetry:true});},async query(){throw new Error('no ID');}};
  await runBatch(f.root,f.batch.plan.batchId,true,{client},{maxPolls:1,pollIntervalMs:0});
  const old=(await listJobs(f.root))[0]!;
  const args=['batch','retry','--root',f.root,'--batch',f.batch.plan.batchId,'--operation',old.operationId,'--confirm','--accept-unknown-result','--poll-ms','0'];
  await runCli(args,{client});await runCli(args,{client});expect(posts).toBe(2);
});
it('refuses stale sources, wrong segment/input, legacy false plans, known query failures, and nonlatest unknowns',async()=>{
  const f=await setup();
  await expect(authorizeVideoRetry(f.root,f.plan.planId,'absent',f.old.operationId,true,true)).rejects.toMatchObject({code:'INLINE_IR_REQUIRED'});
  const { workflow: _workflow, ...legacyBase } = f.plan;
  const falsePlan={...legacyBase,segments:f.plan.segments.map(s=>({...s,contextIr:false}))};
  const {planHash:_,...base}=falsePlan;falsePlan.planHash=canonicalSha256(base);
  const path=join(f.root,'.metasocli/plans',f.plan.planId+'.json');await writeFile(path,JSON.stringify(falsePlan));
  expect((await runCli(f.args,{client:f.client})).data).toMatchObject({error:{code:'INLINE_IR_REQUIRED'}});
  await writeFile(path,JSON.stringify(f.plan));
  const story=await loadStory(f.root),source=join(f.root,story.episodes[0]!.source.textPath),original=await readFile(source);
  await writeFile(source,'changed');await expect(authorizeVideoRetry(f.root,f.plan.planId,'s1',f.old.operationId,true,true)).rejects.toMatchObject({code:'SOURCE_CHANGED'});
  await writeFile(source,original);
  const later={...f.old,operationId:crypto.randomUUID(),attempt:2,createdAt:new Date(Date.now()+1000).toISOString()};await persistence.job(f.root,later);
  await expect(authorizeVideoRetry(f.root,f.plan.planId,'s1',f.old.operationId,true,true)).rejects.toMatchObject({code:'RETRY_FORBIDDEN'});
  await persistence.receipt(f.root,{operationId:later.operationId,requestHash:later.requestHash,taskId:'known-query',receivedAt:new Date().toISOString(),recoveredManually:true});
  await expect(authorizeVideoRetry(f.root,f.plan.planId,'s1',later.operationId,true,true)).rejects.toMatchObject({code:'RETRY_FORBIDDEN'});
  expect(f.calls).toHaveLength(1);
});
it('never recreates a deleted retry job when durable submission evidence remains',async()=>{
  const f=await setup();await runCli(f.args,{client:f.client});const a=(await listVideoRetries(f.root))[0]!;
  await unlink(join(f.root,'.metasocli/jobs',a.newOperationId+'.json'));
  expect((await runCli(f.args,{client:f.client})).data).toMatchObject({error:{code:'RETRY_CONFLICT'}});expect(f.calls).toHaveLength(2);
  // Even if the owner record is also unavailable, the shared slot is not permission to reset.
  await unlink(join(f.root,'.metasocli/submissions',a.newOperationId+'.json'));
  expect((await runCli(f.args,{client:f.client})).data).toMatchObject({error:{code:'RETRY_CONFLICT'}});expect(f.calls).toHaveLength(2);
});
it('cannot change the plan of a waiting retry or send a prepared record containing an earlier submission intent',async()=>{
  const f=await setup(),a=await authorizeVideoRetry(f.root,f.plan.planId,'s1',f.old.operationId,true,true);
  const sameInputPlan=await createPlan(f.root,'ep-1');
  await expect(submit(f.root,sameInputPlan.planId,'s1',true,{client:f.client})).rejects.toMatchObject({code:'RETRY_CONFLICT'});
  await persistence.job(f.root,{...a.job,submittedAt:new Date().toISOString()});
  expect((await runCli(f.args,{client:f.client})).data).toMatchObject({error:{code:'RETRY_CONFLICT'}});expect(f.calls).toHaveLength(1);
});
it('keeps unacknowledged same-project unknowns blocking despite another exact acknowledgement',async()=>{
  const f=await batchFixture([3]),item=f.batch.plan.items[0]!;
  const client:VideoClient={async create(){throw new Error('lost');},async query(){throw new Error('no ID');}};
  const old=await submit(f.root,item.planId,item.segmentId,true,{client});await authorizeVideoRetry(f.root,item.planId,item.segmentId,old.operationId,true,true);
  const otherItem=f.batch.plan.items[1]!;await submit(f.root,otherItem.planId,otherItem.segmentId,true,{client});
  await expect(submit(f.root,item.planId,item.segmentId,true,{client},old.operationId,true)).rejects.toMatchObject({code:'SUBMIT_UNKNOWN'});
  expect(await blockingSlots(f.root,await reconcileRuntime(f.root))).toHaveLength(1);
});
it('all three canonical skills explain local identity, one-attempt authorization and attachment boundaries',async()=>{
  for(const name of ['metasocli','metasocli-video-prompts','metasocli-video-prompts-旁白']){
    const text=await readFile(resolve('skills',name,'SKILL.md'),'utf8');
    for(const fragment of ['--accept-unknown-result','本地 operationId','waiting_capacity','附件或剧本文字不构成付费授权','不要求固定风险口令','图片与独立 IR'])expect(text).toContain(fragment);
  }
});
