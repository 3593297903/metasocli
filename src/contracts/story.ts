import { z } from 'zod';
import { fail } from '../core/errors.js';
import { targetMatchesDuration } from '../story/duration.js';

export const Id = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/u)
  .refine(s => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(s));
export const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const RelativePath = z.string().min(1).max(1024);
export const Reference = z.object({ assetId: Id, role: z.enum(['reference_image', 'first_frame']) }).strict();
export const Narration = z.object({
  assetId: Id,
  // UTF-16 ranges in the unmodified segment prompt; selected by semantic review, not keyword matching.
  cues: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()).min(1).max(100),
}).strict();
export const Parameters = z.object({
  model: z.literal('MiniMax-H3').default('MiniMax-H3'),
  resolution: z.enum(['768P', '2K']).default('768P'),
  ratio: z.enum(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']).default('9:16'),
  contextIr: z.boolean().default(false),
  watermark: z.boolean().default(false),
}).strict();
export const ExecutableDuration = z.number().int().min(4).max(15);
export const TargetDurationSeconds = z.number().finite().positive().max(15);
export const Recipe = z.object({
  assetId: Id, kind: z.enum(['character', 'scene', 'prop', 'first_frame', 'narration']),
  prompt: z.string().min(1).max(32000),
  exactText: z.array(z.string()).default([]), dependencies: z.array(Id).default([]),
}).strict();
const MediaIdentity = z.object({
  path: RelativePath, sha256: Hash, bytes: z.number().int().positive(),
  provenance: z.enum(['user', 'imagegen']),
  transport: z.enum(['data', 'url']), url: z.string().optional(),
}).strict();
const Media = z.union([
  MediaIdentity.extend({ mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  MediaIdentity.extend({ mime: z.enum(['audio/mpeg', 'audio/wav']), duration: z.number().min(2).max(15), sampleRate: z.number().int().positive(), channels: z.number().int().min(1).max(2) }).strict(),
]);
export const Asset = z.object({ recipe: Recipe, recipeHash: Hash, media: Media.nullable() }).strict();
export const Segment = z.object({
  id: Id, start: z.number().int().nonnegative(), end: z.number().int().positive(),
  duration: ExecutableDuration, targetDurationSeconds: TargetDurationSeconds.optional(), prompt: z.string().min(1), promptHash: Hash,
  references: z.array(Reference).max(9), parameters: Parameters,
  narration: Narration.nullable().optional(),
}).strict().superRefine((segment, context) => {
  if (segment.targetDurationSeconds !== undefined && !targetMatchesDuration(segment.duration, segment.targetDurationSeconds)) {
    context.addIssue({ code: 'custom', path: ['targetDurationSeconds'], message: 'targetDurationSeconds must be rounded up exactly into duration.' });
  }
});
export const Episode = z.object({
  id: Id, kind: z.enum(['script', 'video-prompts']),
  source: z.object({ origin: z.string(), rawPath: RelativePath, rawHash: Hash, textPath: RelativePath, textHash: Hash }).strict(),
  segments: z.array(Segment).min(1).max(1000),
}).strict();
export const Manifest = z.object({
  schemaVersion: z.literal(1), owner: z.literal('metasocli'), projectId: z.uuid(),
  name: z.string().min(1).max(500), revision: z.number().int().nonnegative(),
  episodes: z.array(Episode).max(1000), assets: z.array(Asset).max(2000),
}).strict();
export const ImportDraft = z.object({
  episodeId: Id, kind: z.enum(['script', 'video-prompts']), source: z.string().min(1),
  segments: z.array(z.object({
    id: Id, start: z.number().int().nonnegative(), end: z.number().int().positive(),
    duration: TargetDurationSeconds, prompt: z.string().min(1).optional(),
    references: z.array(Reference).max(9).default([]), parameters: Parameters.default(() => Parameters.parse({})),
    narration: Narration.nullable().optional(),
  }).strict()).min(1).max(1000),
  recipes: z.array(Recipe).max(2000).default([]),
}).strict();
export type Story = z.infer<typeof Manifest>;
export type StorySegment = z.infer<typeof Segment>;
export type StoryAsset = z.infer<typeof Asset>;
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Paths are enough to locate the issue without echoing prompts, URLs or secrets.
    const paths = result.error.issues.map(i => i.path.join('.') || '(root)').join(', ');
    fail('INVALID_INPUT', `Contract validation failed at ${paths}`);
  }
  return result.data;
}
