import { afterEach, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fixture, cleanup, mp4 } from './helpers.js';
import { runCli } from '../src/cli/main.js';
import { sha256Hex } from '../src/storage/canonical.js';
afterEach(cleanup);
it('drives both entries through the public offline CLI without an API key', async () => {
  for (const kind of ['script', 'video-prompts']) {
    const f = await fixture();
    const imported = await runCli(['import', '--root', f.root, '--kind', kind, '--file', f.source, '--episode', 'ep-1', '--duration', '6']);
    expect(imported.exitCode).toBe(0);
    const plan = await runCli(['plan', '--root', f.root, '--episode', 'ep-1']); expect(plan.exitCode).toBe(0);
    const status = await runCli(['status', '--root', f.root]); expect(status.exitCode).toBe(0);
    const doctor = await runCli(['doctor', '--root', f.root]); expect(doctor.exitCode).toBe(0);
    expect((doctor.data as any).nativeApiVerifiedLive).toBe(false);
  }
});
it('requires explicit roots and rejects unknown or conflicting options before side effects', async () => {
  expect((await runCli(['status'])).exitCode).toBe(1);
  expect((await runCli(['init', '--root', 'E:\\libcli'])).exitCode).toBe(1);
  expect((await runCli(['generate', '--root', '.', '--api-key', 'must-not-echo'])).data).not.toEqual(expect.stringContaining('must-not-echo'));
  const f = await fixture();
  expect((await runCli(['import', '--root', f.root, '--draft', 'a.json', '--file', f.source])).exitCode).toBe(1);
  expect((await runCli(['generate', '--root', f.root, '--plan', 'not-authorized'])).data).toMatchObject({ error: { code: 'GENERATION_NOT_AUTHORIZED' } });
  expect((await runCli(['init', '--root', join(dirname(f.root), 'other'), '--name', 'Independent'])).exitCode).toBe(0);
});
it('completes fake generation/download through the same CLI and repeats without creating', async () => {
  const f = await fixture();
  await runCli(['import', '--root', f.root, '--kind', 'video-prompts', '--file', f.source, '--episode', 'ep-1', '--duration', '6']);
  const plan = (await runCli(['plan', '--root', f.root, '--episode', 'ep-1'])).data as any;
  let creates = 0; const evidence = { sha256: sha256Hex('{}'), response: {} };
  const deps = { client: {
    async create() { creates++; return { taskId: 'fake-task', evidence }; },
    async query(taskId: string) { return { taskId, status: 'generated' as const, rawStatus: 'succeeded', url: 'https://example.com/video.mp4', duration: 6, resolution: '768P', evidence }; },
  }, fetcher: async () => new Response(mp4()) };
  const args = ['generate', '--root', f.root, '--plan', plan.planId, '--confirm'];
  expect((await runCli([...args, '--max-polls', '0'], deps)).exitCode).toBe(1); expect(creates).toBe(0);
  const first = await runCli(args, deps); expect(first.exitCode).toBe(0); expect((first.data as any).jobs[0].status).toBe('downloaded');
  expect((await runCli(args, deps)).exitCode).toBe(0); expect(creates).toBe(1);
});
