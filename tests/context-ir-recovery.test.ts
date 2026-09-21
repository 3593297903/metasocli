import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, mp4, png } from './helpers.js';
import { irFixture, irEvidence, reviewFor } from './context-ir-fixtures.js';
import { submitContextIr, resumeContextIr, attachContextIrTask } from '../src/jobs/context-ir.js';
import { irPersistence, readIrOperation, listIrOperations, readIrPrompt } from '../src/jobs/context-ir-store.js';
import { createPlan, createPlanFromContextIr, loadPlan } from '../src/core/planning.js';
import { submit } from '../src/jobs/submit.js';
import { resume, attachTask } from '../src/jobs/resume.js';
import { persistence } from '../src/jobs/store.js';
import { ProviderError, type ContextIrClient } from '../src/metaso/client.js';
import { registerAsset } from '../src/assets/registry.js';
import { writeJson } from '../src/storage/io.js';
import { loadStory, importStory } from '../src/core/project.js';
import { operationKind } from '../src/jobs/submission-guard.js';
afterEach(cleanup);

async function done(f: Awaited<ReturnType<typeof irFixture>>) {
  const op = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
  return resumeContextIr(f.root, op.operationId, { client: f.irClient });
}

it.each(['timeout', 'receipt', 'checkpoint'])('recovers %s creation interruption without repeating IR', async failure => {
  const f = await irFixture();
  if (failure === 'timeout') f.irClient.createContextIr = async () => { f.counts.ir++; throw new Error('accepted but response lost'); };
  const deps = { client: f.irClient, persistence: { ...irPersistence,
    async receipt(root: string, value: Parameters<typeof irPersistence.receipt>[1]) { if (failure === 'receipt') throw new Error('disk'); await irPersistence.receipt(root, value); },
    async operation(root: string, value: Parameters<typeof irPersistence.operation>[1]) { if (failure === 'checkpoint' && value.status === 'queued') throw new Error('disk'); await irPersistence.operation(root, value); },
  } };
  if (failure === 'timeout') expect((await submitContextIr(f.root, f.plan.planId, 's1', true, deps)).status).toBe('submit_unknown');
  else await expect(submitContextIr(f.root, f.plan.planId, 's1', true, deps)).rejects.toMatchObject({ code: 'IR_RECEIPT_PERSISTENCE' });
  const op = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
  expect(op.status).toBe(failure === 'checkpoint' ? 'queued' : 'submit_unknown');
  expect(f.counts.ir).toBe(1);
  await expect(submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient }, op.operationId)).rejects.toMatchObject({ code: 'RETRY_FORBIDDEN' });
  if (failure !== 'checkpoint') {
    await expect(attachContextIrTask(f.root, op.operationId, 'ir-1', false, { client: f.irClient })).rejects.toMatchObject({ code: 'TASK_LINK_REQUIRED' });
    await attachContextIrTask(f.root, op.operationId, 'ir-1', true, { client: f.irClient });
  }
  expect((await resumeContextIr(f.root, op.operationId, { client: f.irClient })).status).toBe('enhanced'); expect(f.counts.ir).toBe(1);
});

it('recovers a saved IR result after the enhanced checkpoint fails without requery or create', async () => {
  const f = await irFixture(), op = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
  await expect(resumeContextIr(f.root, op.operationId, { client: f.irClient, persistence: { ...irPersistence,
    async operation(root, value) { if (value.status === 'enhanced') throw new Error('crashed after result receipt'); await irPersistence.operation(root, value); },
  } })).rejects.toThrow('crashed after result receipt');
  f.irClient.queryContextIr = async () => { throw new Error('do not requery'); };
  const recovered = await resumeContextIr(f.root, op.operationId, { client: f.irClient });
  expect(await readIrPrompt(f.root, recovered)).toBe(f.prompt); expect(f.counts).toMatchObject({ ir: 1, queries: 1, video: 0 });
});

it.each(['reserved', 'plan-written', 'linked'])('reuses reserved plan identity after %s interruption', async stage => {
  const f = await irFixture(), op = await done(f), review = reviewFor(op);
  await expect(createPlanFromContextIr(f.root, op.operationId, review, {
    async operation(root, value) {
      if (stage === 'linked' && value.derived?.planHash) throw new Error('checkpoint interrupted');
      await irPersistence.operation(root, value);
      if (stage === 'reserved' && value.derived && !value.derived.planHash) throw new Error('checkpoint interrupted');
    },
    async plan(root, plan) {
      await writeJson(join(root, `.metasocli/plans/${plan.planId}.json`), plan);
      if (stage === 'plan-written') throw new Error('checkpoint interrupted');
    },
  })).rejects.toThrow('checkpoint interrupted');
  const candidate = (await readIrOperation(f.root, op.operationId)).derived!;
  const plan = await createPlanFromContextIr(f.root, op.operationId, review);
  expect(plan.planId).toBe(candidate.planId); expect(plan.createdAt).toBe(candidate.createdAt);
  expect((await loadPlan(f.root, plan.planId)).planHash).toBe(plan.planHash);
  expect((await createPlanFromContextIr(f.root, op.operationId, review)).planHash).toBe(plan.planHash);
  expect(f.counts).toMatchObject({ ir: 1, video: 0 });
});

