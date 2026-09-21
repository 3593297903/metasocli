import { afterEach, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanup, fixture, mp4 } from './helpers.js';
import { wav } from './audio-fixtures.js';
import { normalizeTargetDurationSeconds } from '../src/story/duration.js';
import { importStory, loadStory } from '../src/core/project.js';
import { createPlan, loadPlan, validatePlan } from '../src/core/planning.js';
import { validateRequest } from '../src/metaso/h3.js';
import { registerAsset } from '../src/assets/registry.js';
import { PlanSegment } from '../src/contracts/plan.js';
import { runCli } from '../src/cli/main.js';
import { submit } from '../src/jobs/submit.js';
import { resume } from '../src/jobs/resume.js';
import { persistence } from '../src/jobs/store.js';
import { sha256Hex } from '../src/storage/canonical.js';
import type { VideoClient } from '../src/metaso/client.js';

afterEach(cleanup);

it.each([
  [12.378, { duration: 13, targetDurationSeconds: 12.378 }],
  [6.666, { duration: 7, targetDurationSeconds: 6.666 }],
  [6.963, { duration: 7, targetDurationSeconds: 6.963 }],
  [3.1, { duration: 4, targetDurationSeconds: 3.1 }],
  [12, { duration: 12 }],
])('uses ceiling duration adaptation for target %s', (target, expected) => {
  expect(normalizeTargetDurationSeconds(target)).toEqual(expected);
});

it.each([3, 0, -1, 15.001, Number.NaN, Number.POSITIVE_INFINITY])('rejects unusable target %s', target => {
  expect(() => normalizeTargetDurationSeconds(target)).toThrow(expect.objectContaining({ code: 'DURATION_TARGET' }));
});

it('identifies the invalid segment instead of treating a bad target as an ordinary timing conflict', async () => {
  const f = await fixture();
  await expect(importStory(f.root, { ...f.draft, segments: [{ ...f.draft.segments[0], duration: 3 }] }))
    .rejects.toMatchObject({ code: 'DURATION_TARGET', message: expect.stringContaining('Segment s1 duration') });
});

it('shares decimal adaptation across script and finished-prompt imports while preserving source and request identity', async () => {
  const cases = [
    { kind: 'script' as const, target: 12.378, duration: 13 },
    { kind: 'video-prompts' as const, target: 6.666, duration: 7 },
  ];
  for (const entry of cases) {
    const f = await fixture();
    const first = await importStory(f.root, { ...f.draft, kind: entry.kind, segments: [{ ...f.draft.segments[0], duration: entry.target }] });
    const segment = first.episodes[0]!.segments[0]!;
    expect(segment).toMatchObject({ duration: entry.duration, targetDurationSeconds: entry.target, prompt: f.text });
    const plan = await createPlan(f.root, 'ep-1');
    expect(plan.segments[0]).toMatchObject({ duration: entry.duration, targetDurationSeconds: entry.target });
    const { built } = await validatePlan(f.root, plan);
    expect(built[0]!.request).toMatchObject({ duration: entry.duration });
    expect(built[0]!.request).not.toHaveProperty('targetDurationSeconds');
    expect(() => validateRequest({ ...built[0]!.request, targetDurationSeconds: entry.target })).toThrow();
    expect(() => PlanSegment.parse({ ...plan.segments[0], duration: entry.duration - 1, targetDurationSeconds: entry.target })).toThrow();
  }
});

it('keeps narration cues, audio precision, source text and asset ordering when adapting a decimal target', async () => {
  const text = '旁白：天亮了。人物对白：快走！\n';
  const f = await fixture(text);
  const quote = '天亮了。', start = text.indexOf(quote);
  const narration = { assetId: 'narrator', cues: [{ start, end: start + quote.length }] };
  await importStory(f.root, {
    ...f.draft,
    recipes: [{ assetId: 'narrator', kind: 'narration', prompt: '用户旁白声线参考' }],
    segments: [{ ...f.draft.segments[0], duration: 6.963, narration }],
  });
  const audio = join(dirname(f.root), 'voice.wav');
  await writeFile(audio, wav(3));
  const asset = await registerAsset(f.root, 'narrator', { file: audio });
  const story = await loadStory(f.root);
  const plan = await createPlan(f.root, 'ep-1');
  const { built } = await validatePlan(f.root, plan);
  const segment = story.episodes[0]!.segments[0]!;
  expect(segment).toMatchObject({ prompt: text, duration: 7, targetDurationSeconds: 6.963, narration });
  expect(segment.promptHash).toBe(sha256Hex(text));
  expect(story.episodes[0]!.source.textHash).toBe(sha256Hex(text));
  expect(asset.media).toMatchObject({ duration: 3 });
  expect(plan.segments[0]!.assets.map(item => item.assetId)).toEqual(['narrator']);
  expect(plan.segments[0]!.narration).toEqual(narration);
  expect(built[0]!.request).toMatchObject({ duration: 7 });
  expect(built[0]!.request).not.toHaveProperty('targetDurationSeconds');
});

