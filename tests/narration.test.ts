import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanup, fixture, png, mp4 } from './helpers.js';
import { wav } from './audio-fixtures.js';
import { importStory, loadStory } from '../src/core/project.js';
import { registerAsset, inspectAssets } from '../src/assets/registry.js';
import { createPlan, validatePlan } from '../src/core/planning.js';
import { validateRequest } from '../src/metaso/h3.js';
import { MetasoClient, type VideoClient } from '../src/metaso/client.js';
import { listJobs, persistence } from '../src/jobs/store.js';
import { submit } from '../src/jobs/submit.js';
import { resume } from '../src/jobs/resume.js';
import { runCli } from '../src/cli/main.js';
import { sha256Hex } from '../src/storage/canonical.js';
afterEach(cleanup);

const recipe = { assetId: 'narrator', kind: 'narration', prompt: '用户提供的统一画外旁白声线参考；不是对白、配乐或需要复述的台词。' };
const evidence = { sha256: sha256Hex('{}'), response: {} };
function select(prompt: string, quote: string) { const start = prompt.indexOf(quote); return { assetId: 'narrator', cues: [{ start, end: start + quote.length }] }; }
async function narrated() {
  const text = '镜头1：旁白：天亮了。镜头2：林舟说：“快走！”\n';
  const f = await fixture(text);
  const narration = select(text, '天亮了。');
  await importStory(f.root, { ...f.draft, recipes: [recipe], segments: [{ ...f.draft.segments[0], narration }] });
  const file = join(dirname(f.root), 'voice.wav'); await writeFile(file, wav());
  await registerAsset(f.root, 'narrator', { file });
  return { ...f, narration, file };
}

it('adds narration only to selected segments, retaining image order and exact original dialogue', async () => {
  const parts = ['旁白：天亮了。\n人物对白：快走！{{ref:b}} 在 {{ref:a}} 旁。\n', '人物对白：这段只说话，没有画外叙述。\n', '镜头：空街。声音：风声，无人说话。\n'];
  const f = await fixture(parts.join('')); let start = 0;
  const segments = parts.map((part, i) => { const s = { id: `s${i + 1}`, start, end: start + part.length, duration: 6, narration: i === 0 ? select(part, '天亮了。') : null, references: i === 0 ? [{ assetId: 'a', role: 'reference_image' }, { assetId: 'b', role: 'reference_image' }] : [] }; start += part.length; return s; });
  await importStory(f.root, { ...f.draft, recipes: [recipe, ...['a','b'].map(assetId => ({ assetId, kind: 'character', prompt: assetId }))], segments });
  const image = join(dirname(f.root), 'image.png'), audio = join(dirname(f.root), 'voice.wav');
  await writeFile(image, png()); await writeFile(audio, wav());
  for (const id of ['a','b']) await registerAsset(f.root, id, { file: image });
  await expect(createPlan(f.root, 'ep-1')).rejects.toMatchObject({ code: 'MISSING_ASSET' });
  expect((await runCli(['assets', 'register', '--root', f.root, '--id', 'narrator', '--file', audio])).exitCode).toBe(0);
  const plan = await createPlan(f.root, 'ep-1'), { story, built } = await validatePlan(f.root, plan);
  expect(story.episodes[0]!.segments.map(s => s.prompt)).toEqual(parts);
  expect(built[0]!.request.content.map(c => c.type)).toEqual(['text','image_url','image_url','audio_url']);
  expect(plan.segments[0]!.assets.map(a => a.assetId)).toEqual(['a','b','narrator']);
  expect(plan.segments[0]!.renderedPrompt).toContain('人物对白：快走！参考图2 在 参考图1 旁。');
  expect(plan.segments[0]!.narration).toEqual(select(parts[0]!, '天亮了。'));
  for (let i = 1; i < parts.length; i++) expect(built[i]!.request.content).toEqual([{ type: 'text', text: parts[i] }]);
  expect(await listJobs(f.root)).toHaveLength(0);
  expect(JSON.stringify(plan)).not.toContain('data:audio');
});

