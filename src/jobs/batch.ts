import { z } from 'zod';
import { type Job } from '../contracts/job.js';
import { parse } from '../contracts/story.js';
import { type VideoBatchRun } from '../contracts/batch.js';
import { fail, publicError, isCode } from '../core/errors.js';
import { readJson } from '../storage/io.js';
import { projectPath, exists, samePath } from '../storage/paths.js';
import { listJobs } from './store.js';
import { submit, type JobDependencies } from './submit.js';
import { resume } from './resume.js';
import { ProviderError, CreateDiagnostics } from '../metaso/client.js';
import { liveLease, withProjectWrite } from '../storage/locking.js';
import { submissionLeasePath } from './submission-owner.js';
import { batchStatus, loadBatch, loadBatchRun, saveBatchRun } from './batch-store.js';
import { acquireScheduler, reconcileRuntime, runtimeDirectory, occupied, blockingSlots } from './coordinator.js';
import { authorizeVideoRetry, listVideoRetries, materializeRetry, effectiveJobs } from './video-retry.js';
import { acquireVideoStage } from '../images/phase.js';

const Options = z.object({ maxPolls: z.number().int().min(1).max(720).default(60), pollIntervalMs: z.number().int().min(0).max(60000).default(5000),
  schedulerWaitMs: z.number().int().min(0).max(300000).default(30000) }).strict();