it('serializes concurrent creation, equivalent preparation and derivation', async () => {
  const f = await irFixture(), plan2 = await createPlan(f.root, 'ep-1', 'h3-context-ir');
  const results = await Promise.allSettled([f.plan, plan2].map(plan => submitContextIr(f.root, plan.planId, 's1', true, { client: f.irClient })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(f.counts.ir).toBe(1);
  const op = (await listIrOperations(f.root))[0]!;
  await expect(submit(f.root, (await createPlan(f.root, 'ep-1')).planId, 's1', true, { client: f.videoClient })).rejects.toMatchObject({ code: 'JOB_ACTIVE' });
  const finished = await resumeContextIr(f.root, op.operationId, { client: f.irClient }), review = reviewFor(finished);
  const plans = await Promise.allSettled([1, 2].map(() => createPlanFromContextIr(f.root, op.operationId, review)));
  expect(plans.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const chosen = await createPlanFromContextIr(f.root, op.operationId, review);
  const videoResults = await Promise.allSettled([1, 2].map(() => submit(f.root, chosen.planId, 's1', true, { client: f.videoClient })));
  expect(videoResults.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(f.counts).toMatchObject({ ir: 1, video: 1 });
});

it.each(['ir', 'video'])('blocks new creation in the other phase while %s submission is unknown', async stage => {
  const f = await irFixture(), plain = await createPlan(f.root, 'ep-1');
  if (stage === 'ir') {
    f.irClient.createContextIr = async () => { f.counts.ir++; throw new Error('lost'); };
    await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
    await expect(submit(f.root, plain.planId, 's1', true, { client: f.videoClient })).rejects.toMatchObject({ code: 'SUBMIT_UNKNOWN' });
    expect(f.counts.video).toBe(0);
  } else {
    f.videoClient.create = async () => { f.counts.video++; throw new Error('lost'); };
    await submit(f.root, plain.planId, 's1', true, { client: f.videoClient });
    await expect(submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient })).rejects.toMatchObject({ code: 'SUBMIT_UNKNOWN' });
    expect(f.counts.ir).toBe(0);
  }
});

it('bounds IR query retry and distinguishes malformed/unknown/failed/cancelled states', async () => {
  const f = await irFixture(), op = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
  const waits: number[] = []; let queries = 0;
  f.irClient.queryContextIr = async taskId => { queries++; if (queries === 1) throw new ProviderError('HTTP', 'rate limited', { retryable: true, retryAfterMs: 1500 }); return { taskId, model: 'MiniMax-H3', taskType: 'h3_context_ir', status: 'running', rawStatus: 'running', evidence: irEvidence }; };
  const job = await resumeContextIr(f.root, op.operationId, { client: f.irClient, sleep: async ms => { waits.push(ms); } }, { maxPolls: 2, pollIntervalMs: 1 });
  expect(job.lastError?.code).toBe('POLL_LIMIT'); expect(waits).toEqual([1500, 1]);
  f.irClient.queryContextIr = async () => { throw new ProviderError('IR_QUERY_CONTRACT', 'wrong type', { evidence: irEvidence }); };
  expect((await resumeContextIr(f.root, op.operationId, { client: f.irClient })).status).toBe('query_unknown');
  f.irClient.queryContextIr = async () => { throw new ProviderError('HTTP', 'rate limited', { retryable: true, retryAfterMs: 60001 }); };
  expect((await resumeContextIr(f.root, op.operationId, { client: f.irClient })).lastError?.code).toBe('QUERY_DEFERRED');
  for (const state of ['unknown', 'failed', 'cancelled'] as const) {
    await irPersistence.operation(f.root, { ...op, status: 'queued' });
    f.irClient.queryContextIr = async taskId => ({ taskId, model: 'MiniMax-H3', taskType: 'h3_context_ir', status: state, rawStatus: state, evidence: irEvidence });
    expect((await resumeContextIr(f.root, op.operationId, { client: f.irClient })).status).toBe(state === 'unknown' ? 'query_unknown' : state);
  }
  expect(f.counts.ir).toBe(1);
});

it('allows only an explicit failed IR retry and reuses the passed IR for video retries/downloads', async () => {
  const f = await irFixture(), firstCreate = f.irClient.createContextIr;
  f.irClient.createContextIr = async () => { f.counts.ir++; throw new ProviderError('HTTP', 'rejected', { rejected: true }); };
  const failedIr = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
  f.irClient.createContextIr = firstCreate;
  expect((await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient })).status).toBe('failed');
  const retryIr = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient }, failedIr.operationId);
  expect(retryIr.attempt).toBe(2);
  const op = await resumeContextIr(f.root, retryIr.operationId, { client: f.irClient }), plan = await createPlanFromContextIr(f.root, op.operationId, reviewFor(op));
  f.videoClient.create = async () => { f.counts.video++; throw new ProviderError('HTTP', 'rejected', { rejected: true }); };
  const failedVideo = await submit(f.root, plan.planId, 's1', true, { client: f.videoClient });
  f.videoClient.create = async () => { f.counts.video++; return { taskId: 'video-retry', evidence: irEvidence }; };
  const video = await submit(f.root, plan.planId, 's1', true, { client: f.videoClient }, failedVideo.operationId);
  expect((await resume(f.root, video.operationId, { client: f.videoClient, fetcher: async () => { throw new Error('lost download'); } })).lastError?.code).toBe('DOWNLOAD_FAILED');
  expect((await resume(f.root, video.operationId, { client: f.videoClient, fetcher: async () => new Response(mp4(7)) })).status).toBe('downloaded');
  expect(f.counts).toMatchObject({ ir: 2, video: 2 });
});

