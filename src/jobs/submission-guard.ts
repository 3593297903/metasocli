import { listJobs, jobPath } from './store.js';
import { listIrOperations, irOperationPath } from './context-ir-store.js';
import { exists } from '../storage/paths.js';
import { fail } from '../core/errors.js';
import { sha256Hex } from '../storage/canonical.js';
import type { Story } from '../contracts/story.js';
import type { GenerationPlan } from '../contracts/plan.js';
import { fetchMedia, type Fetch } from '../metaso/transport.js';
import { MAX_AUDIO_BYTES } from '../assets/audio.js';
import { MAX_IMAGE_BYTES } from '../assets/image.js';

export async function operationKind(root: string, operationId: string): Promise<'ir' | 'video'> {
  const ir = await exists(await irOperationPath(root, operationId)), video = await exists(await jobPath(root, operationId));
  if (ir && video) fail('OPERATION_CONFLICT', 'Operation ID exists in both task namespaces.');
  if (!ir && !video) fail('OPERATION_MISSING', 'No IR or video operation has this ID.');
  return ir ? 'ir' : 'video';
}
/** Caller owns the non-reentrant project lock. No lock acquisition or remote calls here. */
export async function checkSubmissionConflicts(root: string, episodeId: string, segmentId: string, ignoreOperationId?: string) {
  const [videos, irs] = await Promise.all([listJobs(root), listIrOperations(root)]);
  const ids = new Set(videos.map(j => j.operationId));
  if (irs.some(j => ids.has(j.operationId))) fail('OPERATION_CONFLICT', 'Operation ID exists in both task namespaces.');
  const all = [...videos, ...irs];
  const taskIds = all.flatMap(j => j.taskId ? [j.taskId] : []);
  if (new Set(taskIds).size !== taskIds.length) fail('TASK_LINK_CONFLICT', 'A remote task ID is linked to multiple operations.');
  if (all.some(j => j.operationId !== ignoreOperationId && j.status === 'submit_unknown')
    || irs.some(j => j.operationId !== ignoreOperationId && j.status === 'submitting')) fail('SUBMIT_UNKNOWN', 'An IR or video creation is unresolved; recover its task ID before any new paid creation.');
  if (all.some(j => j.operationId !== ignoreOperationId && j.episodeId === episodeId && j.segmentId === segmentId
    && !['prepared', 'failed', 'cancelled', 'downloaded', 'enhanced'].includes(j.status))) fail('JOB_ACTIVE', 'This segment has an unfinished IR or video task; resume it first.');
}
export async function assertTaskIdAvailable(root: string, taskId: string, operationId: string) {
  const all = [...await listJobs(root), ...await listIrOperations(root)];
  if (all.some(j => j.operationId !== operationId && j.taskId === taskId)) fail('TASK_LINK_CONFLICT', 'Remote task ID is already linked to another operation.');
  await operationKind(root, operationId);
}
export async function verifyRemoteAssets(story: Story, assets: GenerationPlan['segments'][number]['assets'], fetcher?: Fetch) {
  for (const ref of assets.filter(a => a.transport === 'url')) {
    const media = story.assets.find(a => a.recipe.assetId === ref.assetId)!.media!;
    if (sha256Hex(await fetchMedia(media.url!, ref.role === 'reference_audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES, fetcher)) !== ref.sha256) fail('REMOTE_ASSET_CHANGED', 'Public reference bytes changed; re-register and replan.');
  }
}
