import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanup, mp4, png } from './helpers.js';
import { irFixture, reviewFor } from './context-ir-fixtures.js';
import { importStory } from '../src/core/project.js';
import { createPlan, createPlanFromContextIr, loadPlan, validatePlan } from '../src/core/planning.js';
import { submitContextIr, resumeContextIr } from '../src/jobs/context-ir.js';
import { irPersistence, readIrOperation } from '../src/jobs/context-ir-store.js';
import { registerAsset } from '../src/assets/registry.js';
import { submit } from '../src/jobs/submit.js';
import { resume } from '../src/jobs/resume.js';
import { writeJson } from '../src/storage/io.js';
import type { GenerationPlan } from '../src/contracts/plan.js';
import type { ContextIrOperation } from '../src/contracts/context-ir.js';

afterEach(cleanup);

async function withSibling() {
  const f = await irFixture(true), sibling = '另一个镜头：路人静立。\n';
  const draft = { ...f.draft, segments: [...f.draft.segments,
    { id: 's2', start: f.text.length, end: f.text.length + sibling.length, duration: 6, references: [], narration: null }] };
  await writeFile(f.source, f.text + sibling);
  await importStory(f.root, draft, true);
  return { ...f, sibling, draft, plan: await createPlan(f.root, 'ep-1', 'h3-context-ir') };
}
async function finishIr(f: Awaited<ReturnType<typeof withSibling>>) {
  const queued = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
  return resumeContextIr(f.root, queued.operationId, { client: f.irClient });
}
async function changeOtherContent(f: Awaited<ReturnType<typeof withSibling>>, kind: 'sibling' | 'episode') {
  if (kind === 'sibling') {
    const sibling = '另一个镜头：路人开始向门口走去。\n';
    await writeFile(f.source, f.text + sibling);
    await importStory(f.root, { ...f.draft, segments: f.draft.segments.map(s => s.id === 's2' ? { ...s, end: f.text.length + sibling.length } : s) }, true);
  } else {
    const source = join(dirname(f.root), 'second-episode.txt'), text = '另一集的独立镜头。\n';
    await writeFile(source, text);
    await importStory(f.root, { source, kind: 'video-prompts', episodeId: 'ep-2', segments: [{ id: 's1', start: 0, end: text.length, duration: 6 }] });
  }
  return createPlan(f.root, 'ep-1', 'h3-context-ir');
}
const reviewAt = (operation: ContextIrOperation, plan: GenerationPlan) => ({
  ...reviewFor(operation), preparePlanId: plan.planId, preparePlanHash: plan.planHash,
});

it.each(['sibling', 'episode'] as const)('reuses successful IR after changing another %s without paying for IR again', async kind => {
  const f = await withSibling(), operation = await finishIr(f);
  const originFile = join(f.root, `.metasocli/plans/${f.plan.planId}.json`);
  const receiptFile = join(f.root, `.metasocli/context-ir/receipts/${operation.operationId}.json`);
  const [originBytes, receiptBytes] = await Promise.all([readFile(originFile), readFile(receiptFile)]);
  const current = await changeOtherContent(f, kind);
  expect(current.revision).toBeGreaterThan(f.plan.revision);
  expect(current.segments[0]!.inputHash).toBe(f.plan.segments[0]!.inputHash);
  expect((await submitContextIr(f.root, current.planId, 's1', true, { client: f.irClient })).operationId).toBe(operation.operationId);
  const review = reviewAt(operation, current), derived = await createPlanFromContextIr(f.root, operation.operationId, review);
  const [{ built: prepared }, { built }] = await Promise.all([validatePlan(f.root, current), validatePlan(f.root, derived)]);
  expect(built[0]!.request.content.slice(1)).toEqual(prepared[0]!.request.content.slice(1));
  expect(derived.workflow).toMatchObject({ preparePlanId: current.planId, irOperationId: operation.operationId });
  expect(derived.revision).toBe(current.revision);
  expect((await createPlanFromContextIr(f.root, operation.operationId, review)).planHash).toBe(derived.planHash);
  const video = await submit(f.root, derived.planId, 's1', true, { client: f.videoClient });
  expect((await resume(f.root, video.operationId, { client: f.videoClient, fetcher: async () => new Response(mp4(7)) })).status).toBe('downloaded');

  // Even another equivalent plan may bind the saved result; video request deduplication still applies.
  const equivalent = await createPlan(f.root, 'ep-1', 'h3-context-ir');
  const another = await createPlanFromContextIr(f.root, operation.operationId, reviewAt(operation, equivalent));
  expect((await submit(f.root, another.planId, 's1', true, { client: f.videoClient })).operationId).toBe(video.operationId);
  expect(f.counts).toMatchObject({ ir: 1, queries: 1, video: 1 });
  const saved = await readIrOperation(f.root, operation.operationId);
  expect(saved).toMatchObject({ planId: operation.planId, planHash: operation.planHash, revision: operation.revision, taskId: operation.taskId, result: operation.result });
  expect(saved.derived).toBeUndefined(); expect(saved.planBindings).toHaveLength(2);
  expect(await readFile(originFile)).toEqual(originBytes); expect(await readFile(receiptFile)).toEqual(receiptBytes);
});

