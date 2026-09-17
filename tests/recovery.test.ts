import { afterEach, expect, it } from 'vitest';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, imported, mp4 } from './helpers.js';
import { createPlan } from '../src/core/planning.js';
import { loadStory } from '../src/core/project.js';
import { submit } from '../src/jobs/submit.js';
import { resume, attachTask } from '../src/jobs/resume.js';
import { readJob, persistence } from '../src/jobs/store.js';
import { inspectVideo } from '../src/jobs/video.js';
import { sha256Hex } from '../src/storage/canonical.js';
import { ProviderError, type VideoClient, type Observation } from '../src/metaso/client.js';
afterEach(cleanup);
const evidence = { sha256: sha256Hex('{}'), response: {} };
async function setup() {
  const f = await imported(), plan = await createPlan(f.root, 'ep-1');
  const client: VideoClient & { creates: number; queries: number; observe: () => Promise<Observation> } = {
    creates: 0, queries: 0,
    async create() { this.creates++; return { taskId: 'task-1', evidence }; },
    async query() { this.queries++; return this.observe(); },
    async observe() { return { taskId: 'task-1', status: 'generated', rawStatus: 'succeeded', duration: 6, resolution: '768P', url: 'https://cdn.example.com/output.mp4?signature=private', evidence }; },
  };
  const job = await submit(f.root, plan.planId, 's1', true, { client });
  return { ...f, plan, job, client };
}
it('resumes using the original task ID after source changes and saves verified output', async () => {
  const f = await setup(); const story = await loadStory(f.root);
  await writeFile(join(f.root, story.episodes[0]!.source.textPath), 'later content change');
  const headers: any[] = [];
  const result = await resume(f.root, f.job.operationId, { client: f.client, fetcher: async (_url, init) => { headers.push(init?.headers); return new Response(mp4(), { headers: { 'content-type': 'video/mp4', 'content-length': String(mp4().length) } }); } });
  expect(result.status).toBe('downloaded'); expect(result.output).toMatchObject({ duration: 6, width: 768, height: 1366 });
  expect(headers[0].Authorization).toBeUndefined(); expect(f.client.creates).toBe(1);
  expect((await inspectVideo(join(f.root, result.output!.path))).sha256).toBe(result.output!.sha256);
  const second = await resume(f.root, f.job.operationId, { client: f.client, fetcher: async () => { throw new Error('must not fetch'); } });
  expect(second.status).toBe('downloaded'); expect(f.client.queries).toBe(1);
});
it('download interruption retries only query/download and never creates another video', async () => {
  const f = await setup();
  const first = await resume(f.root, f.job.operationId, { client: f.client, fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(mp4().subarray(0, 16)); controller.error(new Error('network lost')); } })) });
  expect(first).toMatchObject({ status: 'generated', lastError: { code: 'DOWNLOAD_FAILED' } });
  const result = await resume(f.root, f.job.operationId, { client: f.client, fetcher: async () => new Response(mp4()) });
  expect(result.status).toBe('downloaded'); expect(f.client.creates).toBe(1);
});
it.each(['html', 'truncated', 'duration'])('rejects invalid %s output without losing the task receipt', async kind => {
  const f = await setup();
  const fetcher = async () => kind === 'html' ? new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } })
    : kind === 'truncated' ? new Response(mp4(), { headers: { 'content-length': String(mp4().length + 1) } }) : new Response(mp4(2));
  const result = await resume(f.root, f.job.operationId, { client: f.client, fetcher });
  expect(result.status).toBe('generated'); expect(result.lastError).toBeDefined(); expect(result.taskId).toBe('task-1'); expect(f.client.creates).toBe(1);
});
it('recovers an atomic output rename followed by a failed job checkpoint without network', async () => {
  const f = await setup();
  await expect(resume(f.root, f.job.operationId, { client: f.client, fetcher: async () => new Response(mp4()), persistence: { ...persistence, async job(root, job) { if (job.status === 'downloaded') throw new Error('disk full'); await persistence.job(root, job); } } })).rejects.toThrow('disk full');
  const job = await resume(f.root, f.job.operationId, { client: { async create() { throw new Error('no create'); }, async query() { throw new Error('no query'); } } });
  expect(job.status).toBe('downloaded');
});
it('bounds read retries, honors Retry-After, and preserves pending state on poll timeout', async () => {
  const f = await setup(); const waits: number[] = [];
  f.client.observe = async () => { if (f.client.queries === 1) throw new ProviderError('HTTP', 'limited', { retryable: true, retryAfterMs: 2000 }); return { taskId: 'task-1', status: 'running', rawStatus: 'running', evidence }; };
  const result = await resume(f.root, f.job.operationId, { client: f.client, sleep: async ms => { waits.push(ms); } }, { maxPolls: 2, pollIntervalMs: 7, download: false });
  expect(result).toMatchObject({ status: 'running', lastError: { code: 'POLL_LIMIT' } });
  expect(waits).toEqual([2000, 7]); expect(f.client.queries).toBe(3); expect(f.client.creates).toBe(1);
  f.client.observe = async () => { throw new ProviderError('HTTP', 'limited', { retryable: true, retryAfterMs: 120000 }); };
  const deferred = await resume(f.root, f.job.operationId, { client: f.client, sleep: async () => { throw new Error('must not shorten Retry-After'); } });
  expect(deferred.lastError?.code).toBe('QUERY_DEFERRED'); expect(deferred.status).toBe('running');
});
it('unknown, failure and cancellation never masquerade as success', async () => {
  for (const state of ['unknown', 'failed', 'cancelled'] as const) {
    const f = await setup(); f.client.observe = async () => ({ taskId: 'task-1', status: state, rawStatus: state, evidence });
    const result = await resume(f.root, f.job.operationId, { client: f.client, fetcher: async () => { throw new Error('must not download'); } });
    expect(result.status).toBe(state === 'unknown' ? 'query_unknown' : state); expect(result.output).toBeUndefined();
  }
});
it('retains a query contract failure for later recovery', async () => {
  const f = await setup(); f.client.observe = async () => { throw new ProviderError('QUERY_CONTRACT', 'unknown envelope', { evidence }); };
  const job = await resume(f.root, f.job.operationId, { client: f.client }); expect(job.status).toBe('query_unknown'); expect(job.evidencePath).toBeDefined();
  expect(await readFile(join(f.root, job.evidencePath!), 'utf8')).not.toContain('signature=private');
});
it('supports explicit restoration of a lost downloaded file using the same remote task', async () => {
  const f = await setup(); const deps = { client: f.client, fetcher: async () => new Response(mp4()) };
  const original = await resume(f.root, f.job.operationId, deps); await unlink(join(f.root, original.output!.path));
  await expect(resume(f.root, f.job.operationId, deps)).rejects.toMatchObject({ code: 'OUTPUT_MISSING' });
  expect((await resume(f.root, f.job.operationId, deps, { redownloadMissing: true })).status).toBe('downloaded'); expect(f.client.creates).toBe(1);
});
it('manually attaches a confirmed provider task ID after total create-receipt loss', async () => {
  const f = await setup();
  await unlink(join(f.root, `.metasocli/receipts/${f.job.operationId}.json`));
  const uncertain = { ...f.job, status: 'submit_unknown' as const }; delete uncertain.taskId; await persistence.job(f.root, uncertain);
  await expect(attachTask(f.root, f.job.operationId, 'task-1', false, { client: f.client })).rejects.toMatchObject({ code: 'TASK_LINK_REQUIRED' });
  expect((await attachTask(f.root, f.job.operationId, 'task-1', true, { client: f.client })).taskId).toBe('task-1');
  expect((await readJob(f.root, f.job.operationId)).status).toBe('queued'); expect(f.client.creates).toBe(1);
});
