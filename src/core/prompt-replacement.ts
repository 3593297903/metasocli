import { stringify } from 'yaml';
import { Episode, Manifest, parse, type Story, type StorySegment } from '../contracts/story.js';
import { PromptReplacementInput, PromptNarrationCues, PromptReplacementChange, PromptReplacementReceipt, type PromptReplacementOptions } from '../contracts/prompt-replacement.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { atomicWrite, readStable } from '../storage/io.js';
import { exists, projectPath, safePath } from '../storage/paths.js';
import { withProjectWrite } from '../storage/locking.js';
import { normalizeText, renderPrompt, validateCoverage } from '../story/text.js';
import { validateNarration } from '../story/narration.js';
import { fail } from './errors.js';
import { loadStory, saveStory } from './project.js';
import type { z } from 'zod';

type StoryEpisode = z.infer<typeof Episode>;
// Source offsets change when another segment changes length; they are not target content identity.
function fingerprint({ start: _start, end: _end, ...content }: StorySegment) { return canonicalSha256(content); }
function target(story: Story, episodeId: string, segmentId: string) {
  const episode = story.episodes.find(e => e.id === episodeId);
  if (!episode) fail('EPISODE_MISSING', 'The selected episode does not exist.');
  if (episode.kind !== 'video-prompts') fail('PROMPT_REPLACEMENT_KIND', 'Pure replacement supports video-prompts only; use the existing script workflow.');
  const segment = episode.segments.find(s => s.id === segmentId);
  if (!segment) fail('SEGMENT_MISSING', 'The selected segment does not exist.');
  return { episode, segment };
}
async function sourceText(root: string, episode: StoryEpisode) {
  const raw = await readStable(await projectPath(root, episode.source.rawPath));
  const bytes = await readStable(await projectPath(root, episode.source.textPath));
  const text = normalizeText(raw);
  if (sha256Hex(raw) !== episode.source.rawHash || sha256Hex(bytes) !== episode.source.textHash || !Buffer.from(text).equals(bytes)) {
    fail('SOURCE_CHANGED', 'Current source snapshots are damaged or inconsistent; preserve them for recovery.');
  }
  validateEpisode(text, episode);
  return text;
}
function validateEpisode(text: string, episode: StoryEpisode) {
  validateCoverage(text, episode.segments);
  for (const segment of episode.segments) {
    if (segment.prompt !== text.slice(segment.start, segment.end) || segment.promptHash !== sha256Hex(segment.prompt)) {
      fail('SOURCE_CHANGED', 'Current segment text or hash does not match its source span.');
    }
  }
}
function binding(story: Story, segment: StorySegment) {
  const ids = new Set<string>();
  for (const ref of segment.references) {
    const asset = story.assets.find(a => a.recipe.assetId === ref.assetId);
    if (!asset) fail('MISSING_RECIPE', 'The selected segment has an undeclared image binding.');
    if (ids.has(ref.assetId)) fail('DUPLICATE_REFERENCE', 'The selected segment repeats an image binding.');
    ids.add(ref.assetId);
    if (asset.recipe.kind === 'narration' || (asset.recipe.kind === 'first_frame') !== (ref.role === 'first_frame')) {
      fail('ASSET_ROLE', 'The selected image binding has an incompatible role.');
    }
  }
  if (segment.references.some(r => r.role === 'first_frame') && segment.references.length !== 1) fail('H3_MODE', 'First frame requires an exclusive image binding.');
  if (segment.narration && story.assets.find(a => a.recipe.assetId === segment.narration!.assetId)?.recipe.kind !== 'narration') {
    fail('ASSET_ROLE', 'The selected voice binding requires a declared narration asset.');
  }
}
function replaceText(segment: StorySegment, prompt: string, explicit?: z.infer<typeof PromptNarrationCues>) {
  validateNarration(segment);
  let narration = segment.narration;
  let mode: 'none' | 'kept' | 'relocated' | 'explicit' = narration ? 'kept' : 'none';
  if (explicit) {
    if (!narration) fail('NARRATION_REMAP_REQUIRED', 'Explicit cues cannot introduce a new voice binding.');
    if (explicit.promptHash !== sha256Hex(prompt)) fail('NARRATION_REMAP_REQUIRED', 'Explicit cues refer to a different normalized prompt.');
    if (explicit.cues.some(c => prompt.slice(c.start, c.end) !== c.text)) fail('NARRATION_REMAP_REQUIRED', 'Explicit cue text does not match its source range.');
    narration = { ...narration, cues: explicit.cues.map(({ start, end }) => ({ start, end })) };
    mode = 'explicit';
  } else if (narration && prompt !== segment.prompt) {
    let end = 0;
    const cues = narration.cues.map((cue, i) => {
      const text = segment.prompt.slice(cue.start, cue.end), start = prompt.indexOf(text);
      const reason = start < 0 ? 'missing text' : prompt.indexOf(text, start + 1) !== -1 ? 'ambiguous text' : start < end ? 'reordered or overlapping range' : undefined;
      if (reason) fail('NARRATION_REMAP_REQUIRED', `Cue ${i + 1}: ${reason}; supply explicit new cue ranges.`);
      end = start + text.length; return { start, end };
    });
    narration = { ...narration, cues }; mode = 'relocated';
  }
  const next = { ...segment, prompt, promptHash: sha256Hex(prompt), ...(narration === undefined ? {} : { narration }) };
  validateNarration(next);
  return { next, mode };
}
/** One local transaction. No credential, media, runtime ledger or network access. */
export async function replaceSegmentPrompt(root: string, value: PromptReplacementOptions) {
  const began = performance.now(), options = parse(PromptReplacementInput, value);
  root = await safePath(root);
  const raw = await readStable(await safePath(options.file)), inputSha256 = sha256Hex(raw), prompt = normalizeText(raw);
  if (options.expectedSha256 && options.expectedSha256 !== inputSha256) fail('CONTENT_CHANGED', 'Selected input bytes do not match the expected SHA-256.');
  let explicit: z.infer<typeof PromptNarrationCues> | undefined;
  if (options.narrationCues) {
    let json: unknown;
    try { json = JSON.parse(normalizeText(await readStable(await safePath(options.narrationCues)))); }
    catch { return fail('INVALID_INPUT', 'Cannot read the explicit cue JSON.'); }
    explicit = parse(PromptNarrationCues, json);
  }
  const baseline = await loadStory(root), captured = target(baseline, options.episodeId, options.segmentId);
  const { next: desired, mode } = replaceText(captured.segment, prompt, explicit);
  const readDone = performance.now();
  return withProjectWrite(root, async assertOwned => {
    const locked = performance.now(), story = await loadStory(root), current = target(story, options.episodeId, options.segmentId);
    if (story.projectId !== baseline.projectId) fail('PROMPT_REPLACEMENT_STALE', 'Project identity changed during replacement.');
    const text = await sourceText(root, current.episode);
    const unchanged = fingerprint(current.segment) === fingerprint(desired);
    if (!unchanged && (fingerprint(current.segment) !== fingerprint(captured.segment)
      || (options.expectedPromptHash !== undefined && options.expectedPromptHash !== current.segment.promptHash))) {
      fail('PROMPT_REPLACEMENT_STALE', 'The selected segment changed; preserve the current version and select an explicit new baseline.');
    }
    const selected = { ...desired, start: current.segment.start, end: current.segment.start + prompt.length };
    binding(story, selected); renderPrompt(selected); // Rendering is validation only; never save technical directions in the source.
    let next = story, source = current.episode.source, changeRecordPath: string | undefined;
    let writes: { path: string; bytes: Buffer }[] = [];
    if (!unchanged) {
      const newText = text.slice(0, current.segment.start) + prompt + text.slice(current.segment.end);
      const hash = sha256Hex(newText), delta = prompt.length - current.segment.prompt.length;
      source = { origin: `prompt-replacement:${options.episodeId}/${options.segmentId};input-sha256:${inputSha256}`, rawPath: `.metasocli/sources/${hash}.bin`, rawHash: hash, textPath: `.metasocli/sources/${hash}.txt`, textHash: hash };
      const index = current.episode.segments.indexOf(current.segment);
      const episode = { ...current.episode, source, segments: current.episode.segments.map((s, i) => i === index ? selected : i > index ? { ...s, start: s.start + delta, end: s.end + delta } : s) };
      validateEpisode(newText, episode);
      next = { ...story, revision: story.revision + 1, episodes: story.episodes.map(e => e === current.episode ? episode : e) };
      parse(Manifest, next);
      if (Buffer.byteLength(stringify(next)) > 8 * 1024 * 1024) fail('FILE_LIMIT', 'Updated story exceeds the manifest size limit.');
      const inputPath = `.metasocli/prompt-replacements/inputs/${inputSha256}.bin`;
      const record = parse(PromptReplacementChange, { schemaVersion: 1, kind: 'prepared-prompt-replacement', projectId: story.projectId, episodeId: options.episodeId, segmentId: options.segmentId,
        previousRevision: story.revision, revision: next.revision, previousEpisodeHash: canonicalSha256(current.episode), episodeHash: canonicalSha256(episode),
        previousPromptHash: current.segment.promptHash, promptHash: selected.promptHash, input: { path: inputPath, sha256: inputSha256 }, previousSource: current.episode.source, source,
        previousNarration: current.segment.narration, narration: selected.narration, narrationMode: mode });
      changeRecordPath = `.metasocli/prompt-replacements/${canonicalSha256(record)}.json`;
      const candidates = [{ path: inputPath, bytes: raw }, { path: source.rawPath, bytes: Buffer.from(newText) }, { path: source.textPath, bytes: Buffer.from(newText) },
        { path: changeRecordPath, bytes: Buffer.from(JSON.stringify(record, null, 2) + '\n') }];
      // Check every existing content-addressed file before writing any new business file.
      for (const candidate of candidates) {
        const path = await projectPath(root, candidate.path);
        if (await exists(path)) {
          if (!(await readStable(path)).equals(candidate.bytes)) fail('CONTENT_CHANGED', 'A replacement snapshot or change record is damaged; preserve the existing file.');
        } else writes.push({ path, bytes: candidate.bytes });
      }
    }
    const validated = performance.now();
    if (!unchanged) {
      for (const entry of writes) { await assertOwned(); await atomicWrite(entry.path, entry.bytes); }
      await assertOwned();
      await saveStory(root, next); // The manifest is the only commit point. Prepared evidence is not a success receipt.
      if (canonicalSha256(await loadStory(root)) !== canonicalSha256(next)) fail('PROMPT_REPLACEMENT_STALE', 'Saved story differs from the validated replacement.');
    }
    const saved = performance.now();
    return parse(PromptReplacementReceipt, { schemaVersion: 1, state: unchanged ? 'unchanged' : 'replaced', changed: !unchanged,
      projectId: story.projectId, episodeId: options.episodeId, segmentId: options.segmentId,
      previousPromptHash: current.segment.promptHash, promptHash: selected.promptHash, inputSha256,
      previousRevision: story.revision, revision: next.revision, previousSource: current.episode.source, source,
      narrationMode: mode, cueCount: selected.narration?.cues.length ?? 0, ...(changeRecordPath ? { changeRecordPath } : {}),
      timingsMs: { read: readDone - began, lock: locked - readDone, validate: validated - locked, save: saved - validated, total: saved - began } });
  });
}
