import { afterEach,expect,it } from 'vitest';
import { batchFixture,evidence } from './batch-helpers.js';
import { cleanup,mp4 } from './helpers.js';
import { runBatch } from '../src/jobs/batch.js';
import { createBatchPlan } from '../src/jobs/batch-store.js';
import { inspectRuntime,occupied } from '../src/jobs/coordinator.js';
import { dispatchShares } from '../src/jobs/capacity-policy.js';
import { ProviderError,type VideoClient } from '../src/metaso/client.js';
import { writeFile,mkdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';

afterEach(cleanup);
async function evidenceFile(name:string){const folder=resolve(process.env.METASO_TEST_EVIDENCE_DIR??'.work/video-capacity');await mkdir(folder,{recursive:true});return join(folder,name);}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
const generated=(taskId:string)=>({taskId,status:'generated' as const,rawStatus:'succeeded',duration:7,url:'https://example.test/offline.mp4',evidence});
const opts={maxPolls:4,pollIntervalMs:0,capacityWaitMs:30000,capacityPollMs:10};

it('R3 share formula covers all 46656 two-project combinations and same-project share accounting',()=>{
  let cases=0;
  for(let ah=0;ah<6;ah++)for(let bh=0;bh<6;bh++)for(let ac=0;ac<6;ac++)for(let bc=0;bc<6;bc++)for(let ar=0;ar<6;ar++)for(let br=0;br<6;br++){
    const roots=[...Array(ah).fill('a'),...Array(bh).fill('b')];
    const shares=dispatchShares(roots,[{root:'a',capacity:ac,remaining:ar,eligible:true},{root:'b',capacity:bc,remaining:br,eligible:true}]);
    expect(shares.every(n=>n>=0)).toBe(true);expect(shares[0]!+shares[1]!).toBeLessThanOrEqual(Math.max(0,4-ah-bh));
    expect(shares[0]).toBeLessThanOrEqual(Math.min(ar,Math.max(0,ac-ah)));expect(shares[1]).toBeLessThanOrEqual(Math.min(br,Math.max(0,bc-bh)));cases++;
  }
  expect(cases).toBe(46656);
  expect(dispatchShares(['a'],[{root:'a',capacity:2,remaining:1,eligible:true},{root:'a',capacity:2,remaining:1,eligible:true},{root:'b',capacity:4,remaining:4,eligible:true}])).toEqual([1,0,2]);
});

it('a live batch in a confirmed 429 backoff yields its dispatch priority until it is eligible again',async()=>{
  const a=await batchFixture([1]),b=await batchFixture([1]),sleeping=gate(),release=gate();let time=1000,attempts=0;
  const posts:string[]=[];
  const aw=runBatch(a.root,a.batch.plan.batchId,true,{now:()=>time,sleep:async ms=>{sleeping.resolve();await release.promise;time+=ms;},
    client:{async create(){posts.push('A'+(++attempts));if(attempts===1)throw new ProviderError('PROVIDER_HTTP','rate limit',{httpStatus:429,rejected:true,safeToRetry:true,retryAfterMs:5000});return {taskId:'A-accepted',evidence};},query:async id=>generated(id)},
    fetcher:async()=>new Response(mp4(7))},opts);
  await sleeping.promise;
  try{
    const result=await runBatch(b.root,b.batch.plan.batchId,true,{client:{async create(){posts.push('B');release.resolve();return {taskId:'B-accepted',evidence};},query:async id=>generated(id)},fetcher:async()=>new Response(mp4(7))},opts);
    expect(result.run?.status).toBe('complete');
  }finally{release.resolve();await aw;}
  expect((await aw).run?.status).toBe('complete');expect(posts).toEqual(['A1','B','A2']);
  await writeFile(await evidenceFile('r3-priority-backoff.json'),JSON.stringify({posts,oneExplicitlyRejectedRetry:true},null,2));
},60000);

it('A8 replenishes before later B, but B starts without waiting for A downloads',async()=>{
  const a=await batchFixture([8]),b=await batchFixture([2]),aQuery=gate(),release=gate(),bPost=gate();const posts:string[]=[],trace:unknown[]=[];let an=0,bn=0;
  const ac:VideoClient={async create(){const id='A'+(++an);posts.push(id);trace.push({event:'POST',id});return {taskId:id,evidence};},async query(id){aQuery.resolve();await release.promise;return generated(id);}};
  const bc:VideoClient={async create(){const id='B'+(++bn);posts.push(id);trace.push({event:'POST',id});bPost.resolve();expect(an).toBe(8);return {taskId:id,evidence};},async query(id){return generated(id);}};
  let downloads=0,peak=0;
  const aw=runBatch(a.root,a.batch.plan.batchId,true,{client:ac,fetcher:async()=>{downloads++;peak=Math.max(peak,downloads);try{await bPost.promise;return new Response(mp4(7));}finally{downloads--;}}},opts);
  await aQuery.promise;
  const bw=runBatch(b.root,b.batch.plan.batchId,true,{client:bc,fetcher:async()=>new Response(mp4(7))},opts);
  try{release.resolve();const results=await Promise.all([aw,bw]);await writeFile(await evidenceFile('r3-priority-debug.json'),JSON.stringify({posts,results},null,2));expect(results.map(r=>r.run?.status),JSON.stringify({posts,errors:results.map(r=>r.run?.items.filter(i=>i.error))})).toEqual(['complete','complete']);}
  finally{release.resolve();bPost.resolve();}
  expect(posts).toEqual(['A1','A2','A3','A4','A5','A6','A7','A8','B1','B2']);expect(peak).toBe(2);
  await writeFile(await evidenceFile('r3-priority-A8.json'),JSON.stringify({posts,peakDownloads:peak,trace},null,2));
},120000);

it('A concurrency one retains its replenishment share while B uses the other three',async()=>{
  const a=await batchFixture([2]),b=await batchFixture([4]),first=gate(),three=gate(),second=gate();
  const plan=(await createBatchPlan(a.root,{episodes:a.episodeIds,concurrency:1})).plan;let an=0,bn=0;const posts:string[]=[];
  const ac:VideoClient={async create(){const taskId='A'+(++an);posts.push(taskId);if(an===2)second.resolve();return {taskId,evidence};},async query(id){first.resolve();await three.promise;return generated(id);}};
  const bc:VideoClient={async create(){const taskId='B'+(++bn);posts.push(taskId);if(bn===3)three.resolve();if(bn===4)expect(an).toBe(2);return {taskId,evidence};},async query(id){await second.promise;return generated(id);}};
  const fetcher=async()=>new Response(mp4(7));const aw=runBatch(a.root,plan.batchId,true,{client:ac,fetcher},opts);await first.promise;
  const bw=runBatch(b.root,b.batch.plan.batchId,true,{client:bc,fetcher},opts);
  try{expect((await Promise.all([aw,bw])).map(r=>r.run?.status)).toEqual(['complete','complete']);}finally{three.resolve();second.resolve();}
  expect(posts.slice(0,5)).toEqual(['A1','B1','B2','B3','A2']);
  await writeFile(await evidenceFile('r3-priority-A1.json'),JSON.stringify({posts},null,2));
},90000);

it('A only two does not reserve four fictional slots; B immediately uses two',async()=>{
  const a=await batchFixture([2]),b=await batchFixture([2]),ready=gate(),four=gate();let an=0,bn=0;
  const ac:VideoClient={async create(){return {taskId:'A'+(++an),evidence};},async query(id){ready.resolve();await four.promise;return generated(id);}};
  const bc:VideoClient={async create(){if(++bn===2)four.resolve();return {taskId:'B'+bn,evidence};},async query(id){expect(occupied(await inspectRuntime()).length).toBeLessThanOrEqual(4);return generated(id);}};
  const fetcher=async()=>new Response(mp4(7)),aw=runBatch(a.root,a.batch.plan.batchId,true,{client:ac,fetcher},opts);await ready.promise;
  const bw=runBatch(b.root,b.batch.plan.batchId,true,{client:bc,fetcher},opts);
  try{expect((await Promise.all([aw,bw])).every(r=>r.run?.status==='complete')).toBe(true);}finally{four.resolve();}
  expect([an,bn]).toEqual([2,2]);
},60000);
