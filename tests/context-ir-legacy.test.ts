import { afterEach, expect, it } from 'vitest';
import { cp, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fixture, mp4 } from './helpers.js';
import { loadPlan, validatePlan } from '../src/core/planning.js';
import { resume } from '../src/jobs/resume.js';
import { sha256Hex } from '../src/storage/canonical.js';
afterEach(cleanup);

it('loads actual pre-IR ordinary/narration plan hashes and resumes their original video tasks', async () => {
  const source = fileURLToPath(new URL('./fixtures/pre-context-ir/', import.meta.url));
  const capture = JSON.parse(await readFile(join(source, 'capture.json'), 'utf8'));
  for (const saved of capture.records) {
    const f = await fixture(), root = join(f.root, 'legacy');
    await cp(join(source, saved.name), root, { recursive: true });
    await rename(join(root, 'state'), join(root, '.metasocli'));
    await rename(join(root, 'manifest.yaml'), join(root, 'metasocli.yaml'));
    const manifestFile = join(root, 'metasocli.yaml'), planFile = join(root, `.metasocli/plans/${saved.planId}.json`);
    const plan = await loadPlan(root, saved.planId), { built } = await validatePlan(root, plan);
    expect(plan.planHash).toBe(saved.planHash); expect(plan).not.toHaveProperty('workflow');
    expect(built[0]!.summary).toMatchObject({ inputHash: saved.inputHash, requestHash: saved.requestHash });
    let creates = 0;
    const result = await resume(root, saved.operationId, { client: {
      async create() { creates++; throw new Error('old task must not create'); },
      async query(taskId) { expect(taskId).toBe(saved.taskId); return { taskId, status: 'generated', rawStatus: 'succeeded', duration: 6, url: 'https://example.com/old.mp4', evidence: { sha256: sha256Hex('{}'), response: {} } }; },
    }, fetcher: async () => new Response(mp4(6)) });
    expect(result.status).toBe('downloaded'); expect(creates).toBe(0);
    expect(sha256Hex(await readFile(manifestFile))).toBe(saved.manifestFileHash);
    expect(sha256Hex(await readFile(planFile))).toBe(saved.planFileHash);
  }
});
