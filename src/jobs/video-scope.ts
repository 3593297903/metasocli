import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { Hash, parse } from '../contracts/story.js';
import type { VideoBatchPlan } from '../contracts/batch.js';
import { loadStory } from '../core/project.js';
import { loadPlan } from '../core/planning.js';
import { fail, publicError } from '../core/errors.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { waitLease, withProjectWrite } from '../storage/locking.js';
import { exists, projectPath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { batchHeader } from './batch-evidence.js';
import { batchSelection, freezeBatchPlan, loadBatch } from './batch-store.js';

const Binding = z.object({schemaVersion:z.literal(1), projectId:z.uuid(), scopeHash:Hash, batchId:z.uuid(), batchHash:Hash}).strict();
export interface VideoScope { episodes?: string[]; selection?: unknown; concurrency?: number; expectScope?: string }
type Segment = {episodeId:string; segmentId:string};
export function videoScopeHash(projectId:string, revision:number, manifestHash:string, segments:Segment[], concurrency:number) {
  return canonicalSha256({schemaVersion:1, workflow:'h3-inline-ir', projectId, revision, manifestHash, segments, concurrency});
}
export async function frozenScope(root:string, plan:VideoBatchPlan) {
  // loadBatch has already verified all parent hashes, item order, request and input identities.
  const parents = await Promise.all([...new Set(plan.items.map(i=>i.planId))].map(id=>loadPlan(root,id)));
  const {revision, manifestHash} = parents[0]!;
  if (parents.some(p=>p.revision!==revision || p.manifestHash!==manifestHash)) fail('BATCH_TAMPERED','Batch parents describe different story versions: '+plan.batchId);
  const segments = plan.items.map(({episodeId,segmentId})=>({episodeId,segmentId}));
  return {revision, manifestHash, scopeHash:videoScopeHash(plan.projectId, revision, manifestHash, segments, plan.concurrency)};
}
async function verifyCandidate<T>(id:string,read:()=>Promise<T>){
  try{return await read();}
  catch(error){
    const detail=publicError(error);
    if(['LINK_PATH','UNSAFE_PATH','LEGACY_ROOT'].includes(detail.code))throw error;
    fail('VIDEO_SCOPE_UNVERIFIABLE','Cannot verify batch '+id+' ('+detail.code+'). Restore its original record.');
  }
}
export type WorkflowCheckpoint = (point:string, batchId:string)=>Promise<void>;
export async function resolveVideoScope(root:string, input:VideoScope, checkpoint?:WorkflowCheckpoint) {
  const concurrency = parse(z.number().int().min(1).max(4),input.concurrency ?? 4);
  const lease = await waitLease(await projectPath(root,'.metasocli/video-executions/prepare.lock'),30000);
  try {
    const story = await loadStory(root), manifestHash = canonicalSha256(story);
    const selection = batchSelection(story,input);
    const segments = selection.flatMap(({episodeId,segmentIds})=>segmentIds.map(segmentId=>({episodeId,segmentId})));
    const hash = videoScopeHash(story.projectId,story.revision,manifestHash,segments,concurrency);
    if (input.expectScope !== undefined && parse(Hash,input.expectScope)!==hash) fail('VIDEO_SCOPE_CHANGED','Current project, version, ordered segments or concurrency differs from --expect-scope. Prepare the intended scope again.');
    const file = await projectPath(root,'.metasocli/video-executions/by-scope/'+hash+'.json');
    if (await exists(file)) {
      const bound = parse(Binding,await readJson(file));
      if (bound.projectId!==story.projectId || bound.scopeHash!==hash) fail('VIDEO_SCOPE_CONFLICT','Saved scope binding has a different identity: '+bound.batchId);
      const target = await projectPath(root,'.metasocli/batches/'+bound.batchId+'/plan.json');
      if (!await exists(target)) fail('VIDEO_SCOPE_CONFLICT','Saved scope binding points to a missing batch: '+bound.batchId);
      const plan = await verifyCandidate(bound.batchId,()=>loadBatch(root,bound.batchId));
      if (plan.batchHash!==bound.batchHash || (await frozenScope(root,plan)).scopeHash!==hash) fail('VIDEO_SCOPE_CONFLICT','Bound batch does not match its frozen scope/hash: '+bound.batchId);
      return plan;
    }

    const directory = await projectPath(root,'.metasocli/batches'), candidates:VideoBatchPlan[]=[];
    if (await exists(directory)) for (const id of await readdir(directory)) {
      if (!z.uuid().safeParse(id).success) continue;
      const header=await verifyCandidate(id,()=>batchHeader(root,id));
      if(header.concurrency!==concurrency || header.items.length!==segments.length ||
        segments.some((s,i)=>s.episodeId!==header.items[i]!.episodeId || s.segmentId!==header.items[i]!.segmentId))continue;
      const plan=await verifyCandidate(id,()=>loadBatch(root,id));
      if((await frozenScope(root,plan)).scopeHash===hash)candidates.push(plan);
    }
    if (candidates.length>1) fail('VIDEO_SCOPE_AMBIGUOUS','Select one existing --batch: '+candidates.map(p=>p.batchId).join(', '));
    const plan = candidates[0] ?? await freezeBatchPlan(root,{selection:{schemaVersion:1,episodes:selection},concurrency});
    if ((await frozenScope(root,plan)).scopeHash!==hash || canonicalSha256(await loadStory(root))!==manifestHash) fail('PLAN_STALE','Story changed while preparing the batch.');
    await checkpoint?.('video-plan-saved',plan.batchId);
    await withProjectWrite(root,async assertOwned=>{
      await lease.assertOwned();
      if(canonicalSha256(await loadStory(root))!==manifestHash)fail('PLAN_STALE','Story changed before binding the frozen scope.');
      await assertOwned();
      await writeJson(file,parse(Binding,{schemaVersion:1,projectId:story.projectId,scopeHash:hash,batchId:plan.batchId,batchHash:plan.batchHash}));
    });
    await checkpoint?.('video-binding-saved',plan.batchId);
    return plan;
  } finally { await lease.release(); }
}
