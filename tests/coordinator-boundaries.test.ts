import { afterAll, afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { batchFixture, evidence } from './batch-helpers.js';
import { cleanup, mp4 } from './helpers.js';
import { runCli } from '../src/cli/main.js';
import { runBatch } from '../src/jobs/batch.js';
import { occupied, reconcileRuntime, runtimeDirectory, type LedgerState } from '../src/jobs/coordinator.js';
import { listJobs, receiptPath } from '../src/jobs/store.js';
import { canonicalSha256 } from '../src/storage/canonical.js';
import { contains } from '../src/storage/paths.js';
import type { VideoClient } from '../src/metaso/client.js';

afterEach(cleanup);
const records: unknown[] = [];
afterAll(async () => {
  const output = resolve('.work/video-batch-review-fix');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'boundary-regressions.json'), JSON.stringify({ fakeClientsOnly: true, platform: process.platform, cases: records }, null, 2));
});
const polling = { maxPolls: 1, pollIntervalMs: 0 };
const fetcher = async () => new Response(mp4(7));
const ledgerPath = () => join(runtimeDirectory(), 'video-ledger.json');
const readLedger = async (): Promise<LedgerState> => JSON.parse(await readFile(ledgerPath(), 'utf8'));
async function rewriteLegacyLedger(change: (ledger: LedgerState) => void) {
  const ledger = await readLedger(); change(ledger);
  const { hash: _, ...base } = ledger; ledger.hash = canonicalSha256(base);
  await writeFile(ledgerPath(), JSON.stringify(ledger));
}
// Moves and copies are strictly inside the helper's disposable fixture parent.
async function moveFixture(root: string) {
  const target = join(dirname(root), 'ArchivedStory');
  for (const path of [root, target]) expect(contains(dirname(root), path) && resolve(path) !== resolve(dirname(root))).toBe(true);
  await rename(root, target); return target;
}
const generateArgs = (root: string, plan: string) => ['generate', '--root', root, '--plan', plan, '--segment', 's1', '--confirm', '--submit-only'];

it.skipIf(process.platform !== 'win32')('public CLI persists one receipt and resumes the original ID across Windows root casing', async () => {
  const f = await batchFixture([1]); let posts = 0;
  const queried: string[] = [];
  const client: VideoClient = {
    async create(request) { expect(request.context_ir_enabled).toBe(true); posts++; return { taskId: 'case-original-task', evidence }; },
    async query(taskId) { queried.push(taskId); return { taskId, status: 'generated', rawStatus: 'succeeded', duration: 7, url: 'https://example.com/video.mp4', evidence }; },
  };
  const registered = await runCli(['batch', 'register', '--root', f.root.toUpperCase()], { client });
  expect(registered.exitCode).toBe(0);
  const generated = await runCli(generateArgs(f.root.toLowerCase(), f.batch.plan.items[0]!.planId), { client });
  expect(generated.exitCode, JSON.stringify(generated.data)).toBe(0);
  const [job] = await listJobs(f.root);
  expect(job).toMatchObject({ status: 'queued', taskId: 'case-original-task' });
  const receipt = JSON.parse(await readFile(await receiptPath(f.root, job!.operationId), 'utf8'));
  expect(receipt).toMatchObject({ operationId: job!.operationId, taskId: 'case-original-task', requestHash: job!.requestHash });
  const resumed = await runCli(['resume', '--root', f.root.toUpperCase(), '--operation', job!.operationId, '--max-polls', '1', '--poll-ms', '0'], { client, fetcher });
  expect(resumed.exitCode, JSON.stringify(resumed.data)).toBe(0);
  expect((await listJobs(f.root))[0]).toMatchObject({ operationId: job!.operationId, taskId: job!.taskId, status: 'downloaded' });
  expect((await runCli(generateArgs(f.root, f.batch.plan.items[0]!.planId), { client })).exitCode).toBe(0);
  expect(posts).toBe(1); expect(queried).toEqual(['case-original-task']);
  expect((await reconcileRuntime(f.root)).projects).toHaveLength(1);
  records.push({ name: 'CLI case change', posts, receipt, queried, finalStatus: 'downloaded', operationIdPreserved: true });
}, 30000);

