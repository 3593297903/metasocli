import { z } from 'zod';
import { Hash, Id } from './story.js';

// Only the bridge identity is checked here. Plans, jobs, media and delivery
// validity remain owned by executeVideo and its existing contracts.
export const VideoRunBridge = z.object({
  exitCode: z.union([z.literal(0), z.literal(2)]),
  data: z.object({
    schemaVersion: z.literal(1), projectId: z.uuid(), batchId: z.uuid(),
    batchHash: Hash, scopeHash: Hash, revision: z.number().int().nonnegative(), manifestHash: Hash,
    state: z.enum(['prepared', 'complete', 'partial', 'delivery_incomplete']),
    segments: z.array(z.object({ order: z.number().int().nonnegative(), episodeId: Id, segmentId: Id })).min(1),
  }),
});
export type VideoRunIdentity = z.infer<typeof VideoRunBridge>['data'];