type Event = { kind: 'create'|'query'|'download'; root?: string; order?: number; job?: Job; error?: ReturnType<typeof publicError> };
export interface BatchDependencies extends JobDependencies { retryOperationId?: string; now?: () => number; onStart?: (summary: Awaited<ReturnType<typeof batchStatus>>['summary']) => void | Promise<void> }
export async function authorizeBatchRetry(root: string, id: string, old: string, confirmed: boolean, accepted: boolean, deps: Pick<BatchDependencies, 'runtimeRoot'|'checkpoint'> = {}) {
  const plan = await loadBatch(root, id), jobs = await listJobs(root), original = jobs.find(j => j.operationId === old);
  const item = plan.items.find(i => i.episodeId === original?.episodeId && i.segmentId === original.segmentId && i.inputHash === original.inputHash && i.requestHash === original.requestHash);
  if (!item) fail('RETRY_CONFLICT', 'Local operation is not in this batch scope.');
  return authorizeVideoRetry(root, item.planId, item.segmentId, old, confirmed, accepted, deps.runtimeRoot, deps.checkpoint);
}
async function creationError(root: string, job: Job) {
  const file = await projectPath(root, '.metasocli/receipts/' + job.operationId + '-create-error.json');
  if (!await exists(file)) return undefined;
  const record = parse(z.object({ operationId: z.uuid(), requestHash: z.string(), httpStatus: z.number().nullable(), safeToRetry: z.boolean(), retryAfterMs: z.number().nonnegative(), diagnostics: CreateDiagnostics.optional() }).strict(), await readJson(file));
  if (record.operationId !== job.operationId || record.requestHash !== job.requestHash) fail('RECEIPT_CONFLICT', 'Creation failure record belongs to a different intent.');
  return record;
}
/** A single installation scheduler; POST, GET and downloads are separate asynchronous queues. */
export async function runBatch(root: string, id: string, authorize: boolean, deps: BatchDependencies, input: Partial<z.infer<typeof Options>> = {}) {
  const options = parse(Options, input), plan = await loadBatch(root, id), runtime = runtimeDirectory(deps.runtimeRoot);
  const scheduler = await acquireScheduler(runtime, options.schedulerWaitMs);
  let videoStage: Awaited<ReturnType<typeof acquireVideoStage>> | undefined;
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const creates = new Map<number, Promise<void>>(), queries = new Map<string, Promise<void>>(), downloads = new Map<number, Promise<void>>();
  try {
    let run = await loadBatchRun(root, plan);
    let imageStagePaused=false;
    try{videoStage=await acquireVideoStage(root);}
    catch(error){if(!authorize&&run&&isCode(error,'IMAGE_STAGE_ACTIVE'))imageStagePaused=true;else throw error;}
    if (!run) {
      const retry = deps.retryOperationId && (await listVideoRetries(root, runtime)).find(a => a.oldOperationId === deps.retryOperationId);
      if (!authorize && !retry) fail('GENERATION_NOT_AUTHORIZED', 'batch resume requires a saved authorization for this exact batch hash.');
      run = { schemaVersion: 1, batchId: id, batchHash: plan.batchHash, hash: '0'.repeat(64),
        authorization: { batchHash: plan.batchHash, authorizedAt: new Date().toISOString(), ...(!authorize && retry ? { retryOnly: [retry.newOperationId] } : {}) }, status: 'running', updatedAt: new Date().toISOString(),
        items: plan.items.map(i => ({ order: i.order, retryHistory: [] })), rateLimit: { spentWaitMs: 0, notBefore: 0 }, trace: [] };
    }
    const state: VideoBatchRun = run;
    if (authorize) delete state.authorization.retryOnly;
    if (state.authorization.retryOnly && deps.retryOperationId) {
      const retry = (await listVideoRetries(root, runtime)).find(a => a.oldOperationId === deps.retryOperationId);
      if (!retry || !plan.items.some(i => i.planId === retry.planId && i.segmentId === retry.segmentId)) fail('RETRY_CONFLICT', 'Retry is outside this batch.');
      if (!state.authorization.retryOnly.includes(retry.newOperationId)) state.authorization.retryOnly.push(retry.newOperationId);
    }
    state.status = 'running';
    for (const item of state.items) delete item.error; // Retry local checks on a later explicitly resumed invocation.
    await saveBatchRun(root, state);
    const initial = await batchStatus(root, id);
    await deps.onStart?.(initial.summary);
    const verified = new Set(initial.items.filter(i => i.job?.status === 'downloaded' && !i.outputError).map(i => i.order));
    const attemptedDownloads = new Set<number>(), polls = new Map<string, number>(), nextQuery = new Map<string, number>();
    const handledFailures = new Set<string>();
    const createdThisRun = new Set<string>();
    const events: Event[] = [];
    let halt = imageStagePaused, dispatchPaused = false;
    const taskDeps = { ...deps, runtimeRoot: runtime, schedulerToken: scheduler.token, capacity: plan.concurrency, client: {
      prepare: deps.client.prepare?.bind(deps.client),
      create: deps.client.create.bind(deps.client),
      async query(taskId: string) {
        try {
          const observed = await deps.client.query(taskId);
          if (observed.status === 'unknown') { halt = true; dispatchPaused = true; }
          return observed;
        }
        catch (error) {
          if (error instanceof ProviderError && (error.code === 'QUERY_CONTRACT' || [401,402,403].includes(error.options.httpStatus ?? 0))) { halt = true; dispatchPaused = true; }
          throw error;
        }
      },
    } };
    const trace = (event: string, order?: number, job?: Job, detail?: string, count?: number) => {
      state.trace.push({ at: new Date(now()).toISOString(), event, ...(order === undefined ? {} : { order }),
        ...(job ? { operationId: job.operationId } : {}), ...(detail ? { detail } : {}), ...(count === undefined ? {} : { occupied: count }) });
    };
    if(imageStagePaused)trace('image-stage-pause',undefined,undefined,'Only original task IDs may query/download; new video submissions remain paused.');
    for (;;) {
      await scheduler.assertOwned();
      if (!creates.size) dispatchPaused = false;
      for (const event of events.splice(0)) {
        if (event.kind === 'create' && event.job) createdThisRun.add(event.job.operationId);
        trace(event.kind + (event.error ? '-error' : '-result'), event.order, event.job, event.error?.code);
        if (event.order !== undefined) {
          const item = state.items[event.order]!;
          if (event.job) item.operationId = event.job.operationId;
          if (event.kind === 'create' && event.job && event.job.status !== 'failed') delete item.retryOf;
          if (event.error) item.error = event.error;
          if (event.kind === 'download' && event.job?.status === 'downloaded') verified.add(event.order);
          if (event.kind === 'create' && event.job?.retryOf) {
            await saveBatchRun(root, state);
            await deps.checkpoint?.('retry-batch-index', event.job);
          }
        }
        if (event.job?.lastError && event.kind === 'query' && event.job.evidencePath) {
          const evidence = await readJson(await projectPath(event.root ?? root, event.job.evidencePath)) as { httpStatus?: number };
          if ([401,402,403].includes(evidence.httpStatus ?? 0)) { halt = true; trace('account-halt', undefined, event.job); }
        }
      }
      const retryAuthorizations = (await listVideoRetries(root, runtime)).filter(a => plan.items.some(i => i.planId === a.planId && i.segmentId === a.segmentId));
      for (const a of retryAuthorizations) await withProjectWrite(root, () => materializeRetry(root, a, deps.checkpoint));
      const allJobs = await listJobs(root), jobs = effectiveJobs(allJobs);
      const selected = plan.items.map(item => {
        const matches = jobs.filter(j => j.episodeId === item.episodeId && j.segmentId === item.segmentId && j.inputHash === item.inputHash);
        const job = matches.at(-1), index = state.items[item.order]!;
        if (index.operationId && !allJobs.some(j => j.operationId === index.operationId && j.inputHash === item.inputHash && j.episodeId === item.episodeId && j.segmentId === item.segmentId)) fail('BATCH_RUN_TAMPERED', 'Batch operation link changed.');
        if (job) index.operationId = job.operationId;
        return job;
      });
      // Classify a rejected POST once. Retry intent and its cumulative wait budget precede the next POST.
      for (const [order, job] of selected.entries()) {
        if (!job || job.status !== 'failed' || handledFailures.has(job.operationId)) continue;
        handledFailures.add(job.operationId);
        const failure = await creationError(root, job), item = state.items[order]!;
        if (!failure) continue;
        if ([401,402,403].includes(failure.httpStatus ?? 0)) {
          // On a new invocation old account failures remain failed, while the remaining authorized items may be attempted.
          if (createdThisRun.has(job.operationId)) halt = true;
        }
        if (!failure.safeToRetry || failure.httpStatus !== 429) continue;
        if (retryAuthorizations.some(a => a.newOperationId === job.operationId)) continue; // This authorization buys exactly one POST, even for 429.
        if (item.retryHistory.includes(job.operationId)) continue;
        const wait = Math.max(250 * 2 ** item.retryHistory.length, failure.retryAfterMs);
        if (item.retryHistory.length >= plan.retryPolicy.max429RetriesPerItem || state.rateLimit.spentWaitMs + wait > plan.retryPolicy.totalWaitBudgetMs) {
          halt = true; trace('rate-budget-exhausted', order, job); continue;
        }
        item.retryHistory.push(job.operationId); item.retryOf = job.operationId;
        state.rateLimit.spentWaitMs += wait; state.rateLimit.notBefore = Math.max(state.rateLimit.notBefore, now() + wait);
        trace('rate-backoff', order, job, String(wait));
      }
      let ledger = await reconcileRuntime(root, runtime);
      let blocked = (await blockingSlots(root, ledger, runtime)).length > 0 || halt || dispatchPaused;
      // Prioritize replenishment before starting or waiting for any download.
      if (!blocked && now() >= state.rateLimit.notBefore) {
        const prioritized = [...plan.items].sort((a, b) => Number(retryAuthorizations.some(r => r.newOperationId === selected[b.order]?.operationId && selected[b.order]?.status === 'prepared'))
          - Number(retryAuthorizations.some(r => r.newOperationId === selected[a.order]?.operationId && selected[a.order]?.status === 'prepared')) || a.order - b.order);
        for (const item of prioritized) {
          const job = selected[item.order], index = state.items[item.order]!;
          if (state.authorization.retryOnly && (!job || !state.authorization.retryOnly.includes(job.operationId))) continue;
          if (creates.has(item.order) || index.error || (job && job.status !== 'prepared' && !(job.status === 'failed' && index.retryOf === job.operationId))) continue;
          if (occupied(ledger).length >= plan.concurrency && !(job?.status === 'prepared' && ledger.slots.some(s => s.operationId === job.operationId))) break;
          trace('dispatch', item.order, job, undefined, occupied(ledger).length);
          await saveBatchRun(root, state);
          let entered!: () => void;
          const started = new Promise<void>(resolve => { entered = resolve; });
          const work = submit(root, item.planId, item.segmentId, true, { ...taskDeps, client: {
            prepare: taskDeps.client.prepare,
            async create(request) {
              entered();
              try { return await deps.client.create(request); }
              catch (error) {
                // Stop new dispatch immediately, including the interval before the rejection is persisted.
                dispatchPaused = true;
                if (error instanceof ProviderError && [401,402,403].includes(error.options.httpStatus ?? 0)) halt = true;
                throw error;
              }
            },
            query(taskId) { return taskDeps.client.query(taskId); },
          } }, index.retryOf).then(job => {
            events.push({ kind: 'create', order: item.order, job });
            if (job.status === 'failed') handledFailures.delete(job.operationId);
          }, error => {
            const detail = publicError(error);
            // Capacity/ownership contention defers the item rather than changing its request.
            if (!['CAPACITY_FULL','SCHEDULER_BUSY','LOCK_BUSY'].includes(detail.code)) events.push({ kind: 'create', order: item.order, error: detail });
          }).finally(() => { creates.delete(item.order); entered(); });
          creates.set(item.order, work);
          // Wait only until this POST enters its transport (or local preparation fails), never for its response.
          await started;
          ledger = await reconcileRuntime(root, runtime);
          if (dispatchPaused || halt || (await blockingSlots(root, ledger, runtime)).length || events.length) break;
        }
      }
      // Query all registered accepted tasks, including older tasks occupying shared slots.
      let nextWake = Infinity;
      for (const slot of occupied(ledger)) {
        if (!slot.taskId || slot.status === 'prepared' || slot.status === 'reserved' || slot.status === 'submit_unknown') continue;
        // Receipt persistence can make an ID visible before its creating process finishes
        // the queued/evidence checkpoint. Do not spend a query budget on that partial snapshot.
        if (await liveLease(await submissionLeasePath(slot.root, slot.operationId))) { nextWake = Math.min(nextWake, now() + 25); continue; }
        const key = slot.operationId;
        if (queries.has(key) || (polls.get(key) ?? 0) >= options.maxPolls) continue;
        const due = nextQuery.get(key) ?? 0;
        if (due > now()) { nextWake = Math.min(nextWake, due); continue; }
        if (queries.size >= 4) continue;
        polls.set(key, (polls.get(key) ?? 0) + 1);
        const order = samePath(slot.root, root) ? selected.findIndex(j => j?.operationId === key) : -1;
        const work = resume(slot.root, key, taskDeps, { maxPolls: 1, download: false, observeOnly: true })
          .then(job => { events.push({ kind: 'query', root: slot.root, ...(order < 0 ? {} : { order }), job }); },
            error => { events.push({ kind: 'query', ...(order < 0 ? {} : { order }), error: publicError(error) }); })
          .finally(() => { queries.delete(key); nextQuery.set(key, now() + options.pollIntervalMs); });
        queries.set(key, work);
      }
      for (const item of plan.items) {
        const job = selected[item.order];
        if (!job || !['generated','downloaded'].includes(job.status) || verified.has(item.order) || attemptedDownloads.has(item.order) || downloads.size >= plan.downloadConcurrency) continue;
        attemptedDownloads.add(item.order);
        trace('download-start', item.order, job);
        const work = resume(root, job.operationId, taskDeps, { maxPolls: 1, observeOnly: true, redownloadMissing: true })
          .then(job => { events.push({ kind: 'download', order: item.order, job }); },
            error => { events.push({ kind: 'download', order: item.order, error: publicError(error) }); })
          .finally(() => { downloads.delete(item.order); });
        downloads.set(item.order, work);
      }
      await saveBatchRun(root, state);
      if (events.length) continue;
      const running = [...creates.values(), ...queries.values(), ...downloads.values()];
      const pending = plan.items.some(i => !state.items[i.order]!.error && (!selected[i.order] || selected[i.order]!.status === 'prepared' || (selected[i.order]!.status === 'failed' && state.items[i.order]!.retryOf === selected[i.order]!.operationId)));
      if (pending && !blocked && state.rateLimit.notBefore > now()) nextWake = Math.min(nextWake, state.rateLimit.notBefore);
      if (!running.length && nextWake === Infinity) {
        // A just-freed slot or a newly indexed generated result needs one more loop.
        const refresh = effectiveJobs(await listJobs(root));
        if (refresh.some(j => !jobs.some(old => old.operationId === j.operationId && old.updatedAt === j.updatedAt && old.status === j.status))) continue;
        if (occupied(ledger).length >= plan.concurrency && !occupied(ledger).some(s => s.taskId)) trace('waiting-capacity-no-queryable-tasks', undefined, undefined, 'Possible occupied capacity is full; no queryable tasks. Authorization retained.', occupied(ledger).length);
        break;
      }
      const timer = nextWake === Infinity ? undefined : sleep(Math.max(0, nextWake - now()));
      if (running.length) await Promise.race(timer ? [...running, timer] : running);
      else if (timer) await timer;
    }
    const result = await batchStatus(root, id);
    const error = state.items.some(i => i.error);
    state.status = result.summary.reusable === result.summary.total ? 'complete'
      : result.items.some(i => ['submit_unknown','query_unknown'].includes(i.job?.status ?? '')) || error || halt ? 'needs_attention'
      : result.summary.failed && result.summary.pending === 0 && result.summary.active === 0 && result.summary.downloads === 0 ? 'partial_failed' : 'paused';
    trace('finished', undefined, undefined, state.status);
    await saveBatchRun(root, state);
    return batchStatus(root, id);
  } finally {
    // Drain already authorized in-flight I/O before relinquishing ownership on a local exception.
    await Promise.allSettled([...creates.values(), ...queries.values(), ...downloads.values()]);
    await videoStage?.release();
    await scheduler.release();
  }
}
