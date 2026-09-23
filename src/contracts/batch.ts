import { z } from 'zod';
import { Hash, Id } from './story.js';
export const Selection = z.object({ schemaVersion: z.literal(1), episodes: z.array(z.object({
  episodeId: Id, segmentIds: z.array(Id).min(1),
}).strict()).min(1) }).strict();
export const BatchItem = z.object({ order: z.number().int().nonnegative(), projectId: z.uuid(), episodeId: Id, segmentId: Id,
  planId: z.uuid(), planHash: Hash, requestHash: Hash, inputHash: Hash }).strict();
export const BatchPlan = z.object({ schemaVersion: z.literal(1), batchId: z.uuid(), batchHash: Hash, projectId: z.uuid(), createdAt: z.iso.datetime(),
  concurrency: z.number().int().min(1).max(4), downloadConcurrency: z.literal(2),
  retryPolicy: z.object({ max429RetriesPerItem: z.literal(2), totalWaitBudgetMs: z.literal(60000) }).strict(),
  items: z.array(BatchItem).min(1),
}).strict();
export const BatchRun = z.object({ schemaVersion: z.literal(1), batchId: z.uuid(), batchHash: Hash, hash: Hash,
  authorization: z.object({ batchHash: Hash, authorizedAt: z.iso.datetime() }).strict(),
  status: z.enum(['running','paused','needs_attention','partial_failed','complete']), updatedAt: z.iso.datetime(),
  items: z.array(z.object({ order: z.number().int().nonnegative(), operationId: z.uuid().optional(),
    retryOf: z.uuid().optional(), retryHistory: z.array(z.uuid()), error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  }).strict()),
  rateLimit: z.object({ spentWaitMs: z.number().int().min(0).max(60000), notBefore: z.number().nonnegative() }).strict(),
  trace: z.array(z.object({ at: z.iso.datetime(), event: z.string(), order: z.number().int().optional(), operationId: z.uuid().optional(),
    occupied: z.number().int().nonnegative().optional(), detail: z.string().optional() }).strict()),
}).strict();
export type VideoBatchPlan = z.infer<typeof BatchPlan>;
export type VideoBatchRun = z.infer<typeof BatchRun>;
