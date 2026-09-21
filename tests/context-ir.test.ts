import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, mp4, png } from './helpers.js';
import { irFixture, reviewFor, irEvidence } from './context-ir-fixtures.js';
import { submitContextIr, resumeContextIr, attachContextIrTask } from '../src/jobs/context-ir.js';
import { createPlan, createPlanFromContextIr, loadPlan, validatePlan } from '../src/core/planning.js';
import { loadStory, importStory } from '../src/core/project.js';
import { submit } from '../src/jobs/submit.js';
import { resume } from '../src/jobs/resume.js';
import { readIrOperation, readIrPrompt, irPersistence } from '../src/jobs/context-ir-store.js';
import { canonicalSha256, sha256Hex } from '../src/storage/canonical.js';
import { ProviderError } from '../src/metaso/client.js';
import { runCli } from '../src/cli/main.js';
afterEach(cleanup);

async function enhanced(f: Awaited<ReturnType<typeof irFixture>>) {
  const operation = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
  return resumeContextIr(f.root, operation.operationId, { client: f.irClient });
}

it.each([false, true])('runs one IR plus one video with ordered original assets (narration=%s)', async narrated => {
  const f = await irFixture(narrated), before = await readFile(join(f.root, 'metasocli.yaml'));
  expect(f.counts).toMatchObject({ ir: 0, video: 0 });
  await expect(submit(f.root, f.plan.planId, 's1', true, { client: f.videoClient })).rejects.toMatchObject({ code: 'IR_PREPARE_NOT_VIDEO' });
  const operation = await enhanced(f); expect(f.counts).toMatchObject({ ir: 1, video: 0 });
  const review = reviewFor(operation), plan = await createPlanFromContextIr(f.root, operation.operationId, review);
  expect((await createPlanFromContextIr(f.root, operation.operationId, review)).planHash).toBe(plan.planHash);
  const [{ built: bases }, { built }] = await Promise.all([validatePlan(f.root, f.plan), validatePlan(f.root, plan)]);
  expect(plan.workflow).toMatchObject({ stage: 'video', preparePlanId: f.plan.planId, irOperationId: operation.operationId });
  expect(built[0]!.request.content[0]).toEqual({ type: 'text', text: f.prompt });
  expect(built[0]!.request.content.slice(1)).toEqual(bases[0]!.request.content.slice(1));
  expect(built[0]!.request.context_ir_enabled).toBe(false); expect(plan.segments).toHaveLength(1);
  expect(await readFile(join(f.root, 'metasocli.yaml'))).toEqual(before);
  if (narrated) expect(plan.segments[0]!.assets.at(-1)).toMatchObject({ assetId: 'narrator', duration: 3.125 });
  else expect(built[0]!.request.content.some(c => c.type === 'audio_url')).toBe(false);
  const job = await submit(f.root, plan.planId, 's1', true, { client: f.videoClient });
  const completed = await resume(f.root, job.operationId, { client: f.videoClient, fetcher: async () => new Response(mp4(7)) });
  expect(completed.status).toBe('downloaded');
  const equivalent = await createPlan(f.root, 'ep-1', 'h3-context-ir');
  expect((await submitContextIr(f.root, equivalent.planId, 's1', true, { client: f.irClient })).operationId).toBe(operation.operationId);
  expect((await submit(f.root, plan.planId, 's1', true, { client: f.videoClient })).operationId).toBe(job.operationId);
  expect(f.counts).toMatchObject({ ir: 1, video: 1 });
});

it.each([[12.378, 13], [6.666, 7], [6.963, 7]])('preserves target %s in both phases', async (target, duration) => {
  const f = await irFixture(true, target!);
  const originalIrCreate = f.irClient.createContextIr, originalVideoCreate = f.videoClient.create;
  f.irClient.createContextIr = async request => {
    expect(request.duration).toBe(duration); expect(request).not.toHaveProperty('targetDurationSeconds');
    return originalIrCreate(request);
  };
  f.videoClient.create = async request => {
    expect(request.duration).toBe(duration); expect(request).not.toHaveProperty('targetDurationSeconds');
    return originalVideoCreate(request);
  };
  const operation = await enhanced(f), plan = await createPlanFromContextIr(f.root, operation.operationId, reviewFor(operation));
  expect(f.plan.segments[0]).toMatchObject({ duration, targetDurationSeconds: target });
  expect(plan.segments[0]).toMatchObject({ duration, targetDurationSeconds: target });
  expect(plan.segments[0]!.assets.at(-1)!.duration).toBe(3.125);
  await submit(f.root, plan.planId, 's1', true, { client: f.videoClient });
  expect(f.counts).toMatchObject({ ir: 1, video: 1 });
});

