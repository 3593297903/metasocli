import { randomUUID } from 'node:crypto';
import { Id, parse, type Story } from '../contracts/story.js';
import { Plan, type GenerationPlan } from '../contracts/plan.js';
import { fail } from './errors.js';
import { loadStory } from './project.js';
import { withProjectLock } from '../storage/locking.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { readJson, readStable, writeJson } from '../storage/io.js';
import { projectPath, exists } from '../storage/paths.js';
import { buildRequest } from '../metaso/h3.js';
import { normalizeText, validateCoverage } from '../story/text.js';
import { z } from 'zod';
import { IrReview, type ContextIrOperation, type ContextIrReview } from '../contracts/context-ir.js';
import { buildIrRequest, deriveRequest, irInputHash, validateEnhancedText } from '../metaso/context-ir.js';
import { irPersistence, irReviewPath, readIrOperation, readIrPrompt, readIrReview } from '../jobs/context-ir-store.js';
import { operationKind } from '../jobs/submission-guard.js';

async function requests(root: string, story: Story, episodeId: string, inlineIr = false) {
  const episode = story.episodes.find(e => e.id === episodeId);
  if (!episode) fail('EPISODE_MISSING', 'Episode does not exist.');
  const source = await readStable(await projectPath(root, episode.source.rawPath));
  const normalized = await readStable(await projectPath(root, episode.source.textPath));
  if (sha256Hex(source) !== episode.source.rawHash || sha256Hex(normalized) !== episode.source.textHash || normalizeText(source) !== normalized.toString('utf8')) fail('SOURCE_CHANGED', 'Source snapshot changed; import a new revision.');
  const text = normalized.toString('utf8'); validateCoverage(text, episode.segments);
  for (const s of episode.segments) {
    const span = text.slice(s.start, s.end);
    if (episode.kind === 'video-prompts' ? s.prompt !== span : !s.prompt.includes(span)) fail('SOURCE_CHANGED', `Prompt ${s.id} lost its source text.`);
  }
  const built = [];
  for (const segment of episode.segments) {
    // The immutable plan records this policy; never rewrite historical manifests or plans.
    const effective = inlineIr ? { ...segment, parameters: { ...segment.parameters, contextIr: true } } : segment;
    built.push(await buildRequest(root, story, effective));
  }
  return built;
}
export async function createPlan(root: string, episodeId: string, workflow: 'h3-inline-ir' | 'h3-context-ir' = 'h3-inline-ir'): Promise<GenerationPlan> {
  parse(Id, episodeId);
  if (workflow !== 'h3-inline-ir' && workflow !== 'h3-context-ir') fail('PLAN_WORKFLOW', 'Unknown workflow.');
  return withProjectLock(root, async () => {
    const story = await loadStory(root);
    const built = await requests(root, story, episodeId, workflow === 'h3-inline-ir');
    if (workflow === 'h3-context-ir') for (const base of built) buildIrRequest(base.request);
    const base = { schemaVersion: 1 as const, planId: randomUUID(), projectId: story.projectId, episodeId, revision: story.revision,
      manifestHash: canonicalSha256(story), createdAt: new Date().toISOString(), segments: built.map(b => b.summary),
      workflow: workflow === 'h3-inline-ir'
        ? { type: workflow, stage: 'inline-video' as const }
        : { type: workflow, stage: 'prepare' as const } };
    const plan = parse(Plan, { ...base, planHash: canonicalSha256(base) });
    await writeJson(await projectPath(root, `.metasocli/plans/${plan.planId}.json`), plan);
    return plan;
  });
}
export async function loadPlan(root: string, planId: string): Promise<GenerationPlan> {
  parse(z.uuid(), planId);
  const plan = parse(Plan, await readJson(await projectPath(root, `.metasocli/plans/${planId}.json`)));
  const { planHash, ...base } = plan;
  if (plan.planId !== planId || canonicalSha256(base) !== planHash) fail('PLAN_TAMPERED', 'Plan hash or identity mismatch.');
  return plan;
}
export async function validatePlan(root: string, plan: GenerationPlan): Promise<{ story: Story; built: Awaited<ReturnType<typeof buildRequest>>[] }> {
  if (plan.workflow?.stage === 'video') {
    const workflow = plan.workflow;
    if (workflow.preparePlanId === plan.planId || plan.segments.length !== 1) fail('IR_PROVENANCE', 'Derived video must have exactly one segment and one preparation parent.');
    const operation = await readIrOperation(root, workflow.irOperationId);
    await operationKind(root, operation.operationId);
    const parent = await loadPlan(root, workflow.preparePlanId);
    const candidate = findIrPlanBinding(operation, parent)?.derived;
    if (parent.workflow?.stage !== 'prepare' || parent.planHash !== workflow.preparePlanHash
      || operation.projectId !== parent.projectId || operation.episodeId !== parent.episodeId || operation.taskId !== workflow.irTaskId
      || operation.segmentId !== workflow.segmentId || operation.result?.sha256 !== workflow.promptHash
      || candidate?.planId !== plan.planId || candidate.createdAt !== plan.createdAt
      || candidate.reviewHash !== workflow.reviewHash || candidate.reviewPath !== workflow.reviewPath
      || (candidate.planHash && candidate.planHash !== plan.planHash)
      || plan.projectId !== parent.projectId || plan.episodeId !== parent.episodeId || plan.revision !== parent.revision || plan.manifestHash !== parent.manifestHash) fail('IR_PROVENANCE', 'Derived video provenance does not match its immutable parent and IR operation.');
    const { story, built: bases } = await validatePlan(root, parent);
    const base = bases.find(b => b.summary.segmentId === workflow.segmentId);
    if (!base) fail('IR_PROVENANCE', 'Parent lacks the selected IR segment.');
    const review = await readIrReview(root, operation.operationId, workflow.reviewPath, workflow.reviewHash);
    const text = await verifyIrReview(root, operation, parent, story, base, review);
    const built = [deriveRequest(base, text)];
    if (canonicalSha256(built.map(b => b.summary)) !== canonicalSha256(plan.segments)) fail('PLAN_STALE', 'Derived request differs from its provenance.');
    return { story, built };
  }
  const story = await loadStory(root);
  if (story.projectId !== plan.projectId || story.revision !== plan.revision || canonicalSha256(story) !== plan.manifestHash) fail('PLAN_STALE', 'Story or assets changed; create a fresh plan before any new submission.');
  const built = await requests(root, story, plan.episodeId, plan.workflow?.stage === 'inline-video');
  if (plan.workflow?.stage === 'prepare') for (const base of built) buildIrRequest(base.request);
  if (canonicalSha256(built.map(b => b.summary)) !== canonicalSha256(plan.segments)) fail('PLAN_STALE', 'Request content differs from the immutable plan.');
  return { story, built };
}

