import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Id, parse } from '../contracts/story.js';
import { IrReceipt, type ContextIrOperation } from '../contracts/context-ir.js';
import { loadPlan, validatePlan } from '../core/planning.js';
import { fail, MetasoError, publicError } from '../core/errors.js';
import { withProjectLock } from '../storage/locking.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { buildIrRequest, irInputHash } from '../metaso/context-ir.js';
import { ProviderError, TaskId, type ContextIrClient, type IrObservation, type Submission } from '../metaso/client.js';
import type { Fetch } from '../metaso/transport.js';
import { irPersistence, listIrOperations, readIrOperation, readIrPrompt, saveIrEvidence, type IrPersistence } from './context-ir-store.js';
import { assertTaskIdAvailable, checkSubmissionConflicts, operationKind, verifyRemoteAssets } from './submission-guard.js';

export interface IrDependencies { client: ContextIrClient; fetcher?: Fetch; persistence?: IrPersistence; sleep?: (ms: number) => Promise<void> }
export const IrPollOptions = z.object({ maxPolls: z.number().int().min(1).max(720).default(60), pollIntervalMs: z.number().int().min(0).max(60000).default(5000),
  queryAttempts: z.number().int().min(1).max(5).default(3), retryBudgetMs: z.number().int().min(0).max(60000).default(30000), observeOnly: z.boolean().default(false) }).strict();
