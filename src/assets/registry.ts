import { resolve } from 'node:path';
import { Id, parse } from '../contracts/story.js';
import { fail } from '../core/errors.js';
import { loadStory, saveStory } from '../core/project.js';
import { withProjectLock } from '../storage/locking.js';
import { atomicWrite, readStable } from '../storage/io.js';
import { projectPath } from '../storage/paths.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { inspectImage, MAX_IMAGE_BYTES } from './image.js';
import { fetchImage, publicHttps, type Fetch } from '../metaso/transport.js';

export async function registerAsset(root: string, id: string, input: { file?: string; url?: string; provenance?: 'user' | 'imagegen' }, fetcher?: Fetch) {
  parse(Id, id);
  if ((input.file === undefined) === (input.url === undefined)) fail('INVALID_INPUT', 'Supply exactly one image file or public URL.');
  const url = input.url === undefined ? undefined : publicHttps(input.url);
  const bytes = url ? await fetchImage(url, fetcher) : await readStable(resolve(input.file!), MAX_IMAGE_BYTES);
  const image = inspectImage(bytes), hash = sha256Hex(bytes);
  return withProjectLock(root, async () => {
    const story = await loadStory(root), asset = story.assets.find(a => a.recipe.assetId === id);
    if (!asset) fail('MISSING_RECIPE', 'Declare the asset recipe in the import draft before registration.');
    const media = { ...image, path: `assets/${id}/${hash}.image`, sha256: hash, bytes: bytes.length, provenance: input.provenance ?? 'user', transport: url ? 'url' as const : 'data' as const, ...(url ? { url } : {}) };
    if (canonicalSha256(asset.media) === canonicalSha256(media)) return asset;
    await atomicWrite(await projectPath(root, media.path), bytes);
    asset.media = media; story.revision++;
    await saveStory(root, story); return asset;
  });
}
export async function inspectAssets(root: string) {
  const story = await loadStory(root);
  return Promise.all(story.assets.map(async a => {
    let status: 'missing' | 'ready' | 'changed' = 'missing';
    if (a.media) {
      try { status = sha256Hex(await readStable(await projectPath(root, a.media.path), MAX_IMAGE_BYTES)) === a.media.sha256 ? 'ready' : 'changed'; }
      catch { status = 'missing'; }
    }
    return { assetId: a.recipe.assetId, kind: a.recipe.kind, recipeHash: a.recipeHash, status };
  }));
}
