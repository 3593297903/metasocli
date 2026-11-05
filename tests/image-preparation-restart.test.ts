import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup } from './helpers.js';
import { workflowFixture } from './image-workflow-helpers.js';
import { prepareImages } from '../src/images/preparation.js';
import { collectImages } from '../src/images/reporting.js';
import { runImages } from '../src/images/run.js';
import { listImageJobs, readImagePlan } from '../src/images/store.js';
import { imageResponse } from './image-api-helpers.js';

afterEach(cleanup);

it('prepares an explicit successor and collects its results while preserving the previous unknown request', async () => {
  const f = await workflowFixture(1, 1);
  const first = await prepareImages(f.root, { batch: f.batchPath });
  const deps = { runtimeRoot: join(f.root, 'runtime'), client: { async create(): Promise<Response> { throw new Error('offline unknown'); } } };
  await runImages(f.root, first.planId!, true, deps);
  const oldInput = await readFile(join(f.root, first.recordPath, 'input.json'));
  await writeFile(f.batchPath, JSON.stringify({ ...f.batch, restartOf: first.planId }));
  const second = await prepareImages(f.root, { batch: f.batchPath });
  expect(second.preparationId).not.toBe(first.preparationId);
  expect((await readImagePlan(f.root, second.planId!)).restartOf).toBe(first.planId);
  expect((await prepareImages(f.root, { batch: f.batchPath })).planId).toBe(second.planId);
  await expect(runImages(f.root, second.planId!, true, deps)).rejects.toMatchObject({ code: 'IMAGE_UNKNOWN_ACCEPTANCE_REQUIRED' });
  let posts = 0;
  await runImages(f.root, second.planId!, true, { runtimeRoot: deps.runtimeRoot, client: { async create() { posts++; return imageResponse(); } } }, undefined, true);
  expect(posts).toBe(1);
  expect((await collectImages(f.root, { preparation: second.preparationId })).complete).toBe(true);
  expect((await listImageJobs(f.root)).filter(j => j.status === 'submit_unknown')).toHaveLength(1);
  expect(await readFile(join(f.root, first.recordPath, 'input.json'))).toEqual(oldInput);
}, 60000);
