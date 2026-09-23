import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fixture } from './helpers.js';
import { importStory } from '../src/core/project.js';
import { createBatchPlan } from '../src/jobs/batch-store.js';
import { sha256Hex } from '../src/storage/canonical.js';
export const evidence = { sha256: sha256Hex('{}'), response: {} };
export async function batchFixture(counts = [6,5,5]) {
  const f = await fixture(), episodeIds = ['ep-z','ep-a','ep-m'].slice(0, counts.length);
  for (const [e, count] of counts.entries()) {
    const lines = Array.from({ length: count }, (_, s) => '第' + (e + 1) + '集第' + (s + 1) + '段。完整原文。\n');
    const source = join(dirname(f.root), 'source-' + e + '.txt'); await writeFile(source, lines.join(''));
    let start = 0;
    const segments = lines.map((line, s) => { const result = { id: 's' + (s + 1), start, end: start + line.length, duration: 6.666 }; start += line.length; return result; });
    await importStory(f.root, { episodeId: episodeIds[e], kind: 'video-prompts', source, segments });
  }
  const batch = await createBatchPlan(f.root, { episodes: episodeIds, concurrency: 4 });
  return { ...f, batch, episodeIds };
}
