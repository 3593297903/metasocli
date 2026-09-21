import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fixture, png } from './helpers.js';
import { wav } from './audio-fixtures.js';
import { importStory } from '../src/core/project.js';
import { registerAsset } from '../src/assets/registry.js';
import { createPlan } from '../src/core/planning.js';
import type { ContextIrOperation, ContextIrReview } from '../src/contracts/context-ir.js';
import type { ContextIrClient, VideoClient } from '../src/metaso/client.js';
import { sha256Hex } from '../src/storage/canonical.js';

export const irEvidence = { sha256: sha256Hex('{}'), response: {} };
export async function irFixture(narrated = false, target = 6.963) {
  const text = `镜头：{{ref:b}} 位于 {{ref:a}} 旁。林舟说：“快走！”${narrated ? '旁白：天亮了。' : ''}\n`;
  const f = await fixture(text), cueStart = text.indexOf('天亮了。');
  const narration = narrated ? { assetId: 'narrator', cues: [{ start: cueStart, end: cueStart + 4 }] } : null;
  const recipes = ['a', 'b'].map(assetId => ({ assetId, kind: 'character', prompt: `完整配方 ${assetId}` }));
  if (narrated) recipes.push({ assetId: 'narrator', kind: 'narration', prompt: '旁白声线参考' });
  const draft = { ...f.draft, recipes, segments: [{ ...f.draft.segments[0], duration: target, narration,
    references: [{ assetId: 'a', role: 'reference_image' }, { assetId: 'b', role: 'reference_image' }] }] };
  await importStory(f.root, draft);
  for (const [i, id] of ['a', 'b'].entries()) {
    const file = join(dirname(f.root), `${id}.png`); await writeFile(file, png(256 + i, 256)); await registerAsset(f.root, id, { file });
  }
  if (narrated) { const file = join(dirname(f.root), 'voice.wav'); await writeFile(file, wav(3.125)); await registerAsset(f.root, 'narrator', { file }); }
  const plan = await createPlan(f.root, 'ep-1', 'h3-context-ir');
  const prompt = `运镜细节。${plan.segments[0]!.renderedPrompt}`;
  const counts = { ir: 0, video: 0, queries: 0 };
  const irClient: ContextIrClient = {
    async createContextIr() { counts.ir++; return { taskId: `ir-${counts.ir}`, evidence: irEvidence }; },
    async queryContextIr(taskId) { counts.queries++; return { taskId, taskType: 'h3_context_ir', model: 'MiniMax-H3', status: 'enhanced', rawStatus: 'succeeded', prompt, evidence: irEvidence }; },
  };
  const videoClient: VideoClient = {
    async create() { counts.video++; return { taskId: `video-${counts.video}`, evidence: irEvidence }; },
    async query(taskId) { return { taskId, status: 'generated', rawStatus: 'succeeded', duration: Math.ceil(target), resolution: '768P', url: 'https://example.com/video.mp4', evidence: irEvidence }; },
  };
  return { ...f, draft, plan, prompt, narration, counts, irClient, videoClient };
}
export function reviewFor(operation: ContextIrOperation): ContextIrReview {
  return { schemaVersion: 1, preparePlanId: operation.planId, preparePlanHash: operation.planHash, segmentId: operation.segmentId,
    sourcePromptHash: operation.sourcePromptHash, irOperationId: operation.operationId, irTaskId: operation.taskId!, promptHash: operation.result!.sha256,
    verdict: 'approved', reviewer: 'offline fixture host review', reviewedAt: '2026-09-19T00:00:00.000Z',
    findings: { dialogue: '林舟的“快走！”原句、说话人及先后不变。', references: '参考图1对应a，图2对应b；位置描述保持。',
      narration: '逐段检查音频仅用于原有画外旁白；角色对白保留自身声线。', constraints: '保留镜头、动作、时长及用户限制；未增加冲突。' }, dialogueQuotes: ['快走！'] };
}
