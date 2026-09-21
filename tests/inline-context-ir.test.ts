import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../src/cli/main.js';
import { createPlan, createPlanFromContextIr, validatePlan } from '../src/core/planning.js';
import { importStory, loadStory } from '../src/core/project.js';
import { type GenerationPlan } from '../src/contracts/plan.js';
import { API_BASE, MetasoClient } from '../src/metaso/client.js';
import { canonicalSha256 } from '../src/storage/canonical.js';
import { submitContextIr, resumeContextIr } from '../src/jobs/context-ir.js';
import { cleanup, fixture, mp4 } from './helpers.js';
import { irFixture, reviewFor } from './context-ir-fixtures.js';

afterEach(cleanup);
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

it.each(['script', 'video-prompts'])('sends true for every %s segment through the real HTTP serializer without a separate IR request', async kind => {
  const f = await fixture('林舟说：“走吧！”\n旁白：天亮了。\n');
  const boundary = f.text.indexOf('\n') + 1;
  await importStory(f.root, { ...f.draft, kind, segments: [
    { id: 's1', start: 0, end: boundary, duration: 6, parameters: { contextIr: false } },
    { id: 's2', start: boundary, end: f.text.length, duration: 7 },
  ] });
  const manifest = await readFile(join(f.root, 'metasocli.yaml'));
  const planned = await runCli(['plan', '--root', f.root, '--episode', 'ep-1']);
  expect(planned.exitCode).toBe(0);
  const plan = planned.data as GenerationPlan;
  expect(plan.workflow).toEqual({ type: 'h3-inline-ir', stage: 'inline-video' });
  expect(plan.segments.map(s => s.contextIr)).toEqual([true, true]);
  expect(await readFile(join(f.root, 'metasocli.yaml'))).toEqual(manifest);
  const sent: Record<string, any>[] = [];
  const client = new MetasoClient('offline-test-key', async (url, init) => {
    expect(url).toBe(`${API_BASE}/video_generation`);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)); sent.push(body);
    expect(body.context_ir_enabled).toBe(true);
    expect(canonicalSha256(body)).toBe(plan.segments[sent.length - 1]!.requestHash);
    // The provider need not echo the switch. Never synthesize it in the response.
    return json({ task_id: `inline-${kind}-${sent.length}` });
  });
  const args = ['generate', '--root', f.root, '--plan', plan.planId, '--submit-only'];
  expect((await runCli(args, { client })).exitCode).toBe(1);
  expect(sent).toHaveLength(0);
  const result = await runCli([...args, '--confirm'], { client });
  expect(result.exitCode).toBe(0);
  expect(sent).toHaveLength(2);
  expect(sent.map(r => r.content[0].text).join('')).toBe(f.text);
  expect((await runCli([...args, '--confirm'], { client })).exitCode).toBe(0);
  expect(sent).toHaveLength(2); // Repeating the command resumes the recorded identities.
});

it('keeps ordered image/audio bytes and narration cues while enabling inline IR, then resumes the original task', async () => {
  const f = await irFixture(true), original = await loadStory(f.root);
  const { built: before } = await validatePlan(f.root, f.plan);
  const plan = await createPlan(f.root, 'ep-1');
  const { built: after } = await validatePlan(f.root, plan);
  expect(after[0]!.request).toEqual({ ...before[0]!.request, context_ir_enabled: true });
  expect(after[0]!.summary.assets).toEqual(before[0]!.summary.assets);
  expect(after[0]!.summary.narration).toEqual(before[0]!.summary.narration);
  expect(after[0]!.summary.requestHash).not.toBe(before[0]!.summary.requestHash);
  const calls: string[] = [];
  const client = new MetasoClient('offline-test-key', async (url, init) => {
    calls.push(String(url));
    if (init?.method === 'POST') {
      expect(url).toBe(`${API_BASE}/video_generation`);
      const body = JSON.parse(String(init.body));
      expect(body).toEqual(after[0]!.request);
      expect(body.content.map((c: any) => c.role ?? c.type)).toEqual(['text', 'reference_image', 'reference_image', 'reference_audio']);
      return json({ task_id: 'inline-narration' });
    }
    expect(url).toBe(`${API_BASE}/query/video_generation/inline-narration`);
    return json({ task: { id: 'inline-narration', model: 'MiniMax-H3', status: 'succeeded', task_type: 'generation', modality: 'video',
      duration: 7, resolution: '768P', content: { url: 'https://example.com/inline.mp4' } } });
  });
  const dependencies = { client, fetcher: async () => new Response(mp4(7)) };
  const result = await runCli(['generate', '--root', f.root, '--plan', plan.planId, '--confirm', '--submit-only'], dependencies);
  expect(result.exitCode).toBe(0);
  const operationId = (result.data as any).jobs[0].operationId;
  const resumed = await runCli(['resume', '--root', f.root, '--operation', operationId], dependencies);
  expect(resumed).toMatchObject({ exitCode: 0, data: { status: 'downloaded', taskId: 'inline-narration' } });
  expect(calls).toEqual([`${API_BASE}/video_generation`, `${API_BASE}/query/video_generation/inline-narration`]);
  expect(f.counts.ir).toBe(0);
  expect(await loadStory(f.root)).toEqual(original);
});

it('rejects legacy false video plans before loading credentials or sending any request', async () => {
  const f = await irFixture();
  const { workflow, planHash, ...base } = f.plan;
  const legacy = { ...base, planHash: canonicalSha256(base) };
  await writeFile(join(f.root, `.metasocli/plans/${legacy.planId}.json`), JSON.stringify(legacy));
  const result = await runCli(['generate', '--root', f.root, '--plan', legacy.planId, '--confirm']);
  expect(result).toMatchObject({ exitCode: 1, data: { error: { code: 'INLINE_IR_REQUIRED' } } });
  expect(f.counts.video).toBe(0);
});

it('does not silently add inline IR to an already enhanced legacy derived plan', async () => {
  const f = await irFixture();
  let ir = await submitContextIr(f.root, f.plan.planId, 's1', true, { client: f.irClient });
  ir = await resumeContextIr(f.root, ir.operationId, { client: f.irClient });
  const legacy = await createPlanFromContextIr(f.root, ir.operationId, reviewFor(ir));
  const result = await runCli(['generate', '--root', f.root, '--plan', legacy.planId, '--confirm'], { client: f.videoClient });
  expect(result).toMatchObject({ exitCode: 1, data: { error: { code: 'INLINE_IR_REQUIRED' } } });
  expect(f.counts).toMatchObject({ ir: 1, video: 0 });
  const current = await createPlan(f.root, 'ep-1');
  expect(current.segments[0]!.contextIr).toBe(true);
  expect(current.segments[0]!.renderedPrompt).toBe(f.plan.segments[0]!.renderedPrompt);
  expect(current.segments[0]!.renderedPrompt).not.toBe(f.prompt);
});
