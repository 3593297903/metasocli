import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parse } from '../contracts/story.js';
import { BatchPlan, BatchRun, Selection, type VideoBatchPlan, type VideoBatchRun } from '../contracts/batch.js';
import { createPlan, loadPlan } from '../core/planning.js';
import { loadStory } from '../core/project.js';
import { fail } from '../core/errors.js';
import { readJson, writeJson } from '../storage/io.js';
import { projectPath, exists } from '../storage/paths.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { withProjectWrite } from '../storage/locking.js';
import { listJobs } from './store.js';
import { listIrOperations } from './context-ir-store.js';
import { reconcileOutput } from './video.js';
export const batchPath = (root: string, id: string, name: 'plan'|'run') => projectPath(root, '.metasocli/batches/' + parse(z.uuid(), id) + '/' + name + '.json');
export async function loadBatch(root: string, id: string) {
  const plan = parse(BatchPlan, await readJson(await batchPath(root, id, 'plan'))), { batchHash, ...base } = plan;
  if (plan.batchId !== id || canonicalSha256(base) !== batchHash || (await loadStory(root)).projectId !== plan.projectId) fail('BATCH_TAMPERED', 'Batch identity/hash changed.');
  const loaded = new Map<string, Awaited<ReturnType<typeof loadPlan>>>();
  const unique = new Set<string>();
  for (const [index, item] of plan.items.entries()) {
    const key = item.episodeId + '/' + item.segmentId;
    if (item.order !== index || item.projectId !== plan.projectId || unique.has(key)) fail('BATCH_TAMPERED', 'Batch order or unique scope changed.');
    unique.add(key);
    let parent = loaded.get(item.planId);
    if (!parent) { parent = await loadPlan(root, item.planId); loaded.set(item.planId, parent); }
    const segment = parent.segments.find(s => s.segmentId === item.segmentId);
    if (parent.workflow?.stage !== 'inline-video' || parent.projectId !== item.projectId || parent.episodeId !== item.episodeId
      || parent.planHash !== item.planHash || segment?.contextIr !== true || segment.requestHash !== item.requestHash || segment.inputHash !== item.inputHash) fail('BATCH_TAMPERED', 'Batch item differs from its immutable inline plan.');
  }
  return plan;
}
export async function loadBatchRun(root: string, plan: VideoBatchPlan): Promise<VideoBatchRun | undefined> {
  const file = await batchPath(root, plan.batchId, 'run');
  if (!await exists(file)) return undefined;
  const run = parse(BatchRun, await readJson(file)), { hash, ...base } = run;
  if (canonicalSha256(base) !== hash || run.batchId !== plan.batchId || run.batchHash !== plan.batchHash || run.authorization.batchHash !== plan.batchHash
    || run.items.length !== plan.items.length || run.items.some((i, index) => i.order !== index)) fail('BATCH_RUN_TAMPERED', 'Run authorization or index does not match this batch.');
  return run;
}
export async function saveBatchRun(root: string, run: VideoBatchRun) {
  run.updatedAt = new Date().toISOString();
  const { hash: _, ...base } = run; run.hash = canonicalSha256(base);
  const snapshot = parse(BatchRun, run);
  await withProjectWrite(root, async () => writeJson(await batchPath(root, snapshot.batchId, 'run'), snapshot));
}
export async function batchStatus(root: string, id: string) {
  const plan = await loadBatch(root, id), run = await loadBatchRun(root, plan), jobs = await listJobs(root);
  let reusable = 0, active = 0, pending = 0, failed = 0, downloads = 0;
  const items = [];
  for (const item of plan.items) {
    const job = jobs.filter(j => j.episodeId === item.episodeId && j.segmentId === item.segmentId && j.inputHash === item.inputHash).at(-1);
    const saved = run?.items[item.order];
    if (saved?.operationId && !jobs.some(j => j.operationId === saved.operationId && j.inputHash === item.inputHash && j.episodeId === item.episodeId && j.segmentId === item.segmentId)) fail('BATCH_RUN_TAMPERED', 'Batch index is linked to a different task.');
    let outputError: string | undefined;
    if (!job || job.status === 'prepared') pending++;
    else if (job.status === 'downloaded') {
      try { if (await reconcileOutput(root, job)) reusable++; } catch { downloads++; outputError = 'OUTPUT_NEEDS_RECOVERY'; }
    } else if (['failed','cancelled'].includes(job.status)) failed++;
    else if (job.status === 'generated') downloads++;
    else active++;
    items.push({ ...item, ...(job ? { job } : {}), ...(outputError ? { outputError } : {}) });
  }
  return { plan, run, summary: { total: items.length, reusable, active, pending, failed, downloads, concurrency: plan.concurrency, downloadConcurrency: plan.downloadConcurrency }, items };
}
export async function createBatchPlan(root: string, input: { episodes?: string[]; selection?: unknown; allEpisodes?: boolean; concurrency?: number }) {
  if ([input.episodes !== undefined, input.selection !== undefined, input.allEpisodes === true].filter(Boolean).length !== 1) fail('BATCH_SCOPE', 'Use exactly one of --episodes, --selection or --all-episodes.');
  const concurrency = parse(z.number().int().min(1).max(4), input.concurrency ?? 4), story = await loadStory(root);
  if (input.allEpisodes && ((await listIrOperations(root)).length || story.episodes.some(e => /[\\/]context-ir[\\/]/u.test(e.source.origin)))) {
    fail('BATCH_ORIGINALS_AMBIGUOUS', 'Independent IR history exists. Use explicit original episode IDs or a selection; no copy episodes are inferred from names.');
  }
  const selection = input.selection !== undefined ? parse(Selection, input.selection).episodes
    : (input.episodes ?? story.episodes.map(e => e.id)).map(episodeId => {
      const episode = story.episodes.find(e => e.id === episodeId);
      if (!episode) fail('EPISODE_MISSING', 'Selected episode does not exist.');
      return { episodeId, segmentIds: episode.segments.map(s => s.id) };
    });
  if (!selection.length || new Set(selection.map(e => e.episodeId)).size !== selection.length) fail('BATCH_SCOPE', 'Episode selection must be nonempty and unique.');
  for (const row of selection) {
    const episode = story.episodes.find(e => e.id === row.episodeId);
    if (!episode || new Set(row.segmentIds).size !== row.segmentIds.length || row.segmentIds.some(id => !episode.segments.some(s => s.id === id))) fail('BATCH_SCOPE', 'Selected segments must exist and be unique.');
  }
  const items: VideoBatchPlan['items'] = [];
  for (const row of selection) {
    const plan = await createPlan(root, row.episodeId, 'h3-inline-ir');
    for (const segmentId of row.segmentIds) {
      const s = plan.segments.find(s => s.segmentId === segmentId)!;
      items.push({ order: items.length, projectId: story.projectId, episodeId: row.episodeId, segmentId, planId: plan.planId, planHash: plan.planHash, requestHash: s.requestHash, inputHash: s.inputHash });
    }
  }
  const base = { schemaVersion: 1 as const, batchId: randomUUID(), projectId: story.projectId, createdAt: new Date().toISOString(), concurrency,
    downloadConcurrency: 2 as const, retryPolicy: { max429RetriesPerItem: 2 as const, totalWaitBudgetMs: 60000 as const }, items };
  const plan = parse(BatchPlan, { ...base, batchHash: canonicalSha256(base) });
  await withProjectWrite(root, async () => {
    if (canonicalSha256(await loadStory(root)) !== canonicalSha256(story)) fail('BATCH_STALE', 'Story changed while freezing the scope; prepare again.');
    await writeJson(await batchPath(root, plan.batchId, 'plan'), plan);
  });
  return batchStatus(root, plan.batchId);
}
