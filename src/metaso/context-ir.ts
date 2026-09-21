import { parse, type StorySegment } from '../contracts/story.js';
import type { ContextIrReview } from '../contracts/context-ir.js';
import type { GenerationPlan } from '../contracts/plan.js';
import { fail } from '../core/errors.js';
import { RequestSchema, validateRequest, type H3Request } from './h3.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { z } from 'zod';

export const IrRequestSchema = RequestSchema.pick({ model: true, content: true, duration: true, ratio: true }).strict();
export type IrRequest = z.infer<typeof IrRequestSchema>;
export function validateIrRequest(value: unknown): IrRequest {
  const request = parse(IrRequestSchema, value);
  validateRequest({ ...request, resolution: '768P', context_ir_enabled: false, aigc_watermark: false });
  return request;
}
export function buildIrRequest(base: H3Request): IrRequest {
  if (base.context_ir_enabled) fail('IR_MODE_CONFLICT', 'Independent Context IR requires inline contextIr=false.');
  const { model, content, duration, ratio } = base;
  return validateIrRequest({ model, content, duration, ratio });
}
export function irInputHash(baseInputHash: string, irRequestHash: string): string {
  return canonicalSha256({ workflow: 'h3-context-ir-v1', baseInputHash, irRequestHash });
}
export function validateEnhancedText(text: string, segment: StorySegment, review: ContextIrReview): void {
  if (!text.trim() || [...text].length > 7000) fail('IR_TEXT_LIMIT', 'Enhanced prompt must contain 1–7000 characters; the saved result was not truncated.');
  if (/\{\{|\}\}/u.test(text)) fail('IR_REFERENCE', 'Enhanced text contains an unresolved or legacy reference marker.');
  for (const match of text.matchAll(/(?:参考图|reference\s*image)\s*(\d+)/giu)) {
    const index = Number(match[1]);
    if (index < 1 || index > segment.references.length || segment.references[index - 1]!.role !== 'reference_image') fail('IR_REFERENCE', 'Enhanced text names an image outside the ordered inputs.');
  }
  for (const match of text.matchAll(/(?:参考音频|reference\s*audio)\s*(\d+)/giu)) {
    if (!segment.narration || Number(match[1]) !== 1) fail('IR_REFERENCE', 'Enhanced text names an unbound audio input.');
  }
  if (/首帧图片/u.test(text) && !segment.references.some(r => r.role === 'first_frame')) fail('IR_REFERENCE', 'Enhanced text names an unbound first frame.');
  const quotes = [...review.dialogueQuotes];
  // Recognizable quoted speech is checked even if omitted by the reviewer; unquoted dialogue needs host review.
  for (const match of segment.prompt.matchAll(/“([^”]+)”|「([^」]+)」|"([^"\n]+)"/gu)) quotes.push(match[1] ?? match[2] ?? match[3]!);
  for (const quote of quotes) {
    if (!segment.prompt.includes(quote) || !text.includes(quote)) fail('IR_DIALOGUE', 'A source dialogue quote is absent from the enhanced prompt or does not belong to the source.');
  }
  let cursor = 0;
  for (const quote of review.dialogueQuotes) {
    const index = text.indexOf(quote, cursor);
    if (index < 0) fail('IR_DIALOGUE', 'Reviewed dialogue order changed in the enhanced prompt.');
    cursor = index + quote.length;
  }
  cursor = 0;
  for (const cue of segment.narration?.cues ?? []) {
    const quote = segment.prompt.slice(cue.start, cue.end), index = text.indexOf(quote, cursor);
    if (index < 0) fail('IR_NARRATION', 'An original narration cue is absent or reordered in the enhanced prompt.');
    cursor = index + quote.length;
  }
}
/** Replaces only the request text. Never mutates the story or reruns narrationDirection on new offsets. */
export function deriveRequest(base: { request: H3Request; summary: GenerationPlan['segments'][number] }, text: string) {
  const request = validateRequest({ ...base.request, content: [{ type: 'text', text }, ...base.request.content.slice(1)], context_ir_enabled: false });
  const requestHash = canonicalSha256(request);
  const summary = { ...base.summary, renderedPrompt: text, renderedPromptHash: sha256Hex(text), requestHash,
    inputHash: canonicalSha256({ requestHash, sourcePromptHash: base.summary.sourcePromptHash, assets: base.summary.assets }),
    requestBytes: Buffer.byteLength(JSON.stringify(request)), contextIr: false };
  return { request, summary };
}
