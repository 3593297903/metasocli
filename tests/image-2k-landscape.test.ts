import { afterEach, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanup, png } from './helpers.js';
import { imageFixture, profile } from './image-api-helpers.js';
import { importStory, loadStory } from '../src/core/project.js';
import { registerAsset } from '../src/assets/registry.js';
import { createImagePlan } from '../src/images/planning.js';
import { runImages } from '../src/images/run.js';
import { YicImageClient } from '../src/images/client.js';
import { sha256Hex } from '../src/storage/canonical.js';

afterEach(cleanup);

it('freezes and sends 16:9 2K edits with the exact original image, registers matching dimensions, and resumes without POST', async () => {
  const f = await imageFixture();
  const original = png(1920, 1088);
  const file = join(dirname(f.root), 'original-scene.png');
  await writeFile(file, original);
  await registerAsset(f.root, f.ids[0]!, { file });
  const story = await loadStory(f.root);
  const variant = 'scene-clean-2k';
  await importStory(f.root, {
    ...f.draft,
    recipes: [{ assetId: variant, kind: 'scene', prompt: '2K 2560×1440，保持原横板构图，仅优化场景画质。', dependencies: [f.ids[0]!] }],
    segments: story.episodes[0]!.segments.map(s => ({ id: s.id, start: s.start, end: s.end, duration: s.targetDurationSeconds ?? s.duration,
      references: [{ assetId: variant, role: 'reference_image' }] })),
  }, true);
  const plan = (await createImagePlan(f.root, { assets: [variant], profile: { ...profile, boardSize: '2560x1440' } })).plan;
  expect(plan.items.map(x => x.action)).toEqual(['reuse', 'generate']);
  expect(plan.items.at(-1)?.size).toBe('2560x1440');
  let posts = 0;
  const client = new YicImageClient('offline-test-token', async (_url, init) => {
    posts++;
    const form = init!.body as FormData;
    expect(form.get('size')).toBe('2560x1440');
    expect(form.get('n')).toBe('1');
    expect(form.getAll('image[]')).toHaveLength(0);
    const reference = form.get('image') as File;
    expect(sha256Hex(Buffer.from(await reference.arrayBuffer()))).toBe(sha256Hex(original));
    return new Response(JSON.stringify({ data: [{ b64_json: png(2560, 1440).toString('base64') }] }));
  });
  const first = await runImages(f.root, plan.planId, true, { client });
  expect(first.summary.registered).toBe(1);
  expect((await loadStory(f.root)).assets.find(x => x.recipe.assetId === variant)?.media).toMatchObject({ width: 2560, height: 1440 });
  await runImages(f.root, plan.planId, false, { client });
  expect(posts).toBe(1);
});


it('reuses exact registered originals without replacing or recovering a historical unknown request', async () => {
  const f = await imageFixture();
  const oldPlan = (await createImagePlan(f.root, { assets: f.ids, profile })).plan;
  const runtimeRoot = join(f.root, 'runtime');
  await runImages(f.root, oldPlan.planId, true, { runtimeRoot, client: { async create(): Promise<Response> { throw new Error('offline unknown'); } } });
  const file = join(dirname(f.root), 'original-native.png');
  await writeFile(file, png(1920, 1088));
  await registerAsset(f.root, f.ids[0]!, { file, provenance: 'user' });
  const next = (await createImagePlan(f.root, { assets: f.ids, profile: { ...profile, boardSize: '2560x1440' } })).plan;
  expect(next.items[0]).toMatchObject({ action: 'reuse', targetHash: sha256Hex(png(1920, 1088)) });
  expect(next.items[0]?.operationId).toBeUndefined();
  const jobs = JSON.parse(await (await import('node:fs/promises')).readFile(join(f.root, '.metasocli/image-jobs', (await (await import('node:fs/promises')).readdir(join(f.root, '.metasocli/image-jobs')))[0]!), 'utf8'));
  expect(jobs.status).toBe('submit_unknown');
});
