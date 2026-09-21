import { z } from 'zod';
import { Hash, Id } from './story.js';
import { TaskId } from './task.js';

const FileIdentity = z.object({ path: z.string(), sha256: Hash, bytes: z.number().int().positive() }).strict();
export const IrReview = z.object({
  schemaVersion: z.literal(1), preparePlanId: z.uuid(), preparePlanHash: Hash, segmentId: Id,
  sourcePromptHash: Hash, irOperationId: z.uuid(), irTaskId: TaskId, promptHash: Hash,
  verdict: z.enum(['approved', 'needs_review']), reviewer: z.string().trim().min(1).max(200), reviewedAt: z.iso.datetime(),
  // Concrete explanations from the host Skill, not boolean claims of semantic proof.
  findings: z.object({ dialogue: z.string().trim().min(1).max(8000), references: z.string().trim().min(1).max(8000),
    narration: z.string().trim().min(1).max(8000), constraints: z.string().trim().min(1).max(8000) }).strict(),
  dialogueQuotes: z.array(z.string().min(1).max(7000)).max(1000),
}).strict();
const ReviewIdentity = z.object({ path: z.string(), hash: Hash, verdict: IrReview.shape.verdict }).strict();
const DerivedIdentity = z.object({ planId: z.uuid(), createdAt: z.iso.datetime(), reviewPath: z.string(), reviewHash: Hash, planHash: Hash.optional() }).strict();
export const IrOperation = z.object({
  schemaVersion: z.literal(1), type: z.literal('h3-context-ir'), operationId: z.uuid(), projectId: z.uuid(),
  planId: z.uuid(), planHash: Hash, episodeId: Id, segmentId: Id, revision: z.number().int().nonnegative(),
  sourcePromptHash: Hash, baseInputHash: Hash, irRequestHash: Hash, inputHash: Hash,
  attempt: z.number().int().positive(), retryOf: z.uuid().optional(),
  status: z.enum(['prepared', 'submitting', 'submit_unknown', 'queued', 'running', 'query_unknown', 'enhanced', 'failed', 'cancelled']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), submittedAt: z.iso.datetime().optional(), taskId: TaskId.optional(),
  rawStatus: z.string().optional(), evidencePath: z.string().optional(),
  lastError: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  result: FileIdentity.optional(),
  // The original preparation retains these fields for compatibility with saved IR plans.
  review: ReviewIdentity.optional(),
  derived: DerivedIdentity.optional(),
  // Reusing the same paid result under another preparation must not rewrite its origin or prior derivations.
  planBindings: z.array(z.object({ preparePlanId: z.uuid(), preparePlanHash: Hash,
    review: ReviewIdentity.optional(), derived: DerivedIdentity.optional() }).strict()).optional(),
}).strict();
export const IrReceipt = z.object({ operationId: z.uuid(), irRequestHash: Hash, taskId: TaskId,
  receivedAt: z.iso.datetime(), recoveredManually: z.boolean() }).strict();
export const IrResultReceipt = z.object({ operationId: z.uuid(), irRequestHash: Hash, taskId: TaskId, result: FileIdentity }).strict();
export type ContextIrOperation = z.infer<typeof IrOperation>;
export type ContextIrReview = z.infer<typeof IrReview>;
