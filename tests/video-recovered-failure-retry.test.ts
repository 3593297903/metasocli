import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { cleanup } from './helpers.js';
import { batchFixture, evidence } from './batch-helpers.js';
import { runCli } from '../src/cli/main.js';
import { runBatch } from '../src/jobs/batch.js';
import { batchStatus } from '../src/jobs/batch-store.js';
import { attachTask, resume } from '../src/jobs/resume.js';
import { listJobs, persistence, readJob } from '../src/jobs/store.js';
import { authorizeVideoRetry, retryPath } from '../src/jobs/video-retry.js';
import { occupied, reconcileRuntime } from '../src/jobs/coordinator.js';
import { submit } from '../src/jobs/submit.js';
import type { VideoClient } from '../src/metaso/client.js';
afterEach(cleanup);

async function recovered(status: 'failed' | 'cancelled' = 'failed') {
  const f = await batchFixture([1]), item = f.batch.plan.items[0]!;
  const requests: unknown[] = [];
  const client: VideoClient = {
    async create(request) {
      requests.push(request);
      if (requests.length === 1) throw new Error('A accepted, response lost');
      return { taskId: 'accepted-C', evidence };
    },
    async query(taskId) { return { taskId, status: taskId === 'recovered-A' ? status : 'running', rawStatus: status, evidence }; },
  };
  await runBatch(f.root, f.batch.plan.batchId, true, { client }, { maxPolls: 1, pollIntervalMs: 0 });
  const a = (await listJobs(f.root))[0]!;
  const b = (await authorizeVideoRetry(f.root, item.planId, item.segmentId, a.operationId, true, true)).job;
  const authFile = await retryPath(f.root, a.operationId), authBytes = await readFile(authFile);
  await attachTask(f.root, a.operationId, 'recovered-A', true, { client });
  const args = ['generate', '--root', f.root, '--plan', item.planId, '--segment', item.segmentId, '--retry-of', a.operationId, '--confirm', '--submit-only'];
  const unknownArgs = [...args, '--accept-unknown-result'];
  expect(await runCli(unknownArgs, { client })).toMatchObject({ data: { jobs: [{ operationId: a.operationId }] } });
  expect(await readJob(f.root, b.operationId)).toMatchObject({ status: 'cancelled', lastError: { code: 'RETRY_SUPERSEDED' } });
  expect(await resume(f.root, a.operationId, { client }, { maxPolls: 1, download: false })).toMatchObject({ status });
  return { ...f, item, a, b, client, requests, args, unknownArgs, authFile, authBytes };
}

it.each(['failed', 'cancelled'] as const)('ordinary explicit retry after recovered A is %s creates C once and preserves the obsolete grant', async status => {
  const f = await recovered(status);
  // Neither the original unknown grant nor the old batch authorization creates C.
  await runCli(f.unknownArgs, { client: f.client });
  await runBatch(f.root, f.batch.plan.batchId, false, { client: f.client }, { maxPolls: 1, pollIntervalMs: 0 });
  expect(f.requests).toHaveLength(1);
  const result = await runCli(f.args, { client: f.client });
  expect(result).toMatchObject({ exitCode: 0, data: { jobs: [{ status: 'queued', attempt: 3, retryOf: f.a.operationId, taskId: 'accepted-C' }] } });
  const c = (await listJobs(f.root)).at(-1)!;
  expect(c.operationId).not.toBe(f.b.operationId);
  for (let i = 0; i < 2; i++) {
    expect(await runCli(f.args, { client: f.client })).toMatchObject({ exitCode: 0, data: { jobs: [{ operationId: c.operationId }] } });
    expect(await runCli(f.unknownArgs, { client: f.client })).toMatchObject({ data: { jobs: [{ operationId: f.a.operationId }] } });
  }
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]).toEqual(f.requests[0]);
  expect(await readFile(f.authFile)).toEqual(f.authBytes);
  expect(await readJob(f.root, f.a.operationId)).toMatchObject({ status, taskId: 'recovered-A' });
  expect(await readJob(f.root, f.b.operationId)).toMatchObject({ status: 'cancelled', lastError: { code: 'RETRY_SUPERSEDED' } });
  expect(occupied(await reconcileRuntime(f.root))).toMatchObject([{ operationId: c.operationId }]);
});

it.each(['prepared', 'intent', 'receipt'] as const)('ordinary C survives %s interruption and repeats reuse the same identity', async point => {
  const f = await recovered();
  let interrupted = false;
  const interruptedResult = await runCli(f.args, {
    client: f.client,
    persistence: { ...persistence, async job(root, job) {
      await persistence.job(root, job);
      if (point === 'prepared' && !interrupted && job.status === 'prepared') { interrupted = true; throw new Error('crash after prepared C'); }
    } },
    checkpoint: async event => { if (event === point && !interrupted) { interrupted = true; throw new Error('crash after ' + point); } },
  });
  expect(interrupted).toBe(true);
  expect(interruptedResult.exitCode).toBe(1);
  const c = (await listJobs(f.root)).at(-1)!;
  expect(c).toMatchObject({ attempt: 3, retryOf: f.a.operationId });
  expect(c.operationId).not.toBe(f.b.operationId);
  const result = await runCli(f.args, { client: f.client });
  expect(result).toMatchObject({ data: { jobs: [{ operationId: c.operationId, status: point === 'intent' ? 'submit_unknown' : 'queued' }] } });
  await runCli(f.args, { client: f.client });
  await runCli(f.unknownArgs, { client: f.client });
  expect(f.requests).toHaveLength(point === 'intent' ? 1 : 2);
  expect(await readFile(f.authFile)).toEqual(f.authBytes);
  expect(await listJobs(f.root)).toHaveLength(3);
});