it('preserves prior derived plans and resumes their original video after binding a newer preparation', async () => {
  const f = await withSibling(), operation = await finishIr(f);
  const original = await createPlanFromContextIr(f.root, operation.operationId, reviewFor(operation));
  const originalFile = join(f.root, `.metasocli/plans/${original.planId}.json`), originalBytes = await readFile(originalFile);
  const savedBefore = await readIrOperation(f.root, operation.operationId);
  expect(savedBefore).not.toHaveProperty('planBindings');
  const video = await submit(f.root, original.planId, 's1', true, { client: f.videoClient });
  const current = await changeOtherContent(f, 'episode');
  const newer = await createPlanFromContextIr(f.root, operation.operationId, reviewAt(operation, current));
  await validatePlan(f.root, newer);
  expect(newer.planId).not.toBe(original.planId);
  const saved = await readIrOperation(f.root, operation.operationId);
  expect(saved.review).toEqual(savedBefore.review); expect(saved.derived).toEqual(savedBefore.derived);
  expect(saved.planBindings).toHaveLength(1); expect(await readFile(originalFile)).toEqual(originalBytes);
  expect((await loadPlan(f.root, original.planId)).planHash).toBe(original.planHash);
  expect((await submit(f.root, newer.planId, 's1', true, { client: f.videoClient })).operationId).toBe(video.operationId);
  expect((await resume(f.root, video.operationId, { client: f.videoClient, fetcher: async () => new Response(mp4(7)) })).status).toBe('downloaded');
  expect(f.counts).toMatchObject({ ir: 1, video: 1 });
});

it.each(['prompt', 'duration', 'reference-order', 'image'] as const)('refuses reuse when the selected segment changes its %s', async change => {
  const f = await withSibling(), operation = await finishIr(f);
  if (change === 'image') {
    const file = join(dirname(f.root), 'changed.png'); await writeFile(file, png(512, 512));
    await registerAsset(f.root, 'a', { file });
  } else {
    if (change === 'prompt') await writeFile(f.source, f.text.replace('快走', '稍等') + f.sibling);
    const segments = f.draft.segments.map(s => s.id !== 's1' ? s : {
      ...s, ...(change === 'duration' ? { duration: 9 } : {}),
      ...(change === 'reference-order' ? { references: [...s.references].reverse() } : {}),
    });
    await importStory(f.root, { ...f.draft, segments }, true);
  }
  const current = await createPlan(f.root, 'ep-1', 'h3-context-ir');
  await expect(createPlanFromContextIr(f.root, operation.operationId, reviewAt(operation, current))).rejects.toMatchObject({ code: 'IR_PROVENANCE' });
  expect((await readIrOperation(f.root, operation.operationId)).planBindings).toBeUndefined();
  expect(f.counts).toMatchObject({ ir: 1, video: 0 });
});

