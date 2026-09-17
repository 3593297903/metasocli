import { z } from 'zod';
import { parse, type StorySegment, type Story } from '../contracts/story.js';
import { fail } from '../core/errors.js';
import { projectPath } from '../storage/paths.js';
import { readStable } from '../storage/io.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { renderPrompt } from '../story/text.js';
import { inspectImage, MAX_IMAGE_BYTES } from '../assets/image.js';
import { publicHttps } from './transport.js';

export const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const Content = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).refine(s => [...s].length <= 7000 && s.trim().length > 0) }).strict(),
  z.object({ type: z.literal('image_url'), role: z.enum(['first_frame', 'reference_image']), image_url: z.object({ url: z.string().min(1) }).strict() }).strict(),
]);
export const RequestSchema = z.object({
  model: z.literal('MiniMax-H3'), content: z.array(Content).min(1).max(10),
  resolution: z.enum(['768P', '2K']), duration: z.number().int().min(4).max(15),
  ratio: z.enum(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
  context_ir_enabled: z.boolean(), aigc_watermark: z.boolean(),
}).strict();
export type H3Request = z.infer<typeof RequestSchema>;
export function validateRequest(value: unknown): H3Request {
  const request = parse(RequestSchema, value);
  const texts = request.content.filter(i => i.type === 'text');
  const images = request.content.filter(i => i.type === 'image_url');
  if (texts.length !== 1 || request.content[0]?.type !== 'text') fail('H3_CONTENT', 'One text item must precede the ordered image inputs.');
  const first = images.filter(i => i.role === 'first_frame');
  if (first.length && (first.length !== 1 || images.length !== 1 || request.ratio !== 'adaptive')) fail('H3_MODE', 'A single first frame requires adaptive ratio and cannot mix with references.');
  if (!images.length && request.ratio === 'adaptive') fail('H3_RATIO', 'Text-to-video requires an explicit aspect ratio.');
  for (const image of images) {
    const url = image.image_url.url;
    if (url.startsWith('data:')) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(url);
      if (!match) fail('H3_IMAGE', 'Image data URL is malformed.');
      const bytes = Buffer.from(match[2]!, 'base64');
      if (bytes.toString('base64') !== match[2] || inspectImage(bytes).mime !== match[1]) fail('H3_IMAGE', 'Image data URL content does not match its MIME.');
    } else publicHttps(url);
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_REQUEST_BYTES) fail('REQUEST_LIMIT', 'Encoded H3 request exceeds 64 MiB; use verified public URLs or smaller images.');
  return request;
}
export async function buildRequest(root: string, story: Story, segment: StorySegment) {
  const rendered = renderPrompt(segment);
  const content: H3Request['content'] = [{ type: 'text', text: rendered.text }];
  const assets = [];
  for (const ref of segment.references) {
    const asset = story.assets.find(a => a.recipe.assetId === ref.assetId);
    if (!asset?.media) fail('MISSING_ASSET', `Missing image ${ref.assetId}; register an existing or host-generated image to resume.`);
    if ((asset.recipe.kind === 'first_frame') !== (ref.role === 'first_frame')) fail('ASSET_ROLE', `Image ${ref.assetId} has a conflicting first-frame role.`);
    const media = asset.media;
    const bytes = await readStable(await projectPath(root, media.path), MAX_IMAGE_BYTES);
    const image = inspectImage(bytes);
    if (sha256Hex(bytes) !== media.sha256 || bytes.length !== media.bytes || image.mime !== media.mime || image.width !== media.width || image.height !== media.height) fail('ASSET_CHANGED', `Image ${ref.assetId} changed after registration.`);
    const url = media.transport === 'url' ? publicHttps(media.url!) : `data:${media.mime};base64,${bytes.toString('base64')}`;
    content.push({ type: 'image_url', role: ref.role, image_url: { url } });
    assets.push({ assetId: ref.assetId, role: ref.role, sha256: media.sha256, recipeHash: asset.recipeHash, transport: media.transport });
  }
  const firstFrame = segment.references.some(r => r.role === 'first_frame');
  const request = validateRequest({ model: 'MiniMax-H3', content, resolution: segment.parameters.resolution, duration: segment.duration,
    ratio: firstFrame ? 'adaptive' : segment.parameters.ratio, context_ir_enabled: segment.parameters.contextIr, aigc_watermark: segment.parameters.watermark });
  const requestHash = canonicalSha256(request);
  return { request, summary: {
    segmentId: segment.id, sourcePromptHash: segment.promptHash, renderedPrompt: rendered.text, renderedPromptHash: rendered.hash,
    requestHash, inputHash: canonicalSha256({ requestHash, sourcePromptHash: segment.promptHash, assets }), requestBytes: Buffer.byteLength(JSON.stringify(request)),
    mode: firstFrame ? 'first-frame' as const : assets.length ? 'references' as const : 'text' as const,
    requestedRatio: segment.parameters.ratio, model: request.model, resolution: request.resolution, duration: request.duration,
    effectiveRatio: request.ratio, contextIr: request.context_ir_enabled, watermark: request.aigc_watermark, assets,
  } };
}