function findIrPlanBinding(operation: ContextIrOperation, parent: GenerationPlan): Pick<ContextIrOperation, 'review' | 'derived'> | undefined {
  if (parent.planId === operation.planId) {
    if (parent.planHash !== operation.planHash) fail('IR_PROVENANCE', 'Original IR preparation identity changed.');
    return operation;
  }
  const binding = operation.planBindings?.find(b => b.preparePlanId === parent.planId);
  if (binding && binding.preparePlanHash !== parent.planHash) fail('IR_PROVENANCE', 'IR preparation binding hash changed.');
  return binding;
}

function verifyIrInputs(operation: ContextIrOperation, parent: GenerationPlan, base: Awaited<ReturnType<typeof buildRequest>>) {
  const requestHash = canonicalSha256(buildIrRequest(base.request));
  if (parent.projectId !== operation.projectId || parent.episodeId !== operation.episodeId
    || base.summary.segmentId !== operation.segmentId || base.summary.sourcePromptHash !== operation.sourcePromptHash
    || base.summary.inputHash !== operation.baseInputHash || requestHash !== operation.irRequestHash
    || operation.inputHash !== irInputHash(base.summary.inputHash, requestHash)) {
    fail('IR_PROVENANCE', 'Current segment inputs differ from the saved IR request; do not reuse this result.');
  }
}

async function verifyIrReview(root: string, operation: ContextIrOperation, parent: GenerationPlan, story: Story,
  base: Awaited<ReturnType<typeof buildRequest>>, review: ContextIrReview): Promise<string> {
  if (review.preparePlanId !== parent.planId || review.preparePlanHash !== parent.planHash || review.segmentId !== operation.segmentId
    || review.sourcePromptHash !== operation.sourcePromptHash || review.irOperationId !== operation.operationId
    || review.irTaskId !== operation.taskId || review.promptHash !== operation.result?.sha256) fail('IR_REVIEW_IDENTITY', 'Review identity does not match the source, IR task and result.');
  if (review.verdict !== 'approved') fail('IR_REVIEW_REQUIRED', 'Host review needs attention; IR succeeded but video creation is blocked.');
  verifyIrInputs(operation, parent, base);
  const text = await readIrPrompt(root, operation);
  const segment = story.episodes.find(e => e.id === parent.episodeId)!.segments.find(s => s.id === operation.segmentId)!;
  validateEnhancedText(text, segment, review);
  return text;
}

