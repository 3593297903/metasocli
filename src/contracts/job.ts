import { z } from 'zod';
import { Hash, Id } from './story.js';
import { TaskId } from '../metaso/client.js';
export const Output = z.object({
  path: z.string(), sha256: Hash, bytes: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(), duration: z.number().positive(),
}).strict();
export const JobSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.uuid(), projectId: z.uuid(), planId: z.uuid(), planHash: Hash,
  episodeId: Id, segmentId: Id, revision: z.number().int().nonnegative(), requestHash: Hash, inputHash: Hash,
  attempt: z.number().int().positive(), retryOf: z.uuid().optional(),
  status: z.enum(['prepared', 'submitting', 'submit_unknown', 'queued', 'running', 'query_unknown', 'generated', 'downloaded', 'failed', 'cancelled']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), submittedAt: z.iso.datetime().optional(), taskId: TaskId.optional(),
  rawStatus: z.string().optional(), evidencePath: z.string().optional(),
  lastError: z.object({ code: z.string(), message: z.string() }).strict().optional(), output: Output.optional(),
}).strict();
export const Receipt = z.object({ operationId: z.uuid(), requestHash: Hash, taskId: TaskId, receivedAt: z.iso.datetime(), recoveredManually: z.boolean().default(false) }).strict();
export type Job = z.infer<typeof JobSchema>;
export type SavedOutput = z.infer<typeof Output>;
