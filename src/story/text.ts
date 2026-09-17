import { fail } from '../core/errors.js';
import { sha256Hex } from '../storage/canonical.js';
import type { StorySegment } from '../contracts/story.js';

/** Only BOM and newline normalization; spaces and terminal newlines are significant. */
export function normalizeText(input: Uint8Array | string): string {
  let text: string;
  try { text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
  catch { return fail('INVALID_UTF8', 'Source must be valid UTF-8.'); }
  return (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n?/gu, '\n');
}
export function validateCoverage(text: string, segments: readonly { id: string; start: number; end: number }[]): void {
  let cursor = 0;
  const seen = new Set<string>();
  for (const s of segments) {
    if (seen.has(s.id) || s.start !== cursor || s.end <= s.start || s.end > text.length) {
      fail('SOURCE_COVERAGE', `Segment ${s.id} duplicates, omits, overlaps or reorders source text.`);
    }
    // Never split a UTF-16 surrogate pair at a source boundary.
    if (s.end < text.length && /[\uDC00-\uDFFF]/u.test(text[s.end]!)) fail('SOURCE_COVERAGE', `Segment ${s.id} splits a Unicode character.`);
    cursor = s.end; seen.add(s.id);
  }
  if (cursor !== text.length) fail('SOURCE_COVERAGE', 'Segments must cover the complete normalized source in order.');
}
export function renderPrompt(segment: StorySegment): { text: string; hash: string } {
  const template = segment.prompt;
  if (sha256Hex(template) !== segment.promptHash) fail('CONTENT_CHANGED', `Prompt hash mismatch in ${segment.id}.`);
  if (/\{\{\s*Node\b/iu.test(template)) fail('LEGACY_REFERENCE', `Segment ${segment.id} contains a LibTV node reference.`);
  const bindings = new Map(segment.references.map((r, i) => [r.assetId, r.role === 'first_frame' ? '首帧图片' : `参考图${i + 1}`]));
  const text = template.replace(/\{\{ref:([^{}]+)\}\}/gu, (_all, id: string) => {
    const label = bindings.get(id);
    if (!label) fail('UNKNOWN_REFERENCE', `Segment ${segment.id} contains an unbound reference.`);
    return label;
  });
  if (/\{\{ref:/u.test(text)) fail('UNKNOWN_REFERENCE', `Segment ${segment.id} has an incomplete reference marker.`);
  // Natural ordinal labels refer to the explicit content array order; no provider token is invented.
  if ([...text].length > 7000 || text.trim().length === 0) fail('PROMPT_LIMIT', `Segment ${segment.id} must have 1–7000 H3 prompt characters; source was not truncated.`);
  return { text, hash: sha256Hex(text) };
}