it.skipIf(process.platform !== 'win32')('migrates equivalent roots in legacy ledger entries and assigns batch query events to their segment', async () => {
  const f = await batchFixture([1]); let posts = 0, done = false;
  const client: VideoClient = {
    async create() { posts++; return { taskId: 'legacy-case-task', evidence }; },
    async query(taskId) { return done ? { taskId, status: 'generated', rawStatus: 'succeeded', duration: 7, url: 'https://example.com/video.mp4', evidence }
      : { taskId, status: 'running', rawStatus: 'running', evidence }; },
  };
  await runBatch(f.root, f.batch.plan.batchId, true, { client }, polling);
  await rewriteLegacyLedger(ledger => {
    ledger.projects[0]!.root = f.root.toUpperCase();
    ledger.projects.push({ ...ledger.projects[0]!, root: f.root });
    ledger.slots[0]!.root = f.root.toLowerCase();
  });
  done = true;
  const result = await runBatch(f.root.toUpperCase(), f.batch.plan.batchId, false, { client, fetcher }, polling);
  expect(result.run!.status).toBe('complete'); expect(posts).toBe(1);
  expect(result.run!.trace.some(event => event.event === 'query-result' && event.order === 0)).toBe(true);
  const ledger = await readLedger(); expect(ledger.projects).toHaveLength(1);
  expect(ledger.slots[0]!.root).toBe(ledger.projects[0]!.root);
  records.push({ name: 'legacy case migration and batch attribution', posts, taskId: ledger.slots[0]!.taskId, trace: result.run!.trace });
}, 30000);

it('rejects a cloned project in a different real directory without another POST', async () => {
  const f = await batchFixture([1]); let posts = 0;
  const client: VideoClient = { async create() { posts++; return { taskId: 'different-root-task', evidence }; }, async query() { throw new Error('unused'); } };
  expect((await runCli(generateArgs(f.root, f.batch.plan.items[0]!.planId), { client })).exitCode).toBe(0);
  const clone = join(dirname(f.root), 'DifferentStory'); expect(contains(dirname(f.root), clone)).toBe(true);
  await cp(f.root, clone, { recursive: true });
  const result = await runCli(['batch', 'register', '--root', clone], { client });
  expect(result).toMatchObject({ exitCode: 1, data: { error: { code: 'COORDINATOR_CONFLICT' } } });
  expect(posts).toBe(1); expect(occupied(await readLedger())).toHaveLength(1);
}, 30000);

it.each([false, true])('a completed project can be archived without blocking a new project (legacy ledger: %s)', async legacy => {
  const a = await batchFixture([1]), b = await batchFixture([1]); let posts = 0;
  const client: VideoClient = {
    async create(request) { expect(request.context_ir_enabled).toBe(true); return { taskId: 'archive-task-' + ++posts, evidence }; },
    async query(taskId) { return { taskId, status: 'generated', rawStatus: 'succeeded', duration: 7, url: 'https://example.com/video.mp4', evidence }; },
  };
  expect((await runBatch(a.root, a.batch.plan.batchId, true, { client, fetcher }, polling)).run!.status).toBe('complete');
  const before = await reconcileRuntime(a.root); expect(occupied(before)).toHaveLength(0);
  const oldSlot = before.slots[0]!;
  if (legacy) await rewriteLegacyLedger(ledger => { ledger.projects = ledger.projects.map(({ root, projectId }) => ({ root, projectId })); });
  const archived = await moveFixture(a.root);
  const result = await runCli(['batch', 'run', '--root', b.root, '--batch', b.batch.plan.batchId, '--confirm', '--max-polls', '1', '--poll-ms', '0'], { client, fetcher });
  expect(result.exitCode, JSON.stringify(result.data)).toBe(0); expect(posts).toBe(2);
  const ledger = await readLedger(); expect(occupied(ledger)).toHaveLength(0);
  expect(ledger.slots.find(slot => slot.operationId === oldSlot.operationId)).toEqual(oldSlot);
  expect(ledger.projects.find(project => project.projectId === oldSlot.projectId)).toHaveProperty('retiredAt');
  expect((await listJobs(archived))[0]).toMatchObject({ operationId: oldSlot.operationId, taskId: oldSlot.taskId, status: 'downloaded' });
  // Original root restored: explicit access revalidates history and reuses its task, not a new POST.
  await rename(archived, a.root);
  expect((await runCli(generateArgs(a.root, a.batch.plan.items[0]!.planId), { client })).exitCode).toBe(0);
  expect(posts).toBe(2);
  records.push({ name: 'completed archive', legacy, posts, newProjectPosts: 1, preserved: oldSlot, retired: true });
}, 45000);

