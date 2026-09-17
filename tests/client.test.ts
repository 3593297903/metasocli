import { expect, it } from 'vitest';
import { API_BASE, MetasoClient, ProviderError, retryAfter } from '../src/metaso/client.js';
import type { H3Request } from '../src/metaso/h3.js';
const request: H3Request = { model: 'MiniMax-H3', content: [{ type: 'text', text: '  完整台词\n' }], resolution: '768P', duration: 6, ratio: '9:16', context_ir_enabled: false, aigc_watermark: false };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
it('uses only native Metaso endpoints and exact prompt content', async () => {
  const calls: any[] = [];
  const client = new MetasoClient('test-key', async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? json({ task_id: 'task-123' }) : json({ task: { id: 'task-123', status: 'succeeded', model: 'MiniMax-H3', content: { url: 'https://cdn.example.com/video.mp4?sig=secret' }, duration: 6, resolution: '768P' } });
  });
  const submitted = await client.create(request), result = await client.query(submitted.taskId);
  expect(calls[0].url).toBe(`${API_BASE}/video_generation`);
  expect(calls[1].url).toBe(`${API_BASE}/query/video_generation/task-123`);
  expect(calls[0].init.headers.Authorization).toBe('Bearer test-key');
  expect(JSON.parse(calls[0].init.body)).toEqual(request);
  expect(result.status).toBe('generated'); expect(JSON.stringify(result.evidence)).not.toContain('sig=secret');
});
it('accepts documented nested IDs but rejects ambiguity and malformed success receipts', async () => {
  expect((await new MetasoClient('key', async () => json({ task: { id: 123 } })).create(request)).taskId).toBe('123');
  for (const body of [{}, { task_id: '' }, { task_id: 'a', task: { id: 'b' } }]) {
    await expect(new MetasoClient('key', async () => json(body)).create(request)).rejects.toMatchObject({ code: 'CREATE_CONTRACT' });
  }
});
it('does not turn unknown states or inconsistent identities into queued/success', async () => {
  const client = new MetasoClient('key', async () => json({ task: { id: 'a', status: 'suspended_by_vendor' } }));
  expect((await client.query('a')).status).toBe('unknown');
  await expect(client.query('b')).rejects.toMatchObject({ code: 'QUERY_CONTRACT' });
  await expect(new MetasoClient('key', async () => json({ id: 'a', status: 'succeeded' })).query('a')).rejects.toMatchObject({ code: 'QUERY_CONTRACT' });
});
it('never retries creation itself; distinguishes rejection, ambiguity and read retry hints', async () => {
  let count = 0;
  const client = new MetasoClient('api-secret', async () => { count++; return json({ error: { message: 'api-secret https://cdn.example.com/?signed=private', authorization: 'Bearer api-secret' } }, 429, { 'Retry-After': '2' }); });
  try { await client.create(request); } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).options).toMatchObject({ rejected: true, retryable: false, retryAfterMs: 2000 });
    expect(JSON.stringify((e as ProviderError).options)).not.toContain('api-secret');
    expect(JSON.stringify((e as ProviderError).options)).not.toContain('signed=private');
  }
  expect(count).toBe(1);
  await expect(client.query('a')).rejects.toMatchObject({ options: { retryable: true, retryAfterMs: 2000 } });
  expect(retryAfter('Thu, 17 Sep 2026 10:00:02 GMT', Date.parse('2026-09-17T10:00:00Z'))).toBe(2000);
  await expect(new MetasoClient('key', async () => { throw new Error('Bearer key'); }).create(request)).rejects.toMatchObject({ options: { retryable: false } });
});
