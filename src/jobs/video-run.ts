import { z } from 'zod';
import { VideoRunBridge, type VideoRunIdentity } from '../contracts/video-run.js';
import { parse } from '../contracts/story.js';
import { loadStory } from '../core/project.js';
import { fail, publicError } from '../core/errors.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { batchSelection } from './batch-store.js';
import { parseBatchOptions } from './batch.js';
import { videoScopeHash } from './video-scope.js';
import { executeVideo, type VideoWorkflowDependencies } from './video-workflow.js';

type Input = Parameters<typeof executeVideo>[1];
type Result = Awaited<ReturnType<typeof executeVideo>>;
type Expected = Pick<VideoRunIdentity, 'projectId' | 'revision' | 'manifestHash' | 'scopeHash' | 'segments'>;

export function checkVideoRunBridge(result: unknown, expected?: Expected): VideoRunIdentity {
  const parsed = VideoRunBridge.safeParse(result);
  if (!parsed.success) fail('VIDEO_RUN_RECEIPT', 'Invalid video workflow bridge receipt. Preserve the prepared batch.');
  const { data, exitCode } = parsed.data;
  if (exitCode !== (['prepared', 'complete'].includes(data.state) ? 0 : 2)
    || data.segments.some((s, i) => s.order !== i)) fail('VIDEO_RUN_RECEIPT', 'Inconsistent video workflow state or order.');
  if (expected && (data.projectId !== expected.projectId || data.revision !== expected.revision
    || data.manifestHash !== expected.manifestHash || data.scopeHash !== expected.scopeHash
    || canonicalSha256(data.segments) !== canonicalSha256(expected.segments))) {
    fail('VIDEO_RUN_SCOPE_CHANGED', 'Prepared scope differs from the captured Story and ordered selection. No new execution was started.');
  }
  return data;
}

/** One public invocation; no new task, authorization, lock or retry state machine. */
export async function runVideo(root: string, input: Input, deps: VideoWorkflowDependencies) {
  const started = performance.now();
  const timings = { prepareMs: 0, handoffCheckMs: 0, executeMs: 0, totalMs: 0 };
  let phase: 'prepare' | 'handoff' | 'execute' | 'local' = input.batch === undefined ? 'prepare' : input.confirm ? 'execute' : 'local';
  let prepared: Result | undefined;
  let identity: VideoRunIdentity | undefined;
  const finish = (result: Result, reused = false) => ({ ...result, data: { ...result.data, phase, reused, timings: { ...timings, totalMs: performance.now() - started } } });
  async function invoke(value: Input, key: 'prepareMs' | 'executeMs', observeInitialReuse?: (ready: boolean) => void) {
    const began = performance.now();
    try { return await executeVideo(root, value, deps, observeInitialReuse); }
    finally { timings[key] += performance.now() - began; }
  }
  try {
    if ([input.batch, input.selection, input.episodes].filter(v => v !== undefined).length !== 1) fail('BATCH_SCOPE', 'Use exactly one of --batch, --selection or --episodes.');
    if (input.batch !== undefined) {
      // Exact-batch recovery must not acquire a new Story/version veto.
      let readyAtStart = false;
      const result = await invoke(input, 'executeMs', ready => { readyAtStart = ready; });
      checkVideoRunBridge(result);
      return finish(result, readyAtStart && result.exitCode === 0 && result.data.state === 'complete');
    }
    parseBatchOptions(input.options);
    const concurrency = parse(z.number().int().min(1).max(4), input.concurrency ?? 4);
    const began = performance.now();
    const story = await loadStory(root), manifestHash = canonicalSha256(story);
    const segments = batchSelection(story, input).flatMap(row => row.segmentIds.map(segmentId => ({ episodeId: row.episodeId, segmentId })))
      .map((s, order) => ({ order, ...s }));
    const scopeHash = videoScopeHash(story.projectId, story.revision, manifestHash, segments.map(({episodeId,segmentId})=>({episodeId,segmentId})), concurrency);
    const expected = { projectId: story.projectId, revision: story.revision, manifestHash, scopeHash, segments };
    if (input.expectScope !== undefined && input.expectScope !== scopeHash) fail('VIDEO_SCOPE_CHANGED', 'Expected scope does not match the captured Story.');
    timings.prepareMs += performance.now() - began;
    prepared = await invoke({ ...input, confirm: false, expectScope: scopeHash }, 'prepareMs');
    phase = 'handoff';
    const checking = performance.now();
    try {
      await deps.workflowCheckpoint?.('video-run-prepared', prepared.data.batchId);
      identity = checkVideoRunBridge(prepared, expected);
    } finally { timings.handoffCheckMs += performance.now() - checking; }
    if (!input.confirm || prepared.data.state === 'complete' || 'error' in prepared.data
      || !['prepared', 'partial'].includes(prepared.data.state)) {
      return finish(prepared, prepared.data.state === 'complete');
    }
    await deps.workflowCheckpoint?.('video-run-checked', prepared.data.batchId);
    phase = 'execute';
    const result = await invoke({ batch: prepared.data.batchId, confirm: true, verifyAv: input.verifyAv, options: input.options }, 'executeMs');
    const final = checkVideoRunBridge(result, expected);
    if (final.batchId !== prepared.data.batchId || final.batchHash !== prepared.data.batchHash) fail('VIDEO_RUN_RECEIPT', 'Execution returned a different batch identity.');
    return finish(result);
  } catch (error) {
    // A prior local status is not a fresh execution observation. Retain identity,
    // not obsolete pending statuses or arbitrary contents of a malformed receipt.
    const batchId = z.uuid().safeParse(prepared?.data.batchId ?? input.batch);
    return { exitCode: 1, data: { ...(identity ?? (batchId.success ? {batchId:batchId.data} : {})), state: 'partial', phase,
      error: publicError(error), timings: { ...timings, totalMs: performance.now() - started } } };
  }
}