it.each(['prepared', 'receipt'] as const)('existing authorized batch indexes C after %s interruption without reviving B', async point => {
  const f = await recovered();
  await runCli(f.args, {
    client: f.client,
    persistence: { ...persistence, async job(root, job) {
      await persistence.job(root, job);
      if (point === 'prepared' && job.status === 'prepared') throw new Error('crash after C prepared');
    } },
    checkpoint: async event => { if (event === point) throw new Error('crash after C receipt'); },
  });
  const c = (await listJobs(f.root)).at(-1)!;
  expect(c.attempt).toBe(3);
  await runBatch(f.root, f.batch.plan.batchId, false, { client: f.client }, { maxPolls: 1, pollIntervalMs: 0 });
  const status = await batchStatus(f.root, f.batch.plan.batchId);
  expect(status.run!.items[0]!.operationId).toBe(c.operationId);
  expect(status.items[0]!.job).toMatchObject({ operationId: c.operationId, taskId: 'accepted-C', status: 'running' });
  await runBatch(f.root, f.batch.plan.batchId, false, { client: f.client }, { maxPolls: 1, pollIntervalMs: 0 });
  await runCli(f.args, { client: f.client });
  await runCli(f.unknownArgs, { client: f.client });
  expect(f.requests).toHaveLength(2);
  expect(await readFile(f.authFile)).toEqual(f.authBytes);
});

it('the unknown retry command stays bound to B if A recovers and fails during preflight', async () => {
  const f = await batchFixture([1]), item = f.batch.plan.items[0]!;
  let posts = 0;
  const client: VideoClient = {
    async create() { posts++; throw new Error('A response lost'); },
    async query(taskId) { return { taskId, status: 'failed', rawStatus: 'failed', evidence }; },
  };
  const a = await submit(f.root, item.planId, item.segmentId, true, { client });
  const b = (await authorizeVideoRetry(f.root, item.planId, item.segmentId, a.operationId, true, true)).job;
  client.prepare = async () => {
    await attachTask(f.root, a.operationId, 'racing-receipt', true, { client });
    await resume(f.root, a.operationId, { client }, { maxPolls: 1, download: false });
  };
  const args = ['generate', '--root', f.root, '--plan', item.planId, '--segment', item.segmentId, '--retry-of', a.operationId, '--confirm', '--accept-unknown-result', '--submit-only'];
  expect(await runCli(args, { client })).toMatchObject({ data: { jobs: [{ operationId: a.operationId, status: 'failed' }] } });
  expect(posts).toBe(1);
  expect(await listJobs(f.root)).toHaveLength(2);
  expect(await readJob(f.root, b.operationId)).toMatchObject({ status: 'cancelled', lastError: { code: 'RETRY_SUPERSEDED' } });
});

it.each(['failed', 'submit_unknown'] as const)('C becoming %s does not turn either command for A into another grant', async status => {
  const f = await recovered();
  if (status === 'submit_unknown') f.client.create = async request => { f.requests.push(request); throw new Error('C response lost'); };
  await runCli(f.args, { client: f.client });
  const c = (await listJobs(f.root)).at(-1)!;
  if (status === 'failed') {
    f.client.query = async taskId => ({ taskId, status: 'failed', rawStatus: 'failed', evidence });
    await resume(f.root, c.operationId, { client: f.client }, { maxPolls: 1, download: false });
  }
  expect(await runCli(f.args, { client: f.client })).toMatchObject({ data: { jobs: [{ operationId: c.operationId, status }] } });
  await runCli(f.unknownArgs, { client: f.client });
  await runBatch(f.root, f.batch.plan.batchId, false, { client: f.client }, { maxPolls: 1, pollIntervalMs: 0 });
  expect(f.requests).toHaveLength(2);
  f.client.create = async request => { f.requests.push(request); return { taskId: 'accepted-D', evidence }; };
  const nextArgs = f.args.map(arg => arg === f.a.operationId ? c.operationId : arg);
  if (status === 'submit_unknown') nextArgs.push('--accept-unknown-result');
  expect(await runCli(nextArgs, { client: f.client })).toMatchObject({ exitCode: 0, data: { jobs: [{ taskId: 'accepted-D', attempt: 4, retryOf: c.operationId }] } });
  await runCli(nextArgs, { client: f.client });
  await runCli(f.args, { client: f.client });
  await runCli(f.unknownArgs, { client: f.client });
  expect(f.requests).toHaveLength(3);
  expect(await readFile(f.authFile)).toEqual(f.authBytes);
}, 90000); // Full A/B/C/D lifecycle includes repeated CLI and scheduler disk validation.
