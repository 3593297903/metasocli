import { vi } from 'vitest';
// Every network request in the suite must be explicitly injected. This cannot generate paid jobs.
vi.stubGlobal('fetch', async () => { throw new Error('Unexpected network request in offline tests'); });
