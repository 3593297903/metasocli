import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCli } from '../src/cli/main.js';
import { importStory } from '../src/core/project.js';
import * as planning from '../src/core/planning.js';
import * as io from '../src/storage/io.js';
import { canonicalSha256, sha256Hex } from '../src/storage/canonical.js';
import { batchPath, createBatchPlan, loadBatchRun, saveBatchRun } from '../src/jobs/batch-store.js';
import { authorizeBatchRetry } from '../src/jobs/batch.js';
import { attachTask } from '../src/jobs/resume.js';
import { jobPath, listJobs } from '../src/jobs/store.js';
import { inspectRuntime, runtimeDirectory } from '../src/jobs/coordinator.js';
import { readVideoRetry, retryPath } from '../src/jobs/video-retry.js';
import type { JobDependencies } from '../src/jobs/submit.js';
import { batchFixture, evidence } from './batch-helpers.js';
import { cleanup, mp4 } from './helpers.js';

afterEach(async()=>{ vi.restoreAllMocks(); await cleanup(); });
const poll=['--max-polls','1','--poll-ms','0'];
function network(tag:string, status:'generated'|'failed'|'cancelled'|'running'='generated'){
  const calls={posts:0,gets:[] as string[],downloads:[] as string[]};
  const deps:JobDependencies={
    client:{
      async create(){return {taskId:tag+'-'+ ++calls.posts,evidence};},
      async query(taskId){
        calls.gets.push(taskId);
        return {taskId,status,rawStatus:status,duration:7,url:'https://example.invalid/'+taskId+'.mp4',evidence};
      }
    },
    fetcher:async url=>{calls.downloads.push(url);return new Response(mp4(7));}
  };
  return {calls,deps};
}
const video=(root:string,id:string,deps:JobDependencies,confirm=true)=>runCli(['video','execute','--root',root,'--batch',id,...(confirm?['--confirm']:[]),...poll],deps);
const batch=(root:string,id:string,deps:JobDependencies,full=false)=>runCli(['batch',full?'run':'resume','--root',root,'--batch',id,...(full?['--confirm']:[]),...poll],deps);
async function submitOne(root:string,plan:string,segment:string,deps:JobDependencies,extra:string[]=[]){
  const result=await runCli(['generate','--root',root,'--plan',plan,'--segment',segment,'--confirm','--submit-only',...extra],deps);
  const job=(result.data as any).jobs?.[0];expect(job,JSON.stringify(result.data)).toBeDefined();return job;
}
async function unknown(root:string,planId:string){
  const job=await submitOne(root,planId,'s1',{client:{async create(){throw Error('lost response');},async query(){throw Error('unexpected original query');}}});
  expect(job.status).toBe('submit_unknown');return job;
}
async function newEpisode(root:string){
  const source=join(root,'second.txt'),text='另一集原文。';await writeFile(source,text);
  await importStory(root,{episodeId:'next',kind:'video-prompts',source,segments:[{id:'s1',start:0,end:text.length,duration:7}]});
}
async function evidenceFile(name:string,value:unknown){
  if(process.env.METASO_TEST_EVIDENCE_DIR)await writeFile(join(process.env.METASO_TEST_EVIDENCE_DIR,'four-'+name+'.json'),JSON.stringify(value,null,2));
}

