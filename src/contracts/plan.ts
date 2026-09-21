import { z } from 'zod';
import { Hash, Id, Parameters, Narration, ExecutableDuration, TargetDurationSeconds } from './story.js';
import { targetMatchesDuration } from '../story/duration.js';
import { TaskId } from './task.js';
export const Workflow = z.discriminatedUnion('stage', [
  z.object({ type: z.literal('h3-inline-ir'), stage: z.literal('inline-video') }).strict(),
  z.object({ type: z.literal('h3-context-ir'), stage: z.literal('prepare') }).strict(),
  z.object({ type: z.literal('h3-context-ir'), stage: z.literal('video'), preparePlanId: z.uuid(), preparePlanHash: Hash,
    segmentId: Id, irOperationId: z.uuid(), irTaskId: TaskId, promptHash: Hash, reviewPath: z.string(), reviewHash: Hash }).strict(),
]);
export const PlanSegment = z.object({
  segmentId: Id, sourcePromptHash: Hash, renderedPrompt: z.string(), renderedPromptHash: Hash,
  requestHash: Hash, inputHash: Hash, requestBytes: z.number().int().positive(),
  mode: z.enum(['text', 'first-frame', 'references']), requestedRatio: Parameters.shape.ratio,
  model: z.literal('MiniMax-H3'), resolution: Parameters.shape.resolution, duration: ExecutableDuration, targetDurationSeconds: TargetDurationSeconds.optional(),
  effectiveRatio: Parameters.shape.ratio, contextIr: z.boolean(), watermark: z.boolean(),
  assets: z.array(z.object({ assetId: Id, role: z.enum(['reference_image', 'first_frame', 'reference_audio']), sha256: Hash, recipeHash: Hash, transport: z.enum(['data', 'url']), duration: z.number().min(2).max(15).optional() }).strict()).max(10),
  narration: Narration.nullable().optional(),
}).strict().superRefine((segment, context) => {
  if (segment.targetDurationSeconds !== undefined && !targetMatchesDuration(segment.duration, segment.targetDurationSeconds)) {
    context.addIssue({ code: 'custom', path: ['targetDurationSeconds'], message: 'targetDurationSeconds must be rounded up exactly into duration.' });
  }
});
export const Plan = z.object({
  schemaVersion: z.literal(1), planId: z.uuid(), planHash: Hash, projectId: z.uuid(),
  episodeId: Id, revision: z.number().int().nonnegative(), manifestHash: Hash, createdAt: z.iso.datetime(),
  segments: z.array(PlanSegment).min(1),
  workflow: Workflow.optional(),
}).strict().superRefine((plan, context) => {
  if (plan.workflow?.stage === 'inline-video' && plan.segments.some(segment => segment.contextIr !== true)) {
    context.addIssue({ code: 'custom', path: ['segments'], message: 'Inline IR video plans must enable contextIr on every segment.' });
  }
});
export type GenerationPlan = z.infer<typeof Plan>;
