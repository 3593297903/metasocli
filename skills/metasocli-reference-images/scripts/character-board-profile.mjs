// Run while authoring a new batch. Recovery reads the profile already frozen in its plan.
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { loadImageProfile } from '../../../dist/images/planning.js';
import { Id } from '../../../dist/contracts/story.js';
import { canonicalSha256 } from '../../../dist/storage/canonical.js';
import { readStable } from '../../../dist/storage/io.js';
import { safePath } from '../../../dist/storage/paths.js';
import { z } from 'zod';

const { values } = parseArgs({ options: {
  recipe: { type: 'string', multiple: true },
  asset: { type: 'string', multiple: true },
  profile: { type: 'string' },
  out: { type: 'string' },
} });
if (!values.recipe?.length || !values.out) {
  throw Error('Expected --recipe <new handoff> [--asset <portrait character ID> ...] [--profile <base>] --out <batch profile>');
}
const profile = await loadImageProfile(values.profile);
const handoff = z.object({ assets: z.array(z.object({ assetId: Id, kind: z.string(), status: z.string() })) });
const plannedCharacters = new Set();
for (const file of values.recipe) {
  const bytes = await readStable(await safePath(file), 4 * 1024 * 1024);
  const contents = bytes.toString('utf8').replace(/^\uFEFF/u, '');
  for (const asset of handoff.parse(JSON.parse(contents)).assets) {
    if (asset.kind === 'character' && asset.status === 'planned') plannedCharacters.add(asset.assetId);
  }
}
// An all-new portrait batch uses every planned character. Mixed batches name only newly authored portrait IDs.
for (const id of values.asset ?? plannedCharacters) {
  if (!plannedCharacters.has(id)) throw Error(`No planned character for portrait asset ${id}`);
  const explicit = Object.hasOwn(profile.sizes, id) ? profile.sizes[id] : undefined;
  if (explicit !== undefined && explicit !== '1536x2048') {
    throw Error(`Portrait character ${id} needs 1536x2048; its explicit size is ${explicit}`);
  }
  profile.sizes[id] = '1536x2048';
}
const output = await safePath(values.out);
try {
  await writeFile(output, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (canonicalSha256(await loadImageProfile(output)) !== canonicalSha256(profile)) {
    throw Error('Different batch profile already exists. Choose a new batch output path.');
  }
}
