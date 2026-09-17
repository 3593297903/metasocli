import { randomUUID } from 'node:crypto';
import { Id, parse, type Story } from '../contracts/story.js';
import { Plan, type GenerationPlan } from '../contracts/plan.js';
import { fail } from './errors.js';
import { loadStory } from './project.js';
import { withProjectLock } from '../storage/locking.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { readJson, readStable, writeJson } from '../storage/io.js';
import { projectPath } from '../storage/paths.js';
import { buildRequest } from '../metaso/h3.js';
import { normalizeText, validateCoverage } from '../story/text.js';
import { z } from 'zod';

async function requests(root: string, story: Story, episodeId: string) {
  const episode = story.episodes.find(e => e.id === episodeId);
  if (!episode) fail('EPISODE_MISSING', 'Episode does not exist.');
  const source = await readStable(await projectPath(root, episode.source.rawPath));
  const normalized = await readStable(await projectPath(root, episode.source.textPath));
  if (sha256Hex(source) !== episode.source.rawHash || sha256Hex(normalized) !== episode.source.textHash || normalizeText(source) !== normalized.toString('utf8')) fail('SOURCE_CHANGED', 'Source snapshot changed; import a new revision.');
  const text = normalized.toString('utf8'); validateCoverage(text, episode.segments);
  for (const s of episode.segments) {
    const span = text.slice(s.start, s.end);
    if (episode.kind === 'video-prompts' ? s.prompt !== span : !s.prompt.includes(span)) fail('SOURCE_CHANGED', `Prompt ${s.id} lost its source text.`);
  }
  const built = [];
  for (const segment of episode.segments) built.push(await buildRequest(root, story, segment));
  return built;
}
export async function createPlan(root: string, episodeId: string): Promise<GenerationPlan> {
  parse(Id, episodeId);
  return withProjectLock(root, async () => {
    const story = await loadStory(root);
    const built = await requests(root, story, episodeId);
    const base = { schemaVersion: 1 as const, planId: randomUUID(), projectId: story.projectId, episodeId, revision: story.revision,
      manifestHash: canonicalSha256(story), createdAt: new Date().toISOString(), segments: built.map(b => b.summary) };
    const plan = parse(Plan, { ...base, planHash: canonicalSha256(base) });
    await writeJson(await projectPath(root, `.metasocli/plans/${plan.planId}.json`), plan);
    return plan;
  });
}
export async function loadPlan(root: string, planId: string): Promise<GenerationPlan> {
  parse(z.uuid(), planId);
  const plan = parse(Plan, await readJson(await projectPath(root, `.metasocli/plans/${planId}.json`)));
  const { planHash, ...base } = plan;
  if (plan.planId !== planId || canonicalSha256(base) !== planHash) fail('PLAN_TAMPERED', 'Plan hash or identity mismatch.');
  return plan;
}
export async function validatePlan(root: string, plan: GenerationPlan) {
  const story = await loadStory(root);
  if (story.projectId !== plan.projectId || story.revision !== plan.revision || canonicalSha256(story) !== plan.manifestHash) fail('PLAN_STALE', 'Story or assets changed; create a fresh plan before any new submission.');
  const built = await requests(root, story, plan.episodeId);
  if (canonicalSha256(built.map(b => b.summary)) !== canonicalSha256(plan.segments)) fail('PLAN_STALE', 'Request content differs from the immutable plan.');
  return { story, built };
}