describe('R1 download recovery',()=>{
  it.each(['headers','stream','timeout','truncated','healthy'])('%s leaves each accepted task independently recoverable',async mode=>{
    const {root,batch:{plan}}=await batchFixture([2]), n=network('accepted');
    const jobs=[];
    for(const item of plan.items)jobs.push(await submitOne(root,item.planId,item.segmentId,n.deps));
    await newEpisode(root);
    const full=n.deps.fetcher!;
    let interrupt=true,bytesDelivered=0;
    n.deps.fetcher=async(url,init)=>{
      if(!interrupt || !url.endsWith('accepted-1.mp4') || mode==='healthy')return full(url,init);
      n.calls.downloads.push(url);
      if(mode==='headers')throw Error('test URL must be redacted');
      if(mode==='truncated')return new Response(mp4(7).subarray(0,32),{headers:{'content-length':'348'}});
      return new Response(new ReadableStream<Uint8Array>({pull(c){
        if(!bytesDelivered){bytesDelivered=32;c.enqueue(mp4(7).subarray(0,32));}
        else c.error(new DOMException('test URL must be redacted',mode==='timeout'?'TimeoutError':'NetworkError'));
      }}));
    };
    const got=await video(root,plan.batchId,n.deps);
    expect(got.exitCode).toBe(mode==='healthy'?0:2);
    expect(n.calls.gets).toEqual(jobs.map(j=>j.taskId));expect(n.calls.posts).toBe(2);expect(n.calls.downloads).toHaveLength(2);
    expect((got.data as any).segments[1]).toMatchObject({operationId:jobs[1].operationId,taskId:jobs[1].taskId,status:'downloaded'});
    if(mode==='healthy')return;
    if(mode==='stream'||mode==='timeout')expect(bytesDelivered).toBe(32);
    const first=(got.data as any).segments[0];
    expect(first).toMatchObject({operationId:jobs[0].operationId,taskId:jobs[0].taskId,reason:mode==='truncated'?'DOWNLOAD_TRUNCATED':'DOWNLOAD_FAILED',output:null});
    expect(JSON.stringify(await listJobs(root))).not.toContain('test URL must be redacted');
    expect((await readdir(join(root,'outputs',jobs[0].episodeId))).filter(f=>f.includes(jobs[0].operationId))).toEqual([]);
    expect(await readdir(join(root,'.metasocli/receipts'))).not.toContain(jobs[0].operationId+'-download.json');
    const initialGets=[...n.calls.gets];interrupt=false;
    expect((await runCli(first.recover,n.deps)).exitCode).toBe(0);
    expect((await video(root,plan.batchId,n.deps)).exitCode).toBe(0);
    expect(n.calls.gets.slice(2)).toEqual([jobs[0].taskId]);expect(n.calls.downloads.slice(2)).toHaveLength(1);expect(n.calls.posts).toBe(2);
    await evidenceFile('download-'+mode,{segments:(got.data as any).segments,bytesDelivered,initialGets,calls:n.calls,recoveryPosts:0});
  },60000);
  it('an invalid local download receipt stops the stale recovery loop',async()=>{
    const {root,batch:{plan}}=await batchFixture([2]),n=network('guard');
    const j=await submitOne(root,plan.items[0]!.planId,'s1',n.deps);await submitOne(root,plan.items[1]!.planId,'s2',n.deps);
    expect((await runCli(['resume','--root',root,'--operation',j.operationId],n.deps)).exitCode).toBe(0);
    const file=join(root,'.metasocli/receipts',j.operationId+'-download.json'), receipt=JSON.parse(await readFile(file,'utf8'));
    await writeFile(file,JSON.stringify({...receipt,taskId:'another-task'}));await newEpisode(root);
    const local=network('unused');expect(await video(root,plan.batchId,local.deps)).toMatchObject({exitCode:1,data:{error:{code:'OUTPUT_CONFLICT'}}});
    expect(local.calls).toEqual({posts:0,gets:[],downloads:[]});
  });
});

describe('R2 one linked retry',()=>{
  it.each([['failed','batch-retry-linked'],['cancelled','batch-retry-linked'],['cancelled','retry-job']] as const)('%s at %s resumes its chosen ID once',async(status,point)=>{
    const {root,batch:{plan}}=await batchFixture([1]),first=network('original',status),child=network('child');
    const origin=(await video(root,plan.batchId,first.deps)).data as any, old=origin.segments[0];
    expect(old.status).toBe(status);
    expect((await video(root,plan.batchId,child.deps)).exitCode).toBe(2);expect(child.calls.posts).toBe(0);
    await expect(authorizeBatchRetry(root,plan.batchId,old.operationId,true,false,{checkpoint:async p=>{if(p===point)throw Error('stop at '+point);}})).rejects.toThrow('stop at '+point);
    const trace=(await loadBatchRun(root,plan))!.trace.find(t=>t.event==='batch-retry-linked')!;
    expect(trace.detail).toBe(old.operationId);
    expect((await video(root,plan.batchId,child.deps,false)).exitCode).toBe(2);
    expect(child.calls).toEqual({posts:0,gets:[],downloads:[]});
    const result=await video(root,plan.batchId,child.deps);
    expect(result).toMatchObject({exitCode:0,data:{segments:[{operationId:trace.operationId,taskId:'child-1'}]}});
    expect((await video(root,plan.batchId,child.deps)).exitCode).toBe(0);expect((await batch(root,plan.batchId,child.deps)).exitCode).toBe(0);
    expect(child.calls.posts).toBe(1);
    await evidenceFile('linked-'+status+'-'+point,{old,linked:trace,child:(result.data as any).segments[0],posts:child.calls.posts});
  },60000);
  it('cancelled link with missing Job and submission owner never resends',async()=>{
    const {root,batch:{plan}}=await batchFixture([1]),a=network('a','cancelled'),b=network('unused');
    const old=((await video(root,plan.batchId,a.deps)).data as any).segments[0];
    await expect(authorizeBatchRetry(root,plan.batchId,old.operationId,true,false,{checkpoint:async p=>{if(p==='batch-retry-linked')throw Error('stop');}})).rejects.toThrow('stop');
    const link=(await loadBatchRun(root,plan))!.trace.at(-1)!;
    await writeFile(join(root,'.metasocli/submissions',link.operationId+'.json'),'{}');
    expect(await video(root,plan.batchId,b.deps)).toMatchObject({exitCode:1,data:{error:{code:'RETRY_CONFLICT'}}});
    expect(b.calls.posts).toBe(0);
  });
});

