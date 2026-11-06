import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile, rename, link, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, mp4 } from './helpers.js';
import { batchFixture, evidence } from './batch-helpers.js';
import { runCli } from '../src/cli/main.js';
import { createBatchPlan, loadBatchRun, saveBatchRun } from '../src/jobs/batch-store.js';
import { importStory } from '../src/core/project.js';
import * as planning from '../src/core/planning.js';
import { authorizeBatchRetry } from '../src/jobs/batch.js';
import { attachTask, resume } from '../src/jobs/resume.js';
import { authorizeVideoRetry, retryPath } from '../src/jobs/video-retry.js';
import { inspectRuntime, runtimeDirectory } from '../src/jobs/coordinator.js';
import { listJobs, readJob } from '../src/jobs/store.js';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../src/storage/canonical.js';
import type { VideoClient } from '../src/metaso/client.js';

afterEach(async()=>{vi.restoreAllMocks();await cleanup();});
const net=(prefix:string, failed=false)=>{
  const calls={post:0, get:[] as string[], download:0};
  const client:VideoClient={
    async create(){return {taskId:prefix+'-'+ ++calls.post,evidence};},
    async query(taskId){calls.get.push(taskId);return failed ? {taskId,status:'failed',rawStatus:'failed',evidence}
      : {taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://example.test/test.mp4',evidence};},
  };
  return {calls,deps:{client,fetcher:async()=>{calls.download++;return new Response(mp4(7));}}};
};
const video=(root:string,args:string[],n:ReturnType<typeof net>)=>runCli(['video','execute','--root',root,...args],n.deps);
const record=async(name:string,value:unknown)=>{if(process.env.METASO_TEST_EVIDENCE_DIR)await writeFile(join(process.env.METASO_TEST_EVIDENCE_DIR,name+'.json'),JSON.stringify(value,null,2));};
async function revise(root:string){
  const text='另外一集。', source=join(root,'second.txt');await writeFile(source,text);
  await importStory(root,{episodeId:'new-ep',kind:'video-prompts',source,segments:[{id:'s1',start:0,end:text.length,duration:7}]});
}
it.each([false,true])('historical: A never adopts the independent B output (revision change %s)',async(stale)=>{
  const f=await batchFixture([1]),a=net('A-old',true),b=net('B-new'),local=net('unused');
  const first=await video(f.root,['--batch',f.batch.plan.batchId,'--confirm','--poll-ms','0'],a);
  const old=(first.data as any).segments[0];
  const receipt=join(f.root,'.metasocli/receipts',old.operationId+'.json'), before=await readFile(receipt);
  if(stale)await revise(f.root);
  const next=await createBatchPlan(f.root,{episodes:f.episodeIds});
  const generated=await runCli(['generate','--root',f.root,'--plan',next.plan.items[0]!.planId,'--segment','s1','--retry-of',old.operationId,'--confirm','--poll-ms','0'],b.deps);
  expect(generated.exitCode).toBe(0);
  const child=(generated.data as any).jobs[0];
  for(const flag of [[],['--confirm','--poll-ms','0']]){
    expect(await video(f.root,['--batch',f.batch.plan.batchId,...flag],local)).toMatchObject({exitCode:2,data:{state:'partial',segments:[{operationId:old.operationId,taskId:'A-old-1',status:'failed',output:null}]}});
  }
  const result=await video(f.root,['--batch',next.plan.batchId],local);
  expect(result).toMatchObject({exitCode:0,data:{segments:[{operationId:child.operationId,taskId:'B-new-1',output:{path:expect.stringContaining(child.operationId)}}]}});
  expect((await loadBatchRun(f.root,f.batch.plan))?.items[0]?.operationId).toBe(old.operationId);
  expect(await readFile(receipt)).toEqual(before);
  expect([a.calls.post,b.calls.post,local.calls]).toEqual([1,1,{post:0,get:[],download:0}]);
  await record('history-'+stale,{A:{...old,planId:f.batch.plan.items[0]!.planId},B:child,local:local.calls});
});
it.each([[0],[1],[0,1],[]].map(bad=>({bad})))('staleOutput: isolated corrupt files %j do not strand the accepted peer',async({bad})=>{
  const f=await batchFixture([3]), n=net('accepted'),jobs=[];
  for(const item of f.batch.plan.items){
    const r=await runCli(['generate','--root',f.root,'--plan',item.planId,'--segment',item.segmentId,'--confirm','--submit-only'],n.deps);
    expect(r.exitCode).toBe(0);jobs.push((r.data as any).jobs[0]);
  }
  const damaged=[];
  for(const i of bad){
    const r=await runCli(['resume','--root',f.root,'--operation',jobs[i].operationId],n.deps);
    const output=(r.data as any).output, path=join(f.root,output.path);
    const bytes=await readFile(path);bytes[bytes.length-1]^=1;await writeFile(path,bytes);
    damaged.push({path,expected:output.sha256,actual:sha256Hex(bytes)});
  }
  await revise(f.root);n.calls.get=[];n.calls.download=0;
  const result=await video(f.root,['--batch',f.batch.plan.batchId,'--confirm','--poll-ms','0'],n);
  expect(result).toMatchObject({exitCode:bad.length?2:0,data:{state:bad.length?'partial':'complete'}});
  const items=(result.data as any).segments;
  for(const [i,j] of jobs.entries()){
    expect(items[i]).toMatchObject({operationId:j.operationId,taskId:j.taskId});
    if(bad.includes(i))expect(items[i]).toMatchObject({output:null,reason:'OUTPUT_CHANGED'});
    else expect(items[i].output).toBeTruthy();
  }
  expect(n.calls.get).toEqual(jobs.filter((_,i)=>!bad.includes(i)).map(j=>j.taskId));
  expect(n.calls.download).toBe(3-bad.length);expect(n.calls.post).toBe(3);
  for(const d of damaged)expect(sha256Hex(await readFile(d.path))).toBe(d.actual);
  const local=net('local');expect((await video(f.root,['--batch',f.batch.plan.batchId],local)).exitCode).toBe(result.exitCode);
  expect(local.calls).toEqual({post:0,get:[],download:0});
  await record('damage-'+bad.join('-'),{damaged,calls:n.calls,result});
  for(const [k,index] of bad.entries()){
    const recover=items[index].recover;
    expect(recover).toEqual(['download','--root',f.root,'--operation',jobs[index].operationId,'--redownload-missing']);
    await rename(damaged[k]!.path,damaged[k]!.path+'.held');
    expect((await runCli(recover,n.deps)).exitCode).toBe(0);
    expect(sha256Hex(await readFile(damaged[k]!.path+'.held'))).toBe(damaged[k]!.actual);
  }
  expect(n.calls.post).toBe(3);
});
it.each([false,true])('unrelated: missing first parent is never read during selector or exact local prepare (job %s)',async(withJob)=>{
  const f=await batchFixture([1]), old=f.batch.plan.items[0]!, n=net('first');
  if(withJob)expect((await runCli(['generate','--root',f.root,'--plan',old.planId,'--segment','s1','--confirm','--submit-only'],n.deps)).exitCode).toBe(0);
  await revise(f.root);
  const second=await createBatchPlan(f.root,{episodes:['new-ep']});
  const slotsBefore=(await inspectRuntime(runtimeDirectory())).slots;
  const path=join(f.root,'.metasocli/plans',old.planId+'.json');await rename(path,path+'.held');
  const spy=vi.spyOn(planning,'loadPlan'),local=net('local');
  for(const args of [['--episodes','new-ep'],['--batch',second.plan.batchId]]){
    expect(await video(f.root,args,local)).toMatchObject({exitCode:0,data:{state:'prepared',batchId:second.plan.batchId}});
  }
  const reads=spy.mock.calls.filter(([,id])=>id===old.planId).length;
  expect(reads).toBe(0);expect(local.calls).toEqual({post:0,get:[],download:0});
  expect((await inspectRuntime(runtimeDirectory())).slots).toEqual(slotsBefore);
  if(withJob){
    expect(slotsBefore.some(s=>s.taskId==='first-1')).toBe(true);
    expect(await video(f.root,['--batch',second.plan.batchId,'--confirm'],local)).toMatchObject({exitCode:1,data:{error:{code:'JOB_PARENT_MISSING',message:expect.stringContaining(old.planId)}}});
    expect(local.calls.post).toBe(0);
  }
  await record('unrelated-'+withJob,{oldPlanId:old.planId,reads,local:local.calls});
});
it.each(['batch-retry-linked','retry-job'])('batch resume repairs the two-file checkpoint %s with a single chosen child',async point=>{
  const f=await batchFixture([1]), id=f.batch.plan.batchId, n=net('old',true), b=net('new');
  const failed=await video(f.root,['--batch',id,'--confirm','--poll-ms','0'],n);
  const old=(failed.data as any).segments[0].operationId;
  await expect(authorizeBatchRetry(f.root,id,old,true,false,{checkpoint:async p=>{if(p===point)throw Error('checkpoint');}})).rejects.toThrow('checkpoint');
  const choice=(await loadBatchRun(f.root,f.batch.plan))!.trace.find(t=>t.event==='batch-retry-linked')!;
  expect(choice.detail).toBe(old);
  const recovered=await video(f.root,['--batch',id,'--confirm','--poll-ms','0'],b);
  expect(recovered).toMatchObject({exitCode:0,data:{segments:[{operationId:choice.operationId,taskId:'new-1'}]}});
  await runCli(['batch','retry','--root',f.root,'--batch',id,'--operation',old,'--confirm'],b.deps);
  expect(b.calls.post).toBe(1);expect(await readJob(f.root,old)).toMatchObject({status:'failed'});
},60000);
it('missing chosen child with a submission owner cannot be recreated',async()=>{
  const f=await batchFixture([1]),id=f.batch.plan.batchId,n=net('old',true);
  const old=((await video(f.root,['--batch',id,'--confirm','--poll-ms','0'],n)).data as any).segments[0].operationId;
  await expect(authorizeBatchRetry(f.root,id,old,true,false,{checkpoint:async p=>{if(p==='batch-retry-linked')throw Error('stop');}})).rejects.toThrow('stop');
  const t=(await loadBatchRun(f.root,f.batch.plan))!.trace.at(-1)!;
  await writeFile(join(f.root,'.metasocli/submissions',t.operationId+'.json'),'{}');
  expect(await video(f.root,['--batch',id,'--confirm'],n)).toMatchObject({exitCode:1,data:{error:{code:'RETRY_CONFLICT'}}});
  expect(await listJobs(f.root)).toHaveLength(1);expect(n.calls.post).toBe(1);
});
it('orphan single-attempt authorization cannot start a full batch; explicit retry restricts scope',async()=>{
  const f=await batchFixture([2]),id=f.batch.plan.batchId,n=net('child'),item=f.batch.plan.items[0]!;
  const lost={client:{async create(){throw Error('lost');},async query(){throw Error('unexpected');}}};
  const old=((await runCli(['generate','--root',f.root,'--plan',item.planId,'--segment','s1','--confirm','--submit-only'],lost)).data as any).jobs[0];
  await expect(authorizeVideoRetry(f.root,item.planId,item.segmentId,old.operationId,true,true,undefined,async p=>{if(p==='retry-authorization')throw Error('stop');})).rejects.toThrow('stop');
  expect(await video(f.root,['--batch',id,'--confirm'],n)).toMatchObject({exitCode:1,data:{error:{code:'BATCH_RETRY_UNBOUND'}}});
  expect(n.calls.post).toBe(0);
  const args=['batch','retry','--root',f.root,'--batch',id,'--operation',old.operationId,'--confirm','--accept-unknown-result','--poll-ms','0'];
  expect(await runCli(args,n.deps)).toMatchObject({exitCode:2,data:{summary:{pending:1,reusable:1}}});
  await runCli(args,n.deps);expect(n.calls.post).toBe(1);
});
it.each(['incorrect-index','missing-job','create-receipt','download-receipt','linked-output'])('delivery fails closed on %s without provider I/O',async fault=>{
  const f=await batchFixture([1]),id=f.batch.plan.batchId,n=net('accepted'),local=net('unexpected');
  const done=await video(f.root,['--batch',id,'--confirm','--poll-ms','0'],n),job=(done.data as any).segments[0];
  const run=(await loadBatchRun(f.root,f.batch.plan))!;
  if(fault==='incorrect-index'){run.items[0]!.operationId=randomUUID();await saveBatchRun(f.root,run);}
  if(fault==='missing-job'){const file=join(f.root,'.metasocli/jobs',job.operationId+'.json');await rename(file,file+'.held');}
  if(fault.endsWith('receipt')){
    const file=join(f.root,'.metasocli/receipts',job.operationId+(fault==='download-receipt'?'-download':'')+'.json');
    const r=JSON.parse(await readFile(file,'utf8'));r.taskId='different';await writeFile(file,JSON.stringify(r));
  }
  if(fault==='linked-output')await link(job.output.path,join(f.root,'alias.mp4'));
  await revise(f.root);
  const result=await video(f.root,['--batch',id,'--confirm'],local);
  expect(result.exitCode).toBe(1);expect((result.data as any).error.code).toBe(
    fault==='create-receipt'?'RECEIPT_CONFLICT':fault==='download-receipt'?'OUTPUT_CONFLICT':fault==='linked-output'?'LINK_PATH':'BATCH_RUN_TAMPERED');
  expect(local.calls).toEqual({post:0,get:[],download:0});
});
it.each(['header','parent'])('an unverifiable %s identifies the batch and creates no replacement',async mode=>{
  const f=await batchFixture([1]),id=f.batch.plan.batchId,local=net('unused');
  const file=mode==='header'?join(f.root,'.metasocli/batches',id,'plan.json'):join(f.root,'.metasocli/plans',f.batch.plan.items[0]!.planId+'.json');
  await rename(file,file+'.held');
  const result=await video(f.root,['--episodes',f.episodeIds[0]!],local);
  expect(result).toMatchObject({exitCode:1,data:{error:{code:'VIDEO_SCOPE_UNVERIFIABLE',message:expect.stringContaining(id)}}});
  expect(await readdir(join(f.root,'.metasocli/batches'))).toEqual([id]);expect(local.calls).toEqual({post:0,get:[],download:0});
});
it('same-parent independent retry remains separate until explicit batch association, including a conflicting valid index',async()=>{
  const f=await batchFixture([1]),id=f.batch.plan.batchId,a=net('A',true),b=net('B'),local=net('unused');
  const old=((await video(f.root,['--batch',id,'--confirm','--poll-ms','0'],a)).data as any).segments[0];
  const api=['generate','--root',f.root,'--plan',f.batch.plan.items[0]!.planId,'--segment','s1','--retry-of',old.operationId,'--confirm','--poll-ms','0'];
  const child=((await runCli(api,b.deps)).data as any).jobs[0];
  const historical=await video(f.root,['--batch',id,'--confirm'],local);
  expect(historical).toMatchObject({exitCode:2,data:{segments:[{operationId:old.operationId,output:null}]}});
  const saved=(await loadBatchRun(f.root,f.batch.plan))!;
  saved.items[0]!.operationId=child.operationId;await saveBatchRun(f.root,saved);
  expect(await video(f.root,['--batch',id],local)).toMatchObject({exitCode:1,data:{error:{code:'BATCH_RUN_TAMPERED'}}});
  saved.items[0]!.operationId=old.operationId;await saveBatchRun(f.root,saved);
  const args=['batch','retry','--root',f.root,'--batch',id,'--operation',old.operationId,'--confirm'];
  for(let i=0;i<2;i++)expect(await runCli(args,local.deps)).toMatchObject({exitCode:0,data:{items:[{job:{operationId:child.operationId}}]}});
  expect(local.calls).toEqual({post:0,get:[],download:0});expect(b.calls.post).toBe(1);
});
it('a superseded batch unknown grant remains evidence when the recovered original then explicitly retries its known failure',async()=>{
  const f=await batchFixture([1]),id=f.batch.plan.batchId,success=net('new'),failed=net('recovered',true);
  const lost=net('unused');lost.deps.client.create=async()=>{lost.calls.post++;throw Error('lost');};
  const original=((await video(f.root,['--batch',id,'--confirm'],lost)).data as any).segments[0].operationId;
  const b=(await authorizeBatchRetry(f.root,id,original,true,true)).job;
  await attachTask(f.root,original,'recovered-A',true,failed.deps);
  await authorizeBatchRetry(f.root,id,original,true,true);
  await resume(f.root,original,failed.deps,{download:false,maxPolls:1});
  const c=(await authorizeBatchRetry(f.root,id,original,true,false)).job;
  expect(c.operationId).not.toBe(b.operationId);
  const result=await video(f.root,['--batch',id,'--confirm','--poll-ms','0'],success);
  expect(result).toMatchObject({exitCode:0,data:{segments:[{operationId:c.operationId,taskId:'new-1'}]}});
  expect(await readJob(f.root,b.operationId)).toMatchObject({status:'cancelled',lastError:{code:'RETRY_SUPERSEDED'}});
  expect((await loadBatchRun(f.root,f.batch.plan))!.trace.filter(t=>t.event==='batch-retry-linked').map(t=>t.operationId)).toEqual([b.operationId,c.operationId]);
  expect([lost.calls.post,success.calls.post]).toEqual([1,1]);
});
it.each(['clean','receipt-present'])('old restricted run without trace recovers the authorization-only checkpoint (%s)',async mode=>{
  const f=await batchFixture([2]),id=f.batch.plan.batchId,item=f.batch.plan.items[0]!,n=net('accepted');
  const lost=net('unused');lost.deps.client.create=async()=>{throw Error('unknown');};
  const old=((await runCli(['generate','--root',f.root,'--plan',item.planId,'--segment',item.segmentId,'--confirm','--submit-only'],lost.deps)).data as any).jobs[0];
  await expect(authorizeBatchRetry(f.root,id,old.operationId,true,true,{checkpoint:async p=>{if(p==='retry-authorization')throw Error('stop');}})).rejects.toThrow('stop');
  const run=(await loadBatchRun(f.root,f.batch.plan))!, grant=JSON.parse(await readFile(await retryPath(f.root,old.operationId),'utf8'));
  run.trace=[];delete run.items[0]!.operationId;await saveBatchRun(f.root,run);
  if(mode==='receipt-present'){
    const receipt=join(f.root,'.metasocli/receipts',grant.newOperationId+'.json');
    await writeFile(receipt,JSON.stringify({operationId:grant.newOperationId,taskId:'other-accepted',requestHash:grant.requestHash,receivedAt:new Date().toISOString()}));
    await attachTask(f.root,old.operationId,'found-original',true,n.deps);
  }
  const result=await runCli(['batch','resume','--root',f.root,'--batch',id,'--poll-ms','0'],n.deps);
  if(mode==='clean'){
    expect(result).toMatchObject({exitCode:2,data:{summary:{reusable:1,pending:1},items:[{job:{operationId:grant.newOperationId,taskId:'accepted-1'}},{}]}});
    expect(n.calls.post).toBe(1);
  }else{
    expect(result).toMatchObject({exitCode:1,data:{error:{code:'RETRY_CONFLICT'}}});
    expect(n.calls.post).toBe(0);expect(await listJobs(f.root)).toHaveLength(1);
  }
});
it('exact ID can use another authenticated header as proof despite an earlier unreadable neighbor',async()=>{
  const f=await batchFixture([1]),old=f.batch.plan.items[0]!,n=net('old'),local=net('unused');
  await runCli(['generate','--root',f.root,'--plan',old.planId,'--segment','s1','--confirm','--submit-only'],n.deps);
  await revise(f.root);
  const second=(await createBatchPlan(f.root,{episodes:['new-ep']})).plan;
  const parent=join(f.root,'.metasocli/plans',old.planId+'.json');await rename(parent,parent+'.held');
  const broken='00000000-0000-4000-8000-000000000001',dir=join(f.root,'.metasocli/batches',broken);
  await mkdir(dir);await writeFile(join(dir,'plan.json'),'{');
  expect(await video(f.root,['--batch',second.batchId],local)).toMatchObject({exitCode:0,data:{state:'prepared'}});
  expect(await video(f.root,['--episodes','new-ep'],local)).toMatchObject({exitCode:1,data:{error:{code:'VIDEO_SCOPE_UNVERIFIABLE',message:expect.stringContaining(broken)}}});
  expect(local.calls).toEqual({post:0,get:[],download:0});
});