it('does not reuse an IR from another episode even when all segment inputs match', async () => {
  const f = await withSibling(), operation = await finishIr(f);
  await importStory(f.root, { ...f.draft, episodeId: 'ep-other' });
  const other = await createPlan(f.root, 'ep-other', 'h3-context-ir');
  expect(other.segments[0]!.inputHash).toBe(f.plan.segments[0]!.inputHash);
  await expect(createPlanFromContextIr(f.root, operation.operationId, reviewAt(operation, other))).rejects.toMatchObject({ code: 'IR_PROVENANCE' });
  expect(f.counts).toMatchObject({ ir: 1, video: 0 });
});

it.each(['reserved', 'plan-written', 'linked'])('recovers newer preparation binding after %s interruption without overwriting the original', async stage => {
  const f = await withSibling(), operation = await finishIr(f);
  const oldPlan = await createPlanFromContextIr(f.root, operation.operationId, reviewFor(operation));
  const oldBinding = (await readIrOperation(f.root, operation.operationId)).derived;
  const current = await changeOtherContent(f, 'sibling'), review = reviewAt(operation, current);
  await expect(createPlanFromContextIr(f.root, operation.operationId, review, {
    async operation(root, value) {
      const binding = value.planBindings?.find(b => b.preparePlanId === current.planId);
      if (stage === 'linked' && binding?.derived?.planHash) throw new Error('new binding checkpoint');
      await irPersistence.operation(root, value);
      if (stage === 'reserved' && binding?.derived && !binding.derived.planHash) throw new Error('new binding checkpoint');
    },
    async plan(root, plan) {
      await writeJson(join(root, `.metasocli/plans/${plan.planId}.json`), plan);
      if (stage === 'plan-written') throw new Error('new binding checkpoint');
    },
  })).rejects.toThrow('new binding checkpoint');
  const candidate = (await readIrOperation(f.root, operation.operationId)).planBindings![0]!.derived!;
  const recovered = await createPlanFromContextIr(f.root, operation.operationId, review);
  expect(recovered.planId).toBe(candidate.planId); expect(recovered.createdAt).toBe(candidate.createdAt);
  await validatePlan(f.root, recovered);
  expect((await createPlanFromContextIr(f.root, operation.operationId, review)).planHash).toBe(recovered.planHash);
  const saved = await readIrOperation(f.root, operation.operationId);
  expect(saved.derived).toEqual(oldBinding); expect(saved.planBindings).toHaveLength(1);
  expect((await loadPlan(f.root, oldPlan.planId)).planHash).toBe(oldPlan.planHash);
  expect(f.counts).toMatchObject({ ir: 1, video: 0 });
});

it('serializes concurrent new bindings and rejects their tampered identity', async () => {
  const f = await withSibling(), operation = await finishIr(f), current = await changeOtherContent(f, 'episode');
  const review = reviewAt(operation, current);
  const results = await Promise.allSettled([1, 2].map(() => createPlanFromContextIr(f.root, operation.operationId, review)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const plan = await createPlanFromContextIr(f.root, operation.operationId, review);
  const saved = await readIrOperation(f.root, operation.operationId);
  expect(saved.planBindings).toHaveLength(1);
  const corrupt = structuredClone(saved); corrupt.planBindings![0]!.preparePlanHash = '0'.repeat(64);
  await irPersistence.operation(f.root, corrupt);
  await expect(validatePlan(f.root, plan)).rejects.toMatchObject({ code: 'IR_PROVENANCE' });
  await irPersistence.operation(f.root, { ...saved, planBindings: [...saved.planBindings!, ...saved.planBindings!] });
  await expect(readIrOperation(f.root, operation.operationId)).rejects.toMatchObject({ code: 'IR_JOB_CONFLICT' });
  expect(f.counts).toMatchObject({ ir: 1, video: 0 });
});