async function twoParents(same=false,grantOnly=false){
  const {root,batch:{plan:p}}=await batchFixture([1]), old=await unknown(root,p.items[0]!.planId);
  const q=same?p:(await createBatchPlan(root,{episodes:['ep-z']})).plan;
  const n=network('q');
  if(grantOnly)n.deps.checkpoint=async point=>{if(point==='retry-authorization')throw Error('saved grant only');};
  const args=['generate','--root',root,'--plan',q.items[0]!.planId,'--segment','s1','--retry-of',old.operationId,'--accept-unknown-result','--confirm','--submit-only'];
  const child=await runCli(args,n.deps);
  expect(child.exitCode).toBe(grantOnly?1:0);
  const grant=(await readVideoRetry(root,old.operationId))!;expect(grant.planId).toBe(q.items[0]!.planId);
  await newEpisode(root);const other=(await createBatchPlan(root,{episodes:['next']})).plan;
  return {root,p,q,other,old,grant};
}
const planFile=(root:string,id:string)=>join(root,'.metasocli/plans',id+'.json');
async function hashes(files:string[]){return Promise.all(files.map(async file=>sha256Hex(await readFile(file))));}
describe('R3 independent parent evidence',()=>{
  it.each(['distinct','same','grant-only'])('%s parents allow cold, bound and exact local observations',async mode=>{
    const {root,p,other,old,grant}=await twoParents(mode==='same',mode==='grant-only'), local=network('unused');
    const files=[await jobPath(root,old.operationId),await retryPath(root,old.operationId),join(runtimeDirectory(),'video-ledger.json')];
    if(mode!=='grant-only')files.push(await jobPath(root,grant.newOperationId));
    const before=await hashes(files), slots=(await inspectRuntime(runtimeDirectory())).slots;
    expect(slots.some(s=>s.operationId===old.operationId && s.status==='submit_unknown')).toBe(true);
    const parent=planFile(root,old.planId);await rename(parent,parent+'.held');
    const reads=vi.spyOn(planning,'loadPlan');
    for(const args of [['--episodes','next'],['--episodes','next'],['--batch',other.batchId]]){
      expect(await runCli(['video','execute','--root',root,...args],local.deps)).toMatchObject({exitCode:0,data:{state:'prepared',batchId:other.batchId}});
    }
    const pReads=reads.mock.calls.filter(([,id])=>id===old.planId).length,qReads=reads.mock.calls.filter(([,id])=>id===grant.planId).length;
    expect([pReads,qReads]).toEqual([0,0]);expect(await hashes(files)).toEqual(before);expect(local.calls).toEqual({posts:0,gets:[],downloads:[]});
    await evidenceFile('parents-'+mode,{p:old.planId,q:grant.planId,old:old.operationId,child:grant.newOperationId,pReads,qReads,files,before,after:await hashes(files),calls:local.calls,slots});
    expect((await video(root,p.batchId,local.deps,false)).exitCode).toBe(1);
    expect(await video(root,other.batchId,local.deps)).toMatchObject({exitCode:1,data:{error:{code:'JOB_PARENT_MISSING',message:expect.stringContaining(old.planId)}}});
    expect(local.calls.posts).toBe(0);
  },60000);
  it('without an authenticated Q header, full readable parents are required',async()=>{
    const {root,other,old,q}=await twoParents(),local=network('unused');
    const header=await batchPath(root,q.batchId,'plan');await rename(header,header+'.held');
    expect((await video(root,other.batchId,local.deps,false)).exitCode).toBe(0);
    const file=planFile(root,q.items[0]!.planId);await rename(file,file+'.held');
    expect((await video(root,other.batchId,local.deps,false)).exitCode).toBe(1);
    expect(local.calls.posts).toBe(0);expect(old.status).toBe('submit_unknown');
  });
  it.each(['grant hash','attempt','child retryOf','child createdAt','prepared intent'])('a matching header cannot hide a conflicting %s',async fault=>{
    const {root,other,grant}=await twoParents(),local=network('unused');
    const file=fault.startsWith('child')||fault==='prepared intent'?await jobPath(root,grant.newOperationId):await retryPath(root,grant.oldOperationId);
    const data=JSON.parse(await readFile(file,'utf8'));
    if(fault==='grant hash')data.hash='0'.repeat(64);
    if(fault==='attempt'){data.attempt++;const {hash,...base}=data;data.hash=canonicalSha256(base);}
    if(fault==='child retryOf')data.retryOf=randomUUID();
    if(fault==='child createdAt')data.createdAt=new Date(0).toISOString();
    if(fault==='prepared intent'){data.status='prepared';delete data.taskId;data.submittedAt=new Date().toISOString();}
    await writeFile(file,JSON.stringify(data));
    const result=await video(root,other.batchId,local.deps,false);
    expect(result.exitCode).toBe(1);expect((result.data as any).error.message).toMatch(new RegExp(grant.oldOperationId+'|'+grant.newOperationId));
    expect(local.calls).toEqual({posts:0,gets:[],downloads:[]});
  });
});

