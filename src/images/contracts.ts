import { z } from 'zod';
import { Hash, Id, RelativePath } from '../contracts/story.js';

export const IMAGE_ORIGIN = 'https://api.yiciyuang.com';
export const Size = z.enum(['1024x1024', '1536x1024', '1024x1536', '1920x1088', '1088x1920', '2048x2048', '2560x1707', '1707x2560', '4096x4096']);
export const ImageProfile = z.object({
  backend: z.literal('api').default('api'), provider: z.literal('yiciyuang').default('yiciyuang'),
  origin: z.literal(IMAGE_ORIGIN).default(IMAGE_ORIGIN), model: z.literal('gpt-image-2.5').default('gpt-image-2.5'),
  quality: z.enum(['auto','low','medium','high']).default('medium'), n: z.literal(1).default(1),
  response_format: z.enum(['url','b64_json']).default('url'), submissionMode: z.literal('all-ready').default('all-ready'),
  boardSize: Size.default('1920x1088'), firstFrameSize: Size.default('1088x1920'), sizes: z.record(Id, Size).default({}),
  providerLimits: z.object({ concurrent: z.number().int().positive().optional(), rpm: z.number().int().positive().optional(),
    batch: z.number().int().positive().optional(), source: z.string().min(1).max(2000), checkedAt: z.iso.datetime() }).strict().optional(),
  downloadConcurrency: z.number().int().min(1).max(16).default(2), decodeConcurrency: z.number().int().min(1).max(8).default(2),
  registrationConcurrency: z.literal(1).default(1), generationTimeoutMs: z.number().int().min(1000).max(3600000).default(600000),
  automaticPostRetries: z.literal(0).default(0), quotaGroup: Id.default('yiciyuang-default'),
  maxResponseBytes: z.number().int().min(1024).max(45*1024*1024).default(45*1024*1024),
  maxImageBytes: z.number().int().min(1024).max(30*1024*1024).default(30*1024*1024),
  maxTempBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(32*1024**3),
}).strict();
export type Profile = z.infer<typeof ImageProfile>;
export const Binding = z.object({ episodeId: Id, segmentId: Id, hash: Hash }).strict();
export const ImageItem = z.object({
  assetId: Id, kind: z.enum(['character','scene','prop','first_frame']), recipeHash: Hash, promptHash: Hash,
  promptPath: RelativePath, dependencies: z.array(Id), dependencySources: z.array(z.object({ assetId: Id, hash: Hash.nullable(), producer: Hash.nullable() }).strict()),
  targetHash: Hash.nullable(), size: Size, fingerprint: Hash, requiredBy: z.array(Binding),
  action: z.enum(['generate','reuse','recover','blocked']), operationId: z.uuid().optional(), reason: z.string().optional(),
}).strict();
export const ImagePlan = z.object({ schemaVersion: z.literal(1), planId: z.uuid(), projectId: z.uuid(), planHash: Hash,
  createdAt: z.iso.datetime(), revisionAtCreation: z.number().int(), profile: ImageProfile, scope: z.array(Binding), items: z.array(ImageItem).max(2000) }).strict();
export type ImagePlanRecord = z.infer<typeof ImagePlan>;
export type ImagePlanItem = z.infer<typeof ImageItem>;
export const ImageInput = z.object({ provider: z.literal('yiciyuang'), origin: z.literal(IMAGE_ORIGIN),
  route: z.enum(['/v1/images/generations','/v1/images/edits']), model: z.literal('gpt-image-2.5'), quality: ImageProfile.shape.quality,
  size: Size, n: z.literal(1), response_format: ImageProfile.shape.response_format, promptPath: RelativePath, promptHash: Hash,
  references: z.array(z.object({ assetId: Id, sha256: Hash, path: RelativePath, mime: z.enum(['image/png','image/jpeg','image/webp']) }).strict()),
}).strict();
export type EffectiveInput = z.infer<typeof ImageInput>;
export const ImageStatus = z.enum(['prepared','waiting_dependency','submitting','response_saved','received','downloaded','registered','reused','blocked','rejected','failed','submit_unknown','superseded']);
export const ImageJob = z.object({ schemaVersion: z.literal(1), operationId: z.uuid(), projectId: z.uuid(), planId: z.uuid(), planHash: Hash,
  assetId: Id, fingerprint: Hash, attempt: z.number().int().positive(), retryOf: z.uuid().optional(), status: ImageStatus,
  preparedAt: z.iso.datetime(), requestStartedAt: z.iso.datetime().optional(), responseHeadersAt: z.iso.datetime().optional(),
  responseSavedAt: z.iso.datetime().optional(), receiptSavedAt: z.iso.datetime().optional(), downloadCompletedAt: z.iso.datetime().optional(), registeredAt: z.iso.datetime().optional(),
  requestHash: Hash.optional(), inputHash: Hash.optional(), input: ImageInput.optional(),
  result: z.object({ path: RelativePath, sha256: Hash, bytes: z.number().int().positive(), width: z.number().int(), height: z.number().int(), mime: z.string() }).strict().optional(),
  recoveredManually: z.boolean().optional(), resolutionPath: RelativePath.optional(), error: z.object({code:z.string(),message:z.string()}).strict().optional(),
}).strict();
export type ImageJobRecord = z.infer<typeof ImageJob>;
export const BodyReceipt = z.object({ schemaVersion:z.literal(1), operationId:z.uuid(), requestHash:Hash, path:RelativePath, sha256:Hash,
  bytes:z.number().int().nonnegative(), httpStatus:z.number().int(), headers:z.record(z.string(),z.string()), responseHeadersAt:z.iso.datetime(), responseSavedAt:z.iso.datetime(), hash:Hash }).strict();
export const ImageReceipt = z.object({ operationId:z.uuid(), requestHash:Hash, bodyHash:Hash, receiptSavedAt:z.iso.datetime(),
  url:z.string().optional(), result:ImageJob.shape.result.optional(), requestedModel:z.literal('gpt-image-2.5'), reportedModel:z.string().optional(),
  revisedPromptPath:RelativePath.optional(), usage:z.unknown().optional(), recoveredManually:z.boolean().optional() }).strict();
export const ImageRun = z.object({ schemaVersion:z.literal(1), planId:z.uuid(), planHash:Hash, hash:Hash,
  authorization:z.object({planHash:Hash,provider:z.literal('yiciyuang'),quotaGroup:Id,maxRequests:z.number().int(),authorizedAt:z.iso.datetime()}).strict(),
  items:z.array(z.object({assetId:Id,operationId:z.uuid().optional(),retryOf:z.uuid().optional()}).strict()),
  unlocks:z.array(z.object({at:z.iso.datetime(),dependency:Id,assets:z.array(Id)}).strict()),
  status:z.enum(['running','complete','needs_attention']),updatedAt:z.iso.datetime(),
}).strict();
export type ImageRunRecord = z.infer<typeof ImageRun>;
export const resolvedImage = (status:string) => ['registered','reused','rejected','failed','superseded','blocked'].includes(status);