it('keeps integer manifests and plans field-for-field compatible, and only replaces changed decimal imports explicitly', async () => {
  const f = await fixture();
  const integer = await importStory(f.root, f.draft);
  expect(integer.episodes[0]!.segments[0]).not.toHaveProperty('targetDurationSeconds');
  const legacyCompatiblePlan = await createPlan(f.root, 'ep-1');
  expect(legacyCompatiblePlan.segments[0]).not.toHaveProperty('targetDurationSeconds');
  expect((await loadPlan(f.root, legacyCompatiblePlan.planId)).planHash).toBe(legacyCompatiblePlan.planHash);

  const decimal = { ...f.draft, segments: [{ ...f.draft.segments[0], duration: 6.666 }] };
  await expect(importStory(f.root, decimal)).rejects.toMatchObject({ code: 'EPISODE_EXISTS' });
  const first = await importStory(f.root, decimal, true);
  const firstDecimalPlan = await createPlan(f.root, 'ep-1');
  const again = await importStory(f.root, decimal);
  expect(again.revision).toBe(first.revision);
  await expect(importStory(f.root, { ...f.draft, segments: [{ ...f.draft.segments[0], duration: 6.963 }] })).rejects.toMatchObject({ code: 'EPISODE_EXISTS' });
  const changed = await importStory(f.root, { ...f.draft, segments: [{ ...f.draft.segments[0], duration: 6.963 }] }, true);
  const decimalPlan = await createPlan(f.root, 'ep-1');
  expect(decimalPlan.segments[0]).toMatchObject({ duration: 7, targetDurationSeconds: 6.963 });
  expect(decimalPlan.segments[0]!.requestHash).toBe(firstDecimalPlan.segments[0]!.requestHash);
  expect(decimalPlan.segments[0]!.inputHash).toBe(firstDecimalPlan.segments[0]!.inputHash);
  expect(decimalPlan.planHash).not.toBe(firstDecimalPlan.planHash);
  expect(changed.revision).toBeGreaterThan(first.revision);
  await expect(validatePlan(f.root, legacyCompatiblePlan)).rejects.toMatchObject({ code: 'PLAN_STALE' });
});

it('accepts strict decimal CLI targets without loosening integer poll options', async () => {
  const f = await fixture();
  expect((await runCli(['import', '--root', f.root, '--kind', 'video-prompts', '--file', f.source, '--episode', 'ep-1', '--duration', '12.378'])).exitCode).toBe(0);
  const story = await loadStory(f.root);
  expect(story.episodes[0]!.segments[0]).toMatchObject({ duration: 13, targetDurationSeconds: 12.378 });
  for (const bad of ['0', '3', '15.001', 'Infinity', '0x6', '6seconds', '6.6.6']) {
    const result = await runCli(['import', '--root', f.root, '--kind', 'video-prompts', '--file', f.source, '--episode', 'bad', '--duration', bad]);
    expect(result.exitCode).toBe(1);
  }
  expect((await runCli(['resume', '--root', f.root, '--operation', '00000000-0000-4000-8000-000000000000', '--max-polls', '1.5'])).exitCode).toBe(1);
});

it('resumes one decimal task after receipt and download interruptions and never repeats an unknown create', async () => {
  const f = await fixture();
  await importStory(f.root, { ...f.draft, segments: [{ ...f.draft.segments[0], duration: 6.963 }] });
  const plan = await createPlan(f.root, 'ep-1');
  const evidence = { sha256: sha256Hex('{}'), response: {} };
  let creates = 0;
  const client: VideoClient = {
    async create() { creates++; return { taskId: 'decimal-task', evidence }; },
    async query(taskId) { return { taskId, status: 'generated', rawStatus: 'succeeded', duration: 7, resolution: '768P', url: 'https://example.com/decimal.mp4', evidence }; },
  };
  await expect(submit(f.root, plan.planId, 's1', true, { client, persistence: { ...persistence, async job(root, job) { if (job.status === 'queued') throw new Error('interrupted checkpoint'); await persistence.job(root, job); } } })).rejects.toMatchObject({ code: 'RECEIPT_PERSISTENCE' });
  const job = await submit(f.root, plan.planId, 's1', true, { client });
  const interrupted = await resume(f.root, job.operationId, { client, fetcher: async () => { throw new Error('download interrupted'); } });
  expect(interrupted.lastError?.code).toBe('DOWNLOAD_FAILED');
  expect((await resume(f.root, job.operationId, { client, fetcher: async () => new Response(mp4(7)) })).status).toBe('downloaded');
  expect(creates).toBe(1);

  const f2 = await fixture();
  await importStory(f2.root, { ...f2.draft, segments: [{ ...f2.draft.segments[0], duration: 6.666 }] });
  const unknownPlan = await createPlan(f2.root, 'ep-1');
  let unknownCreates = 0;
  const unknown: VideoClient = { async create() { unknownCreates++; throw new Error('connection ended after create'); }, async query() { throw new Error('unreachable'); } };
  expect((await submit(f2.root, unknownPlan.planId, 's1', true, { client: unknown })).status).toBe('submit_unknown');
  expect((await submit(f2.root, unknownPlan.planId, 's1', true, { client: unknown })).status).toBe('submit_unknown');
  expect(unknownCreates).toBe(1);
});