it.each([
  [{ start: 2, end: 2 }], [{ start: 0, end: 900 }], [{ start: 2, end: 5 }, { start: 1, end: 2 }], [{ start: 1, end: 3 }],
].map(cues => ({ cues })))('rejects invalid narration source ranges before writing a story', async ({ cues }) => {
  const f = await fixture('😀旁白：出发。');
  await expect(importStory(f.root, { ...f.draft, recipes: [recipe], segments: [{ ...f.draft.segments[0], narration: { assetId: 'narrator', cues } }] })).rejects.toMatchObject({ code: 'NARRATION_CUE' });
  expect((await loadStory(f.root)).revision).toBe(0);
});

it('rejects first-frame/audio combinations, role confusion and wrong provenance', async () => {
  const f = await fixture('旁白：天亮了。'); const narration = select(f.text, '天亮了。');
  await expect(importStory(f.root, { ...f.draft, recipes: [recipe, { assetId: 'frame', kind: 'first_frame', prompt: '首帧' }], segments: [{ ...f.draft.segments[0], narration, references: [{ assetId: 'frame', role: 'first_frame' }] }] })).rejects.toMatchObject({ code: 'H3_MODE' });
  await expect(importStory(f.root, { ...f.draft, recipes: [recipe], segments: [{ ...f.draft.segments[0], references: [{ assetId: 'narrator', role: 'reference_image' }] }] })).rejects.toMatchObject({ code: 'ASSET_ROLE' });
  await importStory(f.root, { ...f.draft, recipes: [recipe], segments: [{ ...f.draft.segments[0], narration }] });
  const file = join(dirname(f.root), 'not-audio.png'); await writeFile(file, png());
  await expect(registerAsset(f.root, 'narrator', { file })).rejects.toMatchObject({ code: 'AUDIO_INVALID' });
  await expect(registerAsset(f.root, 'narrator', { file, provenance: 'imagegen' })).rejects.toMatchObject({ code: 'ASSET_ROLE' });
  await writeFile(file, wav());
  const before = (await loadStory(f.root)).revision;
  await expect(registerAsset(f.root, 'narrator', { file, expectedSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'ASSET_CHANGED' });
  expect((await loadStory(f.root)).revision).toBe(before);
  expect((await runCli(['assets','register','--root',f.root,'--id','narrator','--file',file,'--expected-sha256',sha256Hex(wav())])).exitCode).toBe(0);
});

it('includes narration instructions in the length limit without truncating the source', async () => {
  const f = await fixture('旁白：' + '字'.repeat(6900));
  await importStory(f.root, { ...f.draft, recipes: [recipe], segments: [{ ...f.draft.segments[0], narration: { assetId: 'narrator', cues: [{ start: 3, end: 5 }] } }] });
  await expect(createPlan(f.root, 'ep-1')).rejects.toMatchObject({ code: 'PROMPT_LIMIT' });
  expect((await loadStory(f.root)).episodes[0]!.segments[0]!.prompt).toBe(f.text);
});

it('detects managed audio changes and restores copies without changing the source recording', async () => {
  const f = await narrated(), plan = await createPlan(f.root, 'ep-1');
  const before = (await loadStory(f.root)).assets[0]!.media!;
  await writeFile(join(f.root, before.path), wav(3, 1));
  await expect(validatePlan(f.root, plan)).rejects.toMatchObject({ code: 'ASSET_CHANGED' });
  expect((await inspectAssets(f.root))[0]!.status).toBe('changed');
  await registerAsset(f.root, 'narrator', { file: f.file });
  expect(await readFile(f.file)).toEqual(wav());
  await expect(validatePlan(f.root, plan)).rejects.toMatchObject({ code: 'PLAN_STALE' });
  await unlink(join(f.root, before.path));
  await registerAsset(f.root, 'narrator', { file: f.file });
  expect((await inspectAssets(f.root))[0]!.status).toBe('ready');
});

it('validates the audio request and transport through the native Metaso client without network', async () => {
  const f = await narrated(), plan = await createPlan(f.root, 'ep-1'); let creates = 0;
  const client = new MetasoClient('offline-test-key', async (url, init) => {
    if (init?.method === 'POST') {
      creates++; expect(url).toBe('https://metaso.cn/api/minimax/v2/video_generation');
      const body = validateRequest(JSON.parse(String(init.body)));
      const audio = body.content.find(c => c.type === 'audio_url')!;
      expect(audio.role).toBe('reference_audio'); expect(audio.audio_url.url).toBe(`data:audio/wav;base64,${wav().toString('base64')}`);
      return Response.json({ task_id: 'fake-narration' });
    }
    return Response.json({ task: { id: 'fake-narration', model: 'MiniMax-H3', status: 'succeeded', content: { url: 'https://example.com/video.mp4' }, duration: 6, resolution: '768P' } });
  });
  const deps = { client, fetcher: async () => new Response(mp4()) };
  const args = ['generate','--root',f.root,'--plan',plan.planId,'--confirm'];
  expect((await runCli(args, deps)).exitCode).toBe(0);
  expect((await runCli(args, deps)).exitCode).toBe(0); expect(creates).toBe(1);
});

it('preserves the original task after receipt and download failures even if reference audio changes', async () => {
  const f = await narrated(), plan = await createPlan(f.root, 'ep-1'); let creates = 0;
  const client: VideoClient = { async create() { creates++; return { taskId: 'narration-task', evidence }; }, async query(taskId) { return { taskId, status: 'generated', rawStatus: 'succeeded', duration: 6, url: 'https://example.com/out.mp4', evidence }; } };
  await expect(submit(f.root, plan.planId, 's1', true, { client, persistence: { ...persistence, async job(root, job) { if (job.status === 'queued') throw new Error('interrupted'); await persistence.job(root, job); } } })).rejects.toMatchObject({ code: 'RECEIPT_PERSISTENCE' });
  const job = await submit(f.root, plan.planId, 's1', true, { client });
  const failed = await resume(f.root, job.operationId, { client, fetcher: async () => { throw new Error('download interrupted'); } });
  expect(failed.lastError?.code).toBe('DOWNLOAD_FAILED');
  await writeFile(f.file, wav(3, 1)); await registerAsset(f.root, 'narrator', { file: f.file });
  expect((await resume(f.root, job.operationId, { client, fetcher: async () => new Response(mp4()) })).status).toBe('downloaded');
  expect(creates).toBe(1);
});

it('does not resubmit an unknown narrated creation', async () => {
  const f = await narrated(), plan = await createPlan(f.root, 'ep-1'); let creates = 0;
  const client: VideoClient = { async create() { creates++; throw new Error('lost create response'); }, async query() { throw new Error('unknown task'); } };
  const job = await submit(f.root, plan.planId, 's1', true, { client });
  expect(job.status).toBe('submit_unknown');
  expect((await submit(f.root, plan.planId, 's1', true, { client })).operationId).toBe(job.operationId); expect(creates).toBe(1);
});

it('rechecks mutable audio URLs before paid intent and keeps signed URLs out of plans', async () => {
  const f = await narrated();
  await registerAsset(f.root, 'narrator', { url: 'https://example.com/voice.wav?signature=secret' }, async () => new Response(wav()));
  const plan = await createPlan(f.root, 'ep-1'); let creates = 0;
  const client: VideoClient = { async create() { creates++; return { taskId: 'no', evidence }; }, async query() { throw new Error('no'); } };
  await expect(submit(f.root, plan.planId, 's1', true, { client, fetcher: async (_url, init) => { expect(init?.headers).toBeUndefined(); return new Response(wav(3, 1)); } })).rejects.toMatchObject({ code: 'REMOTE_ASSET_CHANGED' });
  expect(creates).toBe(0); expect(await listJobs(f.root)).toHaveLength(0);
  expect(JSON.stringify(plan)).not.toContain('signature=');
  const { built } = await validatePlan(f.root, plan); const request = built[0]!.request;
  expect(() => validateRequest({ ...request, content: [...request.content, { type: 'image_url', role: 'first_frame', image_url: { url: 'https://example.com/frame.png' } }] })).toThrow();
  expect(() => validateRequest({ ...request, content: [...request.content, request.content.at(-1)] })).toThrow();
});