async function restricted(legacy=false,active=false){
  const {root,batch:{plan}}=await batchFixture([2]),old=await unknown(root,plan.items[0]!.planId), n=network('first',active?'running':'generated');
  const args=['batch','retry','--root',root,'--batch',plan.batchId,'--operation',old.operationId,'--confirm','--accept-unknown-result',...poll];
  const retry=await runCli(args,n.deps);
  expect(retry.exitCode).toBe(2);expect(n.calls.posts).toBe(1);
  const run=(await loadBatchRun(root,plan))!, child=run.authorization.retryOnly![0]!;
  if(legacy){run.trace=run.trace.filter(t=>t.event!=='batch-retry-linked');await saveBatchRun(root,run);}
  return {root,plan,old,run,child};
}
describe('R4 explicit full-batch authorization',()=>{
  it.each([false,true])('legacy grant-only snapshot promotes with original task recovered: %s',async recovered=>{
    const {root,batch:{plan}}=await batchFixture([2]),old=await unknown(root,plan.items[0]!.planId),n=network('fresh');
    await expect(authorizeBatchRetry(root,plan.batchId,old.operationId,true,true,{checkpoint:async point=>{
      if(point==='retry-authorization')throw Error('grant saved');
    }})).rejects.toThrow('grant saved');
    const run=(await loadBatchRun(root,plan))!,child=run.authorization.retryOnly![0]!;
    run.trace=[];delete run.items[0]!.operationId;await saveBatchRun(root,run);
    if(recovered)await attachTask(root,old.operationId,'restored-original',true,n.deps);
    const result=await batch(root,plan.batchId,n.deps,true);
    expect(result).toMatchObject({exitCode:0,data:{summary:{reusable:2},items:[{job:{operationId:recovered?old.operationId:child}},{}]}});
    expect((await loadBatchRun(root,plan))!.trace.filter(t=>t.event==='batch-retry-linked')).toMatchObject([{order:0,detail:old.operationId,operationId:child}]);
    expect(n.calls.posts).toBe(recovered?1:2);expect((await listJobs(root)).filter(j=>j.operationId===child)).toHaveLength(recovered?0:1);
  },60000);
  it.each(['current','legacy','active'])('%s: only full confirmation widens the same batch, once',async mode=>{
    const {root,plan,old,run,child}=await restricted(mode==='legacy',mode==='active'),n=network('second');
    const local=await video(root,plan.batchId,n.deps,false);expect(local.exitCode).toBe(2);
    expect(n.calls).toEqual({posts:0,gets:[],downloads:[]});
    expect((await batch(root,plan.batchId,n.deps)).exitCode).toBe(2);
    expect((await video(root,plan.batchId,n.deps)).exitCode).toBe(2);expect(n.calls.posts).toBe(0);
    const before=(await loadBatchRun(root,plan))!, grantFile=await retryPath(root,old.operationId),grantHash=await hashes([grantFile]);
    const savedAtPost:string[]=[];
    const create=n.deps.client.create;
    n.deps.client.create=async request=>{
      const saved=(await loadBatchRun(root,plan))!;
      savedAtPost.push(saved.trace.find(t=>t.event==='batch-full-authorized')?.at??'missing');
      expect(saved.authorization.retryOnly).toBeUndefined();
      return create(request);
    };
    const results=await Promise.all([batch(root,plan.batchId,n.deps,true),batch(root,plan.batchId,n.deps,true)]);
    for(const r of results)expect(r).toMatchObject({exitCode:0,data:{summary:{pending:0,reusable:2},items:[{job:{operationId:child,taskId:'first-1'}},{job:{taskId:'second-1'}}]}});
    const after=(await loadBatchRun(root,plan))!;
    expect(after.trace.filter(t=>t.event==='batch-full-authorized').map(t=>t.at)).toEqual(savedAtPost);
    expect(savedAtPost).toHaveLength(1);expect(after.authorization.authorizedAt).toBe(run.authorization.authorizedAt);
    expect(after.trace).toEqual(expect.arrayContaining(before.trace));
    expect(after.trace.filter(t=>t.event==='batch-retry-linked')).toMatchObject([{operationId:child,detail:old.operationId,order:0}]);
    expect(after.rateLimit).toEqual(before.rateLimit);expect(after.authorization.acceptedUnknown).toEqual(before.authorization.acceptedUnknown);
    expect(await hashes([grantFile])).toEqual(grantHash);expect(n.calls.posts).toBe(1);
    expect((await inspectRuntime(runtimeDirectory())).slots).toContainEqual(expect.objectContaining({operationId:old.operationId,status:'submit_unknown'}));
    await evidenceFile('full-'+mode,{original:old.operationId,child,batchId:plan.batchId,savedAtPost,trace:after.trace,items:(results[0].data as any).items,calls:n.calls});
  },90000);
  it.each(['before','after'])('interruption %s atomic authorization persistence controls ordinary resume',async point=>{
    const {root,plan,child}=await restricted(true),n=network('second'),file=await batchPath(root,plan.batchId,'run');
    const write=io.writeJson;let stopped=false;
    const hook=vi.spyOn(io,'writeJson').mockImplementation(async(path,value)=>{
      const snapshot=value as typeof plan & {authorization?:{retryOnly?:string[]};trace?:{event:string}[]};
      if(path===file && !snapshot.authorization?.retryOnly && snapshot.trace?.some(t=>t.event==='batch-full-authorized') && !stopped){
        stopped=true;if(point==='after')await write(path,value);throw Error('simulated process stop');
      }
      return write(path,value);
    });
    expect((await batch(root,plan.batchId,n.deps,true)).exitCode).toBe(1);expect(stopped).toBe(true);hook.mockRestore();
    expect(n.calls.posts).toBe(0);const saved=(await loadBatchRun(root,plan))!;
    expect(saved.authorization.retryOnly).toEqual(point==='before'?[child]:undefined);
    expect((await batch(root,plan.batchId,n.deps)).exitCode).toBe(point==='before'?2:0);expect(n.calls.posts).toBe(point==='before'?0:1);
    expect((await batch(root,plan.batchId,n.deps,true)).exitCode).toBe(0);expect(n.calls.posts).toBe(1);
  },60000);
  it.each(['missing accepted child','bad hash','wrong batch','stale scope','unrelated binding'])('zero new POST on %s',async fault=>{
    const {root,plan,child}=await restricted(true),n=network('unused');
    let batchId=plan.batchId;
    if(fault==='wrong batch')batchId=randomUUID();
    if(fault==='missing accepted child'){const file=await jobPath(root,child);await rename(file,file+'.held');}
    if(fault==='bad hash'){const file=await batchPath(root,plan.batchId,'run');const data=JSON.parse(await readFile(file,'utf8'));data.hash='0'.repeat(64);await writeFile(file,JSON.stringify(data));}
    if(fault==='stale scope')await newEpisode(root);
    if(fault==='unrelated binding'){const run=(await loadBatchRun(root,plan))!;run.items[1]!.operationId=child;await saveBatchRun(root,run);}
    const r=await batch(root,batchId,n.deps,true);expect(r.exitCode).not.toBe(0);expect(n.calls.posts).toBe(0);
    const file=await batchPath(root,plan.batchId,'run');
    expect(JSON.parse(await readFile(file,'utf8')).authorization.retryOnly).toEqual([child]);
  },60000);
});
