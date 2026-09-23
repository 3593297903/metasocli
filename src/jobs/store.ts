import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parse } from '../contracts/story.js';
import { JobSchema, Receipt, type Job } from '../contracts/job.js';
import { loadStory } from '../core/project.js';
import { loadPlan } from '../core/planning.js';
import { fail } from '../core/errors.js';
import { exists, projectPath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { redact, type Evidence } from '../metaso/client.js';
import { liveSubmission } from './submission-owner.js';

export const jobPath = (root: string, operationId: string) => projectPath(root, `.metasocli/jobs/${parse(z.uuid(), operationId)}.json`);
export const receiptPath = (root: string, operationId: string) => projectPath(root, `.metasocli/receipts/${parse(z.uuid(), operationId)}.json`);
export interface Persistence {
  job(root: string, job: Job): Promise<void>;
  receipt(root: string, value: z.infer<typeof Receipt>): Promise<void>;
}
export const persistence: Persistence = {
  async job(root, job) { await writeJson(await jobPath(root, job.operationId), parse(JobSchema, job)); },
  async receipt(root, value) {
    const file = await receiptPath(root, value.operationId);
    if (await exists(file)) {
      const previous = parse(Receipt, await readJson(file));
      if (previous.taskId !== value.taskId || previous.requestHash !== value.requestHash) fail('RECEIPT_CONFLICT', 'A different remote receipt already exists.');
      return;
    }
    await writeJson(file, parse(Receipt, value));
  },
};
export async function readJob(root: string, operationId: string): Promise<Job> {
  const job = parse(JobSchema, await readJson(await jobPath(root, operationId)));
  const [story, plan] = await Promise.all([loadStory(root), loadPlan(root, job.planId)]);
  const segment = plan.segments.find(s => s.segmentId === job.segmentId);
  if (job.operationId !== operationId || job.projectId !== story.projectId || job.projectId !== plan.projectId || job.planHash !== plan.planHash || job.episodeId !== plan.episodeId || job.requestHash !== segment?.requestHash || job.inputHash !== segment?.inputHash) fail('JOB_CONFLICT', 'Stored job does not belong to this project and immutable plan.');
  const file = await receiptPath(root, operationId);
  if (await exists(file)) {
    const receipt = parse(Receipt, await readJson(file));
    if (receipt.operationId !== job.operationId || receipt.requestHash !== job.requestHash || (job.taskId && job.taskId !== receipt.taskId)) fail('RECEIPT_CONFLICT', 'Job receipt identity mismatch.');
    job.taskId = receipt.taskId;
    if (['prepared', 'submitting', 'submit_unknown'].includes(job.status)) job.status = 'queued';
  } else if (job.status === 'submitting' && !await liveSubmission(root, job)) job.status = 'submit_unknown';
  if (['queued', 'running', 'query_unknown', 'generated', 'downloaded'].includes(job.status) && !job.taskId) fail('JOB_CONFLICT', 'Accepted task record is missing its remote ID.');
  return job;
}
export async function listJobs(root: string): Promise<Job[]> {
  await loadStory(root);
  const files = await readdir(await projectPath(root, '.metasocli/jobs'));
  const jobs = [];
  for (const file of files.filter(f => f.endsWith('.json'))) jobs.push(await readJob(root, file.slice(0, -5)));
  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attempt - b.attempt);
}
export async function saveEvidence(root: string, job: Job, evidence: Evidence): Promise<void> {
  const path = `.metasocli/receipts/${job.operationId}-evidence-${randomUUID()}.json`;
  await writeJson(await projectPath(root, path), { sha256: evidence.sha256, httpStatus: evidence.httpStatus, response: redact(evidence.response) });
  job.evidencePath = path;
}