type PollOptions = z.infer<typeof IrPollOptions>;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function query(client: ContextIrClient, taskId: string, options: PollOptions, sleep: (ms: number) => Promise<void>): Promise<IrObservation> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await client.queryContextIr(taskId);
      if (result.taskId !== taskId || result.model !== 'MiniMax-H3' || result.taskType !== 'h3_context_ir'
        || (result.status === 'enhanced' && (typeof result.prompt !== 'string' || !result.prompt.trim()))) {
        throw new ProviderError('IR_QUERY_CONTRACT', 'IR query returned incompatible task identity or text.', { evidence: result.evidence });
      }
      return result;
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.options.retryable || attempt + 1 >= options.queryAttempts) throw error;
      const ms = Math.max(error.options.retryAfterMs ?? 0, 250 * 2 ** attempt);
      if (ms > options.retryBudgetMs - waited) throw new ProviderError('QUERY_DEFERRED', 'IR retry delay exceeds this run budget; resume the same task later.', { evidence: error.options.evidence });
      await sleep(ms); waited += ms;
    }
  }
}
export async function submitContextIr(root: string, planId: string, segmentId: string, authorized: boolean, deps: IrDependencies, retryOf?: string): Promise<ContextIrOperation> {
  if (authorized !== true) fail('GENERATION_NOT_AUTHORIZED', 'Independent IR is a paid stage and requires explicit authorization.');
  parse(Id, segmentId);
  if (retryOf) parse(z.uuid(), retryOf);
  const disk = deps.persistence ?? irPersistence;
  return withProjectLock(root, async assertOwned => {
    const plan = await loadPlan(root, planId), segment = plan.segments.find(s => s.segmentId === segmentId);
    if (plan.workflow?.stage !== 'prepare') fail('IR_PREPARE_REQUIRED', 'Use plan --episode <id> --workflow h3-context-ir first.');
    if (!segment) fail('SEGMENT_MISSING', 'Segment does not exist in the preparation plan.');
    const operations = await listIrOperations(root);
    // Matching by base identity excludes random plan IDs and permits equivalent preparation plans.
    const matching = operations.filter(j => j.episodeId === plan.episodeId && j.segmentId === segmentId && j.baseInputHash === segment.inputHash);
    const previous = matching.at(-1);
    if (retryOf) {
      const repeated = operations.find(j => j.retryOf === retryOf);
      if (repeated) {
        if (!matching.includes(repeated)) fail('RETRY_CONFLICT', 'IR retry belongs to different inputs.');
        await operationKind(root, repeated.operationId); return repeated;
      }
      if (!previous || previous.operationId !== retryOf || !['failed', 'cancelled'].includes(previous.status)) fail('RETRY_FORBIDDEN', 'Only the latest definitively failed or cancelled IR attempt can be retried.');
    } else if (previous && previous.status !== 'prepared') {
      await operationKind(root, previous.operationId); return previous;
    }
    await checkSubmissionConflicts(root, plan.episodeId, segmentId);
    const { story, built } = await validatePlan(root, plan);
    const base = built.find(b => b.summary.segmentId === segmentId)!;
    const request = buildIrRequest(base.request), irRequestHash = canonicalSha256(request), inputHash = irInputHash(base.summary.inputHash, irRequestHash);
    await verifyRemoteAssets(story, base.summary.assets, deps.fetcher);
    const now = new Date().toISOString();
    const operation: ContextIrOperation = !retryOf && previous?.status === 'prepared' ? previous : {
      schemaVersion: 1, type: 'h3-context-ir', operationId: randomUUID(), projectId: plan.projectId, planId: plan.planId, planHash: plan.planHash,
      episodeId: plan.episodeId, segmentId, revision: plan.revision, sourcePromptHash: segment.sourcePromptHash, baseInputHash: segment.inputHash,
      irRequestHash, inputHash, attempt: (previous?.attempt ?? 0) + 1, ...(retryOf ? { retryOf } : {}), status: 'prepared', createdAt: now, updatedAt: now,
    };
    if (operation.irRequestHash !== irRequestHash || operation.inputHash !== inputHash) fail('IR_JOB_CONFLICT', 'Prepared IR request identity changed.');
    await disk.operation(root, operation);
    await operationKind(root, operation.operationId);
    operation.status = 'submitting'; operation.submittedAt = new Date().toISOString(); operation.updatedAt = operation.submittedAt;
    await disk.operation(root, operation); await assertOwned();
    let receipt: Submission;
    try {
      receipt = await deps.client.createContextIr(request);
      parse(IrReceipt, { operationId: operation.operationId, irRequestHash, taskId: receipt.taskId, receivedAt: new Date().toISOString(), recoveredManually: false });
    } catch (error) {
      operation.status = error instanceof ProviderError && error.options.rejected ? 'failed' : 'submit_unknown';
      operation.lastError = { code: operation.status === 'failed' ? 'CREATE_REJECTED' : 'SUBMIT_UNKNOWN', message: operation.status === 'failed' ? 'Provider rejected IR creation; another paid attempt needs explicit retry.' : 'IR creation result is unknown; recover the original task ID and do not resubmit.' };
      operation.updatedAt = new Date().toISOString(); await disk.operation(root, operation);
      if (error instanceof ProviderError && error.options.evidence) { await saveIrEvidence(root, operation, error.options.evidence); await disk.operation(root, operation); }
      return operation;
    }
    try {
      await assertTaskIdAvailable(root, receipt.taskId, operation.operationId);
      await disk.receipt(root, { operationId: operation.operationId, irRequestHash, taskId: receipt.taskId, receivedAt: new Date().toISOString(), recoveredManually: false });
      operation.taskId = receipt.taskId; operation.status = 'queued'; operation.updatedAt = new Date().toISOString();
      await disk.operation(root, operation);
    } catch {
      throw new MetasoError('IR_RECEIPT_PERSISTENCE', `IR receipt save failed. Operation ${operation.operationId}, remote task ${receipt.taskId}. Preserve both IDs; attach-task/resume, never resubmit.`);
    }
    await saveIrEvidence(root, operation, receipt.evidence); await disk.operation(root, operation);
    return operation;
  });
}
/** Restores IR only, using the accepted task ID. Never creates IR or video and never revalidates changed source assets. */
export async function resumeContextIr(root: string, operationId: string, deps: IrDependencies, input: Partial<PollOptions> = {}): Promise<ContextIrOperation> {
  const options = parse(IrPollOptions, input), disk = deps.persistence ?? irPersistence, sleep = deps.sleep ?? delay;
  return withProjectLock(root, async assertOwned => {
    await operationKind(root, operationId);
    const operation = await readIrOperation(root, operationId);
    if (!operation.taskId) fail(operation.status === 'prepared' ? 'NOT_SUBMITTED' : 'SUBMIT_UNKNOWN', 'No confirmed IR task ID; attach the original ID before recovery.');
    if (operation.status === 'enhanced') { await readIrPrompt(root, operation); return operation; }
    if (['failed', 'cancelled'].includes(operation.status)) return operation;
    for (let poll = 0; poll < options.maxPolls; poll++) {
      await assertOwned();
      let observed: IrObservation;
      try { observed = await query(deps.client, operation.taskId, options, sleep); }
      catch (error) {
        if (error instanceof ProviderError && error.options.evidence) await saveIrEvidence(root, operation, error.options.evidence);
        if (error instanceof ProviderError && error.code === 'IR_QUERY_CONTRACT') operation.status = 'query_unknown';
        operation.lastError = error instanceof MetasoError ? publicError(error) : { code: 'QUERY_FAILED', message: 'IR query failed; resume the original task.' };
        operation.updatedAt = new Date().toISOString(); await disk.operation(root, operation); return operation;
      }
      await saveIrEvidence(root, operation, observed.evidence);
      operation.rawStatus = observed.rawStatus; delete operation.lastError; operation.updatedAt = new Date().toISOString();
      if (observed.status === 'enhanced') {
        // The prompt and result receipt are durable before enhanced is persisted.
        await disk.result(root, operation, observed.prompt!);
        operation.status = 'enhanced'; await disk.operation(root, operation); return operation;
      }
      operation.status = observed.status === 'unknown' ? 'query_unknown' : observed.status;
      if (operation.status === 'query_unknown') operation.lastError = { code: 'IR_QUERY_UNKNOWN', message: 'Unrecognized IR state; preserve evidence and query again later.' };
      await disk.operation(root, operation);
      if (['failed', 'cancelled', 'query_unknown'].includes(operation.status) || options.observeOnly) return operation;
      if (poll + 1 < options.maxPolls) await sleep(options.pollIntervalMs);
    }
    operation.lastError = { code: 'POLL_LIMIT', message: 'IR polling budget ended; resume the same operation.' };
    await disk.operation(root, operation); return operation;
  });
}
export async function attachContextIrTask(root: string, operationId: string, taskId: string, confirmed: boolean, deps: IrDependencies): Promise<ContextIrOperation> {
  if (!confirmed) fail('TASK_LINK_REQUIRED', 'Confirm that this remote IR task belongs to the saved request.');
  parse(TaskId, taskId);
  return withProjectLock(root, async () => {
    await operationKind(root, operationId);
    const disk = deps.persistence ?? irPersistence, operation = await readIrOperation(root, operationId);
    if (operation.taskId || operation.status !== 'submit_unknown') fail('TASK_LINK_CONFLICT', 'Only an unresolved IR creation may acquire its recovered ID.');
    await assertTaskIdAvailable(root, taskId, operationId);
    const observed = await query(deps.client, taskId, IrPollOptions.parse({}), deps.sleep ?? delay);
    await disk.receipt(root, { operationId, taskId, irRequestHash: operation.irRequestHash, receivedAt: new Date().toISOString(), recoveredManually: true });
    operation.taskId = taskId; operation.status = 'queued'; delete operation.lastError; operation.updatedAt = new Date().toISOString();
    await disk.operation(root, operation); await saveIrEvidence(root, operation, observed.evidence); await disk.operation(root, operation);
    return operation;
  });
}
