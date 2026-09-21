import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parse } from '../contracts/story.js';
import { IrOperation, IrReceipt, IrResultReceipt, IrReview, type ContextIrOperation } from '../contracts/context-ir.js';
import { loadStory } from '../core/project.js';
import { loadPlan } from '../core/planning.js';
import { fail } from '../core/errors.js';
import { projectPath, exists } from '../storage/paths.js';
import { readJson, readStable, writeJson, atomicWrite } from '../storage/io.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { irInputHash } from '../metaso/context-ir.js';
import { redact, type Evidence } from '../metaso/client.js';

const id = (value: string) => parse(z.uuid(), value);
export const irOperationPath = (root: string, operationId: string) => projectPath(root, `.metasocli/context-ir/operations/${id(operationId)}.json`);
export const irReceiptPath = (root: string, operationId: string) => projectPath(root, `.metasocli/context-ir/receipts/${id(operationId)}.json`);
export const irPromptPath = (operationId: string) => `.metasocli/context-ir/prompts/${id(operationId)}.txt`;
const resultReceiptPath = (root: string, operationId: string) => projectPath(root, `.metasocli/context-ir/receipts/${id(operationId)}-result.json`);
export const irReviewPath = (operationId: string, hash: string) => `.metasocli/context-ir/reviews/${id(operationId)}-${hash}.json`;