it('persists needs_review without relabeling successful IR or generating video', async () => {
  const f = await irFixture(true), operation = await enhanced(f);
  const review = { ...reviewFor(operation), verdict: 'needs_review', findings: { ...reviewFor(operation).findings, narration: 'IR 将人物对白交给旁白声线，未通过。' } };
  await expect(createPlanFromContextIr(f.root, operation.operationId, review)).rejects.toMatchObject({ code: 'IR_REVIEW_REQUIRED' });
  expect(await readIrOperation(f.root, operation.operationId)).toMatchObject({ status: 'enhanced', review: { verdict: 'needs_review' } });
  await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient }); expect(f.counts).toMatchObject({ ir: 1, video: 0 });
});

it('preserves the exact enhanced UTF-8 text including a leading BOM', async () => {
  const f = await irFixture(), prompt = '\uFEFF' + f.prompt;
  f.irClient.queryContextIr = async taskId => ({ taskId, taskType: 'h3_context_ir', model: 'MiniMax-H3', status: 'enhanced', rawStatus: 'succeeded', prompt, evidence: irEvidence });
  const operation = await enhanced(f), plan = await createPlanFromContextIr(f.root, operation.operationId, reviewFor(operation));
  expect(await readIrPrompt(f.root, operation)).toBe(prompt);
  expect(plan.segments[0]!.renderedPrompt).toBe(prompt);
  expect(plan.segments[0]!.renderedPromptHash).toBe(operation.result!.sha256);
});

