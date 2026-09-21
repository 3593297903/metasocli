import type { StorySegment } from '../contracts/story.js';
import { fail } from '../core/errors.js';

type Selection = Pick<StorySegment, 'prompt' | 'references' | 'narration'>;
export function validateNarration(segment: Selection): void {
  if (!segment.narration) return;
  if (segment.references.some(r => r.role === 'first_frame')) fail('H3_MODE', 'Narration audio cannot be mixed with a first frame. Keep the input roles explicit; do not silently convert them.');
  let end = 0;
  for (const cue of segment.narration.cues) {
    if (cue.start < end || cue.end <= cue.start || cue.end > segment.prompt.length
      || /[\uDC00-\uDFFF]/u.test(segment.prompt[cue.start] ?? '') || /[\uDC00-\uDFFF]/u.test(segment.prompt[cue.end] ?? '')
      || !segment.prompt.slice(cue.start, cue.end).trim()) fail('NARRATION_CUE', 'Narration cues must be nonempty, ordered, non-overlapping UTF-16 ranges in the original segment prompt.');
    end = cue.end;
  }
}

export function narrationDirection(segment: Selection): string {
  validateNarration(segment);
  if (!segment.narration) return '';
  const cues = segment.narration.cues.map(c => `- ${JSON.stringify(segment.prompt.slice(c.start, c.end))}`).join('\n');
  return '\n\n旁白配音参考（技术适配说明，不改写以上原文）\n'
    + '本次输入的参考音频1仅作为画外旁白的音色、咬字、语气、节奏和情绪参考。不得照搬参考音频中的具体台词或剧情，也不是把整条音频铺到整段视频。\n'
    + '仅以下原文片段中的叙述性画外旁白使用该声线，按其所在镜头和时间位置演绎；片段列表只用于标注归属，不重复朗读。原文未指定时间时不虚构时码。\n'
    + cues + '\n'
    + '人物直接对白仍按对应角色的声线和原文口型要求演绎，不得被旁白音频替代；画外旁白不得驱动无口型人物张嘴。纯对白、环境声、音乐和静默部分不使用旁白声线。完整台词、原有顺序及本段时长保持不变。';
}
