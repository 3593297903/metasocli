import { resolve } from 'node:path';
import { z } from 'zod';
import { Hash, Id, parse } from '../contracts/story.js';
import { fail } from '../core/errors.js';
import { loadStory, saveStory } from '../core/project.js';
import { withProjectLock } from '../storage/locking.js';
import { atomicWrite, readStable } from '../storage/io.js';
import { projectPath } from '../storage/paths.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { inspectImage, MAX_IMAGE_BYTES } from './image.js';
import { inspectAudio, MAX_AUDIO_BYTES } from './audio.js';
import { fetchMedia, publicHttps, type Fetch } from '../metaso/transport.js';

export async function registerAsset(root: string, id: string, input: { file?: string; url?: string; provenance?: 'user' | 'imagegen'; expectedSha256?: string }, fetcher?: Fetch) {
  parse(Id, id);
  input = parse(z.object({ file: z.string().min(1).optional(), url: z.string().min(1).optional(), provenance: z.enum(['user', 'imagegen']).optional(), expectedSha256: Hash.optional() }).strict(), input);
  if ((input.file === undefined) === (input.url === undefined)) fail('INVALID_INPUT', 'Supply exactly one media file or public URL.');
  const declared = (await loadStory(root)).assets.find(a => a.recipe.assetId === id);
  if (!declared) fail('MISSING_RECIPE', 'Declare the asset recipe in the import draft before registration.');
  const audio = declared.recipe.kind === 'narration', limit = audio ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
  if (audio && input.provenance === 'imagegen') fail('ASSET_ROLE', 'Narration audio must use user-provided provenance.');
  const url = input.url === undefined ? undefined : publicHttps(input.url);
  const bytes = url ? await fetchMedia(url, limit, fetcher) : await readStable(resolve(input.file!), limit);
  const info = audio ? inspectAudio(bytes) : inspectImage(bytes), hash = sha256Hex(bytes);
  if (input.expectedSha256 && hash !== input.expectedSha256) fail('ASSET_CHANGED', 'The supplied media differs from the explicitly selected reference hash.');
  return withProjectLock(root, async () => {
    const story = await loadStory(root), asset = story.assets.find(a => a.recipe.assetId === id);
    if (!asset) fail('MISSING_RECIPE', 'Declare the asset recipe in the import draft before registration.');
    if (asset.recipeHash !== declared.recipeHash) fail('RECIPE_CONFLICT', 'Asset recipe changed while media was read.');
    const media = { ...info, path: `assets/${id}/${hash}.${audio ? (info.mime === 'audio/mpeg' ? 'mp3' : 'wav') : 'image'}`, sha256: hash, bytes: bytes.length, provenance: input.provenance ?? 'user', transport: url ? 'url' as const : 'data' as const, ...(url ? { url } : {}) };
    if (canonicalSha256(asset.media) === canonicalSha256(media)) {
      const target = await projectPath(root, media.path);
      try { if (sha256Hex(await readStable(target, limit)) === hash) return asset; } catch { /* Restore a missing or damaged managed copy. */ }
    }
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
      try { status = sha256Hex(await readStable(await projectPath(root, a.media.path), a.recipe.kind === 'narration' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES)) === a.media.sha256 ? 'ready' : 'changed'; }
      catch { status = 'missing'; }
    }
    return { assetId: a.recipe.assetId, kind: a.recipe.kind, recipeHash: a.recipeHash, status };
  }));
}