export interface IrPersistence {
  operation(root: string, operation: ContextIrOperation): Promise<void>;
  receipt(root: string, receipt: z.infer<typeof IrReceipt>): Promise<void>;
  result(root: string, operation: ContextIrOperation, prompt: string): Promise<void>;
}
export const irPersistence: IrPersistence = {
  async operation(root, operation) { await writeJson(await irOperationPath(root, operation.operationId), parse(IrOperation, operation)); },
  async receipt(root, receipt) {
    const file = await irReceiptPath(root, receipt.operationId);
    if (await exists(file)) {
      const previous = parse(IrReceipt, await readJson(file));
      if (previous.operationId !== receipt.operationId || previous.irRequestHash !== receipt.irRequestHash || previous.taskId !== receipt.taskId) fail('IR_RECEIPT_CONFLICT', 'IR receipt already belongs to another task.');
      return;
    }
    await writeJson(file, parse(IrReceipt, receipt));
  },
  async result(root, operation, prompt) {
    if (!operation.taskId || !prompt.trim() || Buffer.byteLength(prompt) > 1024 * 1024) fail('IR_QUERY_CONTRACT', 'Invalid bounded IR result.');
    const path = irPromptPath(operation.operationId), file = await projectPath(root, path);
    const result = { path, sha256: sha256Hex(prompt), bytes: Buffer.byteLength(prompt) };
    if (await exists(file)) {
      if (sha256Hex(await readStable(file, 1024 * 1024)) !== result.sha256) fail('IR_RESULT_CHANGED', 'Existing IR result differs; preserve it for inspection.');
    } else await atomicWrite(file, prompt);
    await writeJson(await resultReceiptPath(root, operation.operationId), parse(IrResultReceipt, { operationId: operation.operationId, irRequestHash: operation.irRequestHash, taskId: operation.taskId, result }));
    operation.result = result;
  },
};
export async function readIrOperation(root: string, operationId: string): Promise<ContextIrOperation> {
  const operation = parse(IrOperation, await readJson(await irOperationPath(root, operationId)));
  const [story, plan] = await Promise.all([loadStory(root), loadPlan(root, operation.planId)]);
  const segment = plan.segments.find(s => s.segmentId === operation.segmentId);
  if (operation.operationId !== operationId || operation.projectId !== story.projectId || operation.projectId !== plan.projectId
    || plan.workflow?.stage !== 'prepare' || operation.planHash !== plan.planHash || operation.episodeId !== plan.episodeId || operation.revision !== plan.revision
    || operation.sourcePromptHash !== segment?.sourcePromptHash || operation.baseInputHash !== segment?.inputHash
    || operation.inputHash !== irInputHash(operation.baseInputHash, operation.irRequestHash)) fail('IR_JOB_CONFLICT', 'IR operation does not belong to this project and preparation plan.');
  const receiptFile = await irReceiptPath(root, operationId);
  if (await exists(receiptFile)) {
    const receipt = parse(IrReceipt, await readJson(receiptFile));
    if (receipt.operationId !== operationId || receipt.irRequestHash !== operation.irRequestHash || (operation.taskId && operation.taskId !== receipt.taskId)) fail('IR_RECEIPT_CONFLICT', 'IR task receipt identity mismatch.');
    operation.taskId = receipt.taskId;
    if (['prepared', 'submitting', 'submit_unknown'].includes(operation.status)) operation.status = 'queued';
  } else if (operation.status === 'submitting') operation.status = 'submit_unknown';
  if (['queued', 'running', 'query_unknown', 'enhanced'].includes(operation.status) && !operation.taskId) fail('IR_JOB_CONFLICT', 'Accepted IR task lacks its ID.');
  const resultFile = await resultReceiptPath(root, operationId);
  if (await exists(resultFile)) {
    const receipt = parse(IrResultReceipt, await readJson(resultFile));
    if (receipt.operationId !== operationId || receipt.irRequestHash !== operation.irRequestHash || receipt.taskId !== operation.taskId
      || (operation.result && canonicalSha256(operation.result) !== canonicalSha256(receipt.result))) fail('IR_RESULT_CHANGED', 'IR result receipt identity mismatch.');
    operation.result = receipt.result; operation.status = 'enhanced';
  }
  if (operation.result && operation.result.path !== irPromptPath(operationId)) fail('IR_RESULT_CHANGED', 'IR prompt must use its managed path.');
  if (operation.status === 'enhanced' && !operation.result) fail('IR_RESULT_CHANGED', 'Enhanced operation lacks a durable result.');
  const preparationIds = new Set([operation.planId]), derivedIds = new Set<string>();
  for (const binding of operation.planBindings ?? []) {
    if (preparationIds.has(binding.preparePlanId)) fail('IR_JOB_CONFLICT', 'IR preparation bindings must have unique identities.');
    preparationIds.add(binding.preparePlanId);
  }
  for (const binding of [operation, ...(operation.planBindings ?? [])]) {
    if (binding.review && binding.review.path !== irReviewPath(operationId, binding.review.hash)) fail('IR_REVIEW_CHANGED', 'Review must use its managed path.');
    if (binding.derived) {
      if (binding.derived.reviewPath !== irReviewPath(operationId, binding.derived.reviewHash)) fail('IR_REVIEW_CHANGED', 'Derived plan review path is invalid.');
      if (derivedIds.has(binding.derived.planId)) fail('IR_JOB_CONFLICT', 'Derived plan identity belongs to multiple preparations.');
      derivedIds.add(binding.derived.planId);
    }
  }
  return operation;
}
export async function listIrOperations(root: string): Promise<ContextIrOperation[]> {
  const folder = await projectPath(root, '.metasocli/context-ir/operations');
  if (!await exists(folder)) return [];
  const files = await readdir(folder), operations = [];
  for (const file of files.filter(f => f.endsWith('.json'))) operations.push(await readIrOperation(root, file.slice(0, -5)));
  return operations.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attempt - b.attempt);
}
export async function readIrPrompt(root: string, operation: ContextIrOperation): Promise<string> {
  if (operation.status !== 'enhanced' || !operation.result || operation.result.path !== irPromptPath(operation.operationId)) fail('IR_NOT_ENHANCED', 'IR result is not yet saved.');
  const bytes = await readStable(await projectPath(root, operation.result.path), 1024 * 1024);
  if (bytes.length !== operation.result.bytes || sha256Hex(bytes) !== operation.result.sha256) fail('IR_RESULT_CHANGED', 'Saved IR prompt identity changed.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export async function readIrReview(root: string, operationId: string, path: string, hash: string) {
  if (path !== irReviewPath(operationId, hash)) fail('IR_REVIEW_CHANGED', 'Review is outside its managed identity.');
  const value = await readJson(await projectPath(root, path));
  if (canonicalSha256(value) !== hash) fail('IR_REVIEW_CHANGED', 'Saved review hash changed.');
  return parse(IrReview, value);
}
export async function saveIrEvidence(root: string, operation: ContextIrOperation, evidence: Evidence) {
  const path = `.metasocli/context-ir/receipts/${operation.operationId}-evidence-${randomUUID()}.json`;
  await writeJson(await projectPath(root, path), { sha256: evidence.sha256, httpStatus: evidence.httpStatus, response: redact(evidence.response) });
  operation.evidencePath = path;
}
