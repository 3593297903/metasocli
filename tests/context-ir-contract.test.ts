import { afterEach, expect, it } from 'vitest';
import { MetasoClient, CONTEXT_IR_CREATE_URL, CONTEXT_IR_QUERY_BASE, API_BASE } from '../src/metaso/client.js';
import { buildIrRequest, validateIrRequest } from '../src/metaso/context-ir.js';
import { validatePlan, createPlan } from '../src/core/planning.js';
import { importStory } from '../src/core/project.js';
import { irFixture } from './context-ir-fixtures.js';
import { cleanup } from './helpers.js';
afterEach(cleanup);

it('uses a narrow independent IR route/body and requires text task identity in its query', async () => {
  const f = await irFixture(true), { built } = await validatePlan(f.root, f.plan), request = buildIrRequest(built[0]!.request);
  const seen: string[] = [];
  const client = new MetasoClient('offline-secret-key', async (url, options) => {
    seen.push(String(url));
    if (options?.method === 'POST') {
      expect(url).toBe(CONTEXT_IR_CREATE_URL); expect(options.redirect).toBe('error');
      const body = JSON.parse(String(options.body)); expect(Object.keys(body).sort()).toEqual(['content', 'duration', 'model', 'ratio']);
      expect(body.content.map((c: { type: string }) => c.type)).toEqual(['text', 'image_url', 'image_url', 'audio_url']);
      return Response.json({ task_id: 'ir-contract' });
    }
    expect(url).toBe(`${CONTEXT_IR_QUERY_BASE}/ir-contract`);
    return Response.json({ task: { id: 'ir-contract', model: 'MiniMax-H3', task_type: 'h3_context_ir', modality: 'text', status: 'succeeded', content: { prompt: f.prompt } } });
  });
  expect((await client.createContextIr(request)).taskId).toBe('ir-contract');
  expect((await client.queryContextIr('ir-contract')).prompt).toBe(f.prompt); expect(seen).toHaveLength(2);
  expect(() => validateIrRequest({ ...request, resolution: '768P' })).toThrow();
  expect(() => validateIrRequest({ ...request, context_ir_enabled: true })).toThrow();
});

it.each([
  { task_type: 'generation', content: { url: 'https://example.com/video.mp4' } },
  { model: 'wrong-model' }, { id: 'other' }, { content: { prompt: '   ' } }, { task_type: undefined },
  { content: { prompt: 'text', url: 'https://example.com/video.mp4' } },
])('does not accept video or malformed results as IR: %j', async patch => {
  const client = new MetasoClient('offline-key', async () => Response.json({ task: { id: 'task', model: 'MiniMax-H3', task_type: 'h3_context_ir', status: 'succeeded', content: { prompt: 'valid' }, ...patch } }));
  await expect(client.queryContextIr('task')).rejects.toMatchObject({ code: 'IR_QUERY_CONTRACT' });
});

it('does not let an IR prompt masquerade as a video, including mixed result content', async () => {
  for (const extra of [{ task_type: 'h3_context_ir' }, { content: { prompt: 'text', url: 'https://example.com/x.mp4' } }]) {
    const client = new MetasoClient('offline-key', async url => {
      expect(url).toBe(`${API_BASE}/query/video_generation/task`);
      return Response.json({ task: { id: 'task', model: 'MiniMax-H3', task_type: 'generation', status: 'succeeded', content: { url: 'https://example.com/x.mp4' }, ...extra } });
    });
    await expect(client.query('task')).rejects.toMatchObject({ code: 'QUERY_CONTRACT' });
  }
});

it('retains unknown states and redacts evidence without route fallback or creation retry', async () => {
  let calls = 0;
  const client = new MetasoClient('offline-key', async () => { calls++; return Response.json({ task: { id: 'task', model: 'MiniMax-H3', task_type: 'h3_context_ir', status: 'new-provider-state', content: null }, token: 'offline-key', url: 'https://example.com/?signed=secret' }); });
  const result = await client.queryContextIr('task');
  expect(result.status).toBe('unknown'); expect(calls).toBe(1); expect(JSON.stringify(result.evidence)).not.toContain('offline-key'); expect(JSON.stringify(result.evidence)).not.toContain('signed=');
});

it('rejects an inline IR conflict without changing the story or old ordinary planning', async () => {
  const f = await irFixture();
  await importStory(f.root, { ...f.draft, segments: f.draft.segments.map(s => ({ ...s, parameters: { contextIr: true } })) }, true);
  await expect(createPlan(f.root, 'ep-1', 'h3-context-ir')).rejects.toMatchObject({ code: 'IR_MODE_CONFLICT' });
  expect((await createPlan(f.root, 'ep-1')).segments[0]!.contextIr).toBe(true);
});

it.each([
  { task_id: 'ir', task_type: 'generation' },
  { task_id: 'ir', model: 'other' },
  { task_id: 'ir', task: { id: 'different' } },
])('preserves ambiguity on incompatible IR create receipts without retry: %j', async body => {
  const f = await irFixture(), { built } = await validatePlan(f.root, f.plan); let calls = 0;
  const client = new MetasoClient('offline-key', async () => { calls++; return Response.json(body); });
  await expect(client.createContextIr(buildIrRequest(built[0]!.request))).rejects.toMatchObject({ code: 'CREATE_CONTRACT' });
  expect(calls).toBe(1);
});
