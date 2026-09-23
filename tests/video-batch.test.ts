import { afterEach, expect, it } from 'vitest';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { cleanup, fixture, mp4, png } from './helpers.js';
import { importStory, loadStory } from '../src/core/project.js';
import { createBatchPlan, batchStatus } from '../src/jobs/batch-store.js';
import { runBatch } from '../src/jobs/batch.js';
import { createPlan, validatePlan } from '../src/core/planning.js';
import { submit } from '../src/jobs/submit.js';
import { resume } from '../src/jobs/resume.js';
import { reconcileRuntime, occupied } from '../src/jobs/coordinator.js';
import { MetasoClient, ProviderError, type VideoClient } from '../src/metaso/client.js';
import { runCli } from '../src/cli/main.js';
import { sha256Hex } from '../src/storage/canonical.js';
import { registerAsset } from '../src/assets/registry.js';
import { wav } from './audio-fixtures.js';
afterEach(cleanup);
import { batchFixture, evidence } from './batch-helpers.js';
it('sustains four remote slots across 16 ordered items, replenishes on segment 3, and separates two slow downloads', async () => {
  const f = await batchFixture(), trace: object[] = [], posts: number[] = [], active = new Set<number>();
  const texts = new Map<string, number>();
  for (const item of f.batch.plan.items) {
    const plan = await import('../src/core/planning.js').then(m => m.loadPlan(f.root, item.planId));
    texts.set(plan.segments.find(s => s.segmentId === item.segmentId)!.renderedPrompt, item.order + 1);
  }
  let releasePosts!: () => void, releaseDownloads!: () => void;
  const barrier = new Promise<void>(r => { releasePosts = r; }), slow = new Promise<void>(r => { releaseDownloads = r; });
  let httpActive = 0, peakHttp = 0, downloadActive = 0, peakDownload = 0, peakSlots = 0, failDownload = true;
  const client: VideoClient = {
    async create(request) {
      expect(request.context_ir_enabled).toBe(true);
      const first = request.content[0]; if (first?.type !== 'text') throw new Error('missing text');
      const n = texts.get(first.text)!; expect(n).toBe(posts.length + 1); posts.push(n); active.add(n);
      httpActive++; peakHttp = Math.max(peakHttp, httpActive); peakSlots = Math.max(peakSlots, active.size);
      trace.push({ event: 'POST', n, active: [...active], httpActive });
      expect(active.size).toBeLessThanOrEqual(4);
      if (n === 5) expect([...active].sort()).toEqual([1,2,4,5]);
      if (n === 4) releasePosts();
      if (n === 8) releaseDownloads();
      if (n <= 4) await barrier;
      httpActive--; return { taskId: 'video-' + n, evidence };
    },
    async query(taskId) {
      const n = Number(taskId.slice(6));
      const done = n === 3 || (n === 1 && posts.length >= 5) || ([2,4].includes(n) && posts.length >= 6) || n >= 5;
      trace.push({ event: 'GET', n, state: done ? 'succeeded' : 'running', posted: posts.length });
      if (!done) { expect(posts.length).toBeGreaterThanOrEqual(4); return { taskId, status: 'running', rawStatus: 'running', evidence }; }
      active.delete(n);
      return { taskId, status: 'generated', rawStatus: 'succeeded', duration: 7, url: 'https://example.com/' + n + '.mp4', evidence };
    },
  };
  const fetcher = async (url: string | URL | Request) => {
    const n = Number(String(url).split('/').at(-1)!.split('.')[0]);
    downloadActive++; peakDownload = Math.max(peakDownload, downloadActive);
    trace.push({ event: 'download-start', n, downloadActive, posted: posts.length });
    try {
      if (posts.length < 8) await slow;
      if (n === 6 && failDownload) { failDownload = false; return new Response('retry later', { status: 500 }); }
      return new Response(mp4(7));
    } finally { downloadActive--; trace.push({ event: 'download-end', n, posted: posts.length }); }
  };
  const result = await runBatch(f.root, f.batch.plan.batchId, true, { client, fetcher }, { pollIntervalMs: 0, maxPolls: 30 });
  expect(posts).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  expect(peakHttp).toBe(4); expect(peakSlots).toBe(4); expect(peakDownload).toBe(2);
  await mkdir(resolve('.work'), { recursive: true });
  await writeFile(resolve('.work/video-batch-debug.json'), JSON.stringify(result, null, 2));
  expect(result.summary, JSON.stringify({ unfinished: result.items.filter(i => i.job?.status !== 'downloaded').map(i => ({order:i.order,status:i.job?.status,error:i.job?.lastError})), errors:result.run!.items.filter(i=>i.error) })).toMatchObject({ reusable: 15, downloads: 1 });
  const resumed = await runBatch(f.root, f.batch.plan.batchId, false, { client, fetcher }, { pollIntervalMs: 0, maxPolls: 30 });
  expect(resumed.run!.status).toBe('complete'); expect(posts).toHaveLength(16);
  for (const item of resumed.items) expect(item.job!.output!.path).toBe('outputs/' + item.episodeId + '/' + item.segmentId + '-' + item.job!.operationId + '.mp4');
  const folder = resolve('.work'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'video-batch-trace.json'), JSON.stringify({ fakeClientsOnly: true, posts, peakHttp, peakSlots, peakDownload, final: resumed.summary, trace }, null, 2));
}, 180000);

