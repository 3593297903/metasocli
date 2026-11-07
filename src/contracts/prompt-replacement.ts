import { z } from 'zod';
import { Episode, Hash, Id, Narration } from './story.js';

export const PromptReplacementInput = z.object({
  episodeId: Id, segmentId: Id, file: z.string().min(1),
  expectedSha256: Hash.optional(), expectedPromptHash: Hash.optional(),
  narrationCues: z.string().min(1).optional(),
}).strict();
export const PromptNarrationCues = z.object({
  schemaVersion: z.literal(1), promptHash: Hash,
  cues: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1) }).strict()).min(1).max(100),
}).strict();
const NarrationMode = z.enum(['none', 'kept', 'relocated', 'explicit']);
const Revision = z.number().int().nonnegative();
export const PromptReplacementChange = z.object({
  schemaVersion: z.literal(1), kind: z.literal('prepared-prompt-replacement'),
  projectId: z.uuid(), episodeId: Id, segmentId: Id,
  previousRevision: Revision, revision: Revision,
  previousEpisodeHash: Hash, episodeHash: Hash,
  previousPromptHash: Hash, promptHash: Hash,
  input: z.object({ path: z.string(), sha256: Hash }).strict(),
  previousSource: Episode.shape.source, source: Episode.shape.source,
  previousNarration: Narration.nullable().optional(), narration: Narration.nullable().optional(),
  narrationMode: NarrationMode,
}).strict();
export const PromptReplacementReceipt = z.object({
  schemaVersion: z.literal(1), state: z.enum(['replaced', 'unchanged']), changed: z.boolean(),
  projectId: z.uuid(), episodeId: Id, segmentId: Id,
  previousPromptHash: Hash, promptHash: Hash, inputSha256: Hash,
  previousRevision: Revision, revision: Revision,
  previousSource: Episode.shape.source, source: Episode.shape.source,
  narrationMode: NarrationMode, cueCount: z.number().int().nonnegative(),
  changeRecordPath: z.string().optional(),
  timingsMs: z.object({ read: z.number().nonnegative(), lock: z.number().nonnegative(), validate: z.number().nonnegative(), save: z.number().nonnegative(), total: z.number().nonnegative() }).strict(),
}).strict();
export type PromptReplacementOptions = z.infer<typeof PromptReplacementInput>;
export type PromptReplacementResult = z.infer<typeof PromptReplacementReceipt>;
