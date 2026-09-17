import { mkdir, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify } from 'yaml';
import { ImportDraft, Manifest, Episode, parse, type Story } from '../contracts/story.js';
import { fail } from './errors.js';
import { initializationPath, safePath, exists, projectPath } from '../storage/paths.js';
import { atomicWrite, readStable } from '../storage/io.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { withProjectLock } from '../storage/locking.js';
import { normalizeText, validateCoverage } from '../story/text.js';

export async function loadStory(input: string): Promise<Story> {
  const root = await safePath(input);
  const file = await projectPath(root, 'metasocli.yaml');
  if (!await exists(file)) fail('NOT_INITIALIZED', 'No metasocli.yaml at the explicit project root.');
  let raw: unknown;
  try { raw = parseYaml((await readStable(file)).toString('utf8'), { maxAliasCount: 0 }); }
  catch { return fail('INVALID_MANIFEST', 'Cannot parse metasocli.yaml.'); }
  const story = parse(Manifest, raw);
  if (new Set(story.episodes.map(e => e.id)).size !== story.episodes.length || new Set(story.assets.map(a => a.recipe.assetId)).size !== story.assets.length) {
    fail('INVALID_MANIFEST', 'Episode and asset identifiers must be unique.');
  }
  for (const asset of story.assets) {
    if (canonicalSha256(asset.recipe) !== asset.recipeHash) fail('CONTENT_CHANGED', 'Asset recipe hash mismatch.');
    if (asset.media && ((asset.media.transport === 'url') !== (asset.media.url !== undefined))) fail('INVALID_MANIFEST', 'URL transport requires a verified URL.');
  }
  return story;
}
export async function saveStory(root: string, story: Story): Promise<void> {
  const text = stringify(parse(Manifest, story));
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) fail('FILE_LIMIT', 'Story manifest exceeds the local 8 MiB limit. Split the story.');
  await atomicWrite(await projectPath(root, 'metasocli.yaml'), text);
}
export async function initializeStory(input: string, name: string): Promise<Story> {
  const checked = await safePath(input);
  if (await exists(join(checked, 'metasocli.yaml'))) return loadStory(checked);
  const root = await initializationPath(input);
  if (await exists(root) && (await readdir(root)).length > 0) fail('ROOT_NOT_EMPTY', 'Initialize an empty, dedicated story directory.');
  const story = parse(Manifest, { schemaVersion: 1, owner: 'metasocli', projectId: randomUUID(), name, revision: 0, episodes: [], assets: [] });
  await mkdir(root, { recursive: true });
  // Exclusive creation arbitrates concurrent initialization before any manifest write.
  await mkdir(await projectPath(root, '.metasocli'));
  for (const dir of ['sources', 'plans', 'jobs', 'receipts']) await mkdir(await projectPath(root, `.metasocli/${dir}`));
  await saveStory(root, story);
  return story;
}
export async function importStory(root: string, value: unknown, replace = false): Promise<Story> {
  const draft = parse(ImportDraft, value);
  // Explicit source is read once and copied. Runtime never imports modules from its location.
  const raw = await readStable(resolve(draft.source));
  const text = normalizeText(raw);
  validateCoverage(text, draft.segments);
  const rawHash = sha256Hex(raw), textHash = sha256Hex(text);
  const episode = parse(Episode, {
    id: draft.episodeId, kind: draft.kind,
    source: { origin: basename(draft.source), rawPath: `.metasocli/sources/${rawHash}.bin`, rawHash, textPath: `.metasocli/sources/${textHash}.txt`, textHash },
    segments: draft.segments.map(s => {
      const original = text.slice(s.start, s.end);
      const prompt = s.prompt === undefined ? original : normalizeText(s.prompt);
      if (draft.kind === 'video-prompts' && prompt !== original) fail('PROMPT_CHANGED', `Finished prompt ${s.id} must match its complete source span.`);
      if (draft.kind === 'script' && !prompt.includes(original)) fail('DIALOGUE_CHANGED', `Script prompt ${s.id} must include its complete source span verbatim.`);
      if (new Set(s.references.map(r => r.assetId)).size !== s.references.length) fail('DUPLICATE_REFERENCE', `Segment ${s.id} repeats an asset.`);
      return { ...s, prompt, promptHash: sha256Hex(prompt) };
    }),
  });
  return withProjectLock(root, async () => {
    const story = await loadStory(root);
    const previous = story.episodes.find(e => e.id === episode.id);
    if (previous && canonicalSha256(previous) !== canonicalSha256(episode) && !replace) fail('EPISODE_EXISTS', 'Episode differs; use explicit replacement or a new episode id.');
    const nextAssets = [...story.assets];
    for (const recipe of draft.recipes) {
      const previousAsset = nextAssets.find(a => a.recipe.assetId === recipe.assetId);
      const recipeHash = canonicalSha256(recipe);
      if (previousAsset && previousAsset.recipeHash !== recipeHash) fail('RECIPE_CONFLICT', `Asset ${recipe.assetId} has a different recipe; use a new asset id.`);
      if (!previousAsset) nextAssets.push({ recipe, recipeHash, media: null });
    }
    for (const asset of nextAssets) {
      if (new Set(asset.recipe.dependencies).size !== asset.recipe.dependencies.length || asset.recipe.dependencies.some(id => !nextAssets.some(a => a.recipe.assetId === id) || id === asset.recipe.assetId)) fail('RECIPE_DEPENDENCY', 'Recipe dependencies must uniquely reference other declared assets.');
    }
    const visited = new Set<string>(), active = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id)) fail('RECIPE_DEPENDENCY', 'Asset recipes contain a dependency cycle.');
      if (visited.has(id)) return;
      active.add(id); for (const dependency of nextAssets.find(a => a.recipe.assetId === id)!.recipe.dependencies) visit(dependency);
      active.delete(id); visited.add(id);
    };
    for (const asset of nextAssets) visit(asset.recipe.assetId);
    for (const s of episode.segments) for (const ref of s.references) {
      if (!nextAssets.some(a => a.recipe.assetId === ref.assetId)) fail('MISSING_RECIPE', `Missing recipe for ${ref.assetId}.`);
    }
    const episodes = previous ? story.episodes.map(e => e.id === episode.id ? episode : e) : [...story.episodes, episode];
    if (canonicalSha256({ episodes, assets: nextAssets }) === canonicalSha256({ episodes: story.episodes, assets: story.assets })) {
      let intact = false;
      try {
        intact = sha256Hex(await readStable(await projectPath(root, episode.source.rawPath))) === rawHash
          && sha256Hex(await readStable(await projectPath(root, episode.source.textPath))) === textHash;
      } catch { /* Reimport the explicit source to restore its missing snapshots. */ }
      if (intact) return story;
    }
    await atomicWrite(await projectPath(root, episode.source.rawPath), raw);
    await atomicWrite(await projectPath(root, episode.source.textPath), text);
    const next = { ...story, revision: story.revision + 1, episodes, assets: nextAssets };
    await saveStory(root, next);
    return next;
  });
}