it('freezes explicit episode/segment order and checks offline CLI scope and authorization', async () => {
  const f = await batchFixture([2,2,2]);
  const selection = { schemaVersion: 1, episodes: [{ episodeId: 'ep-m', segmentIds: ['s2','s1'] }, { episodeId: 'ep-z', segmentIds: ['s1'] }] };
  const selected = await createBatchPlan(f.root, { selection, concurrency: 2 });
  expect(selected.plan.items.map(i => i.episodeId + '/' + i.segmentId)).toEqual(['ep-m/s2','ep-m/s1','ep-z/s1']);
  const all = await createBatchPlan(f.root, { allEpisodes: true });
  expect(all.plan.items.map(i => i.episodeId)).toEqual(['ep-z','ep-z','ep-a','ep-a','ep-m','ep-m']);
  await expect(createBatchPlan(f.root, { episodes: ['ep-z'], allEpisodes: true })).rejects.toMatchObject({ code: 'BATCH_SCOPE' });
  await expect(createBatchPlan(f.root, { selection: { ...selection, episodes: [selection.episodes[0], selection.episodes[0]] } })).rejects.toMatchObject({ code: 'BATCH_SCOPE' });
  const noNetwork: VideoClient = { async create() { throw new Error('must not POST'); }, async query() { throw new Error('must not GET'); } };
  expect((await runCli(['batch','resume','--root',f.root,'--batch',selected.plan.batchId], { client: noNetwork })).data).toMatchObject({ error: { code: 'GENERATION_NOT_AUTHORIZED' } });
  expect((await runCli(['batch','run','--root',f.root,'--batch',selected.plan.batchId], { client: noNetwork })).data).toMatchObject({ error: { code: 'GENERATION_NOT_AUTHORIZED' } });
  expect((await runCli(['batch','status','--root',f.root,'--batch',selected.plan.batchId], { client: noNetwork })).exitCode).toBe(0);
});

it('sends true and preserves exact ordered image/audio content through the actual HTTP adapter', async () => {
  const f = await fixture('镜头 {{ref:b}} 与 {{ref:a}}。林舟：“快走！”旁白：天亮了。\n');
  const start = f.text.indexOf('天亮了。');
  await importStory(f.root, { ...f.draft, recipes: [{ assetId:'a',kind:'character',prompt:'人物完整配方' },{ assetId:'b',kind:'scene',prompt:'场景完整配方' },{ assetId:'n',kind:'narration',prompt:'原旁白' }],
    segments: [{ ...f.draft.segments[0], duration:6.963, references:[{assetId:'a',role:'reference_image'},{assetId:'b',role:'reference_image'}], narration:{assetId:'n',cues:[{start,end:start+4}]} }] });
  for (const [id, bytes] of [['a',png()],['b',png(512,512)],['n',wav(3.125)]] as const) {
    const file = join(dirname(f.root),id + (id === 'n' ? '.wav' : '.png')); await writeFile(file,bytes); await registerAsset(f.root,id,{file});
  }
  const before = await readFile(join(f.root,'metasocli.yaml'));
  const planned = await runCli(['batch','plan','--root',f.root,'--episodes','ep-1','--concurrency','4']);
  expect(planned.exitCode).toBe(0);
  const batch = planned.data as Awaited<ReturnType<typeof createBatchPlan>>;
  const plan = await import('../src/core/planning.js').then(m => m.loadPlan(f.root,batch.plan.items[0]!.planId)), expected = (await validatePlan(f.root,plan)).built[0]!.request;
  let creates = 0;
  const client = new MetasoClient('offline',async (_url,init) => {
    if (init?.method === 'POST') { creates++; expect(JSON.parse(String(init.body))).toEqual(expected); expect(expected.context_ir_enabled).toBe(true); return Response.json({task_id:'ordered-body'}); }
    return Response.json({task:{id:'ordered-body',model:'MiniMax-H3',task_type:'generation',status:'succeeded',duration:7,content:{url:'https://example.com/video.mp4'}}});
  });
  const deps={client,fetcher:async()=>new Response(mp4(7))};
  const generated=await runCli(['batch','run','--root',f.root,'--batch',batch.plan.batchId,'--confirm','--poll-ms','0'],deps);
  expect(generated).toMatchObject({exitCode:0,data:{run:{status:'complete'}}});
  expect((await runCli(['batch','status','--root',f.root,'--batch',batch.plan.batchId])).exitCode).toBe(0);
  expect((await runCli(['batch','resume','--root',f.root,'--batch',batch.plan.batchId],deps)).exitCode).toBe(0);
  expect(creates).toBe(1); expect(await readFile(join(f.root,'metasocli.yaml'))).toEqual(before);
}, 60000);
