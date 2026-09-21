export function processReview(operation) {
  return { schemaVersion: 1, preparePlanId: operation.planId, preparePlanHash: operation.planHash, segmentId: operation.segmentId,
    sourcePromptHash: operation.sourcePromptHash, irOperationId: operation.operationId, irTaskId: operation.taskId, promptHash: operation.result.sha256,
    verdict: 'approved', reviewer: 'offline process fixture', reviewedAt: '2026-09-19T00:00:00.000Z', dialogueQuotes: ['完整台词。'],
    findings: { dialogue: '完整台词及林舟说话人未变。', references: '纯文本测试段，没有图片引用。', narration: '没有旁白音频。', constraints: '原段时序与7秒执行时长保留。' } };
}
