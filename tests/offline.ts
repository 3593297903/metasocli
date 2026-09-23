import { vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Every network request in the suite must be explicitly injected. This cannot generate paid jobs.
vi.stubGlobal('fetch', async () => { throw new Error('Unexpected network request in offline tests'); });
let runtime: string, previous: string | undefined;
beforeEach(async () => {
  previous = process.env.METASO_RUNTIME_DIR;
  runtime = await mkdtemp(join(tmpdir(), 'metasocli-capacity-test-'));
  process.env.METASO_RUNTIME_DIR = runtime;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.METASO_RUNTIME_DIR; else process.env.METASO_RUNTIME_DIR = previous;
  await rm(runtime, { recursive: true, force: true });
});