export interface DerivedPlanPersistence {
  operation: typeof irPersistence.operation;
  plan(root: string, plan: GenerationPlan): Promise<void>;
}
const derivedPersistence: DerivedPlanPersistence = {
  operation: irPersistence.operation,
  async plan(root, plan) { await writeJson(await projectPath(root, `.metasocli/plans/${plan.planId}.json`), plan); },
};
/** Each stage owns its own project lock; callers must not wrap this in another project lock. */
export async function createPlanFromContextIr(root: string, operationId: string, input: unknown, disk: DerivedPlanPersistence = derivedPersistence): Promise<GenerationPlan> {
  const review = parse(IrReview, input), reviewHash = canonicalSha256(review);
  return withProjectLock(root, async () => {
    await operationKind(root, operationId);
    const operation = await readIrOperation(root, operationId), parent = await loadPlan(root, review.preparePlanId);
    if (parent.workflow?.stage !== 'prepare') fail('IR_PREPARE_REQUIRED', 'IR video plans require a preparation parent.');
    const { story, built } = await validatePlan(root, parent);
    const base = built.find(b => b.summary.segmentId === operation.segmentId);
    if (!base) fail('IR_PROVENANCE', 'Current preparation lacks the original IR segment.');
    verifyIrInputs(operation, parent, base);
    // Bind any persisted review, including needs_review, before saving its verdict.
    if (review.irOperationId !== operationId || review.preparePlanId !== parent.planId || review.preparePlanHash !== parent.planHash
      || review.irTaskId !== operation.taskId || review.segmentId !== operation.segmentId || review.sourcePromptHash !== operation.sourcePromptHash
      || review.promptHash !== operation.result?.sha256) fail('IR_REVIEW_IDENTITY', 'Review is for a different source, task or result.');
    let binding = findIrPlanBinding(operation, parent);
    if (binding?.derived && binding.derived.reviewHash !== reviewHash) fail('IR_REVIEW_CONFLICT', 'This preparation already reserves a different immutable review.');
    const reviewPath = irReviewPath(operationId, reviewHash), file = await projectPath(root, reviewPath);
    if (await exists(file)) await readIrReview(root, operationId, reviewPath, reviewHash);
    else await writeJson(file, review);
    if (!binding) {
      const newBinding: NonNullable<ContextIrOperation['planBindings']>[number] = { preparePlanId: parent.planId, preparePlanHash: parent.planHash };
      (operation.planBindings ??= []).push(newBinding);
      binding = newBinding;
    }
    binding.review = { path: reviewPath, hash: reviewHash, verdict: review.verdict };
    await disk.operation(root, operation);
    const text = await verifyIrReview(root, operation, parent, story, base, review);
    if (!binding.derived) {
      binding.derived = { planId: randomUUID(), createdAt: new Date().toISOString(), reviewPath, reviewHash };
      await disk.operation(root, operation); // Persist candidate identity before any plan write.
    }
    const candidate = binding.derived;
    const planBase = { schemaVersion: 1 as const, planId: candidate.planId, projectId: parent.projectId, episodeId: parent.episodeId,
      revision: parent.revision, manifestHash: parent.manifestHash, createdAt: candidate.createdAt, segments: [deriveRequest(base, text).summary],
      workflow: { type: 'h3-context-ir' as const, stage: 'video' as const, preparePlanId: parent.planId, preparePlanHash: parent.planHash,
        segmentId: operation.segmentId, irOperationId: operation.operationId, irTaskId: operation.taskId!, promptHash: operation.result!.sha256, reviewPath, reviewHash } };
    const plan = parse(Plan, { ...planBase, planHash: canonicalSha256(planBase) });
    if (candidate.planHash && candidate.planHash !== plan.planHash) fail('IR_PROVENANCE', 'Reserved derived plan hash changed.');
    if (await exists(await projectPath(root, `.metasocli/plans/${plan.planId}.json`))) {
      if (canonicalSha256(await loadPlan(root, plan.planId)) !== canonicalSha256(plan)) fail('IR_PROVENANCE', 'Existing derived plan differs from its reserved identity.');
    } else await disk.plan(root, plan);
    candidate.planHash = plan.planHash; operation.updatedAt = new Date().toISOString(); await disk.operation(root, operation);
    return plan;
  });
}
