import { z } from 'zod';
import { Hash, Id } from './story.js';

/** Immutable, one-new-attempt authorization. Progress is derived from job/receipt/ledger evidence. */
export const VideoRetry = z.object({
  schemaVersion: z.literal(1), hash: Hash, projectId: z.uuid(), runtimeRoot: z.string().min(1),
  oldOperationId: z.uuid(), newOperationId: z.uuid(), planId: z.uuid(), planHash: Hash,
  episodeId: Id, segmentId: Id, requestHash: Hash, inputHash: Hash,
  authorizedAt: z.iso.datetime(), maxNewAttempts: z.literal(1), acceptUnknownResult: z.literal(true),
  attempt: z.number().int().min(2),
}).strict();
export type VideoRetryAuthorization = z.infer<typeof VideoRetry>;
