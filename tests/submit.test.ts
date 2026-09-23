import { afterEach, expect, it } from 'vitest';
import { cleanup, imported, fixture, png } from './helpers.js';
import { importStory } from '../src/core/project.js';
import { registerAsset } from '../src/assets/registry.js';
import { createPlan } from '../src/core/planning.js';
import { submit } from '../src/jobs/submit.js';
import { listJobs, persistence } from '../src/jobs/store.js';
import { ProviderError, type VideoClient } from '../src/metaso/client.js';
import { sha256Hex } from '../src/storage/canonical.js';
afterEach(cleanup);
const evidence = { sha256: sha256Hex('{}'), response: { task_id: 'a' } };
function fake(onCreate?: () => Promise<any>): VideoClient & { creates: number } {
  return { creates: 0, async create() { this.creates++; return onCreate ? onCreate() : { taskId: 'a', evidence }; }, async query(taskId) { return { taskId, status: 'queued', rawStatus: 'queued', evidence }; } };
}
async function setup() { const f = await imported(); return { ...f, plan: await createPlan(f.root, 'ep-1') }; }
it('persists intent before creation and deduplicates repeated execution and equivalent plans', async () => {
  const f = await setup(); const client = fake(async () => {
    expect((await listJobs(f.root))[0]!.status).toBe('submitting'); // A verified live owner keeps its durable intent in-flight; lost ownership is still unknown.
    return { taskId: 'a', evidence };
  });
  const first = await submit(f.root, f.plan.planId, 's1', true, { client });
  expect(first.status).toBe('queued');
  const plan2 = await createPlan(f.root, 'ep-1');
  expect((await submit(f.root, plan2.planId, 's1', true, { client })).operationId).toBe(first.operationId);
  expect(client.creates).toBe(1);
});
it('does not write or call provider without generation authorization', async () => {
  const f = await setup(), client = fake();
  await expect(submit(f.root, f.plan.planId, 's1', false, { client })).rejects.toMatchObject({ code: 'GENERATION_NOT_AUTHORIZED' });
  expect(await listJobs(f.root)).toHaveLength(0); expect(client.creates).toBe(0);
});
it('unknown creation is sticky across restart and cannot be explicitly retried', async () => {
  const f = await setup(), client = fake(async () => { throw new Error('connection reset after server accepted'); });
  const job = await submit(f.root, f.plan.planId, 's1', true, { client });
  expect(job.status).toBe('submit_unknown');
  expect((await submit(f.root, f.plan.planId, 's1', true, { client })).status).toBe('submit_unknown');
  await expect(submit(f.root, f.plan.planId, 's1', true, { client }, job.operationId)).rejects.toMatchObject({ code: 'RETRY_FORBIDDEN' });
  expect(client.creates).toBe(1);
});
it('recovers a persisted receipt when the job update fails after remote acceptance', async () => {
  const f = await setup(), client = fake();
  await expect(submit(f.root, f.plan.planId, 's1', true, { client, persistence: { ...persistence, async job(root, job) { if (job.status === 'queued') throw new Error('disk failed'); await persistence.job(root, job); } } })).rejects.toMatchObject({ code: 'RECEIPT_PERSISTENCE' });
  const recovered = await submit(f.root, f.plan.planId, 's1', true, { client });
  expect(recovered).toMatchObject({ status: 'queued', taskId: 'a' }); expect(client.creates).toBe(1);
});
it('receipt loss never leads to blind resubmission, even with a known ID in memory', async () => {
  const f = await setup(), client = fake();
  await expect(submit(f.root, f.plan.planId, 's1', true, { client, persistence: { ...persistence, async receipt() { throw new Error('disk failed'); } } })).rejects.toThrow('remote task a');
  expect((await submit(f.root, f.plan.planId, 's1', true, { client })).status).toBe('submit_unknown');
  expect(client.creates).toBe(1);
});
it('only explicitly retried rejected attempts create a second tracked operation', async () => {
  const f = await setup(), client = fake(async () => { throw new ProviderError('HTTP', 'rejected', { rejected: true }); });
  const first = await submit(f.root, f.plan.planId, 's1', true, { client });
  expect(first.status).toBe('failed');
  await submit(f.root, f.plan.planId, 's1', true, { client }); expect(client.creates).toBe(1);
  const retry = await submit(f.root, f.plan.planId, 's1', true, { client }, first.operationId);
  expect(retry).toMatchObject({ attempt: 2, retryOf: first.operationId });
  await submit(f.root, f.plan.planId, 's1', true, { client }, first.operationId); expect(client.creates).toBe(2);
});
it('two concurrent callers acquire only one submission permit', async () => {
  const f = await setup(), client = fake(async () => { await new Promise(r => setTimeout(r, 80)); return { taskId: 'a', evidence }; });
  const results = await Promise.allSettled([submit(f.root, f.plan.planId, 's1', true, { client }), submit(f.root, f.plan.planId, 's1', true, { client })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(client.creates).toBe(1);
});
it('revalidates public URL bytes before intent and keeps changed URL material identities distinct', async () => {
  const f = await fixture(), url = 'https://cdn.example.com/reference.png';
  await importStory(f.root, { ...f.draft, recipes: [{ assetId: 'a', kind: 'scene', prompt: '雨后街道' }], segments: [{ ...f.draft.segments[0], references: [{ assetId: 'a', role: 'reference_image' }] }] });
  await registerAsset(f.root, 'a', { url }, async () => new Response(png()));
  const first = await createPlan(f.root, 'ep-1'), client = fake(async () => { throw new ProviderError('HTTP', 'rejected', { rejected: true }); });
  await expect(submit(f.root, first.planId, 's1', true, { client, fetcher: async () => new Response(png(512, 512)) })).rejects.toMatchObject({ code: 'REMOTE_ASSET_CHANGED' });
  expect(client.creates).toBe(0); expect(await listJobs(f.root)).toHaveLength(0);
  await submit(f.root, first.planId, 's1', true, { client, fetcher: async () => new Response(png()) });
  await registerAsset(f.root, 'a', { url }, async () => new Response(png(512, 512)));
  const second = await createPlan(f.root, 'ep-1');
  expect(second.segments[0]!.requestHash).toBe(first.segments[0]!.requestHash);
  await submit(f.root, second.planId, 's1', true, { client, fetcher: async () => new Response(png(512, 512)) });
  expect(client.creates).toBe(2);
});