it.each(['reserved', 'prepared', 'submitting', 'queued', 'running', 'submit_unknown', 'query_unknown'] as const)(
  'a missing %s project retains its reservation and blocks new creation', async status => {
    const a = await batchFixture([1]), b = await batchFixture([1]); let posts = 0;
    const unknown = status === 'submit_unknown', beforePost = ['reserved', 'prepared', 'submitting'].includes(status);
    const client: VideoClient = {
      async create() { posts++; if (unknown) throw new Error('accepted but response lost'); return { taskId: 'protected-original-task', evidence }; },
      async query(taskId) { return { taskId, status: status === 'query_unknown' ? 'unknown' : 'running', rawStatus: status, evidence }; },
    };
    await runCli(generateArgs(a.root, a.batch.plan.items[0]!.planId), { client,
      checkpoint: async event => { if (beforePost && event === (status === 'submitting' ? 'intent' : 'reserved')) throw new Error('process stopped at durable boundary'); },
    });
    if (status === 'prepared') await reconcileRuntime(a.root);
    if (status === 'running' || status === 'query_unknown') {
      const [job] = await listJobs(a.root);
      await runCli(['status', '--root', a.root, '--operation', job!.operationId, '--remote'], { client });
    }
    // A prior coordinator may have persisted submitting just before the owner died.
    if (status === 'submitting') await rewriteLegacyLedger(ledger => { ledger.slots[0]!.status = 'submitting'; });
    if (status === 'query_unknown') await rewriteLegacyLedger(ledger => { ledger.projects[0]!.retiredAt = new Date().toISOString(); });
    const original = await readFile(ledgerPath(), 'utf8'), before = await readLedger(), postsBeforeMove = posts;
    expect(before.slots[0]!.status).toBe(status);
    const archived = await moveFixture(a.root);
    const rejected = await runCli(generateArgs(b.root, b.batch.plan.items[0]!.planId), { client });
    expect(rejected).toMatchObject({ exitCode: 1, data: { error: { code: 'COORDINATOR_PROJECT_MISSING' } } }); expect(posts).toBe(postsBeforeMove);
    expect(await readFile(ledgerPath(), 'utf8')).toBe(original);
    expect(occupied(await readLedger())).toHaveLength(1);
    // Moving the active directory is not a supported way to reacquire its identity/capacity.
    expect((await runCli(['batch', 'register', '--root', archived], { client })).exitCode).toBe(1);
    await rename(archived, a.root);
    if (!beforePost) {
      const [job] = await listJobs(a.root);
      if (!unknown) {
        const recovered = await runCli(['status', '--root', a.root, '--operation', job!.operationId, '--remote'], { client });
        expect(recovered.exitCode).toBe(status === 'query_unknown' ? 2 : 0);
        expect((await listJobs(a.root))[0]!.taskId).toBe('protected-original-task');
      }
      await runCli(generateArgs(a.root, a.batch.plan.items[0]!.planId), { client });
      expect(posts).toBe(postsBeforeMove);
    }
    records.push({ name: 'missing protected root', status, posts, newProjectPosts: 0, retainedSlot: before.slots[0] });
  }, 30000);

it('does not treat a missing empty registration as confirmed terminal history', async () => {
  const a = await batchFixture([1]), b = await batchFixture([1]); let posts = 0;
  await reconcileRuntime(a.root);
  const original = await readFile(ledgerPath(), 'utf8');
  await moveFixture(a.root);
  const client: VideoClient = { async create() { posts++; throw new Error('must not submit'); }, async query() { throw new Error('unused'); } };
  const result = await runCli(generateArgs(b.root, b.batch.plan.items[0]!.planId), { client });
  expect(result).toMatchObject({ exitCode: 1, data: { error: { code: 'COORDINATOR_PROJECT_MISSING' } } });
  expect(posts).toBe(0); expect(await readFile(ledgerPath(), 'utf8')).toBe(original);
}, 30000);