it('checks source snapshots before both creations while retaining accepted task recovery', async () => {
  const f = await irFixture(), story = await loadStory(f.root), source = join(f.root, story.episodes[0]!.source.rawPath);
  const bytes = await readFile(source);
  await writeFile(source, 'changed source');
  await expect(submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(f.counts.ir).toBe(0);
  await writeFile(source, bytes);
  const operation = await enhanced(f), plan = await createPlanFromContextIr(f.root, operation.operationId, reviewFor(operation));
  await writeFile(source, 'changed source');
  await expect(submit(f.root, plan.planId, 's1', true, { client: f.videoClient })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(f.counts.video).toBe(0);
  expect((await resumeContextIr(f.root, operation.operationId, { client: f.irClient })).status).toBe('enhanced');
  await writeFile(source, bytes);
  const video = await submit(f.root, plan.planId, 's1', true, { client: f.videoClient });
  await writeFile(source, 'changed after accepted');
  expect((await resume(f.root, video.operationId, { client: f.videoClient, fetcher: async () => new Response(mp4(7)) })).status).toBe('downloaded');
  expect(f.counts).toMatchObject({ ir: 1, video: 1 });
});

it.each([
  ['oversize', '字'.repeat(7001), 'IR_TEXT_LIMIT'], ['dialogue', '天亮了。参考图1参考图2', 'IR_DIALOGUE'],
  ['narration', '快走！参考图1参考图2', 'IR_NARRATION'], ['image', '快走！天亮了。参考图3', 'IR_REFERENCE'],
  ['legacy', '快走！天亮了。{{Node x}}', 'IR_REFERENCE'], ['audio', '快走！天亮了。参考音频2', 'IR_REFERENCE'],
])('keeps %s result for inspection but blocks derived video', async (_name, prompt, code) => {
  const f = await irFixture(true);
  f.irClient.queryContextIr = async taskId => ({ taskId, taskType: 'h3_context_ir', model: 'MiniMax-H3', status: 'enhanced', rawStatus: 'succeeded', prompt, evidence: irEvidence });
  const operation = await enhanced(f);
  expect(await readIrPrompt(f.root, operation)).toBe(prompt);
  await expect(createPlanFromContextIr(f.root, operation.operationId, reviewFor(operation))).rejects.toMatchObject({ code });
  expect(f.counts.video).toBe(0);
});

it('refuses a mismatched review and tampered IR prompt, review or derived provenance', async () => {
  const f = await irFixture(), operation = await enhanced(f), review = reviewFor(operation);
  await expect(createPlanFromContextIr(f.root, operation.operationId, { ...review, sourcePromptHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'IR_REVIEW_IDENTITY' });
  const plan = await createPlanFromContextIr(f.root, operation.operationId, review);
  const wf = plan.workflow!; if (wf.stage !== 'video') throw new Error('fixture');
  const reviewPath = join(f.root, wf.reviewPath), bytes = await readFile(reviewPath);
  await writeFile(reviewPath, '{}'); await expect(submit(f.root, plan.planId, 's1', true, { client: f.videoClient })).rejects.toMatchObject({ code: 'IR_REVIEW_CHANGED' });
  await writeFile(reviewPath, bytes);
  await writeFile(join(f.root, operation.result!.path), 'tampered'); await expect(validatePlan(f.root, plan)).rejects.toMatchObject({ code: 'IR_RESULT_CHANGED' });
  await writeFile(join(f.root, operation.result!.path), f.prompt);
  const tampered = { ...plan, workflow: { ...wf, preparePlanId: plan.planId } };
  await expect(validatePlan(f.root, tampered)).rejects.toMatchObject({ code: 'IR_PROVENANCE' });
  expect(f.counts.video).toBe(0);
});

it('blocks new paid requests on source or media changes but recovers already accepted tasks', async () => {
  const f = await irFixture(), operation = await enhanced(f), plan = await createPlanFromContextIr(f.root, operation.operationId, reviewFor(operation));
  const job = await submit(f.root, plan.planId, 's1', true, { client: f.videoClient });
  const story = await loadStory(f.root);
  await writeFile(join(f.root, story.assets[0]!.media!.path), png(512, 512));
  await expect(validatePlan(f.root, plan)).rejects.toMatchObject({ code: 'ASSET_CHANGED' });
  expect((await resume(f.root, job.operationId, { client: f.videoClient, fetcher: async () => new Response(mp4(7)) })).status).toBe('downloaded');
  expect((await resumeContextIr(f.root, operation.operationId, { client: f.irClient })).status).toBe('enhanced');
  expect(f.counts).toMatchObject({ ir: 1, video: 1 });
});

it('exposes offline CLI preparation, review and non-creating status/resume/download boundaries', async () => {
  const f = await irFixture(), deps = { client: f.videoClient, irClient: f.irClient };
  expect((await runCli(['context-ir', '--root', f.root, '--plan', f.plan.planId, '--segment', 's1'], deps)).exitCode).toBe(1);
  expect((await runCli(['generate', '--root', f.root, '--plan', f.plan.planId, '--confirm'], deps)).data).toMatchObject({ error: { code: 'IR_PREPARE_NOT_VIDEO' } });
  expect((await runCli(['context-ir', '--root', f.root, '--plan', f.plan.planId, '--segment', 's1', '--confirm', '--max-polls', '1.5'], deps)).exitCode).toBe(1);
  const created = await runCli(['context-ir', '--root', f.root, '--plan', f.plan.planId, '--segment', 's1', '--confirm', '--submit-only'], deps);
  expect(created.exitCode).toBe(0); const id = (created.data as { operationId: string }).operationId;
  const resumed = await runCli(['resume', '--root', f.root, '--operation', id], deps); expect(resumed.exitCode).toBe(0);
  expect((await runCli(['status', '--root', f.root, '--operation', id], deps)).exitCode).toBe(0);
  expect((await runCli(['status', '--root', f.root, '--operation', id, '--remote'], deps)).exitCode).toBe(0);
  expect((await runCli(['download', '--root', f.root, '--operation', id], deps)).data).toMatchObject({ error: { code: 'IR_NOT_VIDEO' } });
  const operation = await readIrOperation(f.root, id), reviewFile = join(f.root, 'review.json'); await writeFile(reviewFile, JSON.stringify(reviewFor(operation)));
  expect((await runCli(['plan', '--root', f.root, '--from-context-ir', id, '--review', reviewFile, '--episode', 'ep-1'], deps)).exitCode).toBe(1);
  expect((await runCli(['plan', '--root', f.root, '--from-context-ir', id, '--review', reviewFile], deps)).exitCode).toBe(0);
  expect(f.counts).toMatchObject({ ir: 1, video: 0 });
});
