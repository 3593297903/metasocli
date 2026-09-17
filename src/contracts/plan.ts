import { z } from 'zod';
import { Hash, Id, Parameters, Reference } from './story.js';
export const PlanSegment = z.object({
  segmentId: Id, sourcePromptHash: Hash, renderedPrompt: z.string(), renderedPromptHash: Hash,
  requestHash: Hash, inputHash: Hash, requestBytes: z.number().int().positive(),
  mode: z.enum(['text', 'first-frame', 'references']), requestedRatio: Parameters.shape.ratio,
  model: z.literal('MiniMax-H3'), resolution: Parameters.shape.resolution, duration: z.number().int().min(4).max(15),
  effectiveRatio: Parameters.shape.ratio, contextIr: z.boolean(), watermark: z.boolean(),
  assets: z.array(z.object({ assetId: Id, role: Reference.shape.role, sha256: Hash, recipeHash: Hash, transport: z.enum(['data', 'url']) }).strict()).max(9),
}).strict();
export const Plan = z.object({
  schemaVersion: z.literal(1), planId: z.uuid(), planHash: Hash, projectId: z.uuid(),
  episodeId: Id, revision: z.number().int().nonnegative(), manifestHash: Hash, createdAt: z.iso.datetime(),
  segments: z.array(PlanSegment).min(1),
}).strict();
export type GenerationPlan = z.infer<typeof Plan>;
