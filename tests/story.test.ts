import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, cleanup } from './helpers.js';
import { importStory, loadStory, initializeStory } from '../src/core/project.js';
import { normalizeText, renderPrompt } from '../src/story/text.js';
import { withProjectLock } from '../src/storage/locking.js';
import { sha256Hex } from '../src/storage/canonical.js';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
afterEach(cleanup);
it('preserves raw source, normalization, dialogue, ordering and idempotent import', async () => {
  const f = await fixture('\uFEFF阿青：  全部保留。\r\n阿白：下一句！\r\n');
  const text = normalizeText(f.text);
  const story = await importStory(f.root, { ...f.draft, segments: [{ id: 's1', start: 0, end: text.length, duration: 6 }] });
  const episode = story.episodes[0]!;
  expect(episode.segments[0]!.prompt).toBe('阿青：  全部保留。\n阿白：下一句！\n');
  expect(await readFile(join(f.root, episode.source.rawPath), 'utf8')).toBe(f.text);
  const again = await importStory(f.root, { ...f.draft, segments: [{ id: 's1', start: 0, end: text.length, duration: 6 }] });
  expect(again.revision).toBe(story.revision);
  expect((await initializeStory(f.root, 'ignored')).projectId).toBe(story.projectId);
});
it('rejects missing/reordered spans and finished-prompt rewrites', async () => {
  const f = await fixture();
  await expect(importStory(f.root, { ...f.draft, segments: [{ ...f.draft.segments[0], start: 1 }] })).rejects.toMatchObject({ code: 'SOURCE_COVERAGE' });
  await expect(importStory(f.root, { ...f.draft, segments: [{ ...f.draft.segments[0], prompt: '缩短' }] })).rejects.toMatchObject({ code: 'PROMPT_CHANGED' });
  expect((await loadStory(f.root)).revision).toBe(0);
});
it('script direction additions must include original speaker and dialogue verbatim', async () => {
  const f = await fixture();
  await expect(importStory(f.root, { ...f.draft, kind: 'script', segments: [{ ...f.draft.segments[0], prompt: '林舟：略。' }] })).rejects.toMatchObject({ code: 'DIALOGUE_CHANGED' });
  const prompt = `缓慢推进。\n${f.text}镜头结束。`;
  const s = await importStory(f.root, { ...f.draft, kind: 'script', segments: [{ ...f.draft.segments[0], prompt }] });
  expect(s.episodes[0]!.segments[0]!.prompt).toBe(prompt);
});
it('rejects invalid UTF-8 and never truncates H3 prompts', async () => {
  expect(() => normalizeText(Uint8Array.from([0xc3, 0x28]))).toThrow();
  const f = await fixture('字'.repeat(7001)); const story = await importStory(f.root, f.draft);
  expect(() => renderPrompt(story.episodes[0]!.segments[0]!)).toThrow(expect.objectContaining({ code: 'PROMPT_LIMIT' }));
  expect(story.episodes[0]!.segments[0]!.prompt.length).toBe(7001);
});
it('renders only explicit local reference markers with stable reference order', async () => {
  const f = await fixture('陈言说：图1不是地图。{{ref:red}} 在 {{ref:blue}} 旁边。\n');
  const story = await importStory(f.root, { ...f.draft, recipes: ['red', 'blue'].map(assetId => ({ assetId, kind: 'character', prompt: assetId })), segments: [{ ...f.draft.segments[0], references: [{ assetId: 'blue', role: 'reference_image' }, { assetId: 'red', role: 'reference_image' }] }] });
  const result = renderPrompt(story.episodes[0]!.segments[0]!);
  expect(result.text).toBe('陈言说：图1不是地图。参考图2 在 参考图1 旁边。\n');
  expect(result.hash).toBe(sha256Hex(result.text));
});
it('serializes live work and recovers only a provably dead same-host owner', async () => {
  const f = await fixture();
  await withProjectLock(f.root, async () => {
    await expect(withProjectLock(f.root, async () => 1)).rejects.toMatchObject({ code: 'LOCK_BUSY' });
  });
  await writeFile(join(f.root, '.metasocli/project.lock'), JSON.stringify({ pid: 2147483647, host: hostname(), token: randomUUID(), createdAt: new Date().toISOString() }));
  expect(await withProjectLock(f.root, async () => 42)).toBe(42);
  await writeFile(join(f.root, '.metasocli/project.lock'), '{}');
  await expect(withProjectLock(f.root, async () => 0)).rejects.toMatchObject({ code: 'LOCK_UNKNOWN' });
});