it('validates current public reference bytes independently at both paid boundaries', async () => {
  const f = await irFixture();
  await registerAsset(f.root, 'a', { url: 'https://example.com/a.png?signature=private' }, async () => new Response(png()));
  const prepare = await createPlan(f.root, 'ep-1', 'h3-context-ir');
  await expect(submitContextIr(f.root, prepare.planId, 's1', true, { client: f.irClient, fetcher: async () => new Response(png(512, 512)) })).rejects.toMatchObject({ code: 'REMOTE_ASSET_CHANGED' });
  expect(f.counts.ir).toBe(0);
  const queued = await submitContextIr(f.root, prepare.planId, 's1', true, { client: f.irClient, fetcher: async () => new Response(png()) });
  const op = await resumeContextIr(f.root, queued.operationId, { client: f.irClient }), video = await createPlanFromContextIr(f.root, op.operationId, reviewFor(op));
  await expect(submit(f.root, video.planId, 's1', true, { client: f.videoClient, fetcher: async () => new Response(png(512, 512)) })).rejects.toMatchObject({ code: 'REMOTE_ASSET_CHANGED' });
  expect(f.counts.video).toBe(0); expect(JSON.stringify(video)).not.toContain('signature=');
});

it('checks IR task type on attach and catches cross-namespace operation collisions', async () => {
  const f = await irFixture(); f.irClient.createContextIr = async () => { throw new Error('lost'); };
  const op = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
  const wrong: ContextIrClient = { ...f.irClient, async queryContextIr() { throw new ProviderError('IR_QUERY_CONTRACT', 'video result'); } };
  await expect(attachContextIrTask(f.root, op.operationId, 'video-id', true, { client: wrong })).rejects.toMatchObject({ code: 'IR_QUERY_CONTRACT' });
  await writeFile(join(f.root, `.metasocli/jobs/${op.operationId}.json`), '{}');
  await expect(operationKind(f.root, op.operationId)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
});

it.each(['ir', 'video'])('prevents attaching an existing task ID from the other namespace to %s', async stage => {
  const f = await irFixture();
  if (stage === 'ir') {
    const video = await submit(f.root, (await createPlan(f.root, 'ep-1')).planId, 's1', true, { client: f.videoClient });
    await resume(f.root, video.operationId, { client: f.videoClient, fetcher: async () => new Response(mp4(7)) });
    f.irClient.createContextIr = async () => { throw new Error('lost'); };
    const ir = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
    await expect(attachContextIrTask(f.root, ir.operationId, video.taskId!, true, { client: f.irClient })).rejects.toMatchObject({ code: 'TASK_LINK_CONFLICT' });
  } else {
    const ir = await done(f), plan = await createPlanFromContextIr(f.root, ir.operationId, reviewFor(ir));
    f.videoClient.create = async () => { throw new Error('lost'); };
    const video = await submit(f.root, plan.planId, 's1', true, { client: f.videoClient });
    await expect(attachTask(f.root, video.operationId, ir.taskId!, true, { client: f.videoClient })).rejects.toMatchObject({ code: 'TASK_LINK_CONFLICT' });
  }
});
